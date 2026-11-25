# Remontada Prospectia — API Laravel

Réécriture Laravel 13 (PHP 8.3+) de l'API Node.js/Express du dépôt parent. Même base MySQL, même contrat `/api/v1` (et `/api` dépréciée) : le backoffice et la PWA fonctionnent sans modification.

- Analyse de l'existant, correctifs et impact : voir la PR d'introduction et `docs/`
- Déploiement cPanel et CI/CD : [docs/DEPLOIEMENT_CPANEL.md](docs/DEPLOIEMENT_CPANEL.md)

## Démarrage local

```bash
composer install
cp .env.example .env          # renseigner la base, les secrets JWT, les origines autorisées
php artisan key:generate
php artisan serve --port=3002
php artisan schedule:work     # notifications et rappels de relance
```

## Tests

Les tests créent leurs propres données dans une transaction annulée. Base vide :

```bash
mysql -uroot -e "CREATE DATABASE nexus_crm_test"
mysql -uroot nexus_crm_test < database/schema/baseline-node.sql
DB_DATABASE=nexus_crm_test php artisan test
```

## Organisation

| Dossier | Contenu |
|---|---|
| `app/Http/Middleware` | JWT cookie/Bearer, habilitations par fiche de poste, rôles, validation de requête, en-têtes de sécurité, garde d'origine |
| `app/Http/Controllers` | Un contrôleur par module (auth, users, permissions, referentials, institutions, missions, objectives, opportunities, reports, sync, notifications, security, analytics) |
| `app/Services` | Règles métier : workflows, tournées, déplacements, propositions d'objectifs, relances, livraisons e-mail/push, PDF, analytique |
| `resources/views` | Gabarits PDF (ordre de mission, rapport) et page publique de vérification |
| `routes/console.php` | Tâches planifiées (cron) |
| `database/schema/baseline-node.sql` | Schéma de référence (structure seule), pour CI et recette uniquement |
