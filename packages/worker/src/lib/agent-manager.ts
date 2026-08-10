import path from "path"
import type IORedis from "ioredis"
import type { AgentStatus } from "@aice/shared"
import { BrowserAgent } from "./browser-agent"
import { db } from "./db"

const PROFILES_DIR =
  process.env.BROWSER_PROFILE_PATH ??
  process.env.BROWSER_PROFILES_DIR ??
  "./browser-profile"

const redisKey = (agentId: number) => `agent:${agentId}:status`

const qrRedisKey = (agentId: number) => `agent:${agentId}:qr`

const screenshotRedisKey = (agentId: number) => `agent:${agentId}:screenshot`

// Cadence for periodic screenshot captures (the Agents UI can also request an
// immediate capture on demand via the 'screenshot' browser command).
const AGENT_SCREENSHOT_INTERVAL_MS = parseInt(
  process.env.AGENT_SCREENSHOT_INTERVAL_MS ?? "60000",
  10,
)

// Keep the key alive between periodic captures (min 2x interval, floor 120s).
const SCREENSHOT_TTL_SEC = Math.max(AGENT_SCREENSHOT_INTERVAL_MS * 2, 120000) / 1000

export class AgentManager {
  private agents = new Map<number, BrowserAgent>()
  private redis!: IORedis
  private lastScreenshotAt = new Map<number, number>()

  // ─── Init ────────────────────────────────────────────────────────────────

  async init(redis: IORedis): Promise<void> {
    this.redis = redis

    const dbAgents = await db.agent.findMany()

    if (dbAgents.length === 0) {
      console.log(
        "[agent-manager] no agents configured — create one via the Agents UI",
      )
    }

    for (const row of dbAgents) {
      this._register(
        row.id,
        row.profilePath,
        row.dailySendCap,
        row.breakEvery,
        row.breakMinMs,
        row.breakMaxMs,
        row.typeDelayMinMs,
        row.typeDelayMaxMs,
        row.validationOnly,
      )
    }

    // Use psubscribe so NEW agents created via the UI after startup are also handled.
    // Per-agent subscribe would miss channels for agents not in the Map at init time.
    const sub = redis.duplicate()
    await sub.psubscribe("browser:command:*")

    sub.on(
      "pmessage",
      async (_pattern: string, channel: string, message: string) => {
        try {
          const agentId = parseInt(channel.replace("browser:command:", ""), 10)
          const { cmd } = JSON.parse(message) as {
            agentId: number
            cmd: string
          }

          // Lazy-load: if a new agent was created via API after worker startup,
          // fetch it from DB and register it now before handling the command.
          if (!this.agents.has(agentId)) {
            console.log(
              `[agent-manager] unknown agent ${agentId} — loading from DB`,
            )
            const row = await db.agent.findUnique({ where: { id: agentId } })
            if (!row) {
              console.error(
                `[agent-manager] agent ${agentId} not found in DB, ignoring command`,
              )
              return
            }
            this._register(
              row.id,
              row.profilePath,
              row.dailySendCap,
              row.breakEvery,
              row.breakMinMs,
              row.breakMaxMs,
              row.typeDelayMinMs,
              row.typeDelayMaxMs,
              row.validationOnly,
            )
          }

          if (cmd === "start") this.startAgent(agentId).catch(console.error)
          if (cmd === "stop") this.stopAgent(agentId).catch(console.error)
          if (cmd === "screenshot") this.captureScreenshot(agentId).catch(console.error)
        } catch (err) {
          console.error("[agent-manager] pubsub handler error:", err)
        }
      },
    )

    console.log(
      `[agent-manager] listening on browser:command:* (${this.agents.size} agent(s) loaded)`,
    )
  }

  // ─── Register ─────────────────────────────────────────────────────────────

  private _register(
    agentId: number,
    profilePath: string,
    dailySendCap?: number | null,
    breakEvery?: number | null,
    breakMinMs?: number | null,
    breakMaxMs?: number | null,
    typeDelayMinMs?: number | null,
    typeDelayMaxMs?: number | null,
    validationOnly?: boolean | null,
  ): BrowserAgent {
    const agent = new BrowserAgent(
      agentId,
      profilePath,
      dailySendCap,
      breakEvery,
      breakMinMs,
      breakMaxMs,
      typeDelayMinMs,
      typeDelayMaxMs,
      validationOnly,
    )
    // Wire QR screenshot publishing to Redis (BrowserAgent polls QR every 5s while on screen)
    agent.qrPublisher = async (b64: string) => {
      await this.redis.set(qrRedisKey(agentId), b64, "EX", 30)
    }
    this.agents.set(agentId, agent)
    const label = agent.validationOnly ? " [VALIDATION ONLY]" : ""
    console.log(
      `[agent-manager] registered agent ${agentId}${label} (cap=${agent.dailySendCap}/day, break every ${agent.breakEvery} msgs, ${agent.breakMinMs / 1000}–${agent.breakMaxMs / 1000}s | type ${agent.typeDelayMinMs}–${agent.typeDelayMaxMs}ms/key)`,
    )
    return agent
  }

  // ─── Start / Stop ────────────────────────────────────────────────────────

  async startAgent(agentId: number): Promise<void> {
    let agent = this.agents.get(agentId)

    // Lazy-load if not registered yet (e.g. created via API after startup)
    if (!agent) {
      const row = await db.agent.findUnique({ where: { id: agentId } })
      if (!row) throw new Error(`Agent ${agentId} not found in DB`)
      agent = this._register(
        row.id,
        row.profilePath,
        row.dailySendCap,
        row.breakEvery,
        row.breakMinMs,
        row.breakMaxMs,
        row.typeDelayMinMs,
        row.typeDelayMaxMs,
        row.validationOnly,
      )
    }

    // If the agent has a dead/stale context (e.g. browser was closed externally
    // while status was stuck at STARTING), force-close it before relaunching.
    if (agent.status === "disconnected" || agent.status === "loading") {
      await agent.close().catch(() => {})
    }

    console.log(`[agent:${agentId}] starting…`)
    await this._setStatus(agentId, "STARTING")

    try {
      await agent.launch()
      const status = this._mapBrowserStatus(agent.status)
      await this._setStatus(agentId, status)
      console.log(`[agent:${agentId}] started — status: ${status}`)

      // Capture initial screenshot immediately after launch
      const screenshot = await agent.screenshot()
      if (screenshot) {
        await this.redis.set(
          `agent:${agentId}:screenshot`,
          screenshot,
          "EX",
          30,
        )
        console.log(
          `[agent:${agentId}] initial screenshot captured (${screenshot.length} bytes)`,
        )
      }
    } catch (err) {
      await this._setStatus(agentId, "ERROR")
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
    await this._setStatus(agentId, "OFFLINE")
    await this.redis.del(qrRedisKey(agentId))
    console.log(`[agent:${agentId}] stopped`)
  }

  // ─── Agent selection ─────────────────────────────────────────────────────

  /**
   * Returns the least-busy connected agent that is NOT validation-only.
   * Used for campaign message sends.
   */
  async getLeastBusyAgent(preferredAgentId?: number): Promise<BrowserAgent> {
    if (preferredAgentId) {
      const preferred = this.agents.get(preferredAgentId)
      if (
        preferred &&
        preferred.status === "connected" &&
        !preferred.validationOnly &&
        !(await this.isRestricted(preferredAgentId))
      )
        return preferred
    }

    const online = (
      await Promise.all(
        Array.from(this.agents.entries()).map(async ([id, a]) => ({
          id,
          agent: a,
          active: a.activeJobCount,
          restricted: await this.isRestricted(id),
        })),
      )
    )
      .filter(({ agent, restricted }) => agent.status === "connected" && !agent.validationOnly && !restricted)
      .map(({ id, agent, active }) => ({ id, agent, active }))

    if (online.length === 0)
      return Promise.reject(new Error("No agents online"))

    online.sort((a, b) => a.active - b.active)
    return online[0].agent
  }

  /**
   * Returns the least-busy connected agent that IS validation-only.
   * Falls back to null if no validation-only agent is online.
   * Used by the phone-check worker (falls back to getLeastBusyAgent if null).
   */
  async getValidationAgent(): Promise<BrowserAgent | null> {
    const online = (
      await Promise.all(
        Array.from(this.agents.entries()).map(async ([id, a]) => ({
          id,
          agent: a,
          active: a.activeJobCount,
          restricted: await this.isRestricted(id),
        })),
      )
    )
      .filter(({ agent, restricted }) => agent.status === "connected" && agent.validationOnly && !restricted)
      .map(({ agent }) => agent)

    if (online.length === 0) return null

    online.sort((a, b) => a.activeJobCount - b.activeJobCount)
    return online[0]
  }

  // ─── Accessors ────────────────────────────────────────────────────────────

  getAgent(agentId: number): BrowserAgent | undefined {
    return this.agents.get(agentId)
  }

  getAllAgents(): Array<{ agentId: number; agent: BrowserAgent }> {
    return Array.from(this.agents.entries()).map(([agentId, agent]) => ({
      agentId,
      agent,
    }))
  }

  // ─── Status polling ───────────────────────────────────────────────────────

  /** Capture the agent's current screen and publish it to Redis (on-demand). */
  async captureScreenshot(agentId: number): Promise<void> {
    const agent = this.agents.get(agentId)
    if (!agent || agent.status === "disconnected") return
    const shot = await agent.screenshot()
    if (shot) {
      this.lastScreenshotAt.set(agentId, Date.now())
      await this.redis.set(screenshotRedisKey(agentId), shot, "EX", SCREENSHOT_TTL_SEC)
    }
  }

  async startPollingStatus(): Promise<void> {
    setInterval(async () => {
      for (const [agentId, agent] of this.agents.entries()) {
        const prev = agent.status
        await agent.getStatus()
        // DB restriction state overrides DOM detection — the restriction banner
        // only appears on new-chat attempts, so a restricted account can still
        // look "connected" on existing chats. Keep publishing RESTRICTED while
        // restrictedUntil is in the future (persists across worker restarts).
        const restricted = await this.isRestricted(agentId)
        const status = restricted ? "RESTRICTED" : this._mapBrowserStatus(agent.status)
        await this._setStatus(agentId, status)

        // Publish screenshot for all states except disconnected
        // (show preview during loading, QR, and normal online operation).
        // Capture on status change (always) or when the interval has elapsed —
        // the Agents UI can request an immediate capture via the 'screenshot'
        // browser command instead of waiting for the next tick.
        const due = (this.lastScreenshotAt.get(agentId) ?? 0) + AGENT_SCREENSHOT_INTERVAL_MS <= Date.now()
        if (agent.status !== "disconnected" && (prev !== agent.status || due)) {
          this.lastScreenshotAt.set(agentId, Date.now())
          const screenshot = await agent.screenshot()
          if (screenshot) {
            await this.redis.set(
              screenshotRedisKey(agentId),
              screenshot,
              "EX",
              SCREENSHOT_TTL_SEC,
            )
            if (agent.status === "qr" || agent.status === "loading") {
              console.log(
                `[agent:${agentId}] screenshot captured (${agent.status}, ${screenshot.length} bytes)`,
              )
            }
          } else {
            await this.redis.del(screenshotRedisKey(agentId))
            if (agent.status === "qr" || agent.status === "loading") {
              console.warn(
                `[agent:${agentId}] screenshot failed (${agent.status})`,
              )
            }
          }
        }

        if (prev !== agent.status) {
          console.log(
            `[agent:${agentId}] status changed: ${prev} → ${agent.status}`,
          )
        }

        // QR crop fallback — refresh every poll cycle while QR visible;
        // clear stale QR key once the agent leaves the qr state.
        if (agent.status === "qr") {
          const qr = await agent.qrScreenshot()
          if (qr) await this.redis.set(qrRedisKey(agentId), qr, "EX", 30)
        } else {
          await this.redis.del(qrRedisKey(agentId))
        }
      }
    }, 60000)
  }

  // ─── Shutdown ────────────────────────────────────────────────────────────

  async closeAll(): Promise<void> {
    for (const [agentId, agent] of this.agents.entries()) {
      await agent.close()
      await this._setStatus(agentId, "OFFLINE")
      await this.redis.del(qrRedisKey(agentId))
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private async _setStatus(
    agentId: number,
    status: AgentStatus,
  ): Promise<void> {
    await this.redis.set(redisKey(agentId), status)
    await db.agent
      .update({ where: { id: agentId }, data: { status } })
      .catch(() => {})
  }

  private _mapBrowserStatus(bs: string): AgentStatus {
    if (bs === "connected") return "ONLINE"
    if (bs === "qr") return "QR"
    if (bs === "loading") return "STARTING"
    if (bs === "restricted") return "RESTRICTED"
    return "OFFLINE"
  }

  // ─── Restriction handling ────────────────────────────────────────────────

  /**
   * Returns true when the agent is currently under a WhatsApp account-level
   * restriction (restrictedUntil is set and still in the future).
   * Reads from DB so the state survives worker restarts.
   */
  async isRestricted(agentId: number): Promise<boolean> {
    const row = await db.agent
      .findUnique({
        where:  { id: agentId },
        select: { restrictedUntil: true },
      })
      .catch(() => null)
    return !!row?.restrictedUntil && row.restrictedUntil.getTime() > Date.now()
  }

  /**
   * Mark an agent as restricted: bump the cumulative counter, record when it
   * happened and when the restriction is expected to lift, then publish the
   * RESTRICTED status so the UI reflects it.
   */
  async markRestricted(agentId: number, durationMs: number): Promise<void> {
    const now    = new Date()
    const until  = new Date(Date.now() + durationMs)
    const updated = await db.agent
      .update({
        where: { id: agentId },
        data:  {
          restrictionCount: { increment: 1 },
          lastRestrictedAt:  now,
          restrictedUntil:   until,
        },
        select: { restrictionCount: true },
      })
      .catch((err) => {
        console.error(`[agent-manager] markRestricted DB update failed for agent ${agentId}:`, err)
        return null
      })
    await this._setStatus(agentId, "RESTRICTED")
    console.error(
      `[agent:${agentId}] RESTRICTED — WhatsApp account-level restriction detected, sends paused until ${until.toISOString()} (restriction #${updated?.restrictionCount ?? '?'})`,
    )
  }

  /**
   * Clear the restriction (ban lifted or operator override). Resets
   * restrictedUntil and re-evaluates the live browser status.
   */
  async clearRestricted(agentId: number): Promise<void> {
    await db.agent
      .update({
        where: { id: agentId },
        data:  { restrictedUntil: null },
      })
      .catch((err) => console.error(`[agent-manager] clearRestricted DB update failed for agent ${agentId}:`, err))
    // Re-evaluate live status — the restriction banner disappears once lifted,
    // so the next DOM check returns the real state (connected/qr/...).
    const agent = this.agents.get(agentId)
    let status: AgentStatus = "OFFLINE"
    if (agent) {
      await agent.getStatus().catch(() => {})
      status = this._mapBrowserStatus(agent.status)
    }
    await this._setStatus(agentId, status)
    console.log(`[agent:${agentId}] restriction cleared — status: ${status}`)
  }
}

export const agentManager = new AgentManager()
