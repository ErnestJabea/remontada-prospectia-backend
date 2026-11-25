<?php

namespace App\Support;

use Illuminate\Http\JsonResponse;

class ApiResponse
{
    /** Format d'erreur identique au backend Node : {error, code, requestId, apiVersion}. */
    public static function error(int $status, string $code, string $message, array $headers = []): JsonResponse
    {
        return response()->json([
            'error' => $message,
            'code' => $code,
            'requestId' => request()?->attributes->get('requestId'),
            'apiVersion' => config('remontada.api_version'),
        ], $status, $headers);
    }

    /** Réponse JSON avec normalisation des dates pour rester compatible avec mysql2. */
    public static function json(mixed $data, int $status = 200): JsonResponse
    {
        return response()->json(Rows::normalize($data), $status, [], JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION);
    }
}
