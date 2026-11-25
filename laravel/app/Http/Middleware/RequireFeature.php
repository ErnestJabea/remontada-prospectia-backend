<?php

namespace App\Http\Middleware;

use App\Exceptions\ApiException;
use App\Services\FeatureAccess;
use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

/**
 * Reprise de requireFeature() : opération déduite de la méthode HTTP,
 * contrôle can_reorganize sur les affectations, et vérification du
 * périmètre pour toute URL /{id}/… quand la vue globale est refusée.
 */
class RequireFeature
{
    public function handle(Request $request, Closure $next, string $defaultFeature)
    {
        $user = $request->attributes->get('user');
        // Chemin relatif au module, comme req.path dans un routeur Express monté.
        $relative = '/'.ltrim(preg_replace('#^api/(v1/)?'.preg_quote($defaultFeature, '#').'#', '', $request->path()), '/');
        $method = $request->method();

        $isDomainOrKpi = $defaultFeature === 'objectives' && preg_match('#^/(domains|kpis)(/|$)#', $relative);
        $feature = $isDomainOrKpi ? 'kpis' : $defaultFeature;
        $isCreate = $method === 'POST' && ($relative === '/' || $relative === '/proposals' || str_starts_with($relative, '/generate') || preg_match('#^/(domains|kpis)/?$#', $relative));
        $operation = in_array($method, ['GET', 'HEAD'], true) ? 'can_view' : ($method === 'DELETE' ? 'can_delete' : ($isCreate ? 'can_create' : 'can_update'));

        $objectiveLookup = $defaultFeature === 'objectives' && in_array($method, ['GET', 'HEAD'], true) && preg_match('#^/(domains|kpis)/?$#', $relative);
        if ($objectiveLookup) {
            try {
                FeatureAccess::assertFeature($user, 'objectives', 'can_view');
            } catch (ApiException) {
                FeatureAccess::assertFeature($user, $feature, $operation);
            }
        } else {
            FeatureAccess::assertFeature($user, $feature, $operation);
        }
        if (preg_match('#/(assign|affectations)(/|$)#', $relative)) {
            FeatureAccess::assertFeature($user, $feature, 'can_reorganize');
        }
        $permission = FeatureAccess::permissionFor($user, $feature);
        $user['restrictFeatureScope'] = $permission !== null && empty($permission['can_view_all']);
        $request->attributes->set('user', $user);

        if (preg_match('#^/(\d+)(?:/|$)#', $relative, $m) && $user['restrictFeatureScope'] && isset(FeatureAccess::OWNERSHIP[$feature])) {
            [$table, $condition, $repeats] = FeatureAccess::OWNERSHIP[$feature];
            $row = DB::selectOne("SELECT x.id FROM {$table} WHERE x.id=? AND {$condition}", array_merge([(int) $m[1]], array_fill(0, $repeats, $user['id'])));
            if (! $row) {
                return response()->json(['error' => 'Ce dossier est hors de votre périmètre.'], 403);
            }
        }

        return $next($request);
    }
}
