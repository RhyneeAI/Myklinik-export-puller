# MyKlinikExportPuller

CLI-based Node.js application dengan tiga mode:

- **EXPORT** — menarik data **Pendaftaran** dan **Kunjungan** dari aplikasi MyKlinik (`apps.myklinik.id`) secara otomatis via browser automation. Data di-export sebagai file Excel (`.xlsx`) dan JSON.
- **IMPORT** *(lama — digantikan MIGRATE)* — membaca hasil export JSON di atas, mencocokkannya dengan data referensi dari database (`sql-reference/*.sql`), lalu menghasilkan file SQL `INSERT`/rollback.
- **MERGED KUNJUNGAN** — mode perbaikan/backfill untuk file merge bulanan Kunjungan (lihat [Mode MERGED KUNJUNGAN](#mode-merged-kunjungan)).

Ketiga mode berdiri sendiri-sendiri dan hanya berbagi folder `output/` sebagai penghubung.

Untuk migrasi lengkap ke Medisy gunakan **`npm run migrate`** — satu perintah yang menarik semua data (pasien, kunjungan, 11 jenis Rekam Medis, PDF SOAP), membuat SQL per bulan, dan mengarsipkan hasilnya ke zip (lihat [MIGRATE](#migrate--semua-langkah-dalam-satu-perintah)).

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
- **Agama & wilayah sesuai produksi** — ID agama selalu diambil dari `kk_kategori` (ISLAM 58, KRISTEN PROTESTAN 59, …); "KOTA X" dan "KAB. X" tidak tertukar; kecamatan/desa hanya dicari di dalam kota/kecamatan induknya. Diuji terhadap 2.230 pasien produksi: agama/kota/kecamatan 100%, desa 99,8%
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
| `LOGIN_KEY` / `LOGIN_USER` / `LOGIN_PASS` | Kredensial login (juga untuk auto re-login saat session expired). **Kalau ketiganya diisi, cookie di bawah diabaikan.** Pastikan ini akun dengan akses yang dibutuhkan (BACKUP butuh menu Master → Download Data) | |
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
| `ACTION` | Lewati prompt interaktif — set `EXPORT`, `IMPORT`, atau `MERGE_KUNJUNGAN` |
| `PLAYWRIGHT_HEADLESS` | Set `false` untuk menjalankan browser dalam mode headed (debugging) |

Variable yang diset langsung di perintah **mengalahkan** isi `.env`. Jadi untuk menarik rentang tertentu tanpa mengubah `.env`, cukup:

```bash
# contoh: tarik ulang Kunjungan Oktober 2024 saja, ke folder terpisah (progress-nya juga terpisah)
ACTION=EXPORT MODE=kunjungan START_DATE=2024-10 END_DATE=2024-10 OUTPUT_DIR=output/backfill_2024_10 npm start
```

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

Proses otomatis menyimpan progress ke `output/.progress.json` (atau `{OUTPUT_DIR}/.progress.json`).
Jika proses terputus (CTRL+C / error), jalankan ulang perintah yang sama dan proses akan melanjutkan dari posisi terakhir — bulan/hari yang sudah selesai dilewati.

Sebelum melanjutkan, pastikan tidak ada proses export lama yang masih berjalan (mis. `node src/index.js` yang tertinggal di Task Manager) — proses yang tertinggal tetap menggeser posisi progress.

### Mode IMPORT

Membaca semua file JSON di `output/pendaftaran/**` dan `output/kunjungan/**` (utamakan file `_merged.json`), lalu:

1. Parse data referensi dari `sql-reference/*.sql` (dump `INSERT` gaya phpMyAdmin — bukan koneksi database langsung)
2. Kelompokkan file per periode (`YYYY_MM`), diproses dari periode terbaru ke terlama
3. Cocokkan setiap baris ke tabel referensi (poli, dokter/perawat, agama, kota/kecamatan/desa, diagnosa ICD-10, tindakan) — exact match dulu, baru fuzzy match kalau tidak persis sama
4. Generate satu file `{YYYY}_{MM}.sql` berisi INSERT Pendaftaran (batched) lalu Kunjungan, satu file `{YYYY}_{MM}_rollback.sql` (urutan dibalik: Kunjungan dulu baru Pendaftaran, karena rollback Kunjungan masih butuh baris Pendaftaran ada), plus `import_recap.md`

File referensi yang dibutuhkan di `sql-reference/` (dump tabel dari database produksi, bukan file ini yang menyimpan data — hanya dipakai sebagai lookup):

`kk_kota`, `kk_kecamatan`, `kk_desa`, `kk_poli`, `kk_users`, `kk_kategori` (agama), `kk_kategori_penyakit` (diagnosa ICD-10), `kk_jenis_tindakan`.

> **Keterbatasan yang diketahui:** mode IMPORT mengisi `kk_pendaftaran.no_pendaftaran` dengan nomor **Register** (nomor kunjungan) dan membuat satu baris pendaftaran per kunjungan. Di database produksi (Medisy), `no_pendaftaran` = **No. MR** pasien (satu baris per pasien), dan nomor Register disimpan di `kk_kunjungan.no_kunjungan`. Jangan jalankan hasil IMPORT ke database yang sudah berisi data sampai ini diperbaiki — untuk menambal data yang kurang, pakai SQL backfill (lihat [Migrasi ke Medisy](#migrasi-ke-medisy-catatan)).

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

### BACKUP (Download Data)

Tool terpisah (bukan pilihan di prompt `npm start`) untuk mengambil semua data dari menu **Master Data → Download Data** (`#masterdata/upload/upload`) — butuh akun dengan akses menu tersebut.

```bash
npm run backup                  # tunggu jam download, lalu download semua
npm run backup -- --dry-run     # login & tampilkan daftar file yang akan didownload (bisa kapan saja)
npm run backup -- --no-wait     # keluar kalau di luar jam download, bukan menunggu
npm run backup -- --reparse     # buat ulang semua .json dari file yang sudah didownload (offline)
```

- **Data Pasien** — semua bagian yang tampil di halaman (mis. 1–1000, 1001–2000, ...), rentangnya dibaca langsung dari halaman.
- **Data Rekam Medis** — semua jenis (General Consent, Risiko Jatuh, Informed Consent, Satu Sehat, SOAP, CPPT, Surgical Safety Checklist, Lab, Radiologi, MCU, Resep & Obat) untuk setiap bulan dari `START_DATE` sampai `END_DATE`.
- **Jam download 21.00–06.00 WIB** — aturan dari MyKlinik, dan tool ini mematuhinya: di luar jam itu tool menunggu sampai 21.00 WIB, tidak memulai download baru mulai 05.50 WIB, lalu otomatis lanjut di malam berikutnya kalau masih ada sisa.
- **Resume** — file yang `.json`-nya sudah ada dilewati, jadi aman dijalankan ulang/dihentikan kapan saja.
- File asli dari server disimpan apa adanya, plus `.json` hasil parsing sheet pertama (baris judul dilewati, nilai tetap teks asli — tanggal tidak diubah jadi angka Excel). Kalau gagal membuka halaman, screenshot disimpan di `output/backup/_last_error.png`.

Hasilnya hanya file mentah — belum ada konversi ke SQL / import ke database.

## MIGRATE — semua langkah dalam satu perintah

```bash
npm run migrate                       # jalankan semua langkah untuk START_DATE..END_DATE
npm run migrate -- --no-wait          # siang hari: lewati langkah 1 & 3 (Download Data) kalau di luar jam 21.00–06.00
npm run migrate -- --steps=4,5,6      # hanya langkah tertentu (nomor atau nama)
npm run migrate -- --from=4           # lanjut dari langkah 4 (mis. setelah langkah 4 gagal)
```

| # | Langkah | Sumber | Jam |
|---|---|---|---|
| 1 | `pasien` — Data Pasien | Download Data (V2) | 21.00–06.00 WIB |
| 2 | `kunjungan` — Pendaftaran per bulan + Kunjungan per hari | Laporan V1 | kapan saja |
| 3 | `rekam-medis` — 11 jenis Rekam Medis per bulan | Download Data (V2) | 21.00–06.00 WIB |
| 4 | `soap-pdf` — PDF print SOAP per kunjungan + baca TTV/keluhan | SOAP & Diagnosa → Print | kapan saja |
| 5 | `sql` — SQL pasien, kunjungan (+SOAP/TTV), lab | file di `output/` + dump `sql-reference/` | offline |
| 6 | `zip` — arsip per tahun-bulan | file di `output/` | offline |

- **Bisa dijalankan ulang kapan saja** — file yang sudah lengkap tidak diunduh ulang (data hari/bulan berjalan tetap diperbarui). Kalau satu langkah gagal, pipeline berhenti dan memberi tahu cara melanjutkan (`--from=N`).
- **Data pasien pakai Download Data (V2)** — satu baris per pasien dengan No. MR, persis bentuk `kk_pendaftaran`. Laporan Pendaftaran V1 tetap ditarik di langkah 2 karena itulah sumber **poli** tiap kunjungan.
- **SQL (langkah 5)** disimpan per bulan di `output/sql/{YYYY}/{YYYY}_{MM}.sql` (dipecah `_part2`, … bila >1MB), **dijalankan dari bulan terlama**. Semua INSERT dilewati bila datanya sudah ada (No. MR / No. Register / kode sampel lab), UPDATE hanya mengisi kolom yang masih kosong — aman untuk database yang sudah berisi sebagian data. `{YYYY}_{MM}_rollback.sql` membatalkannya (jalankan dari bulan **terbaru**). Ringkasan & hal yang perlu dicek: `output/sql/migrate_recap.md`.
- **Yang sudah dipetakan ke SQL:** pasien, kunjungan (poli, dokter, jam), SOAP → `keluhan_awal`/`riwayat_peny_sekarang` + TTV (TB, BB, TD, nadi, RR, SpO2, suhu, lingkar perut/kepala, IMT), Lab → `kk_pemeriksaan_tambahan_lab`. **Belum (placeholder):** O/A/P SOAP & 9 jenis Rekam Medis lainnya (General Consent, Risiko Jatuh, Informed Consent, Satu Sehat, CPPT, Surgical Safety, Radiologi, MCU, Resep & Obat) — jumlah datanya tercatat di recap.
- **TTV** dari PDF: nilai `0` berarti tidak diisi (dikosongkan); nilai yang tidak wajar (mis. suhu 3.7) dikosongkan dan dicatat di recap.
- **Zip (langkah 6):** `output/archive/{YYYY}/{APP_TARGET}_{YYYY}_{MM}.zip` berisi `pendaftaran/`, `kunjungan/`, `rekam-medis/`, `soap-pdf/` bulan itu; Data Pasien di `output/archive/{APP_TARGET}_pasien.zip`. Berisi data medis pasien — simpan dengan aman.

PDF SOAP juga bisa ditarik sendiri: `npm run soap-pdf` (opsi `--limit=N`, `--month=YYYY_MM`, `--reparse` untuk membaca ulang PDF yang sudah ada tanpa internet).

## Migrasi ke Medisy (catatan)

Hasil pencocokan data MyKlinik dengan database produksi Medisy (`sql-reference/`):

- **Pasien:** `kk_pendaftaran.no_pendaftaran` = No. MR MyKlinik apa adanya (`001045`). Pasien yang dibuat langsung di Medisy bernomor 7 digit (`2670006`, …).
- **Kunjungan:** `kk_kunjungan.no_kunjungan` = nomor **Register** MyKlinik. Nomor yang "bolong" di urutan hampir selalu kunjungan yang **dibatalkan** di MyKlinik — cek dengan export Kunjungan hari itu sebelum menganggapnya hilang.
- **Poli kunjungan** paling akurat diambil dari kolom **Layanan** di export Pendaftaran (nama persis sama dengan `kk_poli`), bukan ditebak dari tindakan.
- **SOAP** dari BACKUP tidak punya No. MR, jadi dicocokkan ke kunjungan lewat tanggal + dokter + jam (hasil di `output/backup/analisis/`). **TTV** tidak ada di export SOAP, tapi ada di **PDF print SOAP** (menu SOAP & Diagnosa → Print) beserta No. MR, keluhan/anamnesa, dan ICD-10.

SQL tambalan disimpan di `output/sql/backfill/` (pasien & kunjungan) dan `output/sql/lab/` (pemeriksaan lab). Semuanya:
- **aman dijalankan ulang** — baris yang kuncinya sudah ada (`no_pendaftaran`, `no_kunjungan`, `ucode`) dilewati,
- punya **file `_rollback.sql`** yang hanya menghapus baris baru hasil SQL tersebut,
- disertai **CSV review** untuk dicek sebelum dijalankan.

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
├── backup/
│   ├── pasien/{APP_TARGET}_pasien_{start}_{end}.{xls|xlsx}|json
│   ├── {YYYY}_{MM}/{APP_TARGET}_{jenis}_{YYYY}_{MM}.{csv|xlsx}|json   ← semua jenis Rekam Medis bulan itu
│   ├── {YYYY}_{MM}/soap-pdf/*.pdf      ← PDF SOAP (+ {APP_TARGET}_soap-pdf_{YYYY}_{MM}.json hasil baca)
│   └── analisis/                       ← hasil pencocokan SOAP/Lab ↔ kunjungan, daftar pasien yang belum ada di DB
├── archive/
│   ├── {YYYY}/{APP_TARGET}_{YYYY}_{MM}.zip   ← pendaftaran + kunjungan + rekam medis + PDF SOAP bulan itu
│   └── {APP_TARGET}_pasien.zip
└── sql/
    ├── {YYYY}/
    │   ├── {YYYY}_{MM}.sql               (Pendaftaran batched + Kunjungan; atau _part1.sql, _part2.sql, ... jika >1MB)
    │   └── {YYYY}_{MM}_rollback.sql      (Kunjungan lalu Pendaftaran)
    ├── migrate_recap.md                  ← ringkasan & hal yang perlu dicek (MIGRATE)
    ├── import_recap.md                   ← (IMPORT lama)
    ├── backfill/                         ← SQL tambalan pasien & kunjungan + rollback + CSV review
    └── lab/                              ← SQL kk_pemeriksaan_tambahan_lab + rollback
```

## Catatan

- START\_DATE harus lebih **baru** dari END\_DATE (proses EXPORT berjalan dari bulan terbaru ke terlama)
- Delay default 15 detik antar request untuk menghindari rate limiting
- File Excel asli dari server disimpan tanpa perubahan
- File JSON adalah hasil parsing untuk kemudahan import ke sistem lain
- `output/`, `.env`, dan `*.sql` di-gitignore — dump referensi dan hasil generate SQL tidak pernah ter-commit
