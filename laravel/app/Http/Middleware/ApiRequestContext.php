<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Str;

class ApiRequestContext
{
    public function handle(Request $request, Closure $next)
    {
        $incoming = (string) $request->header('X-Request-ID', '');
        $requestId = preg_match('/^[A-Za-z0-9._-]{8,128}$/', $incoming) ? $incoming : (string) Str::uuid();
        $request->attributes->set('requestId', $requestId);

        $response = $next($request);
        $response->headers->set('X-Request-ID', $requestId);
        $response->headers->set('X-API-Version', config('remontada.api_version'));
        $response->headers->set('Cache-Control', 'no-store, max-age=0');
        $response->headers->set('Pragma', 'no-cache');

        return $response;
    }
}
