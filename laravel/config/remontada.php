<?php

/*
|--------------------------------------------------------------------------
| Remontada Prospectia — configuration métier et sécurité
|--------------------------------------------------------------------------
| Toutes les valeurs reprennent les variables d'environnement du backend
| Node.js afin que le même fichier .env puisse être réutilisé.
*/

$origins = collect(explode(',', implode(',', array_filter([
    env('ALLOWED_ORIGINS'),
    env('FRONTEND_ORIGINS'),
]))))->map(fn ($o) => trim($o))->filter()->unique()->values()->all();

$secureCookies = env('APP_ENV') === 'production' || filter_var(env('COOKIE_SECURE', false), FILTER_VALIDATE_BOOL);
$sameSite = strtolower((string) env('COOKIE_SAMESITE', ''));
if (! in_array($sameSite, ['strict', 'lax', 'none'], true)) {
    $sameSite = $secureCookies ? 'none' : 'lax';
}

return [
    'api_version' => '1',

    'jwt' => [
        'secret' => env('JWT_SECRET'),
        'expires_in' => env('JWT_EXPIRES_IN', '1h'),
        'refresh_secret' => env('JWT_REFRESH_SECRET'),
        'refresh_expires_in' => env('JWT_REFRESH_EXPIRES_IN', '7d'),
    ],

    'cookies' => [
        'access' => 'crm_access',
        'refresh' => 'crm_refresh',
        'secure' => $secureCookies,
        'same_site' => $sameSite,
    ],

    'allowed_origins' => $origins,

    'body_limit_bytes' => (function () {
        $raw = (string) env('API_BODY_LIMIT', '512kb');
        if (! preg_match('/^(\d+)(kb|mb)$/i', $raw, $m)) {
            return 512 * 1024;
        }

        return (int) $m[1] * (strtolower($m[2]) === 'mb' ? 1024 * 1024 : 1024);
    })(),

    'rate_limit_disabled' => filter_var(env('API_RATE_LIMIT_DISABLED', env('DISABLE_RATE_LIMIT', false)), FILTER_VALIDATE_BOOL),

    'mfa' => [
        'ttl_seconds' => 600,
        'resend_cooldown_seconds' => 30,
        'max_resends' => 3,
        'max_attempts' => 5,
        'log_dev_otp' => env('APP_ENV') !== 'production' && filter_var(env('LOG_DEV_OTP', false), FILTER_VALIDATE_BOOL),
    ],

    'public_urls' => [
        'mission_verification' => env('MISSION_VERIFICATION_PUBLIC_URL', env('API_PUBLIC_URL')),
        'backoffice' => env('BACKOFFICE_PUBLIC_URL', env('FRONTEND_PUBLIC_URL', env('FRONTEND_URL'))),
    ],

    // Racine des pièces jointes. Pour une migration douce, pointer vers le
    // dossier uploads/ de l'ancien backend Node.js.
    'upload_root' => env('UPLOAD_ROOT', storage_path('app/private/uploads')),

    // Fuseau dans lequel les DATETIME MySQL ont été écrits par Node.js.
    'db_timezone' => env('DB_WALL_TIMEZONE', 'Africa/Douala'),
    'node_tz_label' => env('NODE_TZ_LABEL', 'West Africa Standard Time'),

    'notifications' => [
        // snapshot (cPanel / mutualisé) | long (VPS)
        'stream_mode' => env('NOTIFICATIONS_STREAM_MODE', 'snapshot'),
        'retry_ms' => (int) env('NOTIFICATIONS_STREAM_RETRY_MS', 20000),
        // Fréquence du worker de livraison : minute (cPanel, cron) | ten_seconds (schedule:work)
        'delivery_frequency' => env('NOTIFICATION_DELIVERY_FREQUENCY', 'minute'),
    ],

    'vapid' => [
        'public_key' => env('VAPID_PUBLIC_KEY'),
        'private_key' => env('VAPID_PRIVATE_KEY'),
        'subject' => env('VAPID_SUBJECT'),
    ],

    'logos' => [
        'inc' => env('PDF_LOGO_INC', resource_path('pdf/logo-inc.png')),
        'ippc' => env('PDF_LOGO_IPPC', resource_path('pdf/logo-ippc.jpeg')),
    ],
];
