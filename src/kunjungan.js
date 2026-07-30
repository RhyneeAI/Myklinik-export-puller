import fs from 'fs';
import path from 'path';
import XLSX from 'xlsx';
import { http } from './httpClient.js';
import { formatDateDMY, formatFileDate, getDaysInMonth, looksLikeHTML, summarizeHtml, requestDelay } from './utils.js';
import { updateKunjunganProgress } from './progress.js';
import dotenv from 'dotenv';

dotenv.config();

const OUTPUT_DIR = process.env.OUTPUT_DIR || 'output';
const APP_TARGET = process.env.APP_TARGET || 'Export';
const ENDPOINT_URL = process.env.ENDPOINT_URL || '';

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
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

export async function fetchKunjungan(year, month, day) {
  const dateStr = formatDateDMY(year, month, day);

  const params = new URLSearchParams({
    scRpt: 'klinik/report/inforekapkunjungan/inforekapkunjungan',
    cidLayanan: '',
    cDateStart: dateStr,
    cidDiagnosa: '',
    cJnsKelamin: '',
  });

  const url = `/sc.excelme.php?${params.toString()}`;

  const res = await http.get(url, {
    responseType: 'arraybuffer',
    headers: {
      Accept: 'application/vnd.ms-excel,application/octet-stream,application/x-xls,*/*',
    },
    validateStatus: () => true,
  });

  return { buffer: res.data, status: res.status, dateStr, url };
}

function shouldSkipDate(cursor, year, month, day) {
  if (!cursor) return false;
  if (cursor.year === year && cursor.month === month && day <= cursor.day) {
    return true;
  }
  return false;
}

export async function processKunjungan(log, progress) {
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
          const { buffer, status, url } = await fetchKunjungan(year, month, day);
          const base = ENDPOINT_URL.replace(/\/+$/, '');
          log.raw(`${base}${decodeURIComponent(url)}`);

          if (looksLikeHTML(buffer)) {
            const summary = summarizeHtml(buffer);
            if (summary.hasLogin) {
              log.error(`  ${label}  Session expired!`);
              return { interrupted: true, reason: 'Session expired' };
            }
            log.warn(`  ${label}  Got HTML (HTTP ${status}) ${summary.title ? `- ${summary.title}` : ''}`);
            retries++;
            if (retries <= maxRetries) {
              log.info(`  Retry ${retries}/${maxRetries} in 30s...`);
              await new Promise(r => setTimeout(r, 30000));
            }
            continue;
          }

          const jsonRows = parseExcelToJson(buffer);
          const rowCount = jsonRows.length;

          const dirName = path.join(OUTPUT_DIR, 'kunjungan', String(year));
          ensureDir(dirName);

          const dateKey = formatFileDate(year, month, day);
          const excelName = `${APP_TARGET}_${dateKey}.xlsx`;
          const jsonName = `${APP_TARGET}_${dateKey}.json`;

          fs.writeFileSync(path.join(dirName, excelName), buffer);
          fs.writeFileSync(path.join(dirName, jsonName), JSON.stringify(jsonRows, null, 2), 'utf-8');

          updateKunjunganProgress(year, month, day);

          log.data(`  ${label}`, 'SAVED', `${rowCount} rows`);
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
            await new Promise(r => setTimeout(r, 30000));
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
