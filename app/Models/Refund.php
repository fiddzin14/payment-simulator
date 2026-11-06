<?php
namespace App\Models;
class Refund extends GatewayRecord
{
    protected $table = 'gateway_refunds';
    protected function casts(): array
    {
        return [
            'amount' => 'integer',
            'succeeded_at' => 'immutable_datetime',
            'failed_at' => 'immutable_datetime',
        ];
    }
}
