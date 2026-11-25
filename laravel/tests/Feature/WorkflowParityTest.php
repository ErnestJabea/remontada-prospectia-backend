<?php

namespace Tests\Feature;

use App\Services\JwtService;
use Illuminate\Foundation\Testing\DatabaseTransactions;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

/**
 * Parcours métier complet. Le test crée ses propres données (référentiel,
 * utilisateurs, KPI) : il tourne aussi bien sur la base vide de la CI
 * (schéma baseline-node.sql) que sur une base de développement.
 * DatabaseTransactions annule toutes les écritures à la fin de chaque test ;
 * les fichiers (PDF) sont écrits dans un dossier temporaire.
 */
class WorkflowParityTest extends TestCase
{
    use DatabaseTransactions;

    private array $users = [];

    private array $geo = [];

    private object $kpi;

    protected function setUp(): void
    {
        parent::setUp();
        config(['remontada.upload_root' => sys_get_temp_dir().'/remontada-test-uploads']);
        $tag = strtoupper(substr(uniqid(), -6));
        $country = DB::table('crm_ref_countries')->insertGetId(['code' => "T{$tag}", 'name' => "Pays {$tag}"]);
        $region = DB::table('crm_ref_regions')->insertGetId(['code' => "R{$tag}", 'name' => "Région {$tag}", 'country_id' => $country]);
        $department = DB::table('crm_ref_departments')->insertGetId(['code' => "D{$tag}", 'name' => "Département {$tag}", 'region_id' => $region]);
        $city = DB::table('crm_ref_cities')->insertGetId(['name' => "Ville {$tag}", 'department_id' => $department]);
        $this->geo = ['region_id' => $region, 'department_id' => $department, 'city_id' => $city];
        $hash = password_hash('Test-password-123!', PASSWORD_BCRYPT, ['cost' => 4]);
        foreach (['COMMERCIAL' => $city, 'DIRECTION' => null] as $role => $baseCity) {
            $id = DB::table('users')->insertGetId([
                'username' => strtolower("t-{$role}-{$tag}"), 'password' => $hash, 'full_name' => "Test {$role} {$tag}",
                'email' => strtolower("t-{$role}-{$tag}@example.test"), 'role' => $role, 'is_active' => 1, 'is_verified' => 1, 'base_city_id' => $baseCity,
            ]);
            $this->users[$role] = (array) DB::selectOne('SELECT * FROM users WHERE id=?', [$id]);
        }
        $domain = DB::table('objectif_domaines')->insertGetId(['code' => "DOM{$tag}", 'name' => "Domaine {$tag}"]);
        $kpi = DB::table('kpis')->insertGetId(['code' => "KPI{$tag}", 'name' => "Missions {$tag}", 'domain_id' => $domain, 'type' => 'QUANTITATIVE', 'unit' => 'missions', 'calculation_source' => 'MISSIONS']);
        $this->kpi = (object) ['id' => $kpi, 'domain_id' => $domain];
    }

    private function as(string $role): static
    {
        $token = app(JwtService::class)->createAccessToken($this->users[$role], 'mobile_pwa');

        return $this->withHeaders(['Authorization' => "Bearer {$token}", 'Accept' => 'application/json']);
    }

    private function cityGeo(): array
    {
        return $this->geo;
    }

    public function test_full_mission_report_and_opportunity_lifecycle(): void
    {
        $commercialId = (int) $this->users['COMMERCIAL']['id'];
        $kpi = $this->kpi;

        // 1. Objectif créé par la direction, soumis puis validé
        $objective = $this->as('DIRECTION')->postJson('/api/v1/objectives', [
            'title' => 'Objectif test Laravel', 'period_type' => 'MONTHLY', 'start_date' => date('Y-m-01'), 'end_date' => date('Y-m-t'),
            'domain_id' => $kpi->domain_id, 'kpi_id' => $kpi->id, 'target_value' => 10, 'responsible_id' => $commercialId,
        ])->assertCreated()->json('id');
        $this->as('DIRECTION')->postJson("/api/v1/objectives/{$objective}/submit")->assertOk();
        $this->as('DIRECTION')->postJson("/api/v1/objectives/{$objective}/validate", ['action' => 'VALIDATE'])->assertOk()->assertJsonPath('message', 'Objectif mis à jour avec le statut : ASSIGNED');

        // 2. Prospect déclaré par le commercial
        $geo = $this->cityGeo();
        $institution = $this->as('COMMERCIAL')->postJson('/api/v1/institutions', ['name' => 'Institution test '.uniqid(), 'type' => 'PROSPECT'] + $geo)->assertCreated()->json('id');

        // 3. Mission : création, soumission, Gate 1, ordre PDF, vérification publique
        $mission = $this->as('COMMERCIAL')->postJson('/api/v1/missions', [
            'objective_id' => $objective, 'title' => 'Mission test', 'scheduled_date' => date('Y-m-d', strtotime('+2 days')),
            'targets' => [['institution_id' => $institution, 'priority' => 'HIGH']], 'key_questions' => "Q1\nQ2",
        ])->assertCreated()->assertJsonPath('travel_scope', 'IN_CITY')->json('id');
        $this->as('COMMERCIAL')->postJson("/api/v1/missions/{$mission}/actions", ['action' => 'VALIDATE_GATE1'])->assertForbidden();
        $this->as('COMMERCIAL')->postJson("/api/v1/missions/{$mission}/actions", ['action' => 'SUBMIT'])->assertOk();
        $this->as('DIRECTION')->postJson("/api/v1/missions/{$mission}/actions", ['action' => 'VALIDATE_GATE1'])->assertOk();
        $pdf = $this->as('COMMERCIAL')->get("/api/v1/missions/{$mission}/order.pdf")->assertOk();
        $this->assertStringContainsString('application/pdf', $pdf->headers->get('Content-Type'));
        $token = DB::selectOne('SELECT order_verification_token t FROM crm_missions WHERE id=?', [$mission])->t;
        $this->get("/api/v1/missions/{$mission}/order/verify?token={$token}")->assertOk()->assertSee('Ordre de mission valide');
        $this->get("/api/v1/missions/{$mission}/order/verify?token=".str_repeat('a', 64))->assertNotFound();

        // 4. Exécution terrain → brouillon de rapport automatique
        $this->as('COMMERCIAL')->postJson("/api/v1/missions/{$mission}/actions", ['action' => 'START', 'check_in_latitude' => 3.85, 'check_in_longitude' => 11.5])->assertOk();
        $this->as('COMMERCIAL')->postJson("/api/v1/missions/{$mission}/actions", ['action' => 'COMPLETE'])->assertOk();
        $detail = $this->as('COMMERCIAL')->getJson("/api/v1/missions/{$mission}")->assertOk();
        $this->assertMatchesRegularExpression('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/', $detail->json('created_at'), 'Dates au format ISO UTC comme mysql2.');
        $this->assertCount(1, $detail->json('targets'));
        $report = $detail->json('report.id');
        $this->assertNotNull($report);

        // 5. Rapport : complétion, soumission (Gate 2), validation + PDF
        $this->as('COMMERCIAL')->postJson("/api/v1/reports/{$report}/submit")->assertStatus(400);
        $this->as('COMMERCIAL')->putJson("/api/v1/reports/{$report}", ['executive_summary' => 'Synthèse', 'results' => 'Résultats', 'institution_id' => $institution])->assertOk();
        $this->as('COMMERCIAL')->postJson("/api/v1/reports/{$report}/submit")->assertOk()->assertJsonPath('newStatus', 'SOUMIS');
        $this->as('COMMERCIAL')->postJson("/api/v1/reports/{$report}/validate")->assertForbidden();
        $this->as('DIRECTION')->postJson("/api/v1/reports/{$report}/validate")->assertOk()->assertJsonPath('newStatus', 'VALIDE');
        $this->assertSame('CLOSED', DB::selectOne('SELECT status FROM crm_missions WHERE id=?', [$mission])->status);
        $this->as('COMMERCIAL')->get("/api/v1/reports/{$report}/download-pdf")->assertOk();

        // 6. Opportunité : détection, soumission, validation, plan d'action avec relance
        $opp = $this->as('COMMERCIAL')->postJson('/api/v1/opportunities', ['institution_id' => $institution, 'title' => 'Opp test', 'need_description' => 'Besoin', 'estimated_amount' => 1500000])->assertCreated()->json('id');
        $this->as('COMMERCIAL')->postJson("/api/v1/opportunities/{$opp}/submit")->assertOk();
        $this->as('COMMERCIAL')->postJson("/api/v1/opportunities/{$opp}/submit")->assertStatus(409);
        $this->as('DIRECTION')->postJson("/api/v1/opportunities/{$opp}/validate")->assertOk();
        $due = date('Y-m-d\TH:i', strtotime('+5 days'));
        $this->as('COMMERCIAL')->postJson("/api/v1/opportunities/{$opp}/create-action-plan", ['actions' => [['title' => 'Relancer', 'action_type' => 'relance', 'due_at_cameroon' => $due]]])->assertOk();
        $this->assertSame(4, (int) DB::selectOne("SELECT COUNT(*) n FROM followup_reminders r JOIN crm_opportunity_actions a ON a.id=r.action_id WHERE a.opportunity_id=? AND r.status='scheduled'", [$opp])->n);
        $this->as('COMMERCIAL')->getJson('/api/v1/opportunities/pipeline')->assertOk()->assertJsonCount(1, 'ACTION_PLAN');

        // 7. Synchronisation PWA idempotente
        $actions = ['actions' => [
            ['id' => 'local-'.uniqid(), 'type' => 'prospect', 'action' => 'create', 'payload' => ['name' => 'Prospect sync '.uniqid(), 'type' => 'PROSPECT'] + $geo],
            ['id' => 'local-'.uniqid(), 'type' => 'opportunity', 'action' => 'add_comment', 'payload' => ['id' => $opp, 'comment' => 'Vu sur le terrain']],
        ]];
        $first = $this->as('COMMERCIAL')->postJson('/api/v1/sync/push', $actions)->assertOk()->assertJsonPath('successCount', 2);
        $again = $this->as('COMMERCIAL')->postJson('/api/v1/sync/push', $actions)->assertOk()->assertJsonPath('successCount', 2);
        $this->assertSame($first->json('results.0.serverId'), $again->json('results.0.serverId'), 'Le rejeu ne doit pas recréer le prospect.');

        // 8. Habilitations
        $this->as('COMMERCIAL')->getJson('/api/v1/security/audit-logs')->assertForbidden();
        $this->as('DIRECTION')->postJson('/api/v1/sync/push', ['actions' => []])->assertForbidden();
    }

    public function test_notification_stream_snapshot_mode_returns_one_event_and_closes(): void
    {
        config(['remontada.notifications.stream_mode' => 'snapshot', 'remontada.notifications.retry_ms' => 20000]);
        $response = $this->as('COMMERCIAL')->get('/api/v1/notifications/stream')->assertOk();
        $this->assertStringContainsString('text/event-stream', $response->headers->get('Content-Type'));
        $body = $response->streamedContent();
        $this->assertStringStartsWith("retry: 20000\n\n", $body);
        $this->assertSame(1, substr_count($body, 'data: '));
        $this->assertArrayHasKey('notifications', json_decode(trim(explode('data: ', $body)[1]), true));
    }

    public function test_cookie_channel_rejects_foreign_origin_and_bearer_mismatch(): void
    {
        $token = app(JwtService::class)->createAccessToken($this->users['DIRECTION'], 'web_portal');
        $this->withCredentials()->withUnencryptedCookie('crm_access', $token)->getJson('/api/v1/auth/me')->assertOk()->assertJsonPath('user.id', (int) $this->users['DIRECTION']['id']);
        $this->withCredentials()->withUnencryptedCookie('crm_access', $token)->withHeader('Origin', 'https://evil.example')->postJson('/api/v1/auth/toggle-mfa', ['enabled' => false])->assertForbidden();
        // Un jeton « web_portal » présenté en Bearer est refusé (canal incompatible).
        $this->withCredentials = false;
        $this->unencryptedCookies = [];
        $this->withHeader('Authorization', "Bearer {$token}")->getJson('/api/v1/auth/me')->assertUnauthorized();
    }
}
