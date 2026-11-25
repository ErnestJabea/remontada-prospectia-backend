<?php

namespace App\Http\Middleware;

use App\Services\JwtService;
use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Symfony\Component\HttpFoundation\Response;

/**
 * Reprise de middleware/auth.js :
 *  - cookie HttpOnly `crm_access` pour le backoffice (clientType=web_portal)
 *  - en-tête Bearer pour la PWA terrain (clientType=mobile_pwa)
 *  - contrôle auth_version, compte actif, jeton révoqué
 *  - chargement des habilitations de la fiche de poste
 *  - journal d'audit de chaque écriture réussie (< 500)
 */
class Authenticate
{
    public function __construct(private JwtService $jwt) {}

    public function handle(Request $request, Closure $next)
    {
        if ($request->attributes->get('user')) {
            return $next($request);
        }
        $header = $request->header('Authorization');
        if ($header && ! preg_match('/^Bearer [A-Za-z0-9._-]+$/', $header)) {
            return $this->fail("En-tete d'authentification invalide.");
        }
        $bearer = $header ? substr($header, 7) : null;
        $cookie = $request->cookie('crm_access') ?: null;
        if ($cookie && $bearer && $cookie !== $bearer) {
            return $this->fail("Sources d'authentification incompatibles.");
        }
        $token = $cookie ?: $bearer;
        if (! $token) {
            return $this->fail("Token d'authentification manquant.");
        }

        try {
            $decoded = $this->jwt->verifyAccess($token);
        } catch (\Throwable) {
            return $this->fail('Token invalide ou expire.');
        }

        $expected = $cookie ? 'web_portal' : 'mobile_pwa';
        if (! (int) ($decoded['id'] ?? 0) || ($decoded['clientType'] ?? null) !== $expected) {
            return $this->fail("Jeton incompatible avec ce canal d'acces.");
        }

        $row = DB::selectOne('SELECT id, username, full_name, role, is_active, auth_version, job_description_id FROM users WHERE id = ? LIMIT 1', [$decoded['id']]);
        if (! $row || ! $row->is_active) {
            return response()->json(['error' => 'Session invalide ou compte desactive.'], 401);
        }
        if ((int) ($decoded['authVersion'] ?? 0) !== (int) $row->auth_version) {
            return $this->fail('Session révoquée. Veuillez vous reconnecter.');
        }
        $revoked = DB::selectOne('SELECT token_hash FROM revoked_access_tokens WHERE token_hash = ? AND expires_at > NOW()', [JwtService::hash($token)]);
        if ($revoked) {
            return $this->fail('Session révoquée.');
        }

        $user = array_merge($decoded, [
            'id' => (int) $row->id,
            'username' => $row->username,
            'full_name' => $row->full_name,
            'job_description_id' => $row->job_description_id !== null ? (int) $row->job_description_id : null,
            'role' => $row->role,
            'token_hash' => JwtService::hash($token),
            'jobPermissions' => null,
            'restrictFeatureScope' => false,
        ]);
        if ($row->job_description_id && $row->role !== 'SYSTEM') {
            $user['jobPermissions'] = array_map(fn ($p) => (array) $p, DB::select(
                'SELECT module_id,feature_id,can_view,can_create,can_update,can_delete,can_view_all,can_reorganize FROM job_feature_permissions WHERE job_description_id=?',
                [$row->job_description_id]
            ));
        }
        $request->attributes->set('user', $user);

        try {
            DB::update('UPDATE users SET last_activity = NOW(), last_active_client = ? WHERE id = ?', [$decoded['clientType'] ?? 'unknown', $user['id']]);
        } catch (\Throwable $e) {
            Log::warning('[MIDDLEWARE_LAST_ACTIVITY_ERROR] '.$e->getMessage());
        }

        $response = $next($request);

        if (! in_array($request->method(), ['GET', 'HEAD', 'OPTIONS'], true) && $response->getStatusCode() < 500) {
            $this->audit($request, $user['id']);
        }

        return $response;
    }

    private function audit(Request $request, int $userId): void
    {
        $path = '/'.ltrim($request->path(), '/');
        $canonical = preg_replace('#^/api(?!/v1(?:/|$))#', '/api/v1', $path);
        $parts = array_values(array_filter(explode('/', $canonical)));
        $module = ($parts[0] ?? '') === 'api' && ($parts[1] ?? '') === 'v1' ? ($parts[2] ?? 'api') : 'api';
        try {
            DB::insert('INSERT INTO crm_audit_logs (user_id, action_type, module_name, ip_address) VALUES (?, ?, ?, ?)', [
                $userId,
                mb_substr($request->method().' '.$canonical, 0, 100),
                mb_substr($module, 0, 50),
                substr((string) ($request->ip() ?? 'unknown'), 0, 45),
            ]);
        } catch (\Throwable $e) {
            Log::error('[AUDIT_ERROR] '.$e->getMessage());
        }
    }

    private function fail(string $message): Response
    {
        return response()->json([
            'error' => $message,
            'code' => 'AUTHENTICATION_REQUIRED',
            'requestId' => request()->attributes->get('requestId'),
        ], 401);
    }
}
