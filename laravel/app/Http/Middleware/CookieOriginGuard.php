<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;

/**
 * Barrière CSRF explicite pour les écritures authentifiées par cookie :
 * l'en-tête Origin doit appartenir à la liste blanche (server.js).
 */
class CookieOriginGuard
{
    public function handle(Request $request, Closure $next)
    {
        $usesCookie = $request->cookies->has('crm_access') || $request->cookies->has('crm_refresh');
        if ($usesCookie && ! in_array($request->method(), ['GET', 'HEAD', 'OPTIONS'], true)) {
            $origin = $request->header('Origin');
            if (! $origin || ! in_array($origin, config('remontada.allowed_origins'), true)) {
                return response()->json(['error' => 'Origine de requete non autorisee.'], 403);
            }
        }

        return $next($request);
    }
}
