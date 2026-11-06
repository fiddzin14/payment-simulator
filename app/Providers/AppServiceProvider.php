<?php
namespace App\Providers;
use Illuminate\Support\ServiceProvider;
class AppServiceProvider extends ServiceProvider
{
    public function register(): void {}
    public function boot(): void
    {
        $url = parse_url(config('app.url'));
        if (
            !is_array($url) ||
            !isset($url['scheme'], $url['host']) ||
            !in_array($url['scheme'], ['http', 'https'], true) ||
            !in_array($url['path'] ?? '', ['', '/'], true) ||
            isset($url['user']) ||
            isset($url['pass']) ||
            isset($url['query']) ||
            isset($url['fragment'])
        ) {
            throw new \RuntimeException(
                'Gateway APP_URL must be an absolute origin without a subdirectory, credentials, query or fragment.',
            );
        }
        if (
            app()->environment('production') &&
            ($url['scheme'] !== 'https' || ($url['port'] ?? 443) !== 443)
        ) {
            throw new \RuntimeException('Production gateway APP_URL must use HTTPS port 443.');
        }
    }
}
