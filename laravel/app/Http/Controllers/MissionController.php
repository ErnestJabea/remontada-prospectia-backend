<?php

namespace App\Http\Controllers;

use App\Services\FeatureAccess;
use App\Services\MissionTargets;
use App\Services\MissionTravel;
use App\Services\ReportWorkflow;
use App\Services\Uploads;
use App\Support\Input;
use App\Support\Rows;
use Barryvdh\DomPDF\Facade\Pdf;
use chillerlan\QRCode\Common\EccLevel;
use chillerlan\QRCode\QRCode;
use chillerlan\QRCode\QROptions;
use Illuminate\Database\QueryException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

/** Reprise de routes/missions.js (cycle de vie, ordre de mission PDF signé + QR, pièces jointes). */
class MissionController extends Controller
{
    public const STATUSES = ['DRAFT', 'SUBMITTED', 'IN_VALIDATION', 'VALIDATED', 'PLANNED', 'IN_PROGRESS', 'COMPLETED', 'CLOSED', 'REJECTED', 'CANCELLED', 'POSTPONED'];

    public const VALID_ORDER = ['VALIDATED', 'PLANNED', 'POSTPONED', 'IN_PROGRESS', 'COMPLETED', 'CLOSED'];

    private const TRANSITIONS = [
        'DRAFT' => ['SUBMITTED', 'CANCELLED'], 'SUBMITTED' => ['IN_VALIDATION', 'REJECTED', 'CANCELLED'], 'IN_VALIDATION' => ['VALIDATED', 'REJECTED'],
        'VALIDATED' => ['PLANNED', 'CANCELLED'], 'PLANNED' => ['IN_PROGRESS', 'POSTPONED', 'CANCELLED'], 'POSTPONED' => ['PLANNED', 'CANCELLED'],
        'IN_PROGRESS' => ['COMPLETED', 'POSTPONED', 'CANCELLED'], 'COMPLETED' => ['CLOSED'], 'REJECTED' => ['DRAFT'], 'CLOSED' => [], 'CANCELLED' => [],
    ];

    private const COMMERCIAL_TRANSITIONS = [
        'DRAFT' => ['SUBMITTED', 'CANCELLED'], 'REJECTED' => ['DRAFT'], 'PLANNED' => ['IN_PROGRESS', 'POSTPONED'], 'POSTPONED' => ['IN_PROGRESS'], 'IN_PROGRESS' => ['COMPLETED', 'POSTPONED'],
    ];

    private const SELECT = 'SELECT m.*, o.title AS objective_title, i.name AS institution_name, u.full_name AS primary_commercial_name, r.name AS region_name,
        r.name_en AS region_name_en, d.name AS department_name, d.name_en AS department_name_en, c.name AS city_name, c.name_en AS city_name_en,
        base.name AS base_city_name, base.name_en AS base_city_name_en
        FROM crm_missions m JOIN crm_objectives o ON m.objective_id = o.id JOIN crm_institutions i ON m.institution_id = i.id JOIN users u ON m.primary_commercial_id = u.id
        JOIN crm_ref_regions r ON m.region_id = r.id JOIN crm_ref_departments d ON m.department_id = d.id JOIN crm_ref_cities c ON m.city_id = c.id
        LEFT JOIN crm_ref_cities base ON m.base_city_id = base.id';

    public static function list(mixed $value): array
    {
        if (is_array($value)) {
            return array_values(array_filter(array_map(fn ($v) => trim((string) (is_scalar($v) ? $v : '')), $value), 'strlen'));
        }
        if (is_string($value)) {
            $decoded = json_decode($value, true);
            if (is_array($decoded)) {
                return self::list($decoded);
            }

            return array_values(array_filter(array_map('trim', explode("\n", $value)), 'strlen'));
        }

        return [];
    }

    public static function contacts(mixed $value): string
    {
        $out = [];
        foreach (is_array($value) ? $value : [] as $c) {
            $c = is_array($c) ? $c : [];
            $row = ['role' => trim((string) ($c['role'] ?? 'AUTRE')) ?: 'AUTRE', 'name' => trim((string) ($c['name'] ?? '')), 'phone' => trim((string) ($c['phone'] ?? '')), 'email' => trim((string) ($c['email'] ?? ''))];
            if ($row['name'] || $row['phone'] || $row['email']) {
                $out[] = $row;
            }
        }

        return json_encode($out, JSON_UNESCAPED_UNICODE);
    }

    public static function reference(int $id): string
    {
        return 'MIS-'.date('Y').'-'.str_pad((string) $id, 5, '0', STR_PAD_LEFT);
    }

    private function access(int $id): array
    {
        $m = DB::selectOne('SELECT m.*, EXISTS(SELECT 1 FROM crm_mission_associates ma WHERE ma.mission_id = m.id AND ma.user_id = ?) AS is_associate FROM crm_missions m WHERE m.id = ?', [$this->user()['id'], $id]);
        if (! $m) {
            return [null, false, false];
        }
        $m = (array) $m;
        $owner = (int) $m['primary_commercial_id'] === $this->user()['id'];

        return [$m, $this->isManager() || $owner || (bool) $m['is_associate'], $this->isManager() || $owner];
    }

    public function index(Request $request): JsonResponse
    {
        $sql = self::SELECT;
        $cond = [];
        $bind = [];
        $u = $this->user();
        if ($u['role'] === 'COMMERCIAL' || $u['restrictFeatureScope']) {
            $cond[] = '(m.primary_commercial_id = ? OR EXISTS(SELECT 1 FROM crm_mission_associates ma WHERE ma.mission_id = m.id AND ma.user_id = ?))';
            array_push($bind, $u['id'], $u['id']);
        }
        if (in_array($status = $request->query('status'), self::STATUSES, true)) {
            $cond[] = 'm.status = ?';
            $bind[] = $status;
        }
        if (($cid = $request->query('commercialId')) && $this->isManager()) {
            $cond[] = 'm.primary_commercial_id = ?';
            $bind[] = $cid;
        }
        if ($cond) {
            $sql .= ' WHERE '.implode(' AND ', $cond);
        }
        $rows = $this->rows(DB::select("{$sql} ORDER BY m.scheduled_date DESC", $bind));
        $targets = MissionTargets::forMissions(array_column($rows, 'id'));

        return $this->ok(array_map(fn ($r) => $r + ['targets' => $targets[(int) $r['id']] ?? []], $rows));
    }

    public function show(int $id): JsonResponse
    {
        [$m, $canRead] = $this->access($id);
        if (! $m) {
            return $this->err(404, 'Mission introuvable.');
        }
        if (! $canRead) {
            return $this->err(403, 'Acces refuse.');
        }
        $row = (array) DB::selectOne(self::SELECT.' WHERE m.id = ?', [$id]);

        return $this->ok($row + [
            'targets' => MissionTargets::forMissions([$id])[$id] ?? [],
            'associates' => $this->rows(DB::select('SELECT u.id, u.full_name, u.role FROM crm_mission_associates ma JOIN users u ON ma.user_id = u.id WHERE ma.mission_id = ?', [$id])),
            'report' => Rows::one(DB::selectOne('SELECT id, status FROM crm_reports WHERE mission_id = ?', [$id])),
            'attachments' => $this->rows(DB::select('SELECT id, file_name, file_size, created_at FROM crm_mission_attachments WHERE mission_id = ? ORDER BY created_at DESC', [$id])),
        ]);
    }

    private function missionValues(array $b, array $travel, array $primary, ?array $current = null): array
    {
        return [
            $travel['base_city_id'], $travel['travel_scope'], $travel['departure_at'], $travel['return_at'], $travel['transport_mode'], $travel['accommodation_required'], $travel['estimated_travel_cost'],
            ($b['mission_type'] ?? null) ?: ($current['mission_type'] ?? null) ?: 'PROSPECTION',
            ($b['strategic_objective'] ?? null) ?: ($current['strategic_objective'] ?? null) ?: 'IDENTIFIER_BESOIN',
            ($b['expected_result'] ?? null) ?: null, ($b['target_decision_maker'] ?? null) ?: null, ($b['target_technical_prescriber'] ?? null) ?: null, ($b['target_influencer'] ?? null) ?: null,
            self::contacts($b['target_contacts'] ?? null),
            json_encode(self::list($b['need_hypotheses'] ?? null), JSON_UNESCAPED_UNICODE), json_encode(self::list($b['visit_approach'] ?? null), JSON_UNESCAPED_UNICODE),
            json_encode(self::list($b['key_questions'] ?? null), JSON_UNESCAPED_UNICODE), json_encode(self::list($b['key_messages'] ?? null), JSON_UNESCAPED_UNICODE),
            json_encode(self::list($b['risks'] ?? null), JSON_UNESCAPED_UNICODE), ($b['planned_measures'] ?? null) ?: null,
        ];
    }

    private function duration(mixed $v): int
    {
        return (int) min(max((int) Input::num($v) ?: 2, 1), 72);
    }

    public function store(Request $request): JsonResponse
    {
        $b = $this->body($request);
        $primaryId = $this->isManager() ? ($b['primary_commercial_id'] ?? null) : $this->user()['id'];
        if (! Input::num($b['objective_id'] ?? null) || ! Input::nonEmptyString($b['title'] ?? null, 150) || empty($b['scheduled_date']) || ! Input::num($primaryId)) {
            return $this->err(400, 'Donnees de mission invalides.');
        }
        if (! FeatureAccess::canLinkRecord($this->user(), 'objectives', $b['objective_id'])) {
            return $this->err(403, 'Objectif inaccessible.');
        }

        return DB::transaction(function () use ($b, $primaryId) {
            $targets = MissionTargets::normalize($b['targets'] ?? null, $b);
            $p = $targets[0];
            $travel = MissionTravel::resolve($primaryId, array_column($targets, 'city_id'), $b);
            DB::insert("INSERT INTO crm_missions (objective_id, institution_id, title, description, scheduled_date, duration_hours, primary_commercial_id, region_id, department_id, city_id,
                base_city_id, travel_scope, departure_at, return_at, transport_mode, accommodation_required, estimated_travel_cost, mission_type, strategic_objective, expected_result,
                target_decision_maker, target_technical_prescriber, target_influencer, target_contacts, need_hypotheses, visit_approach, key_questions, key_messages, risks, planned_measures, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT')", [
                $b['objective_id'], $p['institution_id'], trim($b['title']), ($b['description'] ?? null) ?: null, $b['scheduled_date'], $this->duration($b['duration_hours'] ?? null),
                $primaryId, $p['region_id'], $p['department_id'], $p['city_id'], ...$this->missionValues($b, $travel, $p),
            ]);
            $id = (int) DB::getPdo()->lastInsertId();
            MissionTargets::upsert($id, $targets);
            if ($this->isManager() && is_array($b['associates'] ?? null)) {
                foreach (array_unique(array_filter(array_map('intval', $b['associates']))) as $uid) {
                    DB::insert('INSERT IGNORE INTO crm_mission_associates (mission_id, user_id) VALUES (?, ?)', [$id, $uid]);
                }
            }

            return $this->ok(['id' => $id, 'travel_scope' => $travel['travel_scope'], 'targets' => $targets, 'message' => 'Mission creee.'], 201);
        });
    }

    public function update(Request $request, int $id): JsonResponse
    {
        $b = $this->body($request);
        if (! Input::nonEmptyString($b['title'] ?? null, 150) || empty($b['scheduled_date'])) {
            return $this->err(400, 'Donnees de mission invalides.');
        }
        [$m, , $canWrite] = $this->access($id);
        if (! $m) {
            return $this->err(404, 'Mission introuvable.');
        }
        if (! $canWrite) {
            return $this->err(403, 'Acces refuse.');
        }
        if (! $this->isManager() && ! in_array($m['status'], ['DRAFT', 'REJECTED', 'PLANNED', 'POSTPONED'], true)) {
            return $this->err(409, 'Cette mission ne peut plus etre modifiee.');
        }

        return DB::transaction(function () use ($b, $id, $m) {
            $targets = MissionTargets::normalize($b['targets'] ?? null, $b);
            $p = $targets[0];
            $travel = MissionTravel::resolve($m['primary_commercial_id'], array_column($targets, 'city_id'), $b);
            DB::update('UPDATE crm_missions SET title = ?, description = ?, scheduled_date = ?, duration_hours = ?, institution_id = ?, region_id = ?, department_id = ?, city_id = ?,
                base_city_id = ?, travel_scope = ?, departure_at = ?, return_at = ?, transport_mode = ?, accommodation_required = ?, estimated_travel_cost = ?, mission_type = ?, strategic_objective = ?,
                expected_result = ?, target_decision_maker = ?, target_technical_prescriber = ?, target_influencer = ?, target_contacts = ?, need_hypotheses = ?, visit_approach = ?, key_questions = ?,
                key_messages = ?, risks = ?, planned_measures = ? WHERE id = ?', [
                trim($b['title']), ($b['description'] ?? null) ?: null, $b['scheduled_date'], $this->duration($b['duration_hours'] ?? null),
                $p['institution_id'], $p['region_id'], $p['department_id'], $p['city_id'], ...$this->missionValues($b, $travel, $p, $m), $id,
            ]);
            MissionTargets::upsert($id, $targets);

            return $this->ok(['travel_scope' => $travel['travel_scope'], 'targets' => $targets, 'message' => 'Mission mise a jour.']);
        });
    }

    public function status(Request $request, int $id): JsonResponse
    {
        $b = $this->body($request);
        $status = $b['status'] ?? null;
        if (! in_array($status, self::STATUSES, true)) {
            return $this->err(400, 'Statut invalide.');
        }

        return DB::transaction(function () use ($b, $id, $status) {
            DB::selectOne('SELECT id FROM crm_missions WHERE id = ? FOR UPDATE', [$id]);
            [$m, , $canWrite] = $this->access($id);
            if (! $m) {
                return $this->err(404, 'Mission introuvable.');
            }
            if (! $canWrite) {
                return $this->err(403, 'Acces refuse.');
            }
            if ($status === $m['status']) {
                return $this->ok(['message' => 'Statut inchange.']);
            }
            $map = $this->isManager() ? self::TRANSITIONS : self::COMMERCIAL_TRANSITIONS;
            if (! in_array($status, $map[$m['status']] ?? [], true)) {
                return $this->err(409, "Transition interdite : {$m['status']} vers {$status}.");
            }
            if ($status === 'REJECTED' && trim((string) ($b['rejection_reason'] ?? '')) === '') {
                return $this->err(400, 'Le motif de rejet est obligatoire.');
            }
            DB::update('UPDATE crm_missions SET status = ?, rejection_reason = ? WHERE id = ?', [$status, ($b['rejection_reason'] ?? null) ?: null, $id]);
            $this->auditTransition("PUT /missions/{$id}/status", $b);

            return $this->ok(['message' => "Mission passee en statut : {$status}"]);
        });
    }

    private function auditTransition(string $action, array $b): void
    {
        DB::insert('INSERT INTO crm_audit_logs (user_id, action_type, module_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?)', [
            $this->user()['id'], mb_substr($action, 0, 100), 'crm_missions', json_encode(['action' => $b['action'] ?? null, 'status' => $b['status'] ?? null]), Input::ip(),
        ]);
    }

    public function action(Request $request, int $id): JsonResponse
    {
        $b = $this->body($request);
        $action = strtoupper((string) ($b['action'] ?? ''));

        return DB::transaction(function () use ($b, $id, $action) {
            DB::selectOne('SELECT id FROM crm_missions WHERE id = ? FOR UPDATE', [$id]);
            [$m, , $canWrite] = $this->access($id);
            if (! $m) {
                return $this->err(404, 'Mission introuvable.');
            }
            $manager = $this->isManager();
            $executable = $manager || (int) $m['primary_commercial_id'] === $this->user()['id'] || (bool) $m['is_associate'];
            $reason = trim((string) ($b['reason'] ?? ''));

            switch ($action) {
                case 'SUBMIT':
                    if (! $canWrite) {
                        return $this->err(403, 'Acces refuse.');
                    }
                    if (! in_array($m['status'], ['DRAFT', 'REJECTED'], true)) {
                        return $this->err(409, 'Seules les missions en brouillon ou a reprendre peuvent etre soumises.');
                    }
                    DB::update("UPDATE crm_missions SET status = 'SUBMITTED', rejection_reason = NULL, completion_request = NULL WHERE id = ?", [$id]);
                    $message = 'Mission soumise pour validation.';
                    break;
                case 'VALIDATE_GATE1':
                    if (! $manager) {
                        return $this->err(403, 'Validation reservee au management.');
                    }
                    if (! in_array($m['status'], ['SUBMITTED', 'IN_VALIDATION', 'VALIDATED'], true)) {
                        return $this->err(409, 'Cette mission ne peut pas etre validee a cette etape.');
                    }
                    DB::update("UPDATE crm_missions SET status = 'PLANNED', mission_reference = ?, gate1_validated_at = NOW(), gate1_validated_by = ?, order_verification_token = ?, rejection_reason = NULL, completion_request = NULL WHERE id = ?", [
                        $m['mission_reference'] ?: self::reference($id), $this->user()['id'], $m['order_verification_token'] ?: bin2hex(random_bytes(32)), $id,
                    ]);
                    $message = 'Mission validee et planifiee.';
                    break;
                case 'REQUEST_COMPLETION':
                case 'REJECT':
                    if (! $manager) {
                        return $this->err(403, $action === 'REJECT' ? 'Rejet reserve au management.' : 'Demande de complement reservee au management.');
                    }
                    if (! in_array($m['status'], ['SUBMITTED', 'IN_VALIDATION'], true)) {
                        return $this->err(409, $action === 'REJECT' ? 'Cette mission ne peut pas etre rejetee a cette etape.' : 'Un complement ne peut etre demande que sur une mission soumise.');
                    }
                    if ($reason === '') {
                        return $this->err(400, $action === 'REJECT' ? 'Le motif de rejet est obligatoire.' : 'Precisez le complement attendu.');
                    }
                    $action === 'REJECT'
                        ? DB::update("UPDATE crm_missions SET status = 'REJECTED', rejection_reason = ?, completion_request = NULL WHERE id = ?", [$reason, $id])
                        : DB::update("UPDATE crm_missions SET status = 'REJECTED', completion_request = ?, rejection_reason = NULL WHERE id = ?", [$reason, $id]);
                    $message = $action === 'REJECT' ? 'Mission rejetee.' : 'Mission renvoyee pour complement.';
                    break;
                case 'START':
                    if (! $executable) {
                        return $this->err(403, 'Execution reservee aux personnes affectees a la mission.');
                    }
                    if (! in_array($m['status'], ['PLANNED', 'POSTPONED'], true)) {
                        return $this->err(409, 'La mission doit etre planifiee avant execution.');
                    }
                    $at = $b['check_in_at'] ?? null;
                    $ts = $at ? strtotime((string) $at) : time();
                    if ($at && $ts === false) {
                        return $this->err(400, 'Date de pointage invalide.');
                    }
                    $lat = $b['check_in_latitude'] ?? null;
                    $lng = $b['check_in_longitude'] ?? null;
                    if (($lat !== null && (! is_numeric($lat) || abs($lat) > 90)) || ($lng !== null && (! is_numeric($lng) || abs($lng) > 180))) {
                        return $this->err(400, 'Coordonnées de pointage invalides.');
                    }
                    $checkIn = date('Y-m-d H:i:s', $ts);
                    DB::update("UPDATE crm_missions SET status = 'IN_PROGRESS', started_at = COALESCE(started_at, ?), check_in_at = COALESCE(check_in_at, ?), check_in_latitude = COALESCE(check_in_latitude, ?), check_in_longitude = COALESCE(check_in_longitude, ?) WHERE id = ?", [
                        $checkIn, $checkIn, $lat !== null ? (float) $lat : null, $lng !== null ? (float) $lng : null, $id,
                    ]);
                    $message = 'Mission demarree.';
                    break;
                case 'COMPLETE':
                    if (! $executable) {
                        return $this->err(403, 'Execution reservee aux personnes affectees a la mission.');
                    }
                    if ($m['status'] !== 'IN_PROGRESS') {
                        return $this->err(409, 'Seule une mission en cours peut etre terminee.');
                    }
                    DB::update("UPDATE crm_missions SET status = 'COMPLETED', completed_at = COALESCE(completed_at, NOW()) WHERE id = ?", [$id]);
                    ReportWorkflow::generateFromMission($id, $this->user()['id']);
                    $message = 'Mission terminee. Le reporting peut etre soumis.';
                    break;
                case 'CLOSE':
                    if (! $manager) {
                        return $this->err(403, 'Cloture reservee au management.');
                    }
                    if ($m['status'] !== 'COMPLETED') {
                        return $this->err(409, 'Seule une mission terminee peut etre cloturee.');
                    }
                    DB::update("UPDATE crm_missions SET status = 'CLOSED', closed_at = COALESCE(closed_at, NOW()) WHERE id = ?", [$id]);
                    $message = 'Mission cloturee.';
                    break;
                case 'POSTPONE':
                    if (! $canWrite) {
                        return $this->err(403, 'Acces refuse.');
                    }
                    if (! in_array($m['status'], ['PLANNED', 'IN_PROGRESS', 'POSTPONED'], true)) {
                        return $this->err(409, 'Cette mission ne peut pas etre reportee.');
                    }
                    if (empty($b['scheduled_date'])) {
                        return $this->err(400, 'La nouvelle date est obligatoire.');
                    }
                    DB::update("UPDATE crm_missions SET status = 'POSTPONED', scheduled_date = ? WHERE id = ?", [$b['scheduled_date'], $id]);
                    $message = 'Mission reportee.';
                    break;
                case 'CANCEL':
                    if (! $canWrite) {
                        return $this->err(403, 'Acces refuse.');
                    }
                    if (in_array($m['status'], ['CLOSED', 'CANCELLED'], true)) {
                        return $this->err(409, 'Cette mission ne peut plus etre annulee.');
                    }
                    DB::update("UPDATE crm_missions SET status = 'CANCELLED', rejection_reason = ? WHERE id = ?", [$reason ?: null, $id]);
                    $message = 'Mission annulee.';
                    break;
                default:
                    return $this->err(400, 'Action mission inconnue.');
            }
            $this->auditTransition("POST /missions/{$id}/actions", $b);

            return $this->ok(['message' => $message]);
        });
    }

    public function destroy(int $id): JsonResponse
    {
        try {
            $deleted = DB::delete('DELETE FROM crm_missions WHERE id = ?', [$id]);
        } catch (QueryException) {
            return $this->err(409, 'Cette mission ne peut pas etre supprimee.');
        }

        return $deleted ? $this->ok(['message' => 'Mission supprimee.']) : $this->err(404, 'Mission introuvable.');
    }

    public function attach(Request $request, int $id): JsonResponse
    {
        [$m, $canRead] = $this->access($id);
        if (! $m) {
            return $this->err(404, 'Mission introuvable.');
        }
        if (! $canRead) {
            return $this->err(403, 'Accès refusé.');
        }
        if (! $request->hasFile('files')) {
            return $this->err(400, 'Aucun fichier fourni.');
        }
        $stored = Uploads::storeAll($request, 'missions');
        try {
            foreach ($stored as $s) {
                DB::insert('INSERT INTO crm_mission_attachments (mission_id, file_name, file_path, file_size) VALUES (?, ?, ?, ?)', [$id, $s['file_name'], $s['file_path'], $s['file_size']]);
            }
        } catch (\Throwable $e) {
            Uploads::cleanup($stored);
            throw $e;
        }

        return $this->ok(['message' => count($stored).' fichier(s) ajouté(s).'], 201);
    }

    public function download(int $id, int $attId)
    {
        [$m, $canRead] = $this->access($id);
        if (! $m) {
            return $this->err(404, 'Mission introuvable.');
        }
        if (! $canRead) {
            return $this->err(403, 'Accès refusé.');
        }
        $row = DB::selectOne('SELECT file_name, file_path FROM crm_mission_attachments WHERE id = ? AND mission_id = ?', [$attId, $id]);

        return ($row ? Uploads::download($row->file_path, $row->file_name) : null) ?? $this->err(404, 'Pièce jointe introuvable.');
    }

    public function deleteAttachment(int $id, int $attId): JsonResponse
    {
        [$m, , $canWrite] = $this->access($id);
        if (! $m) {
            return $this->err(404, 'Mission introuvable.');
        }
        if (! $canWrite) {
            return $this->err(403, 'Accès refusé.');
        }
        $row = DB::selectOne('SELECT file_path FROM crm_mission_attachments WHERE id = ? AND mission_id = ?', [$attId, $id]);
        if (! $row) {
            return $this->err(404, 'Pièce jointe introuvable.');
        }
        Uploads::delete($row->file_path);
        DB::delete('DELETE FROM crm_mission_attachments WHERE id = ? AND mission_id = ?', [$attId, $id]);

        return $this->ok(['message' => 'Pièce jointe supprimée.']);
    }

    // ------------------------------------------------------------------ Ordre de mission

    public static function signature(array $m, string $token): string
    {
        return strtoupper(substr(hash('sha256', "{$m['id']}|".($m['mission_reference'] ?? '').'|'.self::jsDateString($m['gate1_validated_at'] ?? null)."|{$token}"), 0, 32));
    }

    /**
     * Node concaténait l'objet Date (String(date) → "Wed Jul 15 2026 10:00:00 GMT+0100 (...)").
     * Pour que les empreintes déjà imprimées restent vérifiables, on reproduit ce format.
     */
    private static function jsDateString(?string $value): string
    {
        if (! $value) {
            return '';
        }
        $tz = new \DateTimeZone(config('remontada.db_timezone'));
        $d = new \DateTimeImmutable($value, $tz);
        // Le libellé dépend de la locale ICU du serveur Node d'origine : à
        // ajuster via NODE_TZ_LABEL pour retrouver les empreintes déjà imprimées.
        $label = config('remontada.node_tz_label');

        return $d->format('D M d Y H:i:s').' GMT'.$d->format('O')." ({$label})";
    }

    public function orderPdf(int $id)
    {
        [$m, $canRead] = $this->access($id);
        if (! $m) {
            return $this->err(404, 'Mission introuvable.');
        }
        if (! $canRead) {
            return $this->err(403, 'Acces refuse.');
        }
        if (! in_array($m['status'], self::VALID_ORDER, true)) {
            return $this->err(409, 'Ordre de mission disponible uniquement apres validation.');
        }
        $mission = (array) DB::selectOne('SELECT m.*, o.title AS objective_title, i.name AS institution_name, i.address AS institution_address, i.phone AS institution_phone, i.email AS institution_email,
            u.full_name AS primary_commercial_name, u.email AS primary_commercial_email, u.phone AS primary_commercial_phone, validator.full_name AS validator_name, validator.username AS validator_username,
            validator.email AS validator_email, r.name AS region_name, d.name AS department_name, c.name AS city_name, base.name AS base_city_name
            FROM crm_missions m JOIN crm_objectives o ON m.objective_id = o.id JOIN crm_institutions i ON m.institution_id = i.id JOIN users u ON m.primary_commercial_id = u.id
            LEFT JOIN users validator ON m.gate1_validated_by = validator.id JOIN crm_ref_regions r ON m.region_id = r.id JOIN crm_ref_departments d ON m.department_id = d.id
            JOIN crm_ref_cities c ON m.city_id = c.id LEFT JOIN crm_ref_cities base ON m.base_city_id = base.id WHERE m.id = ?', [$id]);
        $mission['mission_reference'] = $mission['mission_reference'] ?: self::reference($id);
        if (! $mission['order_verification_token']) {
            $mission['order_verification_token'] = bin2hex(random_bytes(32));
            DB::update('UPDATE crm_missions SET order_verification_token = ? WHERE id = ?', [$mission['order_verification_token'], $id]);
        }
        $token = $mission['order_verification_token'];
        $base = rtrim((string) (config('remontada.public_urls.mission_verification') ?: request()->getSchemeAndHttpHost()), '/');
        $url = "{$base}/api/v1/missions/{$id}/order/verify?token=".rawurlencode($token);
        $qr = (new QRCode(new QROptions(['outputBase64' => true, 'eccLevel' => EccLevel::L, 'scale' => 5, 'quietzoneSize' => 2])))->render($url);

        $contacts = self::decodeList($mission['target_contacts']);
        if (! $contacts) {
            $contacts = array_values(array_filter([
                $mission['target_decision_maker'] ? ['role' => 'DECIDEUR_PRINCIPAL', 'name' => $mission['target_decision_maker']] : null,
                $mission['target_technical_prescriber'] ? ['role' => 'PRESCRIPTEUR_TECHNIQUE', 'name' => $mission['target_technical_prescriber']] : null,
                $mission['target_influencer'] ? ['role' => 'INFLUENCEUR', 'name' => $mission['target_influencer']] : null,
            ]));
        }
        $pdf = Pdf::loadView('pdf.mission-order', [
            'm' => $mission,
            'targets' => MissionTargets::forMissions([$id])[$id] ?? [],
            'associates' => DB::select('SELECT u.full_name, u.email, u.phone FROM crm_mission_associates ma JOIN users u ON ma.user_id = u.id WHERE ma.mission_id = ? ORDER BY u.full_name', [$id]),
            'contacts' => $contacts,
            'signature' => self::signature($mission, $token),
            'qr' => $qr,
            'validator' => trim((string) ($mission['validator_name'] ?: $mission['validator_username'] ?: 'Validateur non renseigne')),
            'travelLabel' => $mission['travel_scope'] ? MissionTravel::scopeLabel($mission['travel_scope']) : 'Non classé',
            'lists' => fn ($k) => self::decodeList($mission[$k]),
        ])->setPaper('a4');

        return $pdf->download("ordre-mission-{$mission['mission_reference']}.pdf");
    }

    public static function decodeList(mixed $value): array
    {
        if (! $value) {
            return [];
        }
        $decoded = json_decode((string) $value, true);

        return is_array($decoded) ? $decoded : array_values(array_filter(array_map('trim', explode("\n", (string) $value)), 'strlen'));
    }

    public function verify(Request $request, int $id)
    {
        $nonce = base64_encode(random_bytes(18));
        $headers = [
            'Cache-Control' => 'no-store, max-age=0',
            'Referrer-Policy' => 'no-referrer',
            'Content-Security-Policy' => "default-src 'none'; style-src 'nonce-{$nonce}'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
            'Content-Type' => 'text/html; charset=utf-8',
        ];
        $render = fn (string $state, int $status, ?array $m = null, string $sig = '') => response()->view('mission-verify', ['state' => $state, 'm' => $m, 'signature' => $sig, 'nonce' => $nonce, 'checkedAt' => now()], $status, $headers);
        $token = (string) $request->query('token', '');
        if (! preg_match('/^[a-f0-9]{64}$/i', $token)) {
            return $render('INVALID', 400);
        }
        $m = Rows::one(DB::selectOne('SELECT id, mission_reference, gate1_validated_at, status, order_verification_token FROM crm_missions WHERE id = ?', [$id]));
        if (! $m || ! $m['order_verification_token'] || ! hash_equals($m['order_verification_token'], $token)) {
            return $render('INVALID', 404);
        }
        $sig = self::signature($m, $token);
        if (! $m['gate1_validated_at'] || ! in_array($m['status'], self::VALID_ORDER, true)) {
            return $render('REVOKED', 410, $m, $sig);
        }

        return $render('VALID', 200, $m, $sig);
    }
}
