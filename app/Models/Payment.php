<?php
namespace App\Models;
class Payment extends GatewayRecord
{
    protected $table = 'gateway_payments';
    protected $hidden = ['checkout_token', 'checkout_hash', 'webhook_url'];
    protected function casts(): array
    {
        return [
            'checkout_token' => 'encrypted',
            'amount' => 'integer',
            'expires_in' => 'integer',
            'paid_amount' => 'integer',
            'refunded_amount' => 'integer',
            'late_received_amount' => 'integer',
            'expires_at' => 'immutable_datetime',
            'paid_at' => 'immutable_datetime',
        ];
    }
}
