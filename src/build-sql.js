// BUILD SQL: turns everything pulled from MyKlinik into SQL for the Medisy
// production schema (see CLAUDE.md "Production data model").
//
//   kk_pendaftaran  <- BACKUP Data Pasien (one row per patient, no_pendaftaran = MR)
//   kk_kunjungan    <- V1 Kunjungan daily exports (no_kunjungan = Register),
//                      poli from the V1 Pendaftaran export (same Register),
//                      + SOAP print PDF: keluhan/anamnesa/S and TTV
//   kk_pemeriksaan_tambahan_lab <- BACKUP "Hasil Laboratorium"
//   the other 9 Rekam Medis types: placeholders (counted in the recap only)
//
// Every statement is safe against a DB that already holds part of the data:
// INSERTs are guarded by WHERE NOT EXISTS on the business key, UPDATEs only
// fill empty columns. Rollbacks undo only what this SQL could have changed,
// based on the sql-reference/ dump snapshot (ids above its max id; UPDATEd
// columns restored only if they still hold the value this SQL wrote).
//
// Output: output/sql/{YYYY}/{YYYY}_{MM}.sql (+ _partN beyond 1MB) and
// {YYYY}_{MM}_rollback.sql, oldest period first; recap at output/sql/migrate_recap.md.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import XLSX from 'xlsx';
import dotenv from 'dotenv';
import {
  loadSqlReferenceData, parseInsertStatements, isPlaceholder,
  findMatchingAgama, findMatchingKota, findMatchingKecamatan, findMatchingDesa, findMatchingUser, findMatchingPoli,
} from './sql-parser.js';
import { writeChunkedSql } from './importer.js';
import { parseDateRange, generateMonthlyRange } from './utils.js';

dotenv.config();

const APP_TARGET = process.env.APP_TARGET || 'MyKlinik';
const OUTPUT_DIR = process.env.OUTPUT_DIR || 'output';
const SQL_DIR = path.join(OUTPUT_DIR, 'sql');
const REF_DIR = path.join(process.cwd(), 'sql-reference');
const BACKUP_DIR = path.join(OUTPUT_DIR, 'backup');

const LAB_ID_PEMERIKSAAN = 170; // SWAB RAPID ANTIGEN COVID & FLU A/B — every MyKlinik lab export row is this test
// Rekam Medis types from Download Data and whether they are mapped to SQL yet
export const REKAM_MEDIS_TYPES = {
  'soap': 'kk_kunjungan (keluhan, anamnesa, TTV via PDF)',
  'hasil-laboratorium': 'kk_pemeriksaan_tambahan_lab',
  'persetujuan-umum-general-consent': null,
  'pengkajian-risiko-jatuh': null,
  'informed-consent': null,
  'persetujuan-satu-sehat': null,
  'cppt': null,
  'surgical-safety-checklist': null,
  'hasil-radiologi': null,
  'hasil-mcu': null,
  'resep-dan-obat': null,
};

// ─── helpers ───────────────────────────────────────────────────
const pad = (n) => String(n).padStart(2, '0');
const q = (v) => (v == null ? 'NULL' : typeof v === 'number' ? String(v) : "'" + String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'");
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const periodOf = (ymd) => (ymd && /^\d{4}-\d{2}/.test(ymd) ? ymd.slice(0, 7).replace('-', '_') : null);
const dmy2ymd = (s) => { const m = /(\d{2})-(\d{2})-(\d{4})/.exec(s || ''); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
const to12h = (t) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(t || '');
  if (!m) return '';
  const h = +m[1];
  return `${h % 12 || 12}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`;
};
const minutes = (t) => { const m = /^(\d{1,2}):(\d{2})/.exec(t || ''); return m ? +m[1] * 60 + +m[2] : null; };
const listDir = (d, re) => (fs.existsSync(d) ? fs.readdirSync(d).filter((f) => re.test(f)).sort() : []);

function loadDump(table) {
  const f = path.join(REF_DIR, `${table}.sql`);
  return fs.existsSync(f) ? parseInsertStatements(fs.readFileSync(f, 'utf8')) : [];
}

// ─── loaders ───────────────────────────────────────────────────
function loadPasien() {
  const dir = path.join(BACKUP_DIR, 'pasien');
  return listDir(dir, /\.json$/).flatMap((f) => readJson(path.join(dir, f))).filter((x) => /^\d{6}$/.test(String(x['NO MR'] || '')));
}

// V1 Pendaftaran: Register -> { poli, jam, mr, tanggal } (one row per registration/visit)
function loadV1Pendaftaran() {
  const map = new Map();
  const root = path.join(OUTPUT_DIR, 'pendaftaran');
  for (const y of listDir(root, /^\d{4}$/)) {
    for (const f of listDir(path.join(root, y), /\.json$/)) {
      for (const r of readJson(path.join(root, y, f))) {
        const no = String(r.__EMPTY || '').trim();
        if (!/^\d{6}$/.test(no)) continue;
        map.set(no, { poli: String(r.__EMPTY_7 || '').trim(), jam: String(r.__EMPTY_2 || '').trim(), mr: String(r.__EMPTY_3 || '').trim(), tanggal: dmy2ymd(r.__EMPTY_1) });
      }
    }
  }
  return map;
}

// V1 Kunjungan daily exports (positional columns, header on row 5)
function loadV1Kunjungan() {
  const rows = new Map();
  const root = path.join(OUTPUT_DIR, 'kunjungan');
  for (const y of listDir(root, /^\d{4}$/)) {
    for (const f of listDir(path.join(root, y), /_\d{4}_\d{2}_\d{2}\.xlsx$/)) {
      const wb = XLSX.read(fs.readFileSync(path.join(root, y, f)), { type: 'buffer' });
      const grid = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: false });
      for (const r of grid) {
        const no = String(r[2]).trim();
        if (!/^\d{6}$/.test(no) || !/^\d{2}-\d{2}-\d{4}/.test(r[1]) || rows.has(no)) continue;
        const [d, t] = String(r[1]).split(' ');
        rows.set(no, {
          no, tanggal: dmy2ymd(d), waktu: t || '00:00:00', mr: String(r[3]).trim(), nama: String(r[4]).trim(),
          dokter: String(r[7]).trim(), tindakan: String(r[12]).replace(/\s+/g, ' ').trim(), nik: String(r[16]).replace(/^'/, '').replace(/\D/g, ''),
        });
      }
    }
  }
  return rows;
}

// ─── kk_pendaftaran ────────────────────────────────────────────
const PEND_COLS = ['nama', 'no_pendaftaran', 'no_register_keluarga', 'id_antrian', 'jenis_pasien', 'tanggal', 'jam', 'type_identitas', 'no_identitas', 'pendidikan', 'bahasa_dikuasai', 'jenis_kelamin', 'gol_darah', 'status_pendaftaran', 'bantuan_pemerintah', 'jenis_pendaftaran', 'kelas_bpjs', 'hub_keluarga_peserta', 'prolanis', 'prb', 'agama', 'tanggal_lahir', 'place_of_birth', 'telpon', 'negara', 'provinsi', 'kota', 'kecamatan', 'desa', 'alamat', 'layanan', 'dokter', 'catatan_pasien', 'source', 'kelengkapan_identitas', 'terakhir_ubah_identitas', 'ket', 'user', 'id_perusahaan', 'created', 'ucode', 'hash_id'];

function pasienStatement(x, ref, firstJam, recap) {
  const mr = x['NO MR'];
  const nama = String(x['NAMA PASIEN'] || '').trim().toUpperCase().replace(/\s+/g, ' ');
  const nik = String(x.KTP || '').replace(/\D/g, '');
  const miss = [];
  const use = (label, raw, m) => {
    if (isPlaceholder(raw)) return null;
    if (!m || !m.applied) { miss.push(`${label} (${raw})`); return null; }
    return m;
  };
  const kota = use('kota', x.KABUPATEN, findMatchingKota(ref, x.KABUPATEN));
  const kec = use('kecamatan', x.KECAMATAN, kota ? findMatchingKecamatan(ref, x.KECAMATAN, kota.id) : null);
  const desa = use('desa', x.KELURAHAN, kec ? findMatchingDesa(ref, x.KELURAHAN, kec.id) : null);
  const agama = isPlaceholder(x.AGAMA) ? { id: 0 } : use('agama', x.AGAMA, findMatchingAgama(ref, x.AGAMA));
  if (miss.length) recap.pasien.push(`${mr} ${nama}: ${miss.join(', ')}`);

  const jkRaw = String(x['JNS KELAMIN'] || '').toUpperCase();
  const jk = /PEREMPUAN|WANITA/.test(jkRaw) ? '2' : /LAKI/.test(jkRaw) ? '1' : '';
  const tanggal = /^\d{4}-\d{2}-\d{2}$/.test(x['TGL MR']) ? x['TGL MR'] : null;
  const created = tanggal ? `${tanggal} ${firstJam && /^\d{1,2}:\d{2}/.test(firstJam) ? firstJam.padStart(8, '0') : '00:00:00'}` : null;
  const alamat = [x.ALAMAT, x.ALAMAT2].map((s) => String(s || '').trim()).filter(Boolean).join(' ');
  const v = [nama, mr, '', 0, 'BARU', tanggal, to12h(firstJam), nik ? '1' : '', nik, '', 'Indonesia', jk, String(x['GOL DARAH'] || '').trim(), 'UMUM', '', 'TIDAK', '', '', '', '',
    agama ? String(agama.id) : null, /^\d{4}-\d{2}-\d{2}$/.test(x['TGL LAHIR']) ? x['TGL LAHIR'] : null, String(x['TEMPAT LAHIR'] || '').trim(), String(x.TELP || '').trim(),
    'Indonesia', kota ? String(kota.id).slice(0, 2) : null, kota ? String(kota.id) : null, kec ? String(kec.id) : null, desa ? String(desa.id) : null, alamat,
    '1', '0', '', '16', 0, created, 'INPUT', 1, 1, created, '', crypto.createHash('sha256').update('myklinik-mr-' + mr).digest('hex')];
  // Same person registered twice in MyKlinik (same NIK, or same name+DOB without NIK) -> keep the first
  const dupGuard = nik.length >= 10
    ? ` AND NOT EXISTS (SELECT 1 FROM \`kk_pendaftaran\` WHERE \`no_identitas\` = ${q(nik)})`
    : ` AND NOT EXISTS (SELECT 1 FROM \`kk_pendaftaran\` WHERE \`nama\` = ${q(nama)} AND \`tanggal_lahir\` = ${q(v[21])} AND (\`no_identitas\` IS NULL OR \`no_identitas\` = ''))`;
  return `-- pasien ${mr} ${nama}\nINSERT INTO \`kk_pendaftaran\` (${PEND_COLS.map((c) => '`' + c + '`').join(', ')})\nSELECT ${v.map(q).join(', ')}\nFROM DUAL WHERE NOT EXISTS (SELECT 1 FROM \`kk_pendaftaran\` WHERE \`no_pendaftaran\` = ${q(mr)})${dupGuard};`;
}

// ─── kk_kunjungan ──────────────────────────────────────────────
const KUNJ_COLS = ['id_pendaftaran', 'tanggal', 'waktu', 'id_antrian', 'prioritas', 'id_layanan', 'id_dokter', 'keluhan_awal', 'riwayat_peny_sekarang', 'rujuk', 'tipe_rujuk', 'rujuk_balik', 'status_rujuk_balik', 'id_user', 'id_perusahaan', 'ket', 'created', 'bpjs', 'no_kunjungan', 'id_kunjungan_ranap', 'status_lab_ranap', 'spo2', 'poli_rujuk', 'asal_rujukan', 'tujuan_rujukan', 'rujuk_kasir', 'jenis_kunjungan', 'id_penjamin', 'status_kunjungan', 'status_berobat', 'kelengkapan_rme', 'tipe_kunjungan', 'fasttrack', 'is_aps'];
// SOAP-PDF fields -> kk_kunjungan columns (TTV keys from soap-pdf-parser)
const TTV_COLS = { tinggi_badan: 'tinggi_badan', berat_badan: 'berat_badan', sistole: 'sistole', diastole: 'diastole', lingkar_perut: 'lingkar_perut', respiratory_rate: 'resdiratory_rate', heart_rate: 'heart_rate', suhu: 'suhu_badan', lingkar_kepala: 'lingkar_kepala', imt: 'nilai_bmi' };

function soapFields(pdf) {
  if (!pdf) return {};
  const firstLine = (s) => String(s || '').split('\n')[0].trim();
  const f = {
    keluhan_awal: pdf.keluhan || pdf.anamnesa || firstLine(pdf.subjective) || null,
    riwayat_peny_sekarang: pdf.subjective || pdf.anamnesa || null,
  };
  for (const [k, col] of Object.entries(TTV_COLS)) if (pdf.ttv?.[k] != null) f[col] = pdf.ttv[k];
  if (pdf.ttv?.spo2 != null) f.spo2 = String(pdf.ttv.spo2);
  for (const k of Object.keys(f)) if (f[k] == null || f[k] === '') delete f[k];
  return f;
}

function pasienSubquery(v) {
  const byMr = `(SELECT \`id\` FROM \`kk_pendaftaran\` WHERE \`no_pendaftaran\` = ${q(v.mr)} ORDER BY \`id\` LIMIT 1)`;
  return v.nik.length >= 10 ? `COALESCE(${byMr}, (SELECT \`id\` FROM \`kk_pendaftaran\` WHERE \`no_identitas\` = ${q(v.nik)} ORDER BY \`id\` LIMIT 1))` : byMr;
}

// ─── main builder ──────────────────────────────────────────────
export async function buildSql(log, opts = {}) {
  const ref = loadSqlReferenceData(REF_DIR);
  const dumpP = loadDump('kk_pendaftaran');
  const dumpK = loadDump('kk_kunjungan');
  const labCatalog = loadDump('kk_pemeriksaan_lab').find((r) => +r.id === LAB_ID_PEMERIKSAAN);
  const maxIdP = Math.max(0, ...dumpP.map((r) => +r.id));
  const maxIdK = Math.max(0, ...dumpK.map((r) => +r.id));
  const dumpKByNo = new Map(dumpK.filter((k) => k.no_kunjungan).map((k) => [k.no_kunjungan, k]));
  const recap = { pasien: [], kunjungan: [], soap: [], lab: [], ttv: [], placeholders: {} };

  let periods;
  if (process.env.START_DATE && process.env.END_DATE) {
    const { start, end } = parseDateRange(process.env.START_DATE, process.env.END_DATE);
    periods = generateMonthlyRange(start, end).map((m) => `${m.year}_${pad(m.month)}`).reverse(); // oldest first
  } else {
    periods = listDir(BACKUP_DIR, /^\d{4}_\d{2}$/);
  }
  const firstP = periods[0];
  const inRange = new Set(periods);

  const pasien = loadPasien();
  const v1p = loadV1Pendaftaran();
  const allVisits = loadV1Kunjungan();
  // only visits inside START_DATE..END_DATE are built
  const visits = new Map([...allVisits].filter(([, v]) => inRange.has(periodOf(v.tanggal))));
  log.info(`Sumber: ${pasien.length} pasien (Data Pasien) · ${visits.size} kunjungan (export Kunjungan) · ${v1p.size} pendaftaran (export Pendaftaran) · dump: ${dumpP.length} pasien / ${dumpK.length} kunjungan`);

  // first visit per MR + its registration time (for kk_pendaftaran.jam / ordering)
  const firstVisit = new Map();
  for (const v of [...allVisits.values()].sort((a, b) => (a.tanggal + a.waktu).localeCompare(b.tanggal + b.waktu))) if (!firstVisit.has(v.mr)) firstVisit.set(v.mr, v);

  const groups = new Map(periods.map((p) => [p, { stmts: [], rollback: { lab: [], upd: [], kunj: [], pend: [] }, counts: { pasien: 0, kunjungan: 0, update: 0, lab: 0 } }]));
  const G = (p) => groups.get(p);
  const mrWithVisitInRange = new Set([...visits.values()].map((v) => v.mr));

  // 1) patients — placed in the month of their MR date or first visit, whichever is
  //    earlier. Patients from before the range are included (in its first month)
  //    only when they have a visit inside the range.
  for (const x of pasien) {
    const fv = firstVisit.get(x['NO MR']);
    const reg = fv ? v1p.get(fv.no) : null;
    const jam = reg && reg.tanggal === x['TGL MR'] ? reg.jam : '';
    let p = [periodOf(x['TGL MR']), fv ? periodOf(fv.tanggal) : null].filter(Boolean).sort()[0] || firstP;
    if (!inRange.has(p)) {
      if (p < firstP && mrWithVisitInRange.has(x['NO MR'])) p = firstP;
      else continue;
    }
    const g = G(p);
    g.stmts.push([pasienStatement(x, ref, jam, recap)]);
    g.rollback.pend.push(x['NO MR']);
    g.counts.pasien++;
  }

  // 2) SOAP PDFs -> visits (by MR + date, doctor as tie-breaker)
  const visitsByMrDate = new Map();
  for (const v of visits.values()) {
    const k = `${v.mr}|${v.tanggal}`;
    (visitsByMrDate.get(k) || visitsByMrDate.set(k, []).get(k)).push(v);
  }
  const soapByVisit = new Map();
  const soapVisitByMyklinikId = new Map(); // MyKlinik internal visit id -> Register (to link Lab)
  let pdfCount = 0;
  for (const period of periods) {
    const f = path.join(BACKUP_DIR, period, `${APP_TARGET}_soap-pdf_${period}.json`);
    if (!fs.existsSync(f)) continue;
    for (const pdf of readJson(f)) {
      if (pdf.error) { recap.soap.push(`${pdf.soap_id}: PDF gagal diparse (${pdf.error})`); continue; }
      pdfCount++;
      const cands = (visitsByMrDate.get(`${pdf.mr}|${pdf.tanggal_pemeriksaan}`) || []).filter((v) => !soapByVisit.has(v.no));
      const pick = cands.find((v) => norm(v.dokter) === norm(pdf.dokter)) || cands[0];
      if (!pick) { recap.soap.push(`SOAP ${pdf.soap_id} MR ${pdf.mr} ${pdf.tanggal_pemeriksaan} (${pdf.dokter}): tidak ada kunjungan di export Kunjungan`); continue; }
      soapByVisit.set(pick.no, pdf);
      if (pdf.myklinik_kunjungan_id) soapVisitByMyklinikId.set(pdf.myklinik_kunjungan_id, pick.no);
      if (pdf.ttv_issues?.length) recap.ttv.push(`${pick.no} MR ${pdf.mr} ${pdf.tanggal_pemeriksaan}: ${pdf.ttv_issues.join(', ')} (dikosongkan)`);
    }
  }

  // 3) visits
  for (const v of [...visits.values()].sort((a, b) => a.no.localeCompare(b.no))) {
    const g = G(periodOf(v.tanggal));
    const reg = v1p.get(v.no);
    const poliMatch = reg?.poli ? findMatchingPoli(ref, reg.poli) : null;
    const idLayanan = poliMatch?.applied ? poliMatch.id : 1;
    if (!poliMatch?.applied) recap.kunjungan.push(`${v.no} ${v.tanggal} ${v.nama}: poli tidak ada di export Pendaftaran${reg?.poli ? ` (${reg.poli})` : ''} -> POLI UMUM`);
    const dok = findMatchingUser(ref, v.dokter);
    const idDokter = dok?.applied ? dok.id : 0;
    if (!dok?.applied && v.dokter && !isPlaceholder(v.dokter)) recap.kunjungan.push(`${v.no} ${v.tanggal}: dokter "${v.dokter}" tidak ditemukan di kk_users`);

    const sf = soapFields(soapByVisit.get(v.no));
    const base = {
      id_pendaftaran: null, tanggal: v.tanggal, waktu: v.waktu, id_antrian: 0, prioritas: '1', id_layanan: idLayanan, id_dokter: idDokter,
      keluhan_awal: sf.keluhan_awal || '', riwayat_peny_sekarang: sf.riwayat_peny_sekarang || '', rujuk: 'TIDAK', tipe_rujuk: 'EXTERNAL', rujuk_balik: 'TIDAK', status_rujuk_balik: 0,
      id_user: 1, id_perusahaan: 1, ket: 'INPUT', created: `${v.tanggal} ${v.waktu}`, bpjs: 0, no_kunjungan: v.no, id_kunjungan_ranap: 0, status_lab_ranap: '', spo2: sf.spo2 || '',
      poli_rujuk: '', asal_rujukan: 0, tujuan_rujukan: 0, rujuk_kasir: '', jenis_kunjungan: 'UMUM', id_penjamin: 0, status_kunjungan: '0', status_berobat: 'Berobat', kelengkapan_rme: 0,
      tipe_kunjungan: 'SAKIT', fasttrack: 0, is_aps: 0,
    };
    const extraCols = Object.keys(TTV_COLS).map((k) => TTV_COLS[k]).filter((c) => sf[c] != null);
    const cols = [...KUNJ_COLS, ...extraCols];
    const vals = cols.map((c) => (c === 'id_pendaftaran' ? pasienSubquery(v) : q(c in base ? base[c] : sf[c])));
    const stmt = [`-- kunjungan ${v.no} ${v.tanggal} ${v.nama}${soapByVisit.has(v.no) ? ' (+SOAP/TTV)' : ''}\nINSERT INTO \`kk_kunjungan\` (${cols.map((c) => '`' + c + '`').join(', ')})\nSELECT ${vals.join(', ')}\nFROM DUAL WHERE NOT EXISTS (SELECT 1 FROM \`kk_kunjungan\` WHERE \`no_kunjungan\` = ${q(v.no)});`];
    g.counts.kunjungan++;
    g.rollback.kunj.push(v.no);

    // Visit already in the DB: fill only empty columns
    const fill = Object.entries(sf);
    if (fill.length) {
      const sets = fill.map(([c, val]) => (typeof val === 'number'
        ? `\`${c}\` = COALESCE(NULLIF(\`${c}\`, 0), ${q(val)})`
        : `\`${c}\` = COALESCE(NULLIF(\`${c}\`, ''), ${q(val)})`));
      stmt.push(`UPDATE \`kk_kunjungan\` SET ${sets.join(', ')} WHERE \`no_kunjungan\` = ${q(v.no)};`);
      g.counts.update++;
      const old = dumpKByNo.get(v.no);
      if (old) {
        const restore = fill.filter(([c]) => old[c] == null || old[c] === '' || +old[c] === 0)
          .map(([c, val]) => `\`${c}\` = CASE WHEN \`${c}\` = ${q(val)} THEN ${q(old[c])} ELSE \`${c}\` END`);
        if (restore.length) g.rollback.upd.push(`UPDATE \`kk_kunjungan\` SET ${restore.join(', ')} WHERE \`no_kunjungan\` = ${q(v.no)};`);
      }
    }
    g.stmts.push(stmt);
  }

  // 4) Lab -> kk_pemeriksaan_tambahan_lab
  const visitsByDate = new Map();
  for (const v of visits.values()) (visitsByDate.get(v.tanggal) || visitsByDate.set(v.tanggal, []).get(v.tanggal)).push(v);
  const labBiaya = labCatalog ? +labCatalog.biaya : 250000;
  for (const period of periods) {
    const f = path.join(BACKUP_DIR, period, `${APP_TARGET}_hasil-laboratorium_${period}.json`);
    if (!fs.existsSync(f)) continue;
    const byVisit = new Map();
    for (const r of readJson(f)) (byVisit.get(r['6']) || byVisit.set(r['6'], []).get(r['6'])).push(r);
    for (const [mkVisit, rows] of byVisit) {
      const r0 = rows[0];
      // via the SOAP of the same MyKlinik visit, else nearest visit that day with the same doctor
      let no = soapVisitByMyklinikId.get(mkVisit);
      let via = 'SOAP';
      if (!no) {
        const t = minutes(r0['4']);
        const cand = (visitsByDate.get(r0['3']) || []).map((v) => ({ v, d: t == null ? 999 : Math.abs(minutes(v.waktu) - t), dok: norm(v.dokter) === norm(r0['22']) }))
          .filter((c) => c.d <= 180).sort((a, b) => (b.dok - a.dok) || (a.d - b.d));
        no = cand[0]?.v.no; via = cand[0] ? `jam±${cand[0].d}m${cand[0].dok ? '' : ', dokter beda'}` : null;
      }
      if (!no) { recap.lab.push(`${r0['3']} ${r0['4']} (${r0['22']}): kunjungan tidak ditemukan`); continue; }
      const g = G(periodOf(r0['3'])) || G(period);
      const bySample = new Map();
      for (const r of rows) (bySample.get(r['24']) || bySample.set(r['24'], []).get(r['24'])).push(r);
      for (const [lb, rs] of bySample) {
        const res = rs.find((r) => r['45_10']) || rs[0];
        const clean = (s) => String(s || '').replace(/<[^>]+>|&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
        const ucode = `MYKLINIK-LAB:${lb}`;
        const ket = [clean(res['45_11']), `Import MyKlinik ${lb} (${clean(res['22'])}, via ${via})`].filter(Boolean).join(' | ');
        const dt = (d, t) => (d && t ? `${d} ${t.length === 5 ? t + ':00' : t}` : null);
        g.stmts.push([`-- lab ${lb} -> kunjungan ${no}\nINSERT INTO \`kk_pemeriksaan_tambahan_lab\` (\`id_pemeriksaan_lab\`, \`id_kunjungan\`, \`status\`, \`id_perusahaan\`, \`hasil\`, \`kritis\`, \`biaya\`, \`petugas\`, \`id_paket\`, \`id_sampel\`, \`keterangan\`, \`ucode\`, \`ket\`, \`jam_ambil_sample\`, \`jam_selesai\`, \`created\`, \`deleted\`, \`updated\`)\n` +
          `SELECT ${LAB_ID_PEMERIKSAAN}, k.\`id\`, 'NO', 1, ${q(clean(res['45_10']).slice(0, 30))}, 0, ${labBiaya}, 0, 0, NULL, ${q(ket)}, ${q(ucode)}, 'INPUT', ${q(dt(res['3'], res['4']))}, ${q(dt(res['25'], res['26']))}, ${q(res['45'] || dt(res['3'], res['4']))}, '0000-00-00 00:00:00', '0000-00-00 00:00:00'\n` +
          `FROM \`kk_kunjungan\` k WHERE k.\`no_kunjungan\` = ${q(no)} AND NOT EXISTS (SELECT 1 FROM \`kk_pemeriksaan_tambahan_lab\` WHERE \`ucode\` = ${q(ucode)}) LIMIT 1;`]);
        g.rollback.lab.push(ucode);
        g.counts.lab++;
      }
    }
  }

  // 5) placeholders for Rekam Medis types without a mapping yet
  for (const [slug, target] of Object.entries(REKAM_MEDIS_TYPES)) {
    if (target) continue;
    let n = 0;
    for (const period of periods) {
      const f = path.join(BACKUP_DIR, period, `${APP_TARGET}_${slug}_${period}.json`);
      if (fs.existsSync(f)) n += readJson(f).length;
    }
    recap.placeholders[slug] = n;
  }

  // ── write ──
  if (!opts.dryRun) {
    // Files this builder wrote earlier are simply replaced; anything else in a
    // period's name (e.g. from the old IMPORT mode) is moved aside, not deleted.
    const own = (f) => /^-- (MyKlinik -> Medisy|Rollback \d{4}_\d{2} \(jalankan)/.test(fs.readFileSync(f, 'utf8').slice(0, 80));
    let bak = null;
    for (const period of periods) {
      const dir = path.join(SQL_DIR, period.slice(0, 4));
      for (const f of listDir(dir, new RegExp(`^${period}(_part\\d+|_rollback|_pendaftaran|_kunjungan)*\\.sql$`))) {
        const fp = path.join(dir, f);
        if (own(fp)) { fs.rmSync(fp); continue; }
        bak = bak || path.join(SQL_DIR, '_previous', new Date().toISOString().replace(/[:.]/g, '-'));
        fs.mkdirSync(path.join(bak, period.slice(0, 4)), { recursive: true });
        fs.renameSync(fp, path.join(bak, period.slice(0, 4), f));
      }
    }
    if (bak) log.info(`SQL lama (bukan buatan build) dipindah ke ${bak}`);
  }
  const totals = { pasien: 0, kunjungan: 0, update: 0, lab: 0, files: 0 };
  for (const [period, g] of groups) {
    if (!g.stmts.length) continue;
    for (const k of Object.keys(g.counts)) totals[k] += g.counts[k];
    if (opts.dryRun) continue;
    const dir = path.join(SQL_DIR, period.slice(0, 4));
    fs.mkdirSync(dir, { recursive: true });
    const c = g.counts;
    totals.files += writeChunkedSql(dir, period, `MyKlinik -> Medisy ${period}: ${c.pasien} pasien, ${c.kunjungan} kunjungan (${c.update} dengan SOAP/TTV), ${c.lab} sampel lab. Jalankan berurutan dari periode terlama.`, g.stmts);
    const rb = g.rollback;
    const inList = (arr) => arr.map(q).join(', ');
    const parts = [
      rb.lab.length && `DELETE FROM \`kk_pemeriksaan_tambahan_lab\` WHERE \`ucode\` IN (${inList(rb.lab)});`,
      ...rb.upd,
      rb.kunj.length && `DELETE FROM \`kk_kunjungan\` WHERE \`id\` > ${maxIdK} AND \`no_kunjungan\` IN (${inList(rb.kunj)});`,
      rb.pend.length && `DELETE FROM \`kk_pendaftaran\` WHERE \`id\` > ${maxIdP} AND \`no_pendaftaran\` IN (${inList(rb.pend)});`,
    ].filter(Boolean);
    fs.writeFileSync(path.join(dir, `${period}_rollback.sql`),
      `-- Rollback ${period} (jalankan dari periode TERBARU ke terlama). Berdasarkan snapshot sql-reference/: id pasien > ${maxIdP}, id kunjungan > ${maxIdK};\n-- kolom yang di-UPDATE hanya dikembalikan bila isinya masih sama dengan yang ditulis SQL ini.\nSTART TRANSACTION;\n\n${parts.join('\n\n')}\n\nCOMMIT;\n`);
  }

  // ── recap ──
  const md = [`# Recap build SQL MyKlinik -> Medisy`, '', `Dibuat: ${new Date().toISOString()}`, '',
    `| | Jumlah |`, `|---|---|`, `| Pasien (kk_pendaftaran) | ${totals.pasien} |`, `| Kunjungan (kk_kunjungan) | ${totals.kunjungan} |`, `| Kunjungan dengan SOAP/TTV | ${totals.update} |`, `| PDF SOAP terbaca | ${pdfCount} |`, `| Sampel lab (kk_pemeriksaan_tambahan_lab) | ${totals.lab} |`, '',
    `## Rekam Medis yang belum dipetakan (placeholder)`, '', '| Jenis | Baris di export |', '|---|---|', ...Object.entries(recap.placeholders).map(([k, n]) => `| ${k} | ${n} |`), '',
    ...[['Pasien: lookup wilayah/agama gagal', recap.pasien], ['Kunjungan', recap.kunjungan], ['SOAP tidak terhubung ke kunjungan', recap.soap], ['TTV di luar rentang wajar', recap.ttv], ['Lab tidak terhubung ke kunjungan', recap.lab]]
      .flatMap(([t, arr]) => [`## ${t} (${arr.length})`, '', ...(arr.length ? arr.map((s) => `- ${s}`) : ['-']), '']),
  ];
  if (!opts.dryRun) { fs.mkdirSync(SQL_DIR, { recursive: true }); fs.writeFileSync(path.join(SQL_DIR, 'migrate_recap.md'), md.join('\n')); }
  return { ...totals, pdfCount, recap };
}
