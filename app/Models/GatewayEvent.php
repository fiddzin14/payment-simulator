<?php
namespace App\Models;
class GatewayEvent extends GatewayRecord
{
    protected $table = 'gateway_events';
    protected function casts(): array
    {
        return [
            'payload' => 'array',
            'attempts' => 'integer',
            'available_at' => 'immutable_datetime',
            'lease_until' => 'immutable_datetime',
            'delivered_at' => 'immutable_datetime',
        ];
    }
}
