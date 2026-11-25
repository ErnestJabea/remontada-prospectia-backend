<?php

use App\Exceptions\ApiException;
use App\Http\Middleware\ApiRequestContext;
use App\Http\Middleware\Authenticate;
use App\Http\Middleware\AuthorizeRoles;
use App\Http\Middleware\CookieOriginGuard;
use App\Http\Middleware\RequireFeature;
use App\Http\Middleware\SecurityHeaders;
use App\Http\Middleware\ValidateApiRequest;
use App\Support\ApiResponse;
use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Foundation\Http\Middleware\ConvertEmptyStringsToNull;
use Illuminate\Foundation\Http\Middleware\TrimStrings;
use Illuminate\Http\Exceptions\ThrottleRequestsException;
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;
use Symfony\Component\HttpKernel\Exception\HttpExceptionInterface;
use Symfony\Component\HttpKernel\Exception\MethodNotAllowedHttpException;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        api: __DIR__.'/../routes/api.php',
        apiPrefix: '',
        commands: __DIR__.'/../routes/console.php',
        health: null,
    )
    ->withMiddleware(function (Middleware $middleware): void {
        // API sans état : pas de session, pas de CSRF Laravel. La protection
        // CSRF des cookies est assurée par SameSite + CookieOriginGuard,
        // exactement comme dans le backend Node.js.
        $middleware->encryptCookies(except: ['crm_access', 'crm_refresh']);
        // Le contrat Node ne rognait pas les chaînes et distinguait '' de null.
        $middleware->remove([
            TrimStrings::class,
            ConvertEmptyStringsToNull::class,
        ]);
        $middleware->prepend([
            ApiRequestContext::class,
            SecurityHeaders::class,
        ]);
        $middleware->appendToGroup('api', [
            ValidateApiRequest::class,
            CookieOriginGuard::class,
        ]);
        $middleware->alias([
            'jwt' => Authenticate::class,
            'role' => AuthorizeRoles::class,
            'feature' => RequireFeature::class,
        ]);
        $middleware->trustProxies(at: ((int) env('TRUST_PROXY_HOPS', 0)) > 0 ? '*' : []);
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        $exceptions->shouldRenderJsonWhen(fn () => true);

        $exceptions->render(function (Throwable $e, Request $request) {
            if ($e instanceof ApiException) {
                return ApiResponse::error($e->status, $e->errorCode, $e->getMessage());
            }
            if ($e instanceof ValidationException) {
                return ApiResponse::error(400, 'VALIDATION_FAILED', collect($e->errors())->flatten()->first() ?? 'Requête invalide.');
            }
            if ($e instanceof ThrottleRequestsException) {
                return ApiResponse::error(429, 'RATE_LIMITED', $e->getMessage() ?: 'Trop de requetes. Reessayez dans 15 minutes.', $e->getHeaders());
            }
            if ($e instanceof NotFoundHttpException) {
                return ApiResponse::error(404, 'ROUTE_NOT_FOUND', "Route non trouvee : {$request->method()} /{$request->path()}");
            }
            if ($e instanceof MethodNotAllowedHttpException) {
                return ApiResponse::error(404, 'ROUTE_NOT_FOUND', "Route non trouvee : {$request->method()} /{$request->path()}");
            }
            if ($e instanceof HttpExceptionInterface) {
                $status = $e->getStatusCode();

                return ApiResponse::error($status, 'REQUEST_FAILED', $status < 500 ? ($e->getMessage() ?: 'Requête refusée.') : 'Erreur serveur interne.');
            }
            report($e);

            return ApiResponse::error(500, 'REQUEST_FAILED', 'Erreur serveur interne.');
        });
    })->create();
