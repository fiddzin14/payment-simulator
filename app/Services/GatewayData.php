<?php
namespace App\Services;
use App\Exceptions\GatewayError;
use App\Models\{GatewayEvent, Merchant, Payment};
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
class GatewayData
{
    public static function id(string $prefix): string
    {
        return $prefix . '_' . Str::ulid();
    }
    public static function token(string $prefix): string
    {
        return $prefix . bin2hex(random_bytes(28));
    }
    public static function now(): CarbonImmutable
    {
        return CarbonImmutable::parse(
            DB::selectOne('SELECT UTC_TIMESTAMP(6) AS moment')->moment,
            'UTC',
        );
    }
    public static function require(
        bool $condition,
        string $code,
        string $message,
        int $status = 422,
    ): void {
        if (!$condition) {
            throw new GatewayError($code, $message, $status);
        }
    }
    public static function audit(Merchant $m, string $action, ?string $resource = null): void
    {
        DB::table('gateway_audits')->insert([
            'id' => self::id('log'),
            'merchant_id' => $m->id,
            'action' => $action,
            'subject_id' => $resource,
            'created_at' => self::now(),
            'updated_at' => self::now(),
        ]);
    }
    public static function event(
        Merchant $m,
        Payment $p,
        string $type,
        array $extra = [],
    ): GatewayEvent {
        $id = self::id('evt');
        $now = self::now();
        $target = $p->webhook_url ?: $m->webhook_url;
        $payload = [
            'id' => $id,
            'type' => $type,
            'api_version' => config('gateway.api_version'),
            'created_at' => $now->toISOString(),
            'data' => [
                'payment_id' => $p->id,
                'merchant_id' => $m->id,
                'external_id' => $p->external_id,
                'amount' => $p->amount,
                'currency' => 'IDR',
                'payment_method' => $p->payment_method,
                'bank_code' => $p->bank_code,
                'status' => $p->status,
                'paid_amount' => $p->paid_amount,
                'refunded_amount' => $p->refunded_amount,
                ...$extra,
            ],
        ];
        return GatewayEvent::create([
            'id' => $id,
            'merchant_id' => $m->id,
            'payment_id' => $p->id,
            'type' => $type,
            'payload' => $payload,
            'target_url' => $target,
            'status' => $target ? 'pending' : 'unconfigured',
            'available_at' => $now,
        ]);
    }
    public static function hash(array $data): string
    {
        $sort = function ($value) use (&$sort) {
            if (!is_array($value)) {
                return $value;
            }
            if (!array_is_list($value)) {
                ksort($value, SORT_STRING);
            }
            return array_map($sort, $value);
        };
        return hash(
            'sha256',
            json_encode(
                $sort($data),
                JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR,
            ),
        );
    }
    public static function idempotent(
        Merchant $m,
        string $scope,
        string $key,
        array $input,
        callable $create,
    ): string {
        self::require(
            strlen($key) >= 8 && strlen($key) <= 100,
            'IDEMPOTENCY_REQUIRED',
            'Supply Idempotency-Key with 8–100 characters.',
        );
        $hash = self::hash($input);
        $old = DB::table('gateway_idempotencies')
            ->where('merchant_id', $m->id)
            ->where('scope', $scope)
            ->where('request_key', $key)
            ->first();
        if ($old) {
            self::require(
                hash_equals($old->request_hash, $hash),
                'IDEMPOTENCY_CONFLICT',
                'Key already used with a different payload.',
                409,
            );
            return $old->resource_id;
        }
        $id = $create();
        DB::table('gateway_idempotencies')->insert([
            'id' => self::id('idem'),
            'merchant_id' => $m->id,
            'scope' => $scope,
            'request_key' => $key,
            'request_hash' => $hash,
            'resource_id' => $id,
            'created_at' => self::now(),
            'updated_at' => self::now(),
        ]);
        return $id;
    }
}
