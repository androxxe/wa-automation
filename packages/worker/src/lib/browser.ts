import { chromium, type Browser, type Page } from 'playwright'
// @ts-expect-error playwright-extra types
import { chromium as chromiumExtra } from 'playwright-extra'
// @ts-expect-error stealth plugin types
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import type { BrowserStatus } from '@aice/shared'

chromiumExtra.use(StealthPlugin())

const PROFILE_PATH = process.env.BROWSER_PROFILE_PATH ?? './browser-profile'
const HEADLESS = process.env.BROWSER_HEADLESS === 'true'

// Chrome UA matching a recent stable release
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

class BrowserManager {
  private browser: Browser | null = null
  private page: Page | null = null
  private _status: BrowserStatus = 'disconnected'

  get status(): BrowserStatus {
    return this._status
  }

  async launch(): Promise<void> {
    if (this.browser) return

    this._status = 'loading'

    this.browser = await chromiumExtra.launch({
      headless: HEADLESS,
      args: [
        '--no-sandbox',
        '--start-maximized',
        '--disable-blink-features=AutomationControlled',
      ],
    })

    const context = await this.browser.newContext({
      userDataDir: PROFILE_PATH,
      viewport: null,
      userAgent: USER_AGENT,
      locale: 'id-ID',
      timezoneId: 'Asia/Jakarta',
    } as Parameters<Browser['newContext']>[0])

    this.page = await context.newPage()
    await this.page.goto('https://web.whatsapp.com', { waitUntil: 'domcontentloaded' })

    // Detect QR or connected state
    this._status = await this._detectStatus()
  }

  private async _detectStatus(): Promise<BrowserStatus> {
    if (!this.page) return 'disconnected'
    try {
      // If the side panel (contact list) is visible → connected
      const connected = await this.page
        .waitForSelector('[data-testid="chat-list"]', { timeout: 5000 })
        .then(() => true)
        .catch(() => false)
      if (connected) return 'connected'

      const qr = await this.page
        .waitForSelector('canvas[aria-label="Scan this QR code to link a device"]', { timeout: 3000 })
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
    return this._status
  }

  async screenshot(): Promise<string | null> {
    if (!this.page) return null
    const buf = await this.page.screenshot({ type: 'jpeg', quality: 60 })
    return buf.toString('base64')
  }

  /**
   * Send a WhatsApp message using the human-simulation flow.
   * See SPEC.md § Human-Simulation Send Flow for the full sequence.
   */
  async sendMessage(phone: string, body: string): Promise<void> {
    const page = await this.getPage()
    // TODO: implement full ghost-cursor + typing simulation
    // Placeholder: direct URL navigation approach for scaffolding
    const url = `https://web.whatsapp.com/send?phone=${phone.replace('+', '')}&text=`
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(3000)

    const inputSelector = '[data-testid="conversation-compose-box-input"]'
    await page.waitForSelector(inputSelector, { timeout: 15000 })
    await page.click(inputSelector)

    // Type character by character
    for (const char of body) {
      await page.keyboard.type(char, { delay: 80 + Math.random() * 100 })
    }

    await page.waitForTimeout(1000 + Math.random() * 2000)
    await page.click('[data-testid="send"]')
    await page.waitForTimeout(1000)
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close()
      this.browser = null
      this.page = null
      this._status = 'disconnected'
    }
  }
}

// Singleton
export const browserManager = new BrowserManager()
