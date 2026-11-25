<?php

namespace App\Http\Controllers;

use App\Services\Analytics;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class AnalyticsController extends Controller
{
    /** Instantané cohérent en lecture seule (REPEATABLE READ + CONSISTENT SNAPSHOT), comme dans Node. */
    public function show(Request $request, string $module): JsonResponse
    {
        $range = Analytics::period($request->query());
        DB::statement('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        DB::statement('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
        try {
            $data = Analytics::compute($module, $this->user(), $range);
            DB::statement('COMMIT');
        } catch (\Throwable $e) {
            DB::statement('ROLLBACK');
            throw $e;
        }

        return $this->ok($data + ['period' => $range, 'generatedAt' => gmdate('Y-m-d\TH:i:s.v\Z'), 'scope' => $this->user()['role'] === 'COMMERCIAL' ? 'personal' : 'organization']);
    }
}
