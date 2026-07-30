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

export async function createContext() {
  const b = await launch();
  const ctx = await b.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    locale: 'id-ID',
  });
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
