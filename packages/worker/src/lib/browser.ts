import fs from 'fs'
import path from 'path'
import { chromium, type BrowserContext, type Page } from 'playwright'
import type { BrowserStatus } from '@aice/shared'

// Resolve relative to cwd (repo root when run via `pnpm dev:worker`)
// or use absolute path from env directly
const PROFILE_PATH = path.resolve(
  process.env.BROWSER_PROFILE_PATH ?? './browser-profile'
)
const HEADLESS = process.env.BROWSER_HEADLESS === 'true'

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

// Stealth init script — patches the properties WhatsApp checks for automation detection.
// Applied via addInitScript instead of playwright-extra (which breaks launchPersistentContext).
const STEALTH_SCRIPT = `
  // Remove webdriver flag
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

  // Fake chrome runtime
  window.chrome = { runtime: {} };

  // Non-empty plugins list
  Object.defineProperty(navigator, 'plugins', {
    get: () => [1, 2, 3, 4, 5],
  });

  // Languages
  Object.defineProperty(navigator, 'languages', {
    get: () => ['id-ID', 'id', 'en-US', 'en'],
  });

  // Permissions
  const originalQuery = window.navigator.permissions?.query;
  if (originalQuery) {
    window.navigator.permissions.query = (parameters) =>
      parameters.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery(parameters);
  }
`

class BrowserManager {
  private context: BrowserContext | null = null
  private page: Page | null = null
  private _status: BrowserStatus = 'disconnected'
  private _browserLock = false

  /** Serialise all browser interactions so send & check don't collide */
  private async _withBrowserLock<T>(fn: () => Promise<T>): Promise<T> {
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

  get status(): BrowserStatus {
    return this._status
  }

  async launch(): Promise<void> {
    if (this.context) return

    this._status = 'loading'

    fs.mkdirSync(PROFILE_PATH, { recursive: true })

    // Remove stale Chrome singleton lock files from a previous force-kill
    for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      const p = path.join(PROFILE_PATH, lock)
      if (fs.existsSync(p)) fs.rmSync(p, { force: true })
    }

    // Use native Playwright launchPersistentContext — NOT playwright-extra.
    // playwright-extra's launchPersistentContext has a known proxy bug that
    // prevents the session from being saved correctly.
    this.context = await chromium.launchPersistentContext(PROFILE_PATH, {
      headless: HEADLESS,
      args: [
        '--no-sandbox',
        '--start-maximized',
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-default-apps',
      ],
      viewport: null,
      userAgent: USER_AGENT,
      locale: 'id-ID',
      timezoneId: 'Asia/Jakarta',
    })

    // Apply stealth patches to every page — including future ones
    await this.context.addInitScript(STEALTH_SCRIPT)

    const pages = this.context.pages()
    this.page = pages.length > 0 ? pages[0] : await this.context.newPage()

    await this.page.goto('https://web.whatsapp.com', { waitUntil: 'domcontentloaded' })

    this._status = await this._detectStatus()
    const shot = await this.screenshot()
    await publishBrowserStatus(this._status, shot)
    console.log(`[browser] initial status: ${this._status}`)

    // Keep polling in background every 15s so status stays fresh
    this._startPolling()
  }

  private _pollTimer: ReturnType<typeof setInterval> | null = null

  private _startPolling() {
    if (this._pollTimer) return
    this._pollTimer = setInterval(async () => {
      if (!this.page) return
      const prev = this._status
      this._status = await this._detectStatus()
      if (this._status !== prev) {
        console.log(`[browser] status changed: ${prev} → ${this._status}`)
      }
      const shot = await this.screenshot()
      await publishBrowserStatus(this._status, shot)
    }, 15000)
  }

  private async _detectStatus(): Promise<BrowserStatus> {
    if (!this.page) return 'disconnected'
    try {
      // Check connected state — multiple selectors in case WA updates their DOM
      const connected = await this.page
        .waitForSelector(
          '[data-testid="chat-list"], #side, [aria-label="Chat list"], ._aigs',
          { timeout: 30000 },
        )
        .then(() => true)
        .catch(() => false)
      if (connected) return 'connected'

      // Check QR code — multiple selectors
      const qr = await this.page
        .waitForSelector(
          'canvas[aria-label="Scan this QR code to link a device"], [data-testid="qrcode"], canvas[aria-label="QR code"]',
          { timeout: 8000 },
        )
        .then(() => true)
        .catch(() => false)
      if (qr) return 'qr'

      const url = this.page.url()
      // Save screenshot to disk for debugging
      try {
        const debugPath = path.resolve('browser-debug.jpg')
        await this.page.screenshot({ path: debugPath, type: 'jpeg', quality: 80 })
        console.log(`[browser] still loading — url: ${url}`)
        console.log(`[browser] debug screenshot saved → ${debugPath}`)
      } catch {}
      return 'loading'
    } catch {
      return 'loading'
    }
  }

  async getPage(): Promise<Page> {
    if (!this.page) throw new Error('Browser not launched')
    return this.page
  }

  async getStatus(): Promise<BrowserStatus> {
    this._status = await this._detectStatus()
    const shot = await this.screenshot()
    await publishBrowserStatus(this._status, shot)
    return this._status
  }

  async screenshot(): Promise<string | null> {
    if (!this.page) return null
    const buf = await this.page.screenshot({ type: 'jpeg', quality: 60 })
    return buf.toString('base64')
  }

  async sendMessage(phone: string, body: string): Promise<void> {
    return this._withBrowserLock(async () => {
    const page = await this.getPage()
    const number = phone.replace('+', '')
    const url = `https://web.whatsapp.com/send?phone=${number}&text=`

    await page.goto(url, { waitUntil: 'domcontentloaded' })

    // Wait for "Starting Chat..." overlay to disappear
    await page
      .waitForSelector('[data-testid="startup"], [data-animate-modal-popup="true"]', {
        state: 'hidden',
        timeout: 10000,
      })
      .catch(() => {})

    // Handle "Nomor tidak terdaftar / Phone number invalid" popup
    const invalidAlert = await page
      .waitForSelector('[data-testid="popup-contents"]', { timeout: 5000 })
      .then(() => true)
      .catch(() => false)
    if (invalidAlert) {
      // Dismiss the popup so it doesn't block the next navigation
      await page.click('[data-testid="popup-contents"] button').catch(() => {})
      await page.waitForTimeout(500)
      throw new Error(`Nomor ${phone} tidak terdaftar di WhatsApp`)
    }

    // Compose box — try multiple selectors across WA Web versions
    const inputSelector = [
      '[data-testid="conversation-compose-box-input"]',
      'div[contenteditable="true"][data-tab="10"]',
      'div[contenteditable="true"][aria-label="Type a message"]',
      'footer div[contenteditable="true"]',
    ].join(', ')

    await page.waitForSelector(inputSelector, { timeout: 30000 })
    await page.click(inputSelector)
    await page.waitForTimeout(500)

    // Type character by character.
    // '\n' must use Shift+Enter — plain Enter sends the message in WhatsApp Web.
    const lines = body.split('\n')
    for (let i = 0; i < lines.length; i++) {
      for (const char of lines[i]) {
        await page.keyboard.type(char, { delay: 80 + Math.random() * 100 })
      }
      if (i < lines.length - 1) {
        await page.keyboard.press('Shift+Enter')
        await page.waitForTimeout(300 + Math.random() * 300)
      }
    }

    await page.waitForTimeout(1000 + Math.random() * 2000)

    // Send button — try multiple selectors
    const sendSelector = [
      '[data-testid="send"]',
      'button[aria-label="Send"]',
      'span[data-testid="send"]',
    ].join(', ')

    await page.click(sendSelector)
    await page.waitForTimeout(1500)
    }) // end _withBrowserLock
  }

  /**
   * Check whether a phone number is registered on WhatsApp.
   *
   * Strategy: race between two signals after navigating to the send URL —
   *   • Compose box appears  → number IS registered
   *   • Popup appears        → number is NOT registered (or format invalid)
   *
   * This is more reliable than only waiting for the popup, because WhatsApp
   * Web may skip the popup for some unregistered numbers and just never load
   * the compose box.
   */
  async checkPhoneRegistered(phone: string): Promise<boolean> {
    return this._withBrowserLock(async () => {
      const page = await this.getPage()
      const number = phone.replace('+', '')
      const url = `https://web.whatsapp.com/send?phone=${number}&text=`

      await page.goto(url, { waitUntil: 'domcontentloaded' })

      const composeSelector = [
        '[data-testid="conversation-compose-box-input"]',
        'div[contenteditable="true"][data-tab="10"]',
        'div[contenteditable="true"][aria-label="Type a message"]',
        'footer div[contenteditable="true"]',
      ].join(', ')

      // Race: compose box (registered) vs popup (not registered), 12s total
      const result = await Promise.race([
        page.waitForSelector(composeSelector, { timeout: 12000 })
          .then(() => 'registered' as const)
          .catch(() => 'timeout' as const),
        page.waitForSelector('[data-testid="popup-contents"]', { timeout: 12000 })
          .then(() => 'popup' as const)
          .catch(() => 'timeout' as const),
      ])

      if (result === 'popup') {
        // Dismiss before returning — no extra wait needed, next page.goto clears it
        await page.click('[data-testid="popup-contents"] button').catch(() => {})
        return false
      }

      // 'registered' or both timed out (treat timeout as registered — don't
      // incorrectly invalidate a number we couldn't confirm either way)
      return true
    })
  }

  /**
   * Poll WhatsApp Web for unread replies.
   *
   * Strategy:
   *   1. Scan chat list for unread badges
   *   2. Click each unread chat, extract the phone number from the header
   *   3. FILTER — only process if the phone matches a contact we actually sent to
   *      (prevents processing random incoming messages on your personal WhatsApp)
   *   4. Read the last incoming message text
   *   5. Take a screenshot of the chat and save to OUTPUT_FOLDER/screenshots/
   *   6. Call onReply so the worker can persist the Reply record + trigger analysis
   */
  /**
   * Poll for replies by navigating directly to each unreplied contact's chat.
   * This avoids brittle chat-list DOM scraping and works regardless of whether
   * the contact has a saved name (not a phone number) in the list.
   *
   * sentPhones should only contain phones WITHOUT a reply yet (pre-filtered by caller).
   */
  async pollReplies(
    onReply: (params: {
      phone: string
      text: string
      screenshotPath: string | null
    }) => Promise<void>,
    sentPhones: Set<string>,
  ): Promise<void> {
    const page = await this.getPage()

    for (const phone of sentPhones) {
      const number = phone.replace('+', '')
      const url = `https://web.whatsapp.com/send?phone=${number}`

      await page.goto(url, { waitUntil: 'domcontentloaded' })

      // Wait for "Starting Chat..." overlay to disappear.
      // This overlay appears when opening a chat via send?phone= URL.
      await page
        .waitForSelector('[data-testid="startup"], [data-animate-modal-popup="true"]', {
          state: 'hidden',
          timeout: 10000,
        })
        .catch(() => {}) // not present on all WA Web versions — ignore

      // Wait for the compose box to confirm the chat is fully loaded
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
        console.log(`[poll] chat failed to load for ${phone}, skipping`)
        continue
      }

      // Extra buffer after compose box appears — messages render slightly after
      await page.waitForTimeout(1500)

      // Get the last incoming message text using page.evaluate
      // Incoming = .message-in, Outgoing = .message-out
      const lastIncoming = await page.evaluate((): string | null => {
        // Try specific incoming class first
        const incomingMsgs = document.querySelectorAll(
          '.message-in [data-testid="msg-text"], ' +
          '[data-id] .copyable-text[data-pre-plain-text]',
        )

        if (incomingMsgs.length > 0) {
          return incomingMsgs[incomingMsgs.length - 1]?.textContent?.trim() ?? null
        }

        // Fallback: all msg-text elements not inside message-out
        const allTexts = document.querySelectorAll('[data-testid="msg-text"]')
        const incoming = Array.from(allTexts).filter(
          (el) => !el.closest('.message-out'),
        )
        return incoming[incoming.length - 1]?.textContent?.trim() ?? null
      })

      if (!lastIncoming) {
        console.log(`[poll] no incoming message found for ${phone}`)
        continue
      }

      console.log(`[poll] ${phone} → "${lastIncoming.slice(0, 60)}"`)

      const screenshotPath = await this._saveReplyScreenshot(phone)
      await onReply({ phone, text: lastIncoming, screenshotPath })
    }
  }

  private async _saveReplyScreenshot(phone: string): Promise<string | null> {
    const OUTPUT_FOLDER = process.env.OUTPUT_FOLDER
    if (!OUTPUT_FOLDER || !this.page) return null

    try {
      const dir = path.join(OUTPUT_FOLDER, 'screenshots')
      fs.mkdirSync(dir, { recursive: true })

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const filename = `${phone.replace('+', '')}_${timestamp}.jpg`
      const fullPath = path.join(dir, filename)

      await this.page.screenshot({ path: fullPath, type: 'jpeg', quality: 80 })

      // Return path relative to OUTPUT_FOLDER for storage in DB/CSV
      return `screenshots/${filename}`
    } catch (err) {
      console.warn('[browser] screenshot failed:', err)
      return null
    }
  }

  async close(): Promise<void> {
    if (this._pollTimer) {
      clearInterval(this._pollTimer)
      this._pollTimer = null
    }
    if (this.context) {
      await this.context.close()
      this.context = null
      this.page = null
      this._status = 'disconnected'
    }
    await publishBrowserStatus('disconnected', null)
  }
}

export const browserManager = new BrowserManager()

// ─── Redis status publisher ───────────────────────────────────────────────────
// Called after every status change so the API can reflect live state.

let _redisPublisher: import('ioredis').default | null = null

export function setStatusPublisher(redis: import('ioredis').default) {
  _redisPublisher = redis
}

export async function publishBrowserStatus(status: BrowserStatus, screenshot?: string | null) {
  if (!_redisPublisher) return
  await _redisPublisher.set('browser:status', status)
  if (screenshot !== undefined) {
    if (screenshot) await _redisPublisher.set('browser:screenshot', screenshot, 'EX', 30)
    else await _redisPublisher.del('browser:screenshot')
  }
}
