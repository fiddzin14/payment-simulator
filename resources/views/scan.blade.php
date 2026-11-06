<!doctype html>
<html lang="id">

<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="referrer" content="no-referrer">
    <title>{{ $error ? 'QRIS tidak tersedia' : 'QRIS simulasi diterima' }}</title>
    <style>
        body {
            margin: 0;
            background: #f4f3ff;
            color: #19223d;
            font: 16px system-ui, sans-serif;
            display: grid;
            min-height: 100dvh;
            place-items: center
        }

        .card {
            box-sizing: border-box;
            background: #fff;
            border-radius: 24px;
            padding: 38px 26px;
            margin: 20px;
            max-width: 420px;
            text-align: center;
            box-shadow: 0 20px 60px #5154ed18
        }

        .icon {
            background: #e0f7e9;
            color: #208153;
            border-radius: 50%;
            font-size: 36px;
            width: 76px;
            height: 76px;
            display: grid;
            place-items: center;
            margin: 0 auto 24px
        }

        .tag {
            color: #5154ed;
            font-weight: 700;
            font-size: 11px;
            letter-spacing: 1.4px
        }

        h1 {
            font-size: 30px;
            letter-spacing: -1px;
            line-height: 1.15
        }

        strong {
            font-size: 32px;
            color: #5154ed
        }

        p {
            font-size: 14px;
            line-height: 1.8;
            color: #68728a
        }

        .reference {
            background: #f6f6fc;
            padding: 14px;
            overflow-wrap: anywhere;
            border-radius: 12px;
            font-size: 12px
        }

        .note {
            font-size: 11px
        }
    </style>
</head>

<body>
    <main class="card">
        <div class="icon">{{ $error ? '!' : '✓' }}</div>
        <div class="tag">LUMEN GATEWAY / LARAVEL SANDBOX</div>
        @if ($error)
            <h1>QRIS tidak tersedia.</h1>
            <p>{{ $error }}</p>
        @else<h1>Pembayaran QRIS<br>sudah diterima.</h1>
            <strong>Rp{{ number_format($payment['amount'], 0, ',', '.') }}</strong>
            <p>{{ $merchant }}</p>
            <div class="reference">{{ $payment['external_id'] }}</div>
            <p>Status aplikasi merchant diperbarui melalui webhook. Kamu boleh menutup halaman ini.
            </p>
        @endif
        <p class="note">Simulasi pembayaran. Tidak ada uang atau saldo bank yang dipindahkan.</p>
    </main>
</body>

</html>
