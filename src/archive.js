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
