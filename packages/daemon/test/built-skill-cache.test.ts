import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTree } from './tree-support.js'
import {
  installSkills,
  type SkillsCliInvocation,
  type SkillsCliInvocationResult
} from '../src/skills/install-skills.js'

const digest = (body: string) => createHash('sha256').update(body).digest('hex')
const COMMIT = 'a'.repeat(40)

describe("a Git source's build, shared by the workspaces that install the same content", () => {
  let root: string
  let gitDir: string
  let builtDir: string
  let builds: number

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ac-built-skills-'))
    gitDir = join(root, 'sources', 'git-skill')
    builtDir = join(root, 'built')
    builds = 0
    await mkdir(gitDir, { recursive: true })
    await writeFile(join(gitDir, 'SKILL.md'), '---\nname: git-skill\ndescription: fixture\n---\n# one\n')
  })

  afterEach(async () => {
    await removeTree(root)
  })

  const cli = async (input: SkillsCliInvocation): Promise<SkillsCliInvocationResult> => {
    builds += 1
    const relativeRoot = '.runtime/skills/git-skill'
    const bundleDir = join(input.cellDir, ...relativeRoot.split('/'))
    await mkdir(bundleDir, { recursive: true })
    const body = await readFile(join(input.sourceDir, 'SKILL.md'), 'utf8')
    await writeFile(join(bundleDir, 'SKILL.md'), body)
    return { bundles: [{ relativeRoot, sourceDir: bundleDir }], stdoutDigest: digest('ok'), stderrDigest: digest('') }
  }

  /** One new session's workspace: its own checkout, the daemon's shared state. */
  const install = async (name: string) => {
    const cwd = join(root, name)
    await mkdir(cwd)
    const result = await installSkills(
      {
        id: 'agent',
        runtime: 'claude',
        skills: [{ name: 'shared', source: 'https://git.example.test/example-org/shared.git', skills: [] }]
      },
      cwd,
      {
        stateDir: join(root, 'state'),
        builtSkillsDir: builtDir,
        acquireGit: async () => ({ sourceDir: gitDir, resolvedCommit: COMMIT }),
        runCli: cli
      }
    )
    return { result, skill: await readFile(join(cwd, '.runtime', 'skills', 'git-skill', 'SKILL.md'), 'utf8') }
  }

  it('builds once and installs the same bundle into the next workspace without building', async () => {
    const first = await install('session-1')
    const second = await install('session-2')
    expect(builds).toBe(1)
    expect(second.skill).toBe(first.skill)
    expect(second.result.installed).toEqual(first.result.installed)
    expect(second.result.errors).toEqual([])
  })

  it('builds again when the source content changes', async () => {
    await install('session-1')
    await writeFile(join(gitDir, 'SKILL.md'), '---\nname: git-skill\ndescription: fixture\n---\n# two\n')
    const changed = await install('session-2')
    expect(builds).toBe(2)
    expect(changed.skill).toContain('# two')
  })

  it('rebuilds instead of installing a damaged entry', async () => {
    await install('session-1')
    const [entry] = (await readdir(builtDir)).filter((name) => /^[a-f0-9]{64}$/.test(name))
    await writeFile(join(builtDir, entry!, '0', 'SKILL.md'), 'tampered\n')
    const next = await install('session-2')
    expect(builds).toBe(2)
    expect(next.skill).toContain('# one')
    expect(next.result.errors).toEqual([])
  })
})
