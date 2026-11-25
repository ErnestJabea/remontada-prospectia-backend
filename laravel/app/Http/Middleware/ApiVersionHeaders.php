<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;

/** Routes /api/* non versionnées : conservées mais signalées dépréciées. */
class ApiVersionHeaders
{
    public function handle(Request $request, Closure $next)
    {
        $response = $next($request);
        $response->headers->set('Deprecation', 'true');
        $response->headers->set('Warning', '299 - "API non versionnee depreciee; utilisez /api/v1"');
        $response->headers->set('Link', '</api/v1>; rel="successor-version"');

        return $response;
    }
}
