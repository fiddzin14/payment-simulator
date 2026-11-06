<!doctype html>
<html lang="id">

<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Integrasi Laravel Gateway dan Lumen Studio</title>
    <style>
        @page {
            margin: 28px 36px
        }

        body {
            font-family: DejaVu Sans, Arial, sans-serif;
            color: #19223d;
            font-size: 12px;
            line-height: 1.65;
            margin: 0
        }

        main {
            max-width: 1100px;
            margin: 24px auto;
            padding: 0 24px
        }

        h1 {
            font-size: 26px;
            line-height: 1.25;
            color: #3639b8
        }

        h2 {
            font-size: 18px;
            color: #3639b8
        }

        a {
            color: #5154ed
        }

        .tag {
            font-size: 10px;
            letter-spacing: 1px;
            color: #68728a
        }

        .diagram {
            width: 100%;
            height: auto
        }

        .page {
            page-break-before: always
        }

        pre {
            background: #f1efff;
            padding: 16px;
            font-size: 11px;
            white-space: pre-wrap;
            overflow-wrap: break-word
        }

        .note {
            padding: 14px;
            background: #fff5df;
            border-radius: 8px
        }

        .columns {
            width: 100%;
            table-layout: fixed;
            border-collapse: collapse
        }

        .columns td {
            width: 50%;
            vertical-align: top;
            padding: 0 24px 10px 0
        }

        li {
            margin: 6px 0
        }

        @media print {
            main {
                margin: 0;
                padding: 0
            }

            .toolbar {
                display: none
            }
        }

        @media(max-width:700px) {

            .columns,
            .columns tbody,
            .columns tr,
            .columns td {
                display: block;
                width: 100%;
                box-sizing: border-box
            }

            .diagram {
                min-width: 850px
            }

            .diagram-scroll {
                overflow: auto
            }
        }
    </style>
</head>

<body>
    <main>
        @unless ($pdf)
            <nav class="toolbar"><a href="/">Merchant portal</a> · <a href="/guide.pdf">Unduh panduan
                    PDF</a> · <a href="/openapi.json">OpenAPI</a></nav>
        @endunless
        <div class="tag">LUMEN GATEWAY / LARAVEL / SANDBOX ONLY</div>
        <h1>Contoh integrasi dengan Lumen Studio</h1>
        <div class="diagram-scroll"><img class="diagram" src="{{ $diagram }}"
                alt="Alur client, Lumen Studio, Laravel payment gateway, scan QR dan signed webhook">
        </div>
        <section class="page">
            <h1>Setup dan kontrak integrasi</h1>
            <table class="columns">
                <tr>
                    <td>
                        <h2>1. Jalankan dua aplikasi Laravel</h2>
                        <p>Lumen Studio dan gateway memakai document root <code>public/</code>,
                            environment serta APP_KEY masing-masing. Simpan transaksi gateway pada
                            MySQL/InnoDB. Node tidak diperlukan untuk backend gateway.</p>
                        <pre>php artisan key:generate
php artisan migrate --force
# Worker lokal gateway:
php artisan gateway:work</pre>
                        <p>Perintah setup dijalankan operator saat siap. Di shared hosting gunakan
                            cron <code>schedule:run</code> pada kedua aplikasi; gateway memiliki
                            <code>gateway:tick</code>, studio memiliki <code>studio:tick</code>.
                        </p>
                        <h2>2. Minta kredensial tanpa approval</h2>
                        <p>Buka <strong>{{ $base }}</strong> lalu buat workspace. Simpan API
                            secret, merchant ID, dan signing secret yang diterbitkan. Isi webhook
                            merchant:</p>
                        <pre>https://studio.example.com/webhooks/payments/simulator</pre>
                    </td>
                    <td>
                        <h2>3. Environment Lumen Studio</h2>
                        <pre>PAYMENT_DRIVER=simulator
GATEWAY_BASE_URL={{ $base }}
GATEWAY_API_KEY=sk_test_YOUR_KEY
GATEWAY_MERCHANT_ID=mer_YOUR_ID
GATEWAY_WEBHOOK_SECRET=whsec_test_YOUR_SECRET</pre>
                        <p>Sesudah perubahan environment, operator memperbarui config cache. Secret
                            hanya berada di backend. UI pembayaran menggunakan token checkout, bukan
                            API secret.</p>
                        <h2>4. Buat transaksi dari backend</h2>
                        <pre>POST /v1/payments
Authorization: Bearer sk_test_YOUR_KEY
Idempotency-Key: invoice-101-deposit-1

{"external_id":"INV-101-DP-1","amount":150000,
 "payment_method":"qris","expires_in":900}</pre>
                        <p>VA memakai <code>payment_method=virtual_account</code> dan
                            <code>bank_code</code> BCA/BNI/BRI/MANDIRI/PERMATA. Jumlah pembayaran
                            selalu mengikuti nominal yang disimpan server.
                        </p>
                    </td>
                </tr>
            </table>
        </section>
        <section class="page">
            <h1>QR, webhook, dan pengoperasian</h1>
            <table class="columns">
                <tr>
                    <td>
                        <h2>5. Scan QR untuk mencatat pembayaran</h2>
                        <p>QR berisi URL <code>/qris/{checkout_token}</code>. Membukanya langsung
                            mencatat pembayaran simulasi dan menampilkan konfirmasi pada browser.
                            Token yang sama tidak menghasilkan receipt kedua; nominal query tidak
                            dapat mengubah nominal tersimpan. Pembayaran expired/cancelled tidak
                            dapat dibayar melalui scan.</p>
                        <p>Untuk ponsel lokal, atur APP_URL gateway ke IP LAN komputer dan layani
                            gateway pada antarmuka yang dapat dijangkau. Untuk hosting publik
                            gunakan domain HTTPS sehingga tidak memerlukan Wi-Fi yang sama.</p>
                        <h2>6. Verifikasi receiver</h2>
                        <pre>HMAC_SHA256(webhook_secret,
  timestamp + "." + exact_raw_body)

X-Simulator-Event-Id
X-Simulator-Timestamp
X-Simulator-Signature</pre>
                        <p>Tolak signature tidak cocok atau timestamp di luar 300 detik. Lumen
                            Studio menyimpan inbox, memeriksa merchant/reference/amount dan
                            mengambil <code>GET /v1/payments/{id}</code> sebelum kredit. Return URL
                            bukan bukti pembayaran.</p>
                    </td>
                    <td>
                        <h2>7. Retry dan rekonsiliasi</h2>
                        <p>Gateway menyimpan event dan delivery di database, mengirim di luar
                            transaksi DB, memakai lease, dan retry setelah 5s, 30s, 2m, 10m, 30m,
                            dan 2h. Cron diperlukan agar antrean bergerak tanpa request browser.
                            Receiver mengakui event duplikat dengan 2xx. URL publik harus HTTPS/443;
                            redirect dan alamat jaringan privat diblokir.</p>
                        <p>Dana terlambat adalah kasus review, tidak mengaktifkan booking
                            kedaluwarsa. Refund pending/succeeded mencadangkan saldo refundable dan
                            tidak boleh melebihi dana settled.</p>
                        <h2>8. Shared hosting</h2>
                        <p>Gunakan PHP 8.4 dan ekstensi PDO MySQL, cURL, XML/XMLWriter, DOM,
                            mbstring, fileinfo, dan GD. Jalankan satu cron per aplikasi. Jika hanya
                            dapat cron sekali per menit, konfirmasi UI dapat tertunda hingga siklus
                            berikutnya.</p>
                        <p>Arsip Node/JSON lama tidak otomatis diimpor. Lumen Studio menyimpan
                            receipt historisnya; buat kredensial gateway Laravel baru dan perbarui
                            environment aplikasi. Jangan menghapus arsip data lama.</p>
                        <div class="note"><strong>Seluruh pembayaran adalah simulasi.</strong> QR
                            bukan payload QRIS bank, VA bukan rekening bank, dan tidak ada uang
                            nyata yang berpindah.</div>
                    </td>
                </tr>
            </table>
        </section>
    </main>
</body>

</html>
