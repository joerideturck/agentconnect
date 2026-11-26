import { describe, expect, it } from 'vitest'
import { uploadSkillFiles } from '../src/skills/skill-upload-scheduler.js'

const settle = () => new Promise((resolve) => setImmediate(resolve))

/** An upload the test finishes by hand, recording which files run at once. */
function harness() {
  const running = new Map<string, () => void>()
  const started: string[] = []
  let peak = 0
  const upload = (file: { sourceId: string; path: string }) =>
    new Promise<void>((resolve) => {
      const key = `${file.sourceId}:${file.path}`
      started.push(key)
      running.set(key, () => {
        running.delete(key)
        resolve()
      })
      peak = Math.max(peak, running.size)
    })
  const finishAll = () => {
    for (const finish of [...running.values()]) finish()
  }
  return { upload, running, started, finishAll, peak: () => peak }
}

describe('uploadSkillFiles', () => {
  it('uploads one file first per new directory, then the rest of that directory side by side', async () => {
    const h = harness()
    const files = ['a/SKILL.md', 'a/one.md', 'a/two.md', 'a/three.md'].map((path) => ({ sourceId: 's', path }))
    const done = uploadSkillFiles(files, h.upload, 8)
    await settle()
    // Every file needs the source's directory and `a`, which nothing has created yet: only the first may start.
    expect([...h.running.keys()]).toEqual(['s:a/SKILL.md'])
    h.finishAll()
    await settle()
    expect([...h.running.keys()].sort()).toEqual(['s:a/one.md', 's:a/three.md', 's:a/two.md'])
    h.finishAll()
    await done
    expect(h.started).toHaveLength(4)
  })

  it('never lets two uploads in flight create the same directory, and keeps to its limit', async () => {
    const h = harness()
    const files = [
      ...['x/1', 'x/2', 'x/3', 'x/4', 'x/5', 'x/6'].map((path) => ({ sourceId: 'one', path })),
      ...['y/deep/1', 'y/deep/2', 'z/1'].map((path) => ({ sourceId: 'two', path }))
    ]
    const done = uploadSkillFiles(files, h.upload, 3)
    for (let round = 0; round < 10 && h.started.length < files.length; round++) {
      await settle()
      expect(h.running.size).toBeLessThanOrEqual(3)
      // Uploads in flight at once never both need a directory neither has seen created.
      h.finishAll()
    }
    await settle()
    h.finishAll()
    await done
    expect(new Set(h.started)).toEqual(new Set(files.map((f) => `${f.sourceId}:${f.path}`)))
    expect(h.peak()).toBeLessThanOrEqual(3)
    // The first round starts one file per source: each source's directory is new.
    expect(h.started.slice(0, 2)).toEqual(['one:x/1', 'two:y/deep/1'])
  })

  it('stops starting uploads after a failure and rejects with it once the rest settle', async () => {
    const started: string[] = []
    const files = ['a/1', 'a/2', 'a/3', 'a/4'].map((path) => ({ sourceId: 's', path }))
    await expect(
      uploadSkillFiles(
        files,
        async (file) => {
          started.push(file.path)
          if (file.path === 'a/2') throw new Error('digest mismatch')
        },
        1
      )
    ).rejects.toThrow('digest mismatch')
    expect(started).toEqual(['a/1', 'a/2'])
  })

  it('uploads nothing for an empty manifest', async () => {
    await expect(uploadSkillFiles([], async () => undefined)).resolves.toBeUndefined()
  })
})
