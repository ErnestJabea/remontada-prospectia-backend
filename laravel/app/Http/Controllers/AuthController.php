<?php

namespace App\Http\Controllers;

use App\Services\JwtService;
use App\Services\Mailer;
use App\Support\Input;
use App\Support\Rows;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Symfony\Component\HttpFoundation\Cookie;

/**
 * Reprise de routes/auth.js.
 * Amélioration : les tickets MFA ne sont plus en mémoire du processus (Map)
 * mais dans le cache Laravel → compatibles redémarrage et multi-instances.
 */
class AuthController extends Controller
{
    public function __construct(private JwtService $jwt) {}

    private function hashOtp(string $otp): string
    {
        return hash_hmac('sha256', $otp, config('remontada.jwt.secret'));
    }

    private function device(mixed $value, int $max, ?string $fallback): ?string
    {
        if (! is_string($value) || trim($value) === '') {
            return $fallback;
        }

        return mb_substr(trim($value), 0, $max);
    }

    private function cookie(string $name, string $value, ?int $expiresAt): Cookie
    {
        $c = config('remontada.cookies');

        return Cookie::create($name, $value, $expiresAt ?? 0, '/', null, $c['secure'], true, true, $c['same_site']);
    }

    private function withWebCookies(JsonResponse $response, string $access, string $refresh): JsonResponse
    {
        $response->headers->setCookie($this->cookie('crm_access', $access, JwtService::unsafeDecode($access)['exp'] ?? null));
        $response->headers->setCookie($this->cookie('crm_refresh', $refresh, JwtService::unsafeDecode($refresh)['exp'] ?? null));

        return $response;
    }

    private function clearWebCookies(JsonResponse $response): JsonResponse
    {
        $c = config('remontada.cookies');
        foreach (['crm_access', 'crm_refresh'] as $name) {
            $response->headers->setCookie(Cookie::create($name, '', 1, '/', null, $c['secure'], true, true, $c['same_site']));
        }

        return $response;
    }

    private function storeRefreshToken(int $userId, string $token, ?string $deviceId): void
    {
        $exp = JwtService::unsafeDecode($token)['exp'];
        DB::insert('INSERT INTO refresh_tokens (user_id, token_hash, device_id, expires_at) VALUES (?, ?, ?, FROM_UNIXTIME(?))', [$userId, JwtService::hash($token), $deviceId, $exp]);
    }

    private function logLogin(?int $userId, mixed $username, ?string $clientType, string $status, ?string $reason = null): void
    {
        try {
            DB::insert('INSERT INTO crm_login_history (user_id, username, ip_address, user_agent, client_type, status, failure_reason) VALUES (?, ?, ?, ?, ?, ?, ?)', [
                $userId,
                mb_substr(is_scalar($username) && $username !== '' ? (string) $username : 'unknown', 0, 50),
                Input::ip(),
                ($ua = request()->userAgent()) ? mb_substr($ua, 0, 255) : null,
                mb_substr((string) ($clientType ?: 'unknown'), 0, 20),
                $status,
                $reason ? mb_substr($reason, 0, 100) : null,
            ]);
        } catch (\Throwable $e) {
            Log::error('[LOG_LOGIN_ERROR] '.$e->getMessage());
        }
    }

    public static function publicUser(array $user): array
    {
        $permissions = ! empty($user['job_description_id']) && $user['role'] !== 'SYSTEM'
            ? Rows::arr(DB::select('SELECT module_id, feature_id, can_view, can_view_all, can_create, can_update, can_delete, can_reorganize FROM job_feature_permissions WHERE job_description_id=?', [$user['job_description_id']]))
            : [];

        return [
            'id' => (int) $user['id'],
            'username' => $user['username'],
            'full_name' => $user['full_name'],
            'name' => $user['full_name'],
            'first_name' => $user['first_name'] ?? null,
            'last_name' => $user['last_name'] ?? null,
            'email' => $user['email'] ?? null,
            'role' => $user['role'],
            'job_title' => $user['job_title'] ?? null,
            'job_description_id' => $user['job_description_id'] ?: null,
            'jobPermissions' => $permissions,
            'base_city_id' => $user['base_city_id'] ?? null ?: null,
            'avatar_url' => $user['avatar_url'] ?? null,
            'settings' => Rows::decode($user['settings'] ?? null),
            'mfa_enabled' => (bool) ($user['mfa_enabled'] ?? false),
        ];
    }

    private function loadUser(int $id): ?array
    {
        return Rows::one(DB::selectOne('SELECT u.*, jd.title AS job_title FROM users u LEFT JOIN job_descriptions jd ON u.job_description_id = jd.id WHERE u.id = ? AND u.is_active = TRUE', [$id]));
    }

    public function login(Request $request): JsonResponse
    {
        $b = $this->body($request);
        $username = $b['username'] ?? null;
        $password = $b['password'] ?? null;
        $clientType = $b['clientType'] ?? null;
        $normalized = $clientType === 'mobile_pwa' ? 'mobile_pwa' : 'web_portal';
        $isMobile = $normalized === 'mobile_pwa';

        if (! is_string($username) || ! is_string($password) || trim($username) === '' || $password === '' || mb_strlen($username) > 50 || strlen($password) > 200) {
            $this->logLogin(null, $username ?: 'unknown', $clientType, 'FAILED', 'Identifiants invalides');

            return $this->err(400, 'Identifiants invalides.');
        }
        $username = trim($username);
        $user = Rows::one(DB::selectOne('SELECT u.*, jd.title AS job_title, jd.role_category FROM users u LEFT JOIN job_descriptions jd ON u.job_description_id = jd.id WHERE u.username = ? LIMIT 1', [$username]));
        if (! $user) {
            password_verify($password, Cache::rememberForever('auth:dummy_hash', fn () => password_hash('Invalid-password-timing-padding-9!', PASSWORD_BCRYPT, ['cost' => 12]))); // égalisation du temps de réponse
            $this->logLogin(null, $username, $clientType, 'FAILED', 'Identifiants incorrects');

            return $this->err(401, 'Identifiants incorrects.');
        }
        if ($user['blocked_until'] && strtotime($user['blocked_until']) > time()) {
            $this->logLogin($user['id'], $username, $clientType, 'BLOCKED', 'Compte temporairement bloque');

            return $this->err(403, 'Compte temporairement bloque.');
        }
        // password_verify accepte les empreintes bcryptjs ($2a$/$2b$).
        if (! password_verify($password, $user['password'])) {
            $attempts = (int) $user['failed_login_attempts'] + 1;
            DB::update('UPDATE users SET failed_login_attempts = ?, blocked_until = '.($attempts >= 5 ? 'DATE_ADD(NOW(), INTERVAL 30 MINUTE)' : 'NULL').' WHERE id = ?', [$attempts, $user['id']]);
            $this->logLogin($user['id'], $username, $clientType, 'FAILED', 'Mot de passe incorrect');

            return $this->err(401, 'Identifiants incorrects.');
        }
        if (! $user['is_active']) {
            $this->logLogin($user['id'], $username, $clientType, 'BLOCKED', 'Compte desactive');

            return $this->err(403, "Compte desactive. Contactez l'administrateur.");
        }
        DB::update('UPDATE users SET failed_login_attempts = 0, blocked_until = NULL, last_login = NOW(), last_activity = NOW(), last_active_client = ? WHERE id = ?', [$normalized, $user['id']]);

        if ($user['mfa_enabled'] || $isMobile) {
            $ticket = Input::uuid();
            $otp = Input::otp();
            Cache::put("mfa:{$ticket}", [
                'userId' => (int) $user['id'],
                'otpHash' => $this->hashOtp($otp),
                'expiry' => time() + config('remontada.mfa.ttl_seconds'),
                'attempts' => 0,
                'resendCount' => 0,
                'lastSentAt' => time(),
                'deviceId' => $this->device($b['deviceId'] ?? null, 100, null),
                'deviceName' => $this->device($b['deviceName'] ?? null, 100, $isMobile ? 'Terrain' : 'Web Portal'),
                'clientType' => $normalized,
            ], config('remontada.mfa.ttl_seconds'));
            if (config('remontada.mfa.log_dev_otp')) {
                @file_put_contents(storage_path('app/last_otp.txt'), $otp);
            }
            $email = $user['email'] ?: "{$username}@remontada.cm";
            Mailer::sendOtp($email, $username, $otp);

            return $this->ok(['mfaRequired' => true, 'ticket' => $ticket, 'email' => preg_replace('/(.{2}).+(@.+)/', '$1***$2', $email)]);
        }

        $access = $this->jwt->createAccessToken($user, 'web_portal');
        $refresh = $this->jwt->createRefreshToken((int) $user['id'], (int) $user['auth_version']);
        $this->storeRefreshToken((int) $user['id'], $refresh, $this->device($b['deviceId'] ?? null, 100, 'web-'.Input::uuid()));
        $this->logLogin($user['id'], $username, 'web_portal', 'SUCCESS');

        return $this->withWebCookies($this->ok(['user' => self::publicUser($user)]), $access, $refresh);
    }

    public function verifyMfa(Request $request): JsonResponse
    {
        $b = $this->body($request);
        $ticket = $b['ticket'] ?? null;
        $otp = $b['otp'] ?? null;
        if (! is_string($ticket) || strlen($ticket) > 100 || ! (is_string($otp) || is_int($otp)) || ! preg_match('/^\d{6}$/', trim((string) $otp))) {
            return $this->err(400, 'Ticket et OTP invalides.');
        }
        $key = "mfa:{$ticket}";
        $data = Cache::get($key);
        if (! $data) {
            return $this->err(401, 'Ticket invalide ou expire.');
        }
        $clientType = $data['clientType'] ?? 'mobile_pwa';
        if (time() > $data['expiry']) {
            Cache::forget($key);
            $this->logLogin($data['userId'], 'unknown', $clientType, 'FAILED', 'Ticket/OTP expire');

            return $this->err(401, 'Code OTP expire. Veuillez vous reconnecter.');
        }
        if (! hash_equals($data['otpHash'], $this->hashOtp(trim((string) $otp)))) {
            $data['attempts']++;
            $blocked = $data['attempts'] >= config('remontada.mfa.max_attempts');
            $blocked ? Cache::forget($key) : Cache::put($key, $data, max(1, $data['expiry'] - time()));
            $name = DB::selectOne('SELECT username FROM users WHERE id = ?', [$data['userId']])?->username ?? 'unknown';
            $this->logLogin($data['userId'], $name, $clientType, $blocked ? 'BLOCKED' : 'FAILED', 'Code OTP incorrect');

            return $this->err(401, 'Code OTP incorrect.');
        }
        Cache::forget($key);

        $user = $this->loadUser($data['userId']);
        if (! $user) {
            return $this->err(401, 'Utilisateur introuvable ou inactif.');
        }
        $token = $this->jwt->createAccessToken($user, $clientType);
        $refresh = $this->jwt->createRefreshToken((int) $user['id'], (int) $user['auth_version']);
        $deviceId = $this->device($b['deviceId'] ?? null, 100, $data['deviceId'] ?: Input::uuid());
        $deviceName = $this->device($b['deviceName'] ?? null, 100, $data['deviceName'] ?: ($clientType === 'mobile_pwa' ? 'Terrain' : 'Web Portal'));
        $this->storeRefreshToken((int) $user['id'], $refresh, $deviceId);
        DB::insert('INSERT INTO user_authorized_devices (user_id, device_id, device_name) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE device_name = VALUES(device_name), last_used_at = NOW()', [$user['id'], $deviceId, $deviceName]);
        DB::update('UPDATE users SET last_activity = NOW(), last_active_client = ?, last_mfa_ip = ? WHERE id = ?', [$clientType, Input::ip(), $user['id']]);
        $this->logLogin($user['id'], $user['username'], $clientType, 'SUCCESS');

        if ($clientType === 'web_portal') {
            return $this->withWebCookies($this->ok(['user' => self::publicUser($user)]), $token, $refresh);
        }

        return $this->ok(['token' => $token, 'accessToken' => $token, 'refreshToken' => $refresh, 'user' => self::publicUser($user)]);
    }

    public function resendMfa(Request $request): JsonResponse
    {
        $ticket = $this->body($request)['ticket'] ?? null;
        if (! is_string($ticket) || $ticket === '' || strlen($ticket) > 100) {
            return $this->err(400, 'Ticket invalide.');
        }
        $key = "mfa:{$ticket}";
        $data = Cache::get($key);
        if (! $data) {
            return $this->err(404, 'Session de connexion expirée ou invalide. Veuillez vous reconnecter.');
        }
        if (time() > $data['expiry']) {
            Cache::forget($key);

            return $this->err(401, 'Session de connexion expiree. Veuillez vous reconnecter.');
        }
        if (time() - $data['lastSentAt'] < config('remontada.mfa.resend_cooldown_seconds')) {
            return $this->err(429, 'Veuillez patienter avant de demander un nouveau code.');
        }
        if ($data['resendCount'] >= config('remontada.mfa.max_resends')) {
            Cache::forget($key);

            return $this->err(429, 'Trop de codes demandes. Veuillez vous reconnecter.');
        }
        $user = DB::selectOne('SELECT username, email FROM users WHERE id = ? AND is_active = TRUE', [$data['userId']]);
        if (! $user) {
            return $this->err(404, 'Utilisateur introuvable ou inactif.');
        }
        $otp = Input::otp();
        $data = array_merge($data, ['otpHash' => $this->hashOtp($otp), 'expiry' => time() + config('remontada.mfa.ttl_seconds'), 'attempts' => 0, 'resendCount' => $data['resendCount'] + 1, 'lastSentAt' => time()]);
        Cache::put($key, $data, config('remontada.mfa.ttl_seconds'));
        $email = $user->email ?: "{$user->username}@remontada.cm";
        Mailer::sendOtp($email, $user->username, $otp);

        return $this->ok(['message' => 'Code OTP renvoyé avec succès.', 'email' => preg_replace('/(.{2}).+(@.+)/', '$1***$2', $email)]);
    }

    public function forgotPassword(Request $request): JsonResponse
    {
        $identifier = is_string($i = $this->body($request)['identifier'] ?? null) ? trim($i) : '';
        if ($identifier === '' || mb_strlen($identifier) > 100) {
            return $this->err(400, 'Identifiant invalide.');
        }
        $ticket = Input::uuid();
        $generic = ['ticket' => $ticket, 'message' => 'Si un compte actif correspond, un code de reinitialisation a ete envoye.'];
        $user = DB::selectOne('SELECT id, username, email FROM users WHERE (username = ? OR email = ?) AND is_active = TRUE LIMIT 1', [$identifier, $identifier]);
        if (! $user || ! $user->email) {
            return $this->ok($generic);
        }
        $otp = Input::otp();
        DB::update('UPDATE password_reset_tokens SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL', [$user->id]);
        DB::insert('INSERT INTO password_reset_tokens (user_id, ticket_hash, otp_hash, expires_at) VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE))', [$user->id, JwtService::hash($ticket), password_hash($otp, PASSWORD_BCRYPT, ['cost' => 12])]);
        Mailer::sendPasswordReset($user->email, $user->username, $otp);

        return $this->ok($generic);
    }

    public function resetPassword(Request $request): JsonResponse
    {
        $b = $this->body($request);
        $ticket = $b['ticket'] ?? null;
        $otp = $b['otp'] ?? null;
        $new = $b['newPassword'] ?? null;
        if (! is_string($ticket) || ! is_string($otp) || ! preg_match('/^\d{6}$/', trim($otp)) || ! Input::strongPassword($new)) {
            return $this->err(400, 'Code invalide ou mot de passe insuffisamment robuste.');
        }

        $result = DB::transaction(function () use ($ticket, $otp, $new) {
            $token = DB::selectOne('SELECT prt.*, u.is_active FROM password_reset_tokens prt JOIN users u ON prt.user_id = u.id WHERE prt.ticket_hash = ? AND prt.used_at IS NULL AND prt.expires_at > NOW() LIMIT 1 FOR UPDATE', [JwtService::hash($ticket)]);
            if (! $token || ! $token->is_active || $token->attempts >= 5) {
                return 'invalid';
            }
            if (! password_verify(trim($otp), $token->otp_hash)) {
                DB::update('UPDATE password_reset_tokens SET attempts = attempts + 1 WHERE id = ?', [$token->id]);

                return 'invalid';
            }
            DB::update('UPDATE users SET password = ?, auth_version = auth_version + 1, failed_login_attempts = 0, blocked_until = NULL WHERE id = ?', [password_hash($new, PASSWORD_BCRYPT, ['cost' => 12]), $token->user_id]);
            DB::update('UPDATE password_reset_tokens SET used_at = NOW() WHERE id = ?', [$token->id]);
            DB::delete('DELETE FROM refresh_tokens WHERE user_id = ?', [$token->user_id]);

            return 'ok';
        });
        if ($result !== 'ok') {
            return $this->err(400, 'Code invalide ou expire.');
        }

        return $this->clearWebCookies($this->ok(['message' => 'Mot de passe reinitialise. Vous pouvez vous connecter.']));
    }

    public function me(): JsonResponse
    {
        $user = $this->loadUser($this->user()['id']);

        return $user ? $this->ok(['user' => self::publicUser($user)]) : $this->err(401, 'Session invalide.');
    }

    public function getSettings(): JsonResponse
    {
        $row = DB::selectOne('SELECT settings FROM users WHERE id = ?', [$this->user()['id']]);
        if (! $row) {
            return $this->err(404, 'Utilisateur introuvable.');
        }
        $default = ['lang' => 'fr', 'theme' => 'light', 'notifications' => ['email' => true, 'push' => false], 'alerts' => ['lateRelance' => true, 'syncConflict' => true], 'sync' => ['auto' => true, 'frequency' => 15]];

        return $this->ok(Rows::decode($row->settings, $default) ?? $default);
    }

    public function putSettings(Request $request): JsonResponse
    {
        $settings = $this->body($request);
        if (! is_array($settings)) {
            return $this->err(400, 'Format de paramètres invalide.');
        }
        DB::update('UPDATE users SET settings = ? WHERE id = ?', [json_encode($settings, JSON_UNESCAPED_UNICODE), $this->user()['id']]);

        return $this->ok(['success' => true, 'settings' => $settings]);
    }

    public function devices(): JsonResponse
    {
        return $this->ok($this->rows(DB::select('SELECT id, device_id, device_name, authorized_at AS created_at, last_used_at FROM user_authorized_devices WHERE user_id = ? ORDER BY last_used_at DESC', [$this->user()['id']])));
    }

    public function revokeDevice(int $id): JsonResponse
    {
        $userId = $this->user()['id'];
        $found = DB::transaction(function () use ($id, $userId) {
            $device = DB::selectOne('SELECT device_id FROM user_authorized_devices WHERE id = ? AND user_id = ? FOR UPDATE', [$id, $userId]);
            if (! $device) {
                return false;
            }
            DB::delete('DELETE FROM refresh_tokens WHERE user_id = ? AND device_id = ?', [$userId, $device->device_id]);
            DB::delete('DELETE FROM user_authorized_devices WHERE id = ? AND user_id = ?', [$id, $userId]);

            return true;
        });

        return $found ? $this->ok(['message' => 'Appareil revoque.']) : $this->err(404, 'Appareil introuvable.');
    }

    public function refresh(Request $request): JsonResponse
    {
        $cookieToken = $request->cookie('crm_refresh');
        $token = $cookieToken ?: ($this->body($request)['refreshToken'] ?? null);
        $cookieSession = (bool) $cookieToken;
        if (! is_string($token) || $token === '') {
            return $this->err(401, 'Refresh token manquant.');
        }
        try {
            $decoded = $this->jwt->verifyRefresh($token);
        } catch (\Throwable) {
            return $this->clearWebCookies($this->err(401, 'Refresh token invalide.'));
        }

        $outcome = DB::transaction(function () use ($token, $decoded, $cookieSession) {
            $stored = DB::selectOne('SELECT * FROM refresh_tokens WHERE token_hash = ? AND user_id = ? AND expires_at > NOW() LIMIT 1 FOR UPDATE', [JwtService::hash($token), $decoded['id']]);
            if (! $stored) {
                return ['error' => 'Refresh token invalide ou expire.', 'clear' => true];
            }
            $user = $this->loadUser((int) $decoded['id']);
            if (! $user) {
                return ['error' => 'Utilisateur introuvable ou inactif.', 'clear' => true];
            }
            if ((int) ($decoded['authVersion'] ?? 0) !== (int) $user['auth_version']) {
                return ['error' => 'Session révoquée.', 'clear' => false];
            }
            $access = $this->jwt->createAccessToken($user, $cookieSession ? 'web_portal' : 'mobile_pwa');
            $rotated = $this->jwt->createRefreshToken((int) $user['id'], (int) $user['auth_version']);
            DB::delete('DELETE FROM refresh_tokens WHERE id = ?', [$stored->id]);
            $this->storeRefreshToken((int) $user['id'], $rotated, $stored->device_id);

            return compact('access', 'rotated', 'user');
        });

        if (isset($outcome['error'])) {
            $response = $this->err(401, $outcome['error']);

            return $outcome['clear'] ? $this->clearWebCookies($response) : $response;
        }
        if ($cookieSession) {
            return $this->withWebCookies($this->ok(['user' => self::publicUser($outcome['user'])]), $outcome['access'], $outcome['rotated']);
        }

        return $this->ok(['accessToken' => $outcome['access'], 'refreshToken' => $outcome['rotated']]);
    }

    public function logout(Request $request): JsonResponse
    {
        $access = $request->cookie('crm_access') ?: preg_replace('/^Bearer /', '', (string) $request->header('Authorization', ''));
        if ($access) {
            try {
                $decoded = $this->jwt->verifyAccess($access);
                DB::insert('INSERT IGNORE INTO revoked_access_tokens (token_hash, expires_at) VALUES (?, FROM_UNIXTIME(?))', [JwtService::hash($access), $decoded['exp']]);
            } catch (\Throwable) {
                // une session expirée est déjà inutilisable
            }
        }
        $refresh = $request->cookie('crm_refresh') ?: ($this->body($request)['refreshToken'] ?? null);
        if (is_string($refresh) && $refresh !== '') {
            try {
                DB::delete('DELETE FROM refresh_tokens WHERE token_hash = ?', [JwtService::hash($refresh)]);
            } catch (\Throwable) {
            }
        }

        return $this->clearWebCookies($this->ok(['message' => 'Deconnexion reussie.']));
    }

    public function toggleMfa(Request $request): JsonResponse
    {
        $enabled = $this->body($request)['enabled'] ?? null;
        if (! is_bool($enabled)) {
            return $this->err(400, 'Statut MFA invalide.');
        }
        DB::update('UPDATE users SET mfa_enabled = ? WHERE id = ?', [$enabled, $this->user()['id']]);
        DB::insert('INSERT INTO crm_audit_logs (user_id, action_type, module_name, old_value, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?)', [
            $this->user()['id'], 'POST /api/v1/auth/toggle-mfa', 'auth', json_encode(['mfa_enabled' => ! $enabled]), json_encode(['mfa_enabled' => $enabled]), Input::ip(),
        ]);

        return $this->ok(['success' => true, 'mfa_enabled' => $enabled]);
    }
}
