<?php

namespace App\Http\Controllers;

use App\Exceptions\ApiException;
use App\Services\JwtService;
use App\Services\Mailer;
use App\Services\MissionTravel;
use App\Support\Input;
use Illuminate\Database\QueryException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

/** Reprise de routes/users.js (les requêtes « fallback » sans base_city_id deviennent inutiles : le schéma est désormais figé). */
class UserController extends Controller
{
    private const ASSIGNABLE = ['COMMERCIAL', 'DIRECTION'];

    private function requireGlobalView(): ?JsonResponse
    {
        return $this->user()['restrictFeatureScope'] ? $this->err(403, 'La consultation des équipes exige le droit de vue globale.') : null;
    }

    private function normalizeEmail(mixed $email): string|false|null
    {
        if ($email === null || $email === '') {
            return null;
        }
        if (! is_string($email)) {
            return false;
        }
        $v = strtolower(trim($email));
        if ($v === '' || strlen($v) > 150) {
            return false;
        }

        return preg_match('/^[^\s@]+@[^\s@]+\.[^\s@]+$/', $v) ? $v : false;
    }

    public function index(): JsonResponse
    {
        if ($r = $this->requireGlobalView()) {
            return $r;
        }

        return $this->ok($this->rows(DB::select("SELECT u.id, u.username, u.full_name, u.first_name, u.last_name, u.email, u.phone, u.role, u.job_description_id, u.base_city_id,
            base_city.name AS base_city_name, base_city.name_en AS base_city_name_en, u.is_active, u.is_verified, u.last_login, u.created_at, u.mfa_enabled,
            jd.title AS job_title, jd.role_category
            FROM users u LEFT JOIN job_descriptions jd ON u.job_description_id = jd.id LEFT JOIN crm_ref_cities base_city ON u.base_city_id = base_city.id
            WHERE u.role NOT IN ('SYSTEM', 'ADMIN') ORDER BY u.created_at DESC")));
    }

    public function commercials(): JsonResponse
    {
        if ($r = $this->requireGlobalView()) {
            return $r;
        }

        return $this->ok($this->rows(DB::select("SELECT u.id, u.username, u.full_name, u.first_name, u.last_name, u.email, u.phone, u.role, u.is_active, u.last_login, u.mfa_enabled,
            u.base_city_id, base_city.name AS base_city_name, base_city.name_en AS base_city_name_en, jd.title AS job_title
            FROM users u LEFT JOIN job_descriptions jd ON u.job_description_id = jd.id LEFT JOIN crm_ref_cities base_city ON u.base_city_id = base_city.id
            WHERE u.role = 'COMMERCIAL' AND u.is_active = TRUE ORDER BY u.full_name")));
    }

    public function jobDescriptions(): JsonResponse
    {
        return $this->ok($this->rows(DB::select('SELECT id, title, description, role_category FROM job_descriptions ORDER BY role_category, title')));
    }

    public function show(string $id): JsonResponse
    {
        $requested = (int) $id;
        if (! $requested) {
            return $this->err(400, 'Identifiant invalide.');
        }
        if (! $this->isManager() && $requested !== $this->user()['id']) {
            return $this->err(403, 'Acces refuse.');
        }
        $row = DB::selectOne('SELECT u.id, u.username, u.full_name, u.first_name, u.last_name, u.email, u.phone, u.role, u.is_active, u.is_verified,
            u.last_login, u.created_at, u.avatar_url, u.mfa_enabled, u.base_city_id, base_city.name AS base_city_name, base_city.name_en AS base_city_name_en,
            jd.id AS job_description_id, jd.title AS job_title, jd.role_category
            FROM users u LEFT JOIN job_descriptions jd ON u.job_description_id = jd.id LEFT JOIN crm_ref_cities base_city ON u.base_city_id = base_city.id WHERE u.id = ?', [$requested]);

        return $row ? $this->ok($row) : $this->err(404, 'Utilisateur introuvable.');
    }

    public function devices(int $id): JsonResponse
    {
        return $this->ok($this->rows(DB::select('SELECT id, device_id, device_name, authorized_at, last_used_at FROM user_authorized_devices WHERE user_id = ? ORDER BY last_used_at DESC', [$id])));
    }

    public function store(Request $request): JsonResponse
    {
        $b = $this->body($request);
        $email = $this->normalizeEmail($b['email'] ?? null);
        $role = $b['role'] ?? null;
        if (! Input::nonEmptyString($b['username'] ?? null, 50) || ! Input::nonEmptyString($b['full_name'] ?? null, 100)
            || ! Input::strongPassword($b['password'] ?? null) || ! in_array($role, self::ASSIGNABLE, true) || $email === false
            || ($role === 'COMMERCIAL' && (! $email || ! Input::num($b['base_city_id'] ?? null)))) {
            return $this->err(400, 'Donnees utilisateur invalides. Pour un commercial, un email valide et une ville de rattachement sont obligatoires. Le mot de passe doit contenir au moins 10 caracteres, avec majuscule, minuscule, chiffre et symbole.');
        }

        try {
            return DB::transaction(function () use ($b, $email, $role) {
                $city = MissionTravel::validateBaseCity($b['base_city_id'] ?? null, $role === 'COMMERCIAL');
                $sendSetup = $role === 'COMMERCIAL';
                // Un commercial reçoit un lien de création : le mot de passe saisi n'est jamais utilisé.
                $password = $sendSetup ? rtrim(strtr(base64_encode(random_bytes(24)), '+/', '-_'), '=').'Aa1!' : $b['password'];
                DB::insert('INSERT INTO users (username, password, full_name, first_name, last_name, email, phone, role, job_description_id, base_city_id, is_verified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, TRUE)', [
                    trim($b['username']), password_hash($password, PASSWORD_BCRYPT, ['cost' => 12]), trim($b['full_name']),
                    ($b['first_name'] ?? null) ?: null, ($b['last_name'] ?? null) ?: null, $email, ($b['phone'] ?? null) ?: null, $role,
                    Input::positiveId($b['job_description_id'] ?? null), $city['id'] ?? null,
                ]);
                $id = (int) DB::getPdo()->lastInsertId();

                if ($sendSetup) {
                    $ticket = Input::uuid();
                    $otp = Input::otp();
                    DB::update('UPDATE password_reset_tokens SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL', [$id]);
                    DB::insert('INSERT INTO password_reset_tokens (user_id, ticket_hash, otp_hash, expires_at) VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 24 HOUR))', [$id, JwtService::hash($ticket), password_hash($otp, PASSWORD_BCRYPT, ['cost' => 12])]);
                    $base = rtrim((string) config('remontada.public_urls.backoffice', ''), '/');
                    $sent = Mailer::sendInitialPasswordSetup($email, [
                        'username' => trim($b['username']), 'fullName' => trim($b['full_name']), 'otp' => $otp,
                        'setupUrl' => ($base ?: '').'/?passwordSetupTicket='.rawurlencode($ticket),
                    ]);
                    if (! $sent) {
                        throw ApiException::make(503, "Utilisateur non cree : impossible d'envoyer l'invitation de creation du mot de passe. Verifiez la configuration SMTP.");
                    }
                }

                return $this->ok(['id' => $id, 'message' => 'Utilisateur cree.'], 201);
            });
        } catch (QueryException $e) {
            if (($e->errorInfo[1] ?? null) === 1062) {
                return $this->err(409, "Ce nom d'utilisateur ou email existe deja.");
            }
            throw $e;
        }
    }

    public function update(Request $request, int $id): JsonResponse
    {
        $b = $this->body($request);
        $role = $b['role'] ?? null;
        if (! Input::nonEmptyString($b['full_name'] ?? null, 100) || ! in_array($role, self::ASSIGNABLE, true) || ($role === 'COMMERCIAL' && ! Input::num($b['base_city_id'] ?? null))) {
            return $this->err(400, 'Donnees utilisateur invalides.');
        }
        $city = MissionTravel::validateBaseCity($b['base_city_id'] ?? null, $role === 'COMMERCIAL');
        $isActive = ($b['is_active'] ?? null) !== false;
        $affected = DB::update("UPDATE users SET full_name = ?, first_name = ?, last_name = ?, email = ?, phone = ?, role = ?, job_description_id = ?, base_city_id = ?, is_active = ?, updated_at = NOW()
            WHERE id = ? AND role NOT IN ('SYSTEM', 'ADMIN')", [
            trim($b['full_name']), ($b['first_name'] ?? null) ?: null, ($b['last_name'] ?? null) ?: null, ($b['email'] ?? null) ?: null,
            ($b['phone'] ?? null) ?: null, $role, Input::positiveId($b['job_description_id'] ?? null), $city['id'] ?? null, $isActive, $id,
        ]);
        if (! $affected && ! DB::selectOne("SELECT id FROM users WHERE id = ? AND role NOT IN ('SYSTEM','ADMIN')", [$id])) {
            return $this->err(404, 'Utilisateur introuvable.');
        }
        if (! $isActive) {
            DB::delete('DELETE FROM refresh_tokens WHERE user_id = ?', [$id]);
        }

        return $this->ok(['message' => 'Utilisateur mis a jour.']);
    }

    public function password(Request $request, int $id): JsonResponse
    {
        $new = $this->body($request)['newPassword'] ?? null;
        if (! Input::strongPassword($new)) {
            return $this->err(400, 'Le mot de passe doit contenir au moins 10 caracteres, avec majuscule, minuscule, chiffre et symbole.');
        }
        DB::update('UPDATE users SET password = ?, auth_version = auth_version + 1 WHERE id = ?', [password_hash($new, PASSWORD_BCRYPT, ['cost' => 12]), $id]);
        DB::delete('DELETE FROM refresh_tokens WHERE user_id = ?', [$id]);

        return $this->ok(['message' => 'Mot de passe mis a jour.']);
    }

    public function destroy(int $id): JsonResponse
    {
        // Correctif : la désactivation incrémente aussi auth_version pour
        // invalider immédiatement les jetons d'accès encore valides.
        DB::update('UPDATE users SET is_active = FALSE, auth_version = auth_version + 1 WHERE id = ?', [$id]);
        DB::delete('DELETE FROM refresh_tokens WHERE user_id = ?', [$id]);

        return $this->ok(['message' => 'Utilisateur desactive.']);
    }
}
