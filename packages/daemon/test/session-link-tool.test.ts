import { describe, expect, it, vi } from 'vitest'
import { sessionLink, type SessionLinkReq } from '../src/mcp/ops/session.js'
import type { SessionContext } from '../src/mcp/ops/context.js'

const ctx = {
  agentId: 'agent-1',
  platform: 'slack',
  integrationId: 'int-1',
  transportScope: 'T0123',
  isDm: true,
  channel: 'D0123',
  thread: '1700000000.000100',
  deliveryThread: '1700000000.000100',
  tools: []
} as unknown as SessionContext

describe('sessionLink', () => {
  it('asks the daemon for the calling session, from the trusted context only', async () => {
    const link = vi.fn(async (_req: SessionLinkReq) => ({
      sessionId: '11111111-1111-4111-8111-111111111111',
      url: 'https://qai.example/org/sessions/11111111-1111-4111-8111-111111111111?source=slack'
    }))
    const result = await sessionLink(ctx, {}, { sessionLink: link })
    expect(result).toEqual({
      sessionId: '11111111-1111-4111-8111-111111111111',
      url: 'https://qai.example/org/sessions/11111111-1111-4111-8111-111111111111?source=slack'
    })
    expect(link).toHaveBeenCalledWith({
      callerAgentId: 'agent-1',
      platform: 'slack',
      callerChannel: 'D0123',
      callerThread: '1700000000.000100',
      callerTransportScope: 'T0123',
      integrationId: 'int-1'
    })
  })

  it('refuses arguments: the session is never chosen by the model', async () => {
    const link = vi.fn(async () => null)
    await expect(sessionLink(ctx, { sessionId: 'other' }, { sessionLink: link })).rejects.toThrow()
    expect(link).not.toHaveBeenCalled()
  })

  it('says so when the session has no id yet, or the daemon has no link', async () => {
    await expect(sessionLink(ctx, {}, { sessionLink: async () => null })).rejects.toThrow(/no id yet/)
    await expect(sessionLink(ctx, {}, {})).rejects.toThrow(/unavailable/)
  })
})
