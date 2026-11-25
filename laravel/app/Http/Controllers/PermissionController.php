<?php

namespace App\Http\Controllers;

use App\Support\Input;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

/** Reprise de routes/permissions.js. */
class PermissionController extends Controller
{
    public const CATALOGUE = [
        ['module_id' => 'crm', 'module_label' => 'Objectifs', 'feature_id' => 'objectives', 'feature_label' => 'Objectifs Commerciaux'],
        ['module_id' => 'crm', 'module_label' => 'Missions', 'feature_id' => 'missions', 'feature_label' => 'Missions Commerciales'],
        ['module_id' => 'crm', 'module_label' => 'Institutions', 'feature_id' => 'institutions', 'feature_label' => 'Institutions / Prospects'],
        ['module_id' => 'crm', 'module_label' => 'Opportunités', 'feature_id' => 'opportunities', 'feature_label' => 'Pipeline des Opportunités'],
        ['module_id' => 'crm', 'module_label' => 'Rapports', 'feature_id' => 'reports', 'feature_label' => "Rapports d'Activité"],
        ['module_id' => 'admin', 'module_label' => 'Administration', 'feature_id' => 'users', 'feature_label' => 'Utilisateurs et Équipes'],
        ['module_id' => 'admin', 'module_label' => 'Administration', 'feature_id' => 'referentials', 'feature_label' => 'Référentiels Géographiques'],
        ['module_id' => 'admin', 'module_label' => 'Administration', 'feature_id' => 'kpis', 'feature_label' => 'KPI et Indicateurs'],
        ['module_id' => 'admin', 'module_label' => 'Administration', 'feature_id' => 'security', 'feature_label' => 'Sécurité et Audit'],
    ];

    public function catalogue(): JsonResponse
    {
        return $this->ok(self::CATALOGUE);
    }

    public function index(): JsonResponse
    {
        $jobs = $this->rows(DB::select('SELECT id, title, description, role_category FROM job_descriptions ORDER BY role_category, title'));
        $perms = collect($this->rows(DB::select('SELECT job_description_id, module_id, feature_id, can_view, can_create, can_update, can_delete, can_view_all, can_reorganize FROM job_feature_permissions')))->groupBy('job_description_id');

        return $this->ok(array_map(fn ($j) => $j + ['permissions' => $perms->get($j['id'], collect())->values()->all()], $jobs));
    }

    public function show(string $jobId): JsonResponse
    {
        $id = (int) $jobId;
        if (! $id) {
            return $this->err(400, 'Identifiant invalide.');
        }
        $job = DB::selectOne('SELECT id, title, description, role_category FROM job_descriptions WHERE id = ?', [$id]);
        if (! $job) {
            return $this->err(404, 'Fiche de poste introuvable.');
        }

        return $this->ok((array) $job + ['permissions' => $this->rows(DB::select('SELECT module_id, feature_id, can_view, can_create, can_update, can_delete, can_view_all, can_reorganize FROM job_feature_permissions WHERE job_description_id = ?', [$id]))]);
    }

    private function knownFeature(mixed $module, mixed $feature): bool
    {
        // Correctif : la version Node acceptait n'importe quel couple module/feature.
        foreach (self::CATALOGUE as $c) {
            if ($c['module_id'] === $module && $c['feature_id'] === $feature) {
                return true;
            }
        }

        return false;
    }

    private function upsert(int $jobId, string $module, string $feature, array $values): void
    {
        DB::insert('INSERT INTO job_feature_permissions (job_description_id, module_id, feature_id, can_view, can_create, can_update, can_delete, can_view_all, can_reorganize)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE can_view = VALUES(can_view), can_create = VALUES(can_create), can_update = VALUES(can_update),
            can_delete = VALUES(can_delete), can_view_all = VALUES(can_view_all), can_reorganize = VALUES(can_reorganize)', array_merge([$jobId, $module, $feature], $values));
    }

    private function editableJob(int $jobId): ?JsonResponse
    {
        $job = DB::selectOne('SELECT id, role_category FROM job_descriptions WHERE id = ?', [$jobId]);
        if (! $job) {
            return $this->err(404, 'Fiche de poste introuvable.');
        }
        if ($job->role_category === 'SYSTEM') {
            return $this->err(403, 'Les habilitations du rôle Système ne peuvent pas être modifiées.');
        }

        return null;
    }

    public function updateFeature(Request $request, string $jobId): JsonResponse
    {
        $id = (int) $jobId;
        if (! $id) {
            return $this->err(400, 'Identifiant invalide.');
        }
        $b = $this->body($request);
        if (empty($b['module_id']) || empty($b['feature_id'])) {
            return $this->err(400, 'module_id et feature_id sont requis.');
        }
        if (! $this->knownFeature($b['module_id'], $b['feature_id'])) {
            return $this->err(400, 'Fonctionnalité inconnue.');
        }
        if ($r = $this->editableJob($id)) {
            return $r;
        }
        $flags = array_map(fn ($k) => ! empty($b[$k]) ? 1 : 0, ['can_view', 'can_create', 'can_update', 'can_delete', 'can_view_all', 'can_reorganize']);
        $this->upsert($id, $b['module_id'], $b['feature_id'], $flags);
        DB::insert("INSERT INTO crm_audit_logs (user_id, action_type, module_name, ip_address) VALUES (?, ?, 'permissions', ?)", [
            $this->user()['id'], mb_substr("MAJ habilitations job#{$id} - {$b['module_id']}/{$b['feature_id']}", 0, 100), Input::ip(),
        ]);

        return $this->ok(['message' => 'Habilitation mise à jour.']);
    }

    public function selectAll(Request $request, string $jobId): JsonResponse
    {
        $id = (int) $jobId;
        if (! $id) {
            return $this->err(400, 'Identifiant invalide.');
        }
        $b = $this->body($request);
        if (empty($b['module_id']) || empty($b['feature_id'])) {
            return $this->err(400, 'module_id et feature_id sont requis.');
        }
        if (! $this->knownFeature($b['module_id'], $b['feature_id'])) {
            return $this->err(400, 'Fonctionnalité inconnue.');
        }
        if ($r = $this->editableJob($id)) {
            return $r;
        }
        $v = ! empty($b['enable_all']) ? 1 : 0;
        $this->upsert($id, $b['module_id'], $b['feature_id'], array_fill(0, 6, $v));

        return $this->ok(['message' => $v ? 'Toutes les habilitations activées.' : 'Toutes les habilitations désactivées.']);
    }
}
