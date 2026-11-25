// Slack's answer about a channel (conversations.info), kept where every member serving the workspace reads it: a member that
// restarts starts warm, and two members ask Slack once between them. Keyed by workspace, since channel ids are only unique there.
import type { StoreQueryResult } from './store-database.js'

export const SLACK_CHANNEL_INFO_SCHEMA = `
      CREATE TABLE IF NOT EXISTS slack_channel_info (
        teamId TEXT NOT NULL,
        channel TEXT NOT NULL,
        info TEXT NOT NULL,
        fetchedAt INTEGER NOT NULL,
        PRIMARY KEY (teamId, channel)
      );
`

export interface SlackChannelInfoDatabase {
  query(sql: string, params: unknown[]): Promise<StoreQueryResult>
}

export interface StoredSlackChannelInfo {
  /** conversations.info's `channel` object as JSON. */
  info: string
  fetchedAt: number
}

export class SlackChannelInfos {
  constructor(private readonly db: SlackChannelInfoDatabase) {}

  async get(teamId: string, channel: string): Promise<StoredSlackChannelInfo | undefined> {
    const { rows } = await this.db.query(
      'SELECT info, fetchedAt FROM slack_channel_info WHERE teamId = ? AND channel = ?',
      [teamId, channel]
    )
    const row = rows[0] as { info?: unknown; fetchedAt?: unknown } | undefined
    if (typeof row?.info !== 'string') return undefined
    return { info: row.info, fetchedAt: Number(row.fetchedAt) }
  }

  /** Keep the latest answer; an older one arriving late never replaces a newer one. */
  async put(teamId: string, channel: string, info: string, fetchedAt: number): Promise<void> {
    await this.db.query(
      `INSERT INTO slack_channel_info (teamId, channel, info, fetchedAt) VALUES (?, ?, ?, ?)
       ON CONFLICT (teamId, channel)
       DO UPDATE SET info = excluded.info, fetchedAt = excluded.fetchedAt
       WHERE slack_channel_info.fetchedAt <= excluded.fetchedAt`,
      [teamId, channel, info, fetchedAt]
    )
  }
}
