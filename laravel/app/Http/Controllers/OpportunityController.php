<?php

namespace App\Http\Controllers;

use App\Exceptions\ApiException;
use App\Services\CameroonTime;
use App\Services\FeatureAccess;
use App\Services\FollowupReminders;
use App\Services\Notifier;
use App\Services\OpportunityWorkflow as Flow;
use App\Services\Uploads;
use App\Support\Input;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/** Reprise de routes/opportunities.js. */
class OpportunityController extends Controller
{
    public const STATUSES = ['DETECTED', 'SUBMITTED', 'TO_CORRECT', 'VALIDATED', 'REJECTED', 'IN_ANALYSIS', 'ACTION_PLAN', 'PROPOSAL', 'NEGOTIATION', 'DECISION', 'WON', 'LOST', 'ARCHIVED'];

    private const STAGES = ['DETECTION', 'QUALIFICATION', 'ANALYSE', 'PROPOSITION', 'NEGOCIATION', 'DECISION', 'SIGNATURE'];

    private const SELECT = "SELECT op.*, i.name AS institution_name, u.full_name AS assigned_to_name,
        (SELECT COUNT(*) FROM crm_opportunity_actions WHERE opportunity_id = op.id AND status = 'PENDING') AS pending_actions_count
        FROM crm_opportunities op JOIN crm_institutions i ON op.institution_id = i.id LEFT JOIN users u ON op.assigned_to = u.id";

    private function restricted(): bool
    {
        return $this->user()['role'] === 'COMMERCIAL' || $this->user()['restrictFeatureScope'];
    }

    private function loadAccessible(int $id): array|JsonResponse
    {
        $opp = Flow::get($id);
        if (! $opp) {
            return $this->err(404, 'Opportunité introuvable.');
        }

        return Flow::canAccess($opp, $this->user()) ? $opp : $this->err(403, 'Accès refusé.');
    }

    public function index(Request $request): JsonResponse
    {
        $cond = [];
        $bind = [];
        if ($this->restricted()) {
            $cond[] = 'op.assigned_to = ?';
            $bind[] = $this->user()['id'];
        }
        if (in_array($s = $request->query('status'), self::STATUSES, true)) {
            $cond[] = 'op.status = ?';
            $bind[] = $s;
        } else {
            $cond[] = "op.status != 'ARCHIVED'";
        }
        if (in_array($st = $request->query('pipeline_stage'), self::STAGES, true)) {
            $cond[] = 'op.pipeline_stage = ?';
            $bind[] = $st;
        }
        if (Input::num($iid = $request->query('institutionId'))) {
            $cond[] = 'op.institution_id = ?';
            $bind[] = $iid;
        }

        return $this->ok($this->rows(DB::select(self::SELECT.' WHERE '.implode(' AND ', $cond).' ORDER BY op.created_at DESC', $bind)));
    }

    public function pipeline(): JsonResponse
    {
        $sql = self::SELECT." WHERE op.status NOT IN ('ARCHIVED')";
        $bind = [];
        if ($this->restricted()) {
            $sql .= ' AND op.assigned_to = ?';
            $bind[] = $this->user()['id'];
        }
        $pipeline = array_fill_keys(array_slice(self::STATUSES, 0, 12), []);
        foreach ($this->rows(DB::select("{$sql} ORDER BY op.estimated_amount DESC", $bind)) as $row) {
            if (isset($pipeline[$row['status']])) {
                $pipeline[$row['status']][] = $row;
            }
        }

        return $this->ok($pipeline);
    }

    public function show(int $id): JsonResponse
    {
        $opp = $this->loadAccessible($id);
        if ($opp instanceof JsonResponse) {
            return $opp;
        }
        $row = (array) DB::selectOne('SELECT op.*, i.name AS institution_name, u.full_name AS assigned_to_name, uv.full_name AS validated_by_name FROM crm_opportunities op JOIN crm_institutions i ON op.institution_id = i.id LEFT JOIN users u ON op.assigned_to = u.id LEFT JOIN users uv ON op.validated_by = uv.id WHERE op.id = ?', [$id]);

        return $this->ok($row + [
            // due_at_utc est déjà renvoyé en ISO UTC, comme dans Node.
            'actions' => $this->rows(DB::select("SELECT act.*, DATE_FORMAT(act.due_at_utc,'%Y-%m-%dT%H:%i:%s.000Z') AS due_at_utc, u.full_name AS assigned_to_name FROM crm_opportunity_actions act LEFT JOIN users u ON act.assigned_to = u.id WHERE act.opportunity_id = ? ORDER BY act.due_date ASC, act.created_at ASC", [$id])),
            'history' => $this->rows(DB::select('SELECT hist.*, u.full_name AS performed_by_name FROM crm_opportunity_stage_histories hist JOIN users u ON hist.performed_by = u.id WHERE hist.opportunity_id = ? ORDER BY hist.performed_at DESC', [$id])),
            'comments' => $this->rows(DB::select('SELECT c.*, u.full_name AS user_name FROM crm_opportunity_comments c JOIN users u ON c.user_id = u.id WHERE c.opportunity_id = ? ORDER BY c.created_at DESC', [$id])),
            'linkedMissions' => $this->rows(DB::select('SELECT m.id, m.title, m.scheduled_date, m.status, u.full_name AS commercial_name FROM crm_opportunity_mission_links l JOIN crm_missions m ON l.mission_id = m.id JOIN users u ON m.primary_commercial_id = u.id WHERE l.opportunity_id = ?', [$id])),
            'attachments' => $this->rows(DB::select('SELECT id, file_name, file_size, created_at FROM crm_opportunity_attachments WHERE opportunity_id = ? ORDER BY created_at DESC', [$id])),
        ]);
    }

    private function invalid(array $b, ?string $priority): bool
    {
        $amount = $b['estimated_amount'] ?? null;

        return ! Input::nonEmptyString($b['title'] ?? null, 150) || ! is_string($b['need_description'] ?? null) || trim($b['need_description']) === ''
            || ! is_numeric($amount) || $amount <= 0 || ($priority !== null && ! in_array($priority, ['LOW', 'MEDIUM', 'HIGH'], true));
    }

    public function store(Request $request): JsonResponse
    {
        $b = $this->body($request);
        if (! Input::num($b['institution_id'] ?? null) || $this->invalid($b, ($b['priority'] ?? null) ?: null)) {
            return $this->err(400, "Données d'opportunité invalides.");
        }
        if (! FeatureAccess::canLinkRecord($this->user(), 'missions', $b['mission_id'] ?? null)) {
            return $this->err(403, 'Mission inaccessible.');
        }
        $u = $this->user();
        $assigned = $this->isManager() ? (Input::positiveId($b['assigned_to'] ?? null)) : $u['id'];

        return DB::transaction(function () use ($b, $u, $assigned) {
            // Correctif : code aléatoire cryptographique (Node utilisait Math.random).
            $code = 'OP-'.strtoupper(Str::random(6));
            DB::insert("INSERT INTO crm_opportunities (code, institution_id, title, need_description, estimated_amount, priority, assigned_to, status, pipeline_stage) VALUES (?, ?, ?, ?, ?, ?, ?, 'DETECTED', 'DETECTION')", [
                $code, $b['institution_id'], trim($b['title']), trim($b['need_description']), (float) $b['estimated_amount'], ($b['priority'] ?? null) ?: 'MEDIUM', $assigned,
            ]);
            $id = (int) DB::getPdo()->lastInsertId();
            if ($mid = Input::positiveId($b['mission_id'] ?? null)) {
                DB::insert("INSERT INTO crm_opportunity_mission_links (opportunity_id, mission_id, link_type) VALUES (?, ?, 'source')", [$id, $mid]);
            }
            Flow::logHistory($id, null, 'DETECTED', 'Créer opportunité', "Détection initiale de l'opportunité commerciale.", $u['id']);
            if ($u['role'] === 'COMMERCIAL') {
                Notifier::notifyDirection('Nouvelle Opportunité détectée', "{$u['full_name']} a détecté l'opportunité : \"".trim($b['title'])."\" ({$b['estimated_amount']} FCFA).", 'OPPORTUNITY_CREATED', $id);
            }

            return $this->ok(['id' => $id, 'code' => $code, 'message' => 'Opportunité créée.'], 201);
        });
    }

    public function update(Request $request, int $id): JsonResponse
    {
        $opp = $this->loadAccessible($id);
        if ($opp instanceof JsonResponse) {
            return $opp;
        }
        $b = $this->body($request);
        $priority = ($b['priority'] ?? null) ?: ($opp['priority'] ?: 'MEDIUM');
        if ($this->invalid($b, $priority)) {
            return $this->err(400, "Données d'opportunité invalides.");
        }
        if ($this->user()['role'] === 'COMMERCIAL' && ! in_array($opp['status'], ['DETECTED', 'TO_CORRECT'], true)) {
            return $this->err(400, 'Vous ne pouvez pas modifier une opportunité déjà soumise ou validée.');
        }
        $assigned = $this->isManager() ? Input::positiveId($b['assigned_to'] ?? null) : $opp['assigned_to'];
        DB::update('UPDATE crm_opportunities SET title = ?, need_description = ?, estimated_amount = ?, priority = ?, assigned_to = ? WHERE id = ?', [trim($b['title']), trim($b['need_description']), (float) $b['estimated_amount'], $priority, $assigned, $id]);

        return $this->ok(['message' => 'Opportunité mise à jour.']);
    }

    public function destroy(int $id): JsonResponse
    {
        if (! $this->isManager()) {
            return $this->err(403, 'Accès refusé.');
        }
        if (! Flow::get($id)) {
            return $this->err(404, 'Opportunité introuvable.');
        }
        DB::delete('DELETE FROM crm_opportunities WHERE id = ?', [$id]);

        return $this->ok(['message' => 'Opportunité supprimée.']);
    }

    /** Point d'entrée unique pour les transitions du pipeline. */
    public function transition(Request $request, int $id, string $transition): JsonResponse
    {
        $b = $this->body($request);
        $u = $this->user();
        $result = match ($transition) {
            'submit' => Flow::submit($id, $u),
            'validate' => Flow::validate($id, $u),
            'request-correction' => Flow::requestCorrection($id, $u, $b['comment'] ?? null),
            'reject' => Flow::reject($id, $u, $b['comment'] ?? null),
            'start-analysis' => Flow::startAnalysis($id, $u),
            'create-action-plan' => Flow::createActionPlan($id, $u, $b['actions'] ?? null),
            'move-to-proposal' => Flow::moveToProposal($id, $u, $b),
            'move-to-negotiation' => Flow::moveToNegotiation($id, $u, $b),
            'move-to-decision' => Flow::moveToDecision($id, $u, $b),
            'mark-as-won' => Flow::markAsWon($id, $u, $b),
            'mark-as-lost' => Flow::markAsLost($id, $u, $b),
            'archive' => Flow::archive($id, $u),
            'follow-up-mission' => Flow::createFollowUpMission($id, $u, $b),
        };

        return $this->ok($result);
    }

    public function comment(Request $request, int $id): JsonResponse
    {
        $c = $this->body($request)['comment'] ?? null;
        if (! is_string($c) || trim($c) === '') {
            return $this->err(400, 'Commentaire vide.');
        }
        $opp = $this->loadAccessible($id);
        if ($opp instanceof JsonResponse) {
            return $opp;
        }
        DB::insert('INSERT INTO crm_opportunity_comments (opportunity_id, user_id, comment) VALUES (?, ?, ?)', [$id, $this->user()['id'], trim($c)]);

        return $this->ok(['id' => (int) DB::getPdo()->lastInsertId(), 'message' => 'Commentaire ajouté.'], 201);
    }

    public function updateAction(Request $request, int $id, int $actionId): JsonResponse
    {
        $b = $this->body($request);
        $status = $b['status'] ?? null;
        if (array_key_exists('status', $b) && ! in_array($status, ['PENDING', 'COMPLETED', 'CANCELLED'], true)) {
            return $this->err(400, "Statut d'action invalide.");
        }
        $opp = $this->loadAccessible($id);
        if ($opp instanceof JsonResponse) {
            return $opp;
        }
        DB::transaction(function () use ($b, $id, $actionId, $status) {
            $a = DB::selectOne("SELECT *,DATE_FORMAT(due_at_utc,'%Y-%m-%d %H:%i:%s') deadline FROM crm_opportunity_actions WHERE id=? AND opportunity_id=? FOR UPDATE", [$actionId, $id])
                ?? throw ApiException::make(404, 'Action introuvable.');
            $deadline = array_key_exists('due_at_cameroon', $b) ? CameroonTime::parseDeadline($b['due_at_cameroon']) : $a->deadline;
            $changed = $deadline !== $a->deadline;
            if ($changed) {
                DB::update('UPDATE crm_opportunity_actions SET due_at_utc=?,due_date=? WHERE id=?', [$deadline, substr($b['due_at_cameroon'], 0, 10), $a->id]);
            }
            if (array_key_exists('status', $b)) {
                DB::update("UPDATE crm_opportunity_actions SET status=?,completed_at=IF(?='COMPLETED',CURRENT_TIMESTAMP,NULL) WHERE id=?", [$status, $status, $a->id]);
            }
            if ($changed || (array_key_exists('status', $b) && $status !== $a->status)) {
                FollowupReminders::planActionReminders((int) $a->id);
            }
        });

        return $this->ok(['message' => 'Action mise à jour.']);
    }

    public function attach(Request $request, int $id): JsonResponse
    {
        $opp = $this->loadAccessible($id);
        if ($opp instanceof JsonResponse) {
            return $opp;
        }
        if (! $request->hasFile('files')) {
            return $this->err(400, 'Aucun fichier fourni.');
        }
        $stored = Uploads::storeAll($request, 'opportunities');
        try {
            foreach ($stored as $s) {
                DB::insert('INSERT INTO crm_opportunity_attachments (opportunity_id, file_name, file_path, file_size) VALUES (?, ?, ?, ?)', [$id, $s['file_name'], $s['file_path'], $s['file_size']]);
            }
        } catch (\Throwable $e) {
            Uploads::cleanup($stored);
            throw $e;
        }

        return $this->ok(['message' => count($stored).' fichier(s) ajouté(s).'], 201);
    }

    public function download(int $id, int $attId)
    {
        $opp = $this->loadAccessible($id);
        if ($opp instanceof JsonResponse) {
            return $opp;
        }
        $row = DB::selectOne('SELECT file_name, file_path FROM crm_opportunity_attachments WHERE id = ? AND opportunity_id = ?', [$attId, $id]);

        return ($row ? Uploads::download($row->file_path, $row->file_name) : null) ?? $this->err(404, 'Pièce jointe introuvable.');
    }

    public function deleteAttachment(int $id, int $attId): JsonResponse
    {
        $opp = $this->loadAccessible($id);
        if ($opp instanceof JsonResponse) {
            return $opp;
        }
        $row = DB::selectOne('SELECT file_path FROM crm_opportunity_attachments WHERE id = ? AND opportunity_id = ?', [$attId, $id]);
        if (! $row) {
            return $this->err(404, 'Pièce jointe introuvable.');
        }
        Uploads::delete($row->file_path);
        DB::delete('DELETE FROM crm_opportunity_attachments WHERE id = ? AND opportunity_id = ?', [$attId, $id]);

        return $this->ok(['message' => 'Pièce jointe supprimée.']);
    }
}
