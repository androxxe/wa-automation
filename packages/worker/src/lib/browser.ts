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
  }

  private async _detectStatus(): Promise<BrowserStatus> {
    if (!this.page) return 'disconnected'
    try {
      const connected = await this.page
        .waitForSelector('[data-testid="chat-list"]', { timeout: 8000 })
        .then(() => true)
        .catch(() => false)
      if (connected) return 'connected'

      const qr = await this.page
        .waitForSelector('canvas[aria-label="Scan this QR code to link a device"]', { timeout: 5000 })
        .then(() => true)
        .catch(() => false)
      if (qr) return 'qr'

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
    const page = await this.getPage()
    const url = `https://web.whatsapp.com/send?phone=${phone.replace('+', '')}&text=`
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(3000)

    const inputSelector = '[data-testid="conversation-compose-box-input"]'
    await page.waitForSelector(inputSelector, { timeout: 20000 })
    await page.click(inputSelector)

    for (const char of body) {
      await page.keyboard.type(char, { delay: 80 + Math.random() * 100 })
    }

    await page.waitForTimeout(1000 + Math.random() * 2000)
    await page.click('[data-testid="send"]')
    await page.waitForTimeout(1000)
  }

  async close(): Promise<void> {
    if (this.context) {
      await this.context.close()
      this.context = null
      this.page = null
      this._status = 'disconnected'
    }
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
