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
  /** If true, this agent is reserved exclusively for phone-check (validation) jobs. */
  readonly validationOnly: boolean

  private context:       BrowserContext | null = null
  private page:          Page | null           = null
  private _status:       BrowserStatus         = 'disconnected'
  private _browserLock:  boolean               = false
  private _pollTimer:    ReturnType<typeof setInterval> | null = null

  /** Incremented when a job is assigned; decremented when it finishes. */
  activeJobCount = 0

  constructor(
    agentId:          number,
    profilePath:      string,
    dailySendCap?:    number | null,
    breakEvery?:      number | null,
    breakMinMs?:      number | null,
    breakMaxMs?:      number | null,
    typeDelayMinMs?:  number | null,
    typeDelayMaxMs?:  number | null,
    validationOnly?:  boolean | null,
  ) {
    this.agentId        = agentId
    this.profilePath    = profilePath
    this.dailySendCap   = dailySendCap   ?? parseInt(process.env.DAILY_SEND_CAP           ?? '150',    10)
    this.breakEvery     = breakEvery     ?? parseInt(process.env.MID_SESSION_BREAK_EVERY  ?? '30',     10)
    this.breakMinMs     = breakMinMs     ?? parseInt(process.env.MID_SESSION_BREAK_MIN_MS ?? '180000', 10)
    this.breakMaxMs     = breakMaxMs     ?? parseInt(process.env.MID_SESSION_BREAK_MAX_MS ?? '480000', 10)
    this.typeDelayMinMs = typeDelayMinMs ?? parseInt(process.env.TYPE_DELAY_MIN_MS        ?? '80',     10)
    this.typeDelayMaxMs = typeDelayMaxMs ?? parseInt(process.env.TYPE_DELAY_MAX_MS        ?? '180',    10)
    this.validationOnly = validationOnly ?? false
  }

  // ─── Quiet navigation (no window focus steal on macOS) ────────────────────

  /**
   * Navigate without stealing OS window focus.
   * page.goto() uses CDP Page.navigate which activates the window on macOS.
   * In-page location.href assignment stays in the renderer process and avoids it.
   */
  private async _gotoQuiet(
    url: string,
    waitUntil: 'load' | 'domcontentloaded' = 'domcontentloaded',
  ): Promise<void> {
    const page = this.page!
    // evaluate may throw when navigation destroys the execution context — that's expected
    await page.evaluate((u) => { location.href = u }, url).catch(() => {})
    await page.waitForLoadState(waitUntil)
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
        '--window-size=1920,1080',
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-default-apps',
      ],
      viewport:   HEADLESS ? { width: 1920, height: 1080 } : null,
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
    }, 5000)
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
    } catch (err) {
      console.warn(`[agent:${this.agentId}] screenshot failed:`, err instanceof Error ? err.message : String(err))
      return null
    }
  }

  // ─── sendMessage ──────────────────────────────────────────────────────────

  async sendMessage(phone: string, body: string, chatLoadTimeoutMs = 30000): Promise<void> {
    return this._withBrowserLock(async () => {
      const page   = this.page!
      const number = phone.replace('+', '')
      const url    = `https://web.whatsapp.com/send?phone=${number}&text=`

      await this._gotoQuiet(url, 'load')
      await this._typeAndSendBody(body, page, phone, chatLoadTimeoutMs)
    })
  }

  // ─── sendMessageViaSidebar ────────────────────────────────────────────────

  /**
   * Send a message by searching the phone number in the WA sidebar search box.
   * More human-like than direct URL navigation. Falls back to sendMessage() if search fails.
   */
  async sendMessageViaSidebar(phone: string, body: string, chatLoadTimeoutMs = 30000): Promise<void> {
    return this._withBrowserLock(async () => {
      const page = this.page!
      const number = phone.replace('+', '')

      // Go to main page
      await this._gotoQuiet('https://web.whatsapp.com', 'load')

      // Wait for chat list / sidebar
      await page.waitForSelector('#side, [data-testid="chat-list"]', { timeout: 15000 })
        .catch(() => { /* may use different selector — proceed anyway */ })
      await page.waitForTimeout(1000 + Math.random() * 1000)

      // Click search box — it's an <input> element with data-tab="3"
      const SEARCH_SELECTORS = [
        'input[data-tab="3"]',
        'input[aria-label="Search or start a new chat"]',
        '[data-testid="chat-list-search"]',
        'span[data-icon="search"]',
      ].join(', ')

      const searchBox = await page.waitForSelector(SEARCH_SELECTORS, { timeout: 10000 })
        .catch(() => null)

      if (!searchBox) {
        console.log(`[agent:${this.agentId}] sidebar search box not found, falling back to URL nav`)
        await this._sendViaUrl(phone, body, page, chatLoadTimeoutMs)
        return
      }

      await searchBox.click()
      await page.waitForTimeout(500)

      // Type phone number character by character
      for (const char of number) {
        await page.keyboard.type(char, {
          delay: this.typeDelayMinMs + Math.random() * (this.typeDelayMaxMs - this.typeDelayMinMs),
        })
      }
      await page.waitForTimeout(1500 + Math.random() * 1000)

      // Click first search result or press Enter
      const firstResult = await page.waitForSelector(
        '[data-testid="cell-frame-container"], [role="button"][aria-label*="' + number.slice(-4) + '"]',
        { timeout: 8000 },
      ).catch(() => null)

      if (firstResult) {
        await firstResult.click()
      } else {
        await page.keyboard.press('Enter')
      }

      await page.waitForTimeout(2000)

      // Now type and send the message body
      await this._typeAndSendBody(body, page, phone, chatLoadTimeoutMs)
    })
  }

  // ─── Internal: shared send helpers ────────────────────────────────────────

  /**
   * Core send logic used by both sendMessage() and sendMessageViaSidebar().
   * Expects the chat panel to already be open.
   */
  private async _typeAndSendBody(
    body: string,
    page: Page,
    phone: string,
    chatLoadTimeoutMs: number,
  ): Promise<void> {
    const INVALID_KEYWORDS = ['tidak terdaftar', 'not registered']
    const INPUT_SELECTORS  = [
      '[data-testid="conversation-compose-box-input"]',
      'div[contenteditable="true"][data-tab="10"]',
      'div[contenteditable="true"][aria-label="Type a message"]',
      'footer div[contenteditable="true"]',
    ].join(', ')

    const handle = await page
      .waitForFunction(
        ({ keywords, inputSel }: { keywords: string[]; inputSel: string }): string | false => {
          const modal = document.querySelector('[data-animate-modal-popup="true"]')
          if (modal) {
            const text = (modal.textContent ?? '').toLowerCase()
            if (keywords.some((kw) => text.includes(kw))) return 'invalid'
          }
          const compose = document.querySelector(inputSel)
          if (compose) return 'ready'
          return false
        },
        { keywords: INVALID_KEYWORDS, inputSel: INPUT_SELECTORS },
        { timeout: chatLoadTimeoutMs, polling: 100 },
      )
      .catch(() => null)

    const signal = handle ? ((await handle.jsonValue()) as string) : null

    if (signal === 'invalid') {
      await page.click('[data-animate-modal-popup="true"] button').catch(() => {})
      await page.waitForTimeout(500)
      throw new Error(`Nomor ${phone} tidak terdaftar di WhatsApp`)
    }

    if (!signal) {
      throw new Error(`Timeout waiting for WhatsApp chat to load for ${phone}`)
    }

    await page.click(INPUT_SELECTORS)
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
  }

  /**
   * URL-based send — extracted from original sendMessage() for reuse as fallback.
   */
  private async _sendViaUrl(phone: string, body: string, page: Page, chatLoadTimeoutMs: number): Promise<void> {
    const number = phone.replace('+', '')
    const url    = `https://web.whatsapp.com/send?phone=${number}&text=`
    await this._gotoQuiet(url, 'load')
    await this._typeAndSendBody(body, page, phone, chatLoadTimeoutMs)
  }

  // ─── checkPhoneRegistered ────────────────────────────────────────────────

  async checkPhoneRegistered(phone: string): Promise<boolean> {
    return this._withBrowserLock(async () => {
      const page   = this.page!
      const number = phone.replace('+', '')
      const url    = `https://web.whatsapp.com/send?phone=${number}&text=`

      await this._gotoQuiet(url)

      const INVALID_KEYWORDS = ['tidak terdaftar', 'not registered']
      const STABILISE_MS     = 1500
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
          { timeout: 15000, polling: 100 },
        )
        .catch(() => null)

      const result = handle ? ((await handle.jsonValue()) as string) : null

      if (result === 'invalid') {
        await page.click('[data-animate-modal-popup="true"] button').catch(() => {})
        return false
      }
      return result === 'registered'
    })
  }

  // ─── pollReplies ─────────────────────────────────────────────────────────

  async pollReplies(
    onReply:  (params: { phone: string; text: string; screenshotPath: string | null }) => Promise<void>,
    sentPhones: Map<string, { sentAt: Date; body?: string }>,
    onStale?: (phone: string, reason: 'NO_OUTGOING' | 'STALE_ANCHOR' | 'FINGERPRINT_MISSING') => Promise<void>,
    options?: { disableStaleGuard?: boolean },
  ): Promise<void> {
    // Lock is acquired PER PHONE instead of for the entire batch.
    // This allows sendMessage() to interleave between poll checks,
    // preventing long agent lockouts during large reply-poll batches.
    //
    // Random delay between phone visits (15-45s) to break the bot signal
    // of rapid-fire navigations to different numbers.
    const POLL_INTER_VISIT_MIN = parseInt(process.env.POLL_INTER_VISIT_DELAY_MIN_MS ?? '15000', 10)
    const POLL_INTER_VISIT_MAX = parseInt(process.env.POLL_INTER_VISIT_DELAY_MAX_MS ?? '45000', 10)
    let visitIndex = 0

    for (const [phone, sentInfo] of sentPhones) {
      // Yield to pending send jobs — if a send job is waiting, abort the rest
      // of this poll batch so the agent can process the message first.
      if (this.activeJobCount > 0) {
        console.log(`[agent:${this.agentId}][poll] send job waiting, yielding remaining ${sentPhones.size} phones`)
        break
      }

      // Random delay between visits (skip first visit — no need to wait before starting)
      if (visitIndex > 0) {
        const delay = POLL_INTER_VISIT_MIN + Math.random() * (POLL_INTER_VISIT_MAX - POLL_INTER_VISIT_MIN)
        console.log(`[agent:${this.agentId}][poll] inter-visit delay: ${Math.round(delay / 1000)}s`)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delay)
          // Allow interruption: if a send job arrives, resolve immediately
          const check = setInterval(() => {
            if (this.activeJobCount > 0) {
              clearInterval(check)
              clearTimeout(timer)
              resolve()
            }
          }, 500)
        })
        // Re-check after delay — a send job may have arrived during the wait
        if (this.activeJobCount > 0) {
          console.log(`[agent:${this.agentId}][poll] send job arrived during inter-visit delay, aborting remaining phones`)
          break
        }
      }
      visitIndex++

      const sentAt    = sentInfo.sentAt
      const body      = sentInfo.body
      const fingerprint = body
        ? body.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 30)
        : null

      await this._withBrowserLock(async () => {
        const page = this.page!
        const number    = phone.replace('+', '')
        const url       = `https://web.whatsapp.com/send?phone=${number}`
        const sentAtMs  = sentAt.getTime()

        await this._gotoQuiet(url)

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
          return
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
        // Fingerprint-based anchor (preferred): locate the bubble whose text matches the
        // stored body fingerprint. This is robust against:
        //   - WhatsApp Web lazy-loading (newer bubble not yet in DOM at scroll-top)
        //   - Browser locale mismatch breaking the id-ID date format check
        //   - Older conversation history containing prior outgoing messages
        //
        // Retry with scroll-to-bottom: WA Web virtualises the chat list, so the latest
        // bubble may be below the rendered viewport. We scroll the chat panel down,
        // wait briefly, and re-query the DOM up to FINGERPRINT_RETRY_MAX times.
        //
        // Fallback: if no body fingerprint is available (older call sites), use the
        // legacy "last .message-out" anchor + date staleness guard, but never return
        // STALE here — we leave that decision to the caller via NO_OUTGOING.
        const FINGERPRINT_RETRY_MAX = 3
        const FINGERPRINT_RETRY_WAIT_MS = 1500

        type PollResult =
          | { kind: 'reply'; text: string }
          | { kind: 'no_reply' }
          | { kind: 'stale'; reason: 'NO_OUTGOING' | 'STALE_ANCHOR' | 'FINGERPRINT_MISSING' }

        const runOnce = async (): Promise<PollResult> => {
          return page.evaluate((payload: {
            expectedSentAtMs: number
            disableStaleGuard: boolean
            fingerprint: string | null
          }): PollResult => {
            const { expectedSentAtMs, disableStaleGuard, fingerprint } = payload
            const rows = Array.from(document.querySelectorAll('[data-id]'))

            // ── Fingerprint-based anchor (preferred path) ─────────────────────
            if (fingerprint) {
              let fpIdx = -1
              for (let i = rows.length - 1; i >= 0; i--) {
                const el = rows[i]
                if (!el.querySelector('[data-icon="tail-out"]')) continue
                const txt = (el.textContent ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
                if (txt.includes(fingerprint)) {
                  fpIdx = i
                  break
                }
              }
              if (fpIdx === -1) {
                // No outgoing bubble matches the fingerprint we sent.
                // Two possibilities:
                //   (a) DOM hasn't rendered it yet (lazy load / scroll position)
                //   (b) The message was not actually delivered
                // The caller will retry with scroll; only after exhausting retries
                // do we report FINGERPRINT_MISSING.
                return { kind: 'stale', reason: 'FINGERPRINT_MISSING' }
              }

              const incomingAfter = rows
                .slice(fpIdx + 1)
                .filter((el) => el.querySelector('[data-icon="tail-in"]'))
              if (incomingAfter.length === 0) return { kind: 'no_reply' }
              const lastEl = incomingAfter[incomingAfter.length - 1]
              const copyableText = lastEl.querySelector('.copyable-text')
              if (!copyableText) return { kind: 'no_reply' }
              const clone = copyableText.cloneNode(true) as Element
              clone.querySelectorAll('._ahy0, ._ahy2, .xe9ewy2').forEach((e) => e.remove())
              clone.querySelectorAll('span.x1c4vz4f.x2lah0s').forEach((e) => e.remove())
              const text = clone.textContent?.trim() ?? ''
              const clean = text.replace(/\s*(\d{1,2}:\d{2}\s*(am|pm|AM|PM)?)\s*$/i, '').trim()
              return { kind: 'reply', text: clean }
            }

            // ── Legacy fallback: last .message-out + date guard ───────────────
            let anchorIdx = -1
            rows.forEach((el, idx) => {
              if (el.querySelector('[data-icon="tail-out"]')) {
                anchorIdx = idx
              }
            })
            if (anchorIdx === -1) return { kind: 'stale', reason: 'NO_OUTGOING' }

            const anchorEl = rows[anchorIdx]
            const preText  = anchorEl.querySelector?.('.copyable-text[data-pre-plain-text]')
              ?.getAttribute('data-pre-plain-text') ?? null

            if (preText && !disableStaleGuard) {
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
                  return { kind: 'stale', reason: 'STALE_ANCHOR' }
                }
              }
            }

            const incomingAfter = rows
              .slice(anchorIdx + 1)
              .filter((el) => el.querySelector('[data-icon="tail-in"]'))
            if (incomingAfter.length === 0) return { kind: 'no_reply' }
            const lastEl = incomingAfter[incomingAfter.length - 1]
            const copyableText = lastEl.querySelector('.copyable-text')
            if (!copyableText) return { kind: 'no_reply' }
            const clone = copyableText.cloneNode(true) as Element
            clone.querySelectorAll('._ahy0, ._ahy2, .xe9ewy2').forEach((e) => e.remove())
            clone.querySelectorAll('span.x1c4vz4f.x2lah0s').forEach((e) => e.remove())
            const text = clone.textContent?.trim() ?? ''
            const clean = text.replace(/\s*(\d{1,2}:\d{2}\s*(am|pm|AM|PM)?)\s*$/i, '').trim()
            return { kind: 'reply', text: clean }
          }, { expectedSentAtMs: sentAtMs, disableStaleGuard: options?.disableStaleGuard === true, fingerprint })
        }

        // Scroll the chat panel to the bottom so any lazy-loaded bubbles render
        const scrollToBottom = async (): Promise<void> => {
          await page.evaluate(() => {
            const scrollables = [
              document.querySelector('#main .copyable-area')?.parentElement,
              document.querySelector('#main [data-testid="conversation-panel-messages"]'),
              document.querySelector('#main'),
            ].filter(Boolean) as Element[]
            for (const el of scrollables) {
              el.scrollTo?.({ top: el.scrollHeight, behavior: 'instant' as ScrollBehavior })
              if ('scrollTop' in el) (el as HTMLElement).scrollTop = (el as HTMLElement).scrollHeight
            }
          }).catch(() => {})
        }

        let result: PollResult
        if (fingerprint) {
          result = await runOnce()
          let attempt = 1
          while (result.kind === 'stale' && result.reason === 'FINGERPRINT_MISSING' && attempt < FINGERPRINT_RETRY_MAX) {
            await scrollToBottom()
            await page.waitForTimeout(FINGERPRINT_RETRY_WAIT_MS)
            result = await runOnce()
            attempt++
          }
        } else {
          result = await runOnce()
        }

        if (result.kind === 'stale') {
          console.warn(
            `[agent:${this.agentId}] ${result.reason} for ${phone}` +
            (fingerprint ? ' — fingerprint not in DOM after retries; logging to metadata' : ' — no outgoing message in view'),
          )
          await onStale?.(phone, result.reason)
          return
        }

        if (result.kind === 'no_reply') {
          console.log(`[agent:${this.agentId}] no reply after sent message for ${phone}`)
          return
        }

        const lastIncoming = result.text
        console.log(`[agent:${this.agentId}] reply from ${phone}: "${lastIncoming.slice(0, 40)}${lastIncoming.length > 40 ? '…' : ''}"`)
        const screenshotPath = await this._saveReplyScreenshot(phone)
        await onReply({ phone, text: lastIncoming, screenshotPath })
      })
    }
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
