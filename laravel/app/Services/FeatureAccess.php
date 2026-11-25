<?php

namespace App\Services;

use App\Exceptions\ApiException;
use Illuminate\Support\Facades\DB;

/** Reprise de middleware/featureAccess.js et utils/linkedAccess.js. */
class FeatureAccess
{
    public const MANAGERS = ['SYSTEM', 'ADMIN', 'DIRECTION'];

    public const FEATURES = [
        'objectives' => 'crm', 'missions' => 'crm', 'institutions' => 'crm', 'opportunities' => 'crm', 'reports' => 'crm',
        'users' => 'admin', 'referentials' => 'admin', 'kpis' => 'admin', 'security' => 'admin',
    ];

    /** [table alias x, condition de périmètre, nombre de répétitions de user.id] */
    public const OWNERSHIP = [
        'objectives' => ['crm_objectives x', "(x.created_by=? OR x.responsible_id=? OR EXISTS (SELECT 1 FROM objectif_affectations a WHERE a.objective_id=x.id AND a.type='COMMERCIAL' AND a.target_id=?))", 3],
        'missions' => ['crm_missions x', '(x.primary_commercial_id=? OR EXISTS (SELECT 1 FROM crm_mission_associates a WHERE a.mission_id=x.id AND a.user_id=?))', 2],
        'opportunities' => ['crm_opportunities x', 'x.assigned_to=?', 1],
        'reports' => ['crm_reports x', '(x.commercial_id=? OR EXISTS (SELECT 1 FROM crm_missions m WHERE m.id=x.mission_id AND m.primary_commercial_id=?))', 2],
        'institutions' => ['crm_institutions x', 'x.created_by=?', 1],
        'users' => ['users x', 'x.id=?', 1],
    ];

    public static function isManager(array $user): bool
    {
        return in_array($user['role'], self::MANAGERS, true);
    }

    /** null = aucune restriction issue de la fiche de poste. */
    public static function permissionFor(array $user, string $feature): ?array
    {
        if ($user['role'] === 'SYSTEM' || empty($user['job_description_id'])) {
            return null;
        }
        $found = null;
        foreach ($user['jobPermissions'] ?? [] as $p) {
            if ($p['feature_id'] === $feature && $p['module_id'] === (self::FEATURES[$feature] ?? null)) {
                $found = $p;
                break;
            }
        }
        if (! $found && in_array($user['role'], ['DIRECTION', 'ADMIN'], true)) {
            return null;
        }

        return $found ?? [];
    }

    public static function assertFeature(array $user, string $feature, string $operation = 'can_view'): void
    {
        $permission = self::permissionFor($user, $feature);
        if ($permission !== null && (empty($permission['can_view']) || empty($permission[$operation]))) {
            throw ApiException::make(403, 'Cette action n’est pas autorisée par votre fiche de poste.');
        }
    }

    public static function scopeRestricted(array $user, string $feature): bool
    {
        $permission = self::permissionFor($user, $feature);

        return $user['role'] === 'COMMERCIAL' || ($permission !== null && empty($permission['can_view_all']));
    }

    /** Un identifiant étranger soumis doit avoir la même visibilité que la liste de sélection. */
    public static function canLinkRecord(array $user, string $feature, mixed $id): bool
    {
        if ($id === null || $id === '') {
            return true;
        }
        if (! is_numeric($id) || (int) $id <= 0 || (float) $id != (int) $id) {
            return false;
        }
        [$table, $condition, $repeats] = self::OWNERSHIP[$feature];
        $restricted = self::scopeRestricted($user, $feature);
        $sql = "SELECT x.id FROM {$table} WHERE x.id=?".($restricted ? ' AND '.$condition : '');
        $bindings = array_merge([(int) $id], $restricted ? array_fill(0, $repeats, $user['id']) : []);

        return DB::selectOne($sql, $bindings) !== null;
    }
}
