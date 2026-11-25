<?php

namespace App\Services;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/** Reprise de utils/notifications.js. */
class Notifier
{
    public static function notifyDirection(string $title, string $message, string $type, ?int $targetId = null): void
    {
        try {
            $users = DB::select("SELECT id FROM users WHERE role IN ('DIRECTION', 'ADMIN') AND is_active = TRUE");
            foreach ($users as $u) {
                self::notifyUser((int) $u->id, $title, $message, $type, $targetId);
            }
        } catch (\Throwable $e) {
            if (DB::transactionLevel() > 0) {
                throw $e;
            }
            Log::error('[NOTIF_ERROR] '.$e->getMessage());
        }
    }

    public static function notifyUser(int $userId, string $title, string $message, string $type, ?int $targetId = null): ?int
    {
        try {
            DB::insert('INSERT INTO crm_notifications (user_id, title, message, type, target_id) VALUES (?, ?, ?, ?, ?)', [
                $userId, mb_substr($title, 0, 100), $message, $type, $targetId,
            ]);
            $id = (int) DB::getPdo()->lastInsertId();
            // Les notifications d'objectifs et de relances partent aussi par e-mail / push.
            if (str_starts_with($type, 'OBJECTIVE_') || $type === 'FOLLOWUP_REMINDER') {
                DB::insert("INSERT INTO notification_deliveries (notification_id, channel) VALUES (?, 'email'), (?, 'push')", [$id, $id]);
            }

            return $id;
        } catch (\Throwable $e) {
            if (DB::transactionLevel() > 0) {
                throw $e;
            }
            Log::error('[NOTIF_USER_ERROR] '.$e->getMessage());

            return null;
        }
    }
}
