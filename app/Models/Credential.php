<?php
namespace App\Models;
class Credential extends GatewayRecord
{
    protected $table = 'gateway_credentials';
    protected $hidden = ['token_hash'];
    protected function casts(): array
    {
        return ['revoked_at' => 'immutable_datetime', 'last_used_at' => 'immutable_datetime'];
    }
}
