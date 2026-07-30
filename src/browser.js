import { chromium } from 'playwright';
import dotenv from 'dotenv';

dotenv.config();

const ENDPOINT_URL = process.env.ENDPOINT_URL || 'https://apps.myklinik.id';
const BASE = ENDPOINT_URL.replace(/\/+$/, '');
const DOMAIN = new URL(BASE).hostname;

let browser = null;

function parseCookies() {
  const c = [];
  const add = (name, value, domain, path) => {
    if (value) c.push({ name, value, domain: domain || DOMAIN, path: path || '/' });
  };

  if (process.env.COOKIES_JSON) {
    try {
      const parsed = JSON.parse(process.env.COOKIES_JSON);
      for (const item of parsed) {
        c.push({ name: item.name, value: item.value, domain: item.domain || DOMAIN, path: item.path || '/' });
      }
      return c;
    } catch {}
  }

  add('SERVERID', process.env.SERVERID);
  add('SOKKACREATIVEID', process.env.SOKKACREATIVEID);
  add('token', process.env.TOKEN);
  add(process.env.SESSION_NAME, process.env.SESSION_VALUE);
  add('key1', process.env.KEY1);
  add('key2', process.env.KEY2);
  add('key3', process.env.KEY3);
  add('key4', process.env.KEY4);

  return c;
}

export async function launch() {
  if (!browser) {
    browser = await chromium.launch({
      channel: 'chrome',
      headless: process.env.PLAYWRIGHT_HEADLESS !== 'false',
    });
  }
  return browser;
}

async function autoLogin(ctx) {
  const page = await ctx.newPage();
  try {
    await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForSelector('#ckeyKlinik', { timeout: 15000 });

    const captcha = (await page.textContent('#captcha')).trim();

    await page.fill('#ckeyKlinik', process.env.LOGIN_KEY);
    await page.fill('#cUser', process.env.LOGIN_USER);
    await page.fill('#cPassword', process.env.LOGIN_PASS);
    await page.fill('#cCaptcha', captcha);

    await page.click('#btnSubmit');
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2000);

    const currentUrl = page.url();
    if (currentUrl.includes('/login') || currentUrl === BASE + '/' || currentUrl === BASE) {
      throw new Error('Login failed - returned to login page');
    }

    return true;
  } finally {
    await page.close();
  }
}

export async function createContext() {
  const b = await launch();
  const ctx = await b.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    locale: 'id-ID',
  });

  const hasLoginCreds = process.env.LOGIN_KEY && process.env.LOGIN_USER && process.env.LOGIN_PASS;
  if (hasLoginCreds) {
    const maxAttempts = 3;
    let lastErr;
    for (let i = 0; i < maxAttempts; i++) {
      try {
        await autoLogin(ctx);
        return ctx;
      } catch (err) {
        lastErr = err;
      }
    }
    throw new Error(`Login failed after ${maxAttempts} attempts: ${lastErr ? lastErr.message : ''}`);
  }

  const cookies = parseCookies();
  if (cookies.length > 0) await ctx.addCookies(cookies);
  return ctx;
}

export async function close() {
  if (browser) {
    await browser.close();
    browser = null;
  }
}
