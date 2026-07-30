import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { http, jar } from './httpClient.js';

dotenv.config();

const { ENDPOINT_URL, COOKIES_JSON, SERVERID, SOKKACREATIVEID, TOKEN, OUTPUT_DIR, SESSION_NAME, SESSION_VALUE, KEY1, KEY2, KEY3, KEY4 } = process.env;

let csrfToken = '';

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function getCsrfToken() {
  return csrfToken;
}

export async function setCookies() {
  const domain = new URL(ENDPOINT_URL).hostname;

  if (COOKIES_JSON) {
    const allCookies = JSON.parse(COOKIES_JSON);
    for (const c of allCookies) {
      await jar.setCookie(`${c.name}=${c.value}; Path=${c.path || '/'}; Domain=${c.domain || domain}`, ENDPOINT_URL);
    }
  } else {
    if (SERVERID) await jar.setCookie(`SERVERID=${SERVERID}; Path=/; Domain=${domain}`, ENDPOINT_URL);
    if (SOKKACREATIVEID) await jar.setCookie(`SOKKACREATIVEID=${SOKKACREATIVEID}; Path=/; Domain=${domain}`, ENDPOINT_URL);
    if (TOKEN) await jar.setCookie(`token=${TOKEN}; Path=/; Domain=${domain}`, ENDPOINT_URL);
    if (SESSION_NAME && SESSION_VALUE) await jar.setCookie(`${SESSION_NAME}=${SESSION_VALUE}; Path=/; Domain=${domain}`, ENDPOINT_URL);
    if (KEY1) await jar.setCookie(`key1=${KEY1}; Path=/; Domain=${domain}`, ENDPOINT_URL);
    if (KEY2) await jar.setCookie(`key2=${KEY2}; Path=/; Domain=${domain}`, ENDPOINT_URL);
    if (KEY3) await jar.setCookie(`key3=${KEY3}; Path=/; Domain=${domain}`, ENDPOINT_URL);
    if (KEY4) await jar.setCookie(`key4=${KEY4}; Path=/; Domain=${domain}`, ENDPOINT_URL);
  }

  const cookies = await jar.getCookies(ENDPOINT_URL);
  return cookies;
}

export async function testAuth() {
  const res = await http.get('/', {
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    responseType: 'text',
    validateStatus: () => true,
  });

  const html = res.data || '';

  const isLoginPage = /<form[^>]+action="[^"]*\/login/i.test(html)
    || /name="_token"/i.test(html)
    || /Please sign in/i.test(html)
    || /Masuk/i.test(html) && /password/i.test(html);

  const isBlocked = /403|forbidden|access denied/i.test(html)
    || res.status === 403;

  if (isBlocked) {
    return { ok: false, reason: 'Access blocked (403/Forbidden)' };
  }

  if (isLoginPage) {
    return { ok: false, reason: 'Redirected to login page - cookies may be invalid or expired' };
  }

  if (res.status >= 200 && res.status < 400) {
    const tokenMatch = html.match(/<meta\s+name=["']csrf-token["']\s+content=["']([^"']+)["']/i)
      || html.match(/name="_token"\s+value="([^"]+)"/i);
    if (tokenMatch) {
      csrfToken = tokenMatch[1];
    }
    const outDir = OUTPUT_DIR || 'output';
    ensureDir(path.join(outDir, 'debug'));
    fs.writeFileSync(path.join(outDir, 'debug', 'main-page.html'), html, 'utf-8');
    return { ok: true, reason: `HTTP ${res.status} - Session valid` };
  }

  return { ok: false, reason: `Unexpected response: HTTP ${res.status}` };
}

export async function initSession() {
  const base = ENDPOINT_URL.replace(/\/+$/, '');
  await http.get('/#klinik/report/infodaftarharian/infodaftarharian', {
    headers: { Accept: 'text/html,application/xhtml+xml' },
    validateStatus: () => true,
  });
  await http.get('/#klinik/report/inforekapkunjungan/inforekapkunjungan', {
    headers: { Accept: 'text/html,application/xhtml+xml' },
    validateStatus: () => true,
  });
}
