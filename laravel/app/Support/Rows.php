<?php

namespace App\Support;

use DateTimeImmutable;
use DateTimeZone;

/**
 * mysql2 renvoyait les colonnes DATETIME/TIMESTAMP sous forme d'objets Date,
 * sérialisés en ISO-8601 UTC ("2026-07-15T09:00:00.000Z"). PDO renvoie
 * "2026-07-15 10:00:00". Ce normaliseur restaure le format attendu par les
 * deux frontends sans toucher aux colonnes DATE simples.
 */
class Rows
{
    public static function normalize(mixed $value): mixed
    {
        if (is_array($value)) {
            foreach ($value as $k => $v) {
                $value[$k] = self::normalize($v);
            }

            return $value;
        }
        if (is_object($value) && ! $value instanceof \JsonSerializable) {
            return self::normalize((array) $value);
        }
        if (is_string($value) && preg_match('/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/', $value)) {
            return self::iso($value);
        }

        return $value;
    }

    public static function iso(?string $wallClock): ?string
    {
        if (! $wallClock) {
            return null;
        }
        try {
            $date = new DateTimeImmutable($wallClock, new DateTimeZone(config('remontada.db_timezone')));

            return $date->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d\TH:i:s.v\Z');
        } catch (\Throwable) {
            return $wallClock;
        }
    }

    /** Convertit un résultat Query Builder (objets stdClass) en tableaux associatifs. */
    public static function arr(mixed $rows): array
    {
        return json_decode(json_encode($rows), true) ?? [];
    }

    public static function one(mixed $row): ?array
    {
        return $row === null ? null : (array) $row;
    }

    public static function decode(mixed $json, mixed $fallback = null): mixed
    {
        if (is_array($json)) {
            return $json;
        }
        if (! is_string($json) || $json === '') {
            return $fallback;
        }
        $decoded = json_decode($json, true);

        return json_last_error() === JSON_ERROR_NONE ? $decoded : $fallback;
    }
}
