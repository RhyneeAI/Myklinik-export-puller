import fs from 'fs';
import path from 'path';
import XLSX from 'xlsx';
import { http } from './httpClient.js';
import { formatDateDMY, formatFileDate, getDaysInMonth, looksLikeHTML, summarizeHtml, requestDelay } from './utils.js';
import { updatePendaftaranProgress } from './progress.js';
import dotenv from 'dotenv';

dotenv.config();

const OUTPUT_DIR = process.env.OUTPUT_DIR || 'output';
const APP_TARGET = process.env.APP_TARGET || 'Export';

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

export async function fetchPendaftaran(year, month) {
  const lastDay = getDaysInMonth(year, month);
  const dateStart = formatDateDMY(year, month, 1);
  const dateEnd = formatDateDMY(year, month, lastDay);

  const params = new URLSearchParams({
    scRpt: 'klinik/report/infodaftarharian/infodaftarharian',
    cIdJaminan: '',
    cidLayanan: '',
    cDateStart: dateStart,
    cDateEnd: dateEnd,
  });

  const url = `/sc.excelme.php?${params.toString()}`;

  const res = await http.get(url, {
    responseType: 'arraybuffer',
    headers: {
      Accept: 'application/vnd.ms-excel,application/octet-stream,application/x-xls,*/*',
    },
    validateStatus: () => true,
  });

  return { buffer: res.data, status: res.status, dateStart, dateEnd, url };
}

export async function processPendaftaran(log, progress) {
  const { start, end } = progress;

  let totalFiles = 0;
  let totalRows = 0;
  let year = start.year;
  let month = start.month;

  while (year > end.year || (year === end.year && month >= end.month)) {
    const label = `${year}_${String(month).padStart(2, '0')}`;

    const cursor = progress.pendaftaran.cursor;
    if (cursor) {
      const cursorLabel = `${cursor.year}_${String(cursor.month).padStart(2, '0')}`;
      const cmp = `${year}_${String(month).padStart(2, '0')}`;
      if (cmp >= cursorLabel) {
        log.data(`  ${label}`, 'SKIP', '(already completed)');
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
        const { buffer, status, url } = await fetchPendaftaran(year, month);
        log.info(`  URL: ${url}`);

        if (looksLikeHTML(buffer)) {
          const summary = summarizeHtml(buffer);
          if (summary.hasLogin) {
            log.error(`  ${label}  Session expired!`);
            return { interrupted: true, reason: 'Session expired' };
          }
          log.warn(`  ${label}  Got HTML instead of Excel (HTTP ${status}) ${summary.title ? `- ${summary.title}` : ''}`);
          retries++;
          if (retries <= maxRetries) {
            log.info(`  Retry ${retries}/${maxRetries} in 30s...`);
            await new Promise(r => setTimeout(r, 30000));
          }
          continue;
        }

        const jsonRows = parseExcelToJson(buffer);
        const rowCount = jsonRows.length;

        const dirName = path.join(OUTPUT_DIR, 'pendaftaran', String(year));
        ensureDir(dirName);

        const dateKey = formatFileDate(year, month);
        const excelName = `${APP_TARGET}_${dateKey}.xlsx`;
        const jsonName = `${APP_TARGET}_${dateKey}.json`;

        fs.writeFileSync(path.join(dirName, excelName), buffer);
        fs.writeFileSync(path.join(dirName, jsonName), JSON.stringify(jsonRows, null, 2), 'utf-8');

        updatePendaftaranProgress(year, month);

        log.data(`  ${label}`, 'SAVED', `${rowCount} rows`);
        totalFiles++;
        totalRows += rowCount;
        success = true;
      } catch (err) {
        log.error(`  ${label}  ${err.message || err}`);
        retries++;
        if (retries <= maxRetries) {
          log.info(`  Retry ${retries}/${maxRetries} in 30s...`);
          await new Promise(r => setTimeout(r, 30000));
        }
      }
    }

    if (!success) {
      log.error(`  ${label}  Failed after ${maxRetries} retries`);
      return { interrupted: true, reason: `Failed at ${label} after retries` };
    }

    if (year === end.year && month === end.month) break;

    month--;
    if (month < 1) { month = 12; year--; }

    await requestDelay();
  }

  return { interrupted: false, totalFiles, totalRows };
}
