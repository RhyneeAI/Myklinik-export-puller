// ARCHIVE: packs everything pulled from MyKlinik into one zip per month:
//   output/archive/{YYYY}/{APP_TARGET}_{YYYY}_{MM}.zip
//     pendaftaran/   V1 Pendaftaran export of that month
//     kunjungan/     V1 Kunjungan daily exports (+ monthly merge)
//     rekam-medis/   the 11 Download Data types of that month (csv/xlsx + json)
//     soap-pdf/      SOAP print PDFs of that month (+ parsed json)
//   output/archive/{APP_TARGET}_pasien.zip  (Data Pasien isn't per month)
// A zip is rebuilt only when one of its source files is newer than it.
import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import dotenv from 'dotenv';

dotenv.config();

const APP_TARGET = process.env.APP_TARGET || 'MyKlinik';
const OUTPUT_DIR = process.env.OUTPUT_DIR || 'output';
const ARCHIVE_DIR = path.join(OUTPUT_DIR, 'archive');

const files = (dir, re) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => re.test(f) && fs.statSync(path.join(dir, f)).isFile()).map((f) => path.join(dir, f)) : []);

function sourcesFor(period) {
  const [y, m] = period.split('_');
  const backup = path.join(OUTPUT_DIR, 'backup', period);
  return {
    'pendaftaran': files(path.join(OUTPUT_DIR, 'pendaftaran', y), new RegExp(`_${y}_${m}\\.(xlsx|json)$`)),
    'kunjungan': [
      ...files(path.join(OUTPUT_DIR, 'kunjungan', y), new RegExp(`_${y}_${m}_\\d{2}\\.(xlsx|json)$`)),
      ...files(path.join(OUTPUT_DIR, 'kunjungan', 'merged'), new RegExp(`_${y}_${m}_merged\\.(xlsx|json)$`)),
    ],
    'rekam-medis': files(backup, /\.(csv|xlsx?|xml|json)$/).filter((f) => !/_soap-pdf_/.test(f)),
    'soap-pdf': [...files(path.join(backup, 'soap-pdf'), /\.pdf$/), ...files(backup, /_soap-pdf_.*\.json$/)],
  };
}

function writeZip(zipPath, groups) {
  const all = Object.values(groups).flat();
  if (!all.length) return 'kosong';
  if (fs.existsSync(zipPath)) {
    const zipTime = fs.statSync(zipPath).mtimeMs;
    if (all.every((f) => fs.statSync(f).mtimeMs <= zipTime)) return 'sama';
  }
  const zip = new AdmZip();
  for (const [folder, list] of Object.entries(groups)) for (const f of list) zip.addLocalFile(f, folder);
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  zip.writeZip(zipPath + '.part');
  fs.renameSync(zipPath + '.part', zipPath);
  return 'dibuat';
}

// One zip with everything (Data Pasien + per month: pendaftaran, kunjungan,
// the 11 Rekam Medis types), plus ISI_ZIP.txt listing per-month coverage and
// missing kunjungan days. SOAP PDFs are left out unless `withSoapPdf`.
export function buildFullArchive(log, periods, { withSoapPdf = false } = {}) {
  const zipPath = path.join(ARCHIVE_DIR, `${APP_TARGET}_backup_lengkap.zip`);
  const zip = new AdmZip();
  const lines = [`Backup MyKlinik (${APP_TARGET}) — dibuat ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`, ''];
  const pasien = files(path.join(OUTPUT_DIR, 'backup', 'pasien'), /\.(xlsx?|json)$/);
  for (const f of pasien) zip.addLocalFile(f, 'pasien');
  lines.push(`pasien/                 Data Pasien (${pasien.length} file)`, '', 'Per bulan: pendaftaran (file) | kunjungan (hari ada / hari di bulan) | rekam medis (jenis)', '');
  let totalFiles = pasien.length;
  const missingDays = [];
  for (const period of [...periods].sort()) {
    const [y, m] = period.split('_');
    const src = sourcesFor(period);
    const groups = { pendaftaran: src.pendaftaran, kunjungan: src.kunjungan, 'rekam-medis': src['rekam-medis'], ...(withSoapPdf ? { 'soap-pdf': src['soap-pdf'] } : {}) };
    for (const [folder, list] of Object.entries(groups)) for (const f of list) zip.addLocalFile(f, `${y}/${period}/${folder}`);
    totalFiles += Object.values(groups).flat().length;
    const daysInMonth = new Date(+y, +m, 0).getDate();
    const haveDays = new Set(src.kunjungan.map((f) => /_(\d{2})\.xlsx$/.exec(f)?.[1]).filter(Boolean));
    const missing = [];
    for (let d = 1; d <= daysInMonth; d++) if (!haveDays.has(String(d).padStart(2, '0'))) missing.push(d);
    if (missing.length) missingDays.push(`${period}: ${missing.length === daysInMonth ? 'semua hari' : missing.join(', ')}`);
    const types = new Set(src['rekam-medis'].map((f) => new RegExp(`^${APP_TARGET}_(.+)_${period}\\.`).exec(path.basename(f))?.[1]).filter(Boolean));
    lines.push(`${period}   pendaftaran ${src.pendaftaran.filter((f) => f.endsWith('.xlsx')).length ? 'ada' : 'TIDAK ADA'} | kunjungan ${haveDays.size}/${daysInMonth} hari | rekam medis ${types.size}/11 jenis`);
  }
  lines.push('', `Hari kunjungan yang belum ditarik (${missingDays.length} bulan):`, ...(missingDays.length ? missingDays.map((s) => '  ' + s) : ['  - (lengkap)']));
  zip.addFile('ISI_ZIP.txt', Buffer.from(lines.join('\r\n'), 'utf8'));
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  zip.writeZip(zipPath + '.part');
  fs.renameSync(zipPath + '.part', zipPath);
  log.info(`Zip lengkap: ${zipPath} (${totalFiles} file, ${(fs.statSync(zipPath).size / 1048576).toFixed(1)} MB) · bulan dengan hari kunjungan belum lengkap: ${missingDays.length}`);
  return { zipPath, totalFiles, missingDays };
}

export function buildArchives(log, periods) {
  const stats = { dibuat: 0, sama: 0, kosong: 0 };
  for (const period of periods) {
    const r = writeZip(path.join(ARCHIVE_DIR, period.slice(0, 4), `${APP_TARGET}_${period}.zip`), sourcesFor(period));
    stats[r]++;
  }
  const pasien = writeZip(path.join(ARCHIVE_DIR, `${APP_TARGET}_pasien.zip`), { 'pasien': files(path.join(OUTPUT_DIR, 'backup', 'pasien'), /\.(xlsx?|json)$/) });
  log.info(`Zip per bulan: ${stats.dibuat} dibuat, ${stats.sama} tidak berubah, ${stats.kosong} tanpa data · Data Pasien: ${pasien}`);
  return { ...stats, pasien };
}
