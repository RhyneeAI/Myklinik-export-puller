# MyPharmaExportPuller

CLI-based Node.js application untuk menarik data **Pendaftaran** dan **Kunjungan** dari aplikasi MyKlinik (`apps.myklinik.id`) secara otomatis. Data di-export sebagai file Excel (`.xlsx`) dan JSON.

## Fitur

- **Playwright automation** — navigasi SPA, klik tombol Cari & Export otomatis
- **Pendaftaran** — tarik data per-bulan (rekursif dari START\_DATE hingga END\_DATE)
- **Kunjungan** — tarik data per-hari + merge otomatis ke file bulanan
- **Output ganda** — Excel (.xlsx) + JSON (.json) untuk setiap periode
- **Progress tracking** — melanjutkan dari posisi terakhir jika terputus (`.progress.json`)
- **Retry & delay** — backoff otomatis saat error 500 / timeout
- **Verifikasi** — cek kelengkapan file setelah selesai
- **CLI modern** — box-drawing, warna, status real-time

## Persyaratan

- Node.js 18+
- npm
- Google Chrome (terinstall di system)

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
| `MODE` | Jenis data: `pendaftaran`, `kunjungan`, atau `all` | `all` |
| `REQUEST_DELAY_MS` | Jeda antar request (ms) | `15000` |
| `MAX_RETRIES` | Maksimal percobaan ulang per request | `3` |
| `COOKIES_JSON` | Semua cookies sebagai JSON (dari DevTools → Copy as JSON) | |
| `SERVERID` | Cookie SERVERID | |
| `SOKKACREATIVEID` | Cookie SOKKACREATIVEID | |
| `TOKEN` | Cookie token | |
| `SESSION_NAME` | Nama cookie session PHP (acak) | |
| `SESSION_VALUE` | Value cookie session PHP | |
| `KEY1` – `KEY4` | Cookie autentikasi | |

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

### Mode

Set `MODE` di `.env`:

- `pendaftaran` — hanya tarik data pendaftaran
- `kunjungan` — hanya tarik data kunjungan
- `all` — tarik pendaftaran dulu, lalu kunjungan (berurutan)

### Resume / Checkpoint

Proses otomatis menyimpan progress ke `output/.progress.json`.
Jika proses terputus (CTRL+C / error), jalankan ulang `npm start` dan akan melanjutkan dari posisi terakhir.

## Struktur Output

```
output/
├── .progress.json
├── pendaftaran/
│   └── 2026/
│       ├── MyKlinik_2026_07.xlsx
│       ├── MyKlinik_2026_07.json
│       ├── MyKlinik_2026_06.xlsx
│       ├── MyKlinik_2026_06.json
│       └── ...
└── kunjungan/
    └── 2026/
        ├── MyKlinik_2026_07_01.xlsx
        ├── MyKlinik_2026_07_01.json
        ├── MyKlinik_2026_07_02.xlsx
        ├── MyKlinik_2026_07_02.json
        ├── ...
        ├── MyKlinik_2026_07_merged.xlsx     ← merge bulanan
        └── MyKlinik_2026_07_merged.json     ← merge bulanan
```

## Catatan

- START\_DATE harus lebih **baru** dari END\_DATE (proses berjalan dari bulan terbaru ke terlama)
- Delay default 15 detik antar request untuk menghindari rate limiting
- File Excel asli dari server disimpan tanpa perubahan
- File JSON adalah hasil parsing untuk kemudahan import ke sistem lain
- Kunjungan otomatis di-merge per-bulan menjadi satu file Excel + JSON
