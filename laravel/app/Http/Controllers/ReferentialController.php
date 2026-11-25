<?php

namespace App\Http\Controllers;

use Illuminate\Database\QueryException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

/**
 * Reprise de routes/referentials.js : un CRUD générique piloté par une
 * table de définition (noms de tables/colonnes fixés côté serveur).
 */
class ReferentialController extends Controller
{
    /** ressource => [table, colonnes modifiables, colonnes requises, message] */
    public const RESOURCES = [
        'countries' => ['crm_ref_countries', ['code', 'name', 'name_en'], ['code', 'name'], 'Le code et le nom sont requis.'],
        'regions' => ['crm_ref_regions', ['code', 'name', 'name_en', 'country_id'], ['code', 'name'], 'Le code et le nom sont requis.'],
        'departments' => ['crm_ref_departments', ['code', 'name', 'name_en', 'region_id'], ['code', 'name', 'region_id'], 'Le code, le nom et la région sont requis.'],
        'cities' => ['crm_ref_cities', ['name', 'name_en', 'department_id'], ['name', 'department_id'], 'Le nom et le département sont requis.'],
        'institution-types' => ['crm_ref_institution_types', ['code', 'name', 'name_en'], ['code', 'name'], 'Le code et le nom sont requis.'],
        'influence-levels' => ['crm_ref_influence_levels', ['code', 'name', 'name_en'], ['code', 'name'], 'Le code et le nom sont requis.'],
        'priorities' => ['crm_ref_priorities', ['code', 'name', 'name_en'], ['code', 'name'], 'Le code et le nom sont requis.'],
        'mission-types' => ['crm_ref_mission_types', ['code', 'name', 'name_en'], ['code', 'name'], 'Le code et le nom sont requis.'],
        'period-types' => ['crm_ref_period_types', ['code', 'name', 'name_en'], ['code', 'name'], 'Le code et le nom sont requis.'],
        'documentary-observations' => ['crm_ref_documentary_observations', ['code', 'name', 'name_en'], ['code', 'name'], 'Le code et le nom sont requis.'],
    ];

    private const DEPENDENCIES = [
        'crm_ref_countries' => [['crm_ref_regions', 'country_id']],
        'crm_ref_regions' => [['crm_ref_departments', 'region_id'], ['crm_institutions', 'region_id'], ['crm_missions', 'region_id']],
        'crm_ref_departments' => [['crm_ref_cities', 'department_id'], ['crm_institutions', 'department_id'], ['crm_missions', 'department_id']],
        'crm_ref_cities' => [['users', 'base_city_id'], ['crm_institutions', 'city_id'], ['crm_missions', 'city_id'], ['crm_missions', 'base_city_id']],
    ];

    public function index(Request $request, string $resource): JsonResponse
    {
        $q = $request->query();
        $sql = match ($resource) {
            'regions' => ['SELECT r.*, c.name as country_name, c.name_en as country_name_en FROM crm_ref_regions r LEFT JOIN crm_ref_countries c ON r.country_id = c.id', 'r.country_id', $q['countryId'] ?? null, 'r.name'],
            'departments' => ['SELECT d.*, r.name as region_name, r.name_en as region_name_en, r.country_id FROM crm_ref_departments d JOIN crm_ref_regions r ON d.region_id = r.id', 'd.region_id', $q['regionId'] ?? null, 'd.name'],
            'cities' => ['SELECT c.*, d.name as department_name, d.name_en as department_name_en, d.region_id FROM crm_ref_cities c JOIN crm_ref_departments d ON c.department_id = d.id', 'c.department_id', $q['departmentId'] ?? null, 'c.name'],
            default => ['SELECT * FROM '.self::RESOURCES[$resource][0], null, null, 'name'],
        };
        [$select, $filterColumn, $filterValue, $order] = $sql;
        $bindings = [];
        if ($filterColumn && $filterValue) {
            $select .= " WHERE {$filterColumn} = ?";
            $bindings[] = $filterValue;
        }

        return $this->ok($this->rows(DB::select("{$select} ORDER BY {$order}", $bindings)));
    }

    public function store(Request $request, string $resource): JsonResponse
    {
        [$table, $fields, $required, $message] = self::RESOURCES[$resource];
        $b = $this->body($request);
        foreach ($required as $r) {
            if (empty($b[$r])) {
                return $this->err(400, $message);
            }
        }
        $data = $this->pick($b, $fields);
        if (! $data) {
            return $this->err(400, 'Aucun champ fourni.');
        }
        try {
            $id = DB::table($table)->insertGetId($data);
        } catch (QueryException $e) {
            if (($e->errorInfo[1] ?? null) === 1062) {
                return $this->err(400, 'Un élément avec ce code ou cette valeur existe déjà.');
            }
            throw $e;
        }

        return $this->ok(['id' => $id, 'message' => 'Élément créé avec succès.'], 201);
    }

    public function update(Request $request, string $resource, int $id): JsonResponse
    {
        [$table, $fields] = self::RESOURCES[$resource];
        $data = $this->pick($this->body($request), $fields);
        if (! $data) {
            return $this->err(400, 'Aucun champ à modifier.');
        }
        if (! DB::table($table)->where('id', $id)->exists()) {
            return $this->err(404, 'Élément introuvable.');
        }
        try {
            DB::table($table)->where('id', $id)->update($data);
        } catch (QueryException $e) {
            if (($e->errorInfo[1] ?? null) === 1062) {
                return $this->err(400, 'Un élément avec ce code ou cette valeur existe déjà.');
            }
            throw $e;
        }

        return $this->ok(['message' => 'Élément modifié avec succès.']);
    }

    public function destroy(string $resource, int $id): JsonResponse
    {
        $table = self::RESOURCES[$resource][0];
        foreach (self::DEPENDENCIES[$table] ?? [] as [$child, $fk]) {
            if (DB::table($child)->where($fk, $id)->exists()) {
                return $this->err(400, 'Impossible de supprimer cet élément : des lieux ou dossiers lui sont encore rattachés.');
            }
        }
        try {
            $deleted = DB::table($table)->where('id', $id)->delete();
        } catch (QueryException $e) {
            if (in_array($e->errorInfo[1] ?? null, [1451, 1217], true)) {
                return $this->err(400, "Impossible de supprimer cet élément car il est lié à d'autres enregistrements actifs dans l'application.");
            }
            throw $e;
        }

        return $deleted ? $this->ok(['message' => 'Élément supprimé avec succès.']) : $this->err(404, 'Élément introuvable.');
    }

    private function pick(array $body, array $fields): array
    {
        $data = [];
        foreach ($fields as $f) {
            if (array_key_exists($f, $body)) {
                $data[$f] = $body[$f] === '' ? null : $body[$f];
            }
        }

        return $data;
    }
}
