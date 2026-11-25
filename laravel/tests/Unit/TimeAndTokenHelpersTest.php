<?php

namespace Tests\Unit;

use App\Exceptions\ApiException;
use App\Services\CameroonTime;
use App\Services\JwtService;
use App\Support\Rows;
use Tests\TestCase;

class TimeAndTokenHelpersTest extends TestCase
{
    public function test_cameroon_deadline_is_converted_to_utc(): void
    {
        // Le Cameroun est en UTC+1 toute l'année.
        $this->assertSame('2026-09-20 13:30:00', CameroonTime::parseDeadline('2026-09-20T14:30'));
        $this->assertSame('2026-12-31 23:15:00', CameroonTime::parseDeadline('2027-01-01T00:15'));
        $this->assertSame('20/09/2026 14:30', CameroonTime::formatDeadline('2026-09-20 13:30:00'));
    }

    public function test_invalid_cameroon_deadlines_are_rejected(): void
    {
        foreach (['2026-02-30T10:00', '2026-09-20 14:30', '', null, '2026-09-20T25:00'] as $value) {
            try {
                CameroonTime::parseDeadline($value);
                $this->fail('Date acceptée à tort : '.var_export($value, true));
            } catch (ApiException $e) {
                $this->assertSame(400, $e->status);
            }
        }
    }

    public function test_datetimes_are_serialized_like_mysql2(): void
    {
        config(['remontada.db_timezone' => 'Africa/Douala']);
        $row = Rows::normalize(['created_at' => '2026-07-15 10:00:00', 'scheduled_date' => '2026-07-15', 'title' => '2026-07-15 10:00:00 réunion', 'n' => 3]);

        $this->assertSame('2026-07-15T09:00:00.000Z', $row['created_at']);
        $this->assertSame('2026-07-15', $row['scheduled_date'], 'Une colonne DATE reste inchangée.');
        $this->assertSame('2026-07-15 10:00:00 réunion', $row['title'], 'Un texte libre n\'est pas converti.');
        $this->assertSame(3, $row['n']);
    }

    public function test_jwt_lifetimes_match_jsonwebtoken_syntax(): void
    {
        $this->assertSame(3600, JwtService::seconds('1h'));
        $this->assertSame(604800, JwtService::seconds('7d'));
        $this->assertSame(900, JwtService::seconds('15m'));
        $this->assertSame(45, JwtService::seconds('45'));
    }
}
