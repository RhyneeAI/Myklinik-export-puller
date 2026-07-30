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

async function navigateToReport(page, menuLabel) {
  const parents = ['Pendaftaran', 'Report Pendaftaran'];
  for (const p of parents) {
    const isOpen = await page.$(`li.open a:has-text("${p}")`);
    if (!isOpen) {
      await page.click(`a:has-text("${p}")`);
      await page.waitForTimeout(500);
    }
  }
  await page.click(`a[href="#klinik/report/${menuLabel}/${menuLabel}"]`);
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2000);
}

async function exportPage(context, menuLabel, dateStart, outputPath) {
  const page = await context.newPage();
  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000);

    await navigateToReport(page, menuLabel);

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

    await page.click('button:has-text("Cari"), input[value="Cari"]', { timeout: 10000 });
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2000);

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

function shouldSkipDate(cursor, year, month, day) {
  if (!cursor) return false;
  return cursor.year === year && cursor.month === month && day <= cursor.day;
}

export async function processKunjungan(log, progress, context) {
  const { start, end } = progress;

  let totalFiles = 0;
  let totalSkipped = 0;
  let totalRows = 0;
  let year = start.year;
  let month = start.month;

  while (year > end.year || (year === end.year && month >= end.month)) {
    const daysInMonth = getDaysInMonth(year, month);
    const monthlyRows = [];

    for (let day = 1; day <= daysInMonth; day++) {
      const label = `${year}_${String(month).padStart(2, '0')}_${String(day).padStart(2, '0')}`;
      const dateStr = formatDateDMY(year, month, day);

      const cursor = progress.kunjungan.cursor;
      if (shouldSkipDate(cursor, year, month, day)) {
        totalSkipped++;
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

          const result = await exportPage(context, 'inforekapkunjungan', dateStr, outputPath);

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

      await requestDelay();
    }

    if (monthlyRows.length > 0) {
      const monthDir = path.join(OUTPUT_DIR, 'kunjungan', String(year));
      ensureDir(monthDir);
      const monthKey = formatFileDate(year, month);
      const mergedExcelPath = path.join(monthDir, `${APP_TARGET}_${monthKey}_merged.xlsx`);
      const mergedJsonPath = path.join(monthDir, `${APP_TARGET}_${monthKey}_merged.json`);

      const ws = XLSX.utils.json_to_sheet(monthlyRows, { defval: '' });
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, `${year}-${String(month).padStart(2,'0')}`);
      fs.writeFileSync(mergedExcelPath, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
      fs.writeFileSync(mergedJsonPath, JSON.stringify(monthlyRows, null, 2), 'utf-8');

      log.info(`  Monthly merged: ${APP_TARGET}_${monthKey}_merged.xlsx (${monthlyRows.length} rows)`);
    }

    if (year === end.year && month === end.month) break;

    month--;
    if (month < 1) { month = 12; year--; }
  }

  return { interrupted: false, totalFiles, totalSkipped, totalRows };
}
