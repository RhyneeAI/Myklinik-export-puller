import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const ENDPOINT_URL = process.env.ENDPOINT_URL || 'https://apps.myklinik.id';
const BASE = ENDPOINT_URL.replace(/\/+$/, '');
const DOMAIN = new URL(BASE).hostname;

let context = null;
let tempProfileDir = null;

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

async function autoLogin(ctx, attempt) {
  const page = await ctx.newPage();
  try {
    await page.goto(BASE, { waitUntil: 'load', timeout: 60000 });
    await page.waitForTimeout(3000);
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});

    const currentUrl = page.url();
    const hasForm = await page.$('#ckeyKlinik');

    if (!hasForm) {
      const outputDir = process.env.OUTPUT_DIR || 'output';
      const debugDir = path.join(outputDir, 'debug');
      if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
      await page.screenshot({ path: path.join(debugDir, `login-attempt-${attempt}.png`) });
      const html = await page.content();
      fs.writeFileSync(path.join(debugDir, `login-attempt-${attempt}.html`), html, 'utf-8');
      throw new Error(`Login form not found at ${currentUrl} — ${hasForm === null ? 'no element' : 'element null'}`);
    }

    const captcha = (await page.textContent('#captcha')).trim();

    await page.fill('#ckeyKlinik', process.env.LOGIN_KEY);
    await page.fill('#cUser', process.env.LOGIN_USER);
    await page.fill('#cPassword', process.env.LOGIN_PASS);
    await page.fill('#cCaptcha', captcha);

    await page.click('#btnSubmit');
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2000);

    const afterUrl = page.url();
    if (afterUrl.includes('/login') || afterUrl === BASE + '/' || afterUrl === BASE) {
      throw new Error('Login failed - returned to login page');
    }

    return true;
  } finally {
    await page.close();
  }
}

export async function createContext() {
  tempProfileDir = path.join(process.env.TEMP || 'D:\\temp', 'pw-chrome-' + Date.now());

  context = await chromium.launchPersistentContext(tempProfileDir, {
    channel: 'chrome',
    headless: process.env.PLAYWRIGHT_HEADLESS !== 'false',
    args: ['--no-first-run', '--disable-default-apps', '--no-default-browser-check'],
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    locale: 'id-ID',
  });

  const hasLoginCreds = process.env.LOGIN_KEY && process.env.LOGIN_USER && process.env.LOGIN_PASS;
  if (hasLoginCreds) {
    const maxAttempts = 3;
    let lastErr;
    for (let i = 0; i < maxAttempts; i++) {
      try {
        await autoLogin(context, i + 1);
        return context;
      } catch (err) {
        lastErr = err;
      }
    }
    // Login failed — fallback to cookies
  }

  const cookies = parseCookies();
  if (cookies.length > 0) await context.addCookies(cookies);
  return context;
}

export async function close() {
  if (context) {
    try { await context.close(); } catch {}
    context = null;
  }
  if (tempProfileDir) {
    try { fs.rmSync(tempProfileDir, { recursive: true, force: true }); } catch {}
    tempProfileDir = null;
  }
}
