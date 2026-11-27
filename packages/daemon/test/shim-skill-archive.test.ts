import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ShimRequester } from '../src/shim/channels.js'
import { ClusterSkillClient } from '../src/shim/skill-client.js'
import { ClusterSkillHandler } from '../src/shim/skill-handler.js'
import { MAX_CLUSTER_SKILL_CHUNK_BYTES } from '../src/shim/skill-protocol.js'
import { decodeSkillArchive, encodeSkillArchive, skillArchiveRawBound } from '../src/skills/skill-archive.js'

const sha256 = (value: Buffer): string => createHash('sha256').update(value).digest('hex')

const AUTHORITY = {
  groupId: 'g',
  term: '1',
  daemonId: 'd',
  agentId: 'a',
  workspaceIncarnation: 'claim-1',
  shimGeneration: 1
}

/** A shim with one operation declaring `files`, and a client that reaches it as the daemon would. */
async function staged(files: Array<{ sourceId: string; path: string; body: Buffer }>) {
  const root = await mkdtemp(join(tmpdir(), 'ac-shim-archive-'))
  const handler = new ClusterSkillHandler({ stagingRoot: join(root, 'staging'), inactiveMs: 60_000 })
  const requests: Array<{ op: string }> = []
  const requester: ShimRequester = {
    async request(_capability, payload) {
      requests.push(payload as { op: string })
      return await handler.handle(payload)
    }
  }
  const client = new ClusterSkillClient(requester, true, false, false, false, undefined, false, true)
  const operationId = randomUUID()
  const { handle } = await client.begin({
    operationId,
    authority: AUTHORITY,
    skillsAgentId: 'codex',
    files: files.map((file) => ({
      sourceId: file.sourceId,
      path: file.path,
      size: file.body.length,
      sha256: sha256(file.body)
    }))
  })
  return { root, handler, client, operationId, handle, requests }
}

describe('a skill archive', () => {
  it('round-trips its records and refuses to inflate past its bound', async () => {
    const entries = [
      { sourceId: 'agent:0', path: 'a/SKILL.md', body: Buffer.from('# a\n') },
      { sourceId: 'agent:1', path: 'b/empty.txt', body: Buffer.alloc(0) }
    ]
    const archive = await encodeSkillArchive(entries)
    const bound = skillArchiveRawBound(entries.map((entry) => entry.body.length))
    expect(await decodeSkillArchive(archive, bound)).toEqual(entries)
    await expect(decodeSkillArchive(archive, 8)).rejects.toThrow(/declared size/)
    await expect(decodeSkillArchive(Buffer.from('not gzip'), bound)).rejects.toThrow()
  })
})

describe('cluster skill shim archive upload', () => {
  it('stages every declared file from one archive sent in chunks, instead of a request per file', async () => {
    // One incompressible asset makes the archive span several chunks.
    const files = [
      { sourceId: 'agent:0', path: 'one/SKILL.md', body: Buffer.from('---\nname: one\n---\n') },
      { sourceId: 'agent:0', path: 'one/assets/blob.bin', body: randomBytes(MAX_CLUSTER_SKILL_CHUNK_BYTES * 2) },
      { sourceId: 'managed:x', path: 'two/SKILL.md', body: Buffer.from('---\nname: two\n---\n') }
    ]
    const f = await staged(files)
    await f.client.uploadArchive(f.operationId, f.handle, await encodeSkillArchive(files))
    for (const file of files) {
      expect(await readFile(f.handler.stagedFile(f.handle, file.sourceId, file.path))).toEqual(file.body)
    }
    const uploads = f.requests.filter((request) => request.op === 'upload-archive')
    expect(uploads.length).toBeGreaterThan(1)
    expect(uploads.length).toBeLessThan(files.length + 3)
    // The gathered archive is gone once unpacked.
    await expect(lstat(join(f.root, 'staging', f.handle, '.upload-archive.gz'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('refuses an archive naming an undeclared file or a wrong body, and removes the operation', async () => {
    const declared = { sourceId: 'agent:0', path: 'one/SKILL.md', body: Buffer.from('# one\n') }
    const stray = await staged([declared])
    await expect(
      stray.client.uploadArchive(
        stray.operationId,
        stray.handle,
        await encodeSkillArchive([declared, { sourceId: 'agent:0', path: 'one/extra.md', body: Buffer.from('x') }])
      )
    ).rejects.toThrow(/not declared/)
    await expect(lstat(join(stray.root, 'staging', stray.handle))).rejects.toMatchObject({ code: 'ENOENT' })

    const wrong = await staged([declared])
    await expect(
      wrong.client.uploadArchive(
        wrong.operationId,
        wrong.handle,
        await encodeSkillArchive([{ ...declared, body: Buffer.from('# two\n') }])
      )
    ).rejects.toThrow(/digest/)
    await expect(lstat(join(wrong.root, 'staging', wrong.handle))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses an out-of-order chunk', async () => {
    const declared = { sourceId: 'agent:0', path: 'one/SKILL.md', body: Buffer.from('# one\n') }
    const f = await staged([declared])
    await expect(
      f.handler.handle({
        op: 'upload-archive',
        operationId: f.operationId,
        handle: f.handle,
        offset: 4,
        data: Buffer.from('xxxx').toString('base64'),
        final: false
      })
    ).rejects.toThrow(/offset/)
  })

  it('publishes a skill from an archive upload as from per-file uploads, modes included', async () => {
    const content = Buffer.from('---\nname: cluster-golden\ndescription: cluster fixture\n---\n# Cluster\n')
    const script = Buffer.from('#!/bin/sh\nprintf executable\n')
    const root = await mkdtemp(join(tmpdir(), 'ac-shim-archive-reconcile-'))
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    const handler = new ClusterSkillHandler({
      stagingRoot: join(root, 'staging'),
      workspaceRoot: workspace,
      stateRoot: join(root, 'state')
    })
    const client = new ClusterSkillClient(
      { request: async (_capability, payload) => await handler.handle(payload) },
      true,
      false,
      false,
      false,
      undefined,
      false,
      true
    )
    const file = { sourceId: 'managed:a', path: 'SKILL.md', size: content.length, sha256: sha256(content) }
    const scriptFile = { ...file, path: 'run.sh', size: script.length, sha256: sha256(script), executable: true }
    const operationId = randomUUID()
    const { handle } = await client.begin({
      operationId,
      authority: AUTHORITY,
      skillsAgentId: 'codex',
      files: [file, scriptFile]
    })
    await client.uploadArchive(
      operationId,
      handle,
      await encodeSkillArchive([
        { sourceId: file.sourceId, path: file.path, body: content },
        { sourceId: scriptFile.sourceId, path: scriptFile.path, body: script }
      ])
    )
    const reply = await handler.handle({
      op: 'reconcile',
      operationId,
      handle,
      authority: AUTHORITY,
      priorRoots: [],
      replayKey: 'a'.repeat(64),
      allowDesiredAdoption: false,
      sources: [{ sourceId: file.sourceId, sourceKind: 'managed', selections: ['cluster-golden'] }]
    })
    expect(reply).toMatchObject({ roots: [{ path: '.agents/skills/cluster-golden' }], conflicts: [] })
    if (process.platform !== 'win32') {
      expect((await lstat(join(workspace, '.agents/skills/cluster-golden/run.sh'))).mode & 0o777).toBe(0o500)
      expect((await lstat(join(workspace, '.agents/skills/cluster-golden/SKILL.md'))).mode & 0o777).toBe(0o400)
    }
  }, 120_000)
})
