<?php

namespace App\Http\Controllers;

use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\DB;

/** Reprise de routes/security.js. */
class SecurityController extends Controller
{
    public function activeUsers(): JsonResponse
    {
        return $this->ok($this->rows(DB::select('SELECT id, username, full_name, role, last_activity, last_active_client FROM users WHERE last_activity >= DATE_SUB(NOW(), INTERVAL 15 MINUTE) AND is_active = TRUE ORDER BY last_activity DESC')));
    }

    public function loginHistory(): JsonResponse
    {
        return $this->ok($this->rows(DB::select('SELECT id, user_id, username, ip_address, user_agent, client_type, status, failure_reason, created_at FROM crm_login_history ORDER BY created_at DESC LIMIT 200')));
    }

    public function auditLogs(): JsonResponse
    {
        return $this->ok($this->rows(DB::select('SELECT l.id, l.user_id, u.username, u.full_name, l.action_type, l.module_name, l.old_value, l.new_value, l.ip_address, l.timestamp FROM crm_audit_logs l LEFT JOIN users u ON l.user_id = u.id ORDER BY l.timestamp DESC LIMIT 200')));
    }
}
