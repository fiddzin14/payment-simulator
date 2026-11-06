<?php
use App\Http\Controllers\GatewayController as Gateway;
use Illuminate\Support\Facades\Route;
Route::post('/portal/register', [Gateway::class, 'register']);
Route::post('/portal/login', [Gateway::class, 'login']);
Route::prefix('portal')
    ->middleware('gateway.auth:portal')
    ->group(function (): void {
        Route::post('/logout', [Gateway::class, 'logout']);
        Route::get('/state', [Gateway::class, 'state']);
        Route::post('/credentials', [Gateway::class, 'credential']);
        Route::post('/credentials/{id}/revoke', [Gateway::class, 'revoke']);
        Route::post('/webhook', [Gateway::class, 'webhook']);
        Route::post('/webhook/rotate', [Gateway::class, 'rotate']);
        Route::post('/payments', [Gateway::class, 'create']);
        Route::post('/payments/{id}/simulate', [Gateway::class, 'simulate']);
        Route::post('/payments/{id}/refunds', [Gateway::class, 'refundCreate']);
        Route::post('/refunds/{id}/simulate', [Gateway::class, 'refundSimulate']);
        Route::post('/refunds/{id}/retry', [Gateway::class, 'refundRetry']);
        Route::post('/events/{id}/retry', [Gateway::class, 'replay']);
    });
Route::prefix('v1')
    ->middleware('gateway.auth:api')
    ->group(function (): void {
        Route::get('/payment-methods', [Gateway::class, 'methods']);
        Route::get('/payments', [Gateway::class, 'listing']);
        Route::post('/payments', [Gateway::class, 'create']);
        Route::get('/payments/{id}', [Gateway::class, 'show']);
        Route::post('/payments/{id}/cancel', [Gateway::class, 'cancel']);
        Route::post('/payments/{id}/refunds', [Gateway::class, 'refundCreate']);
        Route::get('/refunds/{id}', [Gateway::class, 'refundShow']);
    });
Route::get('/checkout-api/{token}', [Gateway::class, 'checkout']);
Route::get('/checkout-api/{token}/qr.svg', [Gateway::class, 'qr']);
Route::post('/checkout-api/{token}/simulate', [Gateway::class, 'checkoutSimulate']);
