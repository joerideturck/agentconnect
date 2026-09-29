import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ShimRequester } from '../src/shim/channels.js'
import { ClusterSkillClient } from '../src/shim/skill-client.js'
import { ClusterSkillHandler } from '../src/shim/skill-handler.js'
import { MAX_CLUSTER_SKILL_CHUNK_BYTES, MAX_CLUSTER_SKILL_CONTROL_BYTES } from '../src/shim/skill-protocol.js'
import { inspectLocalSkillSource } from '../src/skills/skill-source-snapshot.js'
import { treeDigest } from '../src/skills/skill-install-ledger.js'
import { ClusterSkillCoordinator } from '../src/skills/cluster-skill-coordinator.js'
import { legacySandboxSkillLedger } from '../src/skills/sandbox-skill-ledger.js'
import { LocalStore } from '../src/store/local-store.js'
import { memoryStoreDatabase } from './store-support.js'

const sha256 = (value: Buffer): string => createHash('sha256').update(value).digest('hex')

async function fixture(content = Buffer.from('hello')) {
  const root = await mkdtemp(join(tmpdir(), 'ac-shim-skills-'))
  const operationId = randomUUID()
  const handler = new ClusterSkillHandler({ stagingRoot: join(root, 'staging'), inactiveMs: 1_000 })
  const begin = await handler.handle({
    op: 'begin',
    operationId,
    authority: {
      groupId: 'g',
      term: '1',
      daemonId: 'd',
      agentId: 'a',
      workspaceIncarnation: 'claim-1',
      shimGeneration: 1
    },
    skillsAgentId: 'codex',
    files: [{ sourceId: 'managed:a', path: 'nested/SKILL.md', size: content.length, sha256: sha256(content) }]
  })
  return { root, operationId, handler, handle: (begin as { handle: string }).handle, content }
}

describe('cluster skill shim staging', () => {
  it('skips a source whose selected skill set is oversized, publishing nothing for it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-skill-admission-'))
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    try {
      const authority = {
        groupId: 'g',
        term: '1',
        daemonId: 'd',
        agentId: 'a',
        workspaceIncarnation: 'w',
        shimGeneration: 1
      }
      const handler = new ClusterSkillHandler({
        stagingRoot: join(root, 'staging'),
        workspaceRoot: workspace,
        stateRoot: join(root, 'state')
      })
      const client = new ClusterSkillClient({ request: (_cap, payload) => handler.handle(payload) }, true, true, true)
      const operationId = randomUUID()
      const bodies = Array.from({ length: 65 }, (_, index) =>
        Buffer.from(`---\nname: skill-${index}\ndescription: fixture\n---\n# Fixture\n`)
      )
      const files = bodies.map((body, index) => ({
        sourceId: 'source',
        path: `skill-${index}/SKILL.md`,
        size: body.length,
        sha256: sha256(body)
      }))
      const { handle } = await client.begin({ operationId, authority, skillsAgentId: 'codex', files })
      for (const [index, file] of files.entries()) await client.upload(operationId, handle, file, bodies[index]!)
      // 65 bundles exceed the cell's bundle cap. That is the SOURCE's problem, not the session's:
      // the reply names it under `skipped`, nothing of it is published, and the run still completes.
      const reply = await client.reconcile({
        operationId,
        handle,
        authority,
        priorRoots: [],
        replayKey: 'a'.repeat(64),
        allowDesiredAdoption: false,
        sources: [{ sourceId: 'source', sourceKind: 'managed', selections: [] }]
      })
      expect(reply.roots).toEqual([])
      expect(reply.skipped).toEqual([{ sourceId: 'source', reason: expect.stringContaining('too many bundles') }])
      expect(await readdir(workspace)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses incomplete, out-of-order and superseded prior receipts before publication', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-skill-prior-'))
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    try {
      const handler = new ClusterSkillHandler({
        stagingRoot: join(root, 'staging'),
        workspaceRoot: workspace,
        stateRoot: join(root, 'state')
      })
      const operationId = randomUUID()
      const authority = {
        groupId: 'g',
        term: '1',
        daemonId: 'd',
        agentId: 'a',
        workspaceIncarnation: 'w',
        shimGeneration: 1
      }
      const { handle } = await new ClusterSkillClient(
        { request: (_cap, payload) => handler.handle(payload) },
        true,
        true,
        true
      ).begin({ operationId, authority, skillsAgentId: 'codex', files: [] })
      const files = [{ path: 'SKILL.md', mode: 0o600, size: 0, sha256: sha256(Buffer.alloc(0)) }]
      const roots = [
        { path: '.agents/skills/one', sourceId: 'source', sourceKind: 'managed', digest: treeDigest(files), files }
      ]
      await expect(handler.handle({ op: 'prior', operationId, handle, offset: 1, roots })).rejects.toThrow(
        'unexpected prior skill receipt offset'
      )
      await expect(handler.handle({ op: 'prior', operationId, handle, offset: 0, roots })).resolves.toEqual({
        received: 1
      })
      await expect(
        handler.handle({
          op: 'reconcile',
          operationId,
          handle,
          authority,
          priorRoots: [],
          priorRootCount: 2,
          replayKey: 'a'.repeat(64),
          allowDesiredAdoption: false,
          sources: []
        })
      ).rejects.toThrow('cluster skill prior receipt is incomplete')
      await handler.handle({
        op: 'begin',
        operationId: randomUUID(),
        authority: { ...authority, term: '2' },
        skillsAgentId: 'codex',
        files: []
      })
      await expect(handler.handle({ op: 'prior', operationId, handle, offset: 1, roots })).rejects.toThrow(
        'lost duty authority'
      )
      expect(await readdir(workspace)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('commits, migrates, verifies and removes a receipt larger than one frame', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-skill-receipts-'))
    const workspace = join(root, 'workspace')
    const stateRoot = join(root, 'state')
    await mkdir(workspace)
    const store = await LocalStore.open({
      database: memoryStoreDatabase(),
      shared: true,
      ownerId: 'member-a',
      orgForAgent: () => 'org'
    })
    try {
      const authority = {
        groupId: 'g',
        term: '1',
        daemonId: 'member-a',
        agentId: 'a',
        workspaceIncarnation: 'workspace'
      }
      await store.projectDutyWriteFence({ groupId: 'g', term: '1', daemonId: 'member-a' })
      const sources = []
      const nested = ['a', 'b', 'c', 'd'].map((letter) => letter.repeat(180))
      for (let index = 0; index < 6; index++) {
        const name = `skill-${index}`
        const sourceDir = join(root, name)
        await mkdir(join(sourceDir, ...nested), { recursive: true })
        await writeFile(join(sourceDir, 'SKILL.md'), `---\nname: ${name}\ndescription: fixture\n---\n# Fixture\n`)
        for (let file = 1; file < 50; file++) await writeFile(join(sourceDir, ...nested, `file-${file}.txt`), 'fixture')
        sources.push({
          sourceId: name,
          sourceKind: 'managed' as const,
          sourceDir,
          selections: [name],
          expectedLeaves: [name]
        })
      }
      const handler = new ClusterSkillHandler({
        stagingRoot: join(root, 'staging'),
        workspaceRoot: workspace,
        stateRoot
      })
      const requests: string[] = []
      const client = new ClusterSkillClient(
        {
          request: async (_capability, payload) => {
            expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThanOrEqual(MAX_CLUSTER_SKILL_CONTROL_BYTES)
            requests.push((payload as { op: string }).op)
            const reply = await handler.handle(payload)
            expect(Buffer.byteLength(JSON.stringify(reply))).toBeLessThanOrEqual(MAX_CLUSTER_SKILL_CONTROL_BYTES)
            return reply
          }
        },
        true,
        true,
        true
      )
      const coordinator = new ClusterSkillCoordinator(store)
      const common = { authority, skillsAgentId: 'codex', shimGeneration: 1, client }
      const ledger = await coordinator.reconcile({ ...common, sources })
      expect(ledger.roots.flatMap((root) => root.files)).toHaveLength(300)
      expect(Buffer.byteLength(JSON.stringify(ledger))).toBeGreaterThan(MAX_CLUSTER_SKILL_CONTROL_BYTES)
      expect((await store.clusterSkillLedger('a', 'workspace'))?.ledger).toEqual(ledger)
      expect((await legacySandboxSkillLedger('cluster-shim', workspace, stateRoot))?.roots).toHaveLength(6)
      expect(await client.verify(ledger.roots)).toEqual({ intact: Array(6).fill(true) })
      expect(requests.filter((op) => op === 'verify').length).toBeGreaterThan(1)
      expect(requests).toContain('receipt')
      await expect(coordinator.reconcile({ ...common, sources: [] })).resolves.toMatchObject({ roots: [] })
      expect(requests.filter((op) => op === 'prior').length).toBeGreaterThan(1)
      expect(await readdir(join(workspace, '.agents/skills'))).toEqual([])
      expect((await store.clusterSkillLedger('a', 'workspace'))?.revision).toBe(2)
    } finally {
      await store.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 120_000)

  it('assembles a paged manifest and enforces the totals no single page can see', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-shim-paged-'))
    const handler = new ClusterSkillHandler({ stagingRoot: join(root, 'staging'), inactiveMs: 1_000 })
    const operationId = randomUUID()
    const authority = {
      groupId: 'g',
      term: '1',
      daemonId: 'd',
      agentId: 'a',
      workspaceIncarnation: 'claim-1',
      shimGeneration: 1
    }
    const body = Buffer.from('12345678')
    const files = Array.from({ length: 1_500 }, (_unused, index) => ({
      sourceId: 'agent:0',
      path: `docs/note-${index}.md`,
      size: body.length,
      sha256: sha256(body)
    }))
    const requester: ShimRequester = { request: (_capability, payload) => handler.handle(payload) }
    const reply = await new ClusterSkillClient(requester, true).begin({
      operationId,
      authority,
      skillsAgentId: 'universal',
      files
    })

    // Every file arrived across pages, and the assembled set — not any one page — is what upload sees.
    await expect(
      handler.handle({
        op: 'upload',
        operationId,
        handle: reply.handle,
        sourceId: 'agent:0',
        path: 'docs/note-1499.md',
        offset: 0,
        data: body.toString('base64'),
        final: true
      })
    ).resolves.toEqual({ received: 8, complete: true })

    // A page after the client declared the last one is refused.
    await expect(
      handler.handle({ op: 'manifest', operationId, handle: reply.handle, files: [files[0]!], moreFiles: false })
    ).rejects.toThrow(/manifest is already complete/)

    // A page repeating an EARLIER page's file, while the manifest is still open: only the
    // receiver holds the assembled set, so no per-page check could catch this one.
    const openId = randomUUID()
    const open = (await handler.handle({
      op: 'begin',
      operationId: openId,
      authority: { ...authority, term: '2' },
      skillsAgentId: 'universal',
      files: [files[0]!],
      moreFiles: true
    })) as { handle: string }
    await expect(
      handler.handle({
        op: 'manifest',
        operationId: openId,
        handle: open.handle,
        files: [files[0]!],
        moreFiles: false
      })
    ).rejects.toThrow(/duplicate cluster skill manifest file/)
  })

  it('mints a handle and accepts only ordered chunks through verified finalization', async () => {
    const f = await fixture()
    await expect(
      f.handler.handle({
        op: 'upload',
        operationId: f.operationId,
        handle: f.handle,
        sourceId: 'managed:a',
        path: 'nested/SKILL.md',
        offset: 2,
        data: Buffer.from('x').toString('base64'),
        final: false
      })
    ).rejects.toThrow(/offset/)
    expect(
      await f.handler.handle({
        op: 'upload',
        operationId: f.operationId,
        handle: f.handle,
        sourceId: 'managed:a',
        path: 'nested/SKILL.md',
        offset: 0,
        data: f.content.toString('base64'),
        final: true
      })
    ).toEqual({ received: 5, complete: true })
    expect(
      await f.handler.handle({
        op: 'upload',
        operationId: f.operationId,
        handle: f.handle,
        sourceId: 'managed:a',
        path: 'nested/SKILL.md',
        offset: 0,
        data: f.content.toString('base64'),
        final: true
      })
    ).toEqual({ received: 5, complete: true })
    expect(await readFile(f.handler.stagedFile(f.handle, 'managed:a', 'nested/SKILL.md'))).toEqual(f.content)
  })

  it('rejects size and digest mismatches and removes the operation', async () => {
    const f = await fixture()
    await expect(
      f.handler.handle({
        op: 'upload',
        operationId: f.operationId,
        handle: f.handle,
        sourceId: 'managed:a',
        path: 'nested/SKILL.md',
        offset: 0,
        data: Buffer.from('wrong').toString('base64'),
        final: true
      })
    ).rejects.toThrow(/digest/)
    await expect(lstat(join(f.root, 'staging', f.handle))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a symlink planted in the staging descent', async () => {
    const f = await fixture()
    const sourceRoot = join(f.root, 'staging', f.handle, sha256(Buffer.from('managed:a')))
    await mkdir(sourceRoot, { recursive: true })
    await symlink(tmpdir(), join(sourceRoot, 'nested'))
    await expect(
      f.handler.handle({
        op: 'upload',
        operationId: f.operationId,
        handle: f.handle,
        sourceId: 'managed:a',
        path: 'nested/SKILL.md',
        offset: 0,
        data: f.content.toString('base64'),
        final: true
      })
    ).rejects.toThrow(/symlink/)
  })

  it('cleans cancelled and inactive operations', async () => {
    const f = await fixture()
    const abort = new AbortController()
    abort.abort()
    await expect(
      f.handler.handle(
        {
          op: 'upload',
          operationId: f.operationId,
          handle: f.handle,
          sourceId: 'managed:a',
          path: 'nested/SKILL.md',
          offset: 0,
          data: 'aA==',
          final: false
        },
        abort.signal
      )
    ).rejects.toThrow(/aborted/)
    await expect(lstat(join(f.root, 'staging', f.handle))).rejects.toMatchObject({ code: 'ENOENT' })
    const old = await fixture()
    const date = new Date(Date.now() - 5_000)
    await utimes(join(old.root, 'staging', old.handle), date, date)
    expect(await old.handler.gcInactive()).toBe(1)
  })

  it('chunks daemon uploads and parses every shim response strictly', async () => {
    const content = Buffer.alloc(MAX_CLUSTER_SKILL_CHUNK_BYTES + 1, 7)
    const calls: unknown[] = []
    const requester: ShimRequester = {
      async request(_capability, payload) {
        calls.push(payload)
        const upload = payload as { op: string; offset?: number; data?: string }
        if (upload.op === 'begin') return { handle: 'opaque-handle-1234' }
        return { received: upload.offset! + Buffer.from(upload.data!, 'base64').length, complete: calls.length === 3 }
      }
    }
    const client = new ClusterSkillClient(requester)
    const file = { sourceId: 'managed:a', path: 'SKILL.md', size: content.length, sha256: sha256(content) }
    const { handle } = await client.begin({
      operationId: randomUUID(),
      authority: {
        groupId: 'g',
        term: '1',
        daemonId: 'd',
        agentId: 'a',
        workspaceIncarnation: 'claim',
        shimGeneration: 1
      },
      skillsAgentId: 'codex',
      files: [file]
    })
    await client.upload((calls[0] as { operationId: string }).operationId, handle, file, content)
    expect(calls).toHaveLength(3)
    expect(calls.at(-1)).toMatchObject({ offset: MAX_CLUSTER_SKILL_CHUNK_BYTES, final: true })
    const invalid = new ClusterSkillClient({ request: async () => ({ received: 1, complete: false, extra: true }) })
    await expect(invalid.upload(randomUUID(), handle, { ...file, size: 1 }, Buffer.from('x'))).rejects.toThrow()
  })

  it('runs the pinned CLI and publishes a verified receipt', async () => {
    const content = Buffer.from('---\nname: cluster-golden\ndescription: cluster fixture\n---\n# Cluster\n')
    const script = Buffer.from('#!/bin/sh\nprintf executable\n')
    const root = await mkdtemp(join(tmpdir(), 'ac-shim-skills-reconcile-'))
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    const operationId = randomUUID()
    const handler = new ClusterSkillHandler({
      stagingRoot: join(root, 'staging'),
      workspaceRoot: workspace,
      stateRoot: join(root, 'state')
    })
    const file = { sourceId: 'managed:a', path: 'SKILL.md', size: content.length, sha256: sha256(content) }
    const scriptFile = { ...file, path: 'run.sh', size: script.length, sha256: sha256(script), executable: true }
    const authority = {
      groupId: 'g',
      term: '1',
      daemonId: 'd',
      agentId: 'a',
      workspaceIncarnation: 'claim',
      shimGeneration: 1
    }
    const begin = (await handler.handle({
      op: 'begin',
      operationId,
      authority,
      skillsAgentId: 'codex',
      files: [file, scriptFile]
    })) as { handle: string }
    await handler.handle({
      op: 'upload',
      operationId,
      handle: begin.handle,
      sourceId: file.sourceId,
      path: file.path,
      offset: 0,
      data: content.toString('base64'),
      final: true
    })
    await handler.handle({
      op: 'upload',
      operationId,
      handle: begin.handle,
      sourceId: scriptFile.sourceId,
      path: scriptFile.path,
      offset: 0,
      data: script.toString('base64'),
      final: true
    })
    const reply = await handler.handle({
      op: 'reconcile',
      operationId,
      handle: begin.handle,
      authority,
      priorRoots: [],
      replayKey: 'a'.repeat(64),
      allowDesiredAdoption: false,
      sources: [{ sourceId: file.sourceId, sourceKind: 'managed', selections: ['cluster-golden'] }]
    })
    expect(reply).toMatchObject({
      roots: [{ path: '.agents/skills/cluster-golden', sourceKind: 'managed' }],
      conflicts: []
    })
    if (process.platform !== 'win32') {
      expect((await lstat(join(workspace, '.agents/skills/cluster-golden/run.sh'))).mode & 0o777).toBe(0o700)
      expect((await lstat(join(workspace, '.agents/skills/cluster-golden/SKILL.md'))).mode & 0o777).toBe(0o600)
    }
    const replay = new ClusterSkillHandler({
      stagingRoot: join(root, 'staging-replay'),
      workspaceRoot: workspace,
      stateRoot: join(root, 'state')
    })
    const replayBegin = (await replay.handle({
      op: 'begin',
      operationId,
      authority,
      skillsAgentId: 'codex',
      files: [file, scriptFile]
    })) as { handle: string }
    await replay.handle({
      op: 'upload',
      operationId,
      handle: replayBegin.handle,
      sourceId: file.sourceId,
      path: file.path,
      offset: 0,
      data: content.toString('base64'),
      final: true
    })
    await replay.handle({
      op: 'upload',
      operationId,
      handle: replayBegin.handle,
      sourceId: scriptFile.sourceId,
      path: scriptFile.path,
      offset: 0,
      data: script.toString('base64'),
      final: true
    })
    await expect(
      replay.handle({
        op: 'reconcile',
        operationId,
        handle: replayBegin.handle,
        authority,
        priorRoots: [],
        replayKey: 'a'.repeat(64),
        allowDesiredAdoption: false,
        sources: [{ sourceId: file.sourceId, sourceKind: 'managed', selections: ['cluster-golden'] }]
      })
    ).resolves.toMatchObject({ roots: [{ path: '.agents/skills/cluster-golden' }], conflicts: [] })
    expect(await readFile(join(workspace, '.agents/skills/cluster-golden/SKILL.md'), 'utf8')).toContain('# Cluster')
  }, 120_000)

  it('publishes a bundle carrying a multi-MiB asset end to end (cell, snapshot, ledger and mutation helper agree)', async () => {
    // Every validator on the path must admit what the first one admits: a 1 MiB asset was refused
    // by the old 512 KiB receipt checks even once staging let it through.
    const skill = Buffer.from('---\nname: with-asset\ndescription: fixture\n---\n# Asset\n')
    const asset = Buffer.alloc(1024 * 1024 + 7, 0x41)
    const root = await mkdtemp(join(tmpdir(), 'ac-shim-skills-asset-'))
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    const operationId = randomUUID()
    const handler = new ClusterSkillHandler({
      stagingRoot: join(root, 'staging'),
      workspaceRoot: workspace,
      stateRoot: join(root, 'state')
    })
    const client = new ClusterSkillClient({ request: (_cap, payload) => handler.handle(payload) }, true, true, true)
    const authority = {
      groupId: 'g',
      term: '1',
      daemonId: 'd',
      agentId: 'a',
      workspaceIncarnation: 'claim',
      shimGeneration: 1
    }
    const files = [
      { sourceId: 'managed:a', path: 'SKILL.md', size: skill.length, sha256: sha256(skill) },
      { sourceId: 'managed:a', path: 'assets/photo.bin', size: asset.length, sha256: sha256(asset) }
    ]
    const { handle } = await client.begin({ operationId, authority, skillsAgentId: 'codex', files })
    await client.upload(operationId, handle, files[0]!, skill)
    await client.upload(operationId, handle, files[1]!, asset)
    const reply = await client.reconcile({
      operationId,
      handle,
      authority,
      priorRoots: [],
      replayKey: 'd'.repeat(64),
      allowDesiredAdoption: false,
      sources: [{ sourceId: 'managed:a', sourceKind: 'managed', selections: ['with-asset'] }]
    })
    expect(reply.skipped).toBeUndefined()
    expect(reply.roots.map((r) => r.path)).toEqual(['.agents/skills/with-asset'])
    expect(reply.roots[0]!.files.find((f) => f.path === 'assets/photo.bin')?.size).toBe(asset.length)
    expect((await readFile(join(workspace, '.agents/skills/with-asset/assets/photo.bin'))).length).toBe(asset.length)
    await rm(root, { recursive: true, force: true })
  }, 120_000)

  it('keeps a skipped Git source’s PREVIOUS revision installed, even though its source id changed', async () => {
    // Revision A of `agent:0:dgst:<A>` installs; revision B of the same source (a different id,
    // since the id names the commit) fails staging with too many bundles. B is skipped and A's
    // bundle must stay — the run says nothing about intent — under A's own receipt.
    const A = 'a'.repeat(40)
    const B = 'b'.repeat(40)
    const body = Buffer.from('---\nname: keep-me\ndescription: fixture\n---\n# Keep\n')
    const root = await mkdtemp(join(tmpdir(), 'ac-shim-skills-revision-'))
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    const authority = {
      groupId: 'g',
      term: '1',
      daemonId: 'd',
      agentId: 'a',
      workspaceIncarnation: 'claim',
      shimGeneration: 1
    }
    const handler = new ClusterSkillHandler({
      stagingRoot: join(root, 'staging'),
      workspaceRoot: workspace,
      stateRoot: join(root, 'state')
    })
    const client = new ClusterSkillClient({ request: (_cap, payload) => handler.handle(payload) }, true, true, true)

    const firstId = `agent:0:dgst:${A}`
    const first = randomUUID()
    const firstFiles = [{ sourceId: firstId, path: 'keep-me/SKILL.md', size: body.length, sha256: sha256(body) }]
    const begunA = await client.begin({ operationId: first, authority, skillsAgentId: 'codex', files: firstFiles })
    await client.upload(first, begunA.handle, firstFiles[0]!, body)
    const installed = await client.reconcile({
      operationId: first,
      handle: begunA.handle,
      authority,
      priorRoots: [],
      replayKey: 'e'.repeat(64),
      allowDesiredAdoption: false,
      sources: [{ sourceId: firstId, sourceKind: 'agent', selections: ['keep-me'] }]
    })
    expect(installed.roots.map((r) => r.path)).toEqual(['.agents/skills/keep-me'])

    const secondId = `agent:0:dgst:${B}`
    const second = randomUUID()
    const bodies = Array.from({ length: 65 }, (_, i) =>
      Buffer.from(`---\nname: skill-${i}\ndescription: f\n---\n# ${i}\n`)
    )
    const secondFiles = bodies.map((b, i) => ({
      sourceId: secondId,
      path: `skill-${i}/SKILL.md`,
      size: b.length,
      sha256: sha256(b)
    }))
    const begunB = await client.begin({ operationId: second, authority, skillsAgentId: 'codex', files: secondFiles })
    for (const [i, file] of secondFiles.entries()) await client.upload(second, begunB.handle, file, bodies[i]!)
    const reply = await client.reconcile({
      operationId: second,
      handle: begunB.handle,
      authority,
      priorRoots: installed.roots,
      replayKey: 'f'.repeat(64),
      allowDesiredAdoption: false,
      sources: [{ sourceId: secondId, sourceKind: 'agent', selections: [] }]
    })
    expect(reply.skipped).toEqual([{ sourceId: secondId, reason: expect.stringContaining('too many bundles') }])
    // A's bundle survived, still owned under A's id and kind.
    expect(reply.roots).toEqual([
      expect.objectContaining({ path: '.agents/skills/keep-me', sourceId: firstId, sourceKind: 'agent' })
    ])
    expect(await readFile(join(workspace, '.agents/skills/keep-me/SKILL.md'), 'utf8')).toContain('# Keep')
    await rm(root, { recursive: true, force: true })
  }, 120_000)

  it('uses the durable receipt to remove an owned root after pod-local state is lost', async () => {
    const content = Buffer.from('---\nname: replacement\ndescription: fixture\n---\n# Replacement\n')
    const root = await mkdtemp(join(tmpdir(), 'ac-shim-skills-replacement-'))
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    const authority = {
      groupId: 'g',
      term: '2',
      daemonId: 'd',
      agentId: 'a',
      workspaceIncarnation: 'claim',
      shimGeneration: 2
    }
    const first = new ClusterSkillHandler({
      stagingRoot: join(root, 'staging-1'),
      workspaceRoot: workspace,
      stateRoot: join(root, 'state-1')
    })
    const operationId = randomUUID()
    const file = { sourceId: 'managed:a', path: 'SKILL.md', size: content.length, sha256: sha256(content) }
    const begin = (await first.handle({
      op: 'begin',
      operationId,
      authority,
      skillsAgentId: 'codex',
      files: [file]
    })) as {
      handle: string
    }
    await first.handle({
      op: 'upload',
      operationId,
      handle: begin.handle,
      sourceId: file.sourceId,
      path: file.path,
      offset: 0,
      data: content.toString('base64'),
      final: true
    })
    const applied = (await first.handle({
      op: 'reconcile',
      operationId,
      handle: begin.handle,
      authority,
      priorRoots: [],
      replayKey: 'b'.repeat(64),
      allowDesiredAdoption: false,
      sources: [{ sourceId: file.sourceId, sourceKind: 'managed', selections: ['replacement'] }]
    })) as { roots: Array<Record<string, unknown>> }

    const replacement = new ClusterSkillHandler({
      stagingRoot: join(root, 'staging-2'),
      workspaceRoot: workspace,
      stateRoot: join(root, 'state-2')
    })
    const removeId = randomUUID()
    const removeBegin = (await replacement.handle({
      op: 'begin',
      operationId: removeId,
      authority,
      skillsAgentId: 'codex',
      files: []
    })) as { handle: string }
    await replacement.handle({
      op: 'reconcile',
      operationId: removeId,
      handle: removeBegin.handle,
      authority,
      priorRoots: applied.roots,
      replayKey: 'c'.repeat(64),
      allowDesiredAdoption: false,
      sources: []
    })
    await expect(lstat(join(workspace, '.agents/skills/replacement'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 120_000)

  it('fences the bound agent, shim generation, and monotonically observed duty term', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-shim-skills-fence-'))
    const handler = new ClusterSkillHandler({ stagingRoot: join(root, 'staging') })
    const base = {
      groupId: 'g',
      term: '7',
      daemonId: 'd',
      agentId: 'a',
      workspaceIncarnation: 'claim',
      shimGeneration: 3
    }
    await expect(
      handler.handle(
        { op: 'begin', operationId: randomUUID(), authority: base, skillsAgentId: 'codex', files: [] },
        undefined,
        { agentId: 'a', generation: 2 }
      )
    ).rejects.toThrow(/generation/)
    await handler.handle(
      { op: 'begin', operationId: randomUUID(), authority: { ...base, term: '8' }, skillsAgentId: 'codex', files: [] },
      undefined,
      { agentId: 'a', generation: 3 }
    )
    await expect(
      handler.handle(
        { op: 'begin', operationId: randomUUID(), authority: base, skillsAgentId: 'codex', files: [] },
        undefined,
        { agentId: 'a', generation: 3 }
      )
    ).rejects.toThrow(/stale/)
  })

  it('verifies exact receipts including mode, binary bytes, and unexpected files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-shim-skills-verify-'))
    const workspace = join(root, 'workspace')
    const skill = join(workspace, '.agents/skills/binary')
    await mkdir(skill, { recursive: true })
    const body = Buffer.from([0, 1, 2, 255])
    await writeFile(join(skill, 'SKILL.md'), '---\nname: binary\ndescription: fixture\n---\n')
    await writeFile(join(skill, 'asset.bin'), body, { mode: 0o600 })
    const inspected = await inspectLocalSkillSource(skill)
    const receiptFiles = inspected.files.map((file) => ({
      path: file.path,
      mode: file.mode & 0o111 ? 0o700 : 0o600,
      size: file.size,
      sha256: file.sha256.replace(/^sha256:/, '')
    }))
    const receipt = {
      path: '.agents/skills/binary',
      sourceId: 'managed:binary',
      sourceKind: 'managed' as const,
      digest: treeDigest(receiptFiles),
      files: receiptFiles
    }
    const handler = new ClusterSkillHandler({ stagingRoot: join(root, 'staging'), workspaceRoot: workspace })
    await expect(handler.handle({ op: 'verify', roots: [receipt] })).resolves.toEqual({ intact: [true] })
    await chmod(join(skill, 'asset.bin'), 0o700)
    await expect(handler.handle({ op: 'verify', roots: [receipt] })).resolves.toEqual({ intact: [false] })
    await chmod(join(skill, 'asset.bin'), 0o600)
    await writeFile(join(skill, 'extra.txt'), 'extra')
    await expect(handler.handle({ op: 'verify', roots: [receipt] })).resolves.toEqual({ intact: [false] })
  })
})

describe('cluster skill batched uploads (cluster-skills-v4)', () => {
  const authority = {
    groupId: 'g',
    term: '1',
    daemonId: 'd',
    agentId: 'a',
    workspaceIncarnation: 'w',
    shimGeneration: 1
  }

  /** A real handler behind a client, counting what reaches the shim by op. */
  async function batchFixture(batchUploads: boolean) {
    const root = await mkdtemp(join(tmpdir(), 'ac-skill-batch-'))
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    const handler = new ClusterSkillHandler({
      stagingRoot: join(root, 'staging'),
      workspaceRoot: workspace,
      stateRoot: join(root, 'state')
    })
    const ops: string[] = []
    const client = new ClusterSkillClient(
      {
        request: (_capability, payload) => {
          ops.push((payload as { op: string }).op)
          return handler.handle(payload)
        }
      },
      true,
      true,
      true,
      batchUploads
    )
    return { root, workspace, handler, client, ops }
  }

  const skillBodies = (count: number): Map<string, Buffer> =>
    new Map(
      Array.from({ length: count }, (_, index) => [
        `skill-${index}/SKILL.md`,
        Buffer.from(`---\nname: skill-${index}\ndescription: fixture\n---\n# Fixture ${index}\n`)
      ])
    )

  const declare = (bodies: Map<string, Buffer>) =>
    [...bodies].map(([path, body]) => ({ sourceId: 'source', path, size: body.length, sha256: sha256(body) }))

  it('uploads many small files in one frame and publishes the same skills as per-file uploads', async () => {
    const bodies = skillBodies(40)
    const installed: string[][] = []
    const opCounts: Record<string, number>[] = []
    for (const batchUploads of [true, false]) {
      const { root, workspace, client, ops } = await batchFixture(batchUploads)
      try {
        const operationId = randomUUID()
        const files = declare(bodies)
        const { handle } = await client.begin({ operationId, authority, skillsAgentId: 'codex', files })
        await client.uploadFiles(operationId, handle, files, async (file) => bodies.get(file.path)!)
        const reply = await client.reconcile({
          operationId,
          handle,
          authority,
          priorRoots: [],
          replayKey: 'a'.repeat(64),
          allowDesiredAdoption: false,
          sources: [{ sourceId: 'source', sourceKind: 'managed', selections: [] }]
        })
        installed.push(reply.roots.map((root) => root.path).sort())
        opCounts.push(ops.reduce<Record<string, number>>((acc, op) => ({ ...acc, [op]: (acc[op] ?? 0) + 1 }), {}))
        expect((await readdir(workspace)).length).toBeGreaterThan(0)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
    expect(installed[0]).toHaveLength(40)
    expect(installed[0]).toEqual(installed[1])
    // 40 files: one batch where the per-file path takes 40 round trips.
    expect(opCounts[0]).toMatchObject({ 'upload-batch': 1 })
    expect(opCounts[0]!.upload).toBeUndefined()
    expect(opCounts[1]).toMatchObject({ upload: 40 })
    expect(opCounts[1]!['upload-batch']).toBeUndefined()
  })

  it('splits batches at one chunk of bytes and streams a file larger than a chunk on its own', async () => {
    const { root, client, ops } = await batchFixture(true)
    try {
      const bodies = new Map<string, Buffer>([
        ['big/asset.bin', Buffer.alloc(MAX_CLUSTER_SKILL_CHUNK_BYTES + 10, 7)],
        ['a/one.bin', Buffer.alloc(MAX_CLUSTER_SKILL_CHUNK_BYTES / 2 + 1, 1)],
        ['a/two.bin', Buffer.alloc(MAX_CLUSTER_SKILL_CHUNK_BYTES / 2 + 1, 2)],
        ['a/SKILL.md', Buffer.from('small')]
      ])
      const operationId = randomUUID()
      const files = declare(bodies)
      const { handle } = await client.begin({ operationId, authority, skillsAgentId: 'codex', files })
      await client.uploadFiles(operationId, handle, files, async (file) => bodies.get(file.path)!)
      // The big file: two chunked uploads. The two halves cannot share a batch.
      expect(ops.filter((op) => op === 'upload')).toHaveLength(2)
      expect(ops.filter((op) => op === 'upload-batch')).toHaveLength(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps every per-file check: a wrong digest discards the operation, an undeclared file is refused', async () => {
    const { root, handler, client } = await batchFixture(true)
    try {
      const bodies = skillBodies(2)
      const operationId = randomUUID()
      const files = declare(bodies)
      const { handle } = await client.begin({ operationId, authority, skillsAgentId: 'codex', files })
      await expect(
        handler.handle({
          op: 'upload-batch',
          operationId,
          handle,
          files: [{ sourceId: 'source', path: 'nope/SKILL.md', data: Buffer.from('x').toString('base64') }]
        })
      ).rejects.toThrow(/upload file was not declared/)
      const [first, second] = [...bodies.keys()]
      await expect(
        handler.handle({
          op: 'upload-batch',
          operationId,
          handle,
          files: [
            { sourceId: 'source', path: first!, data: bodies.get(first!)!.toString('base64') },
            // Same length, different bytes: the size check passes, the digest check must not.
            {
              sourceId: 'source',
              path: second!,
              data: Buffer.alloc(bodies.get(second!)!.length, 0x41).toString('base64')
            }
          ]
        })
      ).rejects.toThrow(/upload digest does not match declaration/)
      // The failed digest discarded the whole operation, as a per-file upload does.
      await expect(
        handler.handle({
          op: 'upload-batch',
          operationId,
          handle,
          files: [{ sourceId: 'source', path: first!, data: bodies.get(first!)!.toString('base64') }]
        })
      ).rejects.toThrow(/unknown cluster skill staging handle/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('answers a replayed batch whose files are already complete, as a replayed upload does', async () => {
    const { root, handler, client } = await batchFixture(true)
    try {
      const bodies = skillBodies(3)
      const operationId = randomUUID()
      const files = declare(bodies)
      const { handle } = await client.begin({ operationId, authority, skillsAgentId: 'codex', files })
      const batch = {
        op: 'upload-batch' as const,
        operationId,
        handle,
        files: [...bodies].map(([path, body]) => ({ sourceId: 'source', path, data: body.toString('base64') }))
      }
      await expect(handler.handle(batch)).resolves.toEqual({ completed: 3 })
      await expect(handler.handle(batch)).resolves.toEqual({ completed: 3 })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
