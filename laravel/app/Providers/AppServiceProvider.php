<?php

namespace App\Providers;

use App\Support\ApiResponse;
use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\ServiceProvider;
use RuntimeException;

class AppServiceProvider extends ServiceProvider
{
    public function register(): void {}

    public function boot(): void
    {
        foreach (['JWT_SECRET' => 'remontada.jwt.secret', 'JWT_REFRESH_SECRET' => 'remontada.jwt.refresh_secret'] as $name => $key) {
            if (strlen((string) config($key)) < 32 && ! $this->app->runningUnitTests()) {
                throw new RuntimeException("{$name} doit contenir au moins 32 caracteres.");
            }
        }
        $disabled = config('remontada.rate_limit_disabled');
        if ($disabled && $this->app->environment('production')) {
            throw new RuntimeException('Le rate limiting ne peut pas etre desactive en production.');
        }

        // Mêmes fenêtres que express-rate-limit (15 minutes). Les requêtes
        // authentifiées sont comptées par session et non par IP : les commerciaux
        // terrain partagent souvent la même IP publique de l'opérateur mobile (CGNAT).
        $key = function (Request $request): string {
            $token = $request->cookie('crm_access') ?: substr((string) $request->header('Authorization', ''), 7);

            return $token ? 'session:'.hash('sha256', $token) : 'ip:'.$request->ip();
        };
        $limit = fn (int $max, string $message, bool $perSession = false) => fn (Request $request) => $disabled
            ? Limit::none()
            : Limit::perMinutes(15, $max)->by($perSession ? $key($request) : 'ip:'.$request->ip())
                ->response(fn (Request $r, array $headers) => ApiResponse::error(429, 'RATE_LIMITED', $message, $headers));

        RateLimiter::for('api', $limit(200, 'Trop de requetes. Reessayez dans 15 minutes.', true));
        // Flux de notifications en mode « snapshot » : le client se reconnecte toutes les 5 à 20 s.
        RateLimiter::for('stream', $limit(400, 'Trop de reconnexions au flux de notifications.', true));
        RateLimiter::for('login', $limit(10, 'Trop de tentatives de connexion.'));
        RateLimiter::for('password', $limit(5, 'Trop de demandes de reinitialisation. Reessayez plus tard.'));
    }
}
