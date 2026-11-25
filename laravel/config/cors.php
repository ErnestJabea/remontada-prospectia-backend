<?php

// Équivalent du middleware cors() de server.js : liste blanche stricte + cookies.
return [
    'paths' => ['api/*'],
    'allowed_methods' => ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    'allowed_origins' => array_values(array_filter(array_map('trim', explode(',', (string) env('ALLOWED_ORIGINS', '').','.env('FRONTEND_ORIGINS', ''))))),
    'allowed_origins_patterns' => [],
    'allowed_headers' => ['Authorization', 'Content-Type', 'X-Request-ID'],
    'exposed_headers' => ['X-Request-ID', 'X-API-Version', 'Deprecation', 'Link', 'RateLimit', 'RateLimit-Policy', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'Retry-After'],
    'max_age' => 600,
    'supports_credentials' => true,
];
