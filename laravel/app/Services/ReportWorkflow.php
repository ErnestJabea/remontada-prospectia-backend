<?php

namespace App\Services;

use App\Exceptions\ApiException;
use Illuminate\Support\Facades\DB;

/**
 * Reprise de services/reportWorkflow.js. Chaque transition s'exécute dans
 * une transaction avec verrou FOR UPDATE (équivalent de transactionalWorkflow).
 * Correctif : les erreurs renvoient désormais 403/404/409 au lieu d'un 400 générique.
 */
class ReportWorkflow
{
    public const EDITABLE = ['BROUILLON_AUTO', 'A_COMPLETER', 'CORRECTION_DEMANDEE', 'DRAFT', 'REJECTED', 'REJETE'];

    public static function get(int $id, bool $lock = false): ?array
    {
        $row = DB::selectOne('SELECT rp.*, m.title AS mission_title, m.primary_commercial_id FROM crm_reports rp LEFT JOIN crm_missions m ON rp.mission_id = m.id WHERE rp.id = ?'.($lock ? ' FOR UPDATE' : ''), [$id]);

        return $row ? (array) $row : null;
    }

    public static function canAccess(array $report, array $user): bool
    {
        return FeatureAccess::isManager($user) || (int) $report['commercial_id'] === $user['id'] || (int) $report['primary_commercial_id'] === $user['id'];
    }

    public static function logHistory(int $id, ?string $old, string $new, string $action, ?string $comment, int $userId): void
    {
        DB::insert('INSERT INTO crm_report_histories (activity_report_id, old_status, new_status, action, comment, performed_by) VALUES (?, ?, ?, ?, ?, ?)', [$id, $old, $new, $action, $comment ?: null, $userId]);
    }

    private static function locked(int $id): array
    {
        $r = self::get($id, true);
        if (! $r) {
            throw ApiException::make(404, 'Rapport introuvable.');
        }

        return $r;
    }

    private static function manager(array $user): void
    {
        if (! FeatureAccess::isManager($user)) {
            throw ApiException::make(403, 'Accès refusé. Rôle responsable requis.');
        }
    }

    private static function code(int $id): string
    {
        return 'RAP-'.gmdate('Ymd').'-'.str_pad((string) $id, 4, '0', STR_PAD_LEFT);
    }

    public static function generateFromMission(int $missionId, int $userId): array
    {
        return DB::transaction(function () use ($missionId, $userId) {
            $m = DB::selectOne('SELECT * FROM crm_missions WHERE id = ? FOR UPDATE', [$missionId]);
            if (! $m) {
                throw ApiException::make(404, 'Mission introuvable.');
            }
            if ($existing = DB::selectOne('SELECT id, status FROM crm_reports WHERE mission_id = ?', [$missionId])) {
                return ['id' => $existing->id, 'status' => $existing->status, 'message' => 'Le rapport existe déjà.'];
            }
            DB::insert("INSERT INTO crm_reports (mission_id, objective_id, institution_id, commercial_id, report_type, status, executive_summary, administrations_visited, persons_met, generated_from, generated_by)
                VALUES (?, ?, ?, ?, 'mission_report', 'BROUILLON_AUTO', '', '', '', 'system', ?)", [$missionId, $m->objective_id, $m->institution_id, $m->primary_commercial_id, $userId]);
            $id = (int) DB::getPdo()->lastInsertId();
            $code = self::code($id);
            DB::update('UPDATE crm_reports SET code = ? WHERE id = ?', [$code, $id]);
            self::logHistory($id, null, 'BROUILLON_AUTO', 'Génération automatique', 'Rapport généré après complétion de la mission', $userId);

            return ['id' => $id, 'code' => $code, 'status' => 'BROUILLON_AUTO', 'message' => 'Rapport brouillon généré.'];
        });
    }

    public static function submit(int $id, array $user): array
    {
        return DB::transaction(function () use ($id, $user) {
            $r = self::locked($id);
            if (! self::canAccess($r, $user)) {
                throw ApiException::make(403, 'Accès refusé.');
            }
            if (! in_array($r['status'], self::EDITABLE, true)) {
                throw ApiException::make(409, "Transition impossible : statut actuel '{$r['status']}' ne permet pas la soumission.");
            }
            if (trim((string) $r['executive_summary']) === '') {
                throw ApiException::make(400, 'Le résumé exécutif est obligatoire avant la soumission.');
            }
            if (trim((string) $r['results']) === '') {
                throw ApiException::make(400, 'Les résultats obtenus sont obligatoires avant la soumission.');
            }
            if (! $r['institution_id']) {
                throw ApiException::make(400, "L'institution concernée est obligatoire avant la soumission.");
            }
            DB::update("UPDATE crm_reports SET status = 'SOUMIS', submitted_by = ?, submitted_at = NOW() WHERE id = ?", [$user['id'], $id]);
            self::logHistory($id, $r['status'], 'SOUMIS', 'Soumettre au responsable', null, $user['id']);
            Notifier::notifyDirection('Rapport Soumis', "Le rapport d'activité \"".($r['code'] ?: $id)."\" a été soumis par {$user['full_name']} pour validation.", 'REPORT_SUBMITTED', $id);

            return ['message' => 'Rapport soumis pour validation.', 'newStatus' => 'SOUMIS'];
        });
    }

    private static function decide(int $id, array $user, string $newStatus, string $set, array $bind, string $action, ?string $comment, ?array $notify): array
    {
        return DB::transaction(function () use ($id, $user, $newStatus, $set, $bind, $action, $comment, $notify) {
            $r = self::locked($id);
            if (! in_array($r['status'], ['SOUMIS', 'SUBMITTED'], true)) {
                throw ApiException::make(409, "Transition impossible : statut actuel '{$r['status']}' ne permet pas cette décision.");
            }
            DB::update("UPDATE crm_reports SET status = ?, {$set} WHERE id = ?", [$newStatus, ...$bind, $id]);
            self::logHistory($id, $r['status'], $newStatus, $action, $comment, $user['id']);
            if ($newStatus === 'VALIDE' && $r['mission_id']) {
                DB::update("UPDATE crm_missions SET status = 'CLOSED', closed_at = NOW() WHERE id = ?", [$r['mission_id']]);
            }
            $target = $r['commercial_id'] ?: $r['primary_commercial_id'];
            if ($target && $notify) {
                Notifier::notifyUser((int) $target, $notify[0], str_replace('{code}', (string) ($r['code'] ?: $id), $notify[1]), $notify[2], $id);
            }

            return $r;
        });
    }

    public static function requestCorrection(int $id, array $user, mixed $comment): array
    {
        self::manager($user);
        if (! is_string($comment) || trim($comment) === '') {
            throw ApiException::make(400, 'Un commentaire est obligatoire pour demander des corrections.');
        }
        self::decide($id, $user, 'CORRECTION_DEMANDEE', 'correction_requested_by = ?, correction_requested_at = NOW(), correction_comment = ?', [$user['id'], trim($comment)], 'Demander des corrections', $comment,
            ['Correction demandée sur votre rapport', "Des corrections ont été demandées sur le rapport \"{code}\". Commentaire: {$comment}", 'REPORT_CORRECTION_REQUESTED']);

        return ['message' => 'Demande de correction enregistrée.', 'newStatus' => 'CORRECTION_DEMANDEE'];
    }

    public static function validate(int $id, array $user): array
    {
        self::manager($user);
        self::decide($id, $user, 'VALIDE', 'validated_by = ?, validated_at = NOW()', [$user['id']], 'Valider le rapport', null,
            ['Rapport validé', "Félicitations, votre rapport \"{code}\" a été validé par {$user['full_name']}.", 'REPORT_VALIDATED']);

        return ['message' => 'Rapport validé avec succès (mission clôturée).', 'newStatus' => 'VALIDE'];
    }

    public static function reject(int $id, array $user, mixed $comment): array
    {
        self::manager($user);
        if (! is_string($comment) || trim($comment) === '') {
            throw ApiException::make(400, 'Le motif de rejet est obligatoire.');
        }
        self::decide($id, $user, 'REJETE', 'rejected_by = ?, rejected_at = NOW(), rejection_reason = ?', [$user['id'], trim($comment)], 'Rejeter le rapport', $comment,
            ['Rapport rejeté', "Votre rapport \"{code}\" a été rejeté. Motif : {$comment}", 'REPORT_REJECTED']);

        return ['message' => 'Rapport marqué comme rejeté.', 'newStatus' => 'REJETE'];
    }

    public static function archive(int $id, array $user): array
    {
        self::manager($user);

        return DB::transaction(function () use ($id, $user) {
            $r = self::locked($id);
            if ($r['status'] !== 'VALIDE') {
                throw ApiException::make(409, "Transition impossible : seul un rapport validé peut être archivé (actuel: '{$r['status']}').");
            }
            DB::update("UPDATE crm_reports SET status = 'ARCHIVE', archived_by = ?, archived_at = NOW() WHERE id = ?", [$user['id'], $id]);
            self::logHistory($id, 'VALIDE', 'ARCHIVE', 'Archiver le rapport', null, $user['id']);

            return ['message' => 'Rapport archivé avec succès.', 'newStatus' => 'ARCHIVE'];
        });
    }
}
