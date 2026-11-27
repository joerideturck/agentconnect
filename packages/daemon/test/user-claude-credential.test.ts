import { describe, expect, it } from 'vitest'
import {
  lookupUserClaudeCredential,
  userClaudeFallbackNotice,
  userClaudeSecretName
} from '../src/runtimes/user-claude-credential.js'

const NOW = Date.parse('2026-11-25T12:00:00Z')

function secretResponse(payload: unknown): Response {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64')
  return new Response(JSON.stringify({ payload: { data } }), { status: 200 })
}

function fakeFetch(secret: Response | Error): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = []
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input)
    urls.push(url)
    if (url.startsWith('http://metadata.google.internal/')) {
      return new Response(JSON.stringify({ access_token: 'vm-token' }), { status: 200 })
    }
    if (secret instanceof Error) throw secret
    return secret
  }) as typeof fetch
  return { fetchImpl, urls }
}

const saved = {
  token: 'sk-ant-oat01-abc',
  email: 'jan.peeters@qargo.com',
  slack_team_id: 'T01',
  slack_user_id: 'U0ABC',
  created_at: '2026-11-25T10:00:00Z',
  expires_at: '2027-11-25T10:00:00Z'
}

describe('lookupUserClaudeCredential', () => {
  it('names the secret by the lowercased Slack user id', () => {
    expect(userClaudeSecretName('U0ABC')).toBe('claude-token-slack-u0abc')
  })

  it('returns the saved token and its owner', async () => {
    const { fetchImpl, urls } = fakeFetch(secretResponse(saved))
    const lookup = await lookupUserClaudeCredential('U0ABC', { project: 'qargo-agentconnect', now: NOW, fetchImpl })
    expect(lookup.credential).toEqual({
      token: 'sk-ant-oat01-abc',
      email: 'jan.peeters@qargo.com',
      slackTeamId: 'T01',
      slackUserId: 'U0ABC',
      expiresAt: '2027-11-25T10:00:00Z'
    })
    expect(urls[1]).toBe(
      'https://secretmanager.googleapis.com/v1/projects/qargo-agentconnect/secrets/claude-token-slack-u0abc/versions/latest:access'
    )
  })

  it('treats a missing secret as missing', async () => {
    const { fetchImpl } = fakeFetch(new Response('{}', { status: 404 }))
    expect(await lookupUserClaudeCredential('U0ABC', { project: 'p', now: NOW, fetchImpl })).toEqual({
      reason: 'missing'
    })
  })

  it('refuses an expired token', async () => {
    const { fetchImpl } = fakeFetch(secretResponse({ ...saved, expires_at: '2026-11-01T00:00:00Z' }))
    expect(await lookupUserClaudeCredential('U0ABC', { project: 'p', now: NOW, fetchImpl })).toEqual({
      reason: 'expired'
    })
  })

  it('turns every other failure into an error miss', async () => {
    for (const secret of [
      new Response('{}', { status: 403 }),
      secretResponse({ email: 'x@qargo.com' }),
      new Response('not json', { status: 200 }),
      new Error('network down')
    ]) {
      const { fetchImpl } = fakeFetch(secret)
      expect(await lookupUserClaudeCredential('U0ABC', { project: 'p', now: NOW, fetchImpl })).toEqual({
        reason: 'error'
      })
    }
  })
})

describe('userClaudeFallbackNotice', () => {
  const base = {
    sessionKey: 'slack:C1:1795621412.679719:agent-1:slack:scope',
    firstLaunch: true,
    starter: { platform: 'slack', id: 'U123', isBot: false },
    reason: 'missing' as const
  }

  it('tells the person who opened a new session where to connect', () => {
    expect(userClaudeFallbackNotice(base)).toEqual({
      user: 'U123',
      text: expect.stringContaining('https://qai.qargo.com/claude-account/')
    })
    expect(userClaudeFallbackNotice({ ...base, reason: 'expired' })?.text).toContain('expired')
  })

  it('stays quiet for a session under way, a bot opener, an unknown opener or a lookup error', () => {
    expect(userClaudeFallbackNotice({ ...base, firstLaunch: false })).toBeUndefined()
    expect(userClaudeFallbackNotice({ ...base, starter: { ...base.starter, isBot: true } })).toBeUndefined()
    expect(userClaudeFallbackNotice({ ...base, starter: { platform: 'slack', id: 'U123' } })).toBeUndefined()
    expect(
      userClaudeFallbackNotice({ ...base, starter: { platform: 'slack', id: 'B0AB12', isBot: false } })
    ).toBeUndefined()
    expect(userClaudeFallbackNotice({ ...base, reason: 'error' })).toBeUndefined()
    expect(userClaudeFallbackNotice({ ...base, reason: undefined })).toBeUndefined()
  })
})
