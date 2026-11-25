<?php

namespace App\Http\Controllers;

use App\Services\Notifier;
use App\Support\Input;
use Illuminate\Database\QueryException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

/** Reprise de routes/institutions.js. */
class InstitutionController extends Controller
{
    public const TYPES = ['ADMINISTRATION', 'ENTERPRISE_PUBLIQUE', 'CTD', 'PROSPECT'];

    private const INFLUENCE = ['DECIDEUR', 'PRESCRIPTEUR', 'INFLUENCEUR', 'FACILITATEUR'];

    private const SELECT = 'SELECT i.*, r.name AS region_name, r.name_en AS region_name_en, d.name AS department_name, d.name_en AS department_name_en, c.name AS city_name, c.name_en AS city_name_en
        FROM crm_institutions i JOIN crm_ref_regions r ON i.region_id = r.id JOIN crm_ref_departments d ON i.department_id = d.id JOIN crm_ref_cities c ON i.city_id = c.id';

    private function canEdit(int $id): bool
    {
        if ($this->isManager() && ! $this->user()['restrictFeatureScope']) {
            return true;
        }
        $row = DB::selectOne('SELECT created_by FROM crm_institutions WHERE id = ?', [$id]);

        return $row && (int) $row->created_by === $this->user()['id'];
    }

    private function invalid(array $b): bool
    {
        return ! Input::nonEmptyString($b['name'] ?? null, 200) || ! in_array($b['type'] ?? null, self::TYPES, true)
            || ! Input::num($b['region_id'] ?? null) || ! Input::num($b['department_id'] ?? null) || ! Input::num($b['city_id'] ?? null);
    }

    private function values(array $b): array
    {
        return [
            trim($b['name']), $b['type'], ($b['tax_id'] ?? null) ?: null, ($b['address'] ?? null) ?: null, $b['region_id'], $b['department_id'], $b['city_id'],
            ($b['phone'] ?? null) ?: null, ($b['email'] ?? null) ?: null, ($b['website'] ?? null) ?: null, ($b['notes'] ?? null) ?: null, Input::bool($b['is_active'] ?? null, true),
        ];
    }

    public function index(Request $request): JsonResponse
    {
        $sql = self::SELECT;
        $cond = [];
        $bind = [];
        if ($this->user()['restrictFeatureScope']) {
            $cond[] = 'i.created_by=?';
            $bind[] = $this->user()['id'];
        }
        if (in_array($type = $request->query('type'), self::TYPES, true)) {
            $cond[] = 'i.type = ?';
            $bind[] = $type;
        }
        if (Input::num($regionId = $request->query('regionId'))) {
            $cond[] = 'i.region_id = ?';
            $bind[] = $regionId;
        }
        if ($cond) {
            $sql .= ' WHERE '.implode(' AND ', $cond);
        }

        return $this->ok($this->rows(DB::select("{$sql} ORDER BY i.name", $bind)));
    }

    public function show(int $id): JsonResponse
    {
        $row = DB::selectOne(self::SELECT.' WHERE i.id = ?', [$id]);
        if (! $row) {
            return $this->err(404, 'Institution introuvable.');
        }

        return $this->ok((array) $row + ['contacts' => $this->rows(DB::select('SELECT * FROM crm_contacts WHERE institution_id = ? ORDER BY last_name', [$id]))]);
    }

    public function store(Request $request): JsonResponse
    {
        $b = $this->body($request);
        if ($this->invalid($b)) {
            return $this->err(400, "Donnees d'institution invalides.");
        }
        try {
            DB::insert('INSERT INTO crm_institutions (name, type, tax_id, address, region_id, department_id, city_id, phone, email, website, notes, is_active, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [...$this->values($b), $this->user()['id']]);
        } catch (QueryException $e) {
            if (($e->errorInfo[1] ?? null) === 1062) {
                return $this->err(409, 'Cette institution existe deja.');
            }
            throw $e;
        }
        $id = (int) DB::getPdo()->lastInsertId();
        if ($this->user()['role'] === 'COMMERCIAL') {
            Notifier::notifyDirection('Nouveau Prospect/Client', "{$this->user()['full_name']} a declare une nouvelle entite : \"".trim($b['name'])."\" ({$b['type']}).", 'PROSPECT_CREATED', $id);
        }

        return $this->ok(['id' => $id, 'message' => 'Institution creee.'], 201);
    }

    public function update(Request $request, int $id): JsonResponse
    {
        $b = $this->body($request);
        if ($this->invalid($b)) {
            return $this->err(400, "Donnees d'institution invalides.");
        }
        if (! $this->canEdit($id)) {
            return $this->err(403, 'Acces refuse.');
        }
        if (! DB::selectOne('SELECT id FROM crm_institutions WHERE id = ?', [$id])) {
            return $this->err(404, 'Institution introuvable.');
        }
        DB::update('UPDATE crm_institutions SET name = ?, type = ?, tax_id = ?, address = ?, region_id = ?, department_id = ?, city_id = ?, phone = ?, email = ?, website = ?, notes = ?, is_active = ? WHERE id = ?', [...$this->values($b), $id]);

        return $this->ok(['message' => 'Institution mise a jour.']);
    }

    public function status(Request $request, int $id): JsonResponse
    {
        $active = Input::bool($this->body($request)['is_active'] ?? null, true);
        if (! DB::selectOne('SELECT id FROM crm_institutions WHERE id = ?', [$id])) {
            return $this->err(404, 'Institution introuvable.');
        }
        DB::update('UPDATE crm_institutions SET is_active = ? WHERE id = ?', [$active, $id]);

        return $this->ok(['message' => $active ? 'Institution activee.' : 'Institution desactivee.']);
    }

    public function destroy(int $id): JsonResponse
    {
        try {
            $deleted = DB::delete('DELETE FROM crm_institutions WHERE id = ?', [$id]);
        } catch (QueryException) {
            return $this->err(409, "Cette institution est liee a d'autres donnees.");
        }

        return $deleted ? $this->ok(['message' => 'Institution supprimee.']) : $this->err(404, 'Institution introuvable.');
    }

    public function addContact(Request $request, int $id): JsonResponse
    {
        $b = $this->body($request);
        if (! Input::nonEmptyString($b['first_name'] ?? null, 100) || ! Input::nonEmptyString($b['last_name'] ?? null, 100)
            || ! Input::nonEmptyString($b['job_title'] ?? null, 150) || ! in_array($b['influence_level'] ?? null, self::INFLUENCE, true)) {
            return $this->err(400, 'Donnees de contact invalides.');
        }
        if (! $this->canEdit($id)) {
            return $this->err(403, 'Acces refuse.');
        }
        DB::insert('INSERT INTO crm_contacts (institution_id, first_name, last_name, email, phone, job_title, influence_level, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
            $id, trim($b['first_name']), trim($b['last_name']), ($b['email'] ?? null) ?: null, ($b['phone'] ?? null) ?: null, trim($b['job_title']), $b['influence_level'], ($b['notes'] ?? null) ?: null,
        ]);

        return $this->ok(['id' => (int) DB::getPdo()->lastInsertId(), 'message' => 'Contact ajoute.'], 201);
    }

    public function deleteContact(int $contactId): JsonResponse
    {
        $contact = DB::selectOne('SELECT institution_id FROM crm_contacts WHERE id = ?', [$contactId]);
        if (! $contact) {
            return $this->err(404, 'Contact introuvable.');
        }
        if (! $this->canEdit((int) $contact->institution_id)) {
            return $this->err(403, 'Acces refuse.');
        }
        DB::delete('DELETE FROM crm_contacts WHERE id = ?', [$contactId]);

        return $this->ok(['message' => 'Contact supprime.']);
    }
}
