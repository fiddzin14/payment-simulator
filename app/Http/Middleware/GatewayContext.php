<?php
namespace App\Http\Middleware;
use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\Str;
use App\Services\GatewayData;
class GatewayContext
{
    public function handle(Request $r, Closure $next)
    {
        $r->attributes->set('request_id', 'req_' . Str::uuid());
        $key = 'gateway:ip:' . hash('sha256', $r->ip());
        GatewayData::require(
            !RateLimiter::tooManyAttempts($key, 300),
            'RATE_LIMIT',
            'Too many requests. Retry shortly.',
            429,
        );
        RateLimiter::hit($key, 60);
        GatewayData::require(
            strlen($r->getContent()) <= 65536,
            'BODY_TOO_LARGE',
            'Maximum JSON body is 64 KB.',
            413,
        );
        if (!$r->isMethodSafe()) {
            $origin = $r->header('Origin');
            $base = parse_url(config('app.url'));
            $expected =
                ($base['scheme'] ?? 'https') .
                '://' .
                ($base['host'] ?? '') .
                (isset($base['port']) ? ':' . $base['port'] : '');
            GatewayData::require(
                !$origin || hash_equals($expected, $origin),
                'ORIGIN_REJECTED',
                'Use the portal from its own origin.',
                403,
            );
            GatewayData::require(
                !in_array($r->header('Sec-Fetch-Site'), ['cross-site'], true),
                'ORIGIN_REJECTED',
                'Cross-site requests are blocked.',
                403,
            );
            if ($r->getContent() !== '') {
                $body = json_decode($r->getContent());
                GatewayData::require(
                    json_last_error() === JSON_ERROR_NONE && is_object($body),
                    'INVALID_JSON',
                    'Supply a JSON object.',
                    400,
                );
            }
        }
        $response = $next($r);
        $response->headers->set('Cache-Control', 'no-store');
        $response->headers->set('X-Content-Type-Options', 'nosniff');
        $response->headers->set('Referrer-Policy', 'no-referrer');
        return $response;
    }
}
