<?php
use App\Http\Controllers\GatewayController;
use App\Http\Middleware\GatewayContext;
use Illuminate\Support\Facades\Route;
Route::get('/', fn() => response()->file(public_path('portal.html')));
Route::get('/docs', [App\Http\Controllers\GuideController::class, 'show']);
Route::get('/guide.pdf', [App\Http\Controllers\GuideController::class, 'pdf']);
Route::get(
    '/openapi.json',
    fn() => response()->file(base_path('docs/openapi.json'), [
        'Content-Type' => 'application/json',
    ]),
);
Route::get('/pay/{token}', fn() => response()->file(public_path('checkout-v2.html')));
Route::get('/issuer/{token}', fn() => response()->file(public_path('checkout-v2.html')));
Route::get('/qris/{token}', [GatewayController::class, 'scan'])->middleware(GatewayContext::class);
Route::get(
    '/health',
    fn() => response()->json(['status' => 'ok', 'runtime' => 'laravel', 'simulation_only' => true]),
);
