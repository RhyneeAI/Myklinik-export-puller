// BACKUP: pulls everything offered on Master Data → Download Data
// (#masterdata/upload/upload) — "Data Pasien" in the ranges the page lists,
// plus every "Data Rekam Medis" type for each month in START_DATE..END_DATE.
//
// The vendor only allows these downloads between 21:00 and 06:00 WIB. The
// page enforces that in client-side JS only, but it is the vendor's rule, so
// this tool honours it: outside the window it waits (or exits with
// --no-wait), and it stops starting new downloads shortly before 06:00.
//
// Usage: npm run backup [-- --dry-run] [-- --no-wait]
//   --dry-run  log in, list what would be downloaded, download nothing
//   --no-wait  exit instead of waiting when outside the download window
//   --reparse  rebuild every .json from the already-downloaded files (offline)
import fs from 'fs';
import path from 'path';
import XLSX from 'xlsx';
import dotenv from 'dotenv';
import { createContext, close } from './browser.js';
import { createLogger, dim, green, yellow, red } from './logger.js';
import { parseDateRange, generateMonthlyRange, looksLikeHTML, summarizeHtml, requestDelay, sleep } from './utils.js';

dotenv.config();

const {
  APP_TARGET = 'MyKlinik',
  OUTPUT_DIR = 'output',
  START_DATE,
  END_DATE,
} = process.env;

const BASE = (process.env.ENDPOINT_URL || 'https://apps.myklinik.id').replace(/\/+$/, '');
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '3', 10);
const BACKUP_DIR = path.join(OUTPUT_DIR, 'backup');
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000; // a month of one type can be thousands of rows

const DRY_RUN = process.argv.includes('--dry-run');
const NO_WAIT = process.argv.includes('--no-wait');
const REPARSE = process.argv.includes('--reparse');

// ─── Download window (WIB = UTC+7, no DST) ─────────────────────
const WINDOW_OPEN_HOUR = 21;
const WINDOW_CLOSE_HOUR = 6;
const CLOSE_MARGIN_MIN = 10; // don't start a download this close to 06:00

function wibClock() {
  const d = new Date(Date.now() + 7 * 3600 * 1000);
  return { h: d.getUTCHours(), m: d.getUTCMinutes(), s: d.getUTCSeconds() };
}

function inWindow() {
  const { h } = wibClock();
  return h >= WINDOW_OPEN_HOUR || h < WINDOW_CLOSE_HOUR;
}

function canStartDownload() {
  const { h, m } = wibClock();
  if (!inWindow()) return false;
  const minutesToClose = h < WINDOW_CLOSE_HOUR ? (WINDOW_CLOSE_HOUR - h) * 60 - m : Infinity;
  return minutesToClose > CLOSE_MARGIN_MIN;
}

function msUntilWindowOpens() {
  if (canStartDownload()) return 0;
  const { h, m, s } = wibClock();
  const nowSec = h * 3600 + m * 60 + s;
  let diff = WINDOW_OPEN_HOUR * 3600 - nowSec;
  if (diff <= 0) diff += 24 * 3600;
  return diff * 1000;
}

async function waitForWindow(log) {
  const ms = msUntilWindowOpens();
  if (ms === 0) return true;
  const hrs = Math.floor(ms / 3600000);
  const mins = Math.round((ms % 3600000) / 60000);
  if (NO_WAIT) {
    log.warn(`Di luar jam download (21.00-06.00 WIB). Jalankan lagi setelah 21.00 WIB (±${hrs}j ${mins}m lagi).`);
    return false;
  }
  log.info(yellow(`Di luar jam download (21.00-06.00 WIB). Menunggu ±${hrs}j ${mins}m sampai 21.00 WIB... (Ctrl+C untuk batal)`));
  await sleep(ms + 5000);
  return true;
}

// ─── Helpers ───────────────────────────────────────────────────
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function slugify(label) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function pad(n, w = 2) {
  return String(n).padStart(w, '0');
}

function extFromResponse(res, buffer) {
  const cd = res.headers()['content-disposition'] || '';
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
  if (m) {
    const ext = path.extname(decodeURIComponent(m[1])).toLowerCase();
    if (ext) return ext;
  }
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) return '.xlsx'; // zip container
  if (buffer[0] === 0xd0 && buffer[1] === 0xcf) return '.xls'; // legacy OLE
  return '.xls'; // HTML-table "excel" export
}

// Exports start with a title row ("DATA MEDICAL RECORD",
// "Myklinik_Periode : 2026-September"), sometimes followed by blank rows,
// above the real header row; those are skipped. Values stay as the text the server sent — `raw: true`
// stops CSV dates like 2026-09-01 turning into Excel serial numbers.
function parseToRows(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', raw: true });
  if (!wb.SheetNames || wb.SheetNames.length === 0) return { rows: [], sheets: [] };
  const ws = wb.Sheets[wb.SheetNames[0]];
  // Header = first row where at least half the columns are filled (skips the
  // title row and any blank spacer rows under it).
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false, blankrows: true });
  const width = Math.max(1, ...grid.slice(0, 10).map((r) => r.length));
  let headerIdx = grid.slice(0, 10).findIndex((r) => r.filter((v) => String(v).trim() !== '').length >= width / 2);
  if (headerIdx < 0) headerIdx = 0;
  const range = XLSX.utils.decode_range(ws['!ref']);
  range.s.r += headerIdx;
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '', raw: false, range });
  return { rows, sheets: wb.SheetNames };
}

class SessionExpiredError extends Error {}

// ─── Page navigation & login ───────────────────────────────────
async function clickMenu(page) {
  await page.evaluate(() => {
    const a = document.querySelector('a[href="#masterdata/upload/upload"]');
    if (a) a.click();
    else location.hash = 'masterdata/upload/upload';
  });
}

// The captcha text arrives via a CreateCaptcha XHR ~1s after the login form
// renders; submitting before then sends an empty captcha and the server
// silently rejects it (the form just resets with a new captcha).
async function login(page) {
  if (!process.env.LOGIN_KEY || !process.env.LOGIN_USER || !process.env.LOGIN_PASS) {
    throw new Error('Perlu login tapi LOGIN_KEY/LOGIN_USER/LOGIN_PASS tidak diisi di .env');
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.waitForFunction(() => {
      const c = document.querySelector('#captcha');
      return c && c.textContent.trim().length > 0;
    }, null, { timeout: 30000 });
    const captcha = (await page.textContent('#captcha')).trim();
    await page.fill('#ckeyKlinik', process.env.LOGIN_KEY);
    await page.fill('#cUser', process.env.LOGIN_USER);
    await page.fill('#cPassword', process.env.LOGIN_PASS);
    await page.fill('#cCaptcha', captcha);
    await page.waitForTimeout(500);
    await page.click('#btnSubmit', { force: true });
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    // After a successful login the page reloads and the sidebar menu takes a
    // while to render; after a rejected one the login form comes back.
    await page.waitForFunction(() => {
      const k = document.querySelector('#ckeyKlinik');
      const loginBack = k && k.offsetWidth > 0 && !k.value;
      return loginBack || document.querySelector('a[href="#masterdata/upload/upload"]');
    }, null, { timeout: 30000 }).catch(() => {});

    const stillLogin = await page.isVisible('#ckeyKlinik').catch(() => false);
    const loggedIn = !stillLogin && (await page.$('a[href="#masterdata/upload/upload"]'));
    if (loggedIn) return;
    if (!stillLogin) {
      throw new Error(`Login berhasil tapi menu "Download Data" tidak ada — akun ${process.env.LOGIN_USER} mungkin tidak punya akses Master Data → Download Data`);
    }
    await page.waitForTimeout(2000 * attempt);
  }
  throw new Error(`Login gagal 3x untuk user "${process.env.LOGIN_USER}" — cek LOGIN_KEY/LOGIN_USER/LOGIN_PASS di .env`);
}

async function openDownloadPage(page) {
  const loginVisible = await page.isVisible('#ckeyKlinik').catch(() => false);
  if (!loginVisible && (await page.$('#sc-DataTable-MRBackup'))) return;

  if (!page.url().startsWith(BASE) || loginVisible) {
    await page.goto(BASE, { waitUntil: 'load', timeout: 60000 });
    await page.waitForTimeout(1500);
  }
  await clickMenu(page);

  const first = await Promise.race([
    page.waitForSelector('#ckeyKlinik', { state: 'visible', timeout: 30000 }).then(() => 'login'),
    page.waitForSelector('#cDateMonth', { timeout: 30000 }).then(() => 'page'),
  ]).catch(() => 'timeout');

  if (first !== 'page' && (await page.isVisible('#ckeyKlinik').catch(() => false))) {
    await login(page);
    await clickMenu(page);
  }

  try {
    // The view loads slowly (5-10s+ observed after the menu click)
    await page.waitForSelector('#cDateMonth', { state: 'attached', timeout: 90000 });
    // Both lists are server-side DataTables filled by XHR after the view loads
    await page.waitForFunction(() =>
      document.querySelector('#sc-DataTable-MR [onclick^="scDownLoadMR("]') &&
      document.querySelector('#sc-DataTable-MRBackup [onclick^="scDownLoadMRBackup("]'),
    null, { timeout: 90000 });
  } catch (err) {
    ensureDir(BACKUP_DIR);
    const shot = path.join(BACKUP_DIR, '_last_error.png');
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    const state = await page.evaluate(() => ({
      url: location.href,
      loginVisible: !!document.querySelector('#ckeyKlinik') && document.querySelector('#ckeyKlinik').offsetWidth > 0,
      menuLink: !!document.querySelector('a[href="#masterdata/upload/upload"]'),
      cDateMonth: document.querySelectorAll('#cDateMonth').length,
    })).catch(() => ({}));
    throw new Error(`Halaman Download Data tidak terbuka (${JSON.stringify(state)}); screenshot: ${shot}`);
  }
}

async function readCatalog(page) {
  return page.evaluate(() => {
    const pasien = [...document.querySelectorAll('#sc-DataTable-MR [onclick^="scDownLoadMR("]')]
      .map((a) => /scDownLoadMR\(\s*(\d+)\s*,\s*(\d+)\s*\)/.exec(a.getAttribute('onclick')))
      .filter(Boolean)
      .map((m) => ({ start: Number(m[1]), end: Number(m[2]) }));

    const rekamMedis = [...document.querySelectorAll('#sc-DataTable-MRBackup tr')]
      .map((tr) => {
        const a = tr.querySelector('[onclick^="scDownLoadMRBackup("]');
        const m = a && /scDownLoadMRBackup\(\s*(\d+)\s*\)/.exec(a.getAttribute('onclick'));
        if (!m) return null;
        return { id: Number(m[1]), label: (tr.cells[1] ? tr.cells[1].innerText : `rm-${m[1]}`).trim() };
      })
      .filter(Boolean);

    return { pasien, rekamMedis };
  });
}

// Formats the month exactly like the page's own datepicker (e.g. "Aug-2026")
async function toCdate(page, year, month) {
  const val = await page.evaluate(({ y, m }) => {
    const $i = window.jQuery && jQuery('#cDateMonth');
    if (!$i || !$i.datepicker) return null;
    $i.datepicker('update', new Date(y, m - 1, 1));
    return $i.val();
  }, { y: year, m: month }).catch(() => null);
  if (val && /^[A-Za-z]{3}-\d{4}$/.test(val)) return val;
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${MON[month - 1]}-${year}`;
}

// ─── Tasks ─────────────────────────────────────────────────────
function buildTasks(catalog, months) {
  const tasks = [];
  for (const { start, end } of catalog.pasien) {
    const base = `${APP_TARGET}_pasien_${pad(start, 6)}_${pad(end, 6)}`;
    tasks.push({
      kind: 'pasien',
      label: `Pasien ${start}-${end}`,
      dir: path.join(BACKUP_DIR, 'pasien'),
      base,
      stalePrefix: `${APP_TARGET}_pasien_${pad(start, 6)}_`, // last range grows over time
      url: () => `sc.excelme.php?scRpt=masterdata/upload/medicalrecord&starQty=${start}&endQty=${end}`,
    });
  }
  for (const { year, month } of months) {
    for (const rm of catalog.rekamMedis) {
      const slug = slugify(rm.label);
      tasks.push({
        kind: 'rm',
        label: `${year}-${pad(month)} ${rm.label}`,
        dir: path.join(BACKUP_DIR, `${year}_${pad(month)}`),
        base: `${APP_TARGET}_${slug}_${year}_${pad(month)}`,
        url: async (page) => `sc.excelme.php?scRpt=masterdata/upload/backupdata&cRekamMedis=${rm.id}&cdate=${await toCdate(page, year, month)}`,
      });
    }
  }
  return tasks;
}

// The .json is written last, so its presence marks a finished download
function isDone(task) {
  return fs.existsSync(path.join(task.dir, `${task.base}.json`));
}

async function download(page, task) {
  await openDownloadPage(page);
  const rel = await task.url(page);
  const res = await page.request.get(`${BASE}/${rel}`, { timeout: DOWNLOAD_TIMEOUT_MS });
  const buffer = await res.body();

  // Same cleanup call the page makes after each download
  await page.evaluate(() => {
    try { scAjax('./pages/masterdata/upload/add.ajax.php', 'StopLoading', ''); } catch {}
  }).catch(() => {});

  if (res.status() >= 400) throw new Error(`HTTP ${res.status()}`);
  if (buffer.length === 0) throw new Error('Respons kosong');

  // Excel-ish exports can be real xlsx/xls, an HTML <table>, or SpreadsheetML
  // XML (<Workbook>); anything else markup-shaped is an error/login page.
  if (looksLikeHTML(buffer) || /^\s*</.test(buffer.slice(0, 64).toString('utf8'))) {
    const text = buffer.toString('utf8');
    if (!/<table|<Workbook/i.test(text)) {
      const info = summarizeHtml(buffer);
      if (info.hasLogin || /ckeyKlinik|login\.ajax/i.test(text)) throw new SessionExpiredError('Session expired');
      const snippet = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150);
      throw new Error(`Server mengembalikan HTML, bukan file: ${info.title || snippet}`);
    }
  }

  const ext = extFromResponse(res, buffer);
  const { rows, sheets } = parseToRows(buffer);

  ensureDir(task.dir);
  if (task.stalePrefix) {
    for (const f of fs.readdirSync(task.dir)) {
      if (f.startsWith(task.stalePrefix) && !f.startsWith(task.base)) fs.rmSync(path.join(task.dir, f));
    }
  }
  const dataPath = path.join(task.dir, task.base + ext);
  const jsonPath = path.join(task.dir, `${task.base}.json`);
  fs.writeFileSync(dataPath + '.part', buffer);
  fs.renameSync(dataPath + '.part', dataPath);
  fs.writeFileSync(jsonPath + '.part', JSON.stringify(rows, null, 2));
  fs.renameSync(jsonPath + '.part', jsonPath);

  return { rows: rows.length, file: path.basename(dataPath), sheets };
}

function reparseAll(log) {
  const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : [])
    .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const files = walk(BACKUP_DIR).filter((f) => /\.(csv|xlsx?|xml)$/i.test(f));
  let total = 0;
  for (const f of files) {
    const { rows } = parseToRows(fs.readFileSync(f));
    fs.writeFileSync(f.replace(/\.[^.]+$/, '.json'), JSON.stringify(rows, null, 2));
    total += rows.length;
    log.info(`${String(rows.length).padStart(6)}  ${path.relative(BACKUP_DIR, f)}`);
  }
  log.success(`${files.length} file diparse ulang (${total} baris)`);
}

// ─── Main ──────────────────────────────────────────────────────
async function main() {
  const log = createLogger('MyPharmaExportPuller · BACKUP', '1.0.0');
  log.header(APP_TARGET, DRY_RUN ? 'backup (dry-run)' : REPARSE ? 'backup (reparse)' : 'backup');

  if (REPARSE) {
    reparseAll(log);
    log.footer();
    return;
  }

  if (!START_DATE || !END_DATE) {
    log.error('START_DATE dan END_DATE wajib diisi di .env (format YYYY-MM, START lebih baru).');
    process.exit(1);
  }
  const { start, end } = parseDateRange(START_DATE, END_DATE);
  const months = generateMonthlyRange(start, end);
  log.info(`Periode Rekam Medis: ${START_DATE} → ${END_DATE} (${months.length} bulan)`);
  log.info(`Output: ${BACKUP_DIR}`);

  const stats = { saved: 0, skipped: 0, failed: 0, rows: 0 };
  const failures = [];
  let finished = false;
  let firstPass = true;

  while (!finished) {
    if (!DRY_RUN && !(await waitForWindow(log))) break;

    const context = await createContext();
    try {
      const page = await context.newPage();

      log.section('Membaca daftar download');
      await openDownloadPage(page);
      const catalog = await readCatalog(page);
      log.info(`Data Pasien: ${catalog.pasien.length} bagian (${catalog.pasien.map((p) => `${p.start}-${p.end}`).join(', ')})`);
      log.info(`Rekam Medis: ${catalog.rekamMedis.length} jenis — ${catalog.rekamMedis.map((r) => r.label).join(', ')}`);
      if (catalog.pasien.length === 0 && catalog.rekamMedis.length === 0) {
        throw new Error('Daftar download kosong — struktur halaman mungkin berubah');
      }

      const tasks = buildTasks(catalog, months);
      const pending = tasks.filter((t) => !isDone(t));
      if (firstPass) stats.skipped = tasks.length - pending.length;
      firstPass = false;
      log.info(`Total ${tasks.length} file: ${stats.skipped} sudah ada, ${pending.length} akan didownload`);

      if (DRY_RUN) {
        log.section('Rencana download (dry-run)');
        for (const t of pending.slice(0, 30)) log.info(`${dim('•')} ${t.label} ${dim('→ ' + path.join(t.dir, t.base))}`);
        if (pending.length > 30) log.info(dim(`... dan ${pending.length - 30} lainnya`));
        const sample = pending.find((t) => t.kind === 'rm');
        if (sample) log.info(`Contoh URL: ${dim(`${BASE}/${await sample.url(page)}`)}`);
        finished = true;
        break;
      }

      log.section('Download');
      log.startTable([
        { label: 'Item', width: 44 },
        { label: 'Status', width: 8 },
        { label: 'Rows', width: 7 },
        { label: 'File', width: 50 },
      ]);

      let done = 0;
      let windowClosed = false;
      for (const task of pending) {
        if (!canStartDownload()) { windowClosed = true; break; }

        let result = null;
        let lastErr = null;
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
          try {
            result = await download(page, task);
            break;
          } catch (err) {
            lastErr = err;
            if (err instanceof SessionExpiredError) {
              await page.goto(BASE, { waitUntil: 'load', timeout: 60000 }).catch(() => {});
            }
            if (attempt < MAX_RETRIES) await sleep(10000 * attempt);
          }
        }

        done++;
        if (result) {
          stats.saved++;
          stats.rows += result.rows;
          const note = result.sheets.length > 1 ? ` (+${result.sheets.length - 1} sheet lain, cek file asli)` : '';
          log.tableRow([task.label, green('SAVED'), String(result.rows), result.file + note]);
        } else {
          stats.failed++;
          failures.push(`${task.label}: ${lastErr ? lastErr.message : 'unknown error'}`);
          log.tableRow([task.label, red('FAIL'), '-', dim(lastErr ? lastErr.message : '')]);
        }
        log.progressBar(done, pending.length, task.label);
        await requestDelay();
      }
      log.endTable();

      if (windowClosed) {
        log.warn('Jam download hampir/sudah berakhir (06.00 WIB). Sisa file dilanjutkan di jendela berikutnya.');
      } else {
        finished = true;
      }
    } catch (err) {
      log.error(err.message);
      finished = true;
      process.exitCode = 1;
    } finally {
      await close();
    }
  }

  log.summary([
    `Tersimpan: ${stats.saved} file (${stats.rows} baris)`,
    `Sudah ada sebelumnya: ${stats.skipped} file`,
    stats.failed ? red(`Gagal: ${stats.failed} file — jalankan ulang untuk mencoba lagi`) : null,
    ...failures.map((f) => red('  ' + f)),
  ]);
  log.footer();
}

main();
