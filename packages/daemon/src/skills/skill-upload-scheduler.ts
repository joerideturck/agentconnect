// Uploads a skill manifest's files to a shim several at a time. Each upload is a request/reply round trip per chunk, so
// one at a time a source of a thousand files costs a thousand round trips. The shim stages each file under its source's
// directory and creates missing parent directories as it writes, and two uploads creating the same directory at once
// race in that `mkdir`. So an upload starts only when no upload in flight is creating one of the directories it needs;
// a file whose directories already exist starts right away. That keeps every shim image, old or new, safe.

export interface UploadedSkillFile {
  sourceId: string
  path: string
}

export const SKILL_UPLOAD_CONCURRENCY = 16

/** Uploads every file, at most `limit` at once; rejects with the first failure once the uploads in flight settle. */
export async function uploadSkillFiles<F extends UploadedSkillFile>(
  files: readonly F[],
  upload: (file: F) => Promise<void>,
  limit = SKILL_UPLOAD_CONCURRENCY
): Promise<void> {
  const created = new Set<string>()
  const creating = new Set<string>()
  const queue = [...files]
  const inFlight = new Set<Promise<void>>()
  let failure: { error: unknown } | undefined

  const start = (file: F, missing: string[]): void => {
    for (const dir of missing) creating.add(dir)
    const running: Promise<void> = upload(file).then(
      () => {
        for (const dir of missing) {
          creating.delete(dir)
          created.add(dir)
        }
      },
      (error: unknown) => {
        for (const dir of missing) creating.delete(dir)
        failure ??= { error }
      }
    )
    inFlight.add(running)
    void running.finally(() => inFlight.delete(running))
  }

  while (queue.length > 0 && !failure) {
    while (inFlight.size < limit && !failure) {
      const index = queue.findIndex((file) => !missingDirectories(file, created).some((dir) => creating.has(dir)))
      if (index === -1) break
      const [file] = queue.splice(index, 1)
      start(file!, missingDirectories(file!, created))
    }
    // Something is always in flight here: with nothing running, no directory is being created and the head can start.
    if (queue.length > 0 && !failure) await Promise.race(inFlight)
  }
  await Promise.all(inFlight)
  if (failure) throw failure.error
}

/** The staging directories `file` needs that no finished upload has created yet: its source's, then each parent. */
function missingDirectories(file: UploadedSkillFile, created: ReadonlySet<string>): string[] {
  const parts = file.path.replaceAll('\\', '/').split('/').slice(0, -1)
  const dirs = [`${file.sourceId}\0`]
  for (let depth = 1; depth <= parts.length; depth++) dirs.push(`${file.sourceId}\0${parts.slice(0, depth).join('/')}`)
  return dirs.filter((dir) => !created.has(dir))
}
