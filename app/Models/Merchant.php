<?php
namespace App\Models;
use Illuminate\Foundation\Auth\User as Authenticatable;
class Merchant extends Authenticatable
{
    protected $table = 'gateway_merchants';
    public $incrementing = false;
    protected $keyType = 'string';
    protected $guarded = [];
    protected $hidden = ['password', 'webhook_secret'];
    protected $dateFormat = 'Y-m-d H:i:s.u';
    protected function casts(): array
    {
        return ['webhook_secret' => 'encrypted'];
    }
}
