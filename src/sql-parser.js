import fs from 'fs';
import path from 'path';

// Scans forward from `from` for the statement-terminating ';', skipping any
// ';' that falls inside a quoted string (e.g. the literal ';' in "&amp;").
function findStatementEnd(str, from) {
  let inString = false;
  let quoteChar = '';
  let escaped = false;

  for (let i = from; i < str.length; i++) {
    const ch = str[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (inString) {
      if (ch === quoteChar) {
        if (str[i + 1] === quoteChar) {
          i++; // doubled-quote escape, e.g. ''
          continue;
        }
        inString = false;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      inString = true;
      quoteChar = ch;
      continue;
    }
    if (ch === ';') return i;
  }
  return str.length;
}

function parseInsertStatements(sqlContent) {
  const rows = [];
  const headerRegex = /INSERT INTO\s+`?(\w+)`?\s*\(([^)]+)\)\s*VALUES\s*/gi;
  let headerMatch;

  while ((headerMatch = headerRegex.exec(sqlContent)) !== null) {
    const columns = headerMatch[2].split(',').map((c) => c.trim().replace(/`/g, ''));
    const start = headerRegex.lastIndex;
    const end = findStatementEnd(sqlContent, start);
    const valuesBlock = sqlContent.slice(start, end);
    headerRegex.lastIndex = end;

    // Parse tuple values like (1, 'val', ...), (2, 'val2', ...)
    const tupleRegex = /\((.*?)\)(?=\s*(?:,|\s*$))/gs;
    let tupleMatch;

    while ((tupleMatch = tupleRegex.exec(valuesBlock)) !== null) {
      const rawValues = tupleMatch[1];
      const parsedValues = parseSqlTupleValues(rawValues);

      if (parsedValues.length === columns.length) {
        const row = {};
        for (let i = 0; i < columns.length; i++) {
          row[columns[i]] = parsedValues[i];
        }
        rows.push(row);
      }
    }
  }

  return rows;
}

function parseSqlTupleValues(str) {
  const values = [];
  let current = '';
  let inString = false;
  let quoteChar = '';
  let escaped = false;

  for (let i = 0; i < str.length; i++) {
    const char = str[i];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (inString) {
      if (char === quoteChar) {
        // Handle double quote escape in SQL ''
        if (i + 1 < str.length && str[i + 1] === quoteChar) {
          current += quoteChar;
          i++;
        } else {
          inString = false;
        }
      } else {
        current += char;
      }
    } else {
      if (char === "'" || char === '"') {
        inString = true;
        quoteChar = char;
      } else if (char === ',') {
        values.push(cleanVal(current));
        current = '';
      } else {
        current += char;
      }
    }
  }

  values.push(cleanVal(current));
  return values;
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function cleanVal(v) {
  const trimmed = v.trim();
  if (trimmed.toUpperCase() === 'NULL') return null;
  return decodeHtmlEntities(trimmed);
}

const DEFAULT_AGAMA_MAP = {
  ISLAM: 1,
  PROTESTAN: 2,
  KRISTEN: 2,
  KATOLIK: 3,
  HINDU: 4,
  BUDDHA: 5,
  KHONGHUCU: 6,
  'LAIN-LAIN': 72,
  LAINNYA: 72,
};

export function loadSqlReferenceData(sqlRefDir) {
  const ref = {
    kategoriAgama: { ...DEFAULT_AGAMA_MAP },
    kota: [],
    kecamatan: [],
    desa: [],
    poli: [],
    users: [],
    kategoriPenyakit: [],
    jenisTindakan: [],
  };

  const readSql = (fileName) => {
    const fp = path.join(sqlRefDir, fileName);
    if (fs.existsSync(fp)) {
      return fs.readFileSync(fp, 'utf-8');
    }
    return '';
  };

  // Load kk_kategori
  const katContent = readSql('kk_kategori.sql');
  if (katContent) {
    const rows = parseInsertStatements(katContent);
    for (const r of rows) {
      if ((r.type || '').toUpperCase() === 'AGAMA' && r.nama && r.id) {
        ref.kategoriAgama[r.nama.trim().toUpperCase()] = parseInt(r.id, 10);
      }
    }
  }

  // Load kk_kota
  const kotaContent = readSql('kk_kota.sql');
  if (kotaContent) {
    const rows = parseInsertStatements(kotaContent);
    for (const r of rows) {
      if (r.nama && r.id) {
        ref.kota.push({ id: parseInt(r.id, 10), nama: r.nama.trim().toUpperCase() });
      }
    }
  }

  // Load kk_kecamatan
  const kecContent = readSql('kk_kecamatan.sql');
  if (kecContent) {
    const rows = parseInsertStatements(kecContent);
    for (const r of rows) {
      if (r.nama && r.id) {
        ref.kecamatan.push({ id: parseInt(r.id, 10), nama: r.nama.trim().toUpperCase() });
      }
    }
  }

  // Load kk_desa
  const desaContent = readSql('kk_desa.sql');
  if (desaContent) {
    const rows = parseInsertStatements(desaContent);
    for (const r of rows) {
      if (r.nama && r.id) {
        ref.desa.push({ id: parseInt(r.id, 10), nama: r.nama.trim().toUpperCase() });
      }
    }
  }

  // Load kk_poli (skip TIDAK AKTIF so an exact name match can't resolve to a retired poli)
  const poliContent = readSql('kk_poli.sql');
  if (poliContent) {
    const rows = parseInsertStatements(poliContent);
    for (const r of rows) {
      if (r.nama && r.id && (r.status || '').trim().toUpperCase() === 'AKTIF') {
        ref.poli.push({ id: parseInt(r.id, 10), nama: r.nama.trim().toUpperCase() });
      }
    }
  }

  // Load kk_users
  const userContent = readSql('kk_users.sql');
  if (userContent) {
    const rows = parseInsertStatements(userContent);
    for (const r of rows) {
      if (r.id) {
        ref.users.push({
          id: parseInt(r.id, 10),
          nama_lengkap: (r.nama_lengkap || '').trim().toUpperCase(),
          nama_panggilan: (r.nama_panggilan || '').trim().toUpperCase(),
        });
      }
    }
  }

  // Load kk_kategori_penyakit
  const diagnosaContent = readSql('kk_kategori_penyakit.sql');
  if (diagnosaContent) {
    const rows = parseInsertStatements(diagnosaContent);
    for (const r of rows) {
      if (r.kode && r.id) {
        ref.kategoriPenyakit.push({
          id: parseInt(r.id, 10),
          kode: r.kode.trim().toUpperCase(),
          nama: (r.nama || '').trim().toUpperCase(),
        });
      }
    }
  }

  // Load kk_jenis_tindakan
  const tindakanContent = readSql('kk_jenis_tindakan.sql');
  if (tindakanContent) {
    const rows = parseInsertStatements(tindakanContent);
    for (const r of rows) {
      if (r.nama && r.id) {
        ref.jenisTindakan.push({
          id: parseInt(r.id, 10),
          nama: r.nama.trim().toUpperCase(),
        });
      }
    }
  }

  ref.kotaByTight = buildTightIndex(ref.kota, (it) => stripAdminPrefix(it.nama));
  ref.kecamatanByTight = buildTightIndex(ref.kecamatan, (it) => stripAdminPrefix(it.nama));
  ref.desaByTight = buildTightIndex(ref.desa, (it) => stripAdminPrefix(it.nama));
  ref.poliByTight = buildTightIndex(ref.poli, (it) => it.nama);
  ref.tindakanByTight = buildTightIndex(ref.jenisTindakan, (it) => it.nama);
  ref.kategoriPenyakitByTight = buildTightIndex(ref.kategoriPenyakit, (it) => it.nama);
  ref.usersByTight = new Map();
  for (const u of ref.users) {
    for (const cand of [u.nama_panggilan, u.nama_lengkap]) {
      if (!cand) continue;
      const key = tightKey(stripGelar(cand));
      if (key && !ref.usersByTight.has(key)) ref.usersByTight.set(key, u);
    }
  }

  return ref;
}

// ─── Matching Helpers ───────────────────────────────────────────
// Every findMatching* returns either null (no candidates existed at all) or
// { id, label, score, exact, applied } — score is 1 for a normalized exact
// match, otherwise a 0..1 Dice-coefficient similarity for the single closest
// candidate, whether or not it cleared FUZZY_THRESHOLD. `applied` says
// whether `id` is safe to use in generated SQL: true for exact matches and
// fuzzy matches that cleared the threshold; false means the candidate is
// only there to help a human figure out what the raw value should map to --
// `id` should NOT be used in that case (callers use 0/NULL instead).

const FUZZY_THRESHOLD = 0.55;

const ADMIN_PREFIX_RE = /^(KABUPATEN|KAB\.?|KOTA ADM\.?|KOTA|KECAMATAN|KEC\.?|KELURAHAN|KEL\.?|DESA)\s+/;
const GELAR_PREFIX_RE = /^(DR|DRG)\.?\s+/;

function normalizeLoose(str) {
  // decode twice: the source export sometimes double-encodes ("&amp;amp;")
  const decoded = decodeHtmlEntities(decodeHtmlEntities((str || '').toString()));
  return decoded.trim().toUpperCase().replace(/\s+/g, ' ');
}

function tightKey(str) {
  return str.replace(/[^A-Z0-9]/g, '');
}

function stripAdminPrefix(str) {
  return str.replace(ADMIN_PREFIX_RE, '');
}

function stripGelar(str) {
  return str.replace(GELAR_PREFIX_RE, '');
}

function bigrams(str) {
  const out = [];
  for (let i = 0; i < str.length - 1; i++) out.push(str.substring(i, i + 2));
  return out;
}

function diceCoefficient(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const bgA = bigrams(a);
  const bgB = bigrams(b);
  if (bgA.length === 0 || bgB.length === 0) return 0;
  const pool = new Map();
  for (const bg of bgB) pool.set(bg, (pool.get(bg) || 0) + 1);
  let matches = 0;
  for (const bg of bgA) {
    const count = pool.get(bg) || 0;
    if (count > 0) {
      matches++;
      pool.set(bg, count - 1);
    }
  }
  return (2 * matches) / (bgA.length + bgB.length);
}

// Finds the single closest candidate regardless of FUZZY_THRESHOLD -- the
// threshold is applied by callers (it decides `applied`, not whether a
// candidate is returned at all).
function bestFuzzyMatch(candidates, targetLoose, getLoose) {
  let best = null;
  let bestScore = 0;
  for (const c of candidates) {
    const score = diceCoefficient(targetLoose, getLoose(c));
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best ? { item: best, score: bestScore } : null;
}

function buildTightIndex(list, getLoose) {
  const map = new Map();
  for (const item of list) {
    const key = tightKey(getLoose(item));
    if (key && !map.has(key)) map.set(key, item);
  }
  return map;
}

// The source export uses these as "not filled in" placeholders (e.g. a
// dash for an unrecorded nurse, "- NOT SET -" for an unset kelurahan) --
// they represent legitimately empty data, not a lookup that failed.
export function isPlaceholder(raw) {
  if (!raw) return true;
  const clean = raw.toString().trim().toUpperCase().replace(/\s+/g, ' ');
  return clean === '' || clean === '-' || clean === '- NOT SET -' || clean === 'NOT SET';
}

export function findMatchingAgama(ref, agamaStr) {
  if (!agamaStr) return null;
  const clean = normalizeLoose(agamaStr);
  if (ref.kategoriAgama[clean] != null) {
    return { id: ref.kategoriAgama[clean], label: clean, score: 1, exact: true, applied: true };
  }
  let best = null;
  let bestScore = 0;
  for (const [k, id] of Object.entries(ref.kategoriAgama)) {
    const score = diceCoefficient(clean, k);
    if (score > bestScore) {
      bestScore = score;
      best = { k, id };
    }
  }
  if (!best) return null;
  const applied = bestScore >= FUZZY_THRESHOLD;
  return { id: best.id, label: best.k, score: bestScore, exact: false, applied };
}

function matchLocation(list, tightIndex, raw) {
  if (!raw) return null;
  const loose = stripAdminPrefix(normalizeLoose(raw));
  const exact = tightIndex.get(tightKey(loose));
  if (exact) return { id: exact.id, label: exact.nama, score: 1, exact: true, applied: true };
  const best = bestFuzzyMatch(list, loose, (it) => stripAdminPrefix(it.nama));
  if (!best) return null;
  const applied = best.score >= FUZZY_THRESHOLD;
  return { id: best.item.id, label: best.item.nama, score: best.score, exact: false, applied };
}

export function findMatchingKota(ref, kotaStr) {
  return matchLocation(ref.kota, ref.kotaByTight, kotaStr);
}

export function findMatchingKecamatan(ref, kecStr) {
  return matchLocation(ref.kecamatan, ref.kecamatanByTight, kecStr);
}

export function findMatchingDesa(ref, desaStr) {
  return matchLocation(ref.desa, ref.desaByTight, desaStr);
}

export function findMatchingPoli(ref, poliStr) {
  if (!poliStr) return null;
  const loose = normalizeLoose(poliStr);
  const exact = ref.poliByTight.get(tightKey(loose));
  if (exact) return { id: exact.id, label: exact.nama, score: 1, exact: true, applied: true };
  const best = bestFuzzyMatch(ref.poli, loose, (it) => it.nama);
  if (!best) return null;
  const applied = best.score >= FUZZY_THRESHOLD;
  return { id: best.item.id, label: best.item.nama, score: best.score, exact: false, applied };
}

export function findMatchingUser(ref, nameStr) {
  if (!nameStr) return null;
  const loose = stripGelar(normalizeLoose(nameStr));
  const exact = ref.usersByTight.get(tightKey(loose));
  if (exact) {
    return { id: exact.id, label: exact.nama_lengkap || exact.nama_panggilan, score: 1, exact: true, applied: true };
  }
  let best = null;
  let bestScore = 0;
  for (const u of ref.users) {
    for (const cand of [u.nama_panggilan, u.nama_lengkap]) {
      if (!cand) continue;
      const score = diceCoefficient(loose, stripGelar(cand));
      if (score > bestScore) {
        bestScore = score;
        best = u;
      }
    }
  }
  if (!best) return null;
  const applied = bestScore >= FUZZY_THRESHOLD;
  return { id: best.id, label: best.nama_lengkap || best.nama_panggilan, score: bestScore, exact: false, applied };
}

export function findMatchingDiagnosa(ref, kodeOrNama) {
  if (!kodeOrNama) return null;
  const clean = normalizeLoose(kodeOrNama);
  const cleanNoDot = clean.replace(/\.$/, '');
  const byKode = ref.kategoriPenyakit.find(
    (d) => d.kode === clean || d.kode.replace(/\.$/, '') === cleanNoDot
  );
  if (byKode) return { id: byKode.id, label: byKode.kode, score: 1, exact: true, applied: true };
  const exactNama = ref.kategoriPenyakitByTight.get(tightKey(clean));
  if (exactNama) return { id: exactNama.id, label: exactNama.nama, score: 1, exact: true, applied: true };
  const best = bestFuzzyMatch(ref.kategoriPenyakit, clean, (d) => d.nama);
  if (!best) return null;
  const applied = best.score >= FUZZY_THRESHOLD;
  return { id: best.item.id, label: best.item.nama, score: best.score, exact: false, applied };
}

export function findMatchingTindakan(ref, tindakanStr) {
  if (!tindakanStr) return null;
  const loose = normalizeLoose(tindakanStr);
  const exact = ref.tindakanByTight.get(tightKey(loose));
  if (exact) return { id: exact.id, label: exact.nama, score: 1, exact: true, applied: true };
  const best = bestFuzzyMatch(ref.jenisTindakan, loose, (t) => t.nama);
  if (!best) return null;
  const applied = best.score >= FUZZY_THRESHOLD;
  return { id: best.item.id, label: best.item.nama, score: best.score, exact: false, applied };
}
