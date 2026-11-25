<?php

namespace App\Support;

use Illuminate\Support\Str;

/** Petites aides de normalisation reprises des routes Node.js. */
class Input
{
    public static function positiveId(mixed $value): ?int
    {
        if (is_bool($value) || $value === null || $value === '') {
            return null;
        }
        if (! is_numeric($value)) {
            return null;
        }
        $n = $value + 0;

        return is_int($n) && $n > 0 ? $n : (is_float($n) && floor($n) === $n && $n > 0 ? (int) $n : null);
    }

    /** Équivalent JS de `Number(x)` truthy. */
    public static function num(mixed $value): float
    {
        if (is_bool($value)) {
            return $value ? 1.0 : 0.0;
        }

        return is_numeric($value) ? (float) $value : 0.0;
    }

    public static function isFiniteNumber(mixed $value): bool
    {
        if (is_bool($value) || $value === null) {
            return false;
        }

        return is_numeric($value) || $value === '';
    }

    public static function str(mixed $value): string
    {
        return is_scalar($value) ? trim((string) $value) : '';
    }

    public static function text(mixed $value, int $max = 1000): ?string
    {
        $t = self::str($value);

        return $t === '' ? null : mb_substr($t, 0, $max);
    }

    public static function bool(mixed $value, bool $default = true): bool
    {
        if ($value === null || $value === '') {
            return $default;
        }

        return $value === true || $value === 1 || $value === '1' || $value === 'true';
    }

    public static function nonEmptyString(mixed $value, int $max): bool
    {
        return is_string($value) && trim($value) !== '' && mb_strlen($value) <= $max;
    }

    public static function strongPassword(mixed $password): bool
    {
        return is_string($password) && strlen($password) >= 10 && strlen($password) <= 200
            && preg_match('/[a-z]/', $password) && preg_match('/[A-Z]/', $password)
            && preg_match('/\d/', $password) && preg_match('/[^A-Za-z0-9]/', $password);
    }

    public static function uuid(): string
    {
        return (string) Str::uuid();
    }

    public static function otp(): string
    {
        return (string) random_int(100000, 999999);
    }

    public static function ip(): string
    {
        return substr((string) (request()->ip() ?? 'unknown'), 0, 45);
    }
}
