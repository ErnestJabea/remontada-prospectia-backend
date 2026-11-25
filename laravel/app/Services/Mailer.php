<?php

namespace App\Services;

use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Mail;

/** Reprise de utils/mailer.js (Nodemailer → Laravel Mail / Symfony Mailer). */
class Mailer
{
    public static function configured(): bool
    {
        $user = (string) config('mail.mailers.smtp.username');

        return config('mail.default') === 'smtp' && config('mail.mailers.smtp.host') && $user !== ''
            && ! str_contains($user, 'votre-email');
    }

    private static function devOtp(string $username, string $otp): void
    {
        if (config('remontada.mfa.log_dev_otp')) {
            Log::info("[MFA] [DEV ONLY] OTP pour {$username}: {$otp}");
        }
    }

    private static function send(string $to, string $subject, string $html, string $text, array $headers = []): bool
    {
        Mail::html($html, function ($m) use ($to, $subject, $text, $headers) {
            $m->to($to)->subject($subject)->text($text);
            foreach ($headers as $k => $v) {
                $m->getSymfonyMessage()->getHeaders()->addTextHeader($k, $v);
            }
        });

        return true;
    }

    public static function sendOtp(string $to, string $username, string $otp): bool
    {
        self::devOtp($username, $otp);
        if (! self::configured()) {
            Log::info("[MFA] Envoi email simule vers {$to}.");

            return true;
        }
        $u = e($username);
        try {
            return self::send($to, 'Votre code de securite Remontada Prospectia',
                "<div style=\"font-family: Arial, sans-serif; max-width: 520px; margin: auto; padding: 28px;\"><h2 style=\"color: #e31e24;\">Remontada Prospectia</h2><p>Bonjour <strong>{$u}</strong>,</p><p>Votre code de securite temporaire est :</p><p style=\"font-size: 32px; font-weight: bold; letter-spacing: 8px;\">{$otp}</p><p>Ce code est valable pendant 10 minutes. Ne le communiquez a personne.</p></div>",
                "Bonjour {$username}, votre code de securite est {$otp}. Il est valable pendant 10 minutes.");
        } catch (\Throwable $e) {
            Log::error('[MAIL] Echec envoi OTP: '.$e->getMessage());

            return false;
        }
    }

    public static function sendPasswordReset(string $to, string $username, string $otp): bool
    {
        if (! self::configured()) {
            Log::info("[PASSWORD_RESET] Envoi email simule vers {$to}.");
            self::devOtp($username, $otp);

            return true;
        }
        $u = e($username);
        try {
            return self::send($to, 'Reinitialisation de votre mot de passe Remontada Prospectia',
                "<div style=\"font-family: Arial, sans-serif; max-width: 520px; margin: auto; padding: 28px;\"><h2 style=\"color: #e31e24;\">Reinitialisation du mot de passe</h2><p>Bonjour <strong>{$u}</strong>,</p><p>Utilisez le code suivant pour definir un nouveau mot de passe :</p><p style=\"font-size: 32px; font-weight: bold; letter-spacing: 8px;\">{$otp}</p><p>Ce code est valable pendant 10 minutes et ne peut etre utilise qu'une fois.</p><p>Si vous n'avez pas demande cette operation, ignorez cet email.</p></div>",
                "Bonjour {$username}, votre code de reinitialisation est {$otp}. Il est valable pendant 10 minutes.");
        } catch (\Throwable $e) {
            Log::error('[MAIL] Echec envoi reset: '.$e->getMessage());

            return false;
        }
    }

    public static function sendInitialPasswordSetup(string $to, array $user): bool
    {
        if (! self::configured()) {
            Log::error('[MAIL] SMTP non configure. Invitation de creation de mot de passe non envoyee.');

            return false;
        }
        $name = e($user['fullName'] ?: $user['username']);
        $login = e($user['username']);
        $url = e($user['setupUrl']);
        try {
            return self::send($to, 'Vos acces Remontada Prospectia',
                "<div style=\"font-family: Arial, sans-serif; max-width: 560px; margin: auto; padding: 28px;\"><h2 style=\"color: #e31e24;\">Bienvenue sur Remontada Prospectia</h2><p>Bonjour <strong>{$name}</strong>,</p><p>Votre compte a ete cree.</p><div style=\"background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 16px; margin: 18px 0;\"><p style=\"margin: 0 0 8px;\"><strong>Identifiant :</strong> {$login}</p><p style=\"margin: 0 0 8px;\"><strong>Code de creation du mot de passe :</strong> {$user['otp']}</p><p style=\"margin: 0;\"><a href=\"{$url}\" style=\"color: #e31e24; font-weight: bold;\">Definir mon mot de passe</a></p></div><p>Ce lien et ce code sont temporaires et ne peuvent etre utilises qu'une seule fois.</p><p>Ne transferez pas cet email et ne communiquez jamais ce code.</p></div>",
                "Bonjour {$user['fullName']}, votre compte a ete cree. Identifiant: {$user['username']}. Definissez votre mot de passe avec ce lien: {$user['setupUrl']}. Code: {$user['otp']}.");
        } catch (\Throwable $e) {
            Log::error('[MAIL] Echec envoi invitation: '.$e->getMessage());

            return false;
        }
    }

    /** Utilisé par le worker de livraison : lève une exception en cas d'échec pour le retry. */
    public static function sendNotification(string $to, string $title, string $message, int $notificationId): void
    {
        if (! self::configured()) {
            throw new \RuntimeException('SMTP_NOT_CONFIGURED');
        }
        Mail::raw($message, function ($m) use ($to, $title, $notificationId) {
            $m->to($to)->subject($title);
            $m->getSymfonyMessage()->getHeaders()->addIdHeader('Message-ID', "objective-notification-{$notificationId}@remontada.cm");
        });
    }
}
