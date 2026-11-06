<?php
namespace App\Services;
use Illuminate\Support\Facades\Http;
use Symfony\Component\HttpFoundation\IpUtils;
class Destination
{
    public function allowLocal(): bool
    {
        return app()->environment(['local', 'testing']) &&
            (bool) config('gateway.allow_local_callbacks');
    }
    public function validate(?string $value): ?string
    {
        if (!$value) {
            return null;
        }
        $u = parse_url($value);
        GatewayData::require(
            is_array($u) &&
                isset($u['scheme'], $u['host']) &&
                !isset($u['user']) &&
                !isset($u['pass']) &&
                !isset($u['fragment']) &&
                strlen($value) <= 1000,
            'INVALID_URL',
            'Supply an absolute URL without credentials or a fragment.',
        );
        $host = strtolower(trim($u['host'], '[]'));
        $local = in_array($host, ['localhost', '127.0.0.1', '::1'], true);
        if ($local) {
            GatewayData::require(
                $this->allowLocal() && $u['scheme'] === 'http',
                'LOCAL_URL_DISABLED',
                'Loopback HTTP callbacks are local-development only.',
            );
        } else {
            GatewayData::require(
                $u['scheme'] === 'https' &&
                    ($u['port'] ?? 443) === 443 &&
                    preg_match('/^[a-z0-9.:-]+$/iD', $host),
                'HTTPS_REQUIRED',
                'Public URLs must use HTTPS port 443.',
            );
            if (filter_var($host, FILTER_VALIDATE_IP)) {
                GatewayData::require(
                    $this->publicIp($host),
                    'PRIVATE_ADDRESS',
                    'Private and reserved addresses are blocked.',
                );
            }
        }
        return $value;
    }
    private function publicIp(string $ip): bool
    {
        return (bool) filter_var(
            $ip,
            FILTER_VALIDATE_IP,
            FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE,
        ) &&
            !IpUtils::checkIp($ip, [
                '100.64.0.0/10',
                '192.0.0.0/24',
                '192.0.2.0/24',
                '198.18.0.0/15',
                '198.51.100.0/24',
                '203.0.113.0/24',
                '2001:db8::/32',
                '2002::/16',
                '2001::/32',
                '::ffff:0:0/96',
            ]);
    }
    public function deliver(string $url, string $raw, array $headers)
    {
        $this->validate($url);
        $u = parse_url($url);
        $host = strtolower(trim($u['host'], '[]'));
        $port = (int) ($u['port'] ?? ($u['scheme'] === 'https' ? 443 : 80));
        $local = in_array($host, ['localhost', '127.0.0.1', '::1'], true);
        $addresses = $local
            ? [$host === '::1' ? '::1' : '127.0.0.1']
            : (filter_var($host, FILTER_VALIDATE_IP)
                ? [$host]
                : array_values(
                    array_filter(
                        array_merge(
                            array_column(dns_get_record($host, DNS_A) ?: [], 'ip'),
                            array_column(dns_get_record($host, DNS_AAAA) ?: [], 'ipv6'),
                        ),
                    ),
                ));
        GatewayData::require(
            count($addresses) > 0,
            'DNS_UNAVAILABLE',
            'Webhook DNS is unavailable.',
        );
        foreach ($addresses as $ip) {
            GatewayData::require(
                $local || $this->publicIp($ip),
                'PRIVATE_ADDRESS',
                'Webhook DNS resolved to a private/reserved address.',
            );
        }
        $ip = $addresses[0];
        $pin = str_contains($ip, ':') ? '[' . $ip . ']' : $ip;
        return Http::withoutRedirecting()
            ->connectTimeout(2)
            ->timeout(4)
            ->withOptions([
                'verify' => true,
                'proxy' => '',
                'curl' => filter_var($host, FILTER_VALIDATE_IP)
                    ? []
                    : [CURLOPT_RESOLVE => [$host . ':' . $port . ':' . $pin]],
            ])
            ->withHeaders($headers)
            ->withBody($raw, 'application/json')
            ->post($url);
    }
}
