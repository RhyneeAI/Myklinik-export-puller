import fs from 'fs';
import path from 'path';
import XLSX from 'xlsx';
import { http } from './httpClient.js';
import { formatDateDMY, formatFileDate, getDaysInMonth, looksLikeHTML, summarizeHtml, requestDelay } from './utils.js';
import { updateKunjunganProgress } from './progress.js';
import { getCsrfToken, getAuthToken } from './auth.js';
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

function kunjunganSearchPayload(dateStr) {
  const s = new URLSearchParams();
  s.append('cPar', './pages/klinik/report/inforekapkunjungan/add.ajax.php');
  s.append('cFunction', 'GetListKunjungan');
  s.append('cData[draw]', '1');
  s.append('cData[start]', '0');
  s.append('cData[length]', '-1');
  s.append('cData[dateStart]', dateStr);
  s.append('cData[idLayanan]', '');
  s.append('cData[iddiagnosa]', '');
  s.append('cData[idJnsKel]', '');
  for (const i of Array.from({ length: 24 }, (_, i) => i)) {
    s.append(`cData[columns][${i}][data]`, String(i));
    s.append(`cData[columns][${i}][name]`, '');
    s.append(`cData[columns][${i}][searchable]`, 'true');
    s.append(`cData[columns][${i}][orderable]`, 'false');
    s.append(`cData[columns][${i}][search][value]`, '');
    s.append(`cData[columns][${i}][search][regex]`, 'false');
  }
  s.append('cData[order][0][column]', '0');
  s.append('cData[order][0][dir]', 'asc');
  s.append('cData[search][value]', '');
  s.append('cData[search][regex]', 'false');
  return s.toString();
}

export async function fetchKunjungan(year, month, day) {
  const dateStr = formatDateDMY(year, month, day);

  const base = ENDPOINT_URL.replace(/\/+$/, '');

  const headers = {
    Accept: '*/*',
    Referer: base + '/#klinik/report/inforekapkunjungan/inforekapkunjungan',
    'X-Requested-With': 'XMLHttpRequest',
    'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
  };
  const t = getCsrfToken();
  if (t) headers['X-CSRF-TOKEN'] = t;
  const a = getAuthToken();
  if (a) headers['Authorization'] = `Bearer ${a}`;

  // Step 1: POST search to populate server session
  const searchRes = await http.post('/sc.core.php', kunjunganSearchPayload(dateStr), {
    headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
    validateStatus: () => true,
    responseType: 'text',
  });
  {
    const body = searchRes.data || '';
    const head = body.slice(0, 300);
    console.error(`  [search] HTTP ${searchRes.status} | ${head.includes('<') ? 'HTML' : 'JSON/' + typeof body} | ${head.replace(/\s+/g, ' ').trim().slice(0, 200)}`);
    if (looksLikeHTML(Buffer.from(body))) {
      const h = summarizeHtml(Buffer.from(body));
      if (h.hasLogin) return { buffer: null, status: 401, dateStr, url: '/sc.core.php', searchFailed: true, searchError: 'Session expired' };
    }
  }

  // Step 2: export Excel
  const exportParams = `scRpt=klinik/report/inforekapkunjungan/inforekapkunjungan&cidLayanan=&cDateStart=${dateStr}&cidDiagnosa=&cJnsKelamin=`;
  const url = `/sc.excelme.php?${exportParams}`;

  const exportHeaders = {
    ...headers,
    Accept: 'application/vnd.ms-excel,application/octet-stream,application/x-xls,*/*',
  };

  const res = await http.get(url, {
    responseType: 'arraybuffer',
    headers: exportHeaders,
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
          const result = await fetchKunjungan(year, month, day);
          const { buffer, status, url } = result;
          const base = ENDPOINT_URL.replace(/\/+$/, '');
          log.clickableUrl(decodeURIComponent(base + url), base + url);

          if (result.searchFailed) {
            log.warn(`  ${label}  Search: ${result.searchError}`);
            retries++;
            if (retries <= maxRetries) {
              log.info(`  Retry ${retries}/${maxRetries} in 30s...`);
              await new Promise(r => setTimeout(r, 30000));
            }
            continue;
          }

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
