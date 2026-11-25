<?php

namespace App\Http\Controllers;

use App\Exceptions\ApiException;
use App\Services\FeatureAccess;
use App\Services\MissionTargets;
use App\Services\MissionTravel;
use App\Services\Notifier;
use App\Services\ObjectiveProposals;
use App\Services\OpportunityWorkflow;
use App\Services\ReportWorkflow;
use App\Support\Input;
use App\Support\Rows;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * Reprise de routes/sync.js — file d'actions hors-ligne de la PWA.
 *  - idempotence par reçu (user_id, request_id, empreinte du contenu)
 *  - correspondance identifiants locaux → serveur, persistée entre sessions
 *  - chaque action dans sa propre transaction (une erreur n'annule pas le lot)
 * Correctifs : géographie obligatoire pour un prospect (plus de repli sur
 * l'identifiant 1), retour explicite quand une opportunité liée est refusée.
 */
class SyncController extends Controller
{
    private array $results = [];

    private array $details = [];

    private array $map = [];

    private int $success = 0;

    private int $conflicts = 0;

    private int $errors = 0;

    private static function uuid(mixed $v): ?string
    {
        $s = Input::str($v);

        return preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i', $s) ? strtolower($s) : null;
    }

    private static function list(mixed $v): string
    {
        $items = is_array($v) ? $v : ($v ? explode("\n", (string) $v) : []);

        return json_encode(array_values(array_filter(array_map(fn ($i) => trim((string) (is_scalar($i) ? $i : '')), $items), 'strlen')), JSON_UNESCAPED_UNICODE);
    }

    private function resolve(mixed $id): mixed
    {
        return is_scalar($id) && isset($this->map[(string) $id]) ? $this->map[(string) $id] : $id;
    }

    private function remember(mixed $local, int $serverId): void
    {
        if (is_scalar($local) && $local !== '') {
            $this->map[(string) $local] = $serverId;
        }
    }

    private function record(array $result, ?string $detail = null): void
    {
        $this->results[] = $result;
        match ($result['status']) {
            'success' => $this->success++,
            'conflict' => $this->conflicts++,
            default => $this->errors++,
        };
        if ($detail) {
            $this->details[] = $detail;
        }
    }

    private function conflict(string $localId, string $type, array $server, array $payload, string $message, string $detail): void
    {
        DB::insert("INSERT INTO crm_sync_conflicts (user_id, record_type, record_id, local_data, server_data, resolution_choice) VALUES (?, ?, ?, ?, ?, 'KEEP_SERVER')", [
            $this->user()['id'], $type, $server['id'], json_encode($payload, JSON_UNESCAPED_UNICODE), json_encode(Rows::normalize($server), JSON_UNESCAPED_UNICODE),
        ]);
        $this->record(['localId' => $localId, 'status' => 'conflict', 'conflictId' => (int) DB::getPdo()->lastInsertId(), 'recordId' => (int) $server['id'], 'serverData' => $server, 'message' => $message], $detail);
    }

    private static function canSyncMission(mixed $missionId, int $userId): bool
    {
        $id = Input::positiveId($missionId);

        return $id && DB::selectOne('SELECT id FROM crm_missions WHERE id = ? AND (primary_commercial_id = ? OR EXISTS (SELECT 1 FROM crm_mission_associates ma WHERE ma.mission_id = crm_missions.id AND ma.user_id = ?)) LIMIT 1', [$id, $userId, $userId]);
    }

    private static function ownedReport(mixed $reportId, int $userId): ?array
    {
        $id = Input::positiveId($reportId);

        return $id ? Rows::one(DB::selectOne('SELECT r.* FROM crm_reports r LEFT JOIN crm_missions m ON m.id = r.mission_id WHERE r.id = ? AND (r.commercial_id = ? OR m.primary_commercial_id = ?
            OR EXISTS (SELECT 1 FROM crm_mission_associates ma WHERE ma.mission_id = m.id AND ma.user_id = ?)) LIMIT 1', [$id, $userId, $userId, $userId])) : null;
    }

    public function push(Request $request): JsonResponse
    {
        // L'instance du contrôleur peut être réutilisée (tests, Octane) : état remis à zéro.
        $this->results = $this->details = $this->map = [];
        $this->success = $this->conflicts = $this->errors = 0;
        $user = $this->user();
        if ($user['role'] !== 'COMMERCIAL') {
            return $this->err(403, 'Synchronisation reservee aux comptes commerciaux terrain.');
        }
        $actions = $this->body($request)['actions'] ?? null;
        if (! is_array($actions)) {
            return $this->err(400, 'Actions de synchronisation manquantes ou invalides.');
        }
        if (count($actions) > 100) {
            return $this->err(413, 'Maximum 100 actions par synchronisation.');
        }
        foreach (DB::select('SELECT local_aliases,result_json FROM crm_sync_receipts WHERE user_id=? AND local_aliases IS NOT NULL', [$user['id']]) as $row) {
            $result = Rows::decode($row->result_json, []);
            foreach (Rows::decode($row->local_aliases, []) ?? [] as $alias) {
                if (! empty($result['serverId'])) {
                    $this->map[(string) $alias] = (int) $result['serverId'];
                }
            }
        }

        foreach ($actions as $item) {
            $item = is_array($item) ? $item : [];
            $localId = $item['id'] ?? null;
            $action = $item['action'] ?? null;
            $type = $item['type'] ?? null;
            $payload = $item['payload'] ?? null;
            $snapshot = [$this->results, $this->details, $this->map, $this->success, $this->conflicts, $this->errors];
            try {
                $feature = ['prospect' => 'institutions', 'objective' => 'objectives', 'mission' => 'missions', 'report' => 'reports', 'opportunity' => 'opportunities'][$type] ?? null;
                if ($feature) {
                    FeatureAccess::assertFeature($user, $feature, $action === 'create' ? 'can_create' : ($action === 'delete' ? 'can_delete' : 'can_update'));
                }
                if (! is_string($localId) || strlen($localId) > 120 || ! is_array($payload)) {
                    throw ApiException::make(400, 'Action de synchronisation invalide.');
                }
                DB::transaction(function () use ($user, $localId, $action, $type, $payload) {
                    DB::selectOne('SELECT id FROM users WHERE id=? FOR UPDATE', [$user['id']]);
                    $hash = hash('sha256', json_encode(['action' => $action, 'type' => $type, 'payload' => $payload], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
                    $receipt = DB::selectOne('SELECT payload_hash,result_json FROM crm_sync_receipts WHERE user_id=? AND request_id=? FOR UPDATE', [$user['id'], $localId]);
                    if ($receipt) {
                        if ($receipt->payload_hash !== $hash) {
                            throw ApiException::make(409, 'Identifiant de synchronisation réutilisé pour un contenu différent.');
                        }
                        $saved = Rows::decode($receipt->result_json, []);
                        $this->record($saved);
                        if (! empty($saved['serverId'])) {
                            $this->remember($localId, (int) $saved['serverId']);
                            $this->remember($payload['id'] ?? null, (int) $saved['serverId']);
                        }

                        return;
                    }
                    $offset = count($this->results);
                    $this->dispatch($type, $action, $payload, $localId);
                    $result = $this->results[$offset] ?? throw ApiException::make(400, 'Type ou action de synchronisation non pris en charge.');
                    if ($result['status'] === 'success') {
                        $aliases = $action === 'create' ? array_values(array_map('strval', array_filter([$localId, $payload['id'] ?? null, $payload['client_id'] ?? null]))) : [];
                        DB::insert('INSERT INTO crm_sync_receipts (user_id,request_id,payload_hash,result_json,local_aliases) VALUES (?,?,?,?,?)', [$user['id'], $localId, $hash, json_encode(Rows::normalize($result), JSON_UNESCAPED_UNICODE), json_encode($aliases)]);
                    }
                });
            } catch (\Throwable $e) {
                [$this->results, $this->details, $this->map, $this->success, $this->conflicts, $this->errors] = $snapshot;
                $status = $e instanceof ApiException ? $e->status : 500;
                if ($status >= 500) {
                    Log::error('Sync item error: '.$e->getMessage());
                }
                $this->record(['localId' => $localId, 'status' => 'error', 'message' => $status < 500 ? $e->getMessage() : 'Erreur serveur pendant la synchronisation.'],
                    "Erreur sur l'action ".(is_scalar($action) ? $action : '?').' de type '.(is_scalar($type) ? $type : '?').': '.$e->getMessage());
            }
        }

        try {
            DB::insert('INSERT INTO crm_sync_history (user_id, actions_count, status, details) VALUES (?, ?, ?, ?)', [$user['id'], count($actions), ($this->errors || $this->conflicts) ? 'PARTIAL_ERROR' : 'SUCCESS', implode("\n", $this->details)]);
        } catch (\Throwable $e) {
            Log::error('Error logging sync history: '.$e->getMessage());
        }

        return $this->ok(['success' => true, 'processed' => count($actions), 'successCount' => $this->success, 'conflictCount' => $this->conflicts, 'errorCount' => $this->errors, 'results' => $this->results]);
    }

    private function dispatch(mixed $type, mixed $action, array $p, string $localId): void
    {
        match ("{$type}:{$action}") {
            'prospect:create' => $this->createProspect($p, $localId),
            'objective:create', 'objective:update', 'objective:submit', 'objective:delete' => $this->objective($action, $p, $localId),
            'mission:create' => $this->createMission($p, $localId),
            'mission:update' => $this->submitMission($p, $localId),
            'report:create' => $this->createReport($p, $localId),
            'report:update' => $this->updateReport($p, $localId),
            'opportunity:create' => $this->createOpportunity($p, $localId),
            'opportunity:update' => $this->updateOpportunity($p, $localId),
            'opportunity:submit', 'opportunity:add_comment', 'opportunity:complete_action' => $this->opportunityAction($action, $p, $localId),
            default => throw ApiException::make(400, $type === 'mission' ? 'Action de mission non prise en charge.' : ($type === 'objective' ? "Action d'objectif non prise en charge." : 'Type ou action de synchronisation non pris en charge.')),
        };
    }

    private function createProspect(array $p, string $localId): void
    {
        $u = $this->user();
        $name = trim((string) ($p['name'] ?? '')) ?: 'Prospect sans nom';
        if ($existing = DB::selectOne('SELECT id FROM crm_institutions WHERE name = ?', [$name])) {
            $this->conflict($localId, 'prospect', (array) $existing, $p, 'Cette structure existe déjà sur le serveur.', "Conflit prospect: {$name} existe déjà.");

            return;
        }
        $region = Input::positiveId($p['region_id'] ?? null);
        $department = Input::positiveId($p['department_id'] ?? null);
        $city = Input::positiveId($p['city_id'] ?? null);
        if (! $region || ! $department || ! $city) {
            throw ApiException::make(400, 'La région, le département et la ville du prospect sont obligatoires.');
        }
        $type = in_array($p['type'] ?? null, InstitutionController::TYPES, true) ? $p['type'] : 'PROSPECT';
        DB::insert('INSERT INTO crm_institutions (name, type, tax_id, address, region_id, department_id, city_id, phone, email, website, notes, is_active, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, TRUE, ?)', [
            mb_substr($name, 0, 200), $type, ($p['tax_id'] ?? null) ?: null, ($p['address'] ?? null) ?: null, $region, $department, $city, ($p['phone'] ?? null) ?: null, ($p['email'] ?? null) ?: null,
            ($p['website'] ?? null) ?: null, ($p['notes'] ?? null) ?: null, $u['id'],
        ]);
        $id = (int) DB::getPdo()->lastInsertId();
        $this->remember($localId, $id);
        $this->remember($p['id'] ?? null, $id);
        $this->record(['localId' => $localId, 'status' => 'success', 'serverId' => $id], "Prospect créé via synchro: {$name} (ID: {$id})");
        Notifier::notifyDirection('Nouveau Prospect (Synchro)', "{$u['full_name']} a synchronisé un nouveau prospect : \"{$name}\".", 'PROSPECT_CREATED', $id);
    }

    private function objective(string $action, array $p, string $localId): void
    {
        $u = $this->user();
        if ($action === 'create') {
            $r = ObjectiveProposals::create($u, $p, (bool) ($p['submit_requested'] ?? false));
            $this->remember(($p['id'] ?? null) ?: $localId, (int) $r['objective']['id']);
            $this->record(['localId' => $localId, 'status' => 'success', 'serverId' => (int) $r['objective']['id'], 'serverData' => $r['objective']], "Proposition d'objectif synchronisée: {$r['objective']['title']} (ID: {$r['objective']['id']})");

            return;
        }
        if ($action === 'delete') {
            ObjectiveProposals::delete($u, $p['id'] ?? null);
            $this->record(['localId' => $localId, 'status' => 'success', 'serverId' => $p['id']], "Brouillon d'objectif supprimé via synchro: #{$p['id']}");

            return;
        }
        $o = $action === 'update' ? ObjectiveProposals::update($u, $p['id'] ?? null, $p) : ObjectiveProposals::submit($u, $p['id'] ?? null);
        $this->record(['localId' => $localId, 'status' => 'success', 'serverId' => (int) $o['id'], 'serverData' => $o], "Proposition d'objectif ".($action === 'update' ? 'mise à jour' : 'soumise')." via synchro: #{$o['id']}");
    }

    private function createMission(array $p, string $localId): void
    {
        $u = $this->user();
        $rid = self::uuid($p['client_request_id'] ?? null) ?? throw ApiException::make(400, 'Identifiant de synchronisation de mission invalide.');
        if ($existing = DB::selectOne('SELECT id, primary_commercial_id FROM crm_missions WHERE client_request_id = ? LIMIT 1', [$rid])) {
            if ((int) $existing->primary_commercial_id !== $u['id']) {
                throw ApiException::make(409, 'Identifiant de synchronisation de mission déjà utilisé.');
            }
            $this->remember(($p['id'] ?? null) ?: $localId, (int) $existing->id);
            $this->record(['localId' => $localId, 'status' => 'success', 'serverId' => (int) $existing->id], "Mission déjà synchronisée: #{$existing->id}");

            return;
        }
        $objectiveId = Input::positiveId($this->resolve($p['objective_id'] ?? null)) ?? throw ApiException::make(400, 'Objectif rattaché invalide.');
        $title = mb_substr(trim((string) ($p['title'] ?? '')), 0, 150);
        if ($title === '' || empty($p['scheduled_date'])) {
            throw ApiException::make(400, 'Le titre et la date prévue de la mission sont obligatoires.');
        }
        if (! DB::selectOne('SELECT id FROM crm_objectives WHERE id = ? AND (created_by = ? OR responsible_id = ?) LIMIT 1', [$objectiveId, $u['id'], $u['id']])) {
            throw ApiException::make(403, 'Objectif rattaché non autorisé.');
        }
        $raw = is_array($p['targets'] ?? null) ? array_map(fn ($t) => (is_array($t) ? $t : []) + ['institution_id' => null], $p['targets']) : null;
        if ($raw) {
            $raw = array_map(fn ($t) => ['institution_id' => $this->resolve($t['institution_id'])] + $t, $raw);
        }
        $targets = MissionTargets::normalize($raw, ['institution_id' => $this->resolve($p['institution_id'] ?? null)] + $p);
        $first = $targets[0];
        $travel = MissionTravel::resolve($u['id'], array_column($targets, 'city_id'), $p);
        $status = strtoupper((string) ($p['status'] ?? '')) === 'SUBMITTED' || ! empty($p['submit_requested']) ? 'SUBMITTED' : 'DRAFT';
        DB::insert('INSERT INTO crm_missions (client_request_id, objective_id, institution_id, title, description, scheduled_date, duration_hours, primary_commercial_id, region_id, department_id, city_id,
            base_city_id, travel_scope, departure_at, return_at, transport_mode, accommodation_required, estimated_travel_cost, mission_type, strategic_objective, expected_result, target_contacts,
            need_hypotheses, key_questions, key_messages, risks, planned_measures, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
            $rid, $objectiveId, $first['institution_id'], $title, ($p['description'] ?? null) ?: (($p['expected_result'] ?? null) ?: null), $p['scheduled_date'],
            (int) min(max((int) Input::num($p['duration_hours'] ?? null) ?: 2, 1), 72), $u['id'], $first['region_id'], $first['department_id'], $first['city_id'],
            $travel['base_city_id'], $travel['travel_scope'], $travel['departure_at'], $travel['return_at'], $travel['transport_mode'], $travel['accommodation_required'], $travel['estimated_travel_cost'],
            ($p['mission_type'] ?? null) ?: 'PROSPECTION', ($p['strategic_objective'] ?? null) ?: 'IDENTIFIER_BESOIN', ($p['expected_result'] ?? null) ?: null,
            self::list(($p['target_contacts'] ?? null) ?: ($p['target_actors'] ?? null)), self::list($p['need_hypotheses'] ?? null), self::list(($p['key_questions'] ?? null) ?: ($p['critical_questions'] ?? null)),
            self::list($p['key_messages'] ?? null), self::list(($p['risks'] ?? null) ?: ($p['risk_flags'] ?? null)), ($p['planned_measures'] ?? null) ?: (($p['mitigation_plan'] ?? null) ?: null), $status,
        ]);
        $id = (int) DB::getPdo()->lastInsertId();
        $reference = MissionController::reference($id);
        DB::update('UPDATE crm_missions SET mission_reference = ? WHERE id = ?', [$reference, $id]);
        MissionTargets::upsert($id, $targets);
        $this->remember(($p['id'] ?? null) ?: $localId, $id);
        $this->record(['localId' => $localId, 'status' => 'success', 'serverId' => $id, 'serverData' => ['id' => $id, 'mission_reference' => $reference, 'travel_scope' => $travel['travel_scope'], 'targets' => $targets]], "Mission synchronisée: {$title} (ID: {$id})");
        if ($status === 'SUBMITTED') {
            Notifier::notifyDirection('Nouvelle mission terrain soumise', "{$u['full_name']} a soumis la mission « {$title} » (".($travel['travel_scope'] === 'OUT_OF_CITY' ? 'hors de la ville' : 'dans la ville').').', 'MISSION_SUBMITTED', $id);
        }
    }

    private function submitMission(array $p, string $localId): void
    {
        $id = Input::positiveId($this->resolve($p['id'] ?? null)) ?? throw ApiException::make(409, 'Mission locale non synchronisée.');
        if (strtoupper((string) ($p['status'] ?? '')) !== 'SUBMITTED') {
            throw ApiException::make(400, 'Mise à jour de mission non prise en charge par la synchronisation.');
        }
        if (! DB::update("UPDATE crm_missions SET status = 'SUBMITTED' WHERE id = ? AND primary_commercial_id = ? AND status = 'DRAFT'", [$id, $this->user()['id']])) {
            throw ApiException::make(409, 'Mission introuvable, non autorisée ou déjà soumise.');
        }
        $this->record(['localId' => $localId, 'status' => 'success', 'serverId' => $id], "Mission soumise via synchronisation: #{$id}");
    }

    private static function reportStatus(mixed $v): string
    {
        $s = strtoupper((string) $v);

        return $s === 'SUBMITTED' ? 'SOUMIS' : (in_array($s, ['A_COMPLETER', 'SOUMIS'], true) ? $s : 'A_COMPLETER');
    }

    private function createReport(array $p, string $localId): void
    {
        $u = $this->user();
        $missionId = $this->resolve($p['mission_id'] ?? null);
        $institutionId = Input::positiveId($this->resolve($p['institution_id'] ?? null));
        if (! self::canSyncMission($missionId, $u['id'])) {
            $this->record(['localId' => $localId, 'status' => 'error', 'message' => 'Mission non autorisee pour ce rapport.']);

            return;
        }
        if ($existing = DB::selectOne('SELECT id FROM crm_reports WHERE mission_id = ?', [$missionId])) {
            $this->conflict($localId, 'report', (array) $existing, $p, 'Un rapport existe déjà pour cette mission sur le serveur.', "Conflit rapport: Mission #{$missionId} a déjà un rapport.");

            return;
        }
        $t = fn ($k) => trim((string) (is_scalar($p[$k] ?? null) ? $p[$k] : ''));
        $persons = $p['persons_met'] ?? '';
        DB::insert("INSERT INTO crm_reports (report_type, mission_id, objective_id, institution_id, commercial_id, period_start, period_end, status, executive_summary, results, diagnosis, difficulties,
            recommendations, next_steps, generated_from, generated_by, persons_met) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'mobile', ?, ?)", [
            ($p['report_type'] ?? null) ?: 'activity_report', (int) $missionId, Input::positiveId($p['objective_id'] ?? null), $institutionId, $u['id'], ($p['period_start'] ?? null) ?: null,
            ($p['period_end'] ?? null) ?: null, self::reportStatus($p['status'] ?? null), $t('executive_summary'), $t('results'), $t('diagnosis'), $t('difficulties'), $t('recommendations'), $t('next_steps'),
            $u['id'], is_array($persons) ? json_encode($persons, JSON_UNESCAPED_UNICODE) : (string) $persons,
        ]);
        $id = (int) DB::getPdo()->lastInsertId();
        DB::update('UPDATE crm_reports SET code = ? WHERE id = ?', ['RAP-'.gmdate('Ymd').'-'.str_pad((string) $id, 4, '0', STR_PAD_LEFT), $id]);
        DB::update("UPDATE crm_missions SET status = 'COMPLETED' WHERE id = ?", [$missionId]);
        if (is_array($p['opportunities'] ?? null)) {
            ReportController::syncOpportunities($id, $p['opportunities'], $institutionId, $u, false);
        }
        $this->remember($localId, $id);
        $this->remember($p['id'] ?? null, $id);
        $this->record(['localId' => $localId, 'status' => 'success', 'serverId' => $id], "Rapport créé via synchro pour mission #{$missionId} (ID: {$id})");
        $title = DB::selectOne('SELECT title FROM crm_missions WHERE id = ?', [$missionId])?->title ?? "Mission #{$missionId}";
        Notifier::notifyDirection('Rapport Soumis (Synchro)', "{$u['full_name']} a soumis un rapport pour la mission \"{$title}\".", 'REPORT_SUBMITTED', $id);
    }

    private function updateReport(array $p, string $localId): void
    {
        $u = $this->user();
        $server = self::ownedReport($p['id'] ?? null, $u['id']);
        if (! $server) {
            $this->record(['localId' => $localId, 'status' => 'error', 'message' => 'Rapport introuvable sur le serveur.']);

            return;
        }
        $clientAt = strtotime((string) ($p['updated_at'] ?? '')) ?: time();
        if (strtotime($server['updated_at']) > $clientAt && $server['status'] !== ($p['status'] ?? null)) {
            $this->conflict($localId, 'report', $server, $p, 'Le rapport a été modifié sur le serveur.', "Conflit rapport: #{$server['id']} modifié sur le serveur.");

            return;
        }
        $t = fn ($k) => trim((string) (is_scalar($p[$k] ?? null) ? $p[$k] : ''));
        $persons = $p['persons_met'] ?? '';
        $institution = Input::positiveId($p['institution_id'] ?? null) ?? $server['institution_id'];
        DB::update("UPDATE crm_reports SET executive_summary = ?, results = ?, diagnosis = ?, difficulties = ?, recommendations = ?, next_steps = ?, institution_id = ?, objective_id = ?, period_start = ?, period_end = ?, persons_met = ?,
            status = CASE WHEN ? = 'SOUMIS' AND status IN ('BROUILLON_AUTO', 'A_COMPLETER', 'CORRECTION_DEMANDEE', 'DRAFT', 'REJECTED', 'REJETE') THEN 'SOUMIS' WHEN status = 'BROUILLON_AUTO' THEN 'A_COMPLETER' ELSE status END WHERE id = ?", [
            $t('executive_summary'), $t('results'), $t('diagnosis'), $t('difficulties'), $t('recommendations'), $t('next_steps'), $institution,
            Input::positiveId($p['objective_id'] ?? null) ?? $server['objective_id'], ($p['period_start'] ?? null) ?: $server['period_start'], ($p['period_end'] ?? null) ?: $server['period_end'],
            is_array($persons) ? json_encode($persons, JSON_UNESCAPED_UNICODE) : (string) $persons, self::reportStatus($p['status'] ?? null), $server['id'],
        ]);
        if (is_array($p['opportunities'] ?? null)) {
            ReportController::syncOpportunities((int) $server['id'], $p['opportunities'], $institution ? (int) $institution : null, $u, true);
        }
        $this->record(['localId' => $localId, 'status' => 'success'], "Rapport mis à jour via synchro: #{$server['id']}");
    }

    private function opportunityAction(string $action, array $p, string $localId): void
    {
        $u = $this->user();
        $id = Input::positiveId($this->resolve($p['id'] ?? null));
        $opp = $id ? OpportunityWorkflow::get($id) : null;
        if (! $opp || ! OpportunityWorkflow::canAccess($opp, $u)) {
            throw ApiException::make(403, 'Opportunité non autorisée.');
        }
        if ($action === 'submit') {
            OpportunityWorkflow::submit($id, $u);
        } elseif ($action === 'add_comment') {
            $c = $p['comment'] ?? null;
            if (! is_string($c) || trim($c) === '' || mb_strlen($c) > 10000) {
                throw ApiException::make(400, 'Commentaire invalide.');
            }
            DB::insert('INSERT INTO crm_opportunity_comments (opportunity_id,user_id,comment) VALUES (?,?,?)', [$id, $u['id'], trim($c)]);
        } else {
            if (! in_array($p['status'] ?? null, ['PENDING', 'COMPLETED'], true)) {
                throw ApiException::make(400, 'Statut invalide.');
            }
            if (! DB::update("UPDATE crm_opportunity_actions SET status=?, completed_at=IF(?='COMPLETED',NOW(),NULL) WHERE id=? AND opportunity_id=?", [$p['status'], $p['status'], $p['actionId'] ?? null, $id])) {
                throw ApiException::make(404, 'Action introuvable.');
            }
        }
        $this->record(['localId' => $localId, 'status' => 'success', 'serverId' => $id]);
    }

    private function createOpportunity(array $p, string $localId): void
    {
        $u = $this->user();
        $institution = Input::positiveId($this->resolve($p['institution_id'] ?? null));
        if (! $institution) {
            $this->record(['localId' => $localId, 'status' => 'error', 'message' => 'Institution invalide ou non trouvée pour cette opportunité.']);

            return;
        }
        $mission = ($p['mission_id'] ?? null) ? $this->resolve($p['mission_id']) : null;
        if ($mission && ! self::canSyncMission($mission, $u['id'])) {
            $this->record(['localId' => $localId, 'status' => 'error', 'message' => 'Mission non autorisee pour cette opportunite.']);

            return;
        }
        $requested = ($p['status'] ?? null) ?: 'DETECTED';
        $amount = $p['estimated_amount'] ?? null;
        if (! in_array($requested, ['DETECTED', 'SUBMITTED'], true) || ! Input::nonEmptyString($p['title'] ?? null, 150) || trim((string) ($p['need_description'] ?? '')) === '' || ! is_numeric($amount) || $amount <= 0) {
            throw ApiException::make(400, 'Données de création de l’opportunité invalides.');
        }
        DB::insert("INSERT INTO crm_opportunities (institution_id, mission_id, title, need_description, estimated_amount, priority, status, pipeline_stage, assigned_to) VALUES (?, ?, ?, ?, ?, ?, 'DETECTED', 'DETECTION', ?)", [
            $institution, Input::positiveId($mission), trim($p['title']), (string) $p['need_description'], (float) $amount, in_array($p['priority'] ?? null, ['LOW', 'MEDIUM', 'HIGH'], true) ? $p['priority'] : 'MEDIUM', $u['id'],
        ]);
        $id = (int) DB::getPdo()->lastInsertId();
        $this->remember(($p['id'] ?? null) ?: $localId, $id);
        OpportunityWorkflow::logHistory($id, null, 'DETECTED', 'Création hors ligne', null, $u['id']);
        if ($requested === 'SUBMITTED') {
            OpportunityWorkflow::submit($id, $u);
        }
        $this->record(['localId' => $localId, 'status' => 'success', 'serverId' => $id], "Opportunité créée via synchro: {$p['title']} (ID: {$id})");
        Notifier::notifyDirection('Nouvelle Opportunité (Synchro)', "{$u['full_name']} a synchronisé une opportunité : \"{$p['title']}\" ({$amount} FCFA).", 'OPPORTUNITY_CREATED', $id);
    }

    private function updateOpportunity(array $p, string $localId): void
    {
        $u = $this->user();
        $server = Rows::one(DB::selectOne('SELECT * FROM crm_opportunities WHERE id = ? AND assigned_to = ?', [$p['id'] ?? null, $u['id']]));
        if (! $server) {
            $this->record(['localId' => $localId, 'status' => 'error', 'message' => 'Opportunite introuvable ou non autorisee sur le serveur.']);

            return;
        }
        $clientAt = strtotime((string) ($p['updated_at'] ?? '')) ?: time();
        if (strtotime($server['updated_at']) > $clientAt && array_key_exists('pipeline_stage', $p) && $server['pipeline_stage'] !== $p['pipeline_stage']) {
            $this->conflict($localId, 'opportunity', $server, $p, "L'opportunité a été modifiée sur le serveur entre-temps.", "Conflit opportunité: #{$server['id']} modifiée sur le serveur.");

            return;
        }
        if (! in_array($server['status'], ['DETECTED', 'TO_CORRECT'], true)) {
            $this->record(['localId' => $localId, 'status' => 'error', 'message' => "Cette opportunite n'est plus modifiable depuis la PWA."]);

            return;
        }
        if (array_key_exists('pipeline_stage', $p) && $p['pipeline_stage'] !== $server['pipeline_stage']) {
            throw ApiException::make(400, 'Le changement d’étape doit suivre le workflow de validation.');
        }
        $title = array_key_exists('title', $p) ? $p['title'] : $server['title'];
        $need = array_key_exists('need_description', $p) ? $p['need_description'] : $server['need_description'];
        $amount = array_key_exists('estimated_amount', $p) ? $p['estimated_amount'] : $server['estimated_amount'];
        $priority = array_key_exists('priority', $p) && in_array($p['priority'], ['LOW', 'MEDIUM', 'HIGH'], true) ? $p['priority'] : $server['priority'];
        if (! Input::nonEmptyString($title, 150) || ! is_string($need) || trim($need) === '' || ! is_numeric($amount) || $amount <= 0) {
            throw ApiException::make(400, 'Données d’opportunité invalides.');
        }
        DB::update('UPDATE crm_opportunities SET title = ?, need_description = ?, estimated_amount = ?, priority = ? WHERE id = ?', [$title, $need, $amount, $priority, $server['id']]);
        if (strtoupper((string) ($p['status'] ?? '')) === 'SUBMITTED') {
            OpportunityWorkflow::submit((int) $server['id'], $u);
        }
        $this->record(['localId' => $localId, 'status' => 'success'], "Opportunité mise à jour: #{$server['id']} vers {$server['pipeline_stage']}");
        Notifier::notifyDirection('Pipeline opportunité mis à jour (Synchro)', "{$u['full_name']} a mis à jour l'opportunité \"{$title}\" vers l'étape \"{$server['pipeline_stage']}\".", 'OPPORTUNITY_UPDATED', (int) $server['id']);
    }

    public function resolveConflict(Request $request): JsonResponse
    {
        $u = $this->user();
        if ($u['role'] !== 'COMMERCIAL') {
            return $this->err(403, 'Resolution de conflit reservee aux comptes commerciaux terrain.');
        }
        $b = $this->body($request);
        $choice = $b['resolutionChoice'] ?? null;
        if (empty($b['conflictId']) || ! $choice) {
            return $this->err(400, 'Paramètres de résolution manquants.');
        }
        if (! in_array($choice, ['KEEP_LOCAL', 'KEEP_SERVER', 'MERGED'], true)) {
            return $this->err(400, 'Choix de resolution invalide.');
        }
        $conflict = DB::selectOne('SELECT * FROM crm_sync_conflicts WHERE id = ? AND user_id = ?', [$b['conflictId'], $u['id']]);
        if (! $conflict) {
            return $this->err(404, 'Conflit introuvable.');
        }
        if ($choice === 'KEEP_SERVER') {
            DB::delete('DELETE FROM crm_sync_conflicts WHERE id = ?', [$conflict->id]);

            return $this->ok(['message' => 'Conflit resolu en conservant la version serveur.']);
        }
        $data = $choice === 'MERGED' && is_array($b['mergedData'] ?? null) ? $b['mergedData'] : (Rows::decode($conflict->local_data, []) ?? []);

        return DB::transaction(function () use ($conflict, $data, $u) {
            if ($conflict->record_type === 'prospect') {
                if (! DB::selectOne('SELECT id FROM crm_institutions WHERE id = ? AND created_by = ? LIMIT 1', [$conflict->record_id, $u['id']])) {
                    return $this->err(403, 'Prospect non autorise.');
                }
                $geo = array_map(fn ($k) => Input::positiveId($data[$k] ?? null), ['region_id', 'department_id', 'city_id']);
                if (in_array(null, $geo, true) || ! Input::nonEmptyString($data['name'] ?? null, 200) || ! in_array($data['type'] ?? null, InstitutionController::TYPES, true)) {
                    return $this->err(400, "Donnees d'institution invalides.");
                }
                DB::update('UPDATE crm_institutions SET name = ?, type = ?, tax_id = ?, address = ?, region_id = ?, department_id = ?, city_id = ?, phone = ?, email = ?, website = ? WHERE id = ?', [
                    trim($data['name']), $data['type'], ($data['tax_id'] ?? null) ?: null, ($data['address'] ?? null) ?: null, ...$geo, ($data['phone'] ?? null) ?: null, ($data['email'] ?? null) ?: null, ($data['website'] ?? null) ?: null, $conflict->record_id,
                ]);
            } elseif ($conflict->record_type === 'opportunity') {
                $current = DB::selectOne('SELECT id, status, pipeline_stage FROM crm_opportunities WHERE id = ? AND assigned_to = ? LIMIT 1 FOR UPDATE', [$conflict->record_id, $u['id']]);
                if (! $current) {
                    return $this->err(403, 'Opportunite non autorisee.');
                }
                if (! in_array($current->status, ['DETECTED', 'TO_CORRECT'], true)) {
                    return $this->err(409, "Cette opportunite n'est plus modifiable depuis la PWA.");
                }
                if (! Input::nonEmptyString($data['title'] ?? null, 150) || ! is_numeric($data['estimated_amount'] ?? null) || $data['estimated_amount'] <= 0) {
                    return $this->err(400, "Données d'opportunité invalides.");
                }
                // Le changement d'étape/statut passe par le workflow, jamais par la résolution de conflit.
                DB::update('UPDATE crm_opportunities SET title = ?, need_description = ?, estimated_amount = ?, priority = ? WHERE id = ?', [
                    trim($data['title']), (string) ($data['need_description'] ?? ''), (float) $data['estimated_amount'], in_array($data['priority'] ?? null, ['LOW', 'MEDIUM', 'HIGH'], true) ? $data['priority'] : 'MEDIUM', $conflict->record_id,
                ]);
            } elseif ($conflict->record_type === 'report') {
                $report = self::ownedReport($conflict->record_id, $u['id']);
                if (! $report) {
                    return $this->err(403, 'Rapport non autorise.');
                }
                if (! in_array($report['status'], ReportWorkflow::EDITABLE, true)) {
                    return $this->err(409, 'Modification impossible sur un rapport soumis ou validé.');
                }
                $s = fn ($k) => is_array($data[$k] ?? null) ? json_encode($data[$k], JSON_UNESCAPED_UNICODE) : (($data[$k] ?? null) === null ? null : (string) $data[$k]);
                DB::update('UPDATE crm_reports SET executive_summary = ?, administrations_visited = ?, persons_met = ?, difficulties = ?, recommendations = ? WHERE id = ?', [
                    $s('executive_summary'), $s('administrations_visited'), $s('persons_met'), $s('difficulties'), $s('recommendations'), $conflict->record_id,
                ]);
            }
            DB::delete('DELETE FROM crm_sync_conflicts WHERE id = ?', [$conflict->id]);

            return $this->ok(['message' => 'Conflit résolu et base serveur mise à jour avec succès.']);
        });
    }
}
