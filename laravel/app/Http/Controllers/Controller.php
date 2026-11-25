<?php

namespace App\Http\Controllers;

use App\Services\FeatureAccess;
use App\Support\ApiResponse;
use App\Support\Rows;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

abstract class Controller
{
    protected function user(): array
    {
        return request()->attributes->get('user');
    }

    protected function isManager(): bool
    {
        return FeatureAccess::isManager($this->user());
    }

    /** Corps JSON brut (équivalent de req.body). */
    protected function body(?Request $request = null): array
    {
        $request ??= request();
        $data = $request->isJson() ? $request->json()->all() : $request->all();

        return is_array($data) ? $data : [];
    }

    protected function ok(mixed $data, int $status = 200): JsonResponse
    {
        return ApiResponse::json($data, $status);
    }

    protected function err(int $status, string $message): JsonResponse
    {
        return response()->json(['error' => $message], $status);
    }

    protected function rows(mixed $rows): array
    {
        return Rows::arr($rows);
    }
}
