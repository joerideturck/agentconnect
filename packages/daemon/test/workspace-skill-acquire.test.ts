import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SkillSourceFailure } from '../src/skills/skill-source-failure.js'
import { removeTree } from './tree-support.js'
import { WorkspaceManager } from '../src/workspace/workspace-manager.js'

describe("a workspace's skill install", () => {
  const roots: string[] = []
  afterEach(async () => {
    for (const root of roots.splice(0)) await removeTree(root)
  })

  it('acquires its Git sources through the acquirer it is given, so sessions can share what one fetched', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ws-skill-acquire-'))
    roots.push(root)
    const cwd = join(root, 'workspace')
    await mkdir(cwd)
    const source = { name: 'shared', source: 'https://git.example.test/example-org/shared.git', skills: [] }
    const agent = { id: 'agent', runtime: 'claude', skills: [source], workspace: { mode: 'from-scratch' } } as never
    const acquireGitSkill = vi.fn(async () => {
      throw new SkillSourceFailure('access_denied', 'refused by the test acquirer')
    })
    const reported = vi.fn()

    await new WorkspaceManager().withSkills(agent, cwd, {
      skillsStateDir: join(root, 'state'),
      acquireGitSkill,
      reportSkillSourceFailures: reported
    })

    expect(acquireGitSkill).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'shared' }),
      expect.objectContaining({ agentId: 'agent' })
    )
    expect(reported).toHaveBeenCalledWith(agent, [{ name: 'shared', code: 'access_denied' }])
  })
})
