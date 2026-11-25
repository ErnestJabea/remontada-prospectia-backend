<?php

namespace App\Services;

use App\Exceptions\ApiException;
use DateTimeImmutable;
use DateTimeZone;

/** Reprise de utils/cameroonTime.js — le Cameroun est en UTC+1 sans heure d'été. */
class CameroonTime
{
    /** "2026-09-20T14:30" (heure locale) → "2026-09-20 13:30:00" (UTC). */
    public static function parseDeadline(mixed $value): string
    {
        if (! is_string($value) || ! preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/', $value)) {
            throw ApiException::make(400, 'Précisez la date et l’heure de relance au Cameroun.');
        }
        $date = DateTimeImmutable::createFromFormat('!Y-m-d\TH:i', $value, new DateTimeZone('Africa/Douala'));
        if (! $date || $date->format('Y-m-d\TH:i') !== $value) {
            throw ApiException::make(400, 'Date de relance invalide.');
        }

        return $date->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d H:i:s');
    }

    public static function formatDeadline(string $utc): string
    {
        return (new DateTimeImmutable($utc, new DateTimeZone('UTC')))->setTimezone(new DateTimeZone('Africa/Douala'))->format('d/m/Y H:i');
    }
}
