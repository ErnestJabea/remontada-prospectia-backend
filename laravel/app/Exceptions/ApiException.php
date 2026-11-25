<?php

namespace App\Exceptions;

use RuntimeException;

/** Erreur métier transportant un statut HTTP (équivalent de `httpError()` côté Node). */
class ApiException extends RuntimeException
{
    public function __construct(public int $status, string $message, public string $errorCode = 'REQUEST_FAILED')
    {
        parent::__construct($message);
    }

    public static function make(int $status, string $message, ?string $code = null): self
    {
        return new self($status, $message, $code ?? match (true) {
            $status === 401 => 'AUTHENTICATION_REQUIRED',
            $status === 403 => 'FORBIDDEN',
            $status === 404 => 'NOT_FOUND',
            $status === 409 => 'CONFLICT',
            default => 'REQUEST_FAILED',
        });
    }
}
