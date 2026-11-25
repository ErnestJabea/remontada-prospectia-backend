<?php

namespace App\Http\Controllers;

use App\Exceptions\ApiException;
use App\Services\FeatureAccess;
use App\Services\ReportPdf;
use App\Services\ReportWorkflow as Flow;
use App\Services\Uploads;
use App\Support\Input;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/** Reprise de routes/reports.js. */
class ReportController extends Controller
{
    private function loadAccessible(int $id): array|JsonResponse
    {
        $r = Flow::get($id);
        if (! $r) {
            return $this->err(404, 'Rapport introuvable.');
        }

        return Flow::canAccess($r, $this->user()) ? $r : $this->err(403, 'Acces refuse.');
    }

    public function index(Request $request): JsonResponse
    {
        $sql = 'SELECT rp.*, m.title AS mission_title, m.scheduled_date, o.title AS objective_title, i.name AS institution_name, u.full_name AS commercial_name
            FROM crm_reports rp LEFT JOIN crm_missions m ON rp.mission_id = m.id LEFT JOIN crm_objectives o ON rp.objective_id = o.id LEFT JOIN crm_institutions i ON rp.institution_id = i.id LEFT JOIN users u ON rp.commercial_id = u.id';
        $cond = [];
        $bind = [];
        $u = $this->user();
        if ($u['role'] === 'COMMERCIAL' || $u['restrictFeatureScope']) {
            $cond[] = '(rp.commercial_id = ? OR m.primary_commercial_id = ?)';
            array_push($bind, $u['id'], $u['id']);
        } elseif ($cid = $request->query('commercial_id')) {
            $cond[] = '(rp.commercial_id = ? OR m.primary_commercial_id = ?)';
            array_push($bind, (int) $cid, (int) $cid);
        }
        foreach (['status' => 'rp.status', 'report_type' => 'rp.report_type', 'institution_id' => 'rp.institution_id'] as $q => $col) {
            if ($v = $request->query($q)) {
                $cond[] = "{$col} = ?";
                $bind[] = $v;
            }
        }
        if ($cond) {
            $sql .= ' WHERE '.implode(' AND ', $cond);
        }

        return $this->ok($this->rows(DB::select("{$sql} ORDER BY rp.created_at DESC", $bind)));
    }

    public function show(int $id): JsonResponse
    {
        $r = $this->loadAccessible($id);
        if ($r instanceof JsonResponse) {
            return $r;
        }
        $row = (array) DB::selectOne('SELECT rp.*, m.title AS mission_title, m.scheduled_date, o.title AS objective_title, i.name AS institution_name, i.address AS institution_address, u.full_name AS commercial_name,
            submitted.full_name AS submitted_by_name, validated.full_name AS validated_by_name, rejected.full_name AS rejected_by_name, correction.full_name AS correction_requested_by_name, archived.full_name AS archived_by_name
            FROM crm_reports rp LEFT JOIN crm_missions m ON rp.mission_id = m.id LEFT JOIN crm_objectives o ON rp.objective_id = o.id LEFT JOIN crm_institutions i ON rp.institution_id = i.id
            LEFT JOIN users u ON rp.commercial_id = u.id LEFT JOIN users submitted ON rp.submitted_by = submitted.id LEFT JOIN users validated ON rp.validated_by = validated.id
            LEFT JOIN users rejected ON rp.rejected_by = rejected.id LEFT JOIN users correction ON rp.correction_requested_by = correction.id LEFT JOIN users archived ON rp.archived_by = archived.id WHERE rp.id = ?', [$id]);

        return $this->ok($row + [
            'attachments' => $this->rows(DB::select('SELECT id, file_name, file_size, created_at FROM crm_report_attachments WHERE report_id = ?', [$id])),
            'opportunities' => $this->rows(DB::select('SELECT o.*, ro.relation_type FROM crm_report_opportunities ro JOIN crm_opportunities o ON ro.opportunity_id = o.id WHERE ro.activity_report_id = ?', [$id])),
            'history' => $this->rows(DB::select('SELECT h.*, u.full_name AS performed_by_name FROM crm_report_histories h JOIN users u ON h.performed_by = u.id WHERE h.activity_report_id = ? ORDER BY h.performed_at ASC', [$id])),
            'comments' => $this->rows(DB::select('SELECT c.*, u.full_name AS user_name, u.avatar_url FROM crm_report_comments c JOIN users u ON c.user_id = u.id WHERE c.activity_report_id = ? ORDER BY c.created_at ASC', [$id])),
        ]);
    }

    public function store(Request $request): JsonResponse
    {
        $b = $this->body($request);
        $u = $this->user();
        if (! FeatureAccess::canLinkRecord($u, 'missions', $b['mission_id'] ?? null) || ! FeatureAccess::canLinkRecord($u, 'objectives', $b['objective_id'] ?? null)) {
            return $this->err(403, 'Mission ou objectif inaccessible.');
        }

        return DB::transaction(function () use ($b, $u) {
            $t = fn ($k) => trim((string) (is_scalar($b[$k] ?? null) ? $b[$k] : ''));
            DB::insert("INSERT INTO crm_reports (report_type, mission_id, objective_id, institution_id, commercial_id, period_start, period_end, status, executive_summary, results, diagnosis, difficulties,
                recommendations, next_steps, generated_from, generated_by) VALUES (?, ?, ?, ?, ?, ?, ?, 'A_COMPLETER', ?, ?, ?, ?, ?, ?, 'manual', ?)", [
                ($b['report_type'] ?? null) ?: 'activity_report', Input::positiveId($b['mission_id'] ?? null), Input::positiveId($b['objective_id'] ?? null), Input::positiveId($b['institution_id'] ?? null),
                $u['id'], ($b['period_start'] ?? null) ?: null, ($b['period_end'] ?? null) ?: null, $t('executive_summary'), $t('results'), $t('diagnosis'), $t('difficulties'), $t('recommendations'), $t('next_steps'), $u['id'],
            ]);
            $id = (int) DB::getPdo()->lastInsertId();
            $code = 'RAP-'.gmdate('Ymd').'-'.str_pad((string) $id, 4, '0', STR_PAD_LEFT);
            DB::update('UPDATE crm_reports SET code = ? WHERE id = ?', [$code, $id]);
            Flow::logHistory($id, null, 'A_COMPLETER', 'Création manuelle', 'Brouillon créé manuellement', $u['id']);

            return $this->ok(['id' => $id, 'code' => $code, 'message' => 'Rapport créé.'], 201);
        });
    }

    /** Création / liaison d'opportunités depuis un rapport (partagé avec la synchronisation PWA). */
    public static function syncOpportunities(int $reportId, array $opportunities, ?int $institutionId, array $user, bool $removeMissing): void
    {
        $existing = array_map('intval', array_column(DB::select('SELECT opportunity_id FROM crm_report_opportunities WHERE activity_report_id = ?', [$reportId]), 'opportunity_id'));
        $keep = [];
        foreach ($opportunities as $opp) {
            if (! is_array($opp)) {
                continue;
            }
            $oppId = $opp['id'] ?? null;
            if (! empty($opp['title']) && ! is_numeric($oppId)) {
                // Double validation au-delà de 50 M FCFA.
                $status = (float) ($opp['estimated_amount'] ?? 0) > 50000000 ? 'SUBMITTED' : 'DETECTED';
                $stage = in_array(strtoupper((string) ($opp['pipeline_stage'] ?? '')), ['DETECTION', 'QUALIFICATION', 'ANALYSE'], true) ? strtoupper($opp['pipeline_stage']) : 'DETECTION';
                DB::insert('INSERT INTO crm_opportunities (institution_id, title, need_description, estimated_amount, priority, status, pipeline_stage, assigned_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
                    $institutionId, mb_substr((string) $opp['title'], 0, 150), ($opp['need_description'] ?? null) ?: null, (float) ($opp['estimated_amount'] ?? 0),
                    in_array($opp['priority'] ?? null, ['LOW', 'MEDIUM', 'HIGH'], true) ? $opp['priority'] : 'MEDIUM', $status, $stage, $user['id'],
                ]);
                $oppId = (int) DB::getPdo()->lastInsertId();
            }
            $oppId = Input::positiveId($oppId);
            if (! $oppId) {
                continue;
            }
            // Correctif IDOR : on ne peut lier qu'une opportunité de son périmètre.
            if (! FeatureAccess::canLinkRecord($user, 'opportunities', $oppId)) {
                throw ApiException::make(403, 'Opportunité inaccessible.');
            }
            $keep[] = $oppId;
            DB::insert('INSERT INTO crm_report_opportunities (activity_report_id, opportunity_id, relation_type) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE relation_type = VALUES(relation_type)', [$reportId, $oppId, ($opp['relation_type'] ?? null) ?: 'PRIMARY']);
        }
        if ($removeMissing) {
            foreach (array_diff($existing, $keep) as $old) {
                DB::delete('DELETE FROM crm_report_opportunities WHERE activity_report_id = ? AND opportunity_id = ?', [$reportId, $old]);
            }
        }
    }

    public function update(Request $request, int $id): JsonResponse
    {
        $r = $this->loadAccessible($id);
        if ($r instanceof JsonResponse) {
            return $r;
        }
        if (! $this->isManager() && ! in_array($r['status'], Flow::EDITABLE, true)) {
            return $this->err(409, 'Modification impossible sur un rapport soumis ou validé.');
        }
        $b = $this->body($request);
        if (! FeatureAccess::canLinkRecord($this->user(), 'objectives', $b['objective_id'] ?? null)) {
            return $this->err(403, 'Objectif inaccessible.');
        }

        return DB::transaction(function () use ($b, $id, $r) {
            $t = fn ($k) => trim((string) (is_scalar($b[$k] ?? null) ? $b[$k] : ''));
            $institution = Input::positiveId($b['institution_id'] ?? null) ?? $r['institution_id'];
            $persons = $b['persons_met'] ?? '';
            DB::update("UPDATE crm_reports SET executive_summary = ?, results = ?, diagnosis = ?, difficulties = ?, recommendations = ?, next_steps = ?, institution_id = ?, objective_id = ?,
                period_start = ?, period_end = ?, persons_met = ?, status = CASE WHEN status = 'BROUILLON_AUTO' THEN 'A_COMPLETER' ELSE status END WHERE id = ?", [
                $t('executive_summary'), $t('results'), $t('diagnosis'), $t('difficulties'), $t('recommendations'), $t('next_steps'), $institution,
                Input::positiveId($b['objective_id'] ?? null) ?? $r['objective_id'], ($b['period_start'] ?? null) ?: $r['period_start'], ($b['period_end'] ?? null) ?: $r['period_end'],
                is_array($persons) ? json_encode($persons, JSON_UNESCAPED_UNICODE) : ((string) $persons), $id,
            ]);
            if (is_array($b['opportunities'] ?? null)) {
                self::syncOpportunities($id, $b['opportunities'], $institution ? (int) $institution : null, $this->user(), true);
            }

            return $this->ok(['message' => 'Rapport mis a jour avec ses liaisons opportunites.']);
        });
    }

    public function transition(Request $request, int $id, string $transition): JsonResponse
    {
        $comment = $this->body($request)['comment'] ?? null;
        $u = $this->user();
        $result = match ($transition) {
            'submit' => Flow::submit($id, $u),
            'request-correction' => Flow::requestCorrection($id, $u, $comment),
            'validate' => Flow::validate($id, $u),
            'reject' => Flow::reject($id, $u, $comment),
            'archive' => Flow::archive($id, $u),
        };
        if ($transition === 'validate') {
            try {
                ReportPdf::generate($id);
            } catch (\Throwable $e) {
                Log::error('[REPORTS/VALIDATE/PDF] '.$e->getMessage());
            }
        }

        return $this->ok($result);
    }

    public function downloadPdf(int $id)
    {
        $r = $this->loadAccessible($id);
        if ($r instanceof JsonResponse) {
            return $r;
        }
        $path = ReportPdf::path($r['pdf_path']) ?? ReportPdf::generate($id);

        return response()->download($path, 'rapport-'.($r['code'] ?: $id).'.pdf', ['Content-Type' => 'application/pdf']);
    }

    public function comment(Request $request, int $id): JsonResponse
    {
        $c = $this->body($request)['comment'] ?? null;
        if (! is_string($c) || trim($c) === '') {
            return $this->err(400, 'Commentaire vide.');
        }
        $r = $this->loadAccessible($id);
        if ($r instanceof JsonResponse) {
            return $r;
        }
        DB::insert('INSERT INTO crm_report_comments (activity_report_id, user_id, comment) VALUES (?, ?, ?)', [$id, $this->user()['id'], trim($c)]);

        return $this->ok(['message' => 'Commentaire ajoute.'], 201);
    }

    public function linkOpportunity(Request $request, int $id): JsonResponse
    {
        $b = $this->body($request);
        if (empty($b['opportunity_id']) || empty($b['relation_type'])) {
            return $this->err(400, 'Champs manquants.');
        }
        $r = $this->loadAccessible($id);
        if ($r instanceof JsonResponse) {
            return $r;
        }
        if (! FeatureAccess::canLinkRecord($this->user(), 'opportunities', $b['opportunity_id'])) {
            return $this->err(403, 'Opportunité inaccessible.');
        }
        DB::insert('INSERT INTO crm_report_opportunities (activity_report_id, opportunity_id, relation_type) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE relation_type = VALUES(relation_type)', [$id, (int) $b['opportunity_id'], $b['relation_type']]);

        return $this->ok(['message' => 'Opportunite liee avec succes.'], 201);
    }

    public function unlinkOpportunity(int $id, int $oppId): JsonResponse
    {
        $r = $this->loadAccessible($id);
        if ($r instanceof JsonResponse) {
            return $r;
        }
        DB::delete('DELETE FROM crm_report_opportunities WHERE activity_report_id = ? AND opportunity_id = ?', [$id, $oppId]);

        return $this->ok(['message' => 'Lien opportunite supprime.']);
    }

    public function attach(Request $request, int $id): JsonResponse
    {
        $r = $this->loadAccessible($id);
        if ($r instanceof JsonResponse) {
            return $r;
        }
        if (! $request->hasFile('files')) {
            return $this->err(400, 'Aucun fichier fourni.');
        }
        $stored = Uploads::storeAll($request, 'reports');
        try {
            foreach ($stored as $s) {
                DB::insert('INSERT INTO crm_report_attachments (report_id, file_name, file_path, file_size) VALUES (?, ?, ?, ?)', [$id, $s['file_name'], $s['file_path'], $s['file_size']]);
            }
        } catch (\Throwable $e) {
            Uploads::cleanup($stored);
            throw $e;
        }

        return $this->ok(['message' => count($stored).' fichier(s) ajoute(s).'], 201);
    }

    public function download(int $id, int $attId)
    {
        $r = $this->loadAccessible($id);
        if ($r instanceof JsonResponse) {
            return $r;
        }
        $row = DB::selectOne('SELECT file_name, file_path FROM crm_report_attachments WHERE id = ? AND report_id = ?', [$attId, $id]);

        return ($row ? Uploads::download($row->file_path, $row->file_name) : null) ?? $this->err(404, 'Piece jointe introuvable.');
    }

    public function deleteAttachment(int $id, int $attId): JsonResponse
    {
        $r = $this->loadAccessible($id);
        if ($r instanceof JsonResponse) {
            return $r;
        }
        $row = DB::selectOne('SELECT file_path FROM crm_report_attachments WHERE id = ? AND report_id = ?', [$attId, $id]);
        if (! $row) {
            return $this->err(404, 'Piece jointe introuvable.');
        }
        Uploads::delete($row->file_path);
        DB::delete('DELETE FROM crm_report_attachments WHERE id = ? AND report_id = ?', [$attId, $id]);

        return $this->ok(['message' => 'Piece jointe supprimee.']);
    }
}
