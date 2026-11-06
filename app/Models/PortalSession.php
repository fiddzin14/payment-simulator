<?php
namespace App\Models;
class PortalSession extends GatewayRecord
{
    protected $table = 'gateway_sessions';
    protected $hidden = ['token_hash'];
    protected function casts(): array
    {
        return ['expires_at' => 'immutable_datetime'];
    }
}
