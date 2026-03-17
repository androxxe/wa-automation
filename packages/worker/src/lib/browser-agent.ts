import fs from 'fs'
import path from 'path'
import { chromium, type BrowserContext, type Page } from 'playwright'
import type { BrowserStatus } from '@aice/shared'

const HEADLESS = process.env.BROWSER_HEADLESS === 'true'

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const STEALTH_SCRIPT = `
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  window.chrome = { runtime: {} };
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  Object.defineProperty(navigator, 'languages', { get: () => ['id-ID', 'id', 'en-US', 'en'] });
  const originalQuery = window.navigator.permissions?.query;
  if (originalQuery) {
    window.navigator.permissions.query = (parameters) =>
      parameters.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery(parameters);
  }
`

export class BrowserAgent {
  readonly agentId:    number
  readonly profilePath: string
  // Per-agent caps and timings — resolved at construction from DB row, fallback to env
  readonly dailySendCap:   number
  readonly breakEvery:     number
  readonly breakMinMs:     number
  readonly breakMaxMs:     number
  readonly typeDelayMinMs: number
  readonly typeDelayMaxMs: number

  private context:       BrowserContext | null = null
  private page:          Page | null           = null
  private _status:       BrowserStatus         = 'disconnected'
  private _browserLock:  boolean               = false
  private _pollTimer:    ReturnType<typeof setInterval> | null = null

  /** Incremented when a job is assigned; decremented when it finishes. */
  activeJobCount = 0

  constructor(
    agentId:         number,
    profilePath:     string,
    dailySendCap?:   number | null,
    breakEvery?:     number | null,
    breakMinMs?:     number | null,
    breakMaxMs?:     number | null,
    typeDelayMinMs?: number | null,
    typeDelayMaxMs?: number | null,
  ) {
    this.agentId        = agentId
    this.profilePath    = profilePath
    this.dailySendCap   = dailySendCap   ?? parseInt(process.env.DAILY_SEND_CAP           ?? '150',    10)
    this.breakEvery     = breakEvery     ?? parseInt(process.env.MID_SESSION_BREAK_EVERY  ?? '30',     10)
    this.breakMinMs     = breakMinMs     ?? parseInt(process.env.MID_SESSION_BREAK_MIN_MS ?? '180000', 10)
    this.breakMaxMs     = breakMaxMs     ?? parseInt(process.env.MID_SESSION_BREAK_MAX_MS ?? '480000', 10)
    this.typeDelayMinMs = typeDelayMinMs ?? parseInt(process.env.TYPE_DELAY_MIN_MS        ?? '80',     10)
    this.typeDelayMaxMs = typeDelayMaxMs ?? parseInt(process.env.TYPE_DELAY_MAX_MS        ?? '180',    10)
  }

  // ─── Lock ─────────────────────────────────────────────────────────────────

  async _withBrowserLock<T>(fn: () => Promise<T>): Promise<T> {
    while (this._browserLock) {
      await new Promise((r) => setTimeout(r, 50))
    }
    this._browserLock = true
    try {
      return await fn()
    } finally {
      this._browserLock = false
    }
  }

  // ─── Status ───────────────────────────────────────────────────────────────

  get status(): BrowserStatus {
    return this._status
  }

  async getStatus(): Promise<BrowserStatus> {
    this._status = await this._detectStatus()
    return this._status
  }

  private async _detectStatus(): Promise<BrowserStatus> {
    if (!this.page) return 'disconnected'
    try {
      const connected = await this.page
        .waitForSelector(
          '[data-testid="chat-list"], #side, [aria-label="Chat list"], ._aigs',
          { timeout: 30000 },
        )
        .then(() => true)
        .catch(() => false)
      if (connected) return 'connected'

      const qr = await this.page
        .waitForSelector(
          'canvas[aria-label="Scan this QR code to link a device"], [data-testid="qrcode"], canvas[aria-label="QR code"]',
          { timeout: 8000 },
        )
        .then(() => true)
        .catch(() => false)
      if (qr) return 'qr'

      return 'loading'
    } catch {
      return 'loading'
    }
  }

  // ─── Launch ───────────────────────────────────────────────────────────────

  async launch(): Promise<void> {
    // Should not happen — AgentManager calls close() before relaunch.
    // Guard against double-launch just in case.
    if (this.context) {
      console.warn(`[agent:${this.agentId}] launch() called but context already exists — skipping`)
      return
    }

    this._status = 'loading'

    fs.mkdirSync(this.profilePath, { recursive: true })

    for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      const p = path.join(this.profilePath, lock)
      if (fs.existsSync(p)) fs.rmSync(p, { force: true })
    }

    this.context = await chromium.launchPersistentContext(this.profilePath, {
      headless: HEADLESS,
      args: [
        '--no-sandbox',
        '--start-maximized',
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-default-apps',
      ],
      viewport:   null,
      userAgent:  USER_AGENT,
      locale:     'id-ID',
      timezoneId: 'Asia/Jakarta',
    })

    await this.context.addInitScript(STEALTH_SCRIPT)

    const pages = this.context.pages()
    this.page = pages.length > 0 ? pages[0] : await this.context.newPage()

    // Detect when the browser window is closed externally (user closes the window,
    // process killed, crash, etc.) and reset internal state so AgentManager's
    // status polling publishes OFFLINE and the user can click Start again.
    this.context.on('close', () => {
      console.log(`[agent:${this.agentId}] browser context closed — resetting to disconnected`)
      this._status = 'disconnected'
      this.context = null
      this.page    = null
      if (this._pollTimer) {
        clearInterval(this._pollTimer)
        this._pollTimer = null
      }
    })

    await this.page.goto('https://web.whatsapp.com', { waitUntil: 'domcontentloaded' })

    this._status = await this._detectStatus()
    console.log(`[agent:${this.agentId}] initial status: ${this._status}`)

    this._startPolling()
  }

  private _startPolling() {
    if (this._pollTimer) return
    this._pollTimer = setInterval(async () => {
      if (!this.page) return
      const prev    = this._status
      this._status  = await this._detectStatus()
      if (this._status !== prev) {
        console.log(`[agent:${this.agentId}] status: ${prev} → ${this._status}`)
      }
    }, 15000)
  }

  // ─── Screenshot ───────────────────────────────────────────────────────────

  async screenshot(): Promise<string | null> {
    if (!this.page) return null
    try {
      // Try to capture just the chat panel (#main) — excludes browser chrome and sidebar.
      // Falls back to full-page screenshot if the element is not found.
      const chatPanel = this.page.locator('#main').first()
      const isVisible = await chatPanel.isVisible().catch(() => false)
      const buf = isVisible
        ? await chatPanel.screenshot({ type: 'jpeg', quality: 60 })
        : await this.page.screenshot({ type: 'jpeg', quality: 60 })
      return buf.toString('base64')
    } catch {
      return null
    }
  }

  // ─── sendMessage ──────────────────────────────────────────────────────────

  async sendMessage(phone: string, body: string): Promise<void> {
    return this._withBrowserLock(async () => {
      const page   = this.page!
      const number = phone.replace('+', '')
      const url    = `https://web.whatsapp.com/send?phone=${number}&text=`

      await page.goto(url, { waitUntil: 'load' })

      await page
        .waitForSelector('[data-testid="startup"], [data-animate-modal-popup="true"]', {
          state:   'hidden',
          timeout: 10000,
        })
        .catch(() => {})

      const invalidAlert = await page.evaluate(
        (keywords: string[]): boolean => {
          const modal = document.querySelector('[data-animate-modal-popup="true"]')
          if (!modal) return false
          const text = (modal.textContent ?? '').toLowerCase()
          return keywords.some((kw) => text.includes(kw))
        },
        ['tidak terdaftar', 'not registered'],
      )
      if (invalidAlert) {
        await page.click('[data-animate-modal-popup="true"] button').catch(() => {})
        await page.waitForTimeout(500)
        throw new Error(`Nomor ${phone} tidak terdaftar di WhatsApp`)
      }

      const inputSelector = [
        '[data-testid="conversation-compose-box-input"]',
        'div[contenteditable="true"][data-tab="10"]',
        'div[contenteditable="true"][aria-label="Type a message"]',
        'footer div[contenteditable="true"]',
      ].join(', ')

      await page.waitForSelector(inputSelector, { timeout: 30000 })
      await page.click(inputSelector)
      await page.waitForTimeout(500)

      await page.keyboard.press('Control+A')
      await page.keyboard.press('Backspace')
      await page.waitForTimeout(200)

      const lines = body.split('\n')
      for (let i = 0; i < lines.length; i++) {
        for (const char of lines[i]) {
          await page.keyboard.type(char, {
            delay: this.typeDelayMinMs + Math.random() * (this.typeDelayMaxMs - this.typeDelayMinMs),
          })
        }
        if (i < lines.length - 1) {
          await page.keyboard.press('Shift+Enter')
          await page.waitForTimeout(300 + Math.random() * 300)
        }
      }

      await page.waitForTimeout(1000 + Math.random() * 2000)
      await page.keyboard.press('Enter')
      await page.waitForTimeout(1500)
    })
  }

  // ─── checkPhoneRegistered ────────────────────────────────────────────────

  async checkPhoneRegistered(phone: string): Promise<boolean> {
    return this._withBrowserLock(async () => {
      const page   = this.page!
      const number = phone.replace('+', '')
      const url    = `https://web.whatsapp.com/send?phone=${number}&text=`

      await page.goto(url, { waitUntil: 'domcontentloaded' })

      const INVALID_KEYWORDS = ['tidak terdaftar', 'not registered']
      const STABILISE_MS     = 2000
      const runId            = Date.now().toString()

      const handle = await page
        .waitForFunction(
          ({
            keywords,
            stabiliseMs,
            id,
          }: { keywords: string[]; stabiliseMs: number; id: string }): string | false => {
            const w = window as unknown as Record<string, unknown>
            if (w['__wc_runId'] !== id) {
              w['__wc_runId']       = id
              w['__wc_composeSince'] = 0
            }
            const modal = document.querySelector('[data-animate-modal-popup="true"]')
            if (modal) {
              const text = (modal.textContent ?? '').toLowerCase()
              if (keywords.some((kw) => text.includes(kw))) return 'invalid'
            }
            const compose = document.querySelector(
              '[data-testid="conversation-compose-box-input"], ' +
                'div[contenteditable="true"][data-tab="10"], ' +
                'footer div[contenteditable="true"]',
            )
            if (compose) {
              if (!w['__wc_composeSince']) w['__wc_composeSince'] = Date.now()
              if ((Date.now() - (w['__wc_composeSince'] as number)) >= stabiliseMs) return 'registered'
            } else {
              w['__wc_composeSince'] = 0
            }
            return false
          },
          { keywords: INVALID_KEYWORDS, stabiliseMs: STABILISE_MS, id: runId },
          { timeout: 25000, polling: 100 },
        )
        .catch(() => null)

      const result = handle ? ((await handle.jsonValue()) as string) : null

      if (result === 'invalid') {
        await page.click('[data-animate-modal-popup="true"] button').catch(() => {})
        return false
      }
      return true
    })
  }

  // ─── pollReplies ─────────────────────────────────────────────────────────

  async pollReplies(
    onReply:  (params: { phone: string; text: string; screenshotPath: string | null }) => Promise<void>,
    sentPhones: Map<string, Date>,
    onStale?: (phone: string) => Promise<void>,
  ): Promise<void> {
    return this._withBrowserLock(async () => {
      const page = this.page!

      for (const [phone, sentAt] of sentPhones) {
        const number    = phone.replace('+', '')
        const url       = `https://web.whatsapp.com/send?phone=${number}`
        const sentAtMs  = sentAt.getTime()

        await page.goto(url, { waitUntil: 'domcontentloaded' })

        await page
          .waitForSelector('[data-testid="startup"]', { state: 'hidden', timeout: 10000 })
          .catch(() => {})

        const chatLoaded = await page
          .waitForSelector(
            [
              'footer div[contenteditable="true"]',
              '[data-testid="conversation-compose-box-input"]',
              'div[contenteditable="true"][data-tab="10"]',
            ].join(', '),
            { timeout: 20000 },
          )
          .then(() => true)
          .catch(() => false)

        if (!chatLoaded) {
          console.log(`[agent:${this.agentId}] chat failed to load for ${phone}, skipping`)
          continue
        }

        await page.waitForTimeout(1500)

        // Position-based anchor: find incoming messages that appear AFTER the last
        // outgoing message in the DOM. WhatsApp Web renders messages in chronological
        // order top-to-bottom, so DOM position reliably represents time order.
        //
        // This prevents old chat history from being mistaken as a reply:
        //   [old msg] Contact: "Halo..."   ← ignored (before our last .message-out)
        //   [campaign] You: "Apakah benar..."  ← anchor (last .message-out)
        //   [reply] Contact: "Iya sudah"   ← ✓ captured
        //
        // Staleness guard: if the anchor's date is >2 days before the expected sentAt,
        // our latest Bulan-2 message never appeared in WhatsApp (silent delivery failure).
        // In that case we must NOT fire handleReply — doing so would attribute the old
        // Bulan-1 reply (R1, which sits after M1 in the DOM) to the Bulan-2 message (M2).
        const lastIncoming = await page.evaluate((expectedSentAtMs: number): string | null | '__STALE__' => {
          // Collect all top-level message rows in DOM order
          const rows = Array.from(document.querySelectorAll(
            '[data-id], .message-in, .message-out',
          ))

          // Find the index of the last OUTGOING message (our sent campaign message)
          let anchorIdx = -1
          rows.forEach((el, idx) => {
            if (el.classList.contains('message-out') || el.querySelector('.message-out')) {
              anchorIdx = idx
            }
          })

          // No outgoing message in view — our message may not have loaded yet, skip
          if (anchorIdx === -1) return null

          // ── Staleness guard ──────────────────────────────────────────────────
          // Read the anchor's timestamp from data-pre-plain-text (e.g. "[14.30, 01/02/2026] ").
          // If the anchor message is from >2 days before expectedSentAt it means our
          // latest message (M2) never appeared in the DOM — we are anchored to an older
          // message (M1 from Bulan 1). Skip to prevent R1 being attributed to M2.
          const anchorEl = rows[anchorIdx]
          const outEl    = anchorEl.classList.contains('message-out')
            ? anchorEl
            : anchorEl.querySelector('.message-out') ?? anchorEl
          const preText  = outEl.querySelector?.('.copyable-text[data-pre-plain-text]')
            ?.getAttribute('data-pre-plain-text') ?? null

          if (preText) {
            // Format (id-ID locale): "[H.MM, DD/MM/YYYY] "
            const dm = preText.match(/,\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/)
            if (dm) {
              const day    = parseInt(dm[1], 10)
              const month  = parseInt(dm[2], 10)
              const year   = parseInt(dm[3], 10)
              const anchorDayMs  = Date.UTC(year, month - 1, day)
              const expectedDay  = new Date(expectedSentAtMs)
              const expectedDayMs = Date.UTC(
                expectedDay.getUTCFullYear(),
                expectedDay.getUTCMonth(),
                expectedDay.getUTCDate(),
              )
              const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000
              if (expectedDayMs - anchorDayMs > TWO_DAYS_MS) {
                // Anchor is from a previous campaign — our latest message (M2) is missing
                // from WhatsApp. Signal the caller so it can mark M2 as FAILED for retry.
                return '__STALE__'
              }
            }
          }
          // ────────────────────────────────────────────────────────────────────

          // Collect incoming messages strictly after the anchor
          const incomingAfter = rows
            .slice(anchorIdx + 1)
            .filter((el) => el.classList.contains('message-in') || el.querySelector('.message-in'))

          // No incoming message after our send — contact hasn't replied yet
          if (incomingAfter.length === 0) return null

          // Take the last incoming after the anchor (covers follow-up messages)
          const lastEl = incomingAfter[incomingAfter.length - 1]
          return (
            lastEl.querySelector('[data-testid="msg-text"]')?.textContent?.trim() ??
            lastEl.querySelector('.copyable-text')?.textContent?.trim() ??
            null
          )
        }, sentAtMs)

        if (lastIncoming === '__STALE__') {
          console.warn(`[agent:${this.agentId}] stale anchor for ${phone} — latest message absent from WhatsApp chat, marking FAILED for retry`)
          await onStale?.(phone)
          continue
        }

        if (!lastIncoming) {
          console.log(`[agent:${this.agentId}] no reply after sent message for ${phone}`)
          continue
        }

        console.log(`[agent:${this.agentId}] reply from ${phone}: "${lastIncoming.slice(0, 40)}${lastIncoming.length > 40 ? '…' : ''}"`)
        const screenshotPath = await this._saveReplyScreenshot(phone)
        await onReply({ phone, text: lastIncoming, screenshotPath })
      }
    })
  }

  private async _saveReplyScreenshot(phone: string): Promise<string | null> {
    const OUTPUT_FOLDER = process.env.OUTPUT_FOLDER
    if (!OUTPUT_FOLDER || !this.page) return null

    try {
      const dir       = path.join(OUTPUT_FOLDER, 'screenshots')
      fs.mkdirSync(dir, { recursive: true })

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const filename  = `${phone.replace('+', '')}_${timestamp}.jpg`
      const fullPath  = path.join(dir, filename)

      // Screenshot only the chat panel (#main); fall back to full page
      const chatPanel  = this.page.locator('#main').first()
      const isVisible  = await chatPanel.isVisible().catch(() => false)
      if (isVisible) {
        await chatPanel.screenshot({ path: fullPath, type: 'jpeg', quality: 80 })
      } else {
        await this.page.screenshot({ path: fullPath, type: 'jpeg', quality: 80 })
      }

      return `screenshots/${filename}`
    } catch (err) {
      console.warn(`[agent:${this.agentId}] screenshot failed:`, err)
      return null
    }
  }

  // ─── Close ────────────────────────────────────────────────────────────────

  async close(): Promise<void> {
    if (this._pollTimer) {
      clearInterval(this._pollTimer)
      this._pollTimer = null
    }
    // Clear internal refs FIRST so launch() can proceed even if close() throws
    // (e.g. browser was already killed externally — context.close() would error)
    const ctx    = this.context
    this.context = null
    this.page    = null
    this._status = 'disconnected'
    if (ctx) await ctx.close().catch(() => {})
  }
}
