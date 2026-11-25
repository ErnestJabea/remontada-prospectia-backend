<?php

namespace App\Services;

use App\Support\Rows;
use Illuminate\Support\Facades\DB;
use Minishlink\WebPush\Subscription;
use Minishlink\WebPush\WebPush;

/** Reprise de utils/notificationDelivery.js (worker e-mail + Web Push avec retry exponentiel). */
class NotificationDelivery
{
    private const PUSH_HOSTS = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'push.services.mozilla.com', 'web.push.apple.com', 'wns.windows.com'];

    public static function pushConfigured(): bool
    {
        $v = config('remontada.vapid');

        return ! empty($v['public_key']) && ! empty($v['private_key']) && ! empty($v['subject']);
    }

    public static function validSubscription(mixed $s): bool
    {
        if (! is_array($s) || ! is_string($s['endpoint'] ?? null) || strlen($s['endpoint']) >= 2048) {
            return false;
        }
        $u = parse_url($s['endpoint']);
        if (($u['scheme'] ?? '') !== 'https' || isset($u['user']) || isset($u['pass']) || isset($u['port'])) {
            return false;
        }
        $host = $u['host'] ?? '';
        $hostOk = collect(self::PUSH_HOSTS)->contains(fn ($h) => $host === $h || str_ends_with($host, '.'.$h));

        return $hostOk && preg_match('/^[A-Za-z0-9_-]{87}$/', (string) ($s['keys']['p256dh'] ?? ''))
            && preg_match('/^[A-Za-z0-9_-]{22}$/', (string) ($s['keys']['auth'] ?? ''));
    }

    public static function deliverPending(): int
    {
        $rows = DB::select("SELECT id FROM notification_deliveries WHERE (status='pending' AND next_attempt_at<=NOW()) OR (status='processing' AND locked_until<NOW()) ORDER BY id LIMIT 20");
        $processed = 0;
        foreach ($rows as $row) {
            $claimed = DB::update("UPDATE notification_deliveries SET status='processing',locked_until=DATE_ADD(NOW(),INTERVAL 5 MINUTE),attempts=attempts+1
                WHERE id=? AND ((status='pending' AND next_attempt_at<=NOW()) OR (status='processing' AND locked_until<NOW()))", [$row->id]);
            if (! $claimed) {
                continue;
            }
            $processed++;
            try {
                $item = DB::selectOne('SELECT d.*,n.user_id,n.title,n.message,n.type,n.target_id,u.email,u.settings,u.is_active FROM notification_deliveries d JOIN crm_notifications n ON n.id=d.notification_id JOIN users u ON u.id=n.user_id WHERE d.id=?', [$row->id]);
                if (! $item) {
                    DB::update("UPDATE notification_deliveries SET status='skipped' WHERE id=?", [$row->id]);

                    continue;
                }
                $settings = Rows::decode($item->settings, []) ?: [];
                $skipped = ! $item->is_active;
                if ($item->type === 'FOLLOWUP_REMINDER' && ! FollowupReminders::reminderValid((int) $item->notification_id)) {
                    $skipped = true;
                }
                if (! $skipped && $item->channel === 'email') {
                    $skipped = ($settings['notifications']['email'] ?? null) === false || ! $item->email;
                    if (! $skipped) {
                        Mailer::sendNotification($item->email, $item->title, $item->message, (int) $item->notification_id);
                    }
                }
                if (! $skipped && $item->channel === 'push') {
                    $skipped = ($settings['notifications']['push'] ?? null) === false;
                    if (! $skipped) {
                        $skipped = ! self::push($item);
                    }
                }
                DB::update("UPDATE notification_deliveries SET status=?,sent_at=IF(?='sent',NOW(),NULL),locked_until=NULL,last_error=NULL WHERE id=?", [$skipped ? 'skipped' : 'sent', $skipped ? 'skipped' : 'sent', $row->id]);
            } catch (\Throwable $e) {
                // Jamais d'adresse, d'endpoint ou de charge utile fournisseur dans les journaux.
                DB::update("UPDATE notification_deliveries SET status=IF(attempts>=10,'failed','pending'),locked_until=NULL,
                    next_attempt_at=DATE_ADD(NOW(),INTERVAL LEAST(3600,POW(2,attempts)*15) SECOND),last_error=? WHERE id=?", [mb_substr($e->getMessage() ?: 'DELIVERY_FAILED', 0, 160), $row->id]);
            }
        }

        return $processed;
    }

    /** @return bool false si aucun abonnement (livraison ignorée) */
    private static function push(object $item): bool
    {
        $subs = DB::select('SELECT * FROM notification_push_subscriptions WHERE user_id=?', [$item->user_id]);
        if (! $subs) {
            return false;
        }
        if (! self::pushConfigured()) {
            throw new \RuntimeException('VAPID_NOT_CONFIGURED');
        }
        $v = config('remontada.vapid');
        $webPush = new WebPush(['VAPID' => ['subject' => $v['subject'], 'publicKey' => $v['public_key'], 'privateKey' => $v['private_key']]], ['TTL' => $item->type === 'FOLLOWUP_REMINDER' ? 3600 : 86400], 10);
        $payload = json_encode(['title' => $item->title, 'body' => $item->message, 'id' => (int) $item->notification_id, 'module' => $item->type === 'FOLLOWUP_REMINDER' ? 'opportunities' : 'objectives', 'targetId' => $item->target_id]);
        foreach ($subs as $saved) {
            $s = json_decode($saved->subscription, true);
            if (! self::validSubscription($s)) {
                throw new \RuntimeException('INVALID_PUSH_ENDPOINT');
            }
            $report = $webPush->sendOneNotification(Subscription::create($s), $payload);
            if (! $report->isSuccess()) {
                $code = $report->getResponse()?->getStatusCode();
                if (in_array($code, [404, 410], true)) {
                    DB::delete('DELETE FROM notification_push_subscriptions WHERE id=?', [$saved->id]);
                } else {
                    throw new \RuntimeException((string) ($code ?: 'PUSH_FAILED'));
                }
            }
        }

        return true;
    }
}
