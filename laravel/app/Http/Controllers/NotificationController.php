<?php

namespace App\Http\Controllers;

use App\Exceptions\ApiException;
use App\Services\FeatureAccess;
use App\Services\NotificationDelivery;
use App\Support\Rows;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Symfony\Component\HttpFoundation\StreamedResponse;

/** Reprise de routes/notifications.js (Web Push + flux SSE). */
class NotificationController extends Controller
{
    public function pushKey(): JsonResponse
    {
        return $this->ok(['publicKey' => NotificationDelivery::pushConfigured() ? config('remontada.vapid.public_key') : null]);
    }

    public function subscribe(Request $request): JsonResponse
    {
        if (! NotificationDelivery::pushConfigured()) {
            return $this->err(503, 'Le service push n’est pas configuré.');
        }
        $sub = $this->body($request);
        if (! NotificationDelivery::validSubscription($sub)) {
            return $this->err(400, 'Abonnement push invalide.');
        }
        $hash = hash('sha256', $sub['endpoint']);
        $count = DB::selectOne('SELECT COUNT(*) n FROM notification_push_subscriptions WHERE user_id=? AND endpoint_hash<>?', [$this->user()['id'], $hash])->n;
        if ($count >= 10) {
            return $this->err(409, 'La limite de dix appareils abonnés est atteinte.');
        }
        DB::insert('INSERT INTO notification_push_subscriptions(user_id,endpoint_hash,subscription) VALUES(?,?,?) ON DUPLICATE KEY UPDATE user_id=VALUES(user_id),subscription=VALUES(subscription)', [$this->user()['id'], $hash, json_encode($sub)]);

        return $this->ok(['success' => true]);
    }

    public function unsubscribe(Request $request): JsonResponse
    {
        $endpoint = $this->body($request)['endpoint'] ?? null;
        if (! is_string($endpoint)) {
            return $this->err(400, 'Abonnement requis.');
        }
        DB::delete('DELETE FROM notification_push_subscriptions WHERE user_id=? AND endpoint_hash=?', [$this->user()['id'], hash('sha256', $endpoint)]);

        return $this->ok(['success' => true]);
    }

    /**
     * Instantané des notifications et de la version des objectifs visibles.
     * Renvoie null si la session n'est plus valable (compte, rôle, révocation, expiration).
     */
    private function streamPayload(array &$authUser): ?string
    {
        $user = DB::selectOne('SELECT is_active,auth_version,job_description_id,role FROM users WHERE id=?', [$authUser['id']]);
        $revoked = DB::selectOne('SELECT token_hash FROM revoked_access_tokens WHERE token_hash=? AND expires_at>NOW()', [$authUser['token_hash']]);
        if (! $user || ! $user->is_active || $user->role !== $authUser['role'] || (int) $user->auth_version !== (int) ($authUser['authVersion'] ?? 0)
            || $user->job_description_id != $authUser['job_description_id'] || $revoked || time() >= ($authUser['exp'] ?? 0)) {
            return null;
        }
        if ($user->job_description_id && $authUser['role'] !== 'SYSTEM') {
            $authUser['jobPermissions'] = Rows::arr(DB::select('SELECT * FROM job_feature_permissions WHERE job_description_id=?', [$user->job_description_id]));
        }
        $notifications = Rows::normalize(Rows::arr(DB::select('SELECT * FROM crm_notifications WHERE user_id=? ORDER BY id DESC LIMIT 50', [$authUser['id']])));
        $objectiveVersion = '';
        try {
            FeatureAccess::assertFeature($authUser, 'objectives');
            $restricted = FeatureAccess::scopeRestricted($authUser, 'objectives');
            $objectives = DB::select('SELECT o.id,o.status,o.updated_at FROM crm_objectives o '.($restricted ? "WHERE o.created_by=? OR o.responsible_id=? OR EXISTS (SELECT 1 FROM objectif_affectations a WHERE a.objective_id=o.id AND a.type='COMMERCIAL' AND a.target_id=?)" : '').' ORDER BY o.id', $restricted ? array_fill(0, 3, $authUser['id']) : []);
            $objectiveVersion = hash('sha256', json_encode($objectives));
        } catch (ApiException) {
        }

        return json_encode(['notifications' => $notifications, 'objectiveVersion' => $objectiveVersion], JSON_UNESCAPED_UNICODE);
    }

    /**
     * Flux de notifications, deux modes (NOTIFICATIONS_STREAM_MODE) :
     *  - « snapshot » (défaut, recommandé sur cPanel) : un seul événement puis
     *    fermeture immédiate. Le client se reconnecte de lui-même : on obtient
     *    une interrogation périodique qui n'occupe un processus PHP que quelques
     *    millisecondes, au lieu de saturer les « entry processes » de l'hébergement.
     *    Le champ « retry » indique au client le délai souhaité.
     *  - « long » : connexion maintenue 55 s, interrogation toutes les 3 s
     *    (serveur dédié / VPS uniquement).
     */
    public function stream(): StreamedResponse
    {
        $authUser = $this->user();
        $mode = config('remontada.notifications.stream_mode');
        $retry = (int) config('remontada.notifications.retry_ms');

        return response()->stream(function () use ($authUser, $mode, $retry) {
            echo "retry: {$retry}\n\n";
            if ($mode !== 'long') {
                if (($payload = $this->streamPayload($authUser)) !== null) {
                    echo "data: {$payload}\n\n";
                }

                return;
            }
            @set_time_limit(70);
            $previous = '';
            $deadline = time() + 55;
            while (time() < $deadline && ! connection_aborted()) {
                $signature = $this->streamPayload($authUser);
                if ($signature === null) {
                    return;
                }
                echo $signature !== $previous ? "data: {$signature}\n\n" : ": heartbeat\n\n";
                $previous = $signature;
                @ob_flush();
                flush();
                sleep(3);
            }
        }, 200, [
            'Content-Type' => 'text/event-stream',
            'Cache-Control' => 'no-cache, no-transform',
            'Connection' => 'keep-alive',
            'X-Accel-Buffering' => 'no',
        ]);
    }

    public function index(): JsonResponse
    {
        return $this->ok($this->rows(DB::select('SELECT * FROM crm_notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', [$this->user()['id']])));
    }

    public function read(int $id): JsonResponse
    {
        DB::update('UPDATE crm_notifications SET is_read = TRUE WHERE id = ? AND user_id = ?', [$id, $this->user()['id']]);

        return $this->ok(['message' => 'Notification marquée comme lue.']);
    }
}
