import path from 'path'
import type IORedis from 'ioredis'
import type { AgentStatus } from '@aice/shared'
import { BrowserAgent } from './browser-agent'
import { db } from './db'

const PROFILES_DIR = process.env.BROWSER_PROFILE_PATH
  ?? process.env.BROWSER_PROFILES_DIR
  ?? './browser-profile'

const redisKey = (agentId: number) => `agent:${agentId}:status`

export class AgentManager {
  private agents = new Map<number, BrowserAgent>()
  private redis!: IORedis

  // ─── Init ────────────────────────────────────────────────────────────────

  async init(redis: IORedis): Promise<void> {
    this.redis = redis

    const dbAgents = await db.agent.findMany()

    if (dbAgents.length === 0) {
      console.log('[agent-manager] no agents configured — create one via the Agents UI')
    }

    for (const row of dbAgents) {
      this._register(row.id, row.profilePath, row.dailySendCap, row.breakEvery, row.breakMinMs, row.breakMaxMs, row.typeDelayMinMs, row.typeDelayMaxMs)
    }

    // Use psubscribe so NEW agents created via the UI after startup are also handled.
    // Per-agent subscribe would miss channels for agents not in the Map at init time.
    const sub = redis.duplicate()
    await sub.psubscribe('browser:command:*')

    sub.on('pmessage', async (_pattern: string, channel: string, message: string) => {
      try {
        const agentId = parseInt(channel.replace('browser:command:', ''), 10)
        const { cmd } = JSON.parse(message) as { agentId: number; cmd: string }

        // Lazy-load: if a new agent was created via API after worker startup,
        // fetch it from DB and register it now before handling the command.
        if (!this.agents.has(agentId)) {
          console.log(`[agent-manager] unknown agent ${agentId} — loading from DB`)
          const row = await db.agent.findUnique({ where: { id: agentId } })
          if (!row) {
            console.error(`[agent-manager] agent ${agentId} not found in DB, ignoring command`)
            return
          }
          this._register(row.id, row.profilePath, row.dailySendCap, row.breakEvery, row.breakMinMs, row.breakMaxMs, row.typeDelayMinMs, row.typeDelayMaxMs)
        }

        if (cmd === 'start') this.startAgent(agentId).catch(console.error)
        if (cmd === 'stop')  this.stopAgent(agentId).catch(console.error)
      } catch (err) {
        console.error('[agent-manager] pubsub handler error:', err)
      }
    })

    console.log(`[agent-manager] listening on browser:command:* (${this.agents.size} agent(s) loaded)`)
  }

  // ─── Register ─────────────────────────────────────────────────────────────

  private _register(
    agentId:         number,
    profilePath:     string,
    dailySendCap?:   number | null,
    breakEvery?:     number | null,
    breakMinMs?:     number | null,
    breakMaxMs?:     number | null,
    typeDelayMinMs?: number | null,
    typeDelayMaxMs?: number | null,
  ): BrowserAgent {
    const agent = new BrowserAgent(agentId, profilePath, dailySendCap, breakEvery, breakMinMs, breakMaxMs, typeDelayMinMs, typeDelayMaxMs)
    this.agents.set(agentId, agent)
    console.log(`[agent-manager] registered agent ${agentId} (cap=${agent.dailySendCap}/day, break every ${agent.breakEvery} msgs, ${agent.breakMinMs/1000}–${agent.breakMaxMs/1000}s | type ${agent.typeDelayMinMs}–${agent.typeDelayMaxMs}ms/key)`)
    return agent
  }

  // ─── Start / Stop ────────────────────────────────────────────────────────

  async startAgent(agentId: number): Promise<void> {
    let agent = this.agents.get(agentId)

    // Lazy-load if not registered yet (e.g. created via API after startup)
    if (!agent) {
      const row = await db.agent.findUnique({ where: { id: agentId } })
      if (!row) throw new Error(`Agent ${agentId} not found in DB`)
      agent = this._register(row.id, row.profilePath, row.dailySendCap, row.breakEvery, row.breakMinMs, row.breakMaxMs, row.typeDelayMinMs, row.typeDelayMaxMs)
    }

    // If the agent has a dead/stale context (e.g. browser was closed externally
    // while status was stuck at STARTING), force-close it before relaunching.
    if (agent.status === 'disconnected' || agent.status === 'loading') {
      await agent.close().catch(() => {})
    }

    console.log(`[agent:${agentId}] starting…`)
    await this._setStatus(agentId, 'STARTING')

    try {
      await agent.launch()
      const status = this._mapBrowserStatus(agent.status)
      await this._setStatus(agentId, status)
      console.log(`[agent:${agentId}] started — status: ${status}`)
    } catch (err) {
      await this._setStatus(agentId, 'ERROR')
      console.error(`[agent:${agentId}] start failed:`, err)
      throw err
    }
  }

  async stopAgent(agentId: number): Promise<void> {
    const agent = this.agents.get(agentId)
    if (!agent) {
      console.warn(`[agent:${agentId}] stop requested but agent not in memory`)
      return
    }
    console.log(`[agent:${agentId}] stopping…`)
    await agent.close()
    await this._setStatus(agentId, 'OFFLINE')
    console.log(`[agent:${agentId}] stopped`)
  }

  // ─── Agent selection ─────────────────────────────────────────────────────

  async getLeastBusyAgent(preferredAgentId?: number): Promise<BrowserAgent> {
    if (preferredAgentId) {
      const preferred = this.agents.get(preferredAgentId)
      if (preferred && preferred.status === 'connected') return preferred
    }

    const online = Array.from(this.agents.entries())
      .filter(([, a]) => a.status === 'connected')
      .map(([id, a]) => ({ id, agent: a, active: a.activeJobCount }))

    if (online.length === 0) return Promise.reject(new Error('No agents online'))

    online.sort((a, b) => a.active - b.active)
    return online[0].agent
  }

  // ─── Accessors ────────────────────────────────────────────────────────────

  getAgent(agentId: number): BrowserAgent | undefined {
    return this.agents.get(agentId)
  }

  getAllAgents(): Array<{ agentId: number; agent: BrowserAgent }> {
    return Array.from(this.agents.entries()).map(([agentId, agent]) => ({ agentId, agent }))
  }

  // ─── Status polling ───────────────────────────────────────────────────────

  async startPollingStatus(): Promise<void> {
    setInterval(async () => {
      for (const [agentId, agent] of this.agents.entries()) {
        const prev   = agent.status
        await agent.getStatus()
        const status = this._mapBrowserStatus(agent.status)
        await this._setStatus(agentId, status)

        // Publish screenshot for ONLINE agents
        if (agent.status === 'connected') {
          const screenshot = await agent.screenshot()
          if (screenshot) await this.redis.set(`agent:${agentId}:screenshot`, screenshot, 'EX', 30)
          else            await this.redis.del(`agent:${agentId}:screenshot`)
        }

        if (prev !== agent.status) {
          console.log(`[agent:${agentId}] status changed: ${prev} → ${agent.status}`)
        }
      }
    }, 15000)
  }

  // ─── Shutdown ────────────────────────────────────────────────────────────

  async closeAll(): Promise<void> {
    for (const [agentId, agent] of this.agents.entries()) {
      await agent.close()
      await this._setStatus(agentId, 'OFFLINE')
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private async _setStatus(agentId: number, status: AgentStatus): Promise<void> {
    await this.redis.set(redisKey(agentId), status)
    await db.agent.update({ where: { id: agentId }, data: { status } }).catch(() => {})
  }

  private _mapBrowserStatus(bs: string): AgentStatus {
    if (bs === 'connected') return 'ONLINE'
    if (bs === 'qr')        return 'QR'
    if (bs === 'loading')   return 'STARTING'
    return 'OFFLINE'
  }
}

export const agentManager = new AgentManager()
