// One gzip stream for an operation's declared skill files, so a holder hands a session's skills to another machine's
// shim in a few large chunks instead of a request per file. Each record is a 4-byte big-endian header length, a JSON
// header `{ sourceId, path, size }` and the file's bytes. Decoding is bounded by what the receiver declared: it never
// inflates past the declared bytes plus the headers, and every record must name a declared file at its declared size.

import { gunzip, gzip } from 'node:zlib'
import { promisify } from 'node:util'

const gzipAsync = promisify(gzip)
const gunzipAsync = promisify(gunzip)

/** Bytes a record's header may take; a path and an id fit many times over. */
const MAX_HEADER_BYTES = 4096

export interface SkillArchiveEntry {
  sourceId: string
  path: string
  body: Buffer
}

export async function encodeSkillArchive(entries: Iterable<SkillArchiveEntry>): Promise<Buffer> {
  const parts: Buffer[] = []
  for (const entry of entries) {
    const header = Buffer.from(JSON.stringify({ sourceId: entry.sourceId, path: entry.path, size: entry.body.length }))
    const length = Buffer.alloc(4)
    length.writeUInt32BE(header.length)
    parts.push(length, header, entry.body)
  }
  return await gzipAsync(Buffer.concat(parts))
}

/** The archive's records, in order; throws on a malformed stream or one larger than `maxRawBytes` once inflated. */
export async function decodeSkillArchive(archive: Buffer, maxRawBytes: number): Promise<SkillArchiveEntry[]> {
  let raw: Buffer
  try {
    raw = await gunzipAsync(archive, { maxOutputLength: maxRawBytes })
  } catch (error) {
    throw new Error(`skill archive does not inflate within its declared size (${(error as Error).message})`)
  }
  const entries: SkillArchiveEntry[] = []
  let offset = 0
  while (offset < raw.length) {
    if (offset + 4 > raw.length) throw new Error('skill archive record is truncated')
    const headerLength = raw.readUInt32BE(offset)
    offset += 4
    if (headerLength === 0 || headerLength > MAX_HEADER_BYTES || offset + headerLength > raw.length) {
      throw new Error('skill archive record header is malformed')
    }
    let header: { sourceId?: unknown; path?: unknown; size?: unknown }
    try {
      header = JSON.parse(raw.subarray(offset, offset + headerLength).toString('utf8')) as typeof header
    } catch {
      throw new Error('skill archive record header is malformed')
    }
    offset += headerLength
    const { sourceId, path, size } = header
    if (typeof sourceId !== 'string' || typeof path !== 'string' || !Number.isInteger(size) || (size as number) < 0) {
      throw new Error('skill archive record header is malformed')
    }
    if (offset + (size as number) > raw.length) throw new Error('skill archive record is truncated')
    entries.push({ sourceId, path, body: raw.subarray(offset, offset + (size as number)) })
    offset += size as number
  }
  return entries
}

/** What an archive of these declared sizes inflates to at most: the bodies plus a header per file. */
export function skillArchiveRawBound(sizes: number[]): number {
  return sizes.reduce((total, size) => total + size + 4 + MAX_HEADER_BYTES, 0)
}
