<?php
return [
    'defaults' => ['guard' => 'web', 'passwords' => 'merchants'],
    'guards' => ['web' => ['driver' => 'session', 'provider' => 'merchants']],
    'providers' => ['merchants' => ['driver' => 'eloquent', 'model' => App\Models\Merchant::class]],
];
