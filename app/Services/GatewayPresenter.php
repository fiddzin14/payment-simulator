<?php
namespace App\Services;
use App\Models\{Credential, GatewayEvent, Merchant, Payment, Refund};
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;
class GatewayPresenter
{
    public static function date($value): ?string
    {
        return $value ? CarbonImmutable::parse($value, 'UTC')->toISOString() : null;
    }
    public static function base(): string
    {
        return rtrim(config('app.url'), '/');
    }
    public static function merchant(Merchant $m): array
    {
        return [
            'id' => $m->id,
            'name' => $m->name,
            'email' => $m->email,
            'webhook_url' => $m->webhook_url,
            'created_at' => self::date($m->created_at),
            'mode' => 'test',
            'email_verified' => false,
        ];
    }
    public static function credential(Credential $c): array
    {
        return [
            'id' => $c->id,
            'name' => $c->name,
            'prefix' => $c->prefix,
            'last_four' => $c->last_four,
            'created_at' => self::date($c->created_at),
            'revoked_at' => self::date($c->revoked_at),
            'last_used_at' => self::date($c->last_used_at),
        ];
    }
    public static function payment(Payment $p): array
    {
        $base = self::base();
        $token = $p->checkout_token;
        return [
            'id' => $p->id,
            'merchant_id' => $p->merchant_id,
            'external_id' => $p->external_id,
            'amount' => $p->amount,
            'currency' => 'IDR',
            'payment_method' => $p->payment_method,
            'bank_code' => $p->bank_code,
            'account_number' => $p->account_number,
            'account_name' => $p->account_name,
            'status' => $p->status,
            'paid_amount' => $p->paid_amount,
            'refunded_amount' => $p->refunded_amount,
            'late_received_amount' => $p->late_received_amount,
            'description' => $p->description,
            'customer_name' => $p->customer_name,
            'return_url' => $p->return_url,
            'expires_in' => $p->expires_in,
            'created_at' => self::date($p->created_at),
            'expires_at' => self::date($p->expires_at),
            'paid_at' => self::date($p->paid_at),
            'checkout_url' => $base . '/pay/' . $token,
            'qr_string' =>
                $p->payment_method === 'qris'
                    ? $base . '/qris/' . $token . '?amount=' . $p->amount
                    : null,
            'qr_image_url' =>
                $p->payment_method === 'qris'
                    ? $base . '/checkout-api/' . $token . '/qr.svg'
                    : null,
            'simulation_only' => true,
        ];
    }
    public static function refund(Refund $r): array
    {
        return [
            'id' => $r->id,
            'merchant_id' => $r->merchant_id,
            'payment_id' => $r->payment_id,
            'amount' => $r->amount,
            'reason' => $r->reason,
            'currency' => 'IDR',
            'status' => $r->status,
            'created_at' => self::date($r->created_at),
            'succeeded_at' => self::date($r->succeeded_at),
            'failed_at' => self::date($r->failed_at),
        ];
    }
    public static function event(GatewayEvent $e): array
    {
        return [
            'id' => $e->id,
            'payment_id' => $e->payment_id,
            'payload' => $e->payload,
            'target_url' => $e->target_url,
            'status' => $e->status,
            'created_at' => self::date($e->created_at),
            'retry_count' => max(0, $e->attempts - 1),
            'next_attempt_at' => self::date($e->available_at),
            'deliveries' => DB::table('gateway_deliveries')
                ->where('event_id', $e->id)
                ->orderBy('created_at')
                ->get()
                ->map(
                    fn($d) => [
                        'at' => self::date($d->at),
                        'http_status' => $d->status_code,
                        'ok' => $d->status_code >= 200 && $d->status_code < 300,
                        'error' => $d->error,
                        'duration_ms' => $d->duration_ms,
                    ],
                )
                ->all(),
        ];
    }
}
