@extends('pdf.layout')
@section('title', "Rapport d'activité ".($r['code'] ?? ''))
@section('subtitle', "Rapport d'Activité Commerciale — ".($r['code'] ?: 'RAPPORT #'.$r['id']))
@php
    $statuses = ['BROUILLON_AUTO' => 'Brouillon automatique', 'A_COMPLETER' => 'A completer', 'DRAFT' => 'Brouillon', 'SUBMITTED' => 'Soumis', 'SOUMIS' => 'Soumis', 'EN_VALIDATION' => 'En validation', 'CORRECTION_DEMANDEE' => 'Correction demandee', 'VALIDATED' => 'Valide', 'VALIDE' => 'Valide', 'REJECTED' => 'Rejete', 'REJETE' => 'Rejete', 'ARCHIVED' => 'Archive', 'ARCHIVE' => 'Archive'];
    $code = strtoupper(trim((string) $r['status']));
    $color = in_array($code, ['VALIDE', 'VALIDATED']) ? '#047857' : (in_array($code, ['REJETE', 'REJECTED', 'CORRECTION_DEMANDEE']) ? '#b91c1c' : '#d97706');
    $block = fn ($label, $text) => $text ? '<p class="label">'.e($label).'</p><div class="block">'.e($text).'</div>' : '';
@endphp
@section('content')
<div class="hero"><h1>RAPPORT D'ACTIVITE</h1><p style="color:{{ $color }}">STATUT : {{ mb_strtoupper($statuses[$code] ?? $r['status']) }}</p></div>

<h2>Identification</h2>
<table class="fields">
    <tr><td class="l">Code Rapport :</td><td>{{ $r['code'] }}</td><td class="l">Type :</td><td>{{ $r['report_type'] === 'mission_report' ? 'Mission' : 'Activité' }}</td></tr>
    <tr><td class="l">Commercial :</td><td>{{ $r['commercial_name'] }}</td><td class="l">Créé le :</td><td>{{ \App\Support\PdfFormat::dateTime($r['created_at']) }}</td></tr>
    <tr><td class="l">Date début :</td><td>{{ \App\Support\PdfFormat::date($r['period_start']) }}</td><td class="l">Date fin :</td><td>{{ \App\Support\PdfFormat::date($r['period_end']) }}</td></tr>
</table>

@if ($r['mission_id'])
    <h2>Rappel de la mission</h2>
    <table class="fields">
        <tr><td class="l">Mission :</td><td>{{ $r['mission_title'] }}</td><td class="l">Objectif lié :</td><td>{{ $r['objective_title'] }}</td></tr>
        <tr><td class="l">Institution ciblée :</td><td>{{ $r['institution_name'] }}</td><td class="l">Date mission :</td><td>{{ \App\Support\PdfFormat::date($r['scheduled_date']) }}</td></tr>
        <tr><td class="l">Zone :</td><td>{{ $r['city_name'] ?: '-' }} / {{ $r['department_name'] ?: '-' }} / {{ $r['region_name'] ?: '-' }}</td><td class="l">Durée :</td><td>{{ $r['duration_hours'] ?: 2 }} heure(s)</td></tr>
    </table>
@else
    <h2>Institution cible</h2>
    <table class="fields"><tr><td class="l">Nom Institution :</td><td>{{ $r['institution_name'] ?: '-' }}</td></tr><tr><td class="l">Adresse :</td><td>{{ $r['institution_address'] ?: '-' }}</td></tr></table>
@endif

<h2>Déroulement et Synthèse</h2>
{!! $block('Résumé exécutif', $r['executive_summary']) !!}
{!! $block('Résultats obtenus', $r['results']) !!}
{!! $block('Personnes rencontrées / Administrations visitées', $r['persons_met'] ?: $r['administrations_visited']) !!}
@if ($r['diagnosis'])<h2>Diagnostic et Constats</h2>{!! $block('Analyse documentaire et terrain', $r['diagnosis']) !!}@endif
@if ($r['difficulties'])<h2>Difficultés rencontrées</h2>{!! $block('Obstacles et contraintes', $r['difficulties']) !!}@endif
@if ($r['recommendations'] || $r['next_steps'])
    <h2>Recommandations et Suites proposées</h2>
    {!! $block('Recommandations', $r['recommendations']) !!}
    {!! $block('Suites à donner / Actions de suivi', $r['next_steps']) !!}
@endif

@if (count($opps))
    <h2>Opportunités détectées ou rattachées</h2>
    @foreach ($opps as $o)
        <div class="card"><strong>{{ $o->title }}</strong>
            <div class="muted">Lien: {{ $o->relation_type }} | Montant: {{ number_format((float) $o->estimated_amount, 0, ',', ' ') }} XAF | Priorite: {{ $o->priority }} | Statut: {{ $o->status }}</div></div>
    @endforeach
@endif

<h2>Approbation et Suivi (GATE 2)</h2>
<table class="fields">
    <tr><td class="l">Soumis par :</td><td>{{ $r['submitted_by_name'] ?: '-' }}</td><td class="l">Date soumission :</td><td>{{ \App\Support\PdfFormat::dateTime($r['submitted_at']) }}</td></tr>
    <tr><td class="l">Approuvé par :</td><td>{{ $r['validated_by_name'] ?: '-' }}</td><td class="l">Date approbation :</td><td>{{ \App\Support\PdfFormat::dateTime($r['validated_at']) }}</td></tr>
</table>
{!! $block('Motif du rejet', $r['rejection_reason']) !!}
{!! $block('Commentaire de correction demandée', $r['correction_comment']) !!}
@endsection
