// SOAP PDF: downloads MyKlinik's "SOAP DAN DIAGNOSA" print PDF for every SOAP
// id in the BACKUP SOAP exports, and parses it (TTV, keluhan/anamnesa, ICD).
//
// The URL is built exactly like the page's own scPrint(id): GetTanggalLahir ->
// DiffDate -> sc.reportme.php?scRpt=klinik/trssoap/trssoap&id=..&tahun..&bulan..&hari..
// The server only serves it with the Referer the Print iframe sends, so the
// request carries the same session and Referer. No download-time window applies.
//
// Usage: npm run soap-pdf [-- --limit=N] [-- --month=YYYY_MM] [-- --reparse] [-- --dry-run]
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { createContext, close } from './browser.js';
import { createLogger, dim, green, red, yellow } from './logger.js';
import { parseDateRange, generateMonthlyRange, requestDelay, sleep } from './utils.js';
import { BASE, openView } from './session.js';
import { parseSoapPdf } from './soap-pdf-parser.js';

dotenv.config();

const APP_TARGET = process.env.APP_TARGET || 'MyKlinik';
const OUTPUT_DIR = process.env.OUTPUT_DIR || 'output';
const BACKUP_DIR = path.join(OUTPUT_DIR, 'backup');
const MAX_RETRIES = Math.max(3, parseInt(process.env.MAX_RETRIES || '3', 10));
const SOAP_HREF = '#klinik/trssoap/trssoap';

const pad = (n) => String(n).padStart(2, '0');
const isTestRow = (s) => /^(A+|TEST|-)?$/i.test(String(s['5'] || '').trim()) && /^(A+|TEST|-)?$/i.test(String(s['9'] || '').trim());

export const pdfDir = (period) => path.join(BACKUP_DIR, period, 'soap-pdf');
export const parsedPath = (period) => path.join(BACKUP_DIR, period, `${APP_TARGET}_soap-pdf_${period}.json`);

// period -> SOAP rows from the BACKUP SOAP export
function soapRowsByPeriod(periods) {
  const out = [];
  for (const period of periods) {
    const f = path.join(BACKUP_DIR, period, `${APP_TARGET}_soap_${period}.json`);
    if (!fs.existsSync(f)) continue;
    const rows = JSON.parse(fs.readFileSync(f, 'utf8')).filter((s) => /^\d+$/.test(String(s['1'] || '')));
    out.push({ period, rows });
  }
  return out;
}

function resolvePeriods(opts) {
  if (opts.month) return [opts.month];
  if (process.env.START_DATE && process.env.END_DATE) {
    const { start, end } = parseDateRange(process.env.START_DATE, process.env.END_DATE);
    return generateMonthlyRange(start, end).map((m) => `${m.year}_${pad(m.month)}`);
  }
  return fs.existsSync(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR).filter((d) => /^\d{4}_\d{2}$/.test(d)).sort().reverse() : [];
}

// Re-parses every downloaded PDF of a period into one JSON file (offline).
export async function parsePeriod(period, soapRows) {
  const dir = pdfDir(period);
  if (!fs.existsSync(dir)) return { parsed: 0, failed: 0 };
  const bySoapId = new Map((soapRows || []).map((s) => [String(s['1']), s]));
  const records = [];
  let failed = 0;
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.pdf')).sort()) {
    const soapId = /_(\d+)\.pdf$/.exec(f)?.[1];
    try {
      const rec = await parseSoapPdf(fs.readFileSync(path.join(dir, f)));
      const src = bySoapId.get(soapId);
      records.push({ soap_id: soapId, myklinik_kunjungan_id: src ? String(src['2']) : null, ...rec });
    } catch (err) {
      failed++;
      records.push({ soap_id: soapId, error: err.message });
    }
  }
  fs.writeFileSync(parsedPath(period), JSON.stringify(records, null, 2));
  return { parsed: records.length - failed, failed };
}

async function buildPrintUrl(page, soapId) {
  return page.evaluate((id) => new Promise((resolve, reject) => {
    // eslint-disable-next-line no-undef
    $.ajax({
      type: 'post', url: './sc.core.php', data: 'cpar=./pages/klinik/trssoap/add.ajax.php&cfunction=GetTanggalLahir&id=' + id,
      success: (data) => {
        try {
          const h = JSON.parse(data);
          // eslint-disable-next-line no-undef
          const l = DiffDate(1, h[0], h[1]).split('|');
          resolve(`sc.reportme.php?scRpt=klinik/trssoap/trssoap&id=${id}&tahun=${l[0]}&bulan=${l[1]}&hari=${l[2]}`);
        } catch (e) { reject(new Error('GetTanggalLahir: respons tidak valid')); }
      },
      error: (e) => reject(new Error('GetTanggalLahir HTTP ' + e.status)),
    });
  }), soapId);
}

const soapViewReady = () => typeof window.scPrint === 'function' && typeof window.DiffDate === 'function' && typeof window.$ === 'function';

async function downloadOne(page, soapId, outPath) {
  await openView(page, SOAP_HREF, soapViewReady);
  const rel = await buildPrintUrl(page, soapId);
  const res = await page.request.get(`${BASE}/${rel}`, { headers: { Referer: `${BASE}/` }, timeout: 120000 });
  const buf = await res.body();
  if (res.status() === 403) throw Object.assign(new Error('HTTP 403 Forbidden — server menolak permintaan PDF'), { fatal: true });
  if (res.status() >= 400) throw new Error(`HTTP ${res.status()}`);
  if (buf.slice(0, 4).toString() !== '%PDF') {
    const text = buf.toString('utf8');
    if (/ckeyKlinik|login\.ajax/i.test(text)) throw Object.assign(new Error('Session expired'), { relogin: true });
    throw new Error(`Bukan PDF: ${text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)}`);
  }
  fs.writeFileSync(outPath + '.part', buf);
  fs.renameSync(outPath + '.part', outPath);
}

export async function runSoapPdf(log, opts = {}) {
  const periods = resolvePeriods(opts);
  const sources = soapRowsByPeriod(periods);
  const tasks = [];
  for (const { period, rows } of sources) {
    for (const s of rows) {
      if (isTestRow(s)) continue;
      const out = path.join(pdfDir(period), `${APP_TARGET}_soap_${s['1']}.pdf`);
      tasks.push({ period, soapId: String(s['1']), tanggal: s['3'], out, done: fs.existsSync(out) });
    }
  }
  const pending = tasks.filter((t) => !t.done);
  log.info(`SOAP: ${tasks.length} PDF dari ${sources.length} bulan — ${tasks.length - pending.length} sudah ada, ${pending.length} akan diunduh`);
  if (sources.length === 0) log.warn('Belum ada export SOAP (jalankan BACKUP / Download Data dulu).');

  const stats = { saved: 0, failed: 0 };
  const failures = [];
  if (!opts.reparse && !opts.dryRun && pending.length > 0) {
    const todo = opts.limit ? pending.slice(0, opts.limit) : pending;
    const context = await createContext();
    try {
      const page = await context.newPage();
      log.info('Login & membuka halaman SOAP & Diagnosa...');
      await openView(page, SOAP_HREF, soapViewReady, { timeout: 120000 });
      let done = 0;
      for (const t of todo) {
        fs.mkdirSync(path.dirname(t.out), { recursive: true });
        let ok = false, lastErr = null;
        for (let attempt = 1; attempt <= MAX_RETRIES && !ok; attempt++) {
          try {
            await downloadOne(page, t.soapId, t.out);
            ok = true;
          } catch (err) {
            lastErr = err;
            if (err.fatal) throw err;
            if (err.relogin) await page.goto(BASE, { waitUntil: 'load', timeout: 60000 }).catch(() => {});
            if (attempt < MAX_RETRIES) await sleep(10000 * attempt);
          }
        }
        done++;
        if (ok) stats.saved++;
        else { stats.failed++; failures.push(`${t.soapId} (${t.tanggal}): ${lastErr?.message}`); log.data(`SOAP ${t.soapId}`, 'FAIL', lastErr?.message); }
        log.progressBar(done, todo.length, `${t.period} SOAP ${t.soapId}`);
        await requestDelay();
      }
      log.endProgress();
    } finally {
      await close();
    }
  }

  // Parse every period that has PDFs (also picks up PDFs from earlier runs)
  let parsed = 0, parseFailed = 0;
  const issues = [];
  for (const { period, rows } of sources) {
    if (!fs.existsSync(pdfDir(period))) continue;
    const r = await parsePeriod(period, rows);
    parsed += r.parsed; parseFailed += r.failed;
    for (const rec of JSON.parse(fs.readFileSync(parsedPath(period), 'utf8'))) if (rec.ttv_issues?.length) issues.push(`${rec.soap_id} MR ${rec.mr} ${rec.tanggal_pemeriksaan}: ${rec.ttv_issues.join(', ')}`);
  }
  log.info(`Diparse: ${parsed} PDF${parseFailed ? red(`, gagal ${parseFailed}`) : ''} | TTV di luar rentang wajar (dikosongkan): ${issues.length}`);
  return { ...stats, parsed, parseFailed, failures, ttvIssues: issues };
}

async function main() {
  const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  const opts = { limit: arg('limit') ? +arg('limit') : 0, month: arg('month'), reparse: process.argv.includes('--reparse'), dryRun: process.argv.includes('--dry-run') };
  const log = createLogger('MyPharmaExportPuller · SOAP PDF', '1.0.0');
  log.header(APP_TARGET, opts.reparse ? 'soap-pdf (reparse)' : opts.dryRun ? 'soap-pdf (dry-run)' : 'soap-pdf');
  try {
    const r = await runSoapPdf(log, opts);
    log.summary([
      `PDF baru: ${green(r.saved)}${r.failed ? ', gagal ' + red(r.failed) : ''}`,
      `Diparse: ${r.parsed}`,
      r.ttvIssues.length ? yellow(`TTV dikosongkan karena tidak wajar: ${r.ttvIssues.length}`) : null,
      ...r.failures.slice(0, 20).map((f) => red('  ' + f)),
      ...r.ttvIssues.slice(0, 10).map((f) => dim('  ' + f)),
    ]);
  } catch (err) {
    log.error(err.message);
    process.exitCode = 1;
  }
  log.footer();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
