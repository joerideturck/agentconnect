import { describe, expect, it } from 'vitest'
import { ChannelInfoCache } from '../src/slack/channel-info-cache.js'

describe('ChannelInfoCache', () => {
  it('answers a channel from one request while it is fresh, and asks again once it is not', async () => {
    let now = 0
    const cache = new ChannelInfoCache<string>(60_000, () => now)
    let calls = 0
    const fetch = async () => `answer-${++calls}`

    expect(await Promise.all([cache.get('C1', fetch), cache.get('C1', fetch)])).toEqual(['answer-1', 'answer-1'])
    now = 59_999
    expect(await cache.get('C1', fetch)).toBe('answer-1')
    expect(await cache.get('C2', fetch)).toBe('answer-2')
    now = 60_000
    expect(await cache.get('C1', fetch)).toBe('answer-3')
    expect(cache.takeCounts()).toEqual({ hits: 2, misses: 3 })
    expect(cache.takeCounts()).toEqual({ hits: 0, misses: 0 })
  })

  it('never keeps a failed answer', async () => {
    const cache = new ChannelInfoCache<string>(60_000, () => 0)
    await expect(cache.get('C1', async () => Promise.reject(new Error('ratelimited')))).rejects.toThrow('ratelimited')
    expect(await cache.get('C1', async () => 'ok')).toBe('ok')
  })

  it('drops the oldest channel past its bound', async () => {
    const cache = new ChannelInfoCache<string>(60_000, () => 0, 2)
    let calls = 0
    const fetch = async () => `answer-${++calls}`
    await cache.get('C1', fetch)
    await cache.get('C2', fetch)
    await cache.get('C3', fetch)
    expect(await cache.get('C2', fetch)).toBe('answer-2')
    expect(await cache.get('C1', fetch)).toBe('answer-4')
  })
})
