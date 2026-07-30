import dotenv from 'dotenv';
import { http, jar } from './httpClient.js';

dotenv.config();

const { ENDPOINT_URL, SERVEID, SOKKACREATIVEID, TOKEN } = process.env;

export async function setCookies() {
  const origin = new URL(ENDPOINT_URL).origin;
  const domain = new URL(ENDPOINT_URL).hostname;

  if (SERVEID) {
    await jar.setCookie(`SERVEID=${SERVEID}; Path=/; Domain=${domain}`, ENDPOINT_URL);
  }
  if (SOKKACREATIVEID) {
    await jar.setCookie(`SOKKACREATIVEID=${SOKKACREATIVEID}; Path=/; Domain=${domain}`, ENDPOINT_URL);
  }
  if (TOKEN) {
    await jar.setCookie(`token=${TOKEN}; Path=/; Domain=${domain}`, ENDPOINT_URL);
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
    return { ok: true, reason: `HTTP ${res.status} - Session valid` };
  }

  return { ok: false, reason: `Unexpected response: HTTP ${res.status}` };
}
