# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Node.js (ESM) CLI tool with three modes, chosen interactively on `npm start`:

- **EXPORT** — drives a real Chrome browser (via Playwright) against `apps.myklinik.id`, a clinic SPA, to pull **Pendaftaran** (patient registration) and **Kunjungan** (visit) reports as Excel + JSON.
- **IMPORT** — reads the JSON exported above, cross-references it against reference tables dumped from the production MySQL database (`sql-reference/*.sql`), and generates `INSERT`/rollback SQL files to load that data into the clinic's database.
- **MERGED KUNJUNGAN** — repair/backfill for Kunjungan monthly merge files (`src/merge-kunjungan.js`): moves `_merged` files that older code wrote into `kunjungan/{YYYY}/` over to `kunjungan/merged/`, and merges months whose daily files are complete but were never merged. It is idempotent, and it skips months that still have missing days.

The modes are independent pipelines that only share the `output/` directory as a handoff point. User-facing strings, prompts, and the README are in Indonesian.

## Commands

```bash
npm install       # install dependencies
npm start         # runs src/index.js, prompts for EXPORT / IMPORT / MERGED KUNJUNGAN
npm run backup    # separate tool: Master Data → Download Data (see BACKUP below)
```

There is no build step, lint config, or test suite. For verification, use `node --check <file>` for syntax, then run the relevant mode against existing `output/` data. IMPORT and MERGED KUNJUNGAN need no browser or network, so you can re-run them freely.

- `ACTION=EXPORT|IMPORT|MERGE_KUNJUNGAN` skips the interactive prompt.
- `PLAYWRIGHT_HEADLESS=false` runs the browser headed so you can debug automation.
- Playwright uses the `chrome` channel (installed Google Chrome, not bundled Chromium; see `src/browser.js`). `npx playwright install` is not needed.

## Configuration (`.env`)

Copy `.env.example` to `.env`. The key variables:

- `APP_TARGET` — prefix for output filenames (also used in the filename regexes in `merge-kunjungan.js`).
- `ENDPOINT_URL`, `OUTPUT_DIR` (default `output`).
- `START_DATE` / `END_DATE` (`YYYY-MM`) — export walks backwards from `START_DATE` to `END_DATE`, so `START_DATE` must be the newer month.
- `MODE` — `pendaftaran`, `kunjungan`, or `all` (EXPORT only).
- `REQUEST_DELAY_MS` / `MAX_RETRIES` — scraper throttling/retry.
- Auth: either `LOGIN_KEY`/`LOGIN_USER`/`LOGIN_PASS` (auto re-login when the session expires mid-run), or captured cookies (`COOKIES_JSON`, or individual `SERVERID`/`SOKKACREATIVEID`/`TOKEN`/`SESSION_NAME`/`SESSION_VALUE`/`KEY1`-`KEY4`).

## EXPORT pipeline architecture

`src/index.js` is the orchestrator. It parses the `.env` date range, launches a persistent Chrome context (`src/browser.js`), runs Pendaftaran then Kunjungan sequentially (each owns a single `page` for its whole run), verifies the expected output files exist, and prints a summary.

- `src/browser.js` — `chromium.launchPersistentContext` with a throwaway temp profile dir, seeded with cookies from `.env` if provided. `close()` also deletes the temp profile.
- `src/pendaftaran.js` / `src/kunjungan.js` — near-identical scraping logic. The duplication is intentional, so don't extract a shared module. Each one:
  1. navigates the SPA to the report page via `page.evaluate` DOM clicks (the SPA has no real URL routing for these views),
  2. detects session expiry and fills the login modal (`#ckeyKlinik`/`#cUser`/`#cPassword`/`#cCaptcha`),
  3. fills `#cDateStart`/`#cDateEnd` and clicks "Cari",
  4. clicks Export and captures the Playwright `download` event, saving the `.xlsx` unmodified,
  5. parses the same buffer into JSON via `xlsx` and writes a sibling `.json`.
  - Pendaftaran iterates **month by month** (newest → oldest). Kunjungan iterates **day by day**, merges each completed month into `kunjungan/merged/..._{YYYY}_{MM}_merged`, and at the end writes an all-time `_ALL_merged` file.
  - Both guard against the server returning HTML instead of Excel (rate limiting, session expiry, 500s). `looksLikeHTML`/`summarizeHtml` in `src/utils.js` detect this and trigger a retry. A login page instead triggers a hard stop, because re-login is handled by the outer retry loop.
- `src/progress.js` — checkpoint at `output/.progress.json` with a `cursor` (last completed `YYYY_MM` for Pendaftaran, `YYYY_MM_DD` for Kunjungan) so a crashed or interrupted run resumes. Cursor comparison is lexical string comparison, which works only because runs always walk newer → older.
- `src/logger.js` — hand-rolled ANSI/box-drawing output, including `progressBar`. There is no logging library.

## BACKUP tool (`npm run backup`, `src/backup.js`)

This is a separate entry point, not one of the `npm start` modes. It pulls everything on Master Data → Download Data (`#masterdata/upload/upload`), which needs an account with access to that menu. It reads the catalog from the page's onclick attributes, so the ranges and types aren't hard-coded: `scDownLoadMR(start,end)` for Data Pasien ranges, `scDownLoadMRBackup(id)` for Rekam Medis types. It then GETs the same URL the button's hidden iframe would load, `sc.excelme.php?scRpt=masterdata/upload/{medicalrecord|backupdata}&...`, through `page.request` (which shares the session cookies). `cdate` is formatted by the page's own `#cDateMonth` datepicker (e.g. `Aug-2026`).

- **Download window:** the vendor only allows downloads 21:00–06:00 WIB. The page checks this only in client-side JS, but the tool deliberately honours it (`canStartDownload()`, computed in UTC+7 regardless of the PC's timezone), so don't remove or work around that guard. Outside the window the tool waits for 21:00, and it resumes automatically the next night.
- **Resume:** a task is done when its `.json` exists. Files are written via `.part` then renamed.
- **Login:** the captcha text loads by XHR about 1s after the login form appears, so `login()` waits for `#captcha` to be non-empty before submitting. `pendaftaran.js`/`kunjungan.js` read it without waiting and only get away with it because of their fixed sleeps.
- `--dry-run` logs in and lists the plan, including a sample URL. It works at any hour.

## IMPORT pipeline architecture

The entry point is `runImport()` in `src/importer.js`.

1. `src/sql-parser.js` regex-parses phpMyAdmin-style `INSERT INTO ... VALUES (...), (...);` dumps in `sql-reference/` into in-memory lookup data. There is no DB connection. The tables used for lookup are `kk_kota`, `kk_kecamatan`, `kk_desa`, `kk_poli`, `kk_users`, `kk_kategori` (agama), `kk_kategori_penyakit` (ICD-10), and `kk_jenis_tindakan`.
   - Every `findMatching*` returns `null` or `{ id, label, score, exact, applied }`. Matching tries a normalized exact match first (HTML entities are decoded twice because the source double-encodes them; admin prefixes like `KAB.`/`KECAMATAN` and titles like `DR.` are stripped), then falls back to the best Dice-coefficient bigram candidate.
   - `applied` is true only for exact matches or fuzzy scores ≥ `FUZZY_THRESHOLD` (0.55). When `applied` is false, the candidate is informational only: callers must emit `0`/`NULL`, not `id`.
   - `isPlaceholder()` treats source placeholders like `-` and `- NOT SET -` as empty.
2. `importer.js` walks `output/pendaftaran/**/*.json` and `output/kunjungan/**/*.json` (preferring `_merged.json` for kunjungan), groups them by the `YYYY_MM` period in the filename, and processes periods newest-first.
3. `src/import-pendaftaran.js` maps positional `__EMPTY*` keys to `kk_pendaftaran` columns and emits batched multi-row INSERTs (`BATCH_SIZE = 500`). It also builds `pendaftaranLookupMap`, keyed `REG:<register no>` (primary), `NIK:<nik>`, and `NAMA:<name>` (fallbacks).
4. `src/import-kunjungan.js` resolves each visit's Pendaftaran record through that map, in the order REG → NIK → NAMA. It sets `id_pendaftaran` via a `SELECT` subquery and takes the "perawat" (nurse) value from the Pendaftaran row. Each visit emits a **statement group**: the `kk_kunjungan` INSERT, then `SET @kunjungan_id = LAST_INSERT_ID();`, then its `kk_pemeriksaan_diagnosa` and batched `kk_pemeriksaan_tindakan` INSERTs. A group must never be split across files.
5. Output per period goes to `output/sql/{YYYY}/`:
   - `{YYYY}_{MM}.sql` holds Pendaftaran groups first, then Kunjungan groups (Kunjungan subqueries need the Pendaftaran rows). It is wrapped in a transaction and split into `_partN.sql` beyond 1MB by `chunkGroupsBySize`, which splits only at group boundaries.
   - `{YYYY}_{MM}_rollback.sql` deletes Kunjungan children, then Kunjungan, then Pendaftaran, scoped by `no_pendaftaran`.
   - `output/sql/import_recap.md` lists unresolved lookups (with the closest candidate when it scored below threshold) and fuzzy matches scoring 0.55–0.95. Matches scoring above 0.95 are deliberately left out.

The `__EMPTY*` field names are literal. They come from `xlsx`'s `sheet_to_json` when the source report has merged or unlabeled header cells, so the field-index mapping in `import-pendaftaran.js`/`import-kunjungan.js` is tied to the exact MyKlinik report layout. Header rows (e.g. `PERIODE`, `Register`, `No`) are skipped by value.

## Output layout

```
output/
├── .progress.json
├── pendaftaran/{YYYY}/{APP_TARGET}_{YYYY}_{MM}.xlsx|json
├── pendaftaran/merged/{APP_TARGET}_pendaftaran_ALL_merged.xlsx|json
├── kunjungan/{YYYY}/{APP_TARGET}_{YYYY}_{MM}_{DD}.xlsx|json
├── kunjungan/merged/{APP_TARGET}_{YYYY}_{MM}_merged.xlsx|json
├── kunjungan/merged/{APP_TARGET}_kunjungan_ALL_merged.xlsx|json
├── backup/pasien/…, backup/{YYYY}_{MM}/{APP_TARGET}_{slug}_{YYYY}_{MM}.csv|json   (BACKUP tool)
└── sql/
    ├── {YYYY}/{YYYY}_{MM}.sql (or _partN.sql), {YYYY}_{MM}_rollback.sql
    └── import_recap.md
```

`output/`, `.env`, and `*.sql` are gitignored, so neither the SQL reference dumps nor the generated SQL are ever committed.
