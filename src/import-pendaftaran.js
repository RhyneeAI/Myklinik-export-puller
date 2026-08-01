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

export function processPendaftaranRows(jsonRows, refData, sourceFileName) {
  const insertSqls = [];
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

    // A fuzzy (non-exact) match still resolves the id, but is flagged for
    // manual review since it's a best-effort guess, not a confirmed match.
    // Very high-confidence fuzzy matches (>0.95, e.g. just a punctuation/
    // casing difference) aren't worth a human's time, so they're left out.
    const flagIfFuzzy = (label, raw, match) => {
      if (match && !match.exact && match.score <= 0.95) {
        missingFields.push(`${label} (${raw} -> ${match.label}, score ${match.score.toFixed(2)})`);
      }
    };

    // Match Agama
    const rawAgama = (row['__EMPTY_6'] || '').trim();
    let agamaId = 0;
    if (rawAgama) {
      const matched = findMatchingAgama(refData, rawAgama);
      if (matched) {
        agamaId = matched.id;
        flagIfFuzzy('agama', rawAgama, matched);
      } else {
        missingFields.push(`agama (${rawAgama})`);
      }
    }

    // Match Kota
    const rawKota = isPlaceholder(row['__EMPTY_14']) ? '' : (row['__EMPTY_14'] || '').trim();
    let kotaObj = null;
    if (rawKota) {
      kotaObj = findMatchingKota(refData, rawKota);
      if (kotaObj) flagIfFuzzy('kota', rawKota, kotaObj);
      else missingFields.push(`kota (${rawKota})`);
    }

    // Match Kecamatan
    const rawKec = isPlaceholder(row['__EMPTY_13']) ? '' : (row['__EMPTY_13'] || '').trim();
    let kecObj = null;
    if (rawKec) {
      kecObj = findMatchingKecamatan(refData, rawKec);
      if (kecObj) flagIfFuzzy('kecamatan', rawKec, kecObj);
      else missingFields.push(`kecamatan (${rawKec})`);
    }

    // Match Desa
    const rawDesa = isPlaceholder(row['__EMPTY_12']) ? '' : (row['__EMPTY_12'] || '').trim();
    let desaObj = null;
    if (rawDesa) {
      desaObj = findMatchingDesa(refData, rawDesa);
      if (desaObj) flagIfFuzzy('desa', rawDesa, desaObj);
      else missingFields.push(`desa (${rawDesa})`);
    }

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

    const sql = `INSERT INTO \`kk_pendaftaran\` (\`nama\`, \`no_pendaftaran\`, \`no_register_keluarga\`, \`jenis_pasien\`, \`tanggal\`, \`jam\`, \`no_identitas\`, \`pendidikan\`, \`jenis_kelamin\`, \`gol_darah\`, \`bantuan_pemerintah\`, \`kelas_bpjs\`, \`hub_keluarga_peserta\`, \`prolanis\`, \`prb\`, \`agama\`, \`tanggal_lahir\`, \`place_of_birth\`, \`telpon\`, \`kota\`, \`kecamatan\`, \`desa\`, \`alamat\`, \`nomor_status\`, \`terakhir_ubah_identitas\`, \`ket\`, \`user\`, \`id_perusahaan\`, \`created\`, \`hash_id\`) VALUES (${escapeSqlStr(nama)}, ${escapeSqlStr(noPendaftaran)}, '', ${escapeSqlStr(jenisPasien)}, ${escapeSqlStr(tanggal)}, ${escapeSqlStr(jam)}, ${escapeSqlStr(noIdentitas)}, '', ${escapeSqlStr(jkCode)}, '', 'TIDAK', '', '', '', '', ${agamaId}, ${escapeSqlStr(tanggalLahir)}, ${escapeSqlStr(placeOfBirth)}, ${escapeSqlStr(telpon)}, ${kotaObj ? kotaObj.id : 'NULL'}, ${kecObj ? kecObj.id : 'NULL'}, ${desaObj ? desaObj.id : 'NULL'}, ${escapeSqlStr(alamat)}, ${escapeSqlStr(nomorStatus)}, NOW(), 'INPUT', 0, 0, NOW(), '');`;

    insertSqls.push(sql);
  }

  return {
    insertSqls,
    noPendaftaranList,
    recapEntries,
    pendaftaranLookupMap,
  };
}
