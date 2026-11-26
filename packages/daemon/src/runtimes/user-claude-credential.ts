/**
 * A Slack user's own Claude sign-in: the long-lived `claude setup-token` token they saved, read from
 * GCP Secret Manager as `claude-token-slack-<slack user id>` with this machine's service account.
 * Every failure is a miss, so the launch keeps this machine's own sign-in.
 */

const METADATA_TOKEN_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token'
const LOOKUP_TIMEOUT_MS = 2_000

export interface UserClaudeCredential {
  token: string
  email: string
  slackTeamId: string | null
  slackUserId: string
  expiresAt: string
}

export type UserClaudeLookup =
  { credential: UserClaudeCredential } | { credential?: undefined; reason: 'missing' | 'expired' | 'error' }

export function userClaudeSecretName(slackUserId: string): string {
  return `claude-token-slack-${slackUserId.toLowerCase()}`
}

async function metadataAccessToken(fetchImpl: typeof fetch): Promise<string> {
  const response = await fetchImpl(METADATA_TOKEN_URL, {
    headers: { 'Metadata-Flavor': 'Google' },
    signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS)
  })
  if (!response.ok) throw new Error(`metadata token: HTTP ${response.status}`)
  const body = (await response.json()) as { access_token?: unknown }
  if (typeof body.access_token !== 'string') throw new Error('metadata token: no access_token')
  return body.access_token
}

export async function lookupUserClaudeCredential(
  slackUserId: string,
  opts: { project: string; now: number; fetchImpl?: typeof fetch }
): Promise<UserClaudeLookup> {
  const fetchImpl = opts.fetchImpl ?? fetch
  try {
    const accessToken = await metadataAccessToken(fetchImpl)
    const url =
      `https://secretmanager.googleapis.com/v1/projects/${encodeURIComponent(opts.project)}` +
      `/secrets/${userClaudeSecretName(slackUserId)}/versions/latest:access`
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS)
    })
    if (response.status === 404) return { reason: 'missing' }
    if (!response.ok) return { reason: 'error' }
    const body = (await response.json()) as { payload?: { data?: unknown } }
    if (typeof body.payload?.data !== 'string') return { reason: 'error' }
    const saved = JSON.parse(Buffer.from(body.payload.data, 'base64').toString('utf8')) as Record<string, unknown>
    if (typeof saved.token !== 'string' || typeof saved.email !== 'string' || typeof saved.expires_at !== 'string') {
      return { reason: 'error' }
    }
    const expiresAt = Date.parse(saved.expires_at)
    if (!Number.isFinite(expiresAt) || expiresAt <= opts.now) return { reason: 'expired' }
    return {
      credential: {
        token: saved.token,
        email: saved.email,
        slackTeamId: typeof saved.slack_team_id === 'string' ? saved.slack_team_id : null,
        slackUserId,
        expiresAt: saved.expires_at
      }
    }
  } catch {
    return { reason: 'error' }
  }
}

export const CLAUDE_ACCOUNT_URL = 'https://qai.qargo.com/claude-account/'

/** A Slack person's own ids start with U or W; a bot posting as itself has a B id. */
const SLACK_PERSON_ID = /^[UW][A-Z0-9]+$/

/**
 * The note telling the person who opened a Slack session that it runs on the shared sign-in, or undefined
 * when there is nothing to tell: a session already under way, a bot opener, or a miss that saving cannot fix.
 */
export function userClaudeFallbackNotice(opts: {
  sessionKey: string
  firstLaunch: boolean
  starter?: { platform: string; id: string; isBot?: boolean }
  reason?: 'missing' | 'expired' | 'error'
}): { channel: string; thread: string; user: string; text: string } | undefined {
  const { starter, reason } = opts
  if (!opts.firstLaunch || (reason !== 'missing' && reason !== 'expired')) return undefined
  if (starter?.platform !== 'slack' || starter.isBot !== false || !SLACK_PERSON_ID.test(starter.id)) return undefined
  const [platform, channel, thread] = opts.sessionKey.split(':')
  if (platform !== 'slack' || !channel || !thread) return undefined
  const text =
    reason === 'expired'
      ? `Your saved Claude token has expired, so this conversation uses Qargo's shared Claude account. Go to <${CLAUDE_ACCOUNT_URL}> and follow the steps to connect it again.`
      : `This conversation uses Qargo's shared Claude account. To have Qai use your own Claude usage instead, go to <${CLAUDE_ACCOUNT_URL}> and follow the steps.`
  return { channel, thread, user: starter.id, text }
}
