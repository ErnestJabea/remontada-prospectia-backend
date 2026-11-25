<?php

use App\Services\FollowupReminders;
use App\Services\NotificationDelivery;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schedule;

/*
| Remplace les setInterval() de server.js. En production :
|   * * * * * php artisan schedule:run   (cron)  — ou  php artisan schedule:work
*/
Artisan::command('remontada:deliver-notifications', function () {
    $this->info(NotificationDelivery::deliverPending().' livraison(s) traitée(s).');
})->purpose('Envoie les notifications e-mail / Web Push en attente (retry exponentiel).');

Artisan::command('remontada:process-reminders', function () {
    $this->info(FollowupReminders::processReminders().' rappel(s) examiné(s).');
})->purpose('Génère les rappels de relance 48/24/12/6 h avant échéance.');

// Sur cPanel (cron à la minute), garder « minute » : une tâche sous la minute
// maintiendrait schedule:run actif en permanence et consommerait un processus.
$delivery = Schedule::command('remontada:deliver-notifications')->withoutOverlapping();
config('remontada.notifications.delivery_frequency') === 'ten_seconds' ? $delivery->everyTenSeconds() : $delivery->everyMinute();
Schedule::command('remontada:process-reminders')->everyMinute()->withoutOverlapping();
Schedule::call(function () {
    DB::delete('DELETE FROM revoked_access_tokens WHERE expires_at < NOW()');
    DB::delete('DELETE FROM refresh_tokens WHERE expires_at < NOW()');
})->daily()->name('purge-expired-tokens');
