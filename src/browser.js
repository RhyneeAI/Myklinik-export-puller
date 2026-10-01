import { chromium } from 'playwright';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const ENDPOINT_URL = process.env.ENDPOINT_URL || 'https://apps.myklinik.id';
const DOMAIN = new URL(ENDPOINT_URL).hostname;

let context = null;
let tempProfileDir = null;

function parseCookies() {
  const c = [];
  const add = (name, value, domain) => {
    if (value) c.push({ name, value, domain: domain || DOMAIN, path: '/' });
  };

  if (process.env.COOKIES_JSON) {
    try {
      const parsed = JSON.parse(process.env.COOKIES_JSON);
      for (const item of parsed) c.push({ name: item.name, value: item.value, domain: item.domain || DOMAIN, path: item.path || '/' });
      return c;
    } catch {}
  }

  add('SERVERID', process.env.SERVERID || process.env.SERVEID);
  add('SOKKACREATIVEID', process.env.SOKKACREATIVEID);
  add('token', process.env.TOKEN);
  add('key1', process.env.KEY1);
  add('key2', process.env.KEY2);
  add('key3', process.env.KEY3);
  add('key4', process.env.KEY4);

  if (process.env.SESSION_NAME && process.env.SESSION_VALUE) {
    add(process.env.SESSION_NAME, process.env.SESSION_VALUE);
  } else {
    for (const key of Object.keys(process.env)) {
      if (/^[a-zA-Z0-9]{20,30}$/.test(key) && key !== key.toUpperCase()) {
        add(key, process.env[key]);
        break;
      }
    }
  }

  return c;
}

export async function createContext() {
  tempProfileDir = path.join(process.env.TEMP || 'D:\\temp', 'pw-chrome-' + Date.now());

  context = await chromium.launchPersistentContext(tempProfileDir, {
    channel: 'chrome',
    headless: process.env.PLAYWRIGHT_HEADLESS !== 'false',
    args: ['--no-first-run', '--disable-default-apps', '--no-default-browser-check'],
    locale: 'id-ID',
  });

  // Credentials win over captured cookies: a leftover session cookie would
  // otherwise silently log in as whichever account it belonged to.
  const hasCredentials = process.env.LOGIN_KEY && process.env.LOGIN_USER && process.env.LOGIN_PASS;
  const cookies = hasCredentials ? [] : parseCookies();
  if (cookies.length > 0) await context.addCookies(cookies);
  return context;
}

export async function close() {
  if (context) {
    try { await context.close(); } catch {}
    context = null;
  }
  if (tempProfileDir) {
    try {
      const fs = await import('fs');
      fs.rmSync(tempProfileDir, { recursive: true, force: true });
    } catch {}
    tempProfileDir = null;
  }
}
