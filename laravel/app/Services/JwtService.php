<?php

namespace App\Services;

use Firebase\JWT\JWT;
use Firebase\JWT\Key;
use Illuminate\Support\Str;

/**
 * Jetons HS256 identiques à ceux de jsonwebtoken (Node) : mêmes secrets,
 * mêmes revendications. Les sessions ouvertes avant la bascule restent donc
 * valides après le passage à Laravel.
 */
class JwtService
{
    public static function seconds(string $expr): int
    {
        if (preg_match('/^(\d+)\s*([smhd]?)$/i', trim($expr), $m)) {
            return (int) $m[1] * match (strtolower($m[2])) {
                'm' => 60, 'h' => 3600, 'd' => 86400, default => 1,
            };
        }

        return 3600;
    }

    public function createAccessToken(array $user, string $clientType): string
    {
        $now = time();

        return JWT::encode([
            'id' => (int) $user['id'],
            'username' => $user['username'],
            'role' => $user['role'],
            'full_name' => $user['full_name'],
            'clientType' => $clientType,
            'authVersion' => (int) ($user['auth_version'] ?? 0),
            'jti' => (string) Str::uuid(),
            'iat' => $now,
            'exp' => $now + self::seconds(config('remontada.jwt.expires_in')),
        ], config('remontada.jwt.secret'), 'HS256');
    }

    public function createRefreshToken(int $userId, int $authVersion = 0): string
    {
        $now = time();

        return JWT::encode([
            'id' => $userId,
            'authVersion' => $authVersion,
            'jti' => (string) Str::uuid(),
            'iat' => $now,
            'exp' => $now + self::seconds(config('remontada.jwt.refresh_expires_in')),
        ], config('remontada.jwt.refresh_secret'), 'HS256');
    }

    public function verifyAccess(string $token): array
    {
        return (array) JWT::decode($token, new Key(config('remontada.jwt.secret'), 'HS256'));
    }

    public function verifyRefresh(string $token): array
    {
        return (array) JWT::decode($token, new Key(config('remontada.jwt.refresh_secret'), 'HS256'));
    }

    /** Lecture sans vérification (calcul de durée de vie / expiration). */
    public static function unsafeDecode(string $token): array
    {
        $parts = explode('.', $token);
        if (count($parts) !== 3) {
            return [];
        }

        return json_decode(JWT::urlsafeB64Decode($parts[1]), true) ?: [];
    }

    public static function hash(string $token): string
    {
        return hash('sha256', $token);
    }
}
