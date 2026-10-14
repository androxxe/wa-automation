// ─── Target sweep — safety net for auto-completion ──────────────────────────
// Replies that become qualifying AFTER ingestion (manual correction via
// PUT /api/replies/:id, bulk reanalyze script, batch photo import) never pass
// through the stop-on-target check in the worker / POST /api/replies paths.
// This sweep re-evaluates every RUNNING campaign on a cron schedule so those
// campaigns still flip targetReached → COMPLETED without operator action.
//
// Runs in the API process: every TARGET_SWEEP_CRON (default every 5 min)
// plus once at startup. Idempotent — only touches areas with
// targetReached=false and campaigns that are still RUNNING.

import cron from 'node-cron'
import { db } from './db'

const CRON_EXPR = process.env.TARGET_SWEEP_CRON ?? '*/5 * * * *'

let _isSweeping = false

interface SweepResult {
  checked:       number
  areasReached:  number
  completed:     number
}

// ─── Single sweep pass ──────────────────────────────────────────────────────

export async function sweepTargets(): Promise<SweepResult> {
  if (_isSweeping) {
    console.log('[sweep] previous sweep still running, skipping this tick')
    return { checked: 0, areasReached: 0, completed: 0 }
  }
  _isSweeping = true
  try {
    const appConfig = await db.appConfig.findUnique({ where: { id: 'singleton' } })
    const campaigns = await db.campaign.findMany({
      where:  { status: 'RUNNING', stopOnTargetReached: true },
      select: { id: true, targetRepliesPerArea: true, targetReplyMode: true },
    })

    let areasReached = 0
    let completed    = 0

    for (const campaign of campaigns) {
      const target = campaign.targetRepliesPerArea ?? appConfig?.defaultTargetRepliesPerArea ?? 20
      const mode   = campaign.targetReplyMode ?? 'ALL'

      const areas = await db.campaignArea.findMany({
        where:  { campaignId: campaign.id, targetReached: false },
        select: { areaId: true },
      })
      if (areas.length === 0) continue

      for (const { areaId } of areas) {
        const qualifyingCount = await db.reply.count({
          where: {
            message: { campaignId: campaign.id, contact: { areaId } },
            ...(mode === 'YES'    ? { jawaban: 1 }              : {}),
            ...(mode === 'YES_NO' ? { jawaban: { in: [0, 1] } } : {}),
          },
        })
        if (qualifyingCount < target) continue

        await db.campaignArea.update({
          where: { campaignId_areaId: { campaignId: campaign.id, areaId } },
          data:  { targetReached: true },
        })
        await db.message.updateMany({
          where: { campaignId: campaign.id, status: { in: ['PENDING', 'QUEUED'] }, contact: { areaId } },
          data:  { status: 'CANCELLED' },
        })
        areasReached++
        console.log(`[sweep] target reached for area ${areaId} in campaign ${campaign.id} (${qualifyingCount}/${target})`)
      }

      const remaining = await db.campaignArea.count({
        where: { campaignId: campaign.id, targetReached: false },
      })
      if (remaining > 0) continue

      const total = await db.campaignArea.count({ where: { campaignId: campaign.id } })
      if (total === 0) continue

      const updated = await db.campaign.updateMany({
        where: { id: campaign.id, status: 'RUNNING' },
        data:  { status: 'COMPLETED', completedAt: new Date() },
      })
      if (updated.count > 0) {
        completed++
        console.log(`[sweep] campaign ${campaign.id} COMPLETED — all areas reached target`)
      }
    }

    if (areasReached > 0 || completed > 0) {
      console.log(`[sweep] done — checked ${campaigns.length}, areas reached ${areasReached}, completed ${completed}`)
    }
    return { checked: campaigns.length, areasReached, completed }
  } finally {
    _isSweeping = false
  }
}

// ─── Scheduler wiring ───────────────────────────────────────────────────────

export function startTargetSweep(): void {
  if (process.env.TARGET_SWEEP_ENABLED === 'false') {
    console.log('[sweep] disabled via TARGET_SWEEP_ENABLED=false')
    return
  }
  if (!cron.validate(CRON_EXPR)) {
    console.error(`[sweep] invalid TARGET_SWEEP_CRON expr: ${CRON_EXPR} — sweep not scheduled`)
    return
  }

  // Run once at startup (fire-and-forget), then on schedule
  sweepTargets().catch((err) => console.error('[sweep] startup run failed:', err))
  cron.schedule(CRON_EXPR, () => {
    sweepTargets().catch((err) => console.error('[sweep] scheduled run failed:', err))
  })
  console.log(`[sweep] target sweep scheduled '${CRON_EXPR}' + at startup`)
}
