<?php

namespace App\Services;

use App\Exceptions\ApiException;
use Barryvdh\DomPDF\Facade\Pdf;
use Illuminate\Support\Facades\DB;

/** Reprise de services/reportPdfService.js (PDFKit → Blade + Dompdf). */
class ReportPdf
{
    public static function generate(int $id): string
    {
        $r = DB::selectOne('SELECT rp.*, m.title AS mission_title, m.scheduled_date, m.duration_hours, o.title AS objective_title, i.name AS institution_name, i.address AS institution_address,
            u.full_name AS commercial_name, submitted.full_name AS submitted_by_name, validated.full_name AS validated_by_name, r.name AS region_name, d.name AS department_name, c.name AS city_name
            FROM crm_reports rp LEFT JOIN crm_missions m ON rp.mission_id = m.id LEFT JOIN crm_objectives o ON rp.objective_id = o.id LEFT JOIN crm_institutions i ON rp.institution_id = i.id
            LEFT JOIN users u ON rp.commercial_id = u.id LEFT JOIN users submitted ON rp.submitted_by = submitted.id LEFT JOIN users validated ON rp.validated_by = validated.id
            LEFT JOIN crm_ref_regions r ON m.region_id = r.id LEFT JOIN crm_ref_departments d ON m.department_id = d.id LEFT JOIN crm_ref_cities c ON m.city_id = c.id WHERE rp.id = ?', [$id]);
        if (! $r) {
            throw ApiException::make(404, 'Rapport introuvable.');
        }
        $opps = DB::select('SELECT o.title, o.estimated_amount, o.priority, o.status, ro.relation_type FROM crm_report_opportunities ro JOIN crm_opportunities o ON ro.opportunity_id = o.id WHERE ro.activity_report_id = ?', [$id]);
        $dir = Uploads::root().'/reports/pdf';
        if (! is_dir($dir)) {
            mkdir($dir, 0750, true);
        }
        $file = 'rapport-'.preg_replace('/[^A-Za-z0-9_-]/', '', (string) ($r->code ?: $id)).'.pdf';
        Pdf::loadView('pdf.report', ['r' => (array) $r, 'opps' => $opps])->setPaper('a4')->save("{$dir}/{$file}");
        DB::update('UPDATE crm_reports SET pdf_path = ? WHERE id = ?', ["reports/pdf/{$file}", $id]);

        return "{$dir}/{$file}";
    }

    /** Chemin confiné au dossier des PDF de rapports (anciens chemins "uploads/reports/pdf/x.pdf" acceptés). */
    public static function path(?string $stored): ?string
    {
        if (! $stored) {
            return null;
        }
        $file = basename(str_replace('\\', '/', $stored));
        $path = Uploads::root().'/reports/pdf/'.$file;

        return preg_match('/^[A-Za-z0-9_.-]+\.pdf$/', $file) && is_file($path) ? $path : null;
    }
}
