# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Node.js CLI tool with two modes, chosen interactively on `npm start`:

- **EXPORT** — drives a real Chrome browser (via Playwright) against `apps.myklinik.id`, a clinic SPA, to pull **Pendaftaran** (patient registration) and **Kunjungan** (visit) reports as Excel + JSON.
- **IMPORT** — reads the JSON exported above, cross-references it against reference tables dumped from the production MySQL database (`sql-reference/*.sql`), and generates `INSERT`/rollback SQL files to load that data into the clinic's database.

The two modes are independent pipelines that only share the `output/` directory as a handoff point.

## Commands

```bash
npm install       # install dependencies
npm start         # runs src/index.js, prompts for EXPORT or IMPORT
```

There is no build step, lint config, or test suite in this repo. The only "verification" used historically is `node --check <file>` for syntax validation of new files (see `implementation_plan.md`).

Playwright uses the `chrome` channel (real installed Chrome, not the bundled Chromium) — see `src/browser.js`. Google Chrome must be installed on the machine; no `npx playwright install` is required for this to work.

To skip the interactive EXPORT/IMPORT prompt (e.g. scripting), set `ACTION=EXPORT` or `ACTION=IMPORT` in the environment.

To run in headed mode for debugging browser automation, set `PLAYWRIGHT_HEADLESS=false`.

## Configuration (`.env`)

Copied from `.env.example`. Key variables:

- `APP_TARGET` — prefix for output filenames.
- `ENDPOINT_URL` — base URL of the MyKlinik instance.
- `OUTPUT_DIR` — defaults to `output`.
- `START_DATE` / `END_DATE` (`YYYY-MM`) — export walks backwards from `START_DATE` to `END_DATE`; `START_DATE` must be the newer month.
- `MODE` — `pendaftaran`, `kunjungan`, or `all` (EXPORT mode only).
- `REQUEST_DELAY_MS` / `MAX_RETRIES` — throttling and retry knobs for the scraper.
- Auth: either `LOGIN_KEY`/`LOGIN_USER`/`LOGIN_PASS` (auto re-login when the session expires mid-run) or a manually captured cookie set (`COOKIES_JSON`, or individual `SERVERID`/`SOKKACREATIVEID`/`TOKEN`/`SESSION_NAME`/`SESSION_VALUE`/`KEY1`-`KEY4`).

## EXPORT pipeline architecture

`src/index.js` is the orchestrator. Flow: parse `.env` date range → launch a persistent Chrome context (`src/browser.js`) → run Pendaftaran then Kunjungan sequentially (each owns a single `page` for its whole run) → verify output files exist → print summary.

Key modules:
- `src/browser.js` — launches `chromium.launchPersistentContext` with a throwaway temp profile dir, seeds cookies from `.env` if provided. `close()` also deletes the temp profile.
- `src/pendaftaran.js` / `src/kunjungan.js` — near-identical scraping logic (intentionally duplicated, not shared) that:
  1. navigates the SPA to the report page via `page.evaluate` DOM clicks (SPA has no real URL routing for these views),
  2. detects and handles session-expiry by filling the login modal (`#ckeyKlinik`/`#cUser`/`#cPassword`/`#cCaptcha`) using `LOGIN_KEY`/`LOGIN_USER`/`LOGIN_PASS`,
  3. fills the date-range form (`#cDateStart`/`#cDateEnd`) and clicks "Cari" (search),
  4. clicks Export and captures the Playwright `download` event, saving the `.xlsx` directly,
  5. also parses the same buffer into JSON via `xlsx` and writes a sibling `.json`.
  - Pendaftaran iterates **month by month** (newest → oldest). Kunjungan iterates **day by day** within each month, then merges each month's daily JSON/Excel into a `_merged` file, and finally an all-time `_ALL_merged` file across the whole run.
  - Both are defensive about the server returning HTML instead of an Excel file (rate limiting / session expiry / 500s) — `looksLikeHTML`/`summarizeHtml` in `src/utils.js` detect this and trigger retries (or a hard stop if it's a login page, since credentials must be handled at a higher retry loop).
- `src/progress.js` — checkpoint file at `output/.progress.json`. Tracks a `cursor` (last completed year/month for Pendaftaran, year/month/day for Kunjungan) so `npm start` can resume after a crash/Ctrl+C without re-downloading. Cursor comparison is lexical string comparison (`YYYY_MM` / `YYYY_MM_DD`), which works because the run always walks backwards from newer to older dates.
- `src/logger.js` — hand-rolled ANSI/box-drawing console output (markdown-style headers, tables, colored status). No external logging library.

## IMPORT pipeline architecture

Entry point `runImport()` in `src/importer.js`, invoked from `index.js` after the user selects IMPORT.

1. `src/sql-parser.js` regex-parses phpMyAdmin-style `INSERT INTO ... VALUES (...), (...);` dumps in `sql-reference/` into in-memory arrays/maps (no real SQL parser or DB connection — these files are reference/lookup data only, e.g. `kk_kota`, `kk_kecamatan`, `kk_desa`, `kk_poli`, `kk_users`, `kk_kategori` (agama), `kk_kategori_penyakit`, `kk_jenis_tindakan`). It also exposes `findMatching*` fuzzy-lookup helpers (case-insensitive, substring-based, with common prefix stripping like `KAB.`/`KECAMATAN`/`DR.`).
2. `importer.js` walks `output/pendaftaran/**/*.json` and `output/kunjungan/**/*.json` (preferring `_merged.json` for kunjungan), groups files by `YYYY_MM` period extracted from the filename, and processes periods newest-first.
3. For each period: `src/import-pendaftaran.js` maps each row's positional `__EMPTY*` keys (raw `xlsx`-parsed column headers) to `kk_pendaftaran` columns, resolving agama/kota/kecamatan/desa via the reference lookups, and builds a `pendaftaranLookupMap` (keyed by NIK and by name) so Kunjungan rows in the same period can cross-reference the patient's registration record.
4. `src/import-kunjungan.js` maps Kunjungan rows to `kk_kunjungan` (+ child `kk_pemeriksaan_diagnosa` / `kk_pemeriksaan_tindakan` rows), using the pendaftaran lookup map to resolve `id_pendaftaran` via a `SELECT` subquery and to pull the "perawat" (nurse) field recorded on the original Pendaftaran row.
5. Output per period: `output/sql/{period}_pendaftaran.sql`, `output/sql/{period}_pendaftaran_rollback.sql`, `output/sql/{period}_kunjungan.sql`, `output/sql/{period}_kunjungan_rollback.sql`, plus a single `output/sql/import_recap.md` listing every row where a lookup couldn't be resolved (which file, which name, which field).

The `__EMPTY*` field names are literal — they come from `xlsx`'s `sheet_to_json` when the source Excel report has merged/unlabeled header cells, so column positions must stay in sync with the shape of the actual MyKlinik export. If the report layout changes, the field-index mapping in `import-pendaftaran.js`/`import-kunjungan.js` needs updating.

## Output layout

```
output/
├── .progress.json
├── pendaftaran/{YYYY}/{APP_TARGET}_{YYYY}_{MM}.xlsx|json
├── pendaftaran/merged/{APP_TARGET}_pendaftaran_ALL_merged.xlsx|json
├── kunjungan/{YYYY}/{APP_TARGET}_{YYYY}_{MM}_{DD}.xlsx|json
├── kunjungan/merged/{APP_TARGET}_{YYYY}_{MM}_merged.xlsx|json
├── kunjungan/merged/{APP_TARGET}_kunjungan_ALL_merged.xlsx|json
└── sql/{YYYY}_{MM}_{pendaftaran|kunjungan}.sql, *_rollback.sql, import_recap.md
```

`output/`, `.env`, and `*.sql` are gitignored — SQL reference dumps and generated import SQL are never committed.
