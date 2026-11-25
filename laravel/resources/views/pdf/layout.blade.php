@php
    $logo = function (string $key) {
        $path = config("remontada.logos.$key");
        if (! is_file($path)) return null;
        $mime = str_ends_with($path, '.png') ? 'image/png' : 'image/jpeg';
        return "data:$mime;base64,".base64_encode(file_get_contents($path));
    };
@endphp
<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>@yield('title')</title>
<style>
    @page { margin: 120px 54px 60px 54px; }
    body { font-family: Helvetica, DejaVu Sans, sans-serif; font-size: 9pt; color: #111827; }
    header { position: fixed; top: -104px; left: -54px; right: -54px; height: 90px; border-bottom: 3px solid #e31e24; }
    header .logo-l { position: absolute; left: 58px; top: 17px; max-height: 54px; max-width: 68px; }
    header .logo-r { position: absolute; right: 54px; top: 21px; max-height: 46px; max-width: 84px; }
    header .brand { position: absolute; left: 138px; right: 138px; top: 22px; text-align: center; }
    header .brand strong { font-size: 16pt; color: #0f172a; display: block; }
    header .brand span { font-size: 8.5pt; color: #475569; font-weight: bold; letter-spacing: .3px; }
    footer { position: fixed; bottom: -40px; left: 0; right: 0; height: 20px; border-top: .5px solid #cbd5e1; font-size: 8pt; color: #64748b; padding-top: 6px; }
    footer .right { float: right; }
    footer .pagenum:before { content: counter(page); }
    footer .pagecount:before { content: counter(pages); }
    .hero { background: #fff5f5; border-radius: 12px; text-align: center; padding: 14px; margin-bottom: 8px; }
    .hero h1 { color: #e31e24; font-size: 20pt; margin: 0; }
    .hero p { margin: 6px 0 0; font-weight: bold; }
    h2 { background: #f1f5f9; border-left: 4px solid #e31e24; font-size: 10pt; text-transform: uppercase; padding: 5px 10px; margin: 14px 0 7px; color: #0f172a; }
    table.fields { width: 100%; border-collapse: collapse; }
    table.fields td { padding: 2px 0; vertical-align: top; }
    table.fields td.l { width: 126px; font-weight: bold; color: #475569; font-size: 8.4pt; }
    .card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 7px; padding: 8px 12px; margin-bottom: 6px; page-break-inside: avoid; }
    .muted { color: #475569; font-size: 7.8pt; }
    .label { font-weight: bold; color: #475569; margin-top: 6px; }
    .block { white-space: pre-wrap; margin: 2px 0 8px; }
    ul { margin: 2px 0 6px 16px; padding: 0; }
</style>
</head>
<body>
<header>
    @if ($src = $logo('inc'))<img class="logo-l" src="{{ $src }}">@endif
    @if ($src = $logo('ippc'))<img class="logo-r" src="{{ $src }}">@endif
    <div class="brand"><strong>REMONTADA PROSPECTIA</strong><span>@yield('subtitle')</span></div>
</header>
<footer>ERP Remontada Prospectia - Document confidentiel <span class="right">Page <span class="pagenum"></span> / <span class="pagecount"></span></span></footer>
@yield('content')
</body>
</html>
