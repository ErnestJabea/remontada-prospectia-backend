<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;

class AuthorizeRoles
{
    public function handle(Request $request, Closure $next, string ...$roles)
    {
        $user = $request->attributes->get('user');
        if (! $user || ! in_array($user['role'], $roles, true)) {
            return response()->json([
                'error' => 'Acces refuse. Droits insuffisants.',
                'code' => 'FORBIDDEN',
                'requestId' => $request->attributes->get('requestId'),
            ], 403);
        }

        return $next($request);
    }
}
