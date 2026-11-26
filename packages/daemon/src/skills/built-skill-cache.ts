// Daemon-owned cache of what the skills CLI built from one source: the bundles a selection of that source's content
// produced, with their file receipts. A session-isolated agent installs its skills into every new session's workspace,
// and building them means copying and hashing each source's whole tree and running the CLI over it; for an agent whose
// sources hold thousands of files that is most of a session's start. The bundles depend only on the source's content,
// the selection and the CLI that built them, so the key is those, and a new session copies the bundles instead.
//
// An entry changes nothing about what is trusted: a served bundle is copied into the run's private scratch and the
// publication re-hashes every file against its receipt before anything reaches a workspace, exactly as for a bundle the
// CLI just built. Keying on the source's content digest also means only a reader of that exact content can name an entry.

import { createHash, randomUUID } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import type { SkillFileReceipt } from './skill-install-ledger.js'

const MANIFEST = 'manifest.json'

export interface BuiltSkillBundle {
  relativeRoot: string
  files: SkillFileReceipt[]
  treeDigest: string
  /** Where the bundle's tree is: the CLI's staging when stored, the run's own copy when loaded. */
  sourceDir: string
}

interface Manifest {
  version: 1
  bundles: Array<Omit<BuiltSkillBundle, 'sourceDir'>>
}

export interface BuiltSkillCacheOptions {
  /** An entry unused for longer than this is evicted. */
  idleMs?: number
  now?: () => number
}

export class BuiltSkillCache {
  private readonly idleMs: number
  private readonly now: () => number

  constructor(
    private readonly root: string,
    options: BuiltSkillCacheOptions = {}
  ) {
    this.idleMs = options.idleMs ?? 24 * 60 * 60_000
    this.now = options.now ?? Date.now
  }

  /** The entry key for everything a build's output depends on. */
  key(parts: unknown): string {
    return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
  }

  /** Copies the entry's bundles under `destination` (one directory each), or undefined when there is no usable entry. */
  async load(key: string, destination: string): Promise<BuiltSkillBundle[] | undefined> {
    const dir = join(this.root, key)
    let manifest: Manifest
    try {
      manifest = JSON.parse(await fsp.readFile(join(dir, MANIFEST), 'utf8')) as Manifest
      if (manifest.version !== 1 || !Array.isArray(manifest.bundles) || manifest.bundles.length === 0) return undefined
    } catch {
      return undefined
    }
    try {
      await fsp.mkdir(destination, { recursive: true, mode: 0o700 })
      const loaded: BuiltSkillBundle[] = []
      for (const [index, bundle] of manifest.bundles.entries()) {
        const target = join(destination, String(index))
        await fsp.cp(join(dir, String(index)), target, { recursive: true, errorOnExist: true, force: false })
        // Checked here so a damaged entry costs a rebuild, not a publication that refuses the workspace.
        if (!(await matchesReceipts(target, bundle.files)))
          throw new Error('built skill entry does not match its receipts')
        loaded.push({ ...bundle, sourceDir: target })
      }
      const at = new Date(this.now())
      await fsp.utimes(dir, at, at).catch(() => undefined)
      return loaded
    } catch {
      // A torn or tampered entry is a miss; the build runs and the publication would have refused it anyway.
      await fsp.rm(destination, { recursive: true, force: true }).catch(() => undefined)
      return undefined
    }
  }

  /** Records a build's bundles under `key`; a concurrent store of the same key keeps the first. */
  async store(key: string, bundles: BuiltSkillBundle[]): Promise<void> {
    if (bundles.length === 0) return
    await fsp.mkdir(this.root, { recursive: true, mode: 0o700 })
    await fsp.chmod(this.root, 0o700).catch(() => undefined)
    const dir = join(this.root, key)
    const temp = `${dir}.${randomUUID()}`
    try {
      await fsp.mkdir(temp, { mode: 0o700 })
      for (const [index, bundle] of bundles.entries()) {
        await fsp.cp(bundle.sourceDir, join(temp, String(index)), { recursive: true })
      }
      const manifest: Manifest = {
        version: 1,
        bundles: bundles.map(({ relativeRoot, files, treeDigest }) => ({ relativeRoot, files, treeDigest }))
      }
      await fsp.writeFile(join(temp, MANIFEST), `${JSON.stringify(manifest)}\n`, { mode: 0o600 })
      try {
        await fsp.rename(temp, dir)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error
      }
    } finally {
      await fsp.rm(temp, { recursive: true, force: true }).catch(() => undefined)
    }
    await this.prune()
  }

  /** Evicts entries unused for longer than the idle window. */
  async prune(): Promise<void> {
    let names: string[]
    try {
      names = await fsp.readdir(this.root)
    } catch {
      return
    }
    const now = this.now()
    for (const name of names) {
      const dir = join(this.root, name)
      try {
        const stat = await fsp.stat(dir)
        // A leftover temp of a crashed store has a suffix after the key; it is removed once idle as well.
        if (now - stat.mtimeMs > this.idleMs) await fsp.rm(dir, { recursive: true, force: true })
      } catch {
        // Gone already, or not ours to read.
      }
    }
  }
}

/** Whether `dir` holds exactly the receipted files, byte for byte. */
async function matchesReceipts(dir: string, files: SkillFileReceipt[]): Promise<boolean> {
  const present = await listFiles(dir)
  if (present.length !== files.length) return false
  for (const file of files) {
    const body = await fsp.readFile(join(dir, ...file.path.split('/'))).catch(() => undefined)
    if (!body || body.length !== file.size) return false
    if (createHash('sha256').update(body).digest('hex') !== file.sha256) return false
  }
  return true
}

async function listFiles(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = []
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...(await listFiles(join(dir, entry.name), `${prefix}${entry.name}/`)))
    else out.push(`${prefix}${entry.name}`)
  }
  return out
}
