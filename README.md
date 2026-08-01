# MyPharmaExportPuller

CLI-based Node.js application dengan tiga mode:

- **EXPORT** — menarik data **Pendaftaran** dan **Kunjungan** dari aplikasi MyKlinik (`apps.myklinik.id`) secara otomatis via browser automation. Data di-export sebagai file Excel (`.xlsx`) dan JSON.
- **IMPORT** — membaca hasil export JSON di atas, mencocokkannya dengan data referensi dari database (`sql-reference/*.sql`), lalu menghasilkan file SQL `INSERT`/rollback siap-pakai untuk mengisi database klinik.
- **MERGED KUNJUNGAN** — mode perbaikan/backfill untuk file merge bulanan Kunjungan (lihat [Mode MERGED KUNJUNGAN](#mode-merged-kunjungan)).

Ketiga mode berdiri sendiri-sendiri dan hanya berbagi folder `output/` sebagai penghubung.

## Fitur

### EXPORT
- **Playwright automation** — navigasi SPA, klik tombol Cari & Export otomatis
- **Auto re-login** — deteksi session expired dan login ulang otomatis (`LOGIN_KEY`/`LOGIN_USER`/`LOGIN_PASS`)
- **Pendaftaran** — tarik data per-bulan (rekursif dari START\_DATE hingga END\_DATE)
- **Kunjungan** — tarik data per-hari + merge otomatis ke file bulanan dan file all-time
- **Output ganda** — Excel (.xlsx) + JSON (.json) untuk setiap periode
- **Progress tracking** — melanjutkan dari posisi terakhir jika terputus (`.progress.json`)
- **Retry & delay** — backoff otomatis saat error 500 / timeout / rate limiting

### IMPORT
- **Fuzzy matching** — mencocokkan nama poli, dokter/perawat, kota/kecamatan/desa, agama, diagnosa (ICD-10), dan tindakan terhadap data referensi, walau penulisannya tidak persis sama
- **Cross-reference Pendaftaran ↔ Kunjungan** — pakai nomor Register (bukan NIK/Nama) sebagai kunci utama supaya lebih akurat
- **Batch INSERT** — baris Pendaftaran digabung sampai 500 baris per statement `INSERT ... VALUES (...), (...), ...`; tindakan per kunjungan juga digabung — jauh lebih sedikit statement dibanding satu `INSERT` per baris
- **Satu file per periode** — SQL Pendaftaran + Kunjungan (dan rollback-nya) digabung jadi satu file masing-masing, bukan file terpisah per jenis
- **Output per tahun & dibatasi ukuran** — file SQL dikelompokkan ke `output/sql/{YYYY}/`, otomatis dipecah jadi `_part1.sql`, `_part2.sql`, dst. kalau lebih dari 1MB (tanpa memutus grup statement yang saling terkait)
- **Recap report** — `import_recap.md` mencatat setiap baris yang lookup-nya gagal (termasuk kandidat terdekat kalau skornya terlalu rendah untuk dipakai) atau fuzzy-match dengan skor 0.55–0.95, supaya bisa direview manual. Fuzzy match yang sangat yakin (skor >0.95) tidak dicatat karena hampir pasti benar

### MERGED KUNJUNGAN
- **Pindahkan file merge yang nyasar** — kalau ada `*_merged.xlsx/json` yang masih di `output/kunjungan/{YYYY}/` (bukan di `output/kunjungan/merged/`), langsung dipindahkan
- **Backfill merge yang terlewat** — kalau file harian satu bulan penuh sudah lengkap tapi belum pernah di-merge, dibuatkan file merge-nya
- **Aman dijalankan berkali-kali** — bulan yang sudah beres di `merged/` dilewati begitu saja

### Umum
- **CLI modern** — box-drawing, warna, status real-time

## Persyaratan

- Node.js 18+
- npm
- Google Chrome (terinstall di system) — hanya untuk mode EXPORT

## Instalasi

```bash
npm install
```

## Konfigurasi

Copy `.env.example` menjadi `.env`:

```bash
cp .env.example .env
```

### Variable .env

| Variable | Deskripsi | Contoh |
|---|---|---|
| `APP_TARGET` | Prefix nama file output | `MyKlinik` |
| `ENDPOINT_URL` | Base URL aplikasi | `https://apps.myklinik.id/` |
| `OUTPUT_DIR` | Direktori output | `output` |
| `START_DATE` | Bulan mulai (YYYY-MM, lebih baru) | `2026-07` |
| `END_DATE` | Bulan akhir (YYYY-MM, lebih lama) | `2023-01` |
| `MODE` | Jenis data EXPORT: `pendaftaran`, `kunjungan`, atau `all` | `all` |
| `REQUEST_DELAY_MS` | Jeda antar request (ms) | `15000` |
| `MAX_RETRIES` | Maksimal percobaan ulang per request | `3` |
| `LOGIN_KEY` / `LOGIN_USER` / `LOGIN_PASS` | Kredensial untuk auto re-login saat session expired | |
| `COOKIES_JSON` | Semua cookies sebagai JSON (dari DevTools → Copy as JSON), alternatif dari kredensial login | |
| `SERVERID` | Cookie SERVERID | |
| `SOKKACREATIVEID` | Cookie SOKKACREATIVEID | |
| `TOKEN` | Cookie token | |
| `SESSION_NAME` | Nama cookie session PHP (acak) | |
| `SESSION_VALUE` | Value cookie session PHP | |
| `KEY1` – `KEY4` | Cookie autentikasi | |

Tambahan environment variable opsional (bukan di `.env`, diset langsung saat menjalankan perintah):

| Variable | Deskripsi |
|---|---|
| `ACTION` | Lewati prompt interaktif — set `EXPORT` atau `IMPORT` |
| `PLAYWRIGHT_HEADLESS` | Set `false` untuk menjalankan browser dalam mode headed (debugging) |

### Mendapatkan Cookie

1. Buka `https://apps.myklinik.id/` di browser
2. Login seperti biasa
3. Buka Developer Tools (F12) → tab **Application** → **Cookies** → `apps.myklinik.id`
4. Klik kanan di tabel cookies → **Copy All** → **Copy as JSON**, paste ke `COOKIES_JSON` di `.env`
   Atau copy manual nilai masing-masing cookie ke variable individu (`SERVERID`, `SOKKACREATIVEID`, `TOKEN`, `SESSION_NAME`, `SESSION_VALUE`, `KEY1`–`KEY4`)

## Penggunaan

```bash
npm start
```

Akan muncul prompt untuk memilih mode:

```
Pilih mode operasi (1. EXPORT / 2. IMPORT / 3. MERGED KUNJUNGAN) [default: EXPORT]:
```

Untuk skrip otomatis (skip prompt), set `ACTION`:

```bash
ACTION=EXPORT npm start
ACTION=IMPORT npm start
ACTION=MERGE_KUNJUNGAN npm start
```

### Mode EXPORT

Set `MODE` di `.env`:

- `pendaftaran` — hanya tarik data pendaftaran
- `kunjungan` — hanya tarik data kunjungan
- `all` — tarik pendaftaran dulu, lalu kunjungan (berurutan)

`START_DATE` harus lebih **baru** dari `END_DATE` — proses berjalan mundur dari bulan terbaru ke terlama.

#### Resume / Checkpoint

Proses otomatis menyimpan progress ke `output/.progress.json`.
Jika proses terputus (CTRL+C / error), jalankan ulang `npm start` dan akan melanjutkan dari posisi terakhir.

### Mode IMPORT

Membaca semua file JSON di `output/pendaftaran/**` dan `output/kunjungan/**` (utamakan file `_merged.json`), lalu:

1. Parse data referensi dari `sql-reference/*.sql` (dump `INSERT` gaya phpMyAdmin — bukan koneksi database langsung)
2. Kelompokkan file per periode (`YYYY_MM`), diproses dari periode terbaru ke terlama
3. Cocokkan setiap baris ke tabel referensi (poli, dokter/perawat, agama, kota/kecamatan/desa, diagnosa ICD-10, tindakan) — exact match dulu, baru fuzzy match kalau tidak persis sama
4. Generate satu file `{YYYY}_{MM}.sql` berisi INSERT Pendaftaran (batched) lalu Kunjungan, satu file `{YYYY}_{MM}_rollback.sql` (urutan dibalik: Kunjungan dulu baru Pendaftaran, karena rollback Kunjungan masih butuh baris Pendaftaran ada), plus `import_recap.md`

File referensi yang dibutuhkan di `sql-reference/` (dump tabel dari database produksi, bukan file ini yang menyimpan data — hanya dipakai sebagai lookup):

`kk_kota`, `kk_kecamatan`, `kk_desa`, `kk_poli`, `kk_users`, `kk_kategori` (agama), `kk_kategori_penyakit` (diagnosa ICD-10), `kk_jenis_tindakan`.

**Sebelum menjalankan SQL hasil generate ke database produksi, cek dulu `output/sql/import_recap.md`** — baris yang lookup-nya gagal total (`id` jadi `0`/`NULL`) maupun yang cuma fuzzy-matched (ada skor kemiripan) tercatat di sana untuk direview manual.

File SQL per periode disimpan di `output/sql/{YYYY}/{YYYY}_{MM}.sql` (Pendaftaran + Kunjungan digabung, INSERT Pendaftaran di-batch sampai 500 baris per statement). Kalau ukurannya lebih dari 1MB, otomatis dipecah jadi `..._part1.sql`, `..._part2.sql`, dst — masing-masing file tetap satu unit transaksi yang lengkap dan bisa dijalankan sendiri-sendiri (tidak ada baris Kunjungan yang kepotong di tengah beserta diagnosa/tindakannya, dan urutan Pendaftaran-sebelum-Kunjungan selalu terjaga antar bagian).

### Mode MERGED KUNJUNGAN

EXPORT menulis file merge bulanan Kunjungan (`{APP_TARGET}_{YYYY}_{MM}_merged.xlsx|json`) ke `output/kunjungan/merged/` di akhir setiap bulan yang selesai diproses. Mode ini memperbaiki dua situasi yang bisa membuat file merge itu hilang/salah tempat:

- **File merge nyasar** — kalau proses EXPORT-nya berasal dari versi lama yang menulis file merge langsung ke `output/kunjungan/{YYYY}/`, file itu akan langsung dipindahkan ke `output/kunjungan/merged/` (bukan di-generate ulang).
- **Belum sempat di-merge** — kalau semua file harian satu bulan sudah lengkap tapi proses sempat terputus sebelum sampai ke tahap merge, mode ini akan membuat file merge-nya dari file-file harian yang ada.
- Bulan yang file hariannya belum lengkap akan dilewati (ditandai `SKIP`) — jalankan EXPORT lagi untuk melengkapi dulu.

```bash
ACTION=MERGE_KUNJUNGAN npm start
```

## Struktur Output

```
output/
├── .progress.json
├── pendaftaran/
│   ├── {YYYY}/{APP_TARGET}_{YYYY}_{MM}.xlsx|json
│   └── merged/{APP_TARGET}_pendaftaran_ALL_merged.xlsx|json
├── kunjungan/
│   ├── {YYYY}/{APP_TARGET}_{YYYY}_{MM}_{DD}.xlsx|json
│   └── merged/
│       ├── {APP_TARGET}_{YYYY}_{MM}_merged.xlsx|json      ← merge bulanan
│       └── {APP_TARGET}_kunjungan_ALL_merged.xlsx|json    ← merge all-time
└── sql/
    └── {YYYY}/
        ├── {YYYY}_{MM}.sql               (Pendaftaran batched + Kunjungan; atau _part1.sql, _part2.sql, ... jika >1MB)
        └── {YYYY}_{MM}_rollback.sql      (Kunjungan lalu Pendaftaran)
    (dan output/sql/import_recap.md di level atas)
```

## Catatan

- START\_DATE harus lebih **baru** dari END\_DATE (proses EXPORT berjalan dari bulan terbaru ke terlama)
- Delay default 15 detik antar request untuk menghindari rate limiting
- File Excel asli dari server disimpan tanpa perubahan
- File JSON adalah hasil parsing untuk kemudahan import ke sistem lain
- `output/`, `.env`, dan `*.sql` di-gitignore — dump referensi dan hasil generate SQL tidak pernah ter-commit
