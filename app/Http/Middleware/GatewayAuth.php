<?php
namespace App\Http\Middleware;
use App\Models\{Credential, Merchant, PortalSession};
use App\Services\GatewayData;
use Closure;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Http\Request;
class GatewayAuth
{
    public function handle(Request $r, Closure $next, string $kind)
    {
        $bearer = $r->bearerToken();
        if ($kind === 'api') {
            GatewayData::require(
                $bearer && str_starts_with($bearer, 'sk_test_'),
                'INVALID_API_KEY',
                'Use a test API secret key.',
                401,
            );
            $key = Credential::where('token_hash', hash('sha256', $bearer))
                ->whereNull('revoked_at')
                ->first();
            GatewayData::require(
                (bool) $key,
                'INVALID_API_KEY',
                'API key is invalid or revoked.',
                401,
            );
            $key->update(['last_used_at' => GatewayData::now()]);
            $merchantId = $key->merchant_id;
            $r->attributes->set('credential', $key);
        } else {
            $token = $bearer ?: $r->cookie(config('gateway.session_cookie'));
            GatewayData::require(
                is_string($token) && str_starts_with($token, 'sess_'),
                'SESSION_REQUIRED',
                'Sign in to the merchant workspace.',
                401,
            );
            if (!$bearer && !$r->isMethodSafe()) {
                GatewayData::require(
                    (bool) $r->header('Origin'),
                    'ORIGIN_REQUIRED',
                    'Cookie-authenticated writes require a same-origin request.',
                    403,
                );
            }
            $session = PortalSession::where('token_hash', hash('sha256', $token))
                ->whereRaw('expires_at > UTC_TIMESTAMP(6)')
                ->first();
            GatewayData::require(
                (bool) $session,
                'SESSION_EXPIRED',
                'Session expired. Sign in again.',
                401,
            );
            $merchantId = $session->merchant_id;
            $r->attributes->set('portal_session', $session);
        }
        $bucket = 'gateway:merchant:' . $merchantId;
        GatewayData::require(
            !RateLimiter::tooManyAttempts($bucket, 120),
            'RATE_LIMIT',
            'Merchant request limit reached.',
            429,
        );
        RateLimiter::hit($bucket, 60);
        $r->attributes->set('merchant', Merchant::findOrFail($merchantId));
        return $next($r);
    }
}
