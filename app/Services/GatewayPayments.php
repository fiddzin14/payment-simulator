<?php
namespace App\Services;
use App\Exceptions\GatewayError;
use App\Models\{Merchant, Payment, Refund};
use Illuminate\Support\Facades\DB;
class GatewayPayments
{
    public const BANKS = [
        'BCA' => '99901',
        'BNI' => '99902',
        'BRI' => '99903',
        'MANDIRI' => '99904',
        'PERMATA' => '99905',
    ];

    public function create(
        Merchant $merchant,
        array $input,
        string $key,
        ?string $credential = null,
    ): Payment {
        $method = $input['payment_method'];
        $normalized = [
            'external_id' => trim($input['external_id']),
            'amount' => (int) $input['amount'],
            'currency' => $input['currency'] ?? 'IDR',
            'payment_method' => $method,
            'bank_code' =>
                $method === 'virtual_account' ? strtoupper($input['bank_code'] ?? '') : null,
            'expires_in' => (int) ($input['expires_in'] ?? ($method === 'qris' ? 900 : 86400)),
            'description' => trim($input['description'] ?? ''),
            'customer_name' => trim($input['customer_name'] ?? ''),
            'return_url' => app(Destination::class)->validate($input['return_url'] ?? null),
        ];
        GatewayData::require(
            $normalized['amount'] <= ($method === 'qris' ? 10000000 : 100000000),
            'INVALID_AMOUNT',
            'Amount exceeds the channel limit.',
        );
        GatewayData::require(
            $normalized['expires_in'] >= 60 &&
                $normalized['expires_in'] <= ($method === 'qris' ? 3600 : 604800),
            'INVALID_EXPIRY',
            'Expiry is outside the channel limits.',
        );
        GatewayData::require(
            $method !== 'virtual_account' || isset(self::BANKS[$normalized['bank_code']]),
            'INVALID_BANK',
            'Choose a supported virtual-account bank.',
        );
        return DB::transaction(function () use (
            $merchant,
            $normalized,
            $credential,
            $key,
        ): Payment {
            $m = Merchant::whereKey($merchant->id)->lockForUpdate()->firstOrFail();
            $id = GatewayData::idempotent($m, 'payment', $key, $normalized, function () use (
                $m,
                $normalized,
                $credential,
            ): string {
                GatewayData::require(
                    !Payment::where('merchant_id', $m->id)
                        ->where('external_id', $normalized['external_id'])
                        ->exists(),
                    'REFERENCE_EXISTS',
                    'external_id is already used. Create a new reference.',
                    409,
                );
                $account = null;
                if ($normalized['payment_method'] === 'virtual_account') {
                    do {
                        $account =
                            self::BANKS[$normalized['bank_code']] .
                            str_pad((string) random_int(0, 99999999999), 11, '0', STR_PAD_LEFT);
                    } while (Payment::where('account_number', $account)->exists());
                }
                $token = GatewayData::token('cs_test_');
                $p = Payment::create([
                    'id' => GatewayData::id('pay'),
                    'merchant_id' => $m->id,
                    'credential_id' => $credential,
                    ...$normalized,
                    'account_number' => $account,
                    'account_name' => mb_substr('SIM ' . $m->name, 0, 50),
                    'checkout_token' => $token,
                    'checkout_hash' => hash('sha256', $token),
                    'webhook_url' => $m->webhook_url,
                    'status' => 'pending',
                    'paid_amount' => 0,
                    'refunded_amount' => 0,
                    'late_received_amount' => 0,
                    'expires_at' => GatewayData::now()->addSeconds($normalized['expires_in']),
                ]);
                GatewayData::event($m, $p, 'payment.pending');
                GatewayData::audit($m, 'payment.created', $p->id);
                return $p->id;
            });
            return Payment::where('merchant_id', $m->id)->findOrFail($id);
        }, 3);
    }

    public function refresh(Payment $payment): Payment
    {
        return DB::transaction(function () use ($payment): Payment {
            $m = Merchant::whereKey($payment->merchant_id)->lockForUpdate()->firstOrFail();
            $p = Payment::whereKey($payment->id)->lockForUpdate()->firstOrFail();
            if ($p->status === 'pending' && $p->expires_at->lte(GatewayData::now())) {
                $p->update(['status' => 'expired']);
                GatewayData::event($m, $p, 'payment.expired');
                GatewayData::audit($m, 'payment.expired', $p->id);
            }
            return $p;
        }, 3);
    }

    public function checkout(string $token): Payment
    {
        GatewayData::require(
            (bool) preg_match('/^cs_test_[a-f0-9]{56}$/D', $token),
            'CHECKOUT_NOT_FOUND',
            'Checkout is not available.',
            404,
        );
        $p = Payment::where('checkout_hash', hash('sha256', $token))->first();
        GatewayData::require((bool) $p, 'CHECKOUT_NOT_FOUND', 'Checkout is not available.', 404);
        return $this->refresh($p);
    }

    public function simulate(
        Payment $payment,
        array $input,
        bool $authorizedLate = false,
        bool $scan = false,
    ): Payment {
        $payment = $this->refresh($payment);
        return DB::transaction(function () use ($payment, $input, $authorizedLate, $scan): Payment {
            $m = Merchant::whereKey($payment->merchant_id)->lockForUpdate()->firstOrFail();
            $p = Payment::whereKey($payment->id)->lockForUpdate()->firstOrFail();
            if ($scan) {
                GatewayData::require(
                    $p->payment_method === 'qris',
                    'CHECKOUT_NOT_FOUND',
                    'This QR checkout is unavailable.',
                    404,
                );
                if ($p->status === 'paid') {
                    return $p;
                }
            }
            $outcome = $input['outcome'];
            if ($outcome === 'paid') {
                $amount = (int) ($input['amount'] ?? $p->amount);
                GatewayData::require(
                    $amount === $p->amount,
                    'AMOUNT_MISMATCH',
                    'Closed-amount payments require the exact amount. No funds were recorded.',
                );
                $reference = $input['bank_reference'] ?? 'SIM-' . bin2hex(random_bytes(12));
                $old = DB::table('gateway_receipts')->where('bank_reference', $reference)->first();
                if ($old) {
                    GatewayData::require(
                        $old->payment_id === $p->id && (int) $old->amount === $amount,
                        'BANK_REFERENCE_USED',
                        'Bank reference has already been used.',
                        409,
                    );
                    return $p;
                }
                GatewayData::require(
                    $p->status !== 'paid',
                    'ALREADY_PAID',
                    'Payment has already been credited.',
                    409,
                );
                $late = $p->status !== 'pending' || $p->expires_at->lte(GatewayData::now());
                GatewayData::require(
                    !$late || ($authorizedLate && ($input['late_payment'] ?? false)),
                    'PAYMENT_CLOSED',
                    'This payment has expired or closed.',
                    $scan ? 410 : 409,
                );
                DB::table('gateway_receipts')->insert([
                    'id' => GatewayData::id('rcpt'),
                    'merchant_id' => $m->id,
                    'payment_id' => $p->id,
                    'amount' => $amount,
                    'bank_reference' => $reference,
                    'needs_review' => $late,
                    'created_at' => GatewayData::now(),
                    'updated_at' => GatewayData::now(),
                ]);
                if ($late) {
                    $p->late_received_amount += $amount;
                    $p->save();
                    GatewayData::event($m, $p, 'payment.late_received', [
                        'received_amount' => $amount,
                        'needs_review' => true,
                    ]);
                } else {
                    $p->update([
                        'status' => 'paid',
                        'paid_amount' => $amount,
                        'paid_at' => GatewayData::now(),
                    ]);
                    GatewayData::event($m, $p, 'payment.paid');
                }
                GatewayData::audit($m, $late ? 'payment.late-received' : 'payment.paid', $p->id);
            } else {
                GatewayData::require(
                    $p->status === 'pending' && $p->expires_at->gt(GatewayData::now()),
                    'PAYMENT_CLOSED',
                    'Payment is no longer pending.',
                    409,
                );
                if ($outcome !== 'pending') {
                    $p->update(['status' => $outcome]);
                    GatewayData::event($m, $p, 'payment.' . $outcome);
                    GatewayData::audit($m, 'payment.' . $outcome, $p->id);
                }
            }
            return $p;
        }, 3);
    }

    public function cancel(Payment $p): Payment
    {
        $p = $this->refresh($p);
        return $p->status === 'cancelled' ? $p : $this->simulate($p, ['outcome' => 'cancelled']);
    }

    public function refund(Payment $payment, array $input, string $key): Refund
    {
        $normalized = ['amount' => (int) $input['amount'], 'reason' => trim($input['reason'])];
        return DB::transaction(function () use ($payment, $normalized, $key): Refund {
            $m = Merchant::whereKey($payment->merchant_id)->lockForUpdate()->firstOrFail();
            $p = Payment::whereKey($payment->id)->lockForUpdate()->firstOrFail();
            $id = GatewayData::idempotent(
                $m,
                'refund:' . $p->id,
                $key,
                $normalized,
                function () use ($m, $p, $normalized): string {
                    GatewayData::require(
                        $p->status === 'paid',
                        'PAYMENT_NOT_PAID',
                        'Only settled payments can be refunded.',
                        409,
                    );
                    $reserved = (int) Refund::where('payment_id', $p->id)
                        ->whereIn('status', ['pending', 'succeeded'])
                        ->sum('amount');
                    GatewayData::require(
                        $normalized['amount'] <= $p->paid_amount - $reserved,
                        'REFUND_EXCEEDS_PAYMENT',
                        'Refund exceeds unreserved settled funds.',
                    );
                    $r = Refund::create([
                        'id' => GatewayData::id('ref'),
                        'merchant_id' => $m->id,
                        'payment_id' => $p->id,
                        ...$normalized,
                        'status' => 'pending',
                    ]);
                    GatewayData::event($m, $p, 'refund.pending', [
                        'refund_id' => $r->id,
                        'refund_amount' => $r->amount,
                    ]);
                    GatewayData::audit($m, 'refund.requested', $r->id);
                    return $r->id;
                },
            );
            return Refund::where('merchant_id', $m->id)->findOrFail($id);
        }, 3);
    }

    public function refundOutcome(Refund $refund, string $outcome): Refund
    {
        return DB::transaction(function () use ($refund, $outcome): Refund {
            $m = Merchant::whereKey($refund->merchant_id)->lockForUpdate()->firstOrFail();
            $p = Payment::whereKey($refund->payment_id)->lockForUpdate()->firstOrFail();
            $r = Refund::whereKey($refund->id)->lockForUpdate()->firstOrFail();
            if ($r->status === $outcome) {
                return $r;
            }
            GatewayData::require(
                $r->status === 'pending',
                'REFUND_CLOSED',
                'Refund is no longer pending.',
                409,
            );
            $r->update([
                'status' => $outcome,
                $outcome === 'succeeded' ? 'succeeded_at' : 'failed_at' => GatewayData::now(),
            ]);
            if ($outcome === 'succeeded') {
                $p->refunded_amount += $r->amount;
                $p->save();
            }
            GatewayData::event($m, $p, 'refund.' . $outcome, [
                'refund_id' => $r->id,
                'refund_amount' => $r->amount,
            ]);
            GatewayData::audit($m, 'refund.' . $outcome, $r->id);
            return $r;
        }, 3);
    }

    public function retryRefund(Refund $refund): Refund
    {
        return DB::transaction(function () use ($refund): Refund {
            $m = Merchant::whereKey($refund->merchant_id)->lockForUpdate()->firstOrFail();
            $p = Payment::whereKey($refund->payment_id)->lockForUpdate()->firstOrFail();
            $r = Refund::whereKey($refund->id)->lockForUpdate()->firstOrFail();
            GatewayData::require(
                $r->status === 'failed',
                'REFUND_NOT_FAILED',
                'Only failed refunds can be retried.',
                409,
            );
            $reserved = (int) Refund::where('payment_id', $p->id)
                ->whereIn('status', ['pending', 'succeeded'])
                ->sum('amount');
            GatewayData::require(
                $r->amount <= $p->paid_amount - $reserved,
                'REFUND_EXCEEDS_PAYMENT',
                'Settled funds are reserved by another refund.',
            );
            $r->update(['status' => 'pending', 'failed_at' => null]);
            GatewayData::event($m, $p, 'refund.pending', [
                'refund_id' => $r->id,
                'refund_amount' => $r->amount,
            ]);
            GatewayData::audit($m, 'refund.retried', $r->id);
            return $r;
        }, 3);
    }

    public function expireDue(int $limit = 100): int
    {
        $count = 0;
        foreach (
            Payment::where('status', 'pending')
                ->whereRaw('expires_at <= UTC_TIMESTAMP(6)')
                ->orderBy('expires_at')
                ->limit($limit)
                ->get()
            as $p
        ) {
            $this->refresh($p);
            $count++;
        }
        return $count;
    }
}
