<?php

namespace App\Services;

use App\Exceptions\ApiException;
use App\Support\Input;
use Illuminate\Support\Facades\DB;

/** Reprise de services/missionTravelService.js. */
class MissionTravel
{
    public const TRANSPORT_MODES = ['SERVICE_VEHICLE', 'PERSONAL_VEHICLE', 'PUBLIC_TRANSPORT', 'AIR', 'OTHER'];

    public static function validateBaseCity(mixed $cityId, bool $required = false): ?array
    {
        $id = Input::positiveId($cityId);
        if (! $id) {
            if ($required) {
                throw ApiException::make(400, 'La ville de rattachement du commercial est obligatoire.');
            }

            return null;
        }
        $row = DB::selectOne('SELECT id, name FROM crm_ref_cities WHERE id = ? LIMIT 1', [$id]);
        if (! $row) {
            throw ApiException::make(400, 'Ville de rattachement invalide.');
        }

        return (array) $row;
    }

    private static function date(mixed $value, string $label): ?string
    {
        if ($value === null || $value === '') {
            return null;
        }
        $ts = is_string($value) ? strtotime($value) : false;
        if ($ts === false) {
            throw ApiException::make(400, "{$label} invalide.");
        }

        return date('Y-m-d H:i:s', $ts);
    }

    public static function resolve(mixed $commercialId, array $destinationCityIds, array $payload = []): array
    {
        $commercialId = Input::positiveId($commercialId);
        $ids = array_values(array_unique(array_filter(array_map([Input::class, 'positiveId'], $destinationCityIds))));
        if (! $commercialId || ! $ids) {
            throw ApiException::make(400, 'Commercial ou ville de destination invalide.');
        }
        $user = DB::selectOne("SELECT u.id, u.base_city_id, base.name AS base_city_name FROM users u LEFT JOIN crm_ref_cities base ON base.id = u.base_city_id WHERE u.id = ? AND u.role = 'COMMERCIAL' AND u.is_active = TRUE LIMIT 1", [$commercialId]);
        if (! $user) {
            throw ApiException::make(400, 'Commercial principal invalide ou inactif.');
        }
        if (! $user->base_city_id) {
            throw ApiException::make(422, 'La ville de rattachement du commercial doit être configurée avant de créer une mission.');
        }
        $destinations = DB::table('crm_ref_cities')->whereIn('id', $ids)->get(['id', 'name']);
        if ($destinations->count() !== count($ids)) {
            throw ApiException::make(400, 'Ville de destination invalide.');
        }
        $scope = collect($ids)->every(fn ($id) => (int) $user->base_city_id === $id) ? 'IN_CITY' : 'OUT_OF_CITY';
        $base = [
            'base_city_id' => (int) $user->base_city_id,
            'base_city_name' => $user->base_city_name,
            'destination_city_name' => $destinations[0]->name,
            'destination_city_names' => $destinations->pluck('name')->all(),
            'travel_scope' => $scope,
        ];
        if ($scope === 'IN_CITY') {
            return $base + ['departure_at' => null, 'return_at' => null, 'transport_mode' => null, 'accommodation_required' => false, 'estimated_travel_cost' => 0];
        }
        $departure = self::date($payload['departure_at'] ?? null, 'Date de départ');
        $return = self::date($payload['return_at'] ?? null, 'Date de retour');
        if (! $departure || ! $return) {
            throw ApiException::make(400, 'Les dates de départ et de retour sont obligatoires pour une mission hors de la ville.');
        }
        if ($return < $departure) {
            throw ApiException::make(400, 'La date de retour doit être postérieure à la date de départ.');
        }
        $mode = strtoupper(Input::str($payload['transport_mode'] ?? ''));
        if (! in_array($mode, self::TRANSPORT_MODES, true)) {
            throw ApiException::make(400, 'Le moyen de transport est obligatoire pour une mission hors de la ville.');
        }
        $cost = $payload['estimated_travel_cost'] ?? 0;
        if (($cost !== null && $cost !== '' && ! is_numeric($cost)) || (float) $cost < 0 || (float) $cost > 1e9) {
            throw ApiException::make(400, 'Le coût estimatif du déplacement est invalide.');
        }

        return $base + ['departure_at' => $departure, 'return_at' => $return, 'transport_mode' => $mode, 'accommodation_required' => Input::bool($payload['accommodation_required'] ?? null, false), 'estimated_travel_cost' => (float) $cost];
    }

    public static function scopeLabel(?string $scope): string
    {
        return $scope === 'OUT_OF_CITY' ? 'Hors de la ville' : 'Dans la ville';
    }
}
