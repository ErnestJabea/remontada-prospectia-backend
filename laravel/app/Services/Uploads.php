<?php

namespace App\Services;

use App\Exceptions\ApiException;
use Illuminate\Http\Request;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Str;
use Symfony\Component\HttpFoundation\BinaryFileResponse;

/**
 * Reprise de multer + utils/uploadSecurity.js :
 *  - 5 fichiers max, 10 Mo chacun, couple MIME/extension sur liste blanche
 *  - vérification de la signature binaire (magic bytes)
 *  - noms de stockage aléatoires, chemin confiné à la racine d'upload
 * Les chemins sont stockés relativement ("missions/<uuid>.pdf") ; les
 * chemins absolus hérités de Node sont résolus par leurs deux derniers segments.
 */
class Uploads
{
    private const TYPES = [
        'application/pdf' => ['pdf'],
        'image/jpeg' => ['jpg', 'jpeg'],
        'image/png' => ['png'],
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document' => ['docx'],
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' => ['xlsx'],
    ];

    public static function root(): string
    {
        return rtrim(str_replace('\\', '/', config('remontada.upload_root')), '/');
    }

    /** @return array<int, array{file_name:string,file_path:string,file_size:int}> */
    public static function storeAll(Request $request, string $folder): array
    {
        $files = $request->file('files');
        $files = $files instanceof UploadedFile ? [$files] : (array) $files;
        if (count($files) > 5) {
            throw ApiException::make(400, 'Trop de fichiers (5 maximum).');
        }
        foreach ($files as $f) {
            $ext = strtolower($f->getClientOriginalExtension());
            if (! $f->isValid() || $f->getSize() > 10 * 1024 * 1024 || ! in_array($ext, self::TYPES[$f->getClientMimeType()] ?? [], true)) {
                throw ApiException::make(400, 'Type de fichier non autorise.');
            }
            if (! self::validSignature($f->getRealPath(), $ext)) {
                throw ApiException::make(400, 'Contenu de fichier non autorise.');
            }
        }
        $stored = [];
        $dir = self::root().'/'.$folder;
        if (! is_dir($dir)) {
            mkdir($dir, 0750, true);
        }
        foreach ($files as $f) {
            $name = Str::uuid().'.'.strtolower($f->getClientOriginalExtension());
            $f->move($dir, $name);
            $stored[] = ['file_name' => basename($f->getClientOriginalName()), 'file_path' => "{$folder}/{$name}", 'file_size' => (int) filesize("{$dir}/{$name}")];
        }

        return $stored;
    }

    public static function validSignature(string $path, string $ext): bool
    {
        $h = @file_get_contents($path, false, null, 0, 8) ?: '';

        return match ($ext) {
            'pdf' => str_starts_with($h, '%PDF'),
            'png' => $h === "\x89PNG\r\n\x1a\n",
            'jpg', 'jpeg' => str_starts_with($h, "\xFF\xD8\xFF"),
            'docx', 'xlsx' => str_starts_with($h, 'PK'),
            default => false,
        };
    }

    public static function resolve(?string $stored): ?string
    {
        if (! $stored) {
            return null;
        }
        $normalized = str_replace('\\', '/', $stored);
        $parts = array_values(array_filter(explode('/', $normalized), fn ($p) => $p !== ''));
        if (count($parts) < 2) {
            return null;
        }
        $relative = $parts[count($parts) - 2].'/'.$parts[count($parts) - 1];
        if (str_contains($relative, '..')) {
            return null;
        }
        $full = self::root().'/'.$relative;
        $real = realpath($full);
        if (! $real || ! str_starts_with(str_replace('\\', '/', $real), str_replace('\\', '/', realpath(self::root()) ?: self::root()))) {
            return null;
        }

        return $real;
    }

    public static function delete(?string $stored): void
    {
        if ($p = self::resolve($stored)) {
            @unlink($p);
        }
    }

    public static function cleanup(array $stored): void
    {
        foreach ($stored as $s) {
            self::delete($s['file_path']);
        }
    }

    public static function download(?string $stored, string $name): ?BinaryFileResponse
    {
        $p = self::resolve($stored);

        return $p && is_file($p) ? response()->download($p, $name) : null;
    }
}
