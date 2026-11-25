@extends('pdf.layout')
@section('title', 'Ordre de mission '.$m['mission_reference'])
@section('subtitle', 'ORDRE DE MISSION AUTHENTIFIE')
@php
    $roles = ['DECIDEUR_PRINCIPAL' => 'Decideur principal', 'PRESCRIPTEUR_TECHNIQUE' => 'Prescripteur technique', 'INFLUENCEUR' => 'Influenceur', 'AUTRE' => 'Autre contact'];
    $strategic = ['OBTENIR_RDV' => 'Obtenir un rendez-vous', 'IDENTIFIER_BESOIN' => 'Identifier un besoin', 'QUALIFIER_OPPORTUNITE' => 'Qualifier une opportunite', 'PREPARER_OFFRE' => 'Preparer une offre', 'CARTOGRAPHIER_ACTEURS' => 'Cartographier les acteurs', 'INTELLIGENCE_ECONOMIQUE' => 'Intelligence economique', 'AUTRE' => 'Autre'];
    $transport = ['SERVICE_VEHICLE' => 'Véhicule de service', 'PERSONAL_VEHICLE' => 'Véhicule personnel', 'PUBLIC_TRANSPORT' => 'Transport public', 'AIR' => 'Avion', 'OTHER' => 'Autre'];
    $listOrDash = fn ($items) => $items ? '<ul>'.collect($items)->map(fn ($i) => '<li>'.e(is_array($i) ? json_encode($i) : $i).'</li>')->implode('').'</ul>' : '<p>-</p>';
@endphp
@section('content')
<div class="hero"><h1>ORDRE DE MISSION</h1><p>Reference {{ $m['mission_reference'] }}</p></div>

<h2>Identification</h2>
<table class="fields">
    <tr><td class="l">Mission :</td><td>{{ $m['title'] }}</td></tr>
    <tr><td class="l">Objectif rattache :</td><td>{{ $m['objective_title'] }}</td></tr>
    <tr><td class="l">Cibles planifiees :</td><td>{{ $targets ? collect($targets)->pluck('institution_name')->implode(' -> ') : $m['institution_name'] }}</td></tr>
    <tr><td class="l">Adresse institution :</td><td>{{ $m['institution_address'] ?: '-' }}</td></tr>
    <tr><td class="l">Zone :</td><td>{{ $m['city_name'] ?: '-' }} / {{ $m['department_name'] ?: '-' }} / {{ $m['region_name'] ?: '-' }}</td></tr>
    <tr><td class="l">Type de déplacement :</td><td>{{ $travelLabel }}</td></tr>
    <tr><td class="l">Ville de rattachement :</td><td>{{ $m['base_city_name'] ?: '-' }}</td></tr>
    @if ($m['travel_scope'] === 'OUT_OF_CITY')
        <tr><td class="l">Départ :</td><td>{{ \App\Support\PdfFormat::dateTime($m['departure_at']) }}</td></tr>
        <tr><td class="l">Retour :</td><td>{{ \App\Support\PdfFormat::dateTime($m['return_at']) }}</td></tr>
        <tr><td class="l">Transport :</td><td>{{ $transport[$m['transport_mode']] ?? ($m['transport_mode'] ?: '-') }}</td></tr>
        <tr><td class="l">Hébergement :</td><td>{{ $m['accommodation_required'] ? 'Oui' : 'Non' }}</td></tr>
        <tr><td class="l">Coût estimatif :</td><td>{{ number_format((float) $m['estimated_travel_cost'], 0, ',', ' ') }} FCFA</td></tr>
    @endif
    <tr><td class="l">Date prevue :</td><td>{{ \App\Support\PdfFormat::date($m['scheduled_date']) }}</td></tr>
    <tr><td class="l">Duree :</td><td>{{ $m['duration_hours'] ?: 2 }} heure(s)</td></tr>
    <tr><td class="l">Validation Gate 1 :</td><td>{{ \App\Support\PdfFormat::dateTime($m['gate1_validated_at']) }}</td></tr>
</table>

<h2>Equipe mission</h2>
<table class="fields">
    <tr><td class="l">Commercial principal :</td><td>{{ $m['primary_commercial_name'] }}</td></tr>
    <tr><td class="l">Contact principal :</td><td>{{ collect([$m['primary_commercial_phone'], $m['primary_commercial_email']])->filter()->implode(' / ') ?: '-' }}</td></tr>
</table>
<p class="label">Equipe associee :</p>
@forelse ($associates as $a)
    <div>- {{ $a->full_name }}{{ $a->phone ? ' / '.$a->phone : '' }}{{ $a->email ? ' / '.$a->email : '' }}</div>
@empty
    <div>- Aucune personne associee</div>
@endforelse

<h2>Objectif et resultat attendu</h2>
<table class="fields">
    <tr><td class="l">Type de mission :</td><td>{{ $m['mission_type'] ?: 'PROSPECTION' }}</td></tr>
    <tr><td class="l">Objectif strategique :</td><td>{{ $strategic[$m['strategic_objective']] ?? ($m['strategic_objective'] ?: '-') }}</td></tr>
    <tr><td class="l">Resultat attendu :</td><td>{{ $m['expected_result'] ?: '-' }}</td></tr>
    @if ($m['description'])<tr><td class="l">Contexte :</td><td>{{ $m['description'] }}</td></tr>@endif
</table>

<h2>Etapes de la tournee ({{ count($targets) ?: 1 }})</h2>
@forelse ($targets as $i => $t)
    <div class="card">
        <strong>{{ $i + 1 }}. {{ $t['institution_name'] }} - {{ $t['city_name'] ?: 'Ville non renseignee' }}</strong>
        <div class="muted">Priorite {{ strtolower($t['priority'] ?: 'MEDIUM') }} / Potentiel {{ strtolower($t['potential'] ?: 'MEDIUM') }}@if ($t['contact_name']) / Contact {{ $t['contact_name'] }}{{ $t['contact_role'] ? ' ('.$t['contact_role'].')' : '' }}@endif</div>
        @if ($t['opportunity'])
            <div style="color:#b45309;font-weight:bold;margin-top:4px">Opportunite : {{ $t['opportunity']['title'] }}</div>
            <div class="muted">{{ $t['opportunity']['need_description'] ?: '-' }}</div>
        @endif
    </div>
@empty
    <div>1. {{ $m['institution_name'] }}</div>
@endforelse

<h2>Personnes de contact ciblees</h2>
@forelse ($contacts as $c)
    <div><strong>{{ $roles[$c['role'] ?? ''] ?? ($c['role'] ?? 'Contact') }}</strong> - {{ $c['name'] ?? '-' }}</div>
    @if ($line = collect([$c['phone'] ?? null, $c['email'] ?? null])->filter()->implode(' / '))<div class="muted">&nbsp;&nbsp;Contact : {{ $line }}</div>@endif
@empty
    <div>- Aucun contact cible renseigne</div>
@endforelse

<h2>Plan de visite</h2>
<p class="label">Approches :</p>{!! $listOrDash($lists('visit_approach')) !!}
<p class="label">Questions critiques :</p>{!! $listOrDash($lists('key_questions')) !!}
<p class="label">Messages cles a delivrer :</p>{!! $listOrDash($lists('key_messages')) !!}

<h2>Risques et mesures</h2>
<p class="label">Hypotheses de besoin :</p>{!! $listOrDash($lists('need_hypotheses')) !!}
<p class="label">Risques identifies :</p>{!! $listOrDash($lists('risks')) !!}
<table class="fields"><tr><td class="l">Mesures prevues :</td><td>{{ $m['planned_measures'] ?: '-' }}</td></tr></table>

<h2>Validation</h2>
<p>La presente mission est autorisee apres validation hierarchique. Le commercial est mandate pour conduire la visite, recueillir les informations utiles et produire le reporting attendu.</p>
<table class="fields">
    <tr><td class="l">Valide par :</td><td>{{ $validator }}</td></tr>
    <tr><td class="l">Email validateur :</td><td>{{ $m['validator_email'] ?: '-' }}</td></tr>
</table>
<p class="muted">Scannez le QR code pour controler le statut actuel de cet ordre de mission.</p>
<table style="width:100%;background:#f8fafc;border:1px solid #cbd5e1;border-radius:10px;page-break-inside:avoid"><tr>
    <td style="padding:14px;vertical-align:top">
        <strong>SIGNATURE ELECTRONIQUE DU VALIDATEUR</strong><div class="muted">{{ $validator }}</div>
        <div style="margin-top:10px;background:#ecfdf5;border:1px solid #a7f3d0;border-radius:7px;padding:8px">
            <strong style="color:#047857">SIGNE NUMERIQUEMENT</strong><div class="muted" style="font-size:6.7pt">{{ $signature }}</div>
        </div>
    </td>
    <td style="width:130px;text-align:center;padding:8px"><img src="{{ $qr }}" style="width:112px;height:112px"><div class="muted">Scanner pour verifier</div></td>
</tr></table>
@endsection
