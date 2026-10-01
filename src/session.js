// Login + SPA navigation shared by the newer tools (BACKUP, SOAP PDF).
// The V1 scrapers (pendaftaran.js / kunjungan.js) keep their own copies on purpose.
import dotenv from 'dotenv';

dotenv.config();

export const BASE = (process.env.ENDPOINT_URL || 'https://apps.myklinik.id').replace(/\/+$/, '');

const visible = (page, sel) => page.isVisible(sel).catch(() => false);

// Fills the login form. `menuHref` is a menu link only the intended account
// has; logging in without it means a lower-access account was used.
// - the captcha text arrives by XHR ~1s after the form renders
// - the form's own init scripts can wipe fields filled too early
export async function login(page, menuHref) {
  if (!process.env.LOGIN_KEY || !process.env.LOGIN_USER || !process.env.LOGIN_PASS) {
    throw new Error('Perlu login tapi LOGIN_KEY/LOGIN_USER/LOGIN_PASS tidak diisi di .env');
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.waitForSelector('#ckeyKlinik', { state: 'visible', timeout: 30000 });
    await page.waitForFunction(() => {
      const c = document.querySelector('#captcha');
      return c && c.textContent.trim().length > 0;
    }, null, { timeout: 30000 });
    await page.waitForTimeout(1500);
    const captcha = (await page.textContent('#captcha')).trim();
    await page.fill('#ckeyKlinik', process.env.LOGIN_KEY);
    await page.fill('#cUser', process.env.LOGIN_USER);
    await page.fill('#cPassword', process.env.LOGIN_PASS);
    await page.fill('#cCaptcha', captcha);
    const filled = await page.evaluate(() => ['#ckeyKlinik', '#cUser', '#cPassword', '#cCaptcha'].every((s) => document.querySelector(s)?.value));
    if (!filled) continue;
    await page.click('#btnSubmit', { force: true });
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await page.waitForFunction((href) => {
      const k = document.querySelector('#ckeyKlinik');
      return (k && k.offsetWidth > 0 && !k.value) || document.querySelector(`a[href="${href}"]`);
    }, menuHref, { timeout: 30000 }).catch(() => {});

    if (await page.$(`a[href="${menuHref}"]`)) {
      await page.waitForTimeout(2000); // let the post-login page settle before navigating
      return;
    }
    if (!(await visible(page, '#ckeyKlinik'))) {
      throw new Error(`Login berhasil tapi menu ${menuHref} tidak ada — akun ${process.env.LOGIN_USER} tidak punya akses ke menu ini`);
    }
    await page.waitForTimeout(2000 * attempt);
  }
  throw new Error(`Login gagal 3x untuk user "${process.env.LOGIN_USER}" — cek LOGIN_KEY/LOGIN_USER/LOGIN_PASS di .env`);
}

// Opens an SPA view by its menu hash, logging in first if needed, and waits
// until `readyFn` (evaluated in the page) returns truthy.
export async function openView(page, menuHref, readyFn, { timeout = 90000 } = {}) {
  const ready = () => page.evaluate(readyFn).catch(() => false);
  if (!(await visible(page, '#ckeyKlinik')) && (await ready())) return;

  if (!page.url().startsWith(BASE) || (await visible(page, '#ckeyKlinik'))) {
    await page.goto(BASE, { waitUntil: 'load', timeout: 60000 });
    await page.waitForTimeout(1500);
  }
  if (await visible(page, '#ckeyKlinik').then((v) => v || page.waitForSelector('#ckeyKlinik', { state: 'visible', timeout: 5000 }).then(() => true).catch(() => false))) {
    await login(page, menuHref);
  }
  // The SPA loads views from the menu link's click handler, not from hash
  // changes. A click before those handlers are bound only changes the hash,
  // so always click (after the page settles) and re-click on retry.
  // Views load slowly (10s+ is normal).
  for (let i = 0; i < 3; i++) {
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const clicked = await page.evaluate((href) => {
      const a = document.querySelector(`a[href="${href}"]`);
      if (a) { a.click(); return true; }
      return false;
    }, menuHref);
    if (!clicked) await page.evaluate((href) => { location.hash = href.replace(/^#/, ''); }, menuHref);
    const ok = await page.waitForFunction(readyFn, null, { timeout: timeout / 2 }).then(() => true).catch(() => false);
    if (ok) return;
  }
  const shot = 'output/_last_error.png';
  await page.screenshot({ path: shot }).catch(() => {});
  const state = await page.evaluate((href) => ({
    url: location.href,
    loginVisible: !!document.querySelector('#ckeyKlinik') && document.querySelector('#ckeyKlinik').offsetWidth > 0,
    menuLink: !!document.querySelector(`a[href="${href}"]`),
  }), menuHref).catch(() => ({}));
  throw new Error(`Halaman ${menuHref} tidak terbuka (${JSON.stringify(state)}); screenshot: ${shot}`);
}
