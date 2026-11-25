<?php

use App\Http\Controllers\AnalyticsController;
use App\Http\Controllers\AuthController;
use App\Http\Controllers\HealthController;
use App\Http\Controllers\InstitutionController;
use App\Http\Controllers\MissionController;
use App\Http\Controllers\NotificationController;
use App\Http\Controllers\ObjectiveController;
use App\Http\Controllers\OpportunityController;
use App\Http\Controllers\PermissionController;
use App\Http\Controllers\ReferentialController;
use App\Http\Controllers\ReportController;
use App\Http\Controllers\SecurityController;
use App\Http\Controllers\SyncController;
use App\Http\Controllers\UserController;
use App\Http\Middleware\ApiVersionHeaders;
use App\Support\ApiResponse;
use Illuminate\Support\Facades\Route;

/*
| Contrat identique au backend Node.js : /api/v1/* (courant) et /api/*
| (hérité, signalé déprécié). Toutes les ressources sont privées par défaut.
*/
$api = function (string $as) {
    Route::get('health', HealthController::class);

    Route::prefix('auth')->group(function () {
        Route::post('login', [AuthController::class, 'login'])->middleware('throttle:login');
        Route::post('verify-mfa', [AuthController::class, 'verifyMfa'])->middleware('throttle:login');
        Route::post('resend-mfa', [AuthController::class, 'resendMfa'])->middleware('throttle:login');
        Route::post('forgot-password', [AuthController::class, 'forgotPassword'])->middleware('throttle:password');
        Route::post('reset-password', [AuthController::class, 'resetPassword'])->middleware('throttle:password');
        Route::post('refresh', [AuthController::class, 'refresh']);
        Route::post('logout', [AuthController::class, 'logout']);
        Route::middleware('jwt')->group(function () {
            Route::get('me', [AuthController::class, 'me']);
            Route::get('settings', [AuthController::class, 'getSettings']);
            Route::put('settings', [AuthController::class, 'putSettings']);
            Route::get('devices', [AuthController::class, 'devices']);
            Route::delete('devices/{id}', [AuthController::class, 'revokeDevice'])->whereNumber('id');
            Route::post('toggle-mfa', [AuthController::class, 'toggleMfa']);
        });
    });

    // Page publique : le jeton aléatoire du QR code fait office de preuve.
    Route::get('missions/{id}/order/verify', [MissionController::class, 'verify'])->whereNumber('id');

    Route::middleware('jwt')->group(function () {
        $managers = 'role:SYSTEM,DIRECTION,ADMIN';
        $admins = 'role:SYSTEM,ADMIN';

        Route::prefix('users')->middleware('feature:users')->group(function () use ($managers, $admins) {
            Route::get('/', [UserController::class, 'index'])->middleware($managers);
            Route::get('commercials', [UserController::class, 'commercials'])->middleware($managers);
            Route::get('job-descriptions/all', [UserController::class, 'jobDescriptions'])->middleware($managers);
            Route::get('{id}', [UserController::class, 'show']);
            Route::get('{id}/devices', [UserController::class, 'devices'])->whereNumber('id')->middleware($managers);
            Route::post('/', [UserController::class, 'store'])->middleware($managers);
            Route::put('{id}', [UserController::class, 'update'])->whereNumber('id')->middleware($managers);
            Route::put('{id}/password', [UserController::class, 'password'])->whereNumber('id')->middleware($admins);
            Route::delete('{id}', [UserController::class, 'destroy'])->whereNumber('id')->middleware($admins);
        });

        Route::prefix('referentials')->middleware('feature:referentials')->group(function () use ($managers) {
            $resources = implode('|', array_keys(ReferentialController::RESOURCES));
            Route::get('{resource}', [ReferentialController::class, 'index'])->where('resource', $resources);
            Route::post('{resource}', [ReferentialController::class, 'store'])->where('resource', $resources)->middleware($managers);
            Route::put('{resource}/{id}', [ReferentialController::class, 'update'])->where('resource', $resources)->whereNumber('id')->middleware($managers);
            Route::delete('{resource}/{id}', [ReferentialController::class, 'destroy'])->where('resource', $resources)->whereNumber('id')->middleware($managers);
        });

        Route::prefix('objectives')->middleware('feature:objectives')->group(function () {
            $catalog = 'role:DIRECTION,ADMIN';
            Route::get('domains', [ObjectiveController::class, 'domains']);
            Route::post('domains', [ObjectiveController::class, 'storeDomain'])->middleware($catalog);
            Route::put('domains/{id}', [ObjectiveController::class, 'updateDomain'])->whereNumber('id')->middleware($catalog);
            Route::delete('domains/{id}', [ObjectiveController::class, 'destroyDomain'])->whereNumber('id')->middleware($catalog);
            Route::get('kpis', [ObjectiveController::class, 'kpis']);
            Route::post('kpis', [ObjectiveController::class, 'storeKpi'])->middleware($catalog);
            Route::put('kpis/{id}', [ObjectiveController::class, 'updateKpi'])->whereNumber('id')->middleware($catalog);
            Route::delete('kpis/{id}', [ObjectiveController::class, 'destroyKpi'])->whereNumber('id')->middleware($catalog);
            Route::get('/', [ObjectiveController::class, 'index']);
            Route::post('proposals', [ObjectiveController::class, 'storeProposal'])->middleware('role:COMMERCIAL');
            Route::post('/', [ObjectiveController::class, 'store'])->middleware('role:DIRECTION,SYSTEM,ADMIN');
            Route::prefix('{id}')->whereNumber('id')->group(function () {
                Route::get('/', [ObjectiveController::class, 'show']);
                Route::put('proposal', [ObjectiveController::class, 'updateProposal'])->middleware('role:COMMERCIAL');
                Route::put('/', [ObjectiveController::class, 'update']);
                Route::delete('/', [ObjectiveController::class, 'destroy']);
                Route::post('submit', [ObjectiveController::class, 'submit']);
                Route::post('validate', [ObjectiveController::class, 'validateObjective'])->middleware('role:DIRECTION');
                Route::post('assign', [ObjectiveController::class, 'assign']);
                Route::post('evaluate', [ObjectiveController::class, 'evaluateAction']);
                Route::post('record-manual-performance', [ObjectiveController::class, 'recordManual'])->middleware('role:DIRECTION');
                Route::post('close', [ObjectiveController::class, 'close'])->middleware('role:DIRECTION');
            });
        });

        Route::prefix('institutions')->middleware('feature:institutions')->group(function () use ($managers) {
            Route::get('/', [InstitutionController::class, 'index']);
            Route::post('/', [InstitutionController::class, 'store']);
            Route::delete('contacts/{contactId}', [InstitutionController::class, 'deleteContact'])->whereNumber('contactId');
            Route::prefix('{id}')->whereNumber('id')->group(function () use ($managers) {
                Route::get('/', [InstitutionController::class, 'show']);
                Route::put('/', [InstitutionController::class, 'update']);
                Route::patch('status', [InstitutionController::class, 'status'])->middleware($managers);
                Route::delete('/', [InstitutionController::class, 'destroy'])->middleware($managers);
                Route::post('contacts', [InstitutionController::class, 'addContact']);
            });
        });

        Route::prefix('missions')->middleware('feature:missions')->group(function () use ($managers) {
            Route::get('/', [MissionController::class, 'index']);
            Route::post('/', [MissionController::class, 'store']);
            Route::prefix('{id}')->whereNumber('id')->group(function () use ($managers) {
                Route::get('/', [MissionController::class, 'show']);
                Route::get('order.pdf', [MissionController::class, 'orderPdf']);
                Route::put('/', [MissionController::class, 'update']);
                Route::put('status', [MissionController::class, 'status']);
                Route::post('actions', [MissionController::class, 'action']);
                Route::delete('/', [MissionController::class, 'destroy'])->middleware($managers);
                Route::post('attachments', [MissionController::class, 'attach']);
                Route::get('attachments/{attId}/download', [MissionController::class, 'download'])->whereNumber('attId');
                Route::delete('attachments/{attId}', [MissionController::class, 'deleteAttachment'])->whereNumber('attId');
            });
        });

        Route::prefix('opportunities')->middleware('feature:opportunities')->group(function () {
            Route::get('/', [OpportunityController::class, 'index']);
            Route::get('pipeline', [OpportunityController::class, 'pipeline']);
            Route::post('/', [OpportunityController::class, 'store']);
            Route::prefix('{id}')->whereNumber('id')->group(function () {
                Route::get('/', [OpportunityController::class, 'show']);
                Route::put('/', [OpportunityController::class, 'update']);
                Route::delete('/', [OpportunityController::class, 'destroy']);
                Route::post('{transition}', [OpportunityController::class, 'transition'])
                    ->where('transition', 'submit|validate|request-correction|reject|start-analysis|create-action-plan|move-to-proposal|move-to-negotiation|move-to-decision|mark-as-won|mark-as-lost|archive|follow-up-mission');
                Route::post('comments', [OpportunityController::class, 'comment']);
                Route::put('actions/{actionId}', [OpportunityController::class, 'updateAction'])->whereNumber('actionId');
                Route::post('attachments', [OpportunityController::class, 'attach']);
                Route::get('attachments/{attId}/download', [OpportunityController::class, 'download'])->whereNumber('attId');
                Route::delete('attachments/{attId}', [OpportunityController::class, 'deleteAttachment'])->whereNumber('attId');
            });
        });

        Route::prefix('reports')->middleware('feature:reports')->group(function () {
            Route::get('/', [ReportController::class, 'index']);
            Route::post('/', [ReportController::class, 'store']);
            Route::prefix('{id}')->whereNumber('id')->group(function () {
                Route::get('/', [ReportController::class, 'show']);
                Route::put('/', [ReportController::class, 'update']);
                Route::post('{transition}', [ReportController::class, 'transition'])->where('transition', 'submit|request-correction|validate|reject|archive');
                Route::get('download-pdf', [ReportController::class, 'downloadPdf']);
                Route::post('comments', [ReportController::class, 'comment']);
                Route::post('opportunities', [ReportController::class, 'linkOpportunity']);
                Route::delete('opportunities/{oppId}', [ReportController::class, 'unlinkOpportunity'])->whereNumber('oppId');
                Route::post('attachments', [ReportController::class, 'attach']);
                Route::get('attachments/{attId}/download', [ReportController::class, 'download'])->whereNumber('attId');
                Route::delete('attachments/{attId}', [ReportController::class, 'deleteAttachment'])->whereNumber('attId');
            });
        });

        Route::post('sync/push', [SyncController::class, 'push']);
        Route::post('sync/resolve-conflict', [SyncController::class, 'resolveConflict']);

        Route::prefix('notifications')->group(function () {
            Route::get('push-key', [NotificationController::class, 'pushKey']);
            Route::post('subscriptions', [NotificationController::class, 'subscribe']);
            Route::delete('subscriptions', [NotificationController::class, 'unsubscribe']);
            Route::get('stream', [NotificationController::class, 'stream'])->withoutMiddleware('throttle:api')->middleware('throttle:stream');
            Route::get('/', [NotificationController::class, 'index']);
            Route::post('{id}/read', [NotificationController::class, 'read'])->whereNumber('id');
        });

        Route::prefix('security')->middleware(['feature:security', $admins])->group(function () {
            Route::get('active-users', [SecurityController::class, 'activeUsers']);
            Route::get('login-history', [SecurityController::class, 'loginHistory']);
            Route::get('audit-logs', [SecurityController::class, 'auditLogs']);
        });

        Route::prefix('permissions')->middleware($admins)->group(function () {
            Route::get('catalogue', [PermissionController::class, 'catalogue']);
            Route::get('job-descriptions', [PermissionController::class, 'index']);
            Route::get('job-descriptions/{jobId}', [PermissionController::class, 'show']);
            Route::put('job-descriptions/{jobId}/feature', [PermissionController::class, 'updateFeature']);
            Route::post('job-descriptions/{jobId}/select-all', [PermissionController::class, 'selectAll']);
        });

        Route::get('analytics/{module}', [AnalyticsController::class, 'show']);
    });
};

Route::prefix('api/v1')->middleware('throttle:api')->name('v1.')->group(fn () => $api('v1'));

Route::any('api/v{version}/{rest?}', fn () => ApiResponse::error(404, 'API_VERSION_UNSUPPORTED', "Version d'API inexistante ou non prise en charge."))
    ->where(['version' => '(?:[02-9]|\d{2,})', 'rest' => '.*']);

Route::prefix('api')->middleware(['throttle:api', ApiVersionHeaders::class])->name('legacy.')->group(fn () => $api('legacy'));
