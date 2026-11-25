<?php

namespace App\Http\Controllers;

use Illuminate\Http\JsonResponse;

class HealthController extends Controller
{
    public function __invoke(): JsonResponse
    {
        return response()->json([
            'status' => 'ok',
            'service' => 'ERP Remontada Prospectia API',
            'apiVersion' => config('remontada.api_version'),
            'serviceVersion' => '2.0.0-laravel',
            'runtime' => 'laravel/'.app()->version(),
            'timestamp' => gmdate('Y-m-d\TH:i:s.v\Z'),
        ]);
    }
}
