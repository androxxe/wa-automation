import fs from 'fs'
import path from 'path'
import { chromium, type BrowserContext, type Page } from 'playwright'
import type { BrowserStatus } from '@aice/shared'

const HEADLESS = process.env.BROWSER_HEADLESS === 'true'

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const QR_SELECTORS = [
  'canvas[aria-label="Scan this QR code to link a device!"]',
  '[data-testid="link-device-qr-code"]',
  '[data-testid="qrcode"]',
  'canvas[aria-label="QR code"]',
].join(', ')

/**
 * Thrown when WhatsApp shows the "Your account on linked devices is restricted"
 * banner in place of the compose box (verified live on web.whatsapp.com):
 *
 *   div[data-testid="block-message"]
 *     └── div[data-testid="reachout-timelock-compose-bar"]   ← replaces compose box
 *         └── span: "Your account on linked devices is restricted.
 *                    You can't start new chats right now."
 *         └── button: "Show details"
 *
 * The restriction is ACCOUNT-level (linked devices), NOT phone-level — so the
 * phone must NOT be marked unregistered, and the message must NOT be marked
 * FAILED. Callers reschedule instead.
 */
export class AccountRestrictedError extends Error {
  constructor() {
    super('WhatsApp account is restricted — cannot start new chats right now')
    this.name = 'AccountRestrictedError'
  }
}

// DOM markers for the restriction banner (verified live on web.whatsapp.com).
const RESTRICTION_SELECTORS = [
  '[data-testid="block-message"]',
  '[data-testid="reachout-timelock-compose-bar"]',
].join(', ')

// Locale-agnostic text fallback in case the data-testid attributes change.
// Scoped to the compose footer only, so normal chat messages that happen to
// contain "restricted" never trigger a false positive.
const RESTRICTION_KEYWORDS = [
  'restricted',
  "can't start new chats",
  'cannot start new chats',
  'tidak dapat memulai chat baru',
]

// ─── Interstitial / onboarding modal (e.g. "What's new on WhatsApp Web" → Continue) ───
// Verified live 2026-09-04 via Playwright MCP after QR scan:
//   <div role="dialog" active>  ← also has data-animate-modal-popup="true" in some builds
//     <h1>What’s new on WhatsApp Web</h1>
//     <button>Continue</button>   ← id-ID: "Lanjutkan"
//     <button aria-label="Close">Close</button>
// This overlay blocks the chat list and must be dismissed before reporting "connected".
const INTERSTITIAL_DIALOG_SELECTORS = [
  '[data-animate-modal-popup="true"]',
  'div[role="dialog"]',
].join(', ')

const INTERSTITIAL_TITLE_KEYWORDS = [
  "what's new",
  'whats new',
  'apa yang baru',
  'yang baru di whatsapp',
]

const CONTINUE_BUTTON_REGEX = /^(continue|lanjutkan|got it|mengerti|ok)$/i
const CONTINUE_BUTTON_REGEX_LOOSE = /continue|lanjutkan|got it|mengerti/i

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

  /**
   * Optional publisher for cropped QR screenshots (wired by AgentManager to Redis).
   * Called whenever a fresh QR crop is captured while status is 'qr'.
   */
  qrPublisher: ((b64: string) => Promise<void>) | null = null

  private context:       BrowserContext | null = null
  private page:          Page | null           = null
  private _status:       BrowserStatus         = 'disconnected'
  private _browserLock:  boolean               = false
  private _pollTimer:    ReturnType<typeof setTimeout> | null = null

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
      // Dismiss onboarding interstitial (e.g. "What's new" → Continue) before
      // checking status — it overlays the chat list and blocks interaction.
      // Fast evaluate (~0-20ms) when no dialog; only does locators when needed.
      await this._dismissInterstitialIfNeeded().catch(() => false)

      // Restriction banner takes precedence — it can be present even when the
      // chat list is visible (restricted accounts keep their chat list).
      if (await this._hasRestrictionBanner()) return 'restricted'

      const connected = await this.page
        .waitForSelector(
          '[data-testid="chat-list"], #side, [aria-label="Chat list"], ._aigs',
          { timeout: 10000 },
        )
        .then(() => true)
        .catch(() => false)
      if (connected) {
        // Double-check: a dialog may have appeared between the initial dismiss
        // and the chat-list resolving. Try once more before reporting connected.
        const dismissed = await this._dismissInterstitialIfNeeded().catch(() => false)
        if (dismissed) {
          // Give WA a moment to remove overlay, then re-verify chat list still there
          await this.page.waitForTimeout(500).catch(() => {})
        }
        return 'connected'
      }

      const qr = await this.page
        .waitForSelector(QR_SELECTORS, { timeout: 8000 })
        .then(() => true)
        .catch(() => false)
      if (qr) return 'qr'

      return 'loading'
    } catch {
      return 'loading'
    }
  }

  /**
   * Detect the account-level restriction banner. WhatsApp replaces the compose
   * box with "reachout-timelock-compose-bar" (inside "block-message") when a
   * NEW chat is attempted on a restricted account. Existing chats still show
   * the compose box, so the text fallback is scoped to the compose footer.
   */
  private async _hasRestrictionBanner(): Promise<boolean> {
    if (!this.page) return false
    try {
      const viaSelector = await this.page
        .waitForSelector(RESTRICTION_SELECTORS, { timeout: 500 })
        .then(() => true)
        .catch(() => false)
      if (viaSelector) return true

      return await this.page.evaluate((keywords: string[]) => {
        const footer = document.querySelector('footer[data-testid="compose-box"]')
        if (!footer) return false
        const text = (footer.textContent ?? '').toLowerCase()
        // NOTE: no .some()/.map() closures here — tsx/esbuild injects __name
        // into nested closures and Playwright serialization breaks in dev.
        for (const kw of keywords) {
          if (text.includes(kw)) return true
        }
        return false
      }, RESTRICTION_KEYWORDS)
    } catch {
      return false
    }
  }

  /**
   * Dismiss the "What's new on WhatsApp Web" / onboarding interstitial that appears
   * after QR scan and blocks the chat list.
   * Verified live 2026-09-04: dialog[role="dialog"] with h1 "What’s new on WhatsApp Web"
   * and button "Continue" (id-ID: "Lanjutkan"). Also seen as [data-animate-modal-popup="true"].
   * Returns true if a dialog was found and dismissed.
   */
  private async _dismissInterstitialIfNeeded(): Promise<boolean> {
    if (!this.page) return false
    const page = this.page
    try {
      // ── Fast check: is there a dialog that looks like the interstitial? ──────
      const probe = await page
        .evaluate(
          (args: { sel: string; titleKws: string[]; invalidKws: string[] }) => {
            const dialogs = Array.from(document.querySelectorAll(args.sel))
            // NOTE: plain for-loops only — nested closures break under tsx
            // (esbuild __name injection) and Playwright serialization fails.
            for (const d of dialogs) {
              const text = (d.textContent ?? '').toLowerCase()
              // Never treat the "not registered" / "tidak terdaftar" modal as interstitial —
              // it is handled separately in _typeAndSendBody / checkPhoneRegistered.
              let isInvalid = false
              for (const kw of args.invalidKws) {
                if (text.includes(kw)) { isInvalid = true; break }
              }
              if (isInvalid) continue
              let titleHit = false
              for (const kw of args.titleKws) {
                if (text.includes(kw)) { titleHit = true; break }
              }
              if (titleHit) return { found: true, snippet: text.slice(0, 120) }
              // Also match if dialog contains a Continue/Lanjutkan button
              const btns = Array.from(d.querySelectorAll('button'))
              for (const b of btns) {
                const bt = (b.textContent ?? '').toLowerCase().trim()
                if (/^(continue|lanjutkan)$/i.test(bt) || /continue|lanjutkan|got it|mengerti/i.test(bt)) {
                  return { found: true, snippet: text.slice(0, 120) }
                }
              }
            }
            return { found: false, snippet: '' }
          },
          {
            sel: INTERSTITIAL_DIALOG_SELECTORS,
            titleKws: INTERSTITIAL_TITLE_KEYWORDS,
            invalidKws: ['tidak terdaftar', 'not registered'],
          },
        )
        .catch(() => ({ found: false as const, snippet: '' }))

      if (!probe.found) return false

      console.log(
        `[agent:${this.agentId}] interstitial detected — attempting dismiss (snippet: "${probe.snippet.slice(0, 80)}...")`,
      )

      // ── Try to click Continue / Lanjutkan inside the dialog ──────────────────
      // Order: dialog-scoped Continue → global Continue → Close button
      const dialog = page.locator(INTERSTITIAL_DIALOG_SELECTORS).first()

      // Strategy 1: dialog-scoped button with Continue text
      try {
        const btn = dialog.getByRole('button', { name: CONTINUE_BUTTON_REGEX_LOOSE }).first()
        if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
          await btn.click({ timeout: 2000 })
          await page.waitForTimeout(800)
          const gone = await page
            .evaluate((sel: string) => !document.querySelector(sel), INTERSTITIAL_DIALOG_SELECTORS)
            .catch(() => false)
          if (gone) {
            console.log(`[agent:${this.agentId}] interstitial dismissed via Continue (dialog-scoped)`)
            return true
          }
        }
      } catch {}

      // Strategy 2: any visible Continue/Lanjutkan button on page (fallback)
      try {
        const globalContinue = page.getByRole('button', { name: CONTINUE_BUTTON_REGEX }).first()
        if (await globalContinue.isVisible({ timeout: 800 }).catch(() => false)) {
          await globalContinue.click({ timeout: 2000 })
          await page.waitForTimeout(800)
          const gone = await page
            .evaluate((sel: string) => !document.querySelector(sel), INTERSTITIAL_DIALOG_SELECTORS)
            .catch(() => false)
          if (gone) {
            console.log(`[agent:${this.agentId}] interstitial dismissed via Continue (global)`)
            return true
          }
        }
      } catch {}

      // Strategy 3: locator with text selector inside dialog
      try {
        const textBtn = page
          .locator(`${INTERSTITIAL_DIALOG_SELECTORS} button:has-text("Continue"), ${INTERSTITIAL_DIALOG_SELECTORS} button:has-text("Lanjutkan")`)
          .first()
        if (await textBtn.isVisible({ timeout: 800 }).catch(() => false)) {
          await textBtn.click({ timeout: 2000 })
          await page.waitForTimeout(800)
          const gone = await page
            .evaluate((sel: string) => !document.querySelector(sel), INTERSTITIAL_DIALOG_SELECTORS)
            .catch(() => false)
          if (gone) {
            console.log(`[agent:${this.agentId}] interstitial dismissed via text selector`)
            return true
          }
        }
      } catch {}

      // Strategy 4: Close / X button as last resort
      try {
        const closeBtn = page
          .locator(
            `${INTERSTITIAL_DIALOG_SELECTORS} button[aria-label="Close"], ${INTERSTITIAL_DIALOG_SELECTORS} button:has-text("Close"), [aria-label="Close"]`,
          )
          .first()
        if (await closeBtn.isVisible({ timeout: 800 }).catch(() => false)) {
          await closeBtn.click({ timeout: 2000 })
          await page.waitForTimeout(800)
          const gone = await page
            .evaluate((sel: string) => !document.querySelector(sel), INTERSTITIAL_DIALOG_SELECTORS)
            .catch(() => false)
          if (gone) {
            console.log(`[agent:${this.agentId}] interstitial dismissed via Close`)
            return true
          }
        }
      } catch {}

      console.warn(`[agent:${this.agentId}] interstitial found but no dismiss button worked`)
      return false
    } catch (err) {
      console.warn(
        `[agent:${this.agentId}] dismiss interstitial failed:`,
        err instanceof Error ? err.message : String(err),
      )
      return false
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
        '--window-size=1366,768',
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-default-apps',
      ],
      viewport:   HEADLESS ? { width: 1366, height: 768 } : null,
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
        clearTimeout(this._pollTimer)
        this._pollTimer = null
      }
    })

    await this.page.goto('https://web.whatsapp.com', { waitUntil: 'domcontentloaded' })

    this._status = await this._detectStatus()
    console.log(`[agent:${this.agentId}] initial status: ${this._status}`)

    this._publishQr()
    this._startPolling()
  }

  private _startPolling() {
    if (this._pollTimer) return

    // Adaptive cadence: poll fast (5s) while connecting (loading/QR) so logins and
    // QR scans register quickly, then slow to 60s once connected since the status
    // rarely changes while the browser is stable.
    const poll = async () => {
      if (!this.page) return
      const prev    = this._status
      this._status  = await this._detectStatus()
      if (this._status !== prev) {
        console.log(`[agent:${this.agentId}] status: ${prev} → ${this._status}`)
      }
      // Auto-reload expired QR, then publish a fresh crop.
      // QR codes expire in ~30-60s; the stale overlay is "Select to reload QR code".
      await this._refreshQrIfStale()
      this._publishQr()
      const delay = this._status === 'connected' ? 60000 : 5000
      this._pollTimer = setTimeout(poll, delay)
    }

    this._pollTimer = setTimeout(poll, 5000)
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

  // ─── QR screenshot ─────────────────────────────────────────────────────────

  /**
   * Crop just the WhatsApp QR canvas at full quality (PNG) so it can be scanned
   * from the web UI. Returns null when no QR is on screen.
   */
  async qrScreenshot(): Promise<string | null> {
    if (!this.page) return null
    try {
      const qr = await this.page.waitForSelector(QR_SELECTORS, { timeout: 5000 }).catch(() => null)
      if (!qr) return null
      const buf = await qr.screenshot({ type: 'png' })
      return buf.toString('base64')
    } catch (err) {
      console.warn(`[agent:${this.agentId}] qr screenshot failed:`, err instanceof Error ? err.message : String(err))
      return null
    }
  }

  /** Capture QR crop and push it via qrPublisher (fire-and-forget). */
  private _publishQr() {
    if (!this.qrPublisher || this._status !== 'qr') return
    this.qrScreenshot()
      .then((b64) => { if (b64) return this.qrPublisher!(b64) })
      .catch(() => {})
  }

  /**
   * Detect the expired-QR overlay ("Select to reload QR code") and click it to
   * regenerate a fresh QR. No-op when the QR is still valid.
   */
  private async _refreshQrIfStale(): Promise<void> {
    const page = this.page
    if (!page) return
    try {
      const stale = await page
        .getByText(/Select to reload QR code/i)
        .first()
        .isVisible({ timeout: 1500 })
        .catch(() => false)
      if (!stale) return

      console.log(`[agent:${this.agentId}] QR expired — clicking reload`)
      // Prefer the QR container button (cursor: pointer); fall back to the text node.
      await page
        .locator('[data-testid="link-device-qr-code"]')
        .first()
        .click({ timeout: 3000 })
        .catch(async () => {
          await page.getByText(/Select to reload QR code/i).first().click({ timeout: 3000 }).catch(() => {})
        })
      // Wait for the new QR to render before the next crop
      await page.waitForTimeout(3000)
    } catch (err) {
      console.warn(`[agent:${this.agentId}] qr refresh failed:`, err instanceof Error ? err.message : String(err))
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
   * More human-like than direct URL navigation. NEVER fails the message itself:
   * any sidebar problem falls back to sendMessage() (URL nav).
   *
   * Pinned live 2026-09-05 against real session (agent 4):
   * - Search field is a real INPUT: `input[data-tab="3"][role="textbox"]`
   *   (NO [data-testid="chat-list-search"], NO #side header in current build)
   * - Must type via the element handle: global keyboard misses when a modal
   *   dialog holds focus (dialog was the "not typing" root cause)
   * - Results are [data-testid="cell-frame-container"] cells; first cell can be
   *   a message-text match, so pick the cell whose title holds the number tail
   * - Opened chat verified via [data-testid="conversation-header"] text
   */
  async sendMessageViaSidebar(phone: string, body: string, chatLoadTimeoutMs = 30000): Promise<void> {
    return this._withBrowserLock(async () => {
      const page = this.page!
      const opened = await this._openChatViaSidebar(phone).catch(() => false)
      if (!opened) {
        console.log(`[agent:${this.agentId}] sidebar open failed for ${phone}, falling back to URL nav`)
        await this._clearSidebarSearch().catch(() => {})
        await this._sendViaUrl(phone, body, page, chatLoadTimeoutMs)
        return
      }
      await this._clearSidebarSearch().catch(() => {})
      await this._typeAndSendBody(body, page, phone, chatLoadTimeoutMs)
    })
  }

  /**
   * Open the chat for `phone` through sidebar search. Returns true only when
   * the opened conversation header provably matches the target number.
   * Never throws — returns false on any problem so callers fall back to URL.
   */
  private async _openChatViaSidebar(phone: string): Promise<boolean> {
    const page   = this.page!
    const digits = phone.replace(/\D/g, '')
    if (!digits) return false
    const tail    = digits.slice(-8)
    const midTail = digits.slice(-5)

    try {
      await this._gotoQuiet('https://web.whatsapp.com', 'load')
      await this._dismissInterstitialIfNeeded().catch(() => {})
      const listOk = await page
        .waitForSelector('[data-testid="chat-list"], #side', { timeout: 15000 })
        .then(() => true)
        .catch(() => false)
      if (!listOk) return false
      await this._dismissInterstitialIfNeeded().catch(() => {})

      // Real editable input only — never an icon/container (typing into those
      // silently goes nowhere, which was the original sidebar failure).
      const field = page.locator('input[data-tab="3"][role="textbox"], #side input[data-tab="3"]').first()
      if ((await field.count().catch(() => 0)) === 0) return false
      if (!(await field.isVisible().catch(() => false))) return false
      await field.click({ timeout: 5000 })

      // Clear stale text from the previous search
      await field.press('ControlOrMeta+A').catch(() => {})
      await field.press('Backspace').catch(() => {})

      // Type into the element handle (NOT global keyboard — a modal dialog can
      // hold document focus and swallow global keystrokes).
      const typeDelay = this.typeDelayMinMs + Math.random() * (this.typeDelayMaxMs - this.typeDelayMinMs)
      await field.pressSequentially(digits, { delay: typeDelay, timeout: 30000 })
      await page.waitForTimeout(1500 + Math.random() * 1000)

      // Verify keystrokes actually landed — the core regression guard
      const val = await field.inputValue().catch(() => '')
      if (!val.replace(/\D/g, '').includes(midTail)) {
        console.log(`[agent:${this.agentId}] sidebar typing missed (field="${val.slice(0, 24)}")`)
        return false
      }

      // Pick the result whose title holds the number tail. The first cell is
      // often a message-text match, so never blindly click cell #0.
      const cells = page.locator('[data-testid="cell-frame-container"]')
      const n = await cells.count().catch(() => 0)
      let clicked = false
      for (let i = 0; i < Math.min(n, 12); i++) {
        const title = await cells
          .nth(i)
          .locator('[data-testid="cell-frame-title"]')
          .first()
          .textContent()
          .catch(() => null)
        const norm = (title ?? '').replace(/\D/g, '')
        if (norm && (norm.includes(tail) || tail.includes(norm.slice(-8)))) {
          await cells.nth(i).click({ timeout: 5000 })
          clicked = true
          break
        }
      }
      if (!clicked) {
        console.log(`[agent:${this.agentId}] sidebar no result matched ${phone} (${n} cells)`)
        return false
      }
      await page.waitForTimeout(2000)

      // Verify the opened conversation is really the target (wrong-chat guard)
      const header = page.locator('[data-testid="conversation-header"]').first()
      if ((await header.count().catch(() => 0)) === 0) return false
      const htext = (await header.textContent().catch(() => null)) ?? ''
      if (!htext.replace(/\D/g, '').includes(tail)) {
        console.log(`[agent:${this.agentId}] sidebar opened wrong chat for ${phone}`)
        return false
      }
      return true
    } catch {
      return false
    }
  }

  /** Best-effort search reset so the next sidebar send starts from a blank box. */
  private async _clearSidebarSearch(): Promise<void> {
    const page  = this.page!
    const field = page.locator('input[data-tab="3"][role="textbox"], #side input[data-tab="3"]').first()
    if ((await field.count().catch(() => 0)) === 0) return
    await field.click({ timeout: 3000 }).catch(() => {})
    await field.press('ControlOrMeta+A').catch(() => {})
    await field.press('Backspace').catch(() => {})
    await page.keyboard.press('Escape').catch(() => {})
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
    // Dismiss onboarding interstitial if it blocks the chat
    await this._dismissInterstitialIfNeeded().catch(() => {})

    const INVALID_KEYWORDS = ['tidak terdaftar', 'not registered']
    const INPUT_SELECTORS  = [
      '[data-testid="conversation-compose-box-input"]',
      'div[contenteditable="true"][data-tab="10"]',
      'div[contenteditable="true"][aria-label="Type a message"]',
      'footer div[contenteditable="true"]',
    ].join(', ')

    const handle = await page
      .waitForFunction(
        ({
          keywords,
          inputSel,
          restrictionKeywords,
        }: {
          keywords: string[]
          inputSel: string
          restrictionKeywords: string[]
        }): string | false => {
          const modal = document.querySelector('[data-animate-modal-popup="true"]')
          if (modal) {
            const text = (modal.textContent ?? '').toLowerCase()
            // NOTE: plain for-loops only — nested closures break under tsx
            // (esbuild __name injection) and Playwright serialization fails.
            for (const kw of keywords) {
              if (text.includes(kw)) return 'invalid'
            }
          }
          // Account-level restriction — compose box replaced by a banner.
          // Check the dedicated container first, then the compose footer text.
          if (document.querySelector('[data-testid="block-message"], [data-testid="reachout-timelock-compose-bar"]')) {
            return 'restricted'
          }
          const footer = document.querySelector('footer[data-testid="compose-box"]')
          if (footer) {
            const footerText = (footer.textContent ?? '').toLowerCase()
            for (const kw of restrictionKeywords) {
              if (footerText.includes(kw)) return 'restricted'
            }
          }
          const compose = document.querySelector(inputSel)
          if (compose) return 'ready'
          return false
        },
        { keywords: INVALID_KEYWORDS, inputSel: INPUT_SELECTORS, restrictionKeywords: RESTRICTION_KEYWORDS },
        { timeout: chatLoadTimeoutMs, polling: 100 },
      )
      .catch(() => null)

    const signal = handle ? ((await handle.jsonValue()) as string) : null

    if (signal === 'restricted') {
      throw new AccountRestrictedError()
    }

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
      await this._dismissInterstitialIfNeeded().catch(() => {})

      const INVALID_KEYWORDS = ['tidak terdaftar', 'not registered']
      const STABILISE_MS     = 1500
      const runId            = Date.now().toString()

      const handle = await page
        .waitForFunction(
          ({
            keywords,
            stabiliseMs,
            id,
            restrictionKeywords,
          }: {
            keywords: string[]
            stabiliseMs: number
            id: string
            restrictionKeywords: string[]
          }): string | false => {
            const w = window as unknown as Record<string, unknown>
            if (w['__wc_runId'] !== id) {
              w['__wc_runId']       = id
              w['__wc_composeSince'] = 0
            }
            const modal = document.querySelector('[data-animate-modal-popup="true"]')
            if (modal) {
              const text = (modal.textContent ?? '').toLowerCase()
              // NOTE: plain for-loops only — nested closures break under tsx
              // (esbuild __name injection) and Playwright serialization fails.
              for (const kw of keywords) {
                if (text.includes(kw)) return 'invalid'
              }
            }
            // Account-level restriction — do NOT report the number as unregistered.
            if (document.querySelector('[data-testid="block-message"], [data-testid="reachout-timelock-compose-bar"]')) {
              return 'restricted'
            }
            const footer = document.querySelector('footer[data-testid="compose-box"]')
            if (footer) {
              const footerText = (footer.textContent ?? '').toLowerCase()
              for (const kw of restrictionKeywords) {
                if (footerText.includes(kw)) return 'restricted'
              }
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
          {
            keywords: INVALID_KEYWORDS,
            stabiliseMs: STABILISE_MS,
            id: runId,
            restrictionKeywords: RESTRICTION_KEYWORDS,
          },
          { timeout: 15000, polling: 100 },
        )
        .catch(() => null)

      const result = handle ? ((await handle.jsonValue()) as string) : null

      if (result === 'restricted') {
        throw new AccountRestrictedError()
      }

      if (result === 'invalid') {
        await page.click('[data-animate-modal-popup="true"] button').catch(() => {})
        return false
      }
      return result === 'registered'
    })
  }

  // ─── probeRestriction ────────────────────────────────────────────────────

  /**
   * Open a chat for `phone` WITHOUT typing or sending anything, then report
   * whether the account-level restriction banner is present. Used by the
   * "Retry now" button to check if a restriction has been lifted.
   */
  async probeRestriction(phone: string): Promise<'restricted' | 'ok'> {
    return this._withBrowserLock(async () => {
      const page   = this.page!
      const number = phone.replace('+', '')
      const url    = `https://web.whatsapp.com/send?phone=${number}&text=`

      await this._gotoQuiet(url, 'load')
      await this._dismissInterstitialIfNeeded().catch(() => {})
      // Give the chat panel / banner time to render
      await page.waitForTimeout(4000)

      const banner = await this._hasRestrictionBanner()
      return banner ? 'restricted' : 'ok'
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
        await this._dismissInterstitialIfNeeded().catch(() => {})

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

              const incomingAfter: Element[] = []
              // NOTE: plain for-loops only — nested closures break under tsx
              // (esbuild __name injection) and Playwright serialization fails.
              for (let j = fpIdx + 1; j < rows.length; j++) {
                if (rows[j].querySelector('[data-icon="tail-in"]')) incomingAfter.push(rows[j])
              }
              if (incomingAfter.length === 0) return { kind: 'no_reply' }
              const lastEl = incomingAfter[incomingAfter.length - 1]
              const copyableText = lastEl.querySelector('.copyable-text')
              if (!copyableText) return { kind: 'no_reply' }
              const clone = copyableText.cloneNode(true) as Element
              const strip1 = clone.querySelectorAll('._ahy0, ._ahy2, .xe9ewy2')
              for (let k = 0; k < strip1.length; k++) strip1[k].remove()
              const strip2 = clone.querySelectorAll('span.x1c4vz4f.x2lah0s')
              for (let k = 0; k < strip2.length; k++) strip2[k].remove()
              const text = clone.textContent?.trim() ?? ''
              const clean = text.replace(/\s*(\d{1,2}:\d{2}\s*(am|pm|AM|PM)?)\s*$/i, '').trim()
              return { kind: 'reply', text: clean }
            }

            // ── Legacy fallback: last .message-out + date guard ───────────────
            let anchorIdx = -1
            for (let idx = 0; idx < rows.length; idx++) {
              if (rows[idx].querySelector('[data-icon="tail-out"]')) {
                anchorIdx = idx
              }
            }
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

            const incomingAfter = []
            for (let j = anchorIdx + 1; j < rows.length; j++) {
              if (rows[j].querySelector('[data-icon="tail-in"]')) incomingAfter.push(rows[j])
            }
            if (incomingAfter.length === 0) return { kind: 'no_reply' }
            const lastEl = incomingAfter[incomingAfter.length - 1]
            const copyableText = lastEl.querySelector('.copyable-text')
            if (!copyableText) return { kind: 'no_reply' }
            const clone = copyableText.cloneNode(true) as Element
            const strip1 = clone.querySelectorAll('._ahy0, ._ahy2, .xe9ewy2')
            for (let k = 0; k < strip1.length; k++) strip1[k].remove()
            const strip2 = clone.querySelectorAll('span.x1c4vz4f.x2lah0s')
            for (let k = 0; k < strip2.length; k++) strip2[k].remove()
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
        const screenshotPath = await this.saveReplyScreenshot(phone)
        await onReply({ phone, text: lastIncoming, screenshotPath })
      })
    }
  }

  async saveReplyScreenshot(phone: string): Promise<string | null> {
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
