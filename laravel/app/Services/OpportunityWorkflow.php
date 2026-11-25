<?php

namespace App\Services;

use App\Exceptions\ApiException;
use Illuminate\Support\Facades\DB;

/**
 * Reprise de services/OpportunityWorkflowService.js.
 * Chaque transition : transaction + verrou FOR UPDATE + historique.
 * Correctifs : statuts HTTP 403/404/409 corrects, contrôle de l'état
 * avant « perdue »/« archivée », validation de la mission de suivi.
 */
class OpportunityWorkflow
{
    public static function get(int $id, bool $lock = false): ?array
    {
        $row = DB::selectOne('SELECT * FROM crm_opportunities WHERE id = ?'.($lock ? ' FOR UPDATE' : ''), [$id]);

        return $row ? (array) $row : null;
    }

    public static function canAccess(array $opp, array $user): bool
    {
        return FeatureAccess::isManager($user) || (int) $opp['assigned_to'] === $user['id'];
    }

    public static function logHistory(int $id, ?string $old, string $new, string $action, ?string $comment, int $userId): void
    {
        DB::insert('INSERT INTO crm_opportunity_stage_histories (opportunity_id, old_status, new_status, action, comment, performed_by) VALUES (?, ?, ?, ?, ?, ?)', [$id, $old, $new, $action, $comment ?: null, $userId]);
    }

    /** Ouvre une transaction, verrouille l'opportunité et vérifie l'accès. */
    private static function run(int $id, array $user, bool $managerOnly, callable $fn): array
    {
        if ($managerOnly && ! FeatureAccess::isManager($user)) {
            throw ApiException::make(403, 'Accès refusé. Rôle responsable requis.');
        }

        return DB::transaction(function () use ($id, $user, $fn) {
            $opp = self::get($id, true) ?? throw ApiException::make(404, 'Opportunité introuvable.');
            if (! self::canAccess($opp, $user)) {
                throw ApiException::make(403, 'Accès refusé.');
            }

            return $fn($opp);
        });
    }

    private static function requireStatus(array $opp, array $allowed, string $what): void
    {
        if (! in_array($opp['status'], $allowed, true)) {
            throw ApiException::make(409, "Transition impossible : statut actuel '{$opp['status']}' ne permet pas {$what}.");
        }
    }

    private static function move(array $opp, string $status, ?string $stage, string $action, ?string $comment, int $userId, array $extra = []): void
    {
        $sets = ['status = ?'];
        $bind = [$status];
        if ($stage) {
            $sets[] = 'pipeline_stage = ?';
            $bind[] = $stage;
        }
        foreach ($extra as $col => $val) {
            $sets[] = $val === 'NOW()' ? "{$col} = CURRENT_TIMESTAMP" : "{$col} = ?";
            if ($val !== 'NOW()') {
                $bind[] = $val;
            }
        }
        DB::update('UPDATE crm_opportunities SET '.implode(', ', $sets).' WHERE id = ?', [...$bind, $opp['id']]);
        self::logHistory((int) $opp['id'], $opp['status'], $status, $action, $comment, $userId);
    }

    private static function comment(mixed $c, string $message): string
    {
        if (! is_string($c) || trim($c) === '') {
            throw ApiException::make(400, $message);
        }

        return trim($c);
    }

    public static function submit(int $id, array $user): array
    {
        return self::run($id, $user, false, function ($o) use ($user) {
            self::requireStatus($o, ['DETECTED', 'TO_CORRECT'], 'la soumission');
            if (! $o['institution_id'] || trim((string) $o['title']) === '' || trim((string) $o['need_description']) === '' || ! $o['priority']) {
                throw ApiException::make(400, 'Champs requis manquants pour la soumission (institution, titre, besoin identifié, priorité).');
            }
            self::move($o, 'SUBMITTED', 'QUALIFICATION', 'Soumettre au responsable', null, $user['id']);
            Notifier::notifyDirection('Opportunité Soumise', "L'opportunité \"{$o['title']}\" a été soumise par {$user['full_name']} pour validation.", 'OPPORTUNITY_SUBMITTED', (int) $o['id']);

            return ['message' => 'Opportunité soumise pour validation.', 'newStatus' => 'SUBMITTED'];
        });
    }

    public static function requestCorrection(int $id, array $user, mixed $comment): array
    {
        $c = self::comment($comment, 'Un commentaire est obligatoire pour demander des corrections.');

        return self::run($id, $user, true, function ($o) use ($user, $c) {
            self::requireStatus($o, ['SUBMITTED'], 'de demander une correction');
            self::move($o, 'TO_CORRECT', 'DETECTION', 'Demander correction', $c, $user['id']);
            if ($o['assigned_to']) {
                Notifier::notifyUser((int) $o['assigned_to'], 'Correction demandée', "Des corrections ont été demandées sur l'opportunité \"{$o['title']}\" : \"{$c}\".", 'OPPORTUNITY_TO_CORRECT', (int) $o['id']);
            }

            return ['message' => 'Correction demandée.', 'newStatus' => 'TO_CORRECT'];
        });
    }

    public static function reject(int $id, array $user, mixed $comment): array
    {
        $c = self::comment($comment, 'Un commentaire est obligatoire pour rejeter une opportunité.');

        return self::run($id, $user, true, function ($o) use ($user, $c) {
            self::requireStatus($o, ['SUBMITTED'], 'le rejet');
            self::move($o, 'REJECTED', 'QUALIFICATION', 'Rejeter', $c, $user['id'], ['validated_by' => $user['id'], 'validated_at' => 'NOW()']);
            if ($o['assigned_to']) {
                Notifier::notifyUser((int) $o['assigned_to'], 'Opportunité rejetée', "L'opportunité \"{$o['title']}\" a été rejetée par le responsable. Motif : \"{$c}\".", 'OPPORTUNITY_REJECTED', (int) $o['id']);
            }

            return ['message' => 'Opportunité rejetée.', 'newStatus' => 'REJECTED'];
        });
    }

    public static function validate(int $id, array $user): array
    {
        return self::run($id, $user, true, function ($o) use ($user) {
            self::requireStatus($o, ['SUBMITTED'], 'la validation');
            self::move($o, 'VALIDATED', 'QUALIFICATION', 'Valider opportunité', null, $user['id'], ['validated_by' => $user['id'], 'validated_at' => 'NOW()']);
            if ($o['assigned_to']) {
                Notifier::notifyUser((int) $o['assigned_to'], 'Opportunité validée', "L'opportunité \"{$o['title']}\" a été validée. Elle est maintenant dans le pipeline.", 'OPPORTUNITY_VALIDATED', (int) $o['id']);
            }

            return ['message' => 'Opportunité validée.', 'newStatus' => 'VALIDATED'];
        });
    }

    public static function startAnalysis(int $id, array $user): array
    {
        return self::run($id, $user, false, function ($o) use ($user) {
            self::requireStatus($o, ['VALIDATED'], "de démarrer l'analyse");
            self::move($o, 'IN_ANALYSIS', 'ANALYSE', 'Démarrer analyse', null, $user['id']);

            return ['message' => 'Analyse démarrée.', 'newStatus' => 'IN_ANALYSIS'];
        });
    }

    public static function createActionPlan(int $id, array $user, mixed $actions): array
    {
        if (! is_array($actions) || ! $actions) {
            throw ApiException::make(400, "Le plan d'action doit contenir au moins une action.");
        }

        return self::run($id, $user, false, function ($o) use ($user, $actions) {
            self::requireStatus($o, ['VALIDATED', 'IN_ANALYSIS', 'ACTION_PLAN'], "de définir un plan d'action");
            DB::update("UPDATE crm_opportunities SET status = 'ACTION_PLAN', pipeline_stage = 'ANALYSE' WHERE id = ?", [$o['id']]);
            foreach ($actions as $a) {
                if (! is_array($a) || trim((string) ($a['title'] ?? '')) === '' || empty($a['action_type'])) {
                    throw ApiException::make(400, "Chaque action doit avoir un titre et un type d'action.");
                }
                $deadline = $a['action_type'] === 'relance' ? CameroonTime::parseDeadline($a['due_at_cameroon'] ?? null) : null;
                DB::insert("INSERT INTO crm_opportunity_actions (opportunity_id, title, description, action_type, assigned_to, due_date, due_at_utc, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)", [
                    $o['id'], trim($a['title']), ($a['description'] ?? null) ?: null, $a['action_type'], ($a['assigned_to'] ?? null) ?: ($o['assigned_to'] ?: $user['id']),
                    $deadline ? substr($a['due_at_cameroon'], 0, 10) : (($a['due_date'] ?? null) ?: null), $deadline, $user['id'],
                ]);
                FollowupReminders::planActionReminders((int) DB::getPdo()->lastInsertId());
            }
            self::logHistory((int) $o['id'], $o['status'], 'ACTION_PLAN', "Créer plan d'action", count($actions).' action(s) ajoutée(s).', $user['id']);

            return ['message' => "Plan d'action créé avec succès.", 'newStatus' => 'ACTION_PLAN'];
        });
    }

    public static function moveToProposal(int $id, array $user, array $data): array
    {
        return self::run($id, $user, false, function ($o) use ($user, $data) {
            self::requireStatus($o, ['ACTION_PLAN', 'IN_ANALYSIS'], 'de passer en proposition');
            $amount = ($data['final_amount'] ?? null) ?: $o['estimated_amount'];
            self::move($o, 'PROPOSAL', 'PROPOSITION', 'Préparer proposition', "Montant final proposé : {$amount} FCFA. Commentaire : ".(($data['comment'] ?? null) ?: 'N/A'), $user['id'], ['final_amount' => $amount]);

            return ['message' => 'Opportunité passée en proposition.', 'newStatus' => 'PROPOSAL'];
        });
    }

    public static function moveToNegotiation(int $id, array $user, array $data): array
    {
        return self::run($id, $user, false, function ($o) use ($user, $data) {
            self::requireStatus($o, ['PROPOSAL'], 'de passer en négociation');
            self::move($o, 'NEGOTIATION', 'NEGOCIATION', 'Passer en négociation', ($data['comment'] ?? null) ?: 'Discussion sur les termes et conditions.', $user['id']);

            return ['message' => 'Opportunité passée en négociation.', 'newStatus' => 'NEGOTIATION'];
        });
    }

    public static function moveToDecision(int $id, array $user, array $data): array
    {
        return self::run($id, $user, false, function ($o) use ($user, $data) {
            self::requireStatus($o, ['NEGOTIATION', 'PROPOSAL'], 'de passer en décision');
            self::move($o, 'DECISION', 'DECISION', 'Enregistrer décision', ($data['comment'] ?? null) ?: 'Phase de décision finale.', $user['id']);

            return ['message' => 'Opportunité passée en étape décision.', 'newStatus' => 'DECISION'];
        });
    }

    public static function markAsWon(int $id, array $user, array $data): array
    {
        return self::run($id, $user, true, function ($o) use ($user, $data) {
            self::requireStatus($o, ['DECISION', 'NEGOTIATION', 'PROPOSAL'], 'de clore comme gagnée');
            $amount = ($data['final_amount'] ?? null) ?: $o['estimated_amount'];
            self::move($o, 'WON', 'SIGNATURE', 'Marquer gagnée', ($data['comment'] ?? null) ?: 'Opportunité remportée avec succès !', $user['id'], ['final_amount' => $amount, 'decision_date' => 'NOW()']);
            Notifier::notifyDirection('Opportunité Gagnée 🎉', "L'opportunité \"{$o['title']}\" a été remportée ! Montant : {$amount} FCFA.", 'OPPORTUNITY_WON', (int) $o['id']);
            if ($o['assigned_to']) {
                Notifier::notifyUser((int) $o['assigned_to'], 'Opportunité Gagnée 🎉', "Félicitations, votre opportunité \"{$o['title']}\" a été marquée comme GAGNÉE !", 'OPPORTUNITY_WON', (int) $o['id']);
            }

            return ['message' => 'Opportunité marquée comme gagnée.', 'newStatus' => 'WON'];
        });
    }

    public static function markAsLost(int $id, array $user, array $data): array
    {
        $reason = self::comment($data['lost_reason'] ?? null, 'Le motif de la perte est obligatoire.');

        return self::run($id, $user, true, function ($o) use ($user, $data, $reason) {
            // Correctif : Node acceptait de « perdre » une opportunité déjà gagnée ou archivée.
            self::requireStatus($o, ['DETECTED', 'SUBMITTED', 'TO_CORRECT', 'VALIDATED', 'IN_ANALYSIS', 'ACTION_PLAN', 'PROPOSAL', 'NEGOTIATION', 'DECISION'], 'de la classer perdue');
            self::move($o, 'LOST', 'DECISION', 'Marquer perdue', "Motif : {$reason}. Commentaire : ".(($data['comment'] ?? null) ?: 'N/A'), $user['id'], ['lost_reason' => $reason, 'decision_date' => 'NOW()']);
            if ($o['assigned_to']) {
                Notifier::notifyUser((int) $o['assigned_to'], 'Opportunité Perdue', "L'opportunité \"{$o['title']}\" a été classée comme perdue. Motif : \"{$reason}\".", 'OPPORTUNITY_LOST', (int) $o['id']);
            }

            return ['message' => 'Opportunité marquée comme perdue.', 'newStatus' => 'LOST'];
        });
    }

    public static function archive(int $id, array $user): array
    {
        return self::run($id, $user, true, function ($o) use ($user) {
            if ($o['status'] === 'ARCHIVED') {
                throw ApiException::make(409, 'Opportunité déjà archivée.');
            }
            self::move($o, 'ARCHIVED', null, 'Archiver', "Archivage de l'opportunité pour historique.", $user['id'], ['archived_at' => 'NOW()']);

            return ['message' => 'Opportunité archivée.', 'newStatus' => 'ARCHIVED'];
        });
    }

    public static function createFollowUpMission(int $id, array $user, array $d): array
    {
        if (empty($d['objective_id']) || trim((string) ($d['title'] ?? '')) === '' || empty($d['scheduled_date']) || empty($d['primary_commercial_id'])) {
            throw ApiException::make(400, 'Champs de mission requis manquants.');
        }
        if (! FeatureAccess::canLinkRecord($user, 'objectives', $d['objective_id'])) {
            throw ApiException::make(403, 'Objectif inaccessible.');
        }
        // Correctif : un commercial ne peut affecter la mission qu'à lui-même.
        $commercialId = FeatureAccess::isManager($user) ? (int) $d['primary_commercial_id'] : $user['id'];

        return self::run($id, $user, false, function ($o) use ($user, $d, $commercialId) {
            // Correctif : la géographie vient de l'institution (Node retombait sur l'identifiant 1).
            $inst = DB::selectOne('SELECT region_id, department_id, city_id FROM crm_institutions WHERE id = ?', [$o['institution_id']]);
            $pick = fn ($k) => ((int) ($d[$k] ?? 0)) ?: (int) ($inst->{$k} ?? 0) ?: throw ApiException::make(422, "La localisation de l'institution est incomplète.");
            DB::insert("INSERT INTO crm_missions (objective_id, institution_id, title, description, scheduled_date, duration_hours, primary_commercial_id, region_id, department_id, city_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT')", [
                $d['objective_id'], $o['institution_id'], trim($d['title']), ($d['description'] ?? null) ?: null, $d['scheduled_date'], ($d['duration_hours'] ?? null) ?: 2, $commercialId,
                $pick('region_id'), $pick('department_id'), $pick('city_id'),
            ]);
            $missionId = (int) DB::getPdo()->lastInsertId();
            DB::insert("INSERT INTO crm_opportunity_mission_links (opportunity_id, mission_id, link_type) VALUES (?, ?, 'follow_up')", [$o['id'], $missionId]);
            self::logHistory((int) $o['id'], $o['status'], $o['status'], 'Créer mission de suivi', 'Mission de suivi créée : "'.trim($d['title'])."\" (ID: {$missionId})", $user['id']);
            Notifier::notifyUser($commercialId, 'Nouvelle mission de suivi', 'Vous avez été affecté à une mission de suivi terrain : "'.trim($d['title'])."\" liée à l'opportunité \"{$o['title']}\".", 'MISSION_ASSIGNED', $missionId);

            return ['message' => 'Mission de suivi créée et liée.', 'missionId' => $missionId];
        });
    }
}
