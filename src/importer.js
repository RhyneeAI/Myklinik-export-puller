import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { loadSqlReferenceData } from './sql-parser.js';
import { processPendaftaranRows } from './import-pendaftaran.js';
import { processKunjunganRows } from './import-kunjungan.js';

dotenv.config();

const OUTPUT_DIR = process.env.OUTPUT_DIR || 'output';
const SQL_REF_DIR = path.join(process.cwd(), 'sql-reference');
const SQL_OUTPUT_DIR = path.join(OUTPUT_DIR, 'sql');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function findJsonFiles(dirPath) {
  const results = [];
  if (!fs.existsSync(dirPath)) return results;

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...findJsonFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.json') && !entry.name.startsWith('.')) {
      results.push(fullPath);
    }
  }
  return results;
}

function extractPeriodFromFilename(filename) {
  const match = /(\d{4}_\d{2})/.exec(filename);
  return match ? match[1] : null;
}

const MAX_SQL_FILE_BYTES = 1024 * 1024; // 1MB per file, split into _partN.sql beyond this

// Packs statement groups into size-capped chunks without ever splitting a
// group apart (a kunjungan row's insert + its diagnosa/tindakan all share a
// single @kunjungan_id, so they must land in the same file/transaction).
function chunkGroupsBySize(groups, maxBytes) {
  const chunks = [];
  let current = [];
  let currentSize = 0;

  for (const group of groups) {
    const groupSize = Buffer.byteLength(group.join('\n\n'), 'utf-8') + 2;
    if (current.length > 0 && currentSize + groupSize > maxBytes) {
      chunks.push(current);
      current = [];
      currentSize = 0;
    }
    current.push(...group);
    currentSize += groupSize;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

// Writes `groups` as one or more `${baseName}.sql` / `${baseName}_partN.sql`
// files under `maxBytes`, each independently wrapped in its own transaction.
// Returns how many files were written.
function writeChunkedSql(dir, baseName, header, groups) {
  const chunks = chunkGroupsBySize(groups, MAX_SQL_FILE_BYTES);
  const multi = chunks.length > 1;
  chunks.forEach((statements, idx) => {
    const suffix = multi ? `_part${idx + 1}` : '';
    const partLabel = multi ? ` (part ${idx + 1}/${chunks.length})` : '';
    const filePath = path.join(dir, `${baseName}${suffix}.sql`);
    const content = `-- ${header}${partLabel}\nSTART TRANSACTION;\n\n` + statements.join('\n\n') + `\n\nCOMMIT;\n`;
    fs.writeFileSync(filePath, content, 'utf-8');
  });
  return chunks.length;
}

export async function runImport(log) {
  log.section('Step 1: Load SQL Reference Data');
  log.info('Parsing SQL dumps from sql-reference/...');
  const refData = loadSqlReferenceData(SQL_REF_DIR);
  log.success(`Reference data loaded: ${refData.desa.length} desa, ${refData.kecamatan.length} kec, ${refData.kota.length} kota, ${refData.kategoriPenyakit.length} diagnosa`);

  log.section('Step 2: Scanning Merged & JSON Files');
  ensureDir(SQL_OUTPUT_DIR);

  const pendaftaranDir = path.join(OUTPUT_DIR, 'pendaftaran');
  const kunjunganDir = path.join(OUTPUT_DIR, 'kunjungan');

  const pendaftaranJsonFiles = findJsonFiles(pendaftaranDir);
  const kunjunganJsonFiles = findJsonFiles(kunjunganDir);

  log.info(`Found ${pendaftaranJsonFiles.length} pendaftaran JSON files and ${kunjunganJsonFiles.length} kunjungan JSON files.`);

  // Group files by period (YYYY_MM)
  const periodMap = new Map();

  for (const f of pendaftaranJsonFiles) {
    const period = extractPeriodFromFilename(path.basename(f));
    if (period) {
      if (!periodMap.has(period)) periodMap.set(period, {});
      periodMap.get(period).pendaftaran = f;
    }
  }

  for (const f of kunjunganJsonFiles) {
    const period = extractPeriodFromFilename(path.basename(f));
    if (period) {
      if (!periodMap.has(period)) periodMap.set(period, {});
      // Prefer merged json files if available
      const existing = periodMap.get(period).kunjungan;
      if (!existing || f.includes('_merged.json')) {
        periodMap.get(period).kunjungan = f;
      }
    }
  }

  const periods = Array.from(periodMap.keys()).sort().reverse();
  log.info(`Processing ${periods.length} period(s)...`);

  const allRecapEntries = [];
  let totalPendaftaranSqlCount = 0;
  let totalKunjunganSqlCount = 0;

  log.section('Step 3: Generating SQL & Rollback Scripts');

  for (const [periodIdx, period] of periods.entries()) {
    const filePair = periodMap.get(period);
    const yearDir = path.join(SQL_OUTPUT_DIR, period.slice(0, 4));
    ensureDir(yearDir);

    let pendaftaranLookupMap = new Map();
    let pendaftaranNoList = [];

    // Process Pendaftaran
    if (filePair.pendaftaran) {
      const pFname = path.basename(filePair.pendaftaran);
      try {
        const rawJson = fs.readFileSync(filePair.pendaftaran, 'utf-8');
        const rows = JSON.parse(rawJson);

        const resP = processPendaftaranRows(rows, refData, pFname);
        pendaftaranLookupMap = resP.pendaftaranLookupMap;
        pendaftaranNoList = resP.noPendaftaranList;
        allRecapEntries.push(...resP.recapEntries);

        if (resP.insertSqls.length > 0) {
          const groups = resP.insertSqls.map((sql) => [sql]);
          const partCount = writeChunkedSql(yearDir, `${period}_pendaftaran`, `Pendaftaran SQL for ${period}`, groups);

          // Rollback SQL
          const rollbackFilePath = path.join(yearDir, `${period}_pendaftaran_rollback.sql`);
          const escapedNos = pendaftaranNoList.map((n) => "'" + n.replace(/'/g, "\\'") + "'").join(', ');
          const rollbackContent = `-- Rollback Pendaftaran for ${period}\nSTART TRANSACTION;\n\nDELETE FROM \`kk_pendaftaran\` WHERE \`no_pendaftaran\` IN (${escapedNos});\n\nCOMMIT;\n`;
          fs.writeFileSync(rollbackFilePath, rollbackContent, 'utf-8');

          totalPendaftaranSqlCount += resP.insertSqls.length;
          log.info(`  ✓ ${period} Pendaftaran: Generated ${resP.insertSqls.length} INSERTs${partCount > 1 ? ` (${partCount} files)` : ''}`);
        }
      } catch (err) {
        log.error(`  ✕ ${period} Pendaftaran failed: ${err.message}`);
      }
    }

    // Process Kunjungan
    if (filePair.kunjungan) {
      const kFname = path.basename(filePair.kunjungan);
      try {
        const rawJson = fs.readFileSync(filePair.kunjungan, 'utf-8');
        const rows = JSON.parse(rawJson);

        const resK = processKunjunganRows(rows, refData, pendaftaranLookupMap, kFname);
        allRecapEntries.push(...resK.recapEntries);

        if (resK.insertSqls.length > 0) {
          const partCount = writeChunkedSql(yearDir, `${period}_kunjungan`, `Kunjungan SQL for ${period}`, resK.sqlGroups);

          // Rollback SQL
          const rollbackFilePath = path.join(yearDir, `${period}_kunjungan_rollback.sql`);
          let rollbackContent = `-- Rollback Kunjungan for ${period}\nSTART TRANSACTION;\n\n`;

          if (pendaftaranNoList.length > 0) {
            const escapedNos = pendaftaranNoList.map((n) => "'" + n.replace(/'/g, "\\'") + "'").join(', ');
            rollbackContent += `DELETE FROM \`kk_pemeriksaan_tindakan\` WHERE \`id_kunjungan\` IN (SELECT id FROM \`kk_kunjungan\` WHERE \`id_pendaftaran\` IN (SELECT id FROM \`kk_pendaftaran\` WHERE \`no_pendaftaran\` IN (${escapedNos})));\n`;
            rollbackContent += `DELETE FROM \`kk_pemeriksaan_diagnosa\` WHERE \`id_kunjungan\` IN (SELECT id FROM \`kk_kunjungan\` WHERE \`id_pendaftaran\` IN (SELECT id FROM \`kk_pendaftaran\` WHERE \`no_pendaftaran\` IN (${escapedNos})));\n`;
            rollbackContent += `DELETE FROM \`kk_kunjungan\` WHERE \`id_pendaftaran\` IN (SELECT id FROM \`kk_pendaftaran\` WHERE \`no_pendaftaran\` IN (${escapedNos}));\n`;
          } else {
            rollbackContent += `-- Note: Run pendaftaran rollback first if needed\n`;
          }
          rollbackContent += `\nCOMMIT;\n`;

          fs.writeFileSync(rollbackFilePath, rollbackContent, 'utf-8');

          totalKunjunganSqlCount += resK.insertSqls.length;
          log.info(`  ✓ ${period} Kunjungan: Generated ${resK.insertSqls.length} SQL statements${partCount > 1 ? ` (${partCount} files)` : ''}`);
        }
      } catch (err) {
        log.error(`  ✕ ${period} Kunjungan failed: ${err.message}`);
      }
    }

    log.progressBar(periodIdx + 1, periods.length, period);
  }

  log.section('Step 4: Summary & Recap Report');

  // Generate import_recap.md
  const recapFilePath = path.join(SQL_OUTPUT_DIR, 'import_recap.md');
  let mdContent = `# Import Recap & Missing Field Report\n\n`;
  mdContent += `Generated at: ${new Date().toISOString()}\n\n`;

  if (allRecapEntries.length === 0) {
    mdContent += `All data mapped successfully without any missing lookup fields!\n`;
  } else {
    mdContent += `| Jenis | Dari File Mana | Nama | Field yang Kosong |\n`;
    mdContent += `|---|---|---|---|\n`;

    for (const item of allRecapEntries) {
      mdContent += `| ${item.jenis} | ${item.fileName} | ${item.nama} | ${item.missing} |\n`;
    }
  }

  fs.writeFileSync(recapFilePath, mdContent, 'utf-8');

  log.success(`Import complete!`);
  log.info(`Total SQL statements generated: ${totalPendaftaranSqlCount + totalKunjunganSqlCount}`);
  log.info(`SQL files and rollback scripts saved to: output/sql/{year}/`);
  log.info(`Recap report generated at: output/sql/import_recap.md (${allRecapEntries.length} unmatched entries)`);
}
