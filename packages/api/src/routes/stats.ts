import { Router } from 'express'
import { db } from '../lib/db'
import { redis } from '../lib/queue'

const router: import('express').Router = Router()

// GET /api/stats — dashboard stats
router.get('/', async (_req, res) => {
  try {
    // Today in WIB (UTC+7)
    const now = new Date()
    const wib = new Date(now.getTime() + 7 * 60 * 60 * 1000)
    const todayWIB = wib.toISOString().slice(0, 10) // "YYYY-MM-DD"

    // Start of today in UTC (for date comparisons)
    const todayStartUTC = new Date(`${todayWIB}T00:00:00+07:00`)

    const [
      totalContacts,
      activeCampaigns,
      sentToday,
      repliesToday,
      agents,
      dailyLogs,
    ] = await Promise.all([
      db.contact.count(),
      db.campaign.count({ where: { status: { in: ['RUNNING', 'PAUSED'] } } }),
      db.message.count({ where: { sentAt: { gte: todayStartUTC } } }),
      db.reply.count({ where: { receivedAt: { gte: todayStartUTC } } }),
      db.agent.findMany({ select: { id: true, name: true, dailySendCap: true } }),
      db.dailySendLog.findMany({ where: { date: todayWIB } }),
    ])

    const replyRateToday = sentToday > 0
      ? Math.round((repliesToday / sentToday) * 100 * 10) / 10
      : 0

    // Per-agent daily cap remaining
    const defaultCap = parseInt(process.env.DAILY_SEND_CAP ?? '150', 10)
    const agentCaps = await Promise.all(
      agents.map(async (a) => {
        const cap = a.dailySendCap ?? defaultCap
        const log = dailyLogs.find((l) => l.agentId === a.id)
        const sent = log?.count ?? 0
        const status = (await redis.get(`agent:${a.id}:status`)) ?? 'OFFLINE'
        return { agentId: a.id, name: a.name, cap, sent, remaining: Math.max(0, cap - sent), status }
      }),
    )

    const dailyCapRemaining = agentCaps.reduce((sum, a) => sum + a.remaining, 0)

    res.json({
      ok: true,
      data: {
        totalContacts,
        activeCampaigns,
        sentToday,
        replyRateToday,
        dailyCapRemaining,
        agents: agentCaps,
      },
    })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

export default router
