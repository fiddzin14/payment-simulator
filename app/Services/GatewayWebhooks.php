<?php
namespace App\Services;
use App\Models\{GatewayEvent, Merchant};
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Throwable;
class GatewayWebhooks
{
    public function run(int $limit = 10): int
    {
        $count = 0;
        while ($count < $limit) {
            $event = DB::transaction(function () {
                $e = GatewayEvent::where(function ($q) {
                    $q->where(
                        fn($x) => $x
                            ->where('status', 'pending')
                            ->whereRaw('available_at <= UTC_TIMESTAMP(6)'),
                    )->orWhere(
                        fn($x) => $x
                            ->where('status', 'processing')
                            ->whereRaw('lease_until <= UTC_TIMESTAMP(6)'),
                    );
                })
                    ->orderBy('available_at')
                    ->lock('FOR UPDATE SKIP LOCKED')
                    ->first();
                if ($e && $e->attempts >= 7) {
                    $e->update([
                        'status' => 'failed',
                        'available_at' => null,
                        'lease_until' => null,
                        'lease_token' => null,
                    ]);
                    return null;
                }
                if ($e) {
                    $e->update([
                        'status' => 'processing',
                        'attempts' => $e->attempts + 1,
                        'lease_until' => GatewayData::now()->addSeconds(30),
                        'lease_token' => (string) Str::uuid(),
                    ]);
                }
                return $e;
            }, 3);
            if (!$event) {
                break;
            }
            $count++;
            $start = microtime(true);
            $status = null;
            $error = null;
            try {
                $merchant = Merchant::findOrFail($event->merchant_id);
                $raw = json_encode(
                    $event->payload,
                    JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR,
                );
                $timestamp = (string) time();
                $response = app(Destination::class)->deliver($event->target_url, $raw, [
                    'X-Simulator-Timestamp' => $timestamp,
                    'X-Simulator-Event-Id' => $event->id,
                    'X-Simulator-Signature' => hash_hmac(
                        'sha256',
                        $timestamp . '.' . $raw,
                        $merchant->webhook_secret,
                    ),
                    'User-Agent' => 'Lumen-Sandbox-Laravel/3.0',
                ]);
                $status = $response->status();
                if (!$response->successful()) {
                    $error = 'HTTP ' . $status;
                }
            } catch (Throwable $failure) {
                $error = 'Delivery failed: ' . class_basename($failure);
            }
            $duration = (int) round((microtime(true) - $start) * 1000);
            DB::transaction(function () use ($event, $status, $error, $duration): void {
                $e = GatewayEvent::whereKey($event->id)->lockForUpdate()->firstOrFail();
                if ($e->lease_token !== $event->lease_token || $e->status !== 'processing') {
                    return;
                }
                DB::table('gateway_deliveries')->insert([
                    'id' => GatewayData::id('dlv'),
                    'event_id' => $e->id,
                    'attempt' => $e->attempts,
                    'status_code' => $status,
                    'error' => $error,
                    'duration_ms' => $duration,
                    'at' => GatewayData::now(),
                    'created_at' => GatewayData::now(),
                    'updated_at' => GatewayData::now(),
                ]);
                if ($status >= 200 && $status < 300) {
                    $e->update([
                        'status' => 'delivered',
                        'delivered_at' => GatewayData::now(),
                        'available_at' => null,
                        'lease_until' => null,
                        'lease_token' => null,
                    ]);
                } else {
                    $retry = config('gateway.retry_seconds')[$e->attempts - 1] ?? null;
                    $e->update([
                        'status' => $retry === null ? 'failed' : 'pending',
                        'available_at' =>
                            $retry === null ? null : GatewayData::now()->addSeconds($retry),
                        'lease_until' => null,
                        'lease_token' => null,
                    ]);
                }
            }, 3);
        }
        return $count;
    }
    public function retry(GatewayEvent $event, bool $useCurrentUrl): void
    {
        DB::transaction(function () use ($event, $useCurrentUrl): void {
            $m = Merchant::whereKey($event->merchant_id)->lockForUpdate()->firstOrFail();
            $e = GatewayEvent::whereKey($event->id)->lockForUpdate()->firstOrFail();
            GatewayData::require(
                $e->status !== 'processing' ||
                    ($e->lease_until && $e->lease_until->lte(GatewayData::now())),
                'EVENT_BUSY',
                'This event is being delivered. Retry later.',
                409,
            );
            $target = $useCurrentUrl ? $m->webhook_url : $e->target_url;
            GatewayData::require(
                (bool) $target,
                'WEBHOOK_REQUIRED',
                'Configure a webhook before replay.',
            );
            app(Destination::class)->validate($target);
            $e->update([
                'target_url' => $target,
                'status' => 'pending',
                'attempts' => 0,
                'available_at' => GatewayData::now(),
                'lease_until' => null,
                'lease_token' => null,
            ]);
            GatewayData::audit($m, 'event.replayed', $e->id);
        }, 3);
    }
}
