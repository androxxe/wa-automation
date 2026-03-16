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
  readonly agentId: number
  readonly profilePath: string

  private context:       BrowserContext | null = null
  private page:          Page | null           = null
  private _status:       BrowserStatus         = 'disconnected'
  private _browserLock:  boolean               = false
  private _pollTimer:    ReturnType<typeof setInterval> | null = null

  /** Incremented when a job is assigned; decremented when it finishes. */
  activeJobCount = 0

  constructor(agentId: number, profilePath: string) {
    this.agentId     = agentId
    this.profilePath = profilePath
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
    if (this.context) return

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
          await page.keyboard.type(char, { delay: 80 + Math.random() * 100 })
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
    onReply: (params: { phone: string; text: string; screenshotPath: string | null }) => Promise<void>,
    sentPhones: Set<string>,
  ): Promise<void> {
    return this._withBrowserLock(async () => {
      const page = this.page!

      for (const phone of sentPhones) {
        const number = phone.replace('+', '')
        const url    = `https://web.whatsapp.com/send?phone=${number}`

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

        const lastIncoming = await page.evaluate((): string | null => {
          const incomingMsgs = document.querySelectorAll(
            '.message-in [data-testid="msg-text"], ' +
            '[data-id] .copyable-text[data-pre-plain-text]',
          )
          if (incomingMsgs.length > 0) {
            return incomingMsgs[incomingMsgs.length - 1]?.textContent?.trim() ?? null
          }
          const allTexts = document.querySelectorAll('[data-testid="msg-text"]')
          const incoming = Array.from(allTexts).filter((el) => !el.closest('.message-out'))
          return incoming[incoming.length - 1]?.textContent?.trim() ?? null
        })

        if (!lastIncoming) {
          console.log(`[agent:${this.agentId}] no incoming message for ${phone}`)
          continue
        }

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
    if (this.context) {
      await this.context.close()
      this.context = null
      this.page    = null
      this._status = 'disconnected'
    }
  }
}
