<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;

/** Équivalent des en-têtes posés par helmet() dans server.js. */
class SecurityHeaders
{
    public function handle(Request $request, Closure $next)
    {
        $response = $next($request);
        $h = $response->headers;
        $h->remove('X-Powered-By');
        $h->set('X-Content-Type-Options', 'nosniff');
        $h->set('X-Frame-Options', 'SAMEORIGIN');
        $h->set('Referrer-Policy', 'no-referrer');
        $h->set('Cross-Origin-Resource-Policy', 'same-site');
        $h->set('Cross-Origin-Opener-Policy', 'same-origin');
        $h->set('X-DNS-Prefetch-Control', 'off');
        $h->set('X-Permitted-Cross-Domain-Policies', 'none');
        $h->set('Origin-Agent-Cluster', '?1');
        if (! $h->has('Content-Security-Policy')) {
            $h->set('Content-Security-Policy', "default-src 'self';base-uri 'self';font-src 'self' https: data:;form-action 'self';frame-ancestors 'self';img-src 'self' data:;object-src 'none';script-src 'self';script-src-attr 'none';style-src 'self' https: 'unsafe-inline';upgrade-insecure-requests");
        }
        if (app()->environment('production')) {
            $h->set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
        }

        return $response;
    }
}
