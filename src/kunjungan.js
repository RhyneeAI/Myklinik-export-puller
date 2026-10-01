import fs from 'fs';
import path from 'path';
import XLSX from 'xlsx';
import { formatDateDMY, formatFileDate, getDaysInMonth, looksLikeHTML, summarizeHtml, requestDelay, sleep } from './utils.js';
import { updateKunjunganProgress } from './progress.js';
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

async function ensureOnReportPage(page, menuLabel) {
  const isFormPresent = await page.$('#cDateStart').catch(() => null);
  const isLoginPresent = await page.$('#ckeyKlinik').catch(() => null);

  if (isFormPresent && !isLoginPresent) {
    return; // Already on report form and authenticated
  }

  const currentUrl = page.url();
  if (!currentUrl || currentUrl === 'about:blank' || isLoginPresent) {
    await page.goto(BASE, { waitUntil: 'load', timeout: 60000 });
    await page.waitForTimeout(1000);
  }

  // Navigate via menu click
  await page.evaluate((label) => {
    const clickById = (id) => {
      const el = document.getElementById(id);
      if (el) { (el.closest('a') || el).click(); }
    };
    clickById('Pendaftaran');
    clickById('Report Pendaftaran');
    const link = document.querySelector(`a[href="#klinik/report/${label}/${label}"]`);
    if (link) link.click();
  }, menuLabel);

  // Wait for either login modal or report form
  const waitResult = await Promise.race([
    page.waitForSelector('#ckeyKlinik', { timeout: 60000 }).then(() => 'login'),
    page.waitForSelector('#cDateStart', { timeout: 20000 }).then(() => 'form'),
  ]).catch(() => 'timeout');

  // If login modal appeared, fill and submit
  if (waitResult === 'login') {
    // The captcha text arrives via XHR ~1s after the form renders; reading it
    // earlier submits an empty captcha and the login is silently rejected.
    await page.waitForFunction(() => {
      const c = document.querySelector('#captcha');
      return c && c.textContent.trim().length > 0;
    }, null, { timeout: 30000 }).catch(() => {});
    const captcha = (await page.textContent('#captcha')).trim();
    await page.fill('#ckeyKlinik', process.env.LOGIN_KEY);
    await page.fill('#cUser', process.env.LOGIN_USER);
    await page.fill('#cPassword', process.env.LOGIN_PASS);
    await page.fill('#cCaptcha', captcha);
    await page.waitForTimeout(500);
    await page.click('#btnSubmit', { force: true });
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2000);

    // Re-navigate menu after login
    await page.evaluate((label) => {
      const clickById = (id) => {
        const el = document.getElementById(id);
        if (el) { (el.closest('a') || el).click(); }
      };
      clickById('Pendaftaran');
      clickById('Report Pendaftaran');
      const link = document.querySelector(`a[href="#klinik/report/${label}/${label}"]`);
      if (link) link.click();
    }, menuLabel);
  }

  await page.waitForSelector('#cDateStart', { timeout: 20000 });
}

async function exportSingleDate(page, menuLabel, dateStart, outputPath) {
  try {
    await ensureOnReportPage(page, menuLabel);

    await page.evaluate(({ start }) => {
      const setVal = (id, val) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.removeAttribute('readonly');
        el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      setVal('cDateStart', start);
    }, { start: dateStart });

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await page.click('button:has-text("Cari"), input[value="Cari"]', { timeout: 15000 });
        break;
      } catch {
        const loginForm = await page.$('#ckeyKlinik');
        if (!loginForm) throw new Error('Cari button not found');
        await ensureOnReportPage(page, menuLabel);
      }
    }

    await page.waitForSelector('#btn-export', { timeout: 20000 }).catch(() => page.waitForTimeout(1000));

    let download;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 30000 }),
          page.click('#btn-export, button:has-text("Export Excel")', { timeout: 10000 }),
        ]);
        break;
      } catch {
        if (attempt === 1) throw new Error('Export download failed after retry');
      }
    }

    await download.saveAs(outputPath);

    const buffer = fs.readFileSync(outputPath);
    return { buffer, status: 200, dateStr: dateStart };
  } catch (err) {
    const url = page.url();
    if (url.includes('/login') || (await page.$('#ckeyKlinik').catch(() => null))) {
      return { buffer: null, searchError: 'Session expired', searchFailed: true };
    }
    throw err;
  }
}

// Months run newest -> oldest, days within a month run 1 -> N; the cursor is
// the last completed day, so everything in a newer month is already done too.
function shouldSkipDate(cursor, year, month, day) {
  if (!cursor) return false;
  const cur = cursor.year * 12 + cursor.month;
  const ym = year * 12 + month;
  if (ym > cur) return true;
  return ym === cur && day <= cursor.day;
}

export async function processKunjungan(log, progress, context) {
  const { start, end } = progress;

  let totalFiles = 0;
  let totalSkipped = 0;
  let totalRows = 0;
  let year = start.year;
  let month = start.month;
  const allPeriodRows = [];

  let totalDays = 0;
  {
    let y = start.year, m = start.month;
    while (y > end.year || (y === end.year && m >= end.month)) {
      totalDays += getDaysInMonth(y, m);
      m--;
      if (m < 1) { m = 12; y--; }
    }
  }
  let dayIndex = 0;

  let page = await context.newPage();

  try {
    while (year > end.year || (year === end.year && month >= end.month)) {
      const daysInMonth = getDaysInMonth(year, month);
      const monthlyRows = [];

      for (let day = 1; day <= daysInMonth; day++) {
        const label = `${year}_${String(month).padStart(2, '0')}_${String(day).padStart(2, '0')}`;
        const dateStr = formatDateDMY(year, month, day);

        const cursor = progress.kunjungan.cursor;
        if (shouldSkipDate(cursor, year, month, day)) {
          totalSkipped++;
          dayIndex++;
          log.progressBar(dayIndex, totalDays, label);
          continue;
        }

        let retries = 0;
        const maxRetries = parseInt(process.env.MAX_RETRIES || '3', 10);
        let success = false;

        while (retries <= maxRetries && !success) {
          try {
            const dirName = path.join(OUTPUT_DIR, 'kunjungan', String(year));
            ensureDir(dirName);
            const dateKey = formatFileDate(year, month, day);
            const outputPath = path.join(dirName, `${APP_TARGET}_${dateKey}.xlsx`);

            const result = await exportSingleDate(page, 'inforekapkunjungan', dateStr, outputPath);

            if (result.searchFailed) {
              log.warn(`  ${label}  Search: ${result.searchError}`);
              retries++;
              if (retries <= maxRetries) {
                log.info(`  Retry ${retries}/${maxRetries} in 30s...`);
                await sleep(30000);
              }
              continue;
            }

            if (looksLikeHTML(result.buffer)) {
              const summary = summarizeHtml(result.buffer);
              if (summary.hasLogin) {
                log.error(`  ${label}  Session expired!`);
                return { interrupted: true, reason: 'Session expired' };
              }
              log.warn(`  ${label}  Got HTML (HTTP 200) ${summary.title ? `- ${summary.title}` : ''}`);
              retries++;
              if (retries <= maxRetries) {
                log.info(`  Retry ${retries}/${maxRetries} in 30s...`);
                await sleep(30000);
              }
              continue;
            }

            const jsonRows = parseExcelToJson(result.buffer);
            const rowCount = jsonRows.length;

            updateKunjunganProgress(year, month, day);

            log.data(label, 'SAVED', `${rowCount} rows`);
            totalFiles++;
            totalRows += rowCount;

            if (rowCount > 0) {
              monthlyRows.push(...jsonRows);
            }
            success = true;
          } catch (err) {
            log.error(`  ${label}  ${err.message || err}`);
            retries++;
            if (retries <= maxRetries) {
              log.info(`  Retry ${retries}/${maxRetries} in 30s...`);
              // If page crashed or closed, recreate tab
              if (page.isClosed()) {
                page = await context.newPage();
              }
              await sleep(30000);
            }
          }

          if (!success && retries <= maxRetries) {
            await requestDelay();
          }
        }

        if (!success) {
          log.error(`  ${label}  Failed after ${maxRetries} retries`);
          return { interrupted: true, reason: `Failed at ${label} after retries` };
        }

        dayIndex++;
        log.progressBar(dayIndex, totalDays, label);

        await requestDelay();
      }

      if (monthlyRows.length > 0) {
        const mergedDir = path.join(OUTPUT_DIR, 'kunjungan', 'merged');
        ensureDir(mergedDir);
        const monthKey = formatFileDate(year, month);
        const mergedExcelPath = path.join(mergedDir, `${APP_TARGET}_${monthKey}_merged.xlsx`);
        const mergedJsonPath = path.join(mergedDir, `${APP_TARGET}_${monthKey}_merged.json`);

        const ws = XLSX.utils.json_to_sheet(monthlyRows, { defval: '' });
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, `${year}-${String(month).padStart(2,'0')}`);
        fs.writeFileSync(mergedExcelPath, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
        fs.writeFileSync(mergedJsonPath, JSON.stringify(monthlyRows, null, 2), 'utf-8');

        allPeriodRows.push(...monthlyRows);

        log.info(`  Monthly merged: kunjungan/merged/${APP_TARGET}_${monthKey}_merged.xlsx (${monthlyRows.length} rows)`);
      }

      if (year === end.year && month === end.month) break;

      month--;
      if (month < 1) { month = 12; year--; }
    }

    if (allPeriodRows.length > 0) {
      const mergedDir = path.join(OUTPUT_DIR, 'kunjungan', 'merged');
      ensureDir(mergedDir);
      const masterExcelPath = path.join(mergedDir, `${APP_TARGET}_kunjungan_ALL_merged.xlsx`);
      const masterJsonPath = path.join(mergedDir, `${APP_TARGET}_kunjungan_ALL_merged.json`);

      const ws = XLSX.utils.json_to_sheet(allPeriodRows, { defval: '' });
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Kunjungan ALL');
      fs.writeFileSync(masterExcelPath, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
      fs.writeFileSync(masterJsonPath, JSON.stringify(allPeriodRows, null, 2), 'utf-8');

      log.info(`  Master merged (ALL): kunjungan/merged/${APP_TARGET}_kunjungan_ALL_merged.xlsx (${allPeriodRows.length} total rows)`);
    }

    return { interrupted: false, totalFiles, totalSkipped, totalRows };
  } finally {
    await page.close().catch(() => {});
  }
}
