<?php

namespace App\Services;

use App\Exceptions\ApiException;
use Illuminate\Support\Facades\DB;

/** Reprise de services/analytics.js — expressions SQL fixées côté serveur, paramètres en placeholders. */
class Analytics
{
    private static function m(string $fr, string $en, string $sql, string $unit = 'number', bool $alert = false): array
    {
        return compact('fr', 'en', 'sql', 'unit', 'alert');
    }

    private static function definitions(): array
    {
        return [
            'objectives' => ['from' => 'crm_objectives x', 'group' => 'x.status', 'scope' => FeatureAccess::OWNERSHIP['objectives'][1], 'scopeArgs' => 3, 'metrics' => [
                self::m('Objectifs', 'Objectives', 'COUNT(*)'),
                self::m('Réalisation quantitative moyenne', 'Average quantitative achievement', "AVG(CASE WHEN objective_nature='QUANTITATIVE' THEN achievement_rate END)", 'percent'),
                self::m('Qualitatifs atteints', 'Qualitative objectives achieved', "SUM(objective_nature='QUALITATIVE' AND qualitative_rating IN ('ACHIEVED','EXCEEDED'))"),
                self::m('Échéances dépassées', 'Overdue objectives', "SUM(end_date < CURRENT_DATE AND status NOT IN ('CLOSED','CANCELLED','REJECTED'))", 'number', true),
            ]],
            'missions' => ['from' => 'crm_missions x', 'group' => 'x.status', 'scope' => FeatureAccess::OWNERSHIP['missions'][1], 'scopeArgs' => 2, 'extraGroup' => 'x.travel_scope', 'metrics' => [
                self::m('Missions', 'Missions', 'COUNT(*)'),
                self::m('Taux de réalisation', 'Completion rate', "100*SUM(status IN ('COMPLETED','CLOSED'))/NULLIF(COUNT(*),0)", 'percent'),
                self::m('Déplacements estimés', 'Estimated travel costs', 'SUM(estimated_travel_cost)', 'XAF'),
                self::m('Missions en retard', 'Overdue missions', "SUM(scheduled_date < NOW() AND status IN ('VALIDATED','PLANNED','IN_PROGRESS'))", 'number', true),
            ]],
            'institutions' => ['from' => 'crm_institutions x', 'group' => 'x.type', 'scope' => 'x.created_by=?', 'scopeArgs' => 1, 'extraGroup' => "COALESCE((SELECT r.name FROM crm_ref_regions r WHERE r.id=x.region_id),'-')", 'metrics' => [
                self::m('Institutions', 'Institutions', 'COUNT(*)'),
                self::m('Actives', 'Active', 'SUM(is_active=1)'),
                self::m('Villes couvertes', 'Cities covered', 'COUNT(DISTINCT city_id)'),
                self::m('Sans téléphone ni e-mail', 'Without phone or email', "SUM(COALESCE(TRIM(phone),'')='' AND COALESCE(TRIM(email),'')='')", 'number', true),
            ]],
            'opportunities' => ['from' => 'crm_opportunities x', 'group' => 'x.status', 'scope' => 'x.assigned_to=?', 'scopeArgs' => 1, 'extraGroup' => 'x.pipeline_stage', 'metrics' => [
                self::m('Opportunités', 'Opportunities', 'COUNT(*)'),
                self::m('Pipeline ouvert estimé', 'Estimated open pipeline', "SUM(CASE WHEN status NOT IN ('WON','LOST','ARCHIVED','REJECTED') THEN estimated_amount ELSE 0 END)", 'XAF'),
                self::m('Gagnées / décisions', 'Won / decisions', "100*SUM(status='WON')/NULLIF(SUM(status IN ('WON','LOST')),0)", 'percent'),
                self::m('Sans évolution depuis 30 jours', 'Unchanged for 30 days', "SUM(updated_at < DATE_SUB(NOW(), INTERVAL 30 DAY) AND status NOT IN ('WON','LOST','ARCHIVED','REJECTED'))", 'number', true),
            ]],
            'reports' => ['from' => 'crm_reports x', 'group' => 'x.status', 'scope' => FeatureAccess::OWNERSHIP['reports'][1], 'scopeArgs' => 2, 'metrics' => [
                self::m('Rapports', 'Reports', 'COUNT(*)'),
                self::m('À valider', 'Awaiting validation', "SUM(status IN ('SOUMIS','SUBMITTED'))", 'number', true),
                self::m('Délai moyen de validation', 'Average validation delay', 'AVG(CASE WHEN validated_at >= submitted_at THEN TIMESTAMPDIFF(HOUR,submitted_at,validated_at)/24 END)', 'days'),
                self::m('Sans synthèse', 'Without summary', "SUM(COALESCE(TRIM(executive_summary),'')='')", 'number', true),
            ]],
            'commerciaux' => ['roles' => FeatureAccess::MANAGERS, 'from' => 'crm_missions x LEFT JOIN users u ON u.id=x.primary_commercial_id', 'group' => "COALESCE(u.full_name,'-')", 'metrics' => [
                self::m('Missions confiées', 'Assigned missions', 'COUNT(*)'),
                self::m('Commerciaux mobilisés', 'Salespeople assigned', 'COUNT(DISTINCT primary_commercial_id)'),
                self::m('Missions terminées', 'Completed missions', "SUM(status IN ('COMPLETED','CLOSED'))"),
                self::m('Missions en retard', 'Overdue missions', "SUM(scheduled_date < NOW() AND status IN ('VALIDATED','PLANNED','IN_PROGRESS'))", 'number', true),
            ]],
            'security' => ['roles' => ['SYSTEM', 'ADMIN'], 'from' => 'crm_login_history x', 'group' => 'x.status', 'metrics' => [
                self::m('Tentatives de connexion', 'Login attempts', 'COUNT(*)'),
                self::m('Réussies', 'Successful', "SUM(status='SUCCESS')"),
                self::m('Échecs et blocages', 'Failed and blocked', "SUM(status IN ('FAILED','BLOCKED'))", 'number', true),
                self::m('Utilisateurs connectés distincts', 'Distinct signed-in users', "COUNT(DISTINCT CASE WHEN status='SUCCESS' THEN user_id END)"),
            ]],
        ];
    }

    public static function period(array $query): array
    {
        if (array_diff(array_keys($query), ['start', 'end'])) {
            throw ApiException::make(400, 'Filtre inconnu.');
        }
        $parse = function ($v) {
            if (! is_string($v) || ! preg_match('/^\d{4}-\d{2}-\d{2}$/', $v) || ! checkdate((int) substr($v, 5, 2), (int) substr($v, 8, 2), (int) substr($v, 0, 4))) {
                throw ApiException::make(400, 'Date invalide.');
            }

            return strtotime($v.' 00:00:00 UTC');
        };
        $end = isset($query['end']) ? $parse($query['end']) : $parse(gmdate('Y-m-d'));
        $start = isset($query['start']) ? $parse($query['start']) : $end - 29 * 86400;
        $days = (int) round(($end - $start) / 86400) + 1;
        if ($days < 1 || $days > 366) {
            throw ApiException::make(400, 'Période invalide (1 à 366 jours).');
        }
        $f = fn ($t) => gmdate('Y-m-d', $t);

        return ['start' => $f($start), 'end' => $f($end), 'exclusiveEnd' => $f($end + 86400), 'previousStart' => $f($start - $days * 86400), 'days' => $days];
    }

    public static function canRead(string $name, array $user): bool
    {
        if (! in_array($user['role'], [...FeatureAccess::MANAGERS, 'COMMERCIAL'], true)) {
            return false;
        }
        $permission = FeatureAccess::permissionFor($user, $name === 'commerciaux' ? 'users' : $name);
        if (! in_array($name, ['dashboard', 'permissions'], true) && $permission !== null && empty($permission['can_view'])) {
            return false;
        }
        if (in_array($name, ['commerciaux', 'security', 'referentials'], true) && $permission !== null && empty($permission['can_view_all'])) {
            return false;
        }
        if ($name === 'permissions') {
            return in_array($user['role'], ['SYSTEM', 'ADMIN'], true);
        }
        if ($name === 'referentials') {
            return in_array($user['role'], FeatureAccess::MANAGERS, true);
        }
        $roles = self::definitions()[$name]['roles'] ?? null;

        return ! $roles || in_array($user['role'], $roles, true);
    }

    private static function num(mixed $v): int|float|null
    {
        return $v === null ? null : $v + 0;
    }

    private static function cohort(string $name, array $user, array $range): array
    {
        $def = self::definitions()[$name];
        $permission = FeatureAccess::permissionFor($user, $name);
        $scoped = ($name === 'institutions' ? ($permission !== null && empty($permission['can_view_all'])) : FeatureAccess::scopeRestricted($user, $name)) && isset($def['scope']);
        $where = $scoped ? $def['scope'] : '1=1';
        $args = $scoped ? array_fill(0, $def['scopeArgs'], $user['id']) : [];
        $metrics = implode(',', array_map(fn ($m, $i) => "{$m['sql']} AS m{$i}", $def['metrics'], array_keys($def['metrics'])));
        $read = fn (string $s, string $e) => (array) DB::selectOne("SELECT {$metrics} FROM {$def['from']} WHERE {$where} AND x.created_at >= ? AND x.created_at < ?", [...$args, $s, $e]);
        $current = $read($range['start'], $range['exclusiveEnd']);
        $previous = $read($range['previousStart'], $range['start']);
        $stock = (array) DB::selectOne("SELECT {$metrics} FROM {$def['from']} WHERE {$where}", $args);
        $group = fn (string $expr) => array_map(fn ($r) => ['label' => $r->label, 'value' => (int) $r->value],
            DB::select("SELECT COALESCE({$expr},'-') AS label, COUNT(*) AS value FROM {$def['from']} WHERE {$where} AND x.created_at >= ? AND x.created_at < ? GROUP BY label ORDER BY value DESC, label LIMIT 12", [...$args, $range['start'], $range['exclusiveEnd']]));
        $daily = collect(DB::select("SELECT DATE_FORMAT(x.created_at,'%Y-%m-%d') AS day, COUNT(*) AS value FROM {$def['from']} WHERE {$where} AND x.created_at >= ? AND x.created_at < ? GROUP BY day ORDER BY day", [...$args, $range['start'], $range['exclusiveEnd']]))->pluck('value', 'day');
        $strip = fn ($m) => array_diff_key($m, ['sql' => 1]);

        return [
            'stockMetrics' => array_map(fn ($m, $i) => $strip($m) + ['value' => self::num($stock["m{$i}"])], $def['metrics'], array_keys($def['metrics'])),
            'mode' => 'cohort',
            'metrics' => array_map(fn ($m, $i) => $strip($m) + ['value' => self::num($current["m{$i}"]), 'previous' => self::num($previous["m{$i}"])], $def['metrics'], array_keys($def['metrics'])),
            'groups' => $group($def['group']),
            'extraGroups' => isset($def['extraGroup']) ? $group($def['extraGroup']) : [],
            'trend' => array_map(function ($i) use ($range, $daily) {
                $day = gmdate('Y-m-d', strtotime($range['start'].' UTC') + $i * 86400);

                return ['label' => $day, 'value' => (int) ($daily[$day] ?? 0)];
            }, range(0, $range['days'] - 1)),
        ];
    }

    private static function snapshot(string $name): array
    {
        if ($name === 'referentials') {
            $groups = [];
            $missing = 0;
            foreach (['countries', 'regions', 'departments', 'cities', 'institution_types', 'influence_levels', 'mission_types', 'period_types', 'priorities', 'documentary_observations'] as $t) {
                $row = DB::selectOne("SELECT COUNT(*) AS value, SUM(COALESCE(TRIM(name_en),'')='') AS missing FROM crm_ref_{$t}");
                $groups[] = ['label' => $t, 'value' => (int) $row->value];
                $missing += (int) $row->missing;
            }
            $inactive = DB::selectOne('SELECT (SELECT COUNT(*) FROM kpis WHERE active=0) + (SELECT COUNT(*) FROM objectif_domaines WHERE active=0) AS value')->value;

            return ['mode' => 'snapshot', 'metrics' => [
                ['fr' => 'Entrées de référence', 'en' => 'Reference entries', 'value' => array_sum(array_column($groups, 'value'))],
                ['fr' => 'Traductions anglaises manquantes', 'en' => 'Missing English translations', 'value' => $missing, 'alert' => true],
                ['fr' => 'KPI et domaines inactifs', 'en' => 'Inactive KPIs and domains', 'value' => (int) $inactive],
            ], 'groups' => $groups, 'trend' => []];
        }
        $r = DB::selectOne('SELECT (SELECT COUNT(*) FROM job_descriptions) AS profiles, (SELECT COUNT(DISTINCT job_description_id) FROM job_feature_permissions WHERE can_view=1) AS covered,
            (SELECT COUNT(*) FROM users WHERE is_active=1 AND job_description_id IS NULL) AS unassigned, (SELECT COUNT(*) FROM job_feature_permissions WHERE can_delete=1 OR can_view_all=1) AS sensitive_rules');
        $groups = array_map(fn ($g) => ['label' => $g->label, 'value' => (int) $g->value], DB::select('SELECT j.title AS label, COALESCE(SUM(p.can_view=1),0) AS value FROM job_descriptions j LEFT JOIN job_feature_permissions p ON p.job_description_id=j.id GROUP BY j.id,j.title ORDER BY value DESC,j.title'));

        return ['mode' => 'snapshot', 'metrics' => [
            ['fr' => 'Profils', 'en' => 'Profiles', 'value' => (int) $r->profiles],
            ['fr' => 'Profils sans droit de lecture', 'en' => 'Profiles without read access', 'value' => (int) $r->profiles - (int) $r->covered, 'alert' => true],
            ['fr' => 'Comptes actifs sans fiche de poste', 'en' => 'Active accounts without job profile', 'value' => (int) $r->unassigned, 'alert' => true],
            ['fr' => 'Règles avec suppression ou vue globale', 'en' => 'Rules granting deletion or global view', 'value' => (int) $r->sensitive_rules],
        ], 'groups' => $groups, 'trend' => []];
    }

    public static function compute(string $name, array $user, array $range): array
    {
        $defs = self::definitions();
        if (! in_array($name, ['dashboard', 'permissions', 'referentials', ...array_keys($defs)], true)) {
            throw ApiException::make(404, 'Module inconnu.');
        }
        if (! self::canRead($name, $user)) {
            throw ApiException::make(403, 'Accès refusé.');
        }
        if ($name === 'dashboard') {
            $sections = [];
            foreach (['objectives', 'missions', 'opportunities', 'reports'] as $k) {
                if (self::canRead($k, $user)) {
                    $sections[$k] = self::cohort($k, $user, $range);
                }
            }

            return ['mode' => 'dashboard', 'sections' => $sections ?: new \stdClass];
        }

        return isset($defs[$name]) ? self::cohort($name, $user, $range) : self::snapshot($name);
    }
}
