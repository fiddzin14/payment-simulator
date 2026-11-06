<?php
namespace App\Http\Controllers;
use App\Exceptions\GatewayError;
use App\Models\{Credential, GatewayEvent, Merchant, Payment, Refund};
use App\Services\{
    Destination,
    GatewayAccounts,
    GatewayData,
    GatewayPayments,
    GatewayPresenter,
    GatewayWebhooks,
};
use BaconQrCode\Renderer\Image\SvgImageBackEnd;
use BaconQrCode\Renderer\ImageRenderer;
use BaconQrCode\Renderer\RendererStyle\RendererStyle;
use BaconQrCode\Writer;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\RateLimiter;

class GatewayController
{
    private function merchant(Request $r): Merchant
    {
        return $r->attributes->get('merchant');
    }
    private function payment(Request $r, string $id): Payment
    {
        return Payment::where('merchant_id', $this->merchant($r)->id)->findOrFail($id);
    }
    private function refund(Request $r, string $id): Refund
    {
        return Refund::where('merchant_id', $this->merchant($r)->id)->findOrFail($id);
    }
    private function rate(Request $r, string $bucket, int $limit, int $seconds): void
    {
        $key = 'gateway:' . $bucket . ':' . hash('sha256', $r->ip());
        GatewayData::require(
            !RateLimiter::tooManyAttempts($key, $limit),
            'RATE_LIMIT',
            'Too many attempts. Retry later.',
            429,
        );
        RateLimiter::hit($key, $seconds);
    }
    private function sessionResponse(array $data, int $status = 200)
    {
        return response()
            ->json($data, $status)
            ->cookie(
                config('gateway.session_cookie'),
                $data['access_token'],
                config('gateway.session_hours') * 60,
                '/',
                null,
                str_starts_with(config('app.url'), 'https://'),
                true,
                false,
                'lax',
            );
    }
    public function register(Request $r, GatewayAccounts $accounts)
    {
        $this->rate($r, 'registration', 5, 3600);
        $r->merge(['email' => strtolower(trim((string) $r->input('email')))]);
        $data = $r->validate([
            'name' => 'required|string|min:2|max:80',
            'email' => 'required|email:rfc|max:200',
            'password' => 'required|string|min:10|max:128',
        ]);
        return $this->sessionResponse($accounts->register($data), 201);
    }
    public function login(Request $r, GatewayAccounts $accounts)
    {
        $this->rate($r, 'login', 10, 60);
        $data = $r->validate([
            'email' => 'required|email:rfc|max:200',
            'password' => 'required|string|max:128',
        ]);
        return $this->sessionResponse(
            $accounts->login(strtolower(trim($data['email'])), $data['password']),
        );
    }
    public function logout(Request $r)
    {
        $r->attributes->get('portal_session')->delete();
        return response()
            ->json(['ok' => true])
            ->withoutCookie(config('gateway.session_cookie'));
    }
    public function state(Request $r, GatewayPayments $payments)
    {
        $m = $this->merchant($r);
        foreach (
            Payment::where('merchant_id', $m->id)
                ->where('status', 'pending')
                ->whereRaw('expires_at <= UTC_TIMESTAMP(6)')
                ->get()
            as $p
        ) {
            $payments->refresh($p);
        }
        return response()->json([
            'merchant' => GatewayPresenter::merchant($m->fresh()),
            'base_url' => GatewayPresenter::base(),
            'allow_local_webhooks' => app(Destination::class)->allowLocal(),
            'credentials' => Credential::where('merchant_id', $m->id)
                ->latest()
                ->get()
                ->map(fn($c) => GatewayPresenter::credential($c)),
            'payments' => Payment::where('merchant_id', $m->id)
                ->latest()
                ->get()
                ->map(fn($p) => GatewayPresenter::payment($p)),
            'events' => GatewayEvent::where('merchant_id', $m->id)
                ->latest()
                ->get()
                ->map(fn($e) => GatewayPresenter::event($e)),
            'refunds' => Refund::where('merchant_id', $m->id)
                ->latest()
                ->get()
                ->map(fn($r) => GatewayPresenter::refund($r)),
            'receipts' => DB::table('gateway_receipts')->where('merchant_id', $m->id)->get()->map(
                fn($receipt) => [
                    'id' => $receipt->id,
                    'payment_id' => $receipt->payment_id,
                    'amount' => (int) $receipt->amount,
                    'bank_reference' => $receipt->bank_reference,
                    'needs_review' => (bool) $receipt->needs_review,
                    'created_at' => GatewayPresenter::date($receipt->created_at),
                ],
            ),
            'audit' => DB::table('gateway_audits')
                ->where('merchant_id', $m->id)
                ->latest()
                ->limit(100)
                ->get()
                ->map(
                    fn($a) => [
                        'id' => $a->id,
                        'action' => $a->action,
                        'resource' => $a->subject_id,
                        'created_at' => GatewayPresenter::date($a->created_at),
                    ],
                ),
            'banks' => array_keys(GatewayPayments::BANKS),
            'runtime' => 'laravel',
        ]);
    }
    public function credential(Request $r, GatewayAccounts $accounts)
    {
        $data = $r->validate(['name' => 'required|string|max:60']);
        return response()->json($accounts->issue($this->merchant($r), $data['name']), 201);
    }
    public function revoke(Request $r, string $id)
    {
        DB::transaction(function () use ($r, $id): void {
            $m = Merchant::whereKey($this->merchant($r)->id)->lockForUpdate()->firstOrFail();
            $c = Credential::where('merchant_id', $m->id)->findOrFail($id);
            if (!$c->revoked_at) {
                $c->update(['revoked_at' => GatewayData::now()]);
            }
            GatewayData::audit($m, 'credential.revoked', $c->id);
        }, 3);
        return response()->json(['ok' => true]);
    }
    public function webhook(Request $r, GatewayAccounts $accounts)
    {
        $data = $r->validate(['url' => 'nullable|string|max:1000']);
        $accounts->webhook($this->merchant($r), $data['url'] ?? null);
        return response()->json(['ok' => true]);
    }
    public function rotate(Request $r, GatewayAccounts $accounts)
    {
        return response()->json(['webhook_secret' => $accounts->rotate($this->merchant($r))]);
    }

    public function methods()
    {
        return response()->json([
            'currency' => 'IDR',
            'simulation_only' => true,
            'data' => [
                [
                    'code' => 'qris',
                    'name' => 'QRIS Dynamic',
                    'min_amount' => 1,
                    'max_amount' => 10000000,
                    'min_expiry' => 60,
                    'max_expiry' => 3600,
                ],
                [
                    'code' => 'virtual_account',
                    'name' => 'Virtual Account',
                    'min_amount' => 1,
                    'max_amount' => 100000000,
                    'min_expiry' => 60,
                    'max_expiry' => 604800,
                    'banks' => array_keys(GatewayPayments::BANKS),
                ],
            ],
        ]);
    }
    public function create(Request $r, GatewayPayments $payments)
    {
        $input = $r->validate([
            'external_id' => 'required|string|max:100',
            'amount' => [
                'required',
                'integer',
                'min:1',
                'max:100000000',
                function ($attribute, $value, $fail) {
                    if (!is_int($value)) {
                        $fail('Amount must be an integer JSON number.');
                    }
                },
            ],
            'currency' => 'sometimes|in:IDR',
            'payment_method' => 'required|in:qris,virtual_account',
            'bank_code' => 'nullable|string|max:12',
            'expires_in' => 'sometimes|integer|min:60|max:604800',
            'description' => 'nullable|string|max:300',
            'customer_name' => 'nullable|string|max:100',
            'return_url' => 'nullable|string|max:1000',
        ]);
        $p = $payments->create(
            $this->merchant($r),
            $input,
            $r->header('Idempotency-Key', ''),
            $r->attributes->get('credential')?->id,
        );
        return response()->json(GatewayPresenter::payment($p), 201);
    }
    public function show(Request $r, string $id, GatewayPayments $payments)
    {
        return response()->json(
            GatewayPresenter::payment($payments->refresh($this->payment($r, $id))),
        );
    }
    public function listing(Request $r, GatewayPayments $payments)
    {
        $data = $r->validate([
            'limit' => 'nullable|integer|between:1,100',
            'starting_after' => 'nullable|string|max:40',
            'external_id' => 'nullable|string|max:100',
        ]);
        $limit = (int) ($data['limit'] ?? 20);
        $query = Payment::where('merchant_id', $this->merchant($r)->id)
            ->orderByDesc('created_at')
            ->orderByDesc('id');
        if (isset($data['external_id'])) {
            $query->where('external_id', $data['external_id']);
        }
        if (isset($data['starting_after'])) {
            $cursor = $this->payment($r, $data['starting_after']);
            $query->where(
                fn($q) => $q
                    ->where('created_at', '<', $cursor->created_at->format('Y-m-d H:i:s.u'))
                    ->orWhere(
                        fn($x) => $x
                            ->where('created_at', $cursor->created_at->format('Y-m-d H:i:s.u'))
                            ->where('id', '<', $cursor->id),
                    ),
            );
        }
        $records = $query->limit($limit + 1)->get();
        $more = $records->count() > $limit;
        $page = $records->take($limit);
        return response()->json([
            'data' => $page
                ->map(fn($p) => GatewayPresenter::payment($payments->refresh($p)))
                ->values(),
            'has_more' => $more,
            'next_cursor' => $more ? $page->last()?->id : null,
        ]);
    }
    public function cancel(Request $r, string $id, GatewayPayments $payments)
    {
        return response()->json(
            GatewayPresenter::payment($payments->cancel($this->payment($r, $id))),
        );
    }
    private function scenario(Request $r): array
    {
        return $r->validate([
            'outcome' => 'required|in:paid,pending,failed,expired,cancelled',
            'amount' => 'sometimes|integer|min:1|max:100000000',
            'bank_reference' => 'sometimes|string|min:4|max:100',
            'late_payment' => 'sometimes|boolean',
        ]);
    }
    public function simulate(Request $r, string $id, GatewayPayments $payments)
    {
        return response()->json(
            GatewayPresenter::payment(
                $payments->simulate($this->payment($r, $id), $this->scenario($r), true),
            ),
        );
    }
    public function refundCreate(Request $r, string $id, GatewayPayments $payments)
    {
        $input = $r->validate([
            'amount' => 'required|integer|min:1|max:100000000',
            'reason' => 'required|string|min:3|max:300',
        ]);
        return response()->json(
            GatewayPresenter::refund(
                $payments->refund(
                    $this->payment($r, $id),
                    $input,
                    $r->header('Idempotency-Key', ''),
                ),
            ),
            201,
        );
    }
    public function refundShow(Request $r, string $id)
    {
        return response()->json(GatewayPresenter::refund($this->refund($r, $id)));
    }
    public function refundSimulate(Request $r, string $id, GatewayPayments $payments)
    {
        $input = $r->validate(['outcome' => 'required|in:succeeded,failed']);
        return response()->json(
            GatewayPresenter::refund(
                $payments->refundOutcome($this->refund($r, $id), $input['outcome']),
            ),
        );
    }
    public function refundRetry(Request $r, string $id, GatewayPayments $payments)
    {
        return response()->json(
            GatewayPresenter::refund($payments->retryRefund($this->refund($r, $id))),
        );
    }
    public function replay(Request $r, string $id, GatewayWebhooks $webhooks)
    {
        $data = $r->validate(['use_current_url' => 'sometimes|boolean']);
        $event = GatewayEvent::where('merchant_id', $this->merchant($r)->id)->findOrFail($id);
        $webhooks->retry($event, (bool) ($data['use_current_url'] ?? false));
        return response()->json(['ok' => true]);
    }
    public function checkout(string $token, GatewayPayments $payments)
    {
        $p = $payments->checkout($token);
        $data = GatewayPresenter::payment($p);
        unset(
            $data['merchant_id'],
            $data['paid_amount'],
            $data['refunded_amount'],
            $data['late_received_amount'],
            $data['customer_name'],
        );
        $data['merchant_name'] = Merchant::findOrFail($p->merchant_id)->name;
        return response()->json($data);
    }
    public function checkoutSimulate(Request $r, string $token, GatewayPayments $payments)
    {
        return response()->json(
            GatewayPresenter::payment(
                $payments->simulate($payments->checkout($token), $this->scenario($r)),
            ),
        );
    }
    public function qr(string $token, GatewayPayments $payments)
    {
        $p = $payments->checkout($token);
        GatewayData::require(
            $p->payment_method === 'qris' && $p->status === 'pending',
            'QR_UNAVAILABLE',
            'QR is no longer active.',
            409,
        );
        $svg = new Writer(
            new ImageRenderer(new RendererStyle(280, 3), new SvgImageBackEnd()),
        )->writeString(GatewayPresenter::payment($p)['qr_string']);
        return response($svg, 200, [
            'Content-Type' => 'image/svg+xml',
            'Cache-Control' => 'no-store',
        ]);
    }
    public function scan(string $token, GatewayPayments $payments)
    {
        try {
            $p = $payments->checkout($token);
            $p = $payments->simulate(
                $p,
                ['outcome' => 'paid', 'amount' => $p->amount, 'bank_reference' => 'SCAN-' . $p->id],
                false,
                true,
            );
            return response()->view('scan', [
                'payment' => GatewayPresenter::payment($p),
                'merchant' => Merchant::findOrFail($p->merchant_id)->name,
                'error' => null,
            ]);
        } catch (GatewayError $error) {
            return response()->view(
                'scan',
                ['payment' => null, 'merchant' => null, 'error' => $error->getMessage()],
                $error->httpStatus,
            );
        }
    }
}
