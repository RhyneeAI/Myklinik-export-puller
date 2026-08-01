import {
  findMatchingAgama,
  findMatchingKota,
  findMatchingKecamatan,
  findMatchingDesa,
  isPlaceholder,
} from './sql-parser.js';

export function formatDateYMD(dStr) {
  if (!dStr) return '0000-00-00';
  const clean = dStr.trim();
  const parts = clean.split('-');
  if (parts.length === 3) {
    const [d, m, y] = parts;
    if (y.length === 4) {
      return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }
  }
  return clean;
}

export function parseJenisKelamin(jkStr) {
  if (!jkStr) return '1';
  const u = jkStr.trim().toUpperCase();
  if (u.includes('PEREMPUAN') || u === '2') return '2';
  if (u.includes('LAKI') || u === '1') return '1';
  if (u.includes('TIDAK DITENTUKAN') || u === '3') return '3';
  if (u.includes('TIDAK MENGISI') || u === '4') return '4';
  return '1';
}

function escapeSqlStr(str) {
  if (str === null || str === undefined) return "''";
  return "'" + String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

const PENDAFTARAN_COLUMNS = '`nama`, `no_pendaftaran`, `no_register_keluarga`, `jenis_pasien`, `tanggal`, `jam`, `no_identitas`, `pendidikan`, `jenis_kelamin`, `gol_darah`, `bantuan_pemerintah`, `kelas_bpjs`, `hub_keluarga_peserta`, `prolanis`, `prb`, `agama`, `tanggal_lahir`, `place_of_birth`, `telpon`, `kota`, `kecamatan`, `desa`, `alamat`, `nomor_status`, `terakhir_ubah_identitas`, `ket`, `user`, `id_perusahaan`, `created`, `hash_id`';

// Rows with no id-linkage dependency between them, so they can safely be
// packed many-per-statement instead of one INSERT per row.
const BATCH_SIZE = 500;

function batchInserts(table, columns, valueTuples, batchSize = BATCH_SIZE) {
  const statements = [];
  for (let i = 0; i < valueTuples.length; i += batchSize) {
    const chunk = valueTuples.slice(i, i + batchSize);
    statements.push(`INSERT INTO \`${table}\` (${columns}) VALUES\n${chunk.join(',\n')};`);
  }
  return statements;
}

export function processPendaftaranRows(jsonRows, refData, sourceFileName) {
  const valueTuples = [];
  const noPendaftaranList = [];
  const recapEntries = [];
  const pendaftaranLookupMap = new Map(); // nik or nama -> pendaftaran row data

  for (const row of jsonRows) {
    const rawNo = row['__EMPTY'];
    const rawNama = row['__EMPTY_5'];

    // Header filter: skip header / non-data rows
    if (!rawNo || rawNo === 'PERIODE' || rawNo === 'Register' || rawNo === 'No') {
      continue;
    }
    if (row['REPORT PENDAFTARAN PASIEN HARIAN'] === 'No' || !rawNama) {
      continue;
    }

    const noPendaftaran = String(rawNo).trim();
    const nama = String(rawNama).trim().toUpperCase();
    const tanggal = formatDateYMD(row['__EMPTY_1']);
    const jam = (row['__EMPTY_2'] || '00:00:00').trim();
    const noIdentitas = (row['__EMPTY_15'] || '').trim();
    const telpon = (row['__EMPTY_16'] || '').trim();
    const jkCode = parseJenisKelamin(row['__EMPTY_17']);
    const rawPob = (row['__EMPTY_18'] || '').trim().toUpperCase();
    const tanggalLahir = formatDateYMD(row['__EMPTY_19']);
    const alamat = (row['__EMPTY_21'] || '').trim();
    const nomorStatus = (row['__EMPTY_23'] || '').trim();
    const jenisPasien = (row['__EMPTY_10'] || 'BARU').trim().toUpperCase();
    const perawatVal = (row['__EMPTY_9'] || '').trim();
    const poliVal = (row['__EMPTY_7'] || '').trim();

    const missingFields = [];

    // Logs a recap entry as needed and returns the match if (and only if)
    // it's safe to use in the generated SQL:
    //  - no candidate at all              -> "field (raw)"
    //  - candidate too weak to apply      -> "field (raw -> closest: X, score, TIDAK DIPAKAI)", id NOT used
    //  - applied but not exact, score<=.95 -> "field (raw -> X, score)", id used
    //  - applied and (exact or score>.95)  -> silent, id used
    const recordMatch = (label, raw, match) => {
      if (!match) {
        missingFields.push(`${label} (${raw})`);
        return null;
      }
      if (!match.applied) {
        missingFields.push(`${label} (${raw} -> closest: ${match.label}, score ${match.score.toFixed(2)}, TIDAK DIPAKAI)`);
        return null;
      }
      if (!match.exact && match.score <= 0.95) {
        missingFields.push(`${label} (${raw} -> ${match.label}, score ${match.score.toFixed(2)})`);
      }
      return match;
    };

    // Match Agama
    const rawAgama = (row['__EMPTY_6'] || '').trim();
    const agamaMatch = rawAgama ? recordMatch('agama', rawAgama, findMatchingAgama(refData, rawAgama)) : null;
    const agamaId = agamaMatch ? agamaMatch.id : 0;

    // Match Kota
    const rawKota = isPlaceholder(row['__EMPTY_14']) ? '' : (row['__EMPTY_14'] || '').trim();
    const kotaObj = rawKota ? recordMatch('kota', rawKota, findMatchingKota(refData, rawKota)) : null;

    // Match Kecamatan
    const rawKec = isPlaceholder(row['__EMPTY_13']) ? '' : (row['__EMPTY_13'] || '').trim();
    const kecObj = rawKec ? recordMatch('kecamatan', rawKec, findMatchingKecamatan(refData, rawKec)) : null;

    // Match Desa
    const rawDesa = isPlaceholder(row['__EMPTY_12']) ? '' : (row['__EMPTY_12'] || '').trim();
    const desaObj = rawDesa ? recordMatch('desa', rawDesa, findMatchingDesa(refData, rawDesa)) : null;

    // Handle place_of_birth
    let placeOfBirth = rawPob;
    if (rawPob === 'JAKARTA' && kotaObj) {
      placeOfBirth = kotaObj.label;
    }

    if (missingFields.length > 0) {
      recapEntries.push({
        jenis: 'pendaftaran',
        fileName: sourceFileName,
        nama,
        missing: missingFields.join('; '),
      });
    }

    noPendaftaranList.push(noPendaftaran);

    // Save into lookup map for Kunjungan cross-referencing.
    // `Register` is the same number in both the Pendaftaran and Kunjungan
    // exports, so it's a reliable exact key -- prefer it over NIK/Nama,
    // which are kept only as fallbacks for rows where it doesn't line up.
    const recordMeta = { noPendaftaran, noIdentitas, nama, perawatVal, poliVal };
    pendaftaranLookupMap.set(`REG:${noPendaftaran}`, recordMeta);
    if (noIdentitas && noIdentitas !== '-') {
      pendaftaranLookupMap.set(`NIK:${noIdentitas}`, recordMeta);
    }
    if (nama) {
      pendaftaranLookupMap.set(`NAMA:${nama}`, recordMeta);
    }

    const tuple = `(${escapeSqlStr(nama)}, ${escapeSqlStr(noPendaftaran)}, '', ${escapeSqlStr(jenisPasien)}, ${escapeSqlStr(tanggal)}, ${escapeSqlStr(jam)}, ${escapeSqlStr(noIdentitas)}, '', ${escapeSqlStr(jkCode)}, '', 'TIDAK', '', '', '', '', ${agamaId}, ${escapeSqlStr(tanggalLahir)}, ${escapeSqlStr(placeOfBirth)}, ${escapeSqlStr(telpon)}, ${kotaObj ? kotaObj.id : 'NULL'}, ${kecObj ? kecObj.id : 'NULL'}, ${desaObj ? desaObj.id : 'NULL'}, ${escapeSqlStr(alamat)}, ${escapeSqlStr(nomorStatus)}, NOW(), 'INPUT', 0, 0, NOW(), '')`;

    valueTuples.push(tuple);
  }

  const insertSqls = batchInserts('kk_pendaftaran', PENDAFTARAN_COLUMNS, valueTuples);

  return {
    insertSqls,
    rowCount: valueTuples.length,
    noPendaftaranList,
    recapEntries,
    pendaftaranLookupMap,
  };
}
