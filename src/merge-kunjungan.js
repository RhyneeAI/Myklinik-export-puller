import fs from 'fs';
import path from 'path';
import XLSX from 'xlsx';
import dotenv from 'dotenv';
import { getDaysInMonth } from './utils.js';

dotenv.config();

const OUTPUT_DIR = process.env.OUTPUT_DIR || 'output';
const APP_TARGET = process.env.APP_TARGET || 'Export';

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Repairs output/kunjungan/merged/ against what's actually on disk:
//  - a merged file that got written into the year folder (older code path,
//    before merged output had its own directory) is just moved into place
//  - a month whose daily files are all present but was never merged
//    (e.g. a run got interrupted before reaching the merge step) gets
//    merged now
//  - anything else (daily files still incomplete) is left alone
export async function runMergeKunjungan(log) {
  log.section('Checking Kunjungan merge status');

  const kunjunganDir = path.join(OUTPUT_DIR, 'kunjungan');
  const mergedDir = path.join(kunjunganDir, 'merged');

  if (!fs.existsSync(kunjunganDir)) {
    log.warn('output/kunjungan belum ada, tidak ada yang bisa diproses.');
    return;
  }
  ensureDir(mergedDir);

  const years = fs
    .readdirSync(kunjunganDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d{4}$/.test(e.name))
    .map((e) => e.name)
    .sort();

  const dailyRe = new RegExp(`^${escapeRegExp(APP_TARGET)}_(\\d{4})_(\\d{2})_(\\d{2})\\.(xlsx|json)$`);
  const mergedRe = new RegExp(`^${escapeRegExp(APP_TARGET)}_(\\d{4})_(\\d{2})_merged\\.(xlsx|json)$`);

  // period -> { days: Set(dd), misplacedMerged: { xlsx?, json? } }
  const periods = new Map();

  for (const year of years) {
    const dir = path.join(kunjunganDir, year);
    for (const f of fs.readdirSync(dir)) {
      const mergedMatch = mergedRe.exec(f);
      if (mergedMatch) {
        const period = `${mergedMatch[1]}_${mergedMatch[2]}`;
        const entry = periods.get(period) || { days: new Set(), misplacedMerged: {} };
        entry.misplacedMerged[mergedMatch[3]] = path.join(dir, f);
        periods.set(period, entry);
        continue;
      }
      const dailyMatch = dailyRe.exec(f);
      if (dailyMatch) {
        const period = `${dailyMatch[1]}_${dailyMatch[2]}`;
        const entry = periods.get(period) || { days: new Set(), misplacedMerged: {} };
        entry.days.add(dailyMatch[3]);
        periods.set(period, entry);
      }
    }
  }

  const sortedPeriods = Array.from(periods.keys()).sort();

  if (sortedPeriods.length === 0) {
    log.info('Tidak ada file Kunjungan ditemukan.');
    return;
  }

  let alreadyOk = 0;
  let moved = 0;
  let merged = 0;
  let incomplete = 0;

  log.startTable([
    { label: 'Period', width: 10 },
    { label: 'Status', width: 8 },
    { label: 'Info', width: 32 },
  ]);

  for (const period of sortedPeriods) {
    const [y, m] = period.split('_').map(Number);
    const mergedJsonPath = path.join(mergedDir, `${APP_TARGET}_${period}_merged.json`);
    const mergedXlsxPath = path.join(mergedDir, `${APP_TARGET}_${period}_merged.xlsx`);
    const entry = periods.get(period);

    if (fs.existsSync(mergedJsonPath) && fs.existsSync(mergedXlsxPath)) {
      alreadyOk++;
      log.tableRow([period, 'OK', 'sudah ada di kunjungan/merged']);
      continue;
    }

    if (entry.misplacedMerged.json && entry.misplacedMerged.xlsx) {
      fs.renameSync(entry.misplacedMerged.json, mergedJsonPath);
      fs.renameSync(entry.misplacedMerged.xlsx, mergedXlsxPath);
      moved++;
      log.tableRow([period, 'MOVED', 'dipindah dari folder tahun']);
      continue;
    }

    const expectedDays = getDaysInMonth(y, m);
    if (entry.days.size < expectedDays) {
      incomplete++;
      log.tableRow([period, 'SKIP', `baru ${entry.days.size}/${expectedDays} hari, belum lengkap`]);
      continue;
    }

    // All daily files present, no merged file anywhere yet -- build it.
    const yearDir = path.join(kunjunganDir, String(y));
    const allRows = [];
    for (const day of Array.from(entry.days).sort()) {
      const jsonPath = path.join(yearDir, `${APP_TARGET}_${period}_${day}.json`);
      try {
        const rows = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
        allRows.push(...rows);
      } catch {
        // corrupt/missing daily json -- skip it, merge stays best-effort
      }
    }

    const ws = XLSX.utils.json_to_sheet(allRows, { defval: '' });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, `${y}-${String(m).padStart(2, '0')}`);
    fs.writeFileSync(mergedXlsxPath, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
    fs.writeFileSync(mergedJsonPath, JSON.stringify(allRows, null, 2), 'utf-8');

    merged++;
    log.tableRow([period, 'MERGED', `${allRows.length} rows dari ${entry.days.size} file harian`]);
  }

  log.endTable();

  log.summary([
    `Sudah OK: ${alreadyOk}`,
    `Dipindahkan ke merged/: ${moved}`,
    `Baru di-merge: ${merged}`,
    incomplete > 0 ? `Dilewati (daily belum lengkap): ${incomplete}` : null,
  ]);
}
