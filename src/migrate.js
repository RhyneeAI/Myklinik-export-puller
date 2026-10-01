// MIGRATE: one command that runs the whole MyKlinik -> Medisy pipeline.
//
//   1 pasien       Data Pasien (BACKUP / Download Data)            21:00-06:00 WIB only
//   2 kunjungan    V1 Pendaftaran (monthly) + Kunjungan (daily)     any time
//   3 rekam-medis  the 11 Download Data types per month (BACKUP)   21:00-06:00 WIB only
//   4 soap-pdf     SOAP print PDF per SOAP + parse (TTV, keluhan)   any time
//   5 sql          kk_pendaftaran / kk_kunjungan / lab SQL per month, <=1MB per file
//   6 zip          one zip per month (+ Data Pasien) in output/archive/
//
// Every step resumes: finished downloads are reused, so re-running is cheap.
// Date range: START_DATE / END_DATE from .env (or the environment).
//
// Usage: npm run migrate [-- --steps=2,4,5] [-- --from=4] [-- --no-wait]
//   --steps   run only these steps (numbers or names)
//   --from    start at this step
//   --no-wait outside 21:00-06:00 WIB, skip steps 1 and 3 instead of waiting
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { createLogger, green, red, yellow, dim } from './logger.js';
import { parseDateRange, generateMonthlyRange } from './utils.js';
import { runSoapPdf } from './soap-pdf.js';
import { buildSql } from './build-sql.js';
import { buildArchives } from './archive.js';

dotenv.config();

const SRC = path.dirname(fileURLToPath(import.meta.url));
const NO_WAIT = process.argv.includes('--no-wait');

// Runs one of the existing tools as a child process, streaming its output
function runTool(script, args = [], env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(SRC, script), ...args], { stdio: 'inherit', env: { ...process.env, ...env } });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

const STEPS = [
  { n: 1, name: 'pasien', title: 'Tarik Data Pasien (Download Data)', run: () => runTool('backup.js', ['--only=pasien', ...(NO_WAIT ? ['--no-wait'] : [])]) },
  { n: 2, name: 'kunjungan', title: 'Tarik Pendaftaran & Kunjungan (V1)', run: () => runTool('index.js', [], { ACTION: 'EXPORT', MODE: 'all' }) },
  { n: 3, name: 'rekam-medis', title: 'Tarik 11 jenis Rekam Medis (Download Data)', run: () => runTool('backup.js', ['--only=rekam-medis', ...(NO_WAIT ? ['--no-wait'] : [])]) },
  { n: 4, name: 'soap-pdf', title: 'Tarik & parse PDF SOAP per kunjungan', run: async (log) => { const r = await runSoapPdf(log); return r.failed ? 1 : 0; } },
  { n: 5, name: 'sql', title: 'Bangun SQL (pasien, kunjungan + SOAP/TTV, lab)', run: async (log) => { const r = await buildSql(log); log.info(`SQL: ${r.pasien} pasien, ${r.kunjungan} kunjungan (${r.update} dengan SOAP/TTV), ${r.lab} sampel lab -> ${r.files} file di output/sql/{tahun}/ · recap: output/sql/migrate_recap.md`); return 0; } },
  { n: 6, name: 'zip', title: 'Zip arsip per tahun-bulan', run: async (log, periods) => { buildArchives(log, periods); return 0; } },
];

function selectSteps() {
  const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];
  const pick = (v) => STEPS.find((s) => String(s.n) === v || s.name === v);
  if (arg('steps')) return arg('steps').split(',').map((v) => pick(v.trim())).filter(Boolean);
  const from = arg('from') ? pick(arg('from')) : STEPS[0];
  return STEPS.filter((s) => s.n >= (from?.n || 1));
}

async function main() {
  const log = createLogger('MyPharmaExportPuller · MIGRATE', '1.0.0');
  const { START_DATE, END_DATE, APP_TARGET = 'MyKlinik' } = process.env;
  log.header(APP_TARGET, 'migrate');
  if (!START_DATE || !END_DATE) {
    log.error('START_DATE dan END_DATE wajib diisi (format YYYY-MM, START lebih baru).');
    process.exit(1);
  }
  const { start, end } = parseDateRange(START_DATE, END_DATE);
  const periods = generateMonthlyRange(start, end).map((m) => `${m.year}_${String(m.month).padStart(2, '0')}`);
  const steps = selectSteps();
  log.info(`Periode ${START_DATE} → ${END_DATE} (${periods.length} bulan) · langkah: ${steps.map((s) => `${s.n}.${s.name}`).join(', ')}${NO_WAIT ? ' · --no-wait' : ''}`);

  const results = [];
  for (const s of steps) {
    log.section(`Langkah ${s.n}/6 — ${s.title}`);
    const t0 = Date.now();
    let code;
    try {
      code = await s.run(log, periods);
    } catch (err) {
      log.error(err.message);
      code = 1;
    }
    const mins = ((Date.now() - t0) / 60000).toFixed(1);
    results.push(`${s.n}. ${s.name}: ${code === 0 ? green('OK') : red('GAGAL')} ${dim(`(${mins} menit)`)}`);
    if (code !== 0) {
      log.error(`Langkah ${s.n} (${s.name}) gagal — pipeline berhenti. Jalankan ulang dengan --from=${s.n} setelah diperbaiki (yang sudah selesai tidak diulang).`);
      break;
    }
  }
  log.summary(results);
  if (NO_WAIT && steps.some((s) => s.n === 1 || s.n === 3)) log.info(yellow('Catatan: dengan --no-wait, langkah 1/3 dilewati bila di luar 21.00–06.00 WIB — jalankan lagi malam hari untuk melengkapi.'));
  log.footer();
  if (results.some((r) => r.includes('GAGAL'))) process.exitCode = 1;
}

main();
