<?php

namespace App\Services;

use App\Exceptions\ApiException;
use App\Support\Input;
use App\Support\Rows;
use Illuminate\Support\Facades\DB;

/** Reprise de services/missionTargetService.js (tournées multi-cibles). Les tables existent déjà : plus de CREATE TABLE à la volée. */
class MissionTargets
{
    private const LEVELS = ['LOW', 'MEDIUM', 'HIGH'];

    private const MATURITIES = ['DISCOVERY', 'QUALIFIED', 'PROPOSAL', 'NEGOTIATION', 'DECISION'];

    private static function level(mixed $v): string
    {
        $n = strtoupper(Input::str($v));

        return in_array($n, self::LEVELS, true) ? $n : 'MEDIUM';
    }

    private static function opportunity(mixed $v): ?array
    {
        if (! is_array($v) || array_is_list($v)) {
            return null;
        }
        $title = Input::text($v['title'] ?? null, 150);
        $need = Input::text($v['need_description'] ?? null, 2000);
        $solution = Input::text($v['proposed_solution'] ?? null, 1000);
        $amount = $v['estimated_amount'] ?? 0;
        if (! $title && ! $need && ! $solution && ! (float) $amount) {
            return null;
        }
        if (! $title || ! $need) {
            throw ApiException::make(400, 'Le titre et le besoin sont obligatoires pour chaque opportunité cible.');
        }
        if (($amount !== '' && $amount !== null && ! is_numeric($amount)) || (float) $amount < 0 || (float) $amount > 1e12) {
            throw ApiException::make(400, 'Le montant estimé d’une opportunité cible est invalide.');
        }
        $maturity = strtoupper(Input::str($v['maturity'] ?? ''));

        return [
            'title' => $title, 'need_description' => $need, 'proposed_solution' => $solution, 'estimated_amount' => (float) $amount,
            'priority' => self::level($v['priority'] ?? null), 'maturity' => in_array($maturity, self::MATURITIES, true) ? $maturity : 'DISCOVERY',
            'expected_deadline' => ($v['expected_deadline'] ?? null) ?: null, 'tender_reference' => Input::text($v['tender_reference'] ?? null, 120),
            'current_supplier' => Input::text($v['current_supplier'] ?? null, 160), 'notes' => Input::text($v['notes'] ?? null, 2000),
        ];
    }

    public static function normalize(mixed $raw, array $fallback = []): array
    {
        $source = is_array($raw) && $raw ? array_values($raw) : [[
            'institution_id' => $fallback['institution_id'] ?? null,
            'contact_name' => $fallback['target_decision_maker'] ?? null,
            'contact_role' => ! empty($fallback['target_decision_maker']) ? 'DECIDEUR_PRINCIPAL' : null,
        ]];
        if (count($source) > 20) {
            throw ApiException::make(400, 'Une mission ne peut pas contenir plus de 20 cibles.');
        }
        $seen = [];
        $targets = [];
        foreach ($source as $i => $item) {
            $item = is_array($item) ? $item : [];
            $id = Input::positiveId($item['institution_id'] ?? null);
            if (! $id) {
                throw ApiException::make(400, 'Institution invalide pour la cible '.($i + 1).'.');
            }
            if (isset($seen[$id])) {
                throw ApiException::make(400, 'Une institution ne peut apparaître qu’une fois dans la même mission.');
            }
            $seen[$id] = true;
            $targets[] = [
                'institution_id' => $id, 'visit_order' => $i + 1, 'priority' => self::level($item['priority'] ?? null), 'potential' => self::level($item['potential'] ?? null),
                'contact_name' => Input::text($item['contact_name'] ?? null, 150), 'contact_role' => Input::text($item['contact_role'] ?? null, 120),
                'contact_phone' => Input::text($item['contact_phone'] ?? null, 40), 'contact_email' => Input::text($item['contact_email'] ?? null, 190),
                'notes' => Input::text($item['notes'] ?? null, 2000), 'opportunity' => self::opportunity($item['opportunity'] ?? null),
            ];
        }
        $institutions = collect(DB::table('crm_institutions as i')
            ->leftJoin('crm_ref_cities as c', 'c.id', '=', 'i.city_id')
            ->leftJoin('crm_ref_departments as d', 'd.id', '=', 'i.department_id')
            ->leftJoin('crm_ref_regions as r', 'r.id', '=', 'i.region_id')
            ->whereIn('i.id', array_column($targets, 'institution_id'))
            ->get(['i.id', 'i.name', 'i.region_id', 'i.department_id', 'i.city_id', 'c.name as city_name', 'd.name as department_name', 'r.name as region_name']))->keyBy('id');
        foreach ($targets as &$t) {
            $inst = $institutions->get($t['institution_id']);
            if (! $inst) {
                throw ApiException::make(404, "Institution cible #{$t['institution_id']} introuvable.");
            }
            if (! $inst->region_id || ! $inst->department_id || ! $inst->city_id) {
                throw ApiException::make(422, "La localisation de l’institution « {$inst->name} » est incomplète.");
            }
            $t += ['institution_name' => $inst->name, 'region_id' => (int) $inst->region_id, 'region_name' => $inst->region_name, 'department_id' => (int) $inst->department_id,
                'department_name' => $inst->department_name, 'city_id' => (int) $inst->city_id, 'city_name' => $inst->city_name];
        }

        return $targets;
    }

    public static function upsert(int $missionId, array $targets): void
    {
        foreach ($targets as $t) {
            $existing = DB::selectOne('SELECT id FROM crm_mission_targets WHERE mission_id = ? AND institution_id = ? LIMIT 1', [$missionId, $t['institution_id']]);
            $values = [$t['visit_order'], $t['priority'], $t['potential'], $t['contact_name'], $t['contact_role'], $t['contact_phone'], $t['contact_email'], $t['notes']];
            if ($existing) {
                $targetId = (int) $existing->id;
                DB::update('UPDATE crm_mission_targets SET visit_order = ?, priority = ?, potential = ?, contact_name = ?, contact_role = ?, contact_phone = ?, contact_email = ?, notes = ? WHERE id = ?', [...$values, $targetId]);
            } else {
                DB::insert('INSERT INTO crm_mission_targets (mission_id, institution_id, visit_order, priority, potential, contact_name, contact_role, contact_phone, contact_email, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [$missionId, $t['institution_id'], ...$values]);
                $targetId = (int) DB::getPdo()->lastInsertId();
            }
            if ($o = $t['opportunity']) {
                DB::insert('INSERT INTO crm_mission_target_opportunities (mission_target_id, title, need_description, proposed_solution, estimated_amount, priority, maturity, expected_deadline, tender_reference, current_supplier, notes)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE title = VALUES(title), need_description = VALUES(need_description), proposed_solution = VALUES(proposed_solution),
                    estimated_amount = VALUES(estimated_amount), priority = VALUES(priority), maturity = VALUES(maturity), expected_deadline = VALUES(expected_deadline),
                    tender_reference = VALUES(tender_reference), current_supplier = VALUES(current_supplier), notes = VALUES(notes)', [
                    $targetId, $o['title'], $o['need_description'], $o['proposed_solution'], $o['estimated_amount'], $o['priority'], $o['maturity'], $o['expected_deadline'], $o['tender_reference'], $o['current_supplier'], $o['notes'],
                ]);
            }
        }
    }

    /** @return array<int, array> mission_id => cibles */
    public static function forMissions(array $missionIds): array
    {
        $ids = array_values(array_unique(array_filter(array_map([Input::class, 'positiveId'], $missionIds))));
        if (! $ids) {
            return [];
        }
        $targets = Rows::arr(DB::table('crm_mission_targets as mt')
            ->join('crm_institutions as i', 'i.id', '=', 'mt.institution_id')
            ->leftJoin('crm_ref_regions as r', 'r.id', '=', 'i.region_id')
            ->leftJoin('crm_ref_departments as d', 'd.id', '=', 'i.department_id')
            ->leftJoin('crm_ref_cities as c', 'c.id', '=', 'i.city_id')
            ->whereIn('mt.mission_id', $ids)->orderBy('mt.mission_id')->orderBy('mt.visit_order')->orderBy('mt.id')
            ->get(['mt.*', 'i.name as institution_name', 'i.region_id', 'i.department_id', 'i.city_id', 'r.name as region_name', 'd.name as department_name', 'c.name as city_name']));
        $opps = $targets ? collect(Rows::arr(DB::table('crm_mission_target_opportunities')->whereIn('mission_target_id', array_column($targets, 'id'))->get()))->keyBy('mission_target_id') : collect();
        $grouped = array_fill_keys($ids, []);
        foreach ($targets as $t) {
            $t['opportunity'] = $opps->get($t['id']);
            $grouped[(int) $t['mission_id']][] = $t;
        }

        return $grouped;
    }
}
