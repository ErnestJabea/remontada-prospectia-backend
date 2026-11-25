<?php

namespace App\Http\Middleware;

use App\Support\ApiResponse;
use Closure;
use Illuminate\Http\Request;

/** Reprise de middleware/apiSecurity.js#validateApiRequest. */
class ValidateApiRequest
{
    private const DANGEROUS_KEYS = ['__proto__', 'prototype', 'constructor'];

    public function handle(Request $request, Closure $next)
    {
        if (strlen($request->getRequestUri()) > 2048) {
            return ApiResponse::error(414, 'URI_TOO_LONG', 'URI de requete trop longue.');
        }
        $type = strtolower((string) $request->header('Content-Type'));
        $length = (int) $request->header('Content-Length', 0);
        if ($length > config('remontada.body_limit_bytes') && ! str_contains($type, 'multipart/form-data')) {
            return ApiResponse::error(413, 'PAYLOAD_TOO_LARGE', 'Corps de requete trop volumineux.');
        }
        if (in_array($request->method(), ['POST', 'PUT', 'PATCH', 'DELETE'], true) && ($length > 0 || $request->header('Transfer-Encoding'))) {
            $ok = str_contains($type, 'application/json') || str_contains($type, 'application/x-www-form-urlencoded') || str_contains($type, 'multipart/form-data');
            if (! $ok) {
                return ApiResponse::error(415, 'UNSUPPORTED_MEDIA_TYPE', 'Type de contenu non pris en charge.');
            }
            if (str_contains($type, 'application/json') && $request->getContent() !== '') {
                json_decode($request->getContent());
                if (json_last_error() !== JSON_ERROR_NONE) {
                    return ApiResponse::error(400, 'INVALID_JSON', 'Corps JSON invalide.');
                }
            }
        }
        foreach ($request->query() as $value) {
            if (is_array($value)) {
                return ApiResponse::error(400, 'AMBIGUOUS_QUERY', 'Un parametre de requete ne peut pas etre repete.');
            }
        }
        $body = str_contains($type, 'application/json') ? $request->json()->all() : $request->post();
        if ($this->dangerous($request->query()) || $this->dangerous($body)) {
            return ApiResponse::error(400, 'INVALID_PAYLOAD', 'Structure de requete non autorisee.');
        }

        return $next($request);
    }

    private function dangerous(mixed $value, int $depth = 0): bool
    {
        if ($depth > 20) {
            return true;
        }
        if (! is_array($value)) {
            return false;
        }
        if (array_is_list($value) && count($value) > 1000) {
            return true;
        }
        foreach ($value as $key => $child) {
            if (in_array((string) $key, self::DANGEROUS_KEYS, true) || $this->dangerous($child, $depth + 1)) {
                return true;
            }
        }

        return false;
    }
}
