<?php
namespace App\Models;
use Illuminate\Database\Eloquent\Model;
abstract class GatewayRecord extends Model
{
    public $incrementing = false;
    protected $keyType = 'string';
    protected $guarded = [];
    protected $dateFormat = 'Y-m-d H:i:s.u';
}
