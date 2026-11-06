<?php
use App\Exceptions\GatewayError;
use App\Http\Middleware\{GatewayAuth, GatewayContext};
use Illuminate\Database\QueryException;
use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\{Exceptions, Middleware};
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;
use Symfony\Component\HttpKernel\Exception\HttpExceptionInterface;
return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__ . '/../routes/web.php',
        api: __DIR__ . '/../routes/api.php',
        commands: __DIR__ . '/../routes/console.php',
        apiPrefix: '',
        health: '/up',
    )
    ->withMiddleware(function (Middleware $middleware): void {
        $middleware->api(prepend: [GatewayContext::class]);
        $middleware->alias(['gateway.auth' => GatewayAuth::class]);
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        $exceptions->dontReport([GatewayError::class]);
        $exceptions->render(function (Throwable $error, Request $request) {
            if (!$request->is('portal/*', 'v1/*', 'checkout-api/*')) {
                return null;
            }
            $status = 500;
            $code = 'INTERNAL_ERROR';
            $message = 'The gateway could not process this request.';
            if ($error instanceof GatewayError) {
                $status = $error->httpStatus;
                $code = $error->errorCode;
                $message = $error->getMessage();
            } elseif ($error instanceof ValidationException) {
                $status = 422;
                $code = 'VALIDATION_ERROR';
                $message = collect($error->errors())->flatten()->first();
            } elseif ($error instanceof QueryException && ($error->errorInfo[1] ?? null) === 1062) {
                $status = 409;
                $code = 'RESOURCE_CONFLICT';
                $message = 'This reference or account already exists.';
            } elseif ($error instanceof HttpExceptionInterface) {
                $status = $error->getStatusCode();
                $code = $status === 404 ? 'NOT_FOUND' : 'REQUEST_REJECTED';
                $message =
                    $status === 404 ? 'Resource not found.' : 'Request could not be accepted.';
            }
            return response()->json(
                [
                    'error' => [
                        'code' => $code,
                        'message' => $message,
                        'request_id' => $request->attributes->get(
                            'request_id',
                            'req_' . Illuminate\Support\Str::uuid(),
                        ),
                    ],
                ],
                $status,
                $status === 429 ? ['Retry-After' => '60'] : [],
            );
        });
    })
    ->create();
