<?php
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;
return new class extends Migration {
    public function up(): void
    {
        Schema::create('gateway_merchants', function (Blueprint $t): void {
            $t->string('id', 40)->primary();
            $t->string('name', 80);
            $t->string('email', 200)->unique();
            $t->string('password');
            $t->text('webhook_secret');
            $t->string('webhook_url', 1000)->nullable();
            $t->timestamps(6);
        });
        Schema::create('gateway_sessions', function (Blueprint $t): void {
            $t->string('id', 40)->primary();
            $t->string('merchant_id', 40);
            $t->char('token_hash', 64)->unique();
            $t->dateTime('expires_at', 6)->index();
            $t->timestamps(6);
            $t->foreign('merchant_id')
                ->references('id')
                ->on('gateway_merchants')
                ->cascadeOnDelete();
        });
        Schema::create('gateway_credentials', function (Blueprint $t): void {
            $t->string('id', 40)->primary();
            $t->string('merchant_id', 40);
            $t->string('name', 60);
            $t->char('token_hash', 64)->unique();
            $t->string('prefix', 20);
            $t->char('last_four', 4);
            $t->dateTime('revoked_at', 6)->nullable();
            $t->dateTime('last_used_at', 6)->nullable();
            $t->timestamps(6);
            $t->foreign('merchant_id')->references('id')->on('gateway_merchants');
        });
        Schema::create('gateway_payments', function (Blueprint $t): void {
            $t->string('id', 40)->primary();
            $t->string('merchant_id', 40);
            $t->string('credential_id', 40)->nullable();
            $t->string('external_id', 100)->collation('utf8mb4_bin');
            $t->unsignedBigInteger('amount');
            $t->char('currency', 3)->default('IDR');
            $t->string('payment_method', 24);
            $t->string('bank_code', 12)->nullable();
            $t->string('account_number', 16)->nullable()->unique();
            $t->string('account_name', 50)->nullable();
            $t->text('checkout_token');
            $t->char('checkout_hash', 64)->unique();
            $t->string('webhook_url', 1000)->nullable();
            $t->string('return_url', 1000)->nullable();
            $t->string('description', 300)->default('');
            $t->string('customer_name', 100)->default('');
            $t->unsignedInteger('expires_in');
            $t->string('status', 20)->default('pending');
            $t->unsignedBigInteger('paid_amount')->default(0);
            $t->unsignedBigInteger('refunded_amount')->default(0);
            $t->unsignedBigInteger('late_received_amount')->default(0);
            $t->dateTime('expires_at', 6)->index();
            $t->dateTime('paid_at', 6)->nullable();
            $t->timestamps(6);
            $t->unique(['merchant_id', 'external_id']);
            $t->index(['merchant_id', 'created_at']);
            $t->foreign('merchant_id')->references('id')->on('gateway_merchants');
            $t->foreign('credential_id')->references('id')->on('gateway_credentials');
        });
        Schema::create('gateway_receipts', function (Blueprint $t): void {
            $t->string('id', 40)->primary();
            $t->string('merchant_id', 40);
            $t->string('payment_id', 40);
            $t->unsignedBigInteger('amount');
            $t->string('bank_reference', 100)->collation('utf8mb4_bin')->unique();
            $t->boolean('needs_review')->default(false);
            $t->timestamps(6);
            $t->foreign('payment_id')->references('id')->on('gateway_payments');
        });
        Schema::create('gateway_refunds', function (Blueprint $t): void {
            $t->string('id', 40)->primary();
            $t->string('merchant_id', 40);
            $t->string('payment_id', 40);
            $t->unsignedBigInteger('amount');
            $t->string('reason', 300);
            $t->string('status', 20)->default('pending');
            $t->dateTime('succeeded_at', 6)->nullable();
            $t->dateTime('failed_at', 6)->nullable();
            $t->timestamps(6);
            $t->foreign('payment_id')->references('id')->on('gateway_payments');
        });
        Schema::create('gateway_idempotencies', function (Blueprint $t): void {
            $t->string('id', 40)->primary();
            $t->string('merchant_id', 40);
            $t->string('scope', 60);
            $t->string('request_key', 100)->collation('utf8mb4_bin');
            $t->char('request_hash', 64);
            $t->string('resource_id', 40);
            $t->timestamps(6);
            $t->unique(['merchant_id', 'scope', 'request_key'], 'gateway_idempotency_unique');
        });
        Schema::create('gateway_events', function (Blueprint $t): void {
            $t->string('id', 40)->primary();
            $t->string('merchant_id', 40);
            $t->string('payment_id', 40);
            $t->string('type', 40);
            $t->json('payload');
            $t->string('target_url', 1000)->nullable();
            $t->string('status', 24);
            $t->unsignedTinyInteger('attempts')->default(0);
            $t->dateTime('available_at', 6)->nullable()->index();
            $t->dateTime('lease_until', 6)->nullable();
            $t->char('lease_token', 36)->nullable();
            $t->dateTime('delivered_at', 6)->nullable();
            $t->timestamps(6);
            $t->index(['merchant_id', 'created_at']);
            $t->foreign('payment_id')->references('id')->on('gateway_payments');
        });
        Schema::create('gateway_deliveries', function (Blueprint $t): void {
            $t->string('id', 40)->primary();
            $t->string('event_id', 40);
            $t->unsignedInteger('attempt');
            $t->unsignedSmallInteger('status_code')->nullable();
            $t->string('error', 120)->nullable();
            $t->unsignedInteger('duration_ms');
            $t->dateTime('at', 6);
            $t->timestamps(6);
            $t->foreign('event_id')->references('id')->on('gateway_events');
        });
        Schema::create('gateway_audits', function (Blueprint $t): void {
            $t->string('id', 40)->primary();
            $t->string('merchant_id', 40);
            $t->string('action', 80);
            $t->string('subject_id', 40)->nullable();
            $t->timestamps(6);
            $t->index(['merchant_id', 'created_at']);
        });
    }
    public function down(): void
    {
        foreach (
            [
                'audits',
                'deliveries',
                'events',
                'idempotencies',
                'refunds',
                'receipts',
                'payments',
                'credentials',
                'sessions',
                'merchants',
            ]
            as $name
        ) {
            Schema::dropIfExists('gateway_' . $name);
        }
    }
};
