import fs from 'fs';
import path from 'path';
import XLSX from 'xlsx';
import { formatDateDMY, formatFileDate, getDaysInMonth, looksLikeHTML, summarizeHtml, requestDelay, sleep } from './utils.js';
import { updatePendaftaranProgress } from './progress.js';
import { dim, green, yellow, red } from './logger.js';
import dotenv from 'dotenv';

dotenv.config();

const OUTPUT_DIR = process.env.OUTPUT_DIR || 'output';
const APP_TARGET = process.env.APP_TARGET || 'Export';
const ENDPOINT_URL = process.env.ENDPOINT_URL || 'https://apps.myklinik.id';
const BASE = ENDPOINT_URL.replace(/\/+$/, '');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function parseExcelToJson(buffer) {
  try {
    const wb = XLSX.read(buffer, { type: 'buffer' });
    if (!wb.SheetNames || wb.SheetNames.length === 0) return [];
    const ws = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(ws, { defval: '' });
  } catch {
    return [];
  }
}

async function exportPage(context, menuLabel, dateStart, dateEnd, outputPath) {
  const page = await context.newPage();
  try {
    // Step 1: Login if needed
    await page.goto(BASE, { waitUntil: 'load', timeout: 60000 });
    if (await page.$('#ckeyKlinik')) {
      const captcha = (await page.textContent('#captcha')).trim();
      await page.fill('#ckeyKlinik', process.env.LOGIN_KEY);
      await page.fill('#cUser', process.env.LOGIN_USER);
      await page.fill('#cPassword', process.env.LOGIN_PASS);
      await page.fill('#cCaptcha', captcha);
      await page.waitForTimeout(500);
      await page.click('#btnSubmit', { force: true });
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(2000);
    }

    // Step 2: Navigate to report page via hash URL
    const hashUrl = `${BASE}/#klinik/report/${menuLabel}/${menuLabel}`;
    await page.goto(hashUrl, { waitUntil: 'load', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await page.waitForSelector('#cDateStart', { timeout: 30000 }).catch(() => {});

    await page.evaluate(({ start, end }) => {
      const setVal = (id, val) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.removeAttribute('readonly');
        el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      setVal('cDateStart', start);
      if (end) setVal('cDateEnd', end);
    }, { start: dateStart, end: dateEnd });

    await page.click('button:has-text("Cari"), input[value="Cari"]', { timeout: 15000 });
    await page.waitForSelector('#btn-export', { timeout: 20000 }).catch(() => page.waitForTimeout(2000));

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      page.click('#btn-export, button:has-text("Export Excel")', { timeout: 10000 }),
    ]);

    await download.saveAs(outputPath);

    const buffer = fs.readFileSync(outputPath);
    return { buffer, page };
  } catch (err) {
    const currentUrl = page.url();
    if (currentUrl.includes('/login')) {
      return { buffer: null, page, searchError: 'Session expired', searchFailed: true };
    }
    throw err;
  }
}

export async function fetchPendaftaran(year, month, context) {
  const lastDay = getDaysInMonth(year, month);
  const dateStart = formatDateDMY(year, month, 1);
  const dateEnd = formatDateDMY(year, month, lastDay);

  const dirName = path.join(OUTPUT_DIR, 'pendaftaran', String(year));
  ensureDir(dirName);
  const outputPath = path.join(dirName, `${APP_TARGET}_${formatFileDate(year, month)}.xlsx`);

  const result = await exportPage(context, 'infodaftarharian', dateStart, dateEnd, outputPath);

  if (result.searchFailed) {
    return { buffer: null, status: 401, dateStart, dateEnd, searchFailed: true, searchError: result.searchError };
  }

  return { buffer: result.buffer, status: 200, dateStart, dateEnd };
}

export async function processPendaftaran(log, progress, context) {
  const { start, end } = progress;

  let totalFiles = 0;
  let totalRows = 0;
  let year = start.year;
  let month = start.month;

  log.startTable([
    { label: 'Period', width: 10 },
    { label: 'Status', width: 8 },
    { label: 'Rows', width: 6 },
    { label: 'File', width: 30 },
  ]);

  while (year > end.year || (year === end.year && month >= end.month)) {
    const period = `${year}-${String(month).padStart(2, '0')}`;
    const dateKey = formatFileDate(year, month);
    const fname = `${APP_TARGET}_${dateKey}.xlsx`;

    const cursor = progress.pendaftaran.cursor;
    if (cursor) {
      const cursorLabel = `${cursor.year}_${String(cursor.month).padStart(2, '0')}`;
      const cmp = `${year}_${String(month).padStart(2, '0')}`;
      if (cmp >= cursorLabel) {
        log.tableRow([dim(period), yellow('SKIP'), dim('-'), dim(fname)]);
        month--;
        if (month < 1) { month = 12; year--; }
        continue;
      }
    }

    let retries = 0;
    const maxRetries = parseInt(process.env.MAX_RETRIES || '3', 10);
    let success = false;

    while (retries <= maxRetries && !success) {
      try {
        const result = await fetchPendaftaran(year, month, context);
        const { buffer, status } = result;

        if (result.searchFailed) {
          log.tableRow([period, red(result.searchError || 'FAIL'), dim('-'), dim('search')]);
          retries++;
          if (retries <= maxRetries) {
            log.info(`  Retry ${retries}/${maxRetries} in 30s...`);
            await sleep(30000);
          }
          continue;
        }

        if (looksLikeHTML(buffer)) {
          const summary = summarizeHtml(buffer);
          if (summary.hasLogin) {
            log.error(`${period}  Session expired!`);
            log.endTable();
            return { interrupted: true, reason: 'Session expired' };
          }
          log.tableRow([period, red('HTML'), dim(String(status)), dim(summary.title || '')]);
          retries++;
          if (retries <= maxRetries) {
            log.info(`  Retry ${retries}/${maxRetries} in 30s...`);
            await sleep(30000);
          }
          continue;
        }

        const jsonRows = parseExcelToJson(buffer);
        const rowCount = jsonRows.length;

        const dirName = path.join(OUTPUT_DIR, 'pendaftaran', String(year));
        ensureDir(dirName);

        const excelName = `${APP_TARGET}_${dateKey}.xlsx`;
        const jsonName = `${APP_TARGET}_${dateKey}.json`;

        const excelPath = path.join(dirName, excelName);
        const jsonPath = path.join(dirName, jsonName);

        if (result.outputPath && fs.existsSync(result.outputPath)) {
          fs.copyFileSync(result.outputPath, excelPath);
        } else {
          fs.writeFileSync(excelPath, buffer);
        }
        fs.writeFileSync(jsonPath, JSON.stringify(jsonRows, null, 2), 'utf-8');

        updatePendaftaranProgress(year, month);

        log.tableRow([period, green('SAVED'), String(rowCount), fname]);
        totalFiles++;
        totalRows += rowCount;
        success = true;
      } catch (err) {
        log.tableRow([period, red('FAIL'), dim('-'), dim(err.message || err)]);
        retries++;
        if (retries <= maxRetries) {
          log.info(`  Retry ${retries}/${maxRetries} in 30s...`);
          await sleep(30000);
        }
      }
    }

    if (!success) {
      log.endTable();
      log.error(`${period}  Failed after ${maxRetries} retries`);
      return { interrupted: true, reason: `Failed at ${period} after retries` };
    }

    if (year === end.year && month === end.month) break;

    month--;
    if (month < 1) { month = 12; year--; }

    await requestDelay();
  }

  log.endTable();
  return { interrupted: false, totalFiles, totalRows };
}
