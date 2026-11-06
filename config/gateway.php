<?php
return [
    'allow_local_callbacks' => env('ALLOW_LOCAL_WEBHOOKS', false),
    'session_cookie' => 'lumen_gateway_portal',
    'session_hours' => 24,
    'retry_seconds' => [5, 30, 120, 600, 1800, 7200],
    'api_version' => '2026-11-04',
];
