<?php

namespace App\Services;

use App\Exceptions\ApiException;
use App\Support\Input;
use App\Support\Rows;
use Illuminate\Support\Facades\DB;

/** Reprise de services/objectiveProposalService.js (propositions d'objectifs depuis la PWA). */
class ObjectiveProposals
{
    public const PERIODS = ['ANNUAL', 'SEMESTER', 'SEMESTRIAL', 'TRIMESTER', 'TRIMESTRIAL', 'MONTHLY', 'WEEKLY', 'DAILY', 'EXCEPTIONAL', 'PUNCTUAL'];

    private const MEAN_TYPES = ['BUDGET', 'VEHICLE', 'HUMAN_RESOURCES', 'TRAINING', 'EQUIPMENT', 'MARKETING_SUPPORT'];

    private static function positiveId(mixed $v, string $label): int
    {
        return Input::positiveId($v) ?? throw ApiException::make(400, "{$label} invalide.");
    }

    private static function required(mixed $v, string $label, int $max): string
    {
        $t = Input::str($v);
        if ($t === '') {
            throw ApiException::make(400, "{$label} est obligatoire.");
        }
        if (mb_strlen($t) > $max) {
            throw ApiException::make(400, "{$label} ne doit pas dépasser {$max} caractères.");
        }

        return $t;
    }

    private static function optional(mixed $v, int $max): ?string
    {
        $t = Input::str($v);
        if ($t === '') {
            return null;
        }
        if (mb_strlen($t) > $max) {
            throw ApiException::make(400, "Un champ texte dépasse la limite de {$max} caractères.");
        }

        return $t;
    }

    private static function number(mixed $v, string $label, bool $allowZero = false): float
    {
        if (! is_numeric($v) || ($allowZero ? $v < 0 : $v <= 0)) {
            throw ApiException::make(400, "{$label} doit être un nombre ".($allowZero ? 'positif ou nul' : 'strictement positif').'.');
        }

        return (float) $v;
    }

    private static function date(mixed $v, string $label): string
    {
        $t = Input::str($v);
        if (! preg_match('/^\d{4}-\d{2}-\d{2}$/', $t) || ! checkdate((int) substr($t, 5, 2), (int) substr($t, 8, 2), (int) substr($t, 0, 4))) {
            throw ApiException::make(400, "{$label} invalide.");
        }

        return $t;
    }

    public static function natureFromKpiType(?string $type): string
    {
        return strtoupper((string) $type) === 'QUALITATIVE' ? 'QUALITATIVE' : 'QUANTITATIVE';
    }

    public static function normalizeTargets(array $p, string $nature): array
    {
        if ($nature === 'QUALITATIVE') {
            $source = is_array($p['qualitative_criteria'] ?? null) ? $p['qualitative_criteria'] : preg_split('/\r?\n/', (string) ($p['qualitative_criteria'] ?? ''));
            $criteria = array_values(array_filter(array_map(fn ($c) => trim((string) (is_scalar($c) ? $c : '')), $source), 'strlen'));
            if (! $criteria) {
                throw ApiException::make(400, 'Au moins un critère de réussite qualitatif est obligatoire.');
            }
            if (count($criteria) > 10) {
                throw ApiException::make(400, 'Le nombre de critères de réussite est limité à 10.');
            }
            foreach ($criteria as $c) {
                if (mb_strlen($c) > 500) {
                    throw ApiException::make(400, 'Un critère de réussite ne doit pas dépasser 500 caractères.');
                }
            }

            return ['objective_nature' => 'QUALITATIVE', 'target_value' => null, 'min_level' => null, 'expected_level' => null, 'excellent_level' => null,
                'target_qlty' => self::required($p['target_qlty'] ?? null, 'Le résultat qualitatif attendu', 5000), 'qualitative_criteria' => $criteria];
        }
        $target = self::number($p['target_value'] ?? null, 'La valeur cible');
        $empty = fn ($k) => ($p[$k] ?? null) === null || ($p[$k] ?? null) === '';
        $min = $empty('min_level') ? $target * 0.8 : self::number($p['min_level'], 'Le seuil minimum', true);
        $expected = $empty('expected_level') ? $target : self::number($p['expected_level'], 'Le seuil attendu', true);
        $excellent = $empty('excellent_level') ? $target * 1.2 : self::number($p['excellent_level'], 'Le seuil excellent', true);
        if ($min > $expected || $expected > $excellent) {
            throw ApiException::make(400, 'Les seuils doivent respecter : minimum ≤ attendu ≤ excellent.');
        }

        return ['objective_nature' => 'QUANTITATIVE', 'target_value' => $target, 'min_level' => $min, 'expected_level' => $expected, 'excellent_level' => $excellent, 'target_qlty' => null, 'qualitative_criteria' => []];
    }

    public static function assertActiveKpi(int $domainId, int $kpiId): object
    {
        $row = DB::selectOne('SELECT k.id, k.domain_id, k.type, k.unit, k.active AS kpi_active, d.active AS domain_active FROM kpis k JOIN objectif_domaines d ON d.id = k.domain_id WHERE k.id = ? AND d.id = ? LIMIT 1', [$kpiId, $domainId]);
        if (! $row) {
            throw ApiException::make(400, 'Le KPI ne correspond pas au domaine sélectionné.');
        }
        if (! $row->kpi_active || ! $row->domain_active) {
            throw ApiException::make(400, 'Le domaine et le KPI doivent être actifs.');
        }

        return $row;
    }

    private static function normalize(array $p, string $kpiType): array
    {
        $period = strtoupper((string) ($p['period_type'] ?? ''));
        if (! in_array($period, self::PERIODS, true)) {
            throw ApiException::make(400, 'Type de périodicité invalide.');
        }
        $start = self::date($p['start_date'] ?? null, 'Date de début');
        $end = self::date($p['end_date'] ?? null, 'Date de fin');
        if ($start > $end) {
            throw ApiException::make(400, 'La date de début ne peut pas être supérieure à la date de fin.');
        }
        $rid = strtolower(Input::str($p['client_request_id'] ?? ''));
        if ($rid === '') {
            $rid = Input::uuid();
        } elseif (! preg_match('/^[a-z0-9-]{16,40}$/', $rid)) {
            throw ApiException::make(400, 'Identifiant de requête invalide.');
        }
        $means = is_array($p['moyens'] ?? null) ? $p['moyens'] : [];
        $trainings = is_array($p['formations'] ?? null) ? $p['formations'] : [];
        if (count($means) > 20) {
            throw ApiException::make(400, 'Le nombre de moyens demandés est limité à 20.');
        }
        if (count($trainings) > 20) {
            throw ApiException::make(400, 'Le nombre de formations demandées est limité à 20.');
        }

        return [
            'client_request_id' => $rid,
            'title' => self::required($p['title'] ?? null, "Le titre de l'objectif", 1000),
            'description' => self::required($p['description'] ?? null, "La description de l'objectif", 5000),
            'period_type' => $period, 'start_date' => $start, 'end_date' => $end,
            'domain_id' => self::positiveId($p['domain_id'] ?? null, 'Domaine'), 'kpi_id' => self::positiveId($p['kpi_id'] ?? null, 'KPI'),
            'observations' => self::optional($p['observations'] ?? null, 5000),
            'moyens' => array_map(function ($m) {
                $type = strtoupper((string) ($m['type'] ?? 'BUDGET'));
                if (! in_array($type, self::MEAN_TYPES, true)) {
                    throw ApiException::make(400, 'Type de moyen invalide.');
                }
                $q = $m['quantity'] ?? 1;
                if (! is_numeric($q) || (int) $q != $q || $q <= 0 || $q > 10000) {
                    throw ApiException::make(400, 'La quantité du moyen doit être un entier positif raisonnable.');
                }

                return ['type' => $type, 'description' => self::required($m['description'] ?? null, 'La description du moyen', 1000), 'quantity' => (int) $q,
                    'estimated_cost' => self::number(($m['estimated_cost'] ?? 0) ?: 0, 'Le coût estimé', true)];
            }, $means),
            'formations' => array_map(function ($f) {
                $priority = strtoupper((string) ($f['priority'] ?? 'MEDIUM'));
                if (! in_array($priority, ['LOW', 'MEDIUM', 'HIGH'], true)) {
                    throw ApiException::make(400, 'Priorité de formation invalide.');
                }

                return ['theme' => self::required($f['theme'] ?? null, 'Le thème de formation', 255), 'goal' => self::optional($f['goal'] ?? null, 2000) ?? '-', 'period' => self::optional($f['period'] ?? null, 100) ?? '-', 'priority' => $priority];
            }, $trainings),
        ] + self::normalizeTargets($p, self::natureFromKpiType($kpiType));
    }

    private static function replaceNeeds(int $id, array $p): void
    {
        DB::delete('DELETE FROM objectif_moyens WHERE objective_id = ?', [$id]);
        DB::delete('DELETE FROM objectif_formations WHERE objective_id = ?', [$id]);
        foreach ($p['moyens'] as $m) {
            DB::insert("INSERT INTO objectif_moyens (objective_id, type, description, quantity, estimated_cost, approval_status) VALUES (?, ?, ?, ?, ?, 'PENDING')", [$id, $m['type'], $m['description'], $m['quantity'], $m['estimated_cost']]);
        }
        foreach ($p['formations'] as $f) {
            DB::insert("INSERT INTO objectif_formations (objective_id, theme, goal, period, priority, status) VALUES (?, ?, ?, ?, ?, 'PENDING')", [$id, $f['theme'], $f['goal'], $f['period'], $f['priority']]);
        }
    }

    public static function history(int $id, int $userId, string $action, mixed $old, mixed $new, ?string $comments = null, ?string $ip = 'pwa-sync'): void
    {
        DB::insert('INSERT INTO objectif_historiques (objective_id, user_id, action, old_value, new_value, comments, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)', [$id, $userId, $action, json_encode($old, JSON_UNESCAPED_UNICODE), json_encode($new, JSON_UNESCAPED_UNICODE), $comments, $ip]);
    }

    public static function fetch(int $id): ?array
    {
        $o = Rows::one(DB::selectOne('SELECT o.*, u.full_name AS assignee_name, c.full_name AS creator_name, k.name AS kpi_name, k.type AS kpi_type, k.unit AS kpi_unit, d.name AS domain_name
            FROM crm_objectives o LEFT JOIN users u ON o.responsible_id = u.id LEFT JOIN users c ON o.created_by = c.id LEFT JOIN kpis k ON o.kpi_id = k.id LEFT JOIN objectif_domaines d ON o.domain_id = d.id WHERE o.id = ?', [$id]));
        if ($o) {
            $o['qualitative_criteria'] = Rows::decode($o['qualitative_criteria'], []) ?? [];
        }

        return $o;
    }

    private static function assertCommercial(array $user): void
    {
        if ($user['role'] !== 'COMMERCIAL') {
            throw ApiException::make(403, 'Seul un commercial peut créer une proposition terrain.');
        }
    }

    public static function create(array $user, array $payload, bool $submit): array
    {
        self::assertCommercial($user);
        $domainId = self::positiveId($payload['domain_id'] ?? null, 'Domaine');
        $kpiId = self::positiveId($payload['kpi_id'] ?? null, 'KPI');
        [$id, $created, $submittedNow] = DB::transaction(function () use ($user, $payload, $submit, $domainId, $kpiId) {
            $kpi = self::assertActiveKpi($domainId, $kpiId);
            $p = self::normalize($payload, $kpi->type);
            $code = 'OBJ-PWA-'.strtoupper($p['client_request_id']);
            $existing = DB::selectOne('SELECT id, created_by, responsible_id, status FROM crm_objectives WHERE code = ? LIMIT 1 FOR UPDATE', [$code]);
            if ($existing) {
                if ((int) $existing->created_by !== $user['id']) {
                    throw ApiException::make(409, 'Identifiant de synchronisation déjà utilisé.');
                }
                $submittedNow = false;
                if (! $existing->responsible_id) {
                    DB::update('UPDATE crm_objectives SET responsible_id = ? WHERE id = ?', [$user['id'], $existing->id]);
                    self::history($existing->id, $user['id'], 'SELF_ASSIGN', null, $user['id'], 'Auto-affectation au commercial créateur');
                }
                if ($submit && in_array($existing->status, ['DRAFT', 'CORRECTION'], true)) {
                    DB::update("UPDATE crm_objectives SET status = 'SUBMITTED' WHERE id = ?", [$existing->id]);
                    self::history($existing->id, $user['id'], 'SUBMIT', $existing->status, 'SUBMITTED', 'Reprise idempotente de la soumission PWA');
                    $submittedNow = true;
                }

                return [(int) $existing->id, false, $submittedNow];
            }
            $status = $submit ? 'SUBMITTED' : 'DRAFT';
            DB::insert('INSERT INTO crm_objectives (code, title, description, parent_id, period_type, start_date, end_date, responsible_id, domain_id, kpi_id, objective_nature, target_value, unit, min_level,
                expected_level, excellent_level, target_qlty, qualitative_criteria, direction, department, service, observations, status, created_by)
                VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)', [
                $code, $p['title'], $p['description'], $p['period_type'], $p['start_date'], $p['end_date'], $user['id'], $p['domain_id'], $p['kpi_id'], $p['objective_nature'],
                $p['target_value'], $kpi->unit, $p['min_level'], $p['expected_level'], $p['excellent_level'], $p['target_qlty'], json_encode($p['qualitative_criteria'], JSON_UNESCAPED_UNICODE),
                $p['observations'], $status, $user['id'],
            ]);
            $id = (int) DB::getPdo()->lastInsertId();
            self::replaceNeeds($id, $p);
            self::history($id, $user['id'], 'CREATE_PROPOSAL', null, ['title' => $p['title'], 'objective_nature' => $p['objective_nature'], 'target_value' => $p['target_value'], 'target_qlty' => $p['target_qlty'], 'status' => $status, 'responsible_id' => $user['id']], 'Proposition créée et auto-affectée depuis la PWA terrain');
            if ($submit) {
                self::history($id, $user['id'], 'SUBMIT', 'DRAFT', 'SUBMITTED', 'Soumission immédiate depuis la PWA terrain');
            }

            return [$id, true, $submit];
        });
        $objective = self::fetch($id);
        if ($submittedNow) {
            Notifier::notifyDirection('Objectif soumis depuis le terrain', "L'objectif \"{$objective['title']}\" a été soumis par {$user['full_name']}.", 'OBJECTIVE_SUBMITTED', $id);
        }

        return ['objective' => $objective, 'created' => $created];
    }

    public static function update(array $user, mixed $objectiveId, array $payload): array
    {
        self::assertCommercial($user);
        $id = self::positiveId($objectiveId, 'Objectif');
        $domainId = self::positiveId($payload['domain_id'] ?? null, 'Domaine');
        $kpiId = self::positiveId($payload['kpi_id'] ?? null, 'KPI');
        DB::transaction(function () use ($user, $id, $payload, $domainId, $kpiId) {
            $old = DB::selectOne('SELECT * FROM crm_objectives WHERE id = ? FOR UPDATE', [$id]) ?? throw ApiException::make(404, 'Objectif introuvable.');
            if ((int) $old->created_by !== $user['id']) {
                throw ApiException::make(403, 'Accès refusé.');
            }
            if (! in_array($old->status, ['DRAFT', 'CORRECTION'], true)) {
                throw ApiException::make(409, "Cet objectif n'est plus modifiable dans son statut actuel.");
            }
            $kpi = self::assertActiveKpi($domainId, $kpiId);
            $p = self::normalize($payload, $kpi->type);
            DB::update('UPDATE crm_objectives SET title = ?, description = ?, period_type = ?, start_date = ?, end_date = ?, domain_id = ?, kpi_id = ?, objective_nature = ?, target_value = ?, unit = ?,
                min_level = ?, expected_level = ?, excellent_level = ?, target_qlty = ?, qualitative_criteria = ?, observations = ? WHERE id = ?', [
                $p['title'], $p['description'], $p['period_type'], $p['start_date'], $p['end_date'], $p['domain_id'], $p['kpi_id'], $p['objective_nature'], $p['target_value'], $kpi->unit,
                $p['min_level'], $p['expected_level'], $p['excellent_level'], $p['target_qlty'], json_encode($p['qualitative_criteria'], JSON_UNESCAPED_UNICODE), $p['observations'], $id,
            ]);
            self::replaceNeeds($id, $p);
            self::history($id, $user['id'], 'UPDATE_PROPOSAL', ['title' => $old->title, 'objective_nature' => $old->objective_nature, 'target_value' => $old->target_value],
                ['title' => $p['title'], 'objective_nature' => $p['objective_nature'], 'target_value' => $p['target_value'], 'target_qlty' => $p['target_qlty']], 'Proposition modifiée depuis la PWA terrain');
        });

        return self::fetch($id);
    }

    public static function submit(array $user, mixed $objectiveId): array
    {
        self::assertCommercial($user);
        $id = self::positiveId($objectiveId, 'Objectif');
        $title = DB::transaction(function () use ($user, $id) {
            $o = DB::selectOne('SELECT * FROM crm_objectives WHERE id = ? FOR UPDATE', [$id]) ?? throw ApiException::make(404, 'Objectif introuvable.');
            if ((int) $o->created_by !== $user['id']) {
                throw ApiException::make(403, 'Accès refusé.');
            }
            if (! in_array($o->status, ['DRAFT', 'CORRECTION'], true)) {
                throw ApiException::make(409, "Cet objectif n'est pas dans un état soumissible.");
            }
            DB::update("UPDATE crm_objectives SET status = 'SUBMITTED' WHERE id = ?", [$id]);
            self::history($id, $user['id'], 'SUBMIT', $o->status, 'SUBMITTED', 'Soumission depuis la PWA terrain');

            return $o->title;
        });
        Notifier::notifyDirection('Objectif soumis depuis le terrain', "L'objectif \"{$title}\" a été soumis par {$user['full_name']}.", 'OBJECTIVE_SUBMITTED', $id);

        return self::fetch($id);
    }

    public static function delete(array $user, mixed $objectiveId): void
    {
        self::assertCommercial($user);
        $id = self::positiveId($objectiveId, 'Objectif');
        $o = DB::selectOne('SELECT status, created_by FROM crm_objectives WHERE id = ?', [$id]) ?? throw ApiException::make(404, 'Objectif introuvable.');
        if ((int) $o->created_by !== $user['id']) {
            throw ApiException::make(403, 'Accès refusé.');
        }
        if ($o->status !== 'DRAFT') {
            throw ApiException::make(409, 'Seul un brouillon peut être supprimé.');
        }
        DB::delete('DELETE FROM crm_objectives WHERE id = ?', [$id]);
    }
}
