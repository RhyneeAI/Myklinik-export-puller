import {
  findMatchingPoli,
  findMatchingUser,
  findMatchingDiagnosa,
  findMatchingTindakan,
  isPlaceholder,
} from './sql-parser.js';
import { formatDateYMD } from './import-pendaftaran.js';

function escapeSqlStr(str) {
  if (str === null || str === undefined) return "''";
  return "'" + String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

export function processKunjunganRows(jsonRows, refData, pendaftaranLookupMap, sourceFileName) {
  const insertSqls = [];
  // Each row's statements (kunjungan insert + its diagnosa/tindakan, which
  // all reference the same @kunjungan_id) must stay together as a unit when
  // the output file later gets split by size -- so we track them as groups.
  const sqlGroups = [];
  const recapEntries = [];

  for (const row of jsonRows) {
    const rowGroup = [];
    const rawNo = row['__EMPTY'];
    const rawNama = row['__EMPTY_3'];

    // Filter non-data / header rows
    if (!rawNo || rawNo === 'No' || !rawNama || typeof rawNama !== 'string') {
      continue;
    }
    const reportVal = row['REPORT REKAP KUNJUNGAN'];
    if (reportVal === 'KLINIK' || reportVal === 'PERIODE' || reportVal === 'JENIS LAYANAN' || reportVal === 'MR') {
      continue;
    }

    const nama = rawNama.trim().toUpperCase();
    const tanggal = formatDateYMD(row['__EMPTY_1']);
    const rawNik = (row['__EMPTY_13'] || '').trim();
    const nikClean = rawNik !== '-' ? rawNik : '';
    const rawRegister = (row['__EMPTY_2'] || '').trim();

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

    // `Register` is the same number in both Pendaftaran and Kunjungan exports,
    // so it's the most reliable cross-reference key. NIK/Nama are fallbacks
    // for rows where the register number doesn't line up (e.g. edited records).
    let pendaftaranMeta = null;
    if (rawRegister) {
      pendaftaranMeta = pendaftaranLookupMap.get(`REG:${rawRegister}`);
    }
    if (!pendaftaranMeta && nikClean) {
      pendaftaranMeta = pendaftaranLookupMap.get(`NIK:${nikClean}`);
    }
    if (!pendaftaranMeta && nama) {
      pendaftaranMeta = pendaftaranLookupMap.get(`NAMA:${nama}`);
    }

    // Match Poli (Layanan). Kunjungan's own "Layanan" column only holds a
    // coarse category (RAWAT JALAN / PENUNJANG), not a poli name -- the real
    // poli lives on the matching Pendaftaran row, so we cross-reference it.
    const rawPoli = isPlaceholder(pendaftaranMeta?.poliVal) ? '' : (pendaftaranMeta?.poliVal || '').trim();
    const poliMatch = rawPoli ? recordMatch('layanan', rawPoli, findMatchingPoli(refData, rawPoli)) : null;
    const idLayanan = poliMatch ? poliMatch.id : 0;

    // Match Dokter
    const rawDokter = isPlaceholder(row['__EMPTY_6']) ? '' : (row['__EMPTY_6'] || '').trim();
    const dokterMatch = rawDokter ? recordMatch('dokter', rawDokter, findMatchingUser(refData, rawDokter)) : null;
    const idDokter = dokterMatch ? dokterMatch.id : 0;

    // Match User (Perawat from Pendaftaran)
    const perawatName = isPlaceholder(pendaftaranMeta?.perawatVal) ? '' : (pendaftaranMeta?.perawatVal || '');
    const perawatMatch = perawatName ? recordMatch('user perawat', perawatName, findMatchingUser(refData, perawatName)) : null;
    const idUser = perawatMatch ? perawatMatch.id : 0;

    // Subquery for id_pendaftaran
    const whereConds = [];
    if (nikClean) {
      whereConds.push(`no_identitas = ${escapeSqlStr(nikClean)}`);
    }
    if (nama) {
      whereConds.push(`nama = ${escapeSqlStr(nama)}`);
    }
    const subqueryPendaftaran = whereConds.length > 0
      ? `(SELECT id FROM \`kk_pendaftaran\` WHERE ${whereConds.join(' OR ')} ORDER BY id DESC LIMIT 1)`
      : '0';

    // Insert Kunjungan
    const sqlKunjungan = `INSERT INTO \`kk_kunjungan\` (\`id_pendaftaran\`, \`tanggal\`, \`waktu\`, \`id_antrian\`, \`prioritas\`, \`id_layanan\`, \`id_dokter\`, \`keluhan_awal\`, \`riwayat_peny_sekarang\`, \`id_user\`, \`id_perusahaan\`, \`ket\`, \`status_berobat\`, \`tipe_kunjungan\`, \`created\`) VALUES (${subqueryPendaftaran}, ${escapeSqlStr(tanggal)}, '00:00:00', 0, '1', ${idLayanan}, ${idDokter}, '', '', ${idUser}, 0, 'INPUT', 'Berobat', 'SAKIT', NOW());`;

    insertSqls.push(sqlKunjungan);
    insertSqls.push(`SET @kunjungan_id = LAST_INSERT_ID();`);
    rowGroup.push(sqlKunjungan, `SET @kunjungan_id = LAST_INSERT_ID();`);

    // Additional 1: Diagnosa (__EMPTY_7 or __EMPTY_8)
    const rawKodeDiagnosa = (row['__EMPTY_7'] || '').trim();
    const rawNamaDiagnosa = (row['__EMPTY_8'] || '').trim();
    const diagnosaTarget = rawKodeDiagnosa || rawNamaDiagnosa;

    if (diagnosaTarget) {
      const matched = recordMatch('diagnosa', diagnosaTarget, findMatchingDiagnosa(refData, diagnosaTarget));
      if (matched) {
        const sqlDiagnosa = `INSERT INTO \`kk_pemeriksaan_diagnosa\` (\`id_kunjungan\`, \`id_kategori_penyakit\`, \`jenis_diagnosa\`, \`user\`, \`id_perusahaan\`, \`ket\`, \`created\`) VALUES (@kunjungan_id, ${matched.id}, 'Diagnosa Utama', 0, 0, 'INPUT', NOW());`;
        insertSqls.push(sqlDiagnosa);
        rowGroup.push(sqlDiagnosa);
      }
    }

    // Additional 2: Tindakan (__EMPTY_9)
    const rawTindakan = (row['__EMPTY_9'] || '').trim();
    if (rawTindakan) {
      const items = rawTindakan.split('\n').map((s) => s.trim()).filter(Boolean);
      for (const item of items) {
        // "Pemeriksaan Dokter Umum" is billed per-doctor in the reference
        // (e.g. "Pemeriksaan Dokter Umum [dr. Catherine]"), but the visit
        // export doesn't always spell out the full name -- append the
        // visit's own Dokter field so the fuzzy match can pick the right one.
        const searchText = /^PEMERIKSAAN DOKTER UMUM/i.test(item) && rawDokter
          ? `${item} [${rawDokter}]`
          : item;
        const matched = recordMatch('tindakan', item, findMatchingTindakan(refData, searchText));
        if (matched) {
          const sqlTindakan = `INSERT INTO \`kk_pemeriksaan_tindakan\` (\`id_kunjungan\`, \`id_jenis_tindakan\`, \`id_icd9\`, \`perawat\`, \`qty\`, \`user\`, \`id_perusahaan\`, \`ket\`, \`id_bayar\`, \`total_bayar\`, \`status\`, \`created\`) VALUES (@kunjungan_id, ${matched.id}, 0, 0, 1, 0, 0, 'INPUT', 0, 0, 'AKTIF', NOW());`;
          insertSqls.push(sqlTindakan);
          rowGroup.push(sqlTindakan);
        }
      }
    }

    if (missingFields.length > 0) {
      recapEntries.push({
        jenis: 'kunjungan',
        fileName: sourceFileName,
        nama,
        missing: missingFields.join('; '),
      });
    }

    sqlGroups.push(rowGroup);
  }

  return {
    insertSqls,
    sqlGroups,
    recapEntries,
  };
}
