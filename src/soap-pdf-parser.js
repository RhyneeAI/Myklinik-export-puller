// Parses MyKlinik's "SOAP DAN DIAGNOSA" print PDF (sc.reportme.php?scRpt=klinik/trssoap/trssoap)
// into a plain object. The PDF is a TCPDF two-column form ("Label : value"),
// so text is rebuilt into lines by y-position and split on the known labels.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const FIELDS = {
  'Nama': 'nama',
  'Nomor MR': 'mr',
  'Tanggal Lahir': 'tanggal_lahir',
  'Umur': 'umur',
  'Jenis Kelamin': 'jenis_kelamin',
  'Alamat': 'alamat',
  'Tanggal Pemeriksaan': 'tanggal_pemeriksaan',
  'Dokter': 'dokter',
  'Keluhan': 'keluhan',
  'Anamnesa': 'anamnesa',
  'Subjective': 'subjective',
  'Objective': 'objective',
  'Assasment': 'assessment',
  'Assessment': 'assessment',
  'Plan': 'plan',
  'Asuhan Keperawatan': 'asuhan_keperawatan',
  'Jenis Kunjungann': 'jenis_kunjungan',
  'Jenis Kunjungan': 'jenis_kunjungan',
  'Tinggi Badan': 'tinggi_badan',
  'Berat Badan': 'berat_badan',
  'Sistole': 'sistole',
  'Diastole': 'diastole',
  'Lingkar Perut': 'lingkar_perut',
  'IMT': 'imt',
  'Respiratory Rate': 'respiratory_rate',
  'HeartReate': 'heart_rate',
  'Heart Rate': 'heart_rate',
  'Saturasi Oksigen': 'spo2',
  'Suhu': 'suhu',
  'Lingkar Kepala': 'lingkar_kepala',
  'Tanggal Kontrol': 'tanggal_kontrol',
  'Diagnosa Kerja': 'diagnosa_kerja',
};
// Lines that end the current multi-line field without starting a new one
const SECTION_RE = /^(SOAP DAN DIAGNOSA|SOAP|TTV|DIAGNOSA DAN ICD 10|ICD 9|Demikian surat keterangan|Powered by TCPDF)\b/;
const LABEL_RE = new RegExp(`^(${Object.keys(FIELDS).sort((a, b) => b.length - a.length).map((k) => k.replace(/ /g, '\\s+')).join('|')})\\s*:\\s?(.*)$`);

// Plausible ranges; anything outside (e.g. "Suhu 3.7") is dropped and reported
export const TTV_RANGES = {
  tinggi_badan: [30, 230], berat_badan: [1, 300], sistole: [50, 260], diastole: [30, 160],
  lingkar_perut: [20, 200], imt: [8, 80], respiratory_rate: [5, 60], heart_rate: [30, 220],
  spo2: [50, 100], suhu: [30, 43], lingkar_kepala: [20, 70],
};

async function extractLines(buffer) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise;
  const lines = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const { items } = await page.getTextContent();
    const rows = [];
    for (const it of items) {
      if (!it.str || !it.str.trim()) continue;
      const x = it.transform[4], y = it.transform[5];
      let row = rows.find((r) => Math.abs(r.y - y) < 2.5);
      if (!row) rows.push((row = { y, items: [] }));
      row.items.push({ x, str: it.str, w: it.width });
    }
    rows.sort((a, b) => b.y - a.y);
    for (const r of rows) {
      r.items.sort((a, b) => a.x - b.x);
      lines.push({ page: p, y: r.y, items: r.items, text: r.items.map((i) => i.str.trim()).join(' ').replace(/\s+/g, ' ').trim() });
    }
  }
  await doc.destroy();
  return lines;
}

const num = (v) => {
  const m = /-?\d*[.,]?\d+/.exec(String(v || ''));
  if (!m) return null;
  const n = parseFloat(m[0].replace(',', '.'));
  return Number.isFinite(n) && n !== 0 ? n : null; // the form prints 0 / .0 for "not filled"
};
const clean = (v) => {
  const s = String(v || '').replace(/[ \t]+\n/g, '\n').replace(/\n{2,}/g, '\n').trim();
  return s === '-' ? '' : s;
};
const dmyToYmd = (s) => { const m = /(\d{2})-(\d{2})-(\d{4})/.exec(s || ''); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };

function parseIcdTable(lines, startIdx, endIdx, kind) {
  const out = [];
  const header = lines.slice(startIdx, endIdx).find((l) => /Kode ICD/.test(l.text));
  const prim = header?.items.find((i) => /Primary/.test(i.str));
  const sec = header?.items.find((i) => /Secondary/.test(i.str));
  for (let i = startIdx; i < endIdx; i++) {
    const l = lines[i];
    const m = /^(\d+)\.\s+([A-Z]\d{1,2}(?:\.\d+)?|\d{2}(?:\.\d+)?)\s+(.*)$/.exec(l.text);
    if (m) {
      let name = m[3];
      let primary = null;
      const v = l.items.find((it) => it.str.trim() === 'v');
      if (v && prim && sec) primary = Math.abs(v.x - prim.x) <= Math.abs(v.x - sec.x);
      if (v) name = name.replace(/\s+v$/, '');
      out.push({ no: +m[1], kode: m[2], nama: name.trim(), primary: kind === 'icd10' ? primary : undefined });
    } else if (out.length && !/Kode ICD|^No\.?$/.test(l.text) && l.items[0].x > 60) {
      out[out.length - 1].nama += ' ' + l.text.replace(/\s+v$/, ''); // wrapped name cell
    }
  }
  return out;
}

export async function parseSoapPdf(buffer) {
  const lines = await extractLines(buffer);
  const raw = {};
  let cur = null;
  let icd10Start = -1, icd9Start = -1, endIdx = lines.length;
  lines.forEach((l, idx) => {
    if (/^DIAGNOSA DAN ICD 10/.test(l.text)) icd10Start = idx;
    if (/^ICD 9\b/.test(l.text)) icd9Start = idx;
    if (/^Demikian surat keterangan/.test(l.text) && endIdx === lines.length) endIdx = idx;
  });
  // A value wraps inside its cell at normal line spacing; a real paragraph
  // break in the source shows up as a taller gap. Join accordingly.
  let prev = null;
  for (let idx = 0; idx < lines.length; idx++) {
    const l = lines[idx];
    if ((icd10Start >= 0 && idx > icd10Start && !/^Diagnosa Kerja/.test(l.text) && cur !== 'diagnosa_kerja') || idx >= endIdx) { cur = null; continue; }
    const m = LABEL_RE.exec(l.text);
    if (m) {
      cur = FIELDS[m[1].replace(/\s+/g, ' ')];
      raw[cur] = m[2] || '';
      prev = l;
      continue;
    }
    if (SECTION_RE.test(l.text)) { cur = null; continue; }
    if (cur === 'diagnosa_kerja' && /^No\.?\s+Kode ICD/.test(l.text)) { cur = null; continue; }
    if (cur) {
      const paragraph = !prev || prev.page !== l.page ? false : prev.y - l.y > 16;
      const sep = !raw[cur] ? '' : paragraph ? '\n' : ' ';
      raw[cur] = raw[cur] + sep + l.text;
      prev = l;
    }
  }

  const ttv = {};
  const ttvIssues = [];
  for (const k of Object.keys(TTV_RANGES)) {
    const v = num(raw[k]);
    if (v == null) { ttv[k] = null; continue; }
    const [lo, hi] = TTV_RANGES[k];
    if (v < lo || v > hi) { ttv[k] = null; ttvIssues.push(`${k}=${raw[k]}`); } else ttv[k] = v;
  }

  return {
    mr: (raw.mr || '').trim(),
    nama: clean(raw.nama),
    tanggal_pemeriksaan: dmyToYmd(raw.tanggal_pemeriksaan),
    dokter: clean(raw.dokter),
    keluhan: clean(raw.keluhan),
    anamnesa: clean(raw.anamnesa),
    subjective: clean(raw.subjective),
    objective: clean(raw.objective),
    assessment: clean(raw.assessment),
    plan: clean(raw.plan),
    asuhan_keperawatan: clean(raw.asuhan_keperawatan),
    jenis_kunjungan: clean(raw.jenis_kunjungan),
    ttv,
    ttv_issues: ttvIssues,
    diagnosa_kerja: clean(raw.diagnosa_kerja),
    icd10: icd10Start >= 0 ? parseIcdTable(lines, icd10Start, icd9Start >= 0 ? icd9Start : endIdx, 'icd10') : [],
    icd9: icd9Start >= 0 ? parseIcdTable(lines, icd9Start, endIdx, 'icd9') : [],
  };
}
