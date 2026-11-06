<?php
use Illuminate\Support\Facades\{Artisan, Schedule};
use App\Services\{GatewayPayments, GatewayWebhooks};
Artisan::command('gateway:tick', function (): void {
    app(GatewayPayments::class)->expireDue();
    app(GatewayWebhooks::class)->run();
})->purpose('Expire sandbox instruments and deliver signed webhooks');
Artisan::command('gateway:work', function (): void {
    $this->info('Gateway worker running. Ctrl+C to stop.');
    while (true) {
        try {
            Artisan::call('gateway:tick');
        } catch (Throwable $error) {
            report($error);
            $this->error('Gateway cycle failed; inspect application logs.');
        }
        sleep(1);
    }
})->purpose('Local development gateway worker');
Schedule::command('gateway:tick')->everyTenSeconds()->withoutOverlapping();
