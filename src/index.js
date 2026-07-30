import dotenv from 'dotenv';
import { setCookies, testAuth, initSession } from './auth.js';
import { createLogger } from './logger.js';
import { parseDateRange, generateMonthlyRange, getDaysInMonth } from './utils.js';
import { loadProgress, saveProgress } from './progress.js';
import { processPendaftaran } from './pendaftaran.js';
import { processKunjungan } from './kunjungan.js';
import fs from 'fs';
import path from 'path';

dotenv.config();

const {
  APP_TARGET = 'MyKlinik',
  OUTPUT_DIR = 'output',
  START_DATE,
  END_DATE,
  MODE = 'all',
} = process.env;

function verifyFiles(log, start, end, mode) {
  log.section('Verification');

  let missingPendaftaran = [];
  let missingKunjungan = [];

  if (mode === 'all' || mode === 'pendaftaran') {
    const months = [];
    let y = start.year;
    let m = start.month;
    while (y > end.year || (y === end.year && m >= end.month)) {
      months.push({ year: y, month: m });
      m--;
      if (m < 1) { m = 12; y--; }
    }

    for (const { year, month } of months) {
      const dir = path.join(OUTPUT_DIR, 'pendaftaran', String(year));
      const fname = `${APP_TARGET}_${year}_${String(month).padStart(2, '0')}.xlsx`;
      const fpath = path.join(dir, fname);
      if (!fs.existsSync(fpath)) {
        missingPendaftaran.push(`${year}_${String(month).padStart(2, '0')}`);
      }
    }

    log.info(`Pendaftaran: ${months.length - missingPendaftaran.length}/${months.length} files present`);
    if (missingPendaftaran.length > 0) {
      log.warn(`  Missing: ${missingPendaftaran.join(', ')}`);
    }
  }

  if (mode === 'all' || mode === 'kunjungan') {
    let totalDays = 0;
    let y = start.year;
    let m = start.month;
    while (y > end.year || (y === end.year && m >= end.month)) {
      const days = getDaysInMonth(y, m);
      for (let d = 1; d <= days; d++) {
        totalDays++;
        const dir = path.join(OUTPUT_DIR, 'kunjungan', String(y));
        const fname = `${APP_TARGET}_${y}_${String(m).padStart(2, '0')}_${String(d).padStart(2, '0')}.xlsx`;
        if (!fs.existsSync(path.join(dir, fname))) {
          missingKunjungan.push(`${y}_${String(m).padStart(2, '0')}_${String(d).padStart(2, '0')}`);
        }
      }
      m--;
      if (m < 1) { m = 12; y--; }
    }

    log.info(`Kunjungan: ${totalDays - missingKunjungan.length}/${totalDays} files present`);
    if (missingKunjungan.length > 0) {
      log.warn(`  Missing: ${missingKunjungan.join(', ')}`);
    }
  }

  return {
    pendaftaranMissing: missingPendaftaran,
    kunjunganMissing: missingKunjungan,
  };
}

async function main() {
  const log = createLogger('MyPharmaExportPuller', '1.0.0');
  log.header(APP_TARGET, MODE);

  let startStr = START_DATE;
  let endStr = END_DATE;

  if (!startStr || !endStr) {
    log.error('START_DATE and END_DATE required in .env');
    log.footer();
    process.exit(1);
  }

  const dateRange = parseDateRange(startStr, endStr);
  const start = dateRange.start;
  const end = dateRange.end;

  if (start.year < end.year || (start.year === end.year && start.month < end.month)) {
    log.error(`START_DATE (${startStr}) must be newer than END_DATE (${endStr})`);
    log.footer();
    process.exit(1);
  }

  const totalPendaftaranMonths = (() => {
    let y = start.year, m = start.month, count = 0;
    while (y > end.year || (y === end.year && m >= end.month)) {
      count++;
      m--;
      if (m < 1) { m = 12; y--; }
    }
    return count;
  })();

  const totalKunjunganDays = (() => {
    let y = start.year, m = start.month, count = 0;
    while (y > end.year || (y === end.year && m >= end.month)) {
      count += getDaysInMonth(y, m);
      m--;
      if (m < 1) { m = 12; y--; }
    }
    return count;
  })();

  log.info(`Range: ${start.year}-${String(start.month).padStart(2,'0')}  to  ${end.year}-${String(end.month).padStart(2,'0')}`);

  if (MODE === 'all' || MODE === 'pendaftaran') {
    log.info(`Pendaftaran: ${totalPendaftaranMonths} months to process`);
  }
  if (MODE === 'all' || MODE === 'kunjungan') {
    log.info(`Kunjungan: ~${totalKunjunganDays} days to process`);
  }

  log.section('Step 1: Authentication');

  log.step('Setting cookies...');
  const cookies = await setCookies();
  log.success(`${cookies.length} cookies set`);

  log.step('Testing connection...');
  const authResult = await testAuth();
  if (!authResult.ok) {
    log.error(`Auth failed: ${authResult.reason}`);
    log.footer();
    process.exit(1);
  }
  log.success(authResult.reason);

  log.step('Initializing session...');
  await initSession();
  log.success('Session initialized');

  let progress = loadProgress();

  if (MODE === 'all' || MODE === 'pendaftaran') {
    log.section('Step 2: Pendaftaran');

    const prog = progress.pendaftaran;
    if (prog.cursor) {
      log.info(`Resuming from: ${prog.cursor.year}-${String(prog.cursor.month).padStart(2,'0')} (${prog.completedCount} files done)`);
    } else {
      log.info('Starting fresh');
    }

    const pendResult = await processPendaftaran(log, {
      start,
      end,
      pendaftaran: progress.pendaftaran,
    });

    if (pendResult.interrupted) {
      log.error(`Pendaftaran interrupted: ${pendResult.reason}`);
      log.footer();
      process.exit(1);
    }

    log.success(`Pendaftaran complete: ${pendResult.totalFiles} files, ${pendResult.totalRows} rows`);
  }

  progress = loadProgress();

  if (MODE === 'all' || MODE === 'kunjungan') {
    log.section('Step 3: Kunjungan');

    const prog = progress.kunjungan;
    if (prog.cursor) {
      log.info(`Resuming from: ${prog.cursor.year}-${String(prog.cursor.month).padStart(2,'0')}-${String(prog.cursor.day).padStart(2,'0')} (${prog.completedCount} files done)`);
    } else {
      log.info('Starting fresh');
    }

    const kunjResult = await processKunjungan(log, {
      start,
      end,
      kunjungan: progress.kunjungan,
    });

    if (kunjResult.interrupted) {
      log.error(`Kunjungan interrupted: ${kunjResult.reason}`);
      log.footer();
      process.exit(1);
    }

    log.success(`Kunjungan complete: ${kunjResult.totalFiles} files, ${kunjResult.totalRows} rows`);
  }

  log.section('Step 4: Verification');
  const missing = verifyFiles(log, start, end, MODE);

  log.summary([
    MODE !== 'kunjungan' ? `Pendaftaran: ${totalPendaftaranMonths - missing.pendaftaranMissing.length}/${totalPendaftaranMonths} files` : null,
    MODE !== 'pendaftaran' ? `Kunjungan: remaining days check above` : null,
    missing.pendaftaranMissing.length === 0 && missing.kunjunganMissing.length === 0
      ? 'All files verified'
      : 'Some files missing',
  ].filter(Boolean));

  log.success('All done!');
  log.footer();
}

main().catch((err) => {
  console.error(`\n  Error: ${err.message || err}\n`);
  process.exit(1);
});
