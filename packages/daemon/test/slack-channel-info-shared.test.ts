import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SlackConnection } from '../src/slack/connection.js'
import { LocalStore } from '../src/store/local-store.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

async function store(): Promise<LocalStore> {
  return await LocalStore.open(join(mkdtempSync(join(tmpdir(), 'ac-chinfo-')), 'local.sqlite'))
}

async function member(s: LocalStore, now: () => number, info: (args: { channel: string }) => Promise<unknown>) {
  const conn = new SlackConnection(
    {
      group: { appToken: 'xapp-1', botToken: 'xoxb-a', integrations: [] },
      onMessage: () => {},
      now,
      channelInfos: s.slackChannelInfos
    } as never,
    (opts) => {
      const app = fakeSlackAppFactory({ teamId: 'T0EXAMPLE' })(opts)
      return { ...app, client: { ...app.client, conversations: { ...app.client.conversations, info } } } as never
    }
  )
  await conn.start()
  return conn
}

describe("conversations.info answers shared through the daemon's store", () => {
  it('keeps the newest answer per workspace and channel', async () => {
    const s = await store()
    await s.slackChannelInfos.put('T1', 'C1', '{"name":"new"}', 20)
    await s.slackChannelInfos.put('T1', 'C1', '{"name":"late"}', 10)
    expect(await s.slackChannelInfos.get('T1', 'C1')).toEqual({ info: '{"name":"new"}', fetchedAt: 20 })
    expect(await s.slackChannelInfos.get('T2', 'C1')).toBeUndefined()
    await s.close()
  })

  it("lets a second member, or a restarted one, answer from the first one's fresh answer", async () => {
    const s = await store()
    let now = 1_000_000
    const first = vi.fn(async ({ channel }: { channel: string }) => ({ channel: { id: channel, name: 'deploys' } }))
    const a = await member(s, () => now, first)
    expect((await a.getChannelInfo('C1')).name).toBe('deploys')
    await vi.waitFor(async () => expect(await s.slackChannelInfos.get('T0EXAMPLE', 'C1')).toBeDefined())

    const second = vi.fn(async () => ({ channel: { id: 'C1', name: 'never asked' } }))
    const b = await member(s, () => now, second)
    now += 30_000
    expect((await b.getChannelInfo('C1')).name).toBe('deploys')
    expect(second).not.toHaveBeenCalled()
    expect(first).toHaveBeenCalledTimes(1)
    await s.close()
  })

  it('answers from a stale stored answer when Slack refuses, and asks Slack again once it is stale', async () => {
    const s = await store()
    let now = 1_000_000
    await s.slackChannelInfos.put('T0EXAMPLE', 'C1', JSON.stringify({ id: 'C1', name: 'kept' }), now)
    now += 120_000
    const refused = vi.fn(async () => Promise.reject(new Error('ratelimited')))
    const conn = await member(s, () => now, refused)
    expect((await conn.getChannelInfo('C1')).name).toBe('kept')
    expect(refused).toHaveBeenCalledTimes(1)
    await s.close()
  })

  it('asks Slack and fails as before for a channel nobody has an answer for', async () => {
    const s = await store()
    const conn = await member(
      s,
      () => 0,
      async () => Promise.reject(new Error('ratelimited'))
    )
    await expect(conn.getChannelInfo('C9')).rejects.toThrow('ratelimited')
    await s.close()
  })
})
