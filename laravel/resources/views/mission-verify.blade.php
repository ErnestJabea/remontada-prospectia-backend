@php
    $theme = match ($state) {
        'VALID' => ['color' => '#047857', 'soft' => '#ecfdf5', 'border' => '#a7f3d0', 'icon' => '&#10003;', 'label' => 'Ordre de mission valide'],
        'REVOKED' => ['color' => '#b45309', 'soft' => '#fffbeb', 'border' => '#fde68a', 'icon' => '!', 'label' => 'Ordre de mission révoqué'],
        default => ['color' => '#b91c1c', 'soft' => '#fef2f2', 'border' => '#fecaca', 'icon' => '&#215;', 'label' => 'Document non vérifié'],
    };
    $description = match ($state) {
        'VALID' => 'Cette référence correspond à un ordre de mission validé et actuellement autorisé dans Remontada Prospectia.',
        'REVOKED' => "Cette référence a existé, mais son statut actuel ne permet plus de l'utiliser comme ordre de mission valide.",
        default => 'Le lien est incomplet, invalide ou ne correspond à aucun ordre de mission authentifié.',
    };
    $reference = $m['mission_reference'] ?? ($m['id'] ?? 'inconnue');
    $fmt = fn ($v) => $v ? \Illuminate\Support\Carbon::parse($v)->locale('fr')->translatedFormat('j F Y \\à H:i') : '-';
@endphp
<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>Vérification d'un ordre de mission</title>
<style nonce="{{ $nonce }}">
:root{color-scheme:light;font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#0f172a;background:#f8fafc}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at top,#fff 0,#f8fafc 44%,#eef2f7 100%);padding:24px 16px}
main{width:min(680px,100%);margin:0 auto}.brand{display:flex;align-items:center;gap:12px;margin:0 0 18px}
.brand-mark{width:44px;height:44px;border-radius:13px;display:grid;place-items:center;background:#e31e24;color:#fff;font-weight:900}
.brand strong{display:block}.brand span{color:#64748b;font-size:.78rem}
.card{overflow:hidden;background:#fff;border:1px solid #e2e8f0;border-radius:24px;box-shadow:0 24px 70px rgba(15,23,42,.10)}
.status{padding:26px;background:{{ $theme['soft'] }};border-bottom:1px solid {{ $theme['border'] }}}.status-line{display:flex;align-items:center;gap:14px}
.status-icon{width:48px;height:48px;flex:0 0 48px;display:grid;place-items:center;border-radius:50%;color:#fff;background:{{ $theme['color'] }};font-size:1.45rem;font-weight:900}
.status-label{color:{{ $theme['color'] }};font-size:.76rem;font-weight:900;letter-spacing:.08em;text-transform:uppercase}
h1{margin:3px 0 0;font-size:clamp(1.35rem,5vw,2rem)}.status p{color:#475569;line-height:1.55;margin:15px 0 0}.content{padding:26px}
.details{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.details div{padding:14px;border:1px solid #e2e8f0;border-radius:14px;background:#f8fafc}
.details span,.sig span{display:block;margin-bottom:5px;color:#64748b;font-size:.72rem;font-weight:800;text-transform:uppercase}
.sig{margin-top:18px;padding:16px;border-radius:14px;background:#0f172a;color:#fff}.sig span{color:#94a3b8}code{display:block;overflow-wrap:anywhere;font-size:.8rem;color:#d1fae5}
footer{display:flex;justify-content:space-between;gap:12px;padding:18px 26px;border-top:1px solid #e2e8f0;color:#64748b;font-size:.72rem}
@media(max-width:560px){.details{grid-template-columns:1fr}footer{flex-direction:column}}
</style>
</head>
<body><main>
<div class="brand"><div class="brand-mark">RP</div><div><strong>Remontada Prospectia</strong><span>Vérification officielle des ordres de mission</span></div></div>
<article class="card">
    <header class="status"><div class="status-line"><div class="status-icon">{!! $theme['icon'] !!}</div><div><div class="status-label">{{ $theme['label'] }}</div><h1>{{ $state === 'VALID' ? 'Référence '.$reference : $theme['label'] }}</h1></div></div><p>{{ $description }}</p></header>
    <div class="content">
        @if ($m)
            <section class="details"><div><span>Référence</span><strong>{{ $reference }}</strong></div><div><span>Date de validation</span><strong>{{ $fmt($m['gate1_validated_at']) }}</strong></div></section>
            <section class="sig"><span>Empreinte numérique du document</span><code>{{ $signature }}</code></section>
        @else
            <p>Aucune donnée opérationnelle n’est affichée pour ce lien.</p>
        @endif
    </div>
    <footer><span>Contrôle effectué le {{ $fmt($checkedAt) }}</span><span>Ne pas se fier à une copie dont le QR code ne mène pas à cette page.</span></footer>
</article>
</main></body></html>
