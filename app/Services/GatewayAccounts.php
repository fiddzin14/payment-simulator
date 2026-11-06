<?php
namespace App\Services;
use App\Models\{Credential, Merchant, PortalSession};
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
class GatewayAccounts
{
    public function register(array $data): array
    {
        return DB::transaction(function () use ($data): array {
            GatewayData::require(
                !Merchant::where('email', $data['email'])->exists(),
                'EMAIL_EXISTS',
                'Email is registered. Sign in instead.',
                409,
            );
            $m = Merchant::create([
                'id' => GatewayData::id('mer'),
                'name' => $data['name'],
                'email' => $data['email'],
                'password' => Hash::make($data['password']),
                'webhook_secret' => GatewayData::token('whsec_test_'),
            ]);
            $credential = $this->issueLocked($m, 'Default application');
            GatewayData::audit($m, 'merchant.registered', $m->id);
            return [
                'merchant' => GatewayPresenter::merchant($m),
                'credential' => $credential,
                'webhook_secret' => $m->webhook_secret,
                'access_token' => $this->session($m),
            ];
        }, 3);
    }
    public function login(string $email, string $password): array
    {
        $m = Merchant::where('email', $email)->first();
        GatewayData::require(
            $m && Hash::check($password, $m->password),
            'INVALID_LOGIN',
            'Email or password is incorrect.',
            401,
        );
        return DB::transaction(function () use ($m): array {
            GatewayData::audit($m, 'merchant.login', $m->id);
            return [
                'merchant' => GatewayPresenter::merchant($m),
                'access_token' => $this->session($m),
            ];
        });
    }
    private function session(Merchant $m): string
    {
        $token = GatewayData::token('sess_');
        PortalSession::create([
            'id' => GatewayData::id('ses'),
            'merchant_id' => $m->id,
            'token_hash' => hash('sha256', $token),
            'expires_at' => GatewayData::now()->addHours(config('gateway.session_hours')),
        ]);
        return $token;
    }
    public function issue(Merchant $m, string $name): array
    {
        return DB::transaction(
            fn() => $this->issueLocked(
                Merchant::whereKey($m->id)->lockForUpdate()->firstOrFail(),
                $name,
            ),
            3,
        );
    }
    private function issueLocked(Merchant $m, string $name): array
    {
        GatewayData::require(
            Credential::where('merchant_id', $m->id)->whereNull('revoked_at')->count() < 10,
            'KEY_LIMIT',
            'Revoke an active key before creating more.',
            409,
        );
        $secret = GatewayData::token('sk_test_');
        $c = Credential::create([
            'id' => GatewayData::id('key'),
            'merchant_id' => $m->id,
            'name' => $name,
            'token_hash' => hash('sha256', $secret),
            'prefix' => substr($secret, 0, 15),
            'last_four' => substr($secret, -4),
        ]);
        GatewayData::audit($m, 'credential.created', $c->id);
        return [...GatewayPresenter::credential($c), 'secret_key' => $secret];
    }
    public function webhook(Merchant $merchant, ?string $url): void
    {
        app(Destination::class)->validate($url);
        DB::transaction(function () use ($merchant, $url): void {
            $m = Merchant::whereKey($merchant->id)->lockForUpdate()->firstOrFail();
            $m->update(['webhook_url' => $url]);
            if ($url) {
                \App\Models\GatewayEvent::where('merchant_id', $m->id)
                    ->where('status', 'unconfigured')
                    ->update([
                        'target_url' => $url,
                        'status' => 'pending',
                        'available_at' => GatewayData::now(),
                    ]);
            }
            GatewayData::audit($m, 'webhook.updated', $m->id);
        }, 3);
    }
    public function rotate(Merchant $merchant): string
    {
        return DB::transaction(function () use ($merchant): string {
            $m = Merchant::whereKey($merchant->id)->lockForUpdate()->firstOrFail();
            $secret = GatewayData::token('whsec_test_');
            $m->webhook_secret = $secret;
            $m->save();
            GatewayData::audit($m, 'webhook.secret-rotated', $m->id);
            return $secret;
        }, 3);
    }
}
