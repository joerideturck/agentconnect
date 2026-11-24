// `cron/self` over the real daemon WS edge: only organization owners schedule tasks, so the CP does not offer an agent its own cron tools.
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { AGENT_CRON_TOOLS_FEATURE } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { buildWsHarness } from '../fakes/build-ws.js'
import { InMemoryDaemonStub } from '../fakes/daemon-stub.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { AgentCronService } from '../../src/orchestrator/agentCrons.js'
import { AgentMutationGate } from '../../src/orchestrator/agentMutationGate.js'
import type { AgentDelivery } from '../../src/orchestrator/agentDelivery.js'
import { PgAgentRepo, PgCronRepo, PgIntegrationRepo } from '../../src/persistence/index.js'
import { AgentId } from '../../src/domain/ids.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

const DAEMON = 'dddddddd-dddd-4ddd-8ddd-dddddddddd31'
const OTHER = 'dddddddd-dddd-4ddd-8ddd-dddddddddd32'
const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa31'

function harness() {
  const h = buildWsHarness(prisma)
  const crons = new PgCronRepo(prisma)
  const audited: { kind: string; details?: unknown }[] = []
  h.deps.agentCrons = new AgentCronService({
    crons,
    agents: new PgAgentRepo(prisma),
    integrations: new PgIntegrationRepo(prisma),
    audit: {
      append: async (input) => {
        audited.push(input)
        return input as never
      }
    },
    // The pushes are recorded, not delivered: the fence and the row are what this tests.
    delivery: { cronUpsert: async () => {}, cronRemove: async () => {} } as unknown as AgentDelivery,
    mutations: new AgentMutationGate(),
    log: { warn: () => {} }
  })
  return { h, audited }
}

async function ready(daemonId: string) {
  const { h, audited } = harness()
  const token = await h.mintToken(daemonId, { approved: true })
  const stub = new InMemoryDaemonStub()
  h.connect(stub)
  stub.inject('auth', { apiKey: token, daemonId, agentVersion: '1.4.0' })
  await stub.expectFrame('auth/ok')
  stub.inject('register', {
    host: 'daemon-1',
    capabilities: { platforms: ['slack'], runtimes: ['claude'], acp: true, features: [AGENT_CRON_TOOLS_FEATURE] },
    maxAgents: 4,
    localState: { assignments: [], crons: [], leases: [], agents: [], integrations: [], stagedAgents: [] }
  })
  const ok = await stub.expectFrame('register/ok')
  return { stub, audited, features: (ok.payload as { serverFeatures?: string[] }).serverFeatures ?? [] }
}

async function answer(stub: InMemoryDaemonStub, id: string) {
  await stub.settled()
  return {
    reply: stub.sent.find((f) => f.corr === id && f.type === 'cron/self/result')?.payload as
      Record<string, unknown> | undefined,
    error: stub.sent.find((f) => f.corr === id && f.type === 'error')?.payload
  }
}

describe('cron/self over the daemon WS edge', () => {
  it('does not advertise the agent cron tools', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    const { features } = await ready(DAEMON)
    expect(features).not.toContain(AGENT_CRON_TOOLS_FEATURE)
  })

  it('refuses a daemon that does not serve the agent', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedDaemon(prisma, OTHER)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    const { stub } = await ready(OTHER)
    const { error } = await answer(stub, stub.inject('cron/self', { op: 'list', agentId: AGENT }))
    expect(error).toMatchObject({ code: 'SCOPE_DENIED' })
  })

  it('refuses an agent saving or deleting a cron, and lists the ones bound to it', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    const { stub, audited } = await ready(DAEMON)
    const saved = await answer(
      stub,
      stub.inject('cron/self', {
        orgId: DEFAULT_ORG_ID,
        op: 'save',
        agentId: AGENT,
        cron: { schedule: '0 9 * * *', timezone: 'UTC', trigger: 'check the deploy' }
      })
    )
    expect(saved.error).toMatchObject({ code: 'SCOPE_DENIED' })
    expect(await new PgCronRepo(prisma).listForAgent(AgentId(AGENT))).toHaveLength(0)

    const deleted = await answer(
      stub,
      stub.inject('cron/self', { orgId: DEFAULT_ORG_ID, op: 'delete', agentId: AGENT, cronId: randomUUID() })
    )
    expect(deleted.error).toMatchObject({ code: 'SCOPE_DENIED' })

    const listed = await answer(stub, stub.inject('cron/self', { orgId: DEFAULT_ORG_ID, op: 'list', agentId: AGENT }))
    expect(listed.reply).toMatchObject({ status: 'ok', crons: [] })
    expect(audited).toHaveLength(0)
  })
})
