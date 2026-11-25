<?php

namespace App\Support;

use Illuminate\Support\Carbon;

/** Formats de date français utilisés dans les PDF (équivalent de toLocaleString('fr-FR')). */
class PdfFormat
{
    public static function date(mixed $value): string
    {
        return $value ? Carbon::parse($value)->locale('fr')->translatedFormat('j F Y') : '-';
    }

    public static function dateTime(mixed $value): string
    {
        return $value ? Carbon::parse($value)->locale('fr')->translatedFormat('j F Y \à H:i') : '-';
    }
}
