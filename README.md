# Lumen Gateway — Laravel simulator

Payment gateway sandbox kini aplikasi **Laravel 13 / PHP 8.4 / MySQL InnoDB**. Runtime Node, Passenger, dan file-store JSON bukan backend aktif. UI merchant yang sama dipertahankan sebagai aset JS/CSS biasa; tidak memerlukan Vite/build untuk gateway.

## Persiapan (operator menjalankan sendiri)

Tidak ada test, migrate, seed, atau build yang dijalankan saat port ini dibuat. Dependensi Composer sudah disiapkan dengan scripts/plugins dinonaktifkan. Pada instalasi baru:

```bash
cd payment-gateway-simulator
composer install --no-dev --prefer-dist --no-interaction
cp .env.example .env
# Isi DB_HOST/DB_PORT/DB_DATABASE/DB_USERNAME/DB_PASSWORD
# serta APP_URL untuk domain/IP gateway yang dapat dijangkau.
php artisan key:generate
php artisan migrate --force
php artisan serve --host=127.0.0.1 --port=4179
```

Terminal kedua, setelah database siap:

```bash
php artisan gateway:work
```

Buka APP_URL gateway (default http://127.0.0.1:4179). Gunakan **Minta kredensial** untuk membuat merchant dan langsung mendapatkan API secret serta webhook secret tanpa approval/email verification. Gateway developer workspace berbeda dari akun client/admin Lumen Studio.

PHP memerlukan PDO MySQL, cURL, mbstring, XML/XMLWriter, DOM, fileinfo, dan GD untuk fitur yang disertakan. Database target adalah MySQL 8.4/InnoDB. Tabel domain memakai prefix `gateway_` dan migration ledger `gateway_migrations`. Database dan APP_KEY terpisah dari Lumen Studio disarankan; bila hosting hanya menyediakan satu database, nama tabel/pencatatan migration sudah dipisahkan, tetapi atur grant masing-masing user dengan benar. Jangan menyalin credential DB Lumen tanpa memastikan izin yang diperlukan.

## QRIS dan VA

- QRIS dinamis: QR memuat URL `GET /qris/{checkout_token}`. Membuka URL langsung mencatat nominal server dan menampilkan konfirmasi pembayaran uji. Query amount tidak berwenang mengubah nominal. Scan ulang tidak menghasilkan receipt tambahan. Token expired/cancelled tidak dapat membayar.
- VA: nomor sintetis 16 digit berawalan 999, nominal tertutup, label BCA/BNI/BRI/MANDIRI/PERMATA. Gunakan bank simulator untuk amount dan bank reference; tidak terhubung ke bank nyata.
- API key/session token disimpan sebagai SHA-256; signing secret dan checkout token dienkripsi dengan APP_KEY. Simpan APP_KEY yang sama saat update/restore. API secret hanya ditampilkan saat dibuat.
- Transaksi memakai lock merchant dan payment, unique references, serta idempotency yang tersimpan dalam database. Pembayaran terlambat tetap kasus rekonsiliasi dan tidak menghidupkan booking expired.
- Webhook memakai HMAC dari raw body, event ID stabil, claim/lease, retry persisten dan replay. Kirim HTTP dilakukan setelah transaksi DB dilepas. Tidak lagi bergantung pada proses Node tunggal atau file JSON.

QR bukan payload EMV QRIS bank/e-wallet. Semua transaksi, VA, dan refund adalah simulasi tanpa uang nyata.

## Lumen Studio

1. Buka portal gateway, minta credential, lalu simpan URL webhook `https://studio.example.com/webhooks/payments/simulator`.
2. Isi `GATEWAY_BASE_URL`, `GATEWAY_API_KEY`, `GATEWAY_MERCHANT_ID`, dan `GATEWAY_WEBHOOK_SECRET` pada environment backend Lumen Studio.
3. Jalankan worker/scheduler kedua aplikasi. Lumen menggunakan `studio:tick`; gateway menggunakan `gateway:tick`.
4. Lumen membuat DP/balance melalui `POST /v1/payments`, menampilkan QR/VA, lalu memverifikasi webhook dan GET status provider sebelum mengkredit invoice satu kali.

- [Diagram integrasi SVG](public/integration-lumen.svg)
- [Sumber diagram Mermaid](docs/integration-lumen.mmd)
- [Kontrak API](API.md)
- [Tutorial shared hosting kedua aplikasi](../lumen-studio/docs/DEPLOYMENT-SHARED-HOSTING.md)
- Panduan web **/docs**, PDF **/guide.pdf** (dihasilkan oleh PHP saat diminta), OpenAPI **/openapi.json**.

Untuk ponsel di LAN, APP_URL gateway harus memakai IP komputer, misalnya `http://192.168.1.20:4179`, dan server harus bisa dijangkau pada port itu. Gateway dan portal berbagi server PHP yang sama. Pada public hosting gunakan domain HTTPS sehingga ponsel tidak perlu Wi-Fi yang sama. Tidak ada SCAN_HOST/SCAN_BASE_URL/listener 4181 pada backend Laravel.

## Shared hosting

Arahkan subdomain gateway ke `payment-gateway-simulator/public`, isi APP_ENV=production, APP_DEBUG=false, APP_URL=https://gateway.example.com, ALLOW_LOCAL_WEBHOOKS=false, database, dan APP_KEY. Gunakan binary PHP CLI 8.4 yang sama dengan website. Portal/API, checkout, scan, SVG dan dokumentasi dilayani Laravel/Apache/PHP-FPM, tanpa Application Manager Node.

Pasang satu cron gateway:

```cron
* * * * * cd /home/account/apps/lumen-gateway && /usr/local/bin/php artisan schedule:run >> /home/account/logs/gateway-scheduler.log 2>&1
```

Task gateway dijadwalkan setiap 10 detik sehingga schedule:run hidup sampai akhir menit. Jika host membatasi durasi CLI, ganti dengan `php artisan gateway:tick` sekali per menit (pilih satu mode). Konfirmasi/retry akan menunggu siklus cron berikutnya. Jangan memakai endpoint web publik untuk menjalankan command Artisan. Cron Lumen Studio tetap dipasang tersendiri.

Simpan environment/storage di luar webroot, izinkan tulis storage dan bootstrap/cache, dan backup database serta APP_KEY. Public callback hanya HTTPS/443, tidak mengikuti redirect, menolak private/reserved DNS, dan mem-pin DNS saat mengirim webhook. Loopback HTTP hanya di APP_ENV local/testing dengan ALLOW_LOCAL_WEBHOOKS=true.

## Arsip dan status port

Kode Node dan hasil test lamanya berada di `archive/node`. Data JSON lama, termasuk `lumen-studio/.runtime/gateway.json` dan `.data/gateway.json` bila ada, tidak dihapus dan tidak otomatis diimpor. Akun/key Node tidak menjadi akun/key Laravel; registrasikan merchant baru dan ganti environment studio setelah database Laravel diaktifkan. Transaksi historis/receipt Lumen tetap ada, tetapi percobaan gateway lama perlu ditutup atau direkonsiliasi pada runtime asal sebelum perpindahan. Jangan mengarahkan transaksi lama yang masih pending ke backend baru tanpa rencana perpindahan.

Validasi runtime, transaksi bersamaan, cron, callback HTTPS, dan rendering PDF port Laravel **belum dijalankan**, sesuai larangan test/migrate/build pada pekerjaan ini. Hasil test Node sebelumnya tidak merupakan hasil test port Laravel.
