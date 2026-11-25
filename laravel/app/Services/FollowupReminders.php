<?php

namespace App\Services;

use Illuminate\Support\Facades\DB;

/** Reprise de services/followupReminders.js : rappels 48/24/12/6 h avant une relance. */
class FollowupReminders
{
    private const HOURS = [48, 24, 12, 6];

    private const TERMINAL = ['WON', 'LOST', 'ARCHIVED', 'CLOSED', 'CANCELLED', 'REJECTED'];

    private static function actionDetails(int $id): ?object
    {
        return DB::selectOne("SELECT a.id,a.title,a.action_type,a.status,a.opportunity_id,
            DATE_FORMAT(a.due_at_utc,'%Y-%m-%d %H:%i:%s') AS due_at_utc,COALESCE(a.assigned_to,o.assigned_to) AS recipient_id,
            o.status AS opportunity_status,o.title AS opportunity_title,i.name AS institution_name,u.is_active
            FROM crm_opportunity_actions a JOIN crm_opportunities o ON o.id=a.opportunity_id
            JOIN crm_institutions i ON i.id=o.institution_id LEFT JOIN users u ON u.id=COALESCE(a.assigned_to,o.assigned_to)
            WHERE a.id=? FOR UPDATE", [$id]);
    }

    private static function active(?object $row): bool
    {
        return $row && $row->action_type === 'relance' && in_array($row->status, ['PENDING', 'IN_PROGRESS'], true)
            && ! in_array($row->opportunity_status, self::TERMINAL, true) && $row->due_at_utc && $row->recipient_id && $row->is_active;
    }

    public static function planActionReminders(int $actionId): void
    {
        $row = self::actionDetails($actionId);
        DB::update("UPDATE notification_deliveries d JOIN followup_reminders r ON r.notification_id=d.notification_id SET d.status='skipped',d.last_error='REMINDER_REPLANNED' WHERE r.action_id=? AND d.status='pending'", [$actionId]);
        DB::update("UPDATE followup_reminders SET status='cancelled' WHERE action_id=? AND status IN ('scheduled','queued')", [$actionId]);
        if (! self::active($row)) {
            return;
        }
        $now = gmdate('Y-m-d H:i:s');
        $due = strtotime($row->due_at_utc.' UTC');
        foreach (self::HOURS as $hours) {
            $at = gmdate('Y-m-d H:i:s', $due - $hours * 3600);
            DB::insert("INSERT INTO followup_reminders(action_id,recipient_id,due_at_utc,hours_before,scheduled_at_utc,status) VALUES(?,?,?,?,?,?)
                ON DUPLICATE KEY UPDATE status=IF(status='cancelled' AND notification_id IS NULL AND scheduled_at_utc>?, 'scheduled',status)",
                [$actionId, $row->recipient_id, $row->due_at_utc, $hours, $at, $at >= $now ? 'scheduled' : 'skipped', $now]);
        }
    }

    public static function reminderValid(int $notificationId): bool
    {
        $r = DB::selectOne("SELECT action_id,recipient_id,DATE_FORMAT(due_at_utc,'%Y-%m-%d %H:%i:%s') due_at_utc,status FROM followup_reminders WHERE notification_id=?", [$notificationId]);
        if (! $r || $r->status !== 'queued') {
            return false;
        }
        $a = self::actionDetails((int) $r->action_id);

        return self::active($a) && (int) $a->recipient_id === (int) $r->recipient_id && $a->due_at_utc === $r->due_at_utc && strtotime($r->due_at_utc.' UTC') > time();
    }

    public static function processReminders(): int
    {
        $now = gmdate('Y-m-d H:i:s');
        $rows = DB::select("SELECT id,action_id FROM followup_reminders WHERE status='scheduled' AND scheduled_at_utc<=? ORDER BY scheduled_at_utc LIMIT 100", [$now]);
        foreach ($rows as $entry) {
            DB::transaction(function () use ($entry, $now) {
                $a = self::actionDetails((int) $entry->action_id);
                $r = DB::selectOne("SELECT *,DATE_FORMAT(due_at_utc,'%Y-%m-%d %H:%i:%s') AS deadline FROM followup_reminders WHERE id=? FOR UPDATE", [$entry->id]);
                if ($r->status !== 'scheduled') {
                    return;
                }
                if (! self::active($a) || (int) $a->recipient_id !== (int) $r->recipient_id || $a->due_at_utc !== $r->deadline || $r->deadline <= $now) {
                    DB::update("UPDATE followup_reminders SET status='cancelled' WHERE id=?", [$r->id]);

                    return;
                }
                // Après une interruption : n'envoyer que le rappel éligible le plus récent.
                $newer = DB::selectOne("SELECT id FROM followup_reminders WHERE action_id=? AND recipient_id=? AND due_at_utc=? AND hours_before<? AND scheduled_at_utc<=? AND status IN ('scheduled','queued') LIMIT 1", [$a->id, $r->recipient_id, $r->deadline, $r->hours_before, $now]);
                if ($newer) {
                    DB::update("UPDATE followup_reminders SET status='skipped' WHERE id=?", [$r->id]);

                    return;
                }
                $message = "{$a->institution_name} : {$a->title}. Relance prévue le ".CameroonTime::formatDeadline($r->deadline)." (heure du Cameroun, UTC+1). Opportunité : {$a->opportunity_title}.";
                $nid = Notifier::notifyUser((int) $r->recipient_id, "Rappel de relance - {$r->hours_before} h avant", $message, 'FOLLOWUP_REMINDER', (int) $a->opportunity_id);
                DB::update("UPDATE followup_reminders SET status='queued',notification_id=? WHERE id=?", [$nid, $r->id]);
            });
        }

        return count($rows);
    }
}
