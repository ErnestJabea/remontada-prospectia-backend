<?php

namespace App\Http\Controllers;

use App\Exceptions\ApiException;
use App\Services\Notifier;
use App\Services\ObjectiveProposals;
use App\Support\Input;
use App\Support\Rows;
use Illuminate\Database\QueryException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

/** Reprise de routes/objectives.js (référentiels domaines/KPI, CRUD, workflow, moteur d'évaluation). */
class ObjectiveController extends Controller
{
    private const KPI_TYPES = ['QUANTITATIVE', 'QUALITATIVE', 'FINANCIAL', 'PERCENTAGE', 'CALCULATED', 'MANUAL'];

    private const AFFECTATION_TYPES = ['COMMERCIAL', 'TEAM', 'REGION', 'DEPARTMENT'];

    private const RATING_RATES = ['NOT_ACHIEVED' => 0, 'UNDER_EXPECTATIONS' => 50, 'ACHIEVED' => 100, 'EXCEEDED' => 120];

    private const FIELD_ORIGIN = "CASE WHEN EXISTS (SELECT 1 FROM objectif_historiques origin WHERE origin.objective_id=o.id AND origin.action='CREATE_PROPOSAL') THEN 'FIELD' ELSE 'BACKOFFICE' END AS creation_source";

    // ------------------------------------------------------------ Domaines & KPI

    public function domains(): JsonResponse
    {
        return $this->ok($this->rows(DB::select('SELECT * FROM objectif_domaines ORDER BY name ASC')));
    }

    public function storeDomain(Request $request): JsonResponse
    {
        $b = $this->body($request);
        if (empty($b['code']) || empty($b['name'])) {
            return $this->err(400, 'Code et libellé requis.');
        }
        DB::insert('INSERT INTO objectif_domaines (code, name, description) VALUES (?, ?, ?)', [strtoupper((string) $b['code']), $b['name'], ($b['description'] ?? null) ?: null]);

        return $this->ok(['id' => (int) DB::getPdo()->lastInsertId(), 'message' => 'Domaine de résultat créé.'], 201);
    }

    public function updateDomain(Request $request, int $id): JsonResponse
    {
        $b = $this->body($request);
        if (empty($b['code']) || empty($b['name'])) {
            return $this->err(400, 'Code et libellé requis.'); // correctif : Node plantait (500) sur un code absent
        }
        DB::update('UPDATE objectif_domaines SET code = ?, name = ?, description = ?, active = ? WHERE id = ?', [strtoupper((string) $b['code']), $b['name'], ($b['description'] ?? null) ?: null, ($b['active'] ?? null) !== false, $id]);

        return $this->ok(['message' => 'Domaine de résultat mis à jour.']);
    }

    public function destroyDomain(int $id): JsonResponse
    {
        try {
            DB::delete('DELETE FROM objectif_domaines WHERE id = ?', [$id]);
        } catch (QueryException) {
            return $this->err(409, 'Impossible de supprimer car le domaine est lié à des objectifs ou KPIs.');
        }

        return $this->ok(['message' => 'Domaine de résultat supprimé.']);
    }

    public function kpis(): JsonResponse
    {
        return $this->ok($this->rows(DB::select('SELECT k.*, d.name as domain_name FROM kpis k JOIN objectif_domaines d ON k.domain_id = d.id ORDER BY k.name ASC')));
    }

    private function validateKpi(array $b): ?JsonResponse
    {
        $type = strtoupper((string) ($b['type'] ?? ''));
        if (! in_array($type, self::KPI_TYPES, true)) {
            return $this->err(400, 'Type de KPI non valide.');
        }
        if ($type === 'QUALITATIVE' && ($b['calculation_source'] ?? null) !== 'MANUAL') {
            return $this->err(400, 'Un KPI qualitatif doit être évalué manuellement.');
        }
        if (! in_array($b['calculation_source'] ?? null, ['MISSIONS', 'OPPORTUNITIES', 'REPORTS', 'ACTIVITIES', 'MANUAL'], true)) {
            return $this->err(400, 'Source de calcul non valide.');
        }
        if (! empty($b['calculation_rule'])) {
            $rule = json_decode((string) $b['calculation_rule'], true);
            if (! is_array($rule)) {
                return $this->err(400, 'La règle de calcul doit être un JSON valide.');
            }
            if (isset($rule['aggregate']) && ! in_array($rule['aggregate'], ['COUNT', 'SUM', 'AVG', 'PERCENTAGE'], true)) {
                return $this->err(400, 'Agrégation de calcul non autorisée.');
            }
        }

        return null;
    }

    public function storeKpi(Request $request): JsonResponse
    {
        $b = $this->body($request);
        foreach (['code', 'name', 'domain_id', 'type', 'unit', 'calculation_source'] as $k) {
            if (empty($b[$k])) {
                return $this->err(400, 'Champs requis manquants pour le KPI.');
            }
        }
        if ($r = $this->validateKpi($b)) {
            return $r;
        }
        DB::insert('INSERT INTO kpis (code, name, description, domain_id, type, unit, calculation_source, calculation_rule) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
            strtoupper((string) $b['code']), $b['name'], ($b['description'] ?? null) ?: null, $b['domain_id'], strtoupper($b['type']), $b['unit'], $b['calculation_source'], ($b['calculation_rule'] ?? null) ?: null,
        ]);

        return $this->ok(['id' => (int) DB::getPdo()->lastInsertId(), 'message' => 'KPI créé.'], 201);
    }

    public function updateKpi(Request $request, int $id): JsonResponse
    {
        $b = $this->body($request);
        if ($r = $this->validateKpi($b)) {
            return $r;
        }
        $type = strtoupper($b['type']);
        $current = DB::selectOne('SELECT type FROM kpis WHERE id = ? LIMIT 1', [$id]);
        if (! $current) {
            return $this->err(404, 'KPI introuvable.');
        }
        if ($current->type !== $type && DB::selectOne('SELECT COUNT(*) AS total FROM crm_objectives WHERE kpi_id = ?', [$id])->total > 0) {
            return $this->err(409, "Le type d'un KPI déjà utilisé ne peut pas être modifié.");
        }
        DB::update('UPDATE kpis SET code = ?, name = ?, description = ?, domain_id = ?, type = ?, unit = ?, calculation_source = ?, calculation_rule = ?, active = ? WHERE id = ?', [
            strtoupper((string) ($b['code'] ?? '')), $b['name'] ?? null, ($b['description'] ?? null) ?: null, $b['domain_id'] ?? null, $type, $b['unit'] ?? null, $b['calculation_source'],
            ($b['calculation_rule'] ?? null) ?: null, ($b['active'] ?? null) !== false, $id,
        ]);

        return $this->ok(['message' => 'KPI mis à jour.']);
    }

    public function destroyKpi(int $id): JsonResponse
    {
        try {
            DB::delete('DELETE FROM kpis WHERE id = ?', [$id]);
        } catch (QueryException) {
            return $this->err(409, "Impossible de supprimer car le KPI est actuellement en cours d'utilisation.");
        }

        return $this->ok(['message' => 'KPI supprimé.']);
    }

    // ------------------------------------------------------------ Moteur d'évaluation

    private function evaluateKpi(object $kpi, mixed $responsibleId, string $start, string $end): ?float
    {
        if ($kpi->calculation_source === 'MANUAL') {
            return null;
        }
        $rule = Rows::decode($kpi->calculation_rule, []) ?? [];
        $aggregate = in_array($rule['aggregate'] ?? 'COUNT', ['COUNT', 'SUM', 'AVG'], true) ? ($rule['aggregate'] ?? 'COUNT') : 'COUNT';
        // Correctif : colonne d'agrégation sur liste blanche (Node l'échappait seulement).
        $field = in_array($rule['field'] ?? 'id', ['id', 'estimated_amount', 'final_amount', 'duration_hours', 'estimated_travel_cost'], true) ? ($rule['field'] ?? 'id') : 'id';
        $prefix = $kpi->calculation_source === 'REPORTS' ? 'r.' : '';
        $select = "{$aggregate}({$prefix}`{$field}`) AS result";
        [$sql, $bind] = match ($kpi->calculation_source) {
            'MISSIONS', 'ACTIVITIES' => ["SELECT {$select} FROM crm_missions WHERE primary_commercial_id = ? AND scheduled_date BETWEEN ? AND ?", [$responsibleId, $start, $end]],
            'OPPORTUNITIES' => ["SELECT {$select} FROM crm_opportunities WHERE assigned_to = ? AND created_at BETWEEN ? AND ?", [$responsibleId, $start, $end]],
            'REPORTS' => ["SELECT {$select} FROM crm_reports r JOIN crm_missions m ON r.mission_id = m.id WHERE m.primary_commercial_id = ? AND r.created_at BETWEEN ? AND ?", [$responsibleId, $start, $end]],
            default => [null, []],
        };
        if (! $sql) {
            return 0.0;
        }
        foreach ($rule['filters'] ?? [] as $f) {
            if (! in_array($f['column'] ?? null, ['status', 'type', 'priority', 'pipeline_stage', 'estimated_amount', 'id'], true) || ! in_array($f['operator'] ?? null, ['=', '!=', '>', '<', '>=', '<=', 'IN'], true)) {
                continue;
            }
            $col = "{$prefix}`{$f['column']}`";
            if ($f['operator'] === 'IN') {
                if (is_array($f['value'] ?? null) && $f['value']) {
                    $sql .= " AND {$col} IN (".implode(',', array_fill(0, count($f['value']), '?')).')';
                    array_push($bind, ...$f['value']);
                }
            } else {
                $sql .= " AND {$col} {$f['operator']} ?";
                $bind[] = $f['value'] ?? null;
            }
        }

        return (float) (DB::selectOne($sql, $bind)->result ?? 0);
    }

    private function evaluate(int $id, int $userId): void
    {
        $o = DB::selectOne('SELECT * FROM crm_objectives WHERE id = ?', [$id]);
        if (! $o) {
            return;
        }
        if ($o->objective_nature === 'QUALITATIVE') {
            throw ApiException::make(400, 'Un objectif qualitatif doit être évalué par une appréciation documentée.');
        }
        $children = DB::select('SELECT id, achieved_value FROM crm_objectives WHERE parent_id = ?', [$id]);
        $achieved = 0.0;
        $manual = false;
        if ($children) {
            $achieved = array_sum(array_map(fn ($c) => (float) $c->achieved_value, $children));
        } elseif ($kpi = DB::selectOne('SELECT * FROM kpis WHERE id = ?', [$o->kpi_id])) {
            if ($kpi->calculation_source !== 'MANUAL') {
                $achieved = $this->evaluateKpi($kpi, $o->responsible_id, $o->start_date.' 00:00:00', $o->end_date.' 23:59:59') ?? (float) $o->achieved_value;
            } else {
                $achieved = (float) $o->achieved_value;
                $manual = true;
            }
        }
        $target = (float) ($o->target_value ?: 1);
        $rate = $target > 0 ? $achieved / $target * 100 : 0;
        $min = (float) $o->min_level;
        $exp = (float) $o->expected_level;
        $exc = (float) $o->excellent_level;
        $perf = $achieved < $min ? 'NOT_ACHIEVED' : ($achieved < $exp ? 'UNDER_EXPECTATIONS' : ($achieved < $exc ? 'ACHIEVED' : 'EXCEEDED'));
        $status = in_array($o->status, ['VALIDATED', 'ASSIGNED'], true) && $o->responsible_id && strtotime($o->start_date) <= time() ? 'IN_PROGRESS' : $o->status;
        DB::update('UPDATE crm_objectives SET achieved_value = ?, achievement_rate = ?, performance_status = ?, status = ? WHERE id = ?', [$achieved, $rate, $perf, $status, $id]);
        DB::insert('INSERT INTO objectif_resultats (objective_id, achieved_value, target_value, gap, achievement_rate, notes, recorded_by) VALUES (?, ?, ?, ?, ?, ?, ?)', [$id, $achieved, $target, $achieved - $target, $rate, $manual ? 'Saisie Manuelle' : 'Évaluation Automatique', $userId]);
        if ($o->parent_id) {
            $this->evaluate((int) $o->parent_id, $userId);
        }
    }

    // ------------------------------------------------------------ Helpers métier

    private function canAccess(array $o): bool
    {
        $u = $this->user();
        if ($this->isManager() || (int) $o['responsible_id'] === $u['id'] || (int) $o['created_by'] === $u['id']) {
            return true;
        }

        return (bool) DB::selectOne("SELECT 1 FROM objectif_affectations WHERE objective_id = ? AND type = 'COMMERCIAL' AND target_id = ? LIMIT 1", [$o['id'], $u['id']]);
    }

    private function assertActiveCommercials(array $ids, string $label): array
    {
        $ids = array_values(array_unique(array_filter(array_map([Input::class, 'positiveId'], $ids))));
        if (! $ids) {
            return [];
        }
        $users = DB::table('users')->whereIn('id', $ids)->get(['id', 'role', 'is_active'])->keyBy('id');
        foreach ($ids as $id) {
            $u = $users->get($id);
            if (! $u || $u->role !== 'COMMERCIAL' || ! $u->is_active) {
                throw ApiException::make(400, "{$label} doit être un commercial actif.");
            }
        }

        return $ids;
    }

    private function participants(mixed $responsibleId, mixed $team, int $creatorId, bool $allowCreator = false): array
    {
        $responsible = $responsibleId ? Input::positiveId($responsibleId) : null;
        if ($responsibleId && ! $responsible) {
            throw ApiException::make(400, 'Responsable principal invalide.');
        }
        if (! $allowCreator && $responsible && $responsible === $creatorId) {
            throw ApiException::make(403, 'Le créateur ne peut pas se désigner comme responsable principal de son propre objectif.');
        }
        $teamIds = array_values(array_unique(array_filter(array_map([Input::class, 'positiveId'], is_array($team) ? $team : []))));
        if (in_array($creatorId, $teamIds, true)) {
            throw ApiException::make(403, "Le créateur ne peut pas s'ajouter dans l'équipe de son propre objectif.");
        }
        if ($responsible && in_array($responsible, $teamIds, true)) {
            throw ApiException::make(400, 'Le responsable principal ne doit pas être répété dans la liste des commerciaux concernés.');
        }
        $this->assertActiveCommercials(array_filter([$responsible, ...$teamIds]), 'Le responsable principal et les commerciaux concernés');

        return [$responsible, $teamIds];
    }

    private function assertHierarchy(mixed $parentId, string $nature, ?int $objectiveId = null): void
    {
        $parent = Input::positiveId($parentId);
        if ($parentId && ! $parent) {
            throw ApiException::make(400, 'Objectif parent invalide.');
        }
        if ($parent) {
            if ($objectiveId && $parent === $objectiveId) {
                throw ApiException::make(400, 'Un objectif ne peut pas être son propre parent.');
            }
            $p = DB::selectOne('SELECT objective_nature FROM crm_objectives WHERE id = ? LIMIT 1', [$parent]) ?? throw ApiException::make(400, 'Objectif parent introuvable.');
            if ($p->objective_nature !== $nature) {
                throw ApiException::make(400, 'Un objectif et son parent doivent avoir la même nature de mesure.');
            }
        }
        if ($objectiveId && DB::selectOne('SELECT COUNT(*) AS total FROM crm_objectives WHERE parent_id = ? AND objective_nature <> ?', [$objectiveId, $nature])->total > 0) {
            throw ApiException::make(400, 'La nature de cet objectif est incompatible avec celle de ses sous-objectifs.');
        }
    }

    private function syncTeam(int $id, array $teamIds): void
    {
        DB::delete("DELETE FROM objectif_affectations WHERE objective_id = ? AND type = 'COMMERCIAL' AND value_allocated = 0", [$id]);
        if (! $teamIds) {
            return;
        }
        foreach (DB::table('users')->whereIn('id', $teamIds)->where('role', 'COMMERCIAL')->where('is_active', true)->get(['id', 'full_name']) as $c) {
            DB::insert("INSERT INTO objectif_affectations (objective_id, type, target_id, target_name, value_allocated) VALUES (?, 'COMMERCIAL', ?, ?, 0)", [$id, $c->id, $c->full_name]);
        }
    }

    private function replaceNeeds(int $id, array $b, bool $clear): void
    {
        if (is_array($b['moyens'] ?? null)) {
            if ($clear) {
                DB::delete('DELETE FROM objectif_moyens WHERE objective_id = ?', [$id]);
            }
            foreach ($b['moyens'] as $m) {
                if (is_array($m) && trim((string) ($m['description'] ?? '')) !== '') {
                    DB::insert("INSERT INTO objectif_moyens (objective_id, type, description, quantity, estimated_cost, approval_status) VALUES (?, ?, ?, ?, ?, 'PENDING')", [$id, ($m['type'] ?? null) ?: 'BUDGET', trim($m['description']), ($m['quantity'] ?? null) ?: 1, ($m['estimated_cost'] ?? null) ?: 0]);
                }
            }
        }
        if (is_array($b['formations'] ?? null)) {
            if ($clear) {
                DB::delete('DELETE FROM objectif_formations WHERE objective_id = ?', [$id]);
            }
            foreach ($b['formations'] as $f) {
                if (is_array($f) && trim((string) ($f['theme'] ?? '')) !== '') {
                    DB::insert("INSERT INTO objectif_formations (objective_id, theme, goal, period, priority, status) VALUES (?, ?, ?, ?, ?, 'PENDING')", [$id, trim($f['theme']), ($f['goal'] ?? null) ?: '-', ($f['period'] ?? null) ?: '-', ($f['priority'] ?? null) ?: 'MEDIUM']);
                }
            }
        }
    }

    private function validateBase(array $b): ?JsonResponse
    {
        $title = $b['title'] ?? null;
        if (! is_string($title) || trim($title) === '') {
            return $this->err(400, "Le titre de l'objectif est obligatoire.");
        }
        if (mb_strlen($title) > 1000) {
            return $this->err(400, 'Le titre est trop long (maximum 1000 caractères).');
        }
        if (! in_array($b['period_type'] ?? null, ObjectiveProposals::PERIODS, true)) {
            return $this->err(400, 'Type de périodicité invalide : '.(is_scalar($b['period_type'] ?? null) ? $b['period_type'] : ''));
        }
        if (empty($b['start_date']) || strtotime((string) $b['start_date']) === false) {
            return $this->err(400, 'Date de début invalide.');
        }
        if (empty($b['end_date']) || strtotime((string) $b['end_date']) === false) {
            return $this->err(400, 'Date de fin invalide.');
        }
        if (strtotime($b['start_date']) > strtotime($b['end_date'])) {
            return $this->err(400, 'La date de début ne peut pas être supérieure à la date de fin.');
        }
        if (! Input::num($b['domain_id'] ?? null)) {
            return $this->err(400, 'Le domaine clé de résultat est obligatoire.');
        }
        if (! Input::num($b['kpi_id'] ?? null)) {
            return $this->err(400, "L'indicateur KPI est obligatoire.");
        }

        return null;
    }

    private function history(int $id, string $action, mixed $old, mixed $new, ?string $comments): void
    {
        ObjectiveProposals::history($id, $this->user()['id'], $action, $old, $new, $comments ?: null, Input::ip());
    }

    // ------------------------------------------------------------ CRUD

    public function index(Request $request): JsonResponse
    {
        $sql = 'SELECT o.*, '.self::FIELD_ORIGIN.', u.full_name as assignee_name, c.full_name as creator_name, k.name as kpi_name, k.type as kpi_type, k.unit as kpi_unit, d.name as domain_name
            FROM crm_objectives o LEFT JOIN users u ON o.responsible_id = u.id LEFT JOIN users c ON o.created_by = c.id LEFT JOIN kpis k ON o.kpi_id = k.id LEFT JOIN objectif_domaines d ON o.domain_id = d.id';
        $cond = [];
        $bind = [];
        $u = $this->user();
        if ($u['role'] === 'COMMERCIAL' || $u['restrictFeatureScope']) {
            $cond[] = "(o.created_by = ? OR o.responsible_id = ? OR o.id IN (SELECT objective_id FROM objectif_affectations WHERE target_id = ? AND type = 'COMMERCIAL'))";
            array_push($bind, $u['id'], $u['id'], $u['id']);
        } elseif ($r = $request->query('responsible_id')) {
            $cond[] = 'o.responsible_id = ?';
            $bind[] = $r;
        }
        foreach (['status' => 'o.status', 'period_type' => 'o.period_type', 'domain_id' => 'o.domain_id'] as $q => $col) {
            if ($v = $request->query($q)) {
                $cond[] = "{$col} = ?";
                $bind[] = $v;
            }
        }
        if ($cond) {
            $sql .= ' WHERE '.implode(' AND ', $cond);
        }
        $rows = $this->rows(DB::select("{$sql} ORDER BY o.created_at DESC", $bind));
        $affectations = $rows ? collect($this->rows(DB::table('objectif_affectations')->whereIn('objective_id', array_column($rows, 'id'))->get()))->groupBy('objective_id') : collect();
        foreach ($rows as &$row) {
            $row['qualitative_criteria'] = is_string($row['qualitative_criteria']) ? (Rows::decode($row['qualitative_criteria'], []) ?? []) : $row['qualitative_criteria'];
            $row['affectations'] = $affectations->get($row['id'], collect())->values()->all();
            $row['team_member_ids'] = collect($row['affectations'])->filter(fn ($a) => $a['type'] === 'COMMERCIAL' && (float) $a['value_allocated'] == 0 && $a['target_id'])->pluck('target_id')->values()->all();
        }

        return $this->ok($rows);
    }

    public function show(int $id): JsonResponse
    {
        $o = Rows::one(DB::selectOne('SELECT o.*, '.self::FIELD_ORIGIN.', u.full_name as responsible_name, u.role as responsible_role, k.name as kpi_name, k.type as kpi_type, k.calculation_source as kpi_source, d.name as domain_name, p.title as parent_title
            FROM crm_objectives o LEFT JOIN users u ON o.responsible_id = u.id LEFT JOIN kpis k ON o.kpi_id = k.id LEFT JOIN objectif_domaines d ON o.domain_id = d.id LEFT JOIN crm_objectives p ON o.parent_id = p.id WHERE o.id = ?', [$id]));
        if (! $o) {
            return $this->err(404, 'Objectif introuvable.');
        }
        if (! $this->canAccess($o)) {
            return $this->err(403, 'Acces refuse.');
        }
        $o['moyens'] = $this->rows(DB::select('SELECT * FROM objectif_moyens WHERE objective_id = ?', [$id]));
        $o['formations'] = $this->rows(DB::select('SELECT * FROM objectif_formations WHERE objective_id = ?', [$id]));
        $o['affectations'] = $this->rows(DB::select('SELECT * FROM objectif_affectations WHERE objective_id = ?', [$id]));
        $o['historiques'] = $this->rows(DB::select('SELECT h.*, u.full_name as user_name FROM objectif_historiques h JOIN users u ON h.user_id = u.id WHERE h.objective_id = ? ORDER BY h.created_at DESC', [$id]));
        $o['resultats'] = $this->rows(DB::select('SELECT * FROM objectif_resultats WHERE objective_id = ? ORDER BY date_calculated DESC', [$id]));
        $o['qualitative_criteria'] = Rows::decode($o['qualitative_criteria'], []) ?? [];

        return $this->ok($o);
    }

    public function storeProposal(Request $request): JsonResponse
    {
        $b = $this->body($request);
        $submit = (bool) ($b['submit_immediately'] ?? false);
        $r = ObjectiveProposals::create($this->user(), $b, $submit);

        return $this->ok(['objective' => $r['objective'], 'created' => $r['created'], 'message' => $r['created']
            ? ($submit ? 'Objectif créé et soumis à la direction.' : 'Objectif enregistré comme brouillon.')
            : 'Cette proposition avait déjà été synchronisée.'], $r['created'] ? 201 : 200);
    }

    public function updateProposal(Request $request, int $id): JsonResponse
    {
        return $this->ok(['objective' => ObjectiveProposals::update($this->user(), $id, $this->body($request)), 'message' => 'Proposition mise à jour.']);
    }

    public function store(Request $request): JsonResponse
    {
        $b = $this->body($request);
        if ($r = $this->validateBase($b)) {
            return $r;
        }

        return DB::transaction(function () use ($b) {
            $kpi = ObjectiveProposals::assertActiveKpi((int) $b['domain_id'], (int) $b['kpi_id']);
            $t = ObjectiveProposals::normalizeTargets($b, ObjectiveProposals::natureFromKpiType($kpi->type));
            $this->assertHierarchy($b['parent_id'] ?? null, $t['objective_nature']);
            [$responsible, $team] = $this->participants($b['responsible_id'] ?? null, $b['team_member_ids'] ?? [], $this->user()['id']);
            DB::insert("INSERT INTO crm_objectives (code, title, description, parent_id, period_type, start_date, end_date, responsible_id, domain_id, kpi_id, objective_nature, target_value, unit, min_level,
                expected_level, excellent_level, target_qlty, qualitative_criteria, direction, department, service, observations, status, created_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?)", [
                ($b['code'] ?? null) ?: null, trim($b['title']), ($b['description'] ?? null) ?: null, ($b['parent_id'] ?? null) ?: null, $b['period_type'], $b['start_date'], $b['end_date'], $responsible,
                $b['domain_id'], $b['kpi_id'], $t['objective_nature'], $t['target_value'], $kpi->unit, $t['min_level'], $t['expected_level'], $t['excellent_level'], $t['target_qlty'],
                json_encode($t['qualitative_criteria'], JSON_UNESCAPED_UNICODE), ($b['direction'] ?? null) ?: null, ($b['department'] ?? null) ?: null, ($b['service'] ?? null) ?: null,
                ($b['observations'] ?? null) ?: null, $this->user()['id'],
            ]);
            $id = (int) DB::getPdo()->lastInsertId();
            $this->replaceNeeds($id, $b, false);
            $this->syncTeam($id, $team);

            return $this->ok(['id' => $id, 'message' => 'Objectif créé sous forme de brouillon.'], 201);
        });
    }

    public function update(Request $request, int $id): JsonResponse
    {
        $b = $this->body($request);
        if ($r = $this->validateBase($b)) {
            return $r;
        }

        return DB::transaction(function () use ($b, $id) {
            $old = Rows::one(DB::selectOne('SELECT * FROM crm_objectives WHERE id = ? FOR UPDATE', [$id]));
            if (! $old) {
                return $this->err(404, 'Objectif introuvable.');
            }
            $u = $this->user();
            if (! $this->isManager() && (int) $old['created_by'] !== $u['id'] && (int) $old['responsible_id'] !== $u['id']) {
                return $this->err(403, 'Acces refuse.');
            }
            if (! in_array($old['status'], ['DRAFT', 'CORRECTION'], true) && ! $this->isManager()) {
                return $this->err(403, 'Vous ne pouvez plus modifier cet objectif dans son statut actuel.');
            }
            $kpi = ObjectiveProposals::assertActiveKpi((int) $b['domain_id'], (int) $b['kpi_id']);
            $t = ObjectiveProposals::normalizeTargets($b, ObjectiveProposals::natureFromKpiType($kpi->type));
            $this->assertHierarchy($b['parent_id'] ?? null, $t['objective_nature'], $id);
            [$responsible, $team] = $this->participants($b['responsible_id'] ?? null, $b['team_member_ids'] ?? [], (int) $old['created_by'], (int) $old['responsible_id'] === (int) $old['created_by']);
            DB::update('UPDATE crm_objectives SET code = ?, title = ?, description = ?, parent_id = ?, period_type = ?, start_date = ?, end_date = ?, responsible_id = ?, domain_id = ?, kpi_id = ?,
                objective_nature = ?, target_value = ?, unit = ?, min_level = ?, expected_level = ?, excellent_level = ?, target_qlty = ?, qualitative_criteria = ?, direction = ?, department = ?, service = ?, observations = ? WHERE id = ?', [
                ($b['code'] ?? null) ?: null, trim($b['title']), ($b['description'] ?? null) ?: null, ($b['parent_id'] ?? null) ?: null, $b['period_type'], $b['start_date'], $b['end_date'], $responsible,
                $b['domain_id'], $b['kpi_id'], $t['objective_nature'], $t['target_value'], $kpi->unit, $t['min_level'], $t['expected_level'], $t['excellent_level'], $t['target_qlty'],
                json_encode($t['qualitative_criteria'], JSON_UNESCAPED_UNICODE), ($b['direction'] ?? null) ?: null, ($b['department'] ?? null) ?: null, ($b['service'] ?? null) ?: null, ($b['observations'] ?? null) ?: null, $id,
            ]);
            $this->replaceNeeds($id, $b, true);
            if (is_array($b['team_member_ids'] ?? null)) {
                $this->syncTeam($id, $team);
            }
            $this->history($id, 'UPDATE', $old, ['title' => $b['title'], 'target_value' => $b['target_value'] ?? null], "Modification de l'objectif");

            return $this->ok(['message' => 'Objectif mis à jour avec succès.']);
        });
    }

    public function destroy(int $id): JsonResponse
    {
        $o = DB::selectOne('SELECT status, created_by, responsible_id FROM crm_objectives WHERE id = ?', [$id]);
        if (! $o) {
            return $this->err(404, 'Objectif introuvable.');
        }
        $u = $this->user();
        if (! $this->isManager() && (int) $o->created_by !== $u['id'] && (int) $o->responsible_id !== $u['id']) {
            return $this->err(403, 'Acces refuse.');
        }
        if ($o->status !== 'DRAFT' && ! $this->isManager()) {
            return $this->err(403, 'Seuls les brouillons peuvent être supprimés.');
        }
        DB::delete('DELETE FROM crm_objectives WHERE id = ?', [$id]);

        return $this->ok(['message' => 'Objectif supprimé.']);
    }

    // ------------------------------------------------------------ Workflow

    public function submit(int $id): JsonResponse
    {
        if ($this->user()['role'] === 'COMMERCIAL') {
            return $this->ok(['message' => 'Objectif soumis à la direction.', 'objective' => ObjectiveProposals::submit($this->user(), $id)]);
        }

        return DB::transaction(function () use ($id) {
            $o = DB::selectOne('SELECT * FROM crm_objectives WHERE id = ? FOR UPDATE', [$id]);
            if (! $o) {
                return $this->err(404, 'Objectif introuvable.');
            }
            $u = $this->user();
            if (! $this->isManager() && (int) $o->created_by !== $u['id'] && (int) $o->responsible_id !== $u['id']) {
                return $this->err(403, 'Acces refuse.');
            }
            if (! in_array($o->status, ['DRAFT', 'CORRECTION'], true)) {
                return $this->err(400, "L'objectif n'est pas dans un état soumisible.");
            }
            [$responsible] = $this->participants($o->responsible_id, [], (int) $o->created_by);
            if (! $responsible) {
                return $this->err(400, 'Le responsable principal est obligatoire avant soumission.');
            }
            DB::update("UPDATE crm_objectives SET status = 'SUBMITTED' WHERE id = ?", [$id]);
            $this->history($id, 'SUBMIT', $o->status, 'SUBMITTED', 'Soumission pour validation');
            Notifier::notifyDirection('Objectif Soumis', "L'objectif \"{$o->title}\" a été soumis pour validation par {$u['full_name']}.", 'OBJECTIVE_SUBMITTED', $id);

            return $this->ok(['message' => 'Objectif soumis à la direction.']);
        });
    }

    public function validateObjective(Request $request, int $id): JsonResponse
    {
        $b = $this->body($request);
        $action = $b['action'] ?? null;
        if (! in_array($action, ['VALIDATE', 'CORRECTION', 'REJECT'], true)) {
            return $this->err(400, 'Action invalide.');
        }

        return DB::transaction(function () use ($b, $id, $action) {
            $o = DB::selectOne('SELECT * FROM crm_objectives WHERE id = ? FOR UPDATE', [$id]);
            if (! $o) {
                return $this->err(404, 'Objectif introuvable.');
            }
            if ($o->status !== 'SUBMITTED') {
                return $this->err(400, 'Seuls les objectifs soumis peuvent être validés.');
            }
            $responsible = $o->responsible_id ? (int) $o->responsible_id : null;
            [$status, $label] = match ($action) {
                'CORRECTION' => ['CORRECTION', 'NEED_CORRECTION'],
                'REJECT' => ['REJECTED', 'REJECT'],
                default => ['VALIDATED', 'VALIDATE'],
            };
            if ($action === 'VALIDATE') {
                if (! $responsible) {
                    $creator = DB::selectOne('SELECT id, role, is_active FROM users WHERE id = ? LIMIT 1', [$o->created_by]);
                    if ($creator && $creator->role === 'COMMERCIAL' && $creator->is_active) {
                        $responsible = (int) $creator->id;
                    }
                }
                if (! $responsible) {
                    throw ApiException::make(400, 'Le responsable principal est obligatoire avant validation.');
                }
                if ($responsible !== (int) $o->created_by) {
                    $this->participants($responsible, [], (int) $o->created_by);
                }
                $fromField = DB::selectOne("SELECT id FROM objectif_historiques WHERE objective_id=? AND action='CREATE_PROPOSAL' LIMIT 1", [$id]);
                $status = $fromField ? 'VALIDATED' : 'ASSIGNED';
            }
            DB::update('UPDATE crm_objectives SET status = ?, responsible_id = ? WHERE id = ?', [$status, $responsible, $id]);
            foreach (is_array($b['moyens'] ?? null) ? $b['moyens'] : [] as $m) {
                DB::update('UPDATE objectif_moyens SET validated_cost = ?, approval_status = ? WHERE id = ? AND objective_id = ?', [($m['validated_cost'] ?? null) ?: 0, ($m['approval_status'] ?? null) ?: 'APPROVED', $m['id'] ?? null, $id]);
            }
            foreach (is_array($b['formations'] ?? null) ? $b['formations'] : [] as $f) {
                DB::update('UPDATE objectif_formations SET status = ? WHERE id = ? AND objective_id = ?', [($f['status'] ?? null) ?: 'APPROVED', $f['id'] ?? null, $id]);
            }
            $this->history($id, $label, $o->status, $status, $b['comments'] ?? null);
            [$title, $type, $verb] = match ($action) {
                'VALIDATE' => ['Objectif Validé', 'OBJECTIVE_VALIDATED', 'validé'],
                'CORRECTION' => ['Objectif à Corriger', 'OBJECTIVE_CORRECTION', 'renvoyé pour correction'],
                default => ['Objectif Rejeté', 'OBJECTIVE_REJECTED', 'rejeté'],
            };
            $msg = "Votre objectif \"{$o->title}\" a été {$verb} par la direction.";
            if ($o->created_by) {
                Notifier::notifyUser((int) $o->created_by, $title, $msg, $type, $id);
            }
            if ($responsible && $responsible !== (int) $o->created_by) {
                Notifier::notifyUser($responsible, $title, $msg, $type, $id);
            }

            return $this->ok(['message' => "Objectif mis à jour avec le statut : {$status}"]);
        });
    }

    public function assign(Request $request, int $id): JsonResponse
    {
        $affectations = $this->body($request)['affectations'] ?? null;
        if (! is_array($affectations) || ! $affectations) {
            return $this->err(400, 'Affectations requises.');
        }

        return DB::transaction(function () use ($affectations, $id) {
            $o = DB::selectOne('SELECT * FROM crm_objectives WHERE id = ? FOR UPDATE', [$id]);
            if (! $o) {
                return $this->err(404, 'Objectif introuvable.');
            }
            if (DB::selectOne("SELECT id FROM objectif_historiques WHERE objective_id=? AND action='CREATE_PROPOSAL' LIMIT 1", [$id])) {
                return $this->err(409, 'Un objectif proposé sur le terrain est validé pour son créateur et ne nécessite pas d’affectation.');
            }
            $u = $this->user();
            if (! $this->isManager() && (int) $o->responsible_id !== $u['id']) {
                return $this->err(403, "Permissions d'affectation insuffisantes.");
            }
            if (! in_array($o->status, ['VALIDATED', 'ASSIGNED'], true)) {
                return $this->err(409, 'Seul un objectif valide peut etre affecte.');
            }
            $forbidden = array_filter([$u['id'], (int) $o->created_by, (int) $o->responsible_id]);
            $commercials = [];
            $rows = array_map(function ($a) use ($forbidden, &$commercials) {
                $type = strtoupper((string) ($a['type'] ?? ''));
                if (! in_array($type, self::AFFECTATION_TYPES, true)) {
                    throw ApiException::make(400, "Type d'affectation invalide.");
                }
                $value = $a['value_allocated'] ?? null;
                if (! is_numeric($value) || $value < 0) {
                    throw ApiException::make(400, 'La cible allouée doit être un nombre positif.');
                }
                if ($type === 'COMMERCIAL') {
                    $tid = Input::positiveId($a['target_id'] ?? null) ?? throw ApiException::make(400, 'Bénéficiaire commercial invalide.');
                    if (in_array($tid, $forbidden, true)) {
                        throw ApiException::make(403, "Le créateur, le responsable principal ou l'utilisateur connecté ne peut pas s'attribuer cet objectif.");
                    }
                    $commercials[] = $tid;

                    return ['type' => $type, 'target_id' => $tid, 'target_name' => ($a['target_name'] ?? null) ?: null, 'value_allocated' => (float) $value];
                }
                $name = trim((string) ($a['target_name'] ?? ''));
                if ($name === '') {
                    throw ApiException::make(400, "Le nom du bénéficiaire est obligatoire pour ce type d'affectation.");
                }

                return ['type' => $type, 'target_id' => null, 'target_name' => $name, 'value_allocated' => (float) $value];
            }, $affectations);
            $this->assertActiveCommercials($commercials, 'Chaque bénéficiaire commercial');
            DB::delete('DELETE FROM objectif_affectations WHERE objective_id = ?', [$id]);
            foreach ($rows as $a) {
                DB::insert('INSERT INTO objectif_affectations (objective_id, type, target_id, target_name, value_allocated) VALUES (?, ?, ?, ?, ?)', [$id, $a['type'], $a['target_id'], $a['target_name'], $a['value_allocated']]);
                if ($a['type'] === 'COMMERCIAL') {
                    Notifier::notifyUser($a['target_id'], 'Objectif Affecté', "Un sous-objectif de \"{$o->title}\" vous a été affecté (cible: ".($a['value_allocated'] + 0).').', 'OBJECTIVE_ASSIGNED', $id);
                }
            }
            DB::update("UPDATE crm_objectives SET status = 'ASSIGNED' WHERE id = ?", [$id]);
            $this->history($id, 'ASSIGN', $o->status, 'ASSIGNED', "Affectation des parts d'objectifs");

            return $this->ok(['message' => 'Affectations enregistrées avec succès. Objectif affecté.']);
        });
    }

    public function evaluateAction(int $id): JsonResponse
    {
        $o = DB::selectOne('SELECT id, responsible_id FROM crm_objectives WHERE id = ?', [$id]);
        if (! $o) {
            return $this->err(404, 'Objectif introuvable.');
        }
        if (! $this->isManager() && (int) $o->responsible_id !== $this->user()['id']) {
            return $this->err(403, 'Acces refuse.');
        }
        DB::transaction(fn () => $this->evaluate($id, $this->user()['id']));

        return $this->ok(['message' => 'Évaluation et consolidation accomplies avec succès.']);
    }

    public function recordManual(Request $request, int $id): JsonResponse
    {
        $b = $this->body($request);
        $comments = trim((string) (is_scalar($b['comments'] ?? null) ? $b['comments'] : ''));
        if ($comments === '') {
            return $this->err(400, 'Le commentaire ou la justification est obligatoire.');
        }

        return DB::transaction(function () use ($b, $id, $comments) {
            $o = DB::selectOne('SELECT o.*, k.calculation_source, k.type AS kpi_type FROM crm_objectives o JOIN kpis k ON o.kpi_id = k.id WHERE o.id = ? FOR UPDATE', [$id]);
            if (! $o) {
                return $this->err(404, 'Objectif introuvable.');
            }
            if ($o->calculation_source !== 'MANUAL') {
                return $this->err(400, 'La saisie manuelle est réservée exclusivement aux KPIs de type MANUAL.');
            }
            if ($o->objective_nature === 'QUALITATIVE') {
                $rating = strtoupper((string) ($b['rating'] ?? ''));
                if (! isset(self::RATING_RATES[$rating])) {
                    return $this->err(400, 'Appréciation qualitative invalide.');
                }
                DB::update('UPDATE crm_objectives SET qualitative_rating = ?, qualitative_evidence = ?, achievement_rate = ?, performance_status = ? WHERE id = ?', [$rating, $comments, self::RATING_RATES[$rating], $rating, $id]);
                DB::insert("INSERT INTO objectif_resultats (objective_id, result_type, qualitative_rating, qualitative_evidence, achieved_value, target_value, gap, achievement_rate, notes, recorded_by) VALUES (?, 'QUALITATIVE', ?, ?, NULL, NULL, NULL, ?, ?, ?)", [$id, $rating, $comments, self::RATING_RATES[$rating], $comments, $this->user()['id']]);
                $this->history($id, 'RECORD_QUALITATIVE_PERFORMANCE', ['qualitative_rating' => $o->qualitative_rating], ['qualitative_rating' => $rating], $comments);

                return $this->ok(['message' => 'Appréciation qualitative enregistrée.']);
            }
            $value = $b['value'] ?? null;
            if (! is_numeric($value)) {
                return $this->err(400, 'La valeur réalisée doit être un nombre.');
            }
            DB::update('UPDATE crm_objectives SET achieved_value = ? WHERE id = ?', [(float) $value, $id]);
            $this->evaluate($id, $this->user()['id']);
            $this->history($id, 'RECORD_MANUAL_PERFORMANCE', ['achieved_value' => $o->achieved_value], ['achieved_value' => (float) $value], $comments);

            return $this->ok(['message' => 'Performance manuelle enregistrée et évaluée.']);
        });
    }

    public function close(int $id): JsonResponse
    {
        return DB::transaction(function () use ($id) {
            $o = DB::selectOne('SELECT * FROM crm_objectives WHERE id = ? FOR UPDATE', [$id]);
            if (! $o) {
                return $this->err(404, 'Objectif introuvable.');
            }
            DB::update("UPDATE crm_objectives SET status = 'CLOSED' WHERE id = ?", [$id]);
            $this->history($id, 'CLOSE', $o->status, 'CLOSED', "Clôture de l'objectif");
            if ($o->responsible_id) {
                Notifier::notifyUser((int) $o->responsible_id, 'Objectif Clôturé', "Votre objectif \"{$o->title}\" a été clôturé par la direction.", 'OBJECTIVE_CLOSED', $id);
            }

            return $this->ok(['message' => 'Objectif clôturé et archivé.']);
        });
    }
}
