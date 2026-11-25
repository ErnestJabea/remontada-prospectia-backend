# ERP Remontada Prospectia — Analyse du projet et migration du backend vers Laravel

_Date : 25/11/2026 — périmètre : `backend/` (Node/Express), `backoffice/` (React), `pwa/` (React PWA), nouveau `laravel/` (branche `feat/laravel-cpanel` du dépôt backend)._

## 1. Ce qu'est le projet

CRM de prospection commerciale terrain (Cameroun, bilingue FR/EN) en trois briques qui partagent une même base MySQL `nexus_crm` (52 tables) :

| Brique | Techno | Rôle | Authentification |
|---|---|---|---|
| `backend/` | Node 20+, Express 5, mysql2, ~8 000 lignes | API REST `/api/v1` (+ `/api` dépréciée) | JWT HS256 |
| `backoffice/` | React 19 + Vite 8 | Portail direction / admin | Cookies HttpOnly `crm_access`/`crm_refresh` (canal `web_portal`) |
| `pwa/` | React 19 + Vite PWA, IndexedDB | Application du commercial terrain, hors-ligne | Bearer + refresh token en sessionStorage, MFA OTP systématique (canal `mobile_pwa`) |

Modules métier : objectifs (KPI, domaines, propositions terrain, évaluation automatique et consolidation parent/enfant), missions (tournées multi-cibles, déplacements, Gate 1, ordre de mission PDF signé + QR de vérification publique), opportunités (pipeline 13 statuts, plan d'action, relances avec rappels 48/24/12/6 h), rapports (Gate 2, PDF), synchronisation hors-ligne idempotente, notifications (in-app, SSE, e-mail, Web Push), habilitations par fiche de poste, audit et sécurité, analytique.

## 2. Mon avis sur l'existant

### Points forts (à conserver)
- **Sécurité pensée sérieusement** : double canal cookie/Bearer non interchangeable, rotation des refresh tokens, révocation par `auth_version` et liste noire, verrouillage après 5 échecs, temps constant sur identifiant inconnu, contrôle d'`Origin` sur les écritures par cookie, rate limiting, validation anti-prototype-pollution, signature binaire des pièces jointes, CSP à nonce sur la page de vérification.
- **Habilitations fines** (vue / création / modification / suppression / vue globale / réorganisation) appliquées aussi au périmètre des identifiants étrangers (`linkedAccess`).
- **Synchronisation hors-ligne robuste** : reçus idempotents par empreinte, table de correspondance identifiants locaux → serveur, une transaction par action.
- **Workflows explicites** (machines à états) avec historique et notifications.

### Faiblesses structurelles
1. **Schéma de base non maîtrisé** : il est réparti entre `init_db_crm.sql`, ~20 scripts `migrate_*.js` lancés à la main et des `ALTER TABLE` / `CREATE TABLE` **exécutés à chaud** dans les routes (`ensureMissionColumns`, `ensureInstitutionStatusColumn`, `ensureMissionTargetTables`, `migrate_production_fixes` au démarrage). Plus des requêtes de repli « si la colonne n'existe pas ». Personne ne peut dire avec certitude quel schéma tourne en production.
2. **SQL brut partout, aucune couche d'accès aux données** : routes de 700 à 1 400 lignes mêlant HTTP, règles métier et SQL ; logique dupliquée (ajout d'opportunités depuis un rapport écrit 3 fois, `isManager` redéfini 6 fois, upload multer copié 3 fois).
3. **Transactions « magiques »** : `db.js` détourne `pool.query` via AsyncLocalStorage et `transactionalRoutes`/`transactionalWorkflow` réécrivent la pile Express après coup. Ça marche, mais c'est fragile et opaque.
4. **État en mémoire du processus** : tickets MFA dans une `Map` (perdus au redémarrage, incompatibles avec plusieurs instances), workers `setInterval` dans le serveur web.
5. **Tests** : scripts ad hoc (`test_*.js`) sans framework ni CI ; pas de test des frontends visible côté backend.
6. **Couplage** : les PDF lisent les logos dans `../backoffice/src/assets` ; l'empreinte de l'ordre de mission dépend de `String(Date)` donc de la locale et du fuseau du serveur Node.
7. **Frontends monolithiques** : `pwa/src/App.jsx` fait 6 677 lignes, `ObjectivesModule.jsx` 2 054 — difficile à maintenir et à tester.
8. **Hygiène du dépôt** : `backend/` est un sous-module avec `.env`, `.env.production`, `last_otp.txt`, logs et PDF de rapports réels dans l'arbre de travail (ignorés par git mais présents) ; zips de build versionnés (`backoffice-dist.zip`).

### Bugs et failles constatés (corrigés dans la version Laravel)
| # | Gravité | Constat (Node) | Correction Laravel |
|---|---|---|---|
| 1 | **Haute** | Rapport : un commercial peut lier **n'importe quelle opportunité** (PUT `/reports/:id` et POST `/reports/:id/opportunities`) — IDOR | Contrôle de périmètre `canLinkRecord('opportunities')` |
| 2 | Haute | Rapport rejeté → statut `REJETE`, mais la liste des statuts modifiables contient `REJECTED` : **un rapport rejeté ne peut plus être corrigé ni resoumis** | `REJETE` ajouté aux statuts modifiables/soumissibles |
| 3 | Moyenne | Désactiver un utilisateur supprime ses refresh tokens mais **son jeton d'accès reste valide jusqu'à 1 h** | `auth_version` incrémenté à la désactivation |
| 4 | Moyenne | Synchro prospect / mission de suivi : région, département, ville **retombent sur l'id 1** si absents → données géographiques fausses silencieusement | Géographie obligatoire, ou reprise de celle de l'institution |
| 5 | Moyenne | Mission de suivi : un commercial peut **affecter la mission à n'importe qui** | Commercial = lui-même ; objectif soumis au contrôle de périmètre |
| 6 | Moyenne | Workflows opportunités/rapports : toute erreur (accès refusé, introuvable, mauvais statut) renvoie **400** | 403 / 404 / 409 corrects |
| 7 | Moyenne | `mark-as-lost` / `archive` sans contrôle d'état (on peut « perdre » une opportunité gagnée) | Transitions contrôlées |
| 8 | Faible | `GET /missions` renvoie `err.message` et `err.code` SQL au client en cas d'erreur | Erreur générique, détail en journal |
| 9 | Faible | Code opportunité `OP-` + `Math.random()` sur 5 caractères (collisions, prévisible) | Aléa cryptographique, 6 caractères |
| 10 | Faible | Habilitations : `module_id`/`feature_id` arbitraires acceptés | Validés contre le catalogue |
| 11 | Faible | Résolution de conflit : réécrit statut/étape d'opportunité et champs de rapport sans validation ; e-mails OTP non échappés (HTML) | Champs validés, statut via workflow uniquement ; HTML échappé |
| 12 | Faible | Moteur KPI : colonne d'agrégation choisie par la règle (seulement échappée) | Liste blanche de colonnes |
| 13 | Info | `PUT /objectives/:id` fait un `SELECT … FOR UPDATE` hors transaction (verrou inopérant) | Toute la modification est transactionnelle |
| 14 | Info | Validation/clôture d'objectif réservée à `DIRECTION` seulement (ADMIN/SYSTEM exclus) alors que les autres modules acceptent les trois | **Conservé tel quel** — décision métier à confirmer |

## 3. Ce qui a été livré : `laravel/` (branche `feat/laravel-cpanel` du dépôt backend)

Copie convertie du backend, **sans toucher à `backend/`** ni aux frontends.

- **Laravel 13.44 / PHP 8.4**, dépendances : `firebase/php-jwt`, `minishlink/web-push`, `barryvdh/laravel-dompdf`, `chillerlan/php-qrcode`.
- **Même base, même schéma** : `database/schema/baseline-node.sql` est l'export exact des 52 tables de la base locale (structure seule). Aucune migration ni table supplémentaire n'est exigée ; plus aucun `ALTER TABLE` à chaud.
- **Contrat d'API identique** : 109 routes × 2 (`/api/v1` et `/api` dépréciée avec en-têtes `Deprecation`/`Link`), mêmes chemins, mêmes corps JSON, mêmes messages d'erreur en français, même format `{error, code, requestId, apiVersion}`, `X-Request-ID`, versions non supportées → `API_VERSION_UNSUPPORTED`.
- **Sessions conservées** : mêmes secrets JWT et mêmes revendications → un utilisateur connecté sur Node reste connecté après bascule ; `password_verify` accepte les empreintes bcryptjs existantes.

| Node | Laravel |
|---|---|
| `middleware/auth.js`, `featureAccess.js`, `apiSecurity.js`, helmet, cors, rate-limit | `app/Http/Middleware/*`, `config/cors.php`, `RateLimiter` (mêmes fenêtres 15 min : 200 / 10 / 5) |
| `routes/*.js` (12 routeurs) | `app/Http/Controllers/*` (13 contrôleurs) + `routes/api.php` |
| `services/*`, `utils/*` | `app/Services/*` (MissionTargets, MissionTravel, ObjectiveProposals, OpportunityWorkflow, ReportWorkflow, FollowupReminders, NotificationDelivery, Analytics, Uploads, Mailer…) |
| PDFKit (dessin programmatique) | Vues Blade `resources/views/pdf/*` + Dompdf |
| `setInterval` dans le serveur web | `routes/console.php` : `remontada:deliver-notifications` (10 s), `remontada:process-reminders` (1 min), purge des jetons expirés — via `php artisan schedule:work` ou cron |
| Tickets MFA en mémoire | Cache Laravel (fichier en local, **Redis requis en multi-instances**) |
| Transactions par AsyncLocalStorage | `DB::transaction()` explicite + `FOR UPDATE`, savepoints pour l'imbrication |

**Vérifications faites** : lint PHP de tous les fichiers ; 219 routes chargées ; test de fumée HTTP (santé, 401, JSON invalide, `__proto__`, version inconnue, 404) ; lectures authentifiées par rôle (SYSTEM, DIRECTION, COMMERCIAL) sur 21 endpoints, codes 200/403 conformes aux fiches de poste ; **test de bout en bout** `tests/Feature/WorkflowParityTest.php` (objectif → prospect → mission → Gate 1 → PDF + QR + page publique → pointage GPS → rapport auto → Gate 2 → PDF → opportunité → plan d'action avec 4 rappels → synchro idempotente → contrôles d'accès → canal cookie et garde d'origine) : **2 tests, 50 assertions, verts**, exécutés dans une transaction annulée (base locale inchangée).

**Non vérifié / limites connues**
- Pas de comparaison réponse par réponse avec le serveur Node en marche (je ne l'ai pas lancé : il exécute des migrations et envoie des e-mails/push au démarrage). La base locale étant vide de données métier, les formes de réponses ont été validées sur des données de test.
- Envoi réel d'e-mails SMTP et de Web Push non testé.
- PDF : rendu fidèle dans l'esprit (mêmes sections, logos, QR, signature) mais pas au pixel près.
- Flux SSE `/notifications/stream` : la connexion est fermée après 55 s (reconnexion automatique d'`EventSource`) pour ne pas bloquer un worker PHP-FPM.
- Empreinte imprimée sur les **anciens** ordres de mission : reproduite via `NODE_TZ_LABEL` (libellé de fuseau de Node) ; à ajuster si elle diffère. La validité, elle, repose sur le jeton et n'est pas affectée.
- Reçus de synchro créés par Node : si la PWA rejoue une action **déjà synchronisée par Node**, l'empreinte JSON peut différer (sérialisation PHP vs JS) → réponse 409 au lieu du succès idempotent. Risque faible : vider la file PWA avant la bascule.

## 4. Impact sur les deux frontends

**En résumé : aucune modification de code obligatoire.** Les deux applications parlent au même contrat d'API.

| Sujet | Backoffice | PWA terrain | Action |
|---|---|---|---|
| URL de l'API | `VITE_API_URL` ou `/api/v1` | idem (`pwa/src/config.js`) | Pointer le reverse proxy / `VITE_API_URL` vers Laravel |
| Authentification | Cookies HttpOnly identiques, `credentials: 'include'` | Bearer + `refreshToken` dans le corps, MFA identique | Aucune |
| CORS + garde d'origine | Même liste `ALLOWED_ORIGINS` | idem | Recopier les variables d'environnement |
| Format des dates | DATETIME renvoyés en ISO UTC `…Z` comme mysql2 | idem | Aucune ; les colonnes DATE sortent en `AAAA-MM-JJ` (évite le décalage d'un jour de mysql2) |
| Codes d'erreur | Quelques 400 deviennent 403/404/409 (workflows) | idem | Les écrans lisent `error` → message identique ; vérifier tout `if (status === 400)` éventuel |
| Rapport rejeté | Devient modifiable (correctif) | idem | Gain fonctionnel |
| Synchro prospect sans ville | — | Renvoie désormais une erreur explicite au lieu d'enregistrer la ville n°1 | La PWA doit envoyer région/département/ville (déjà le cas dans le formulaire) |
| Flux SSE | Reconnexion toutes les ~55 s | idem | Transparent avec `EventSource` |
| Pièces jointes | Anciennes pièces lues via `UPLOAD_ROOT` | idem | Pointer `UPLOAD_ROOT` vers `backend/uploads` ou copier le dossier |

## 5. Mon avis sur la migration

**Pertinente si** l'équipe maîtrise PHP, si l'hébergement est mutualisé/cPanel (cas fréquent, PHP y est natif et Node souvent mal supporté), ou si vous voulez structurer le projet (Eloquent, migrations, tests, files d'attente, planificateur) — Laravel apporte nativement ce que Node a dû bricoler ici.

**Moins pertinente si** l'objectif est seulement de corriger les bugs : ils sont tous corrigeables dans Node en quelques jours, sans risque de bascule.

**Coûts et risques** : PHP-FPM est moins adapté au temps réel (SSE) — prévoir Reverb/WebSockets à terme ; un worker planifié (cron) devient obligatoire ; Redis requis dès deux instances ; double maintenance tant que les deux backends coexistent.

**Ma recommandation** : basculer, mais progressivement.
1. Déployer Laravel en **pré-production** sur une copie de la base, frontends pointés dessus, recette complète des workflows.
2. Bascule par reverse proxy (`/api` → Laravel), Node gardé en secours une à deux semaines, **un seul** des deux planificateurs actif (sinon notifications envoyées deux fois).
3. Ensuite seulement : introduire Eloquent et les Form Requests module par module, remplacer le SSE par Reverb, découper `pwa/src/App.jsx`.

## 6. Démarrer la version Laravel en local

```powershell
cd laravel
composer install
copy .env.example .env    # puis reprendre les valeurs de backend/.env (DB, JWT, SMTP, VAPID, origines)
php artisan key:generate
php artisan serve --host=127.0.0.1 --port=3002
php artisan schedule:work  # dans un second terminal : notifications et rappels
php artisan test           # test de bout en bout, en transaction annulée
```

Déploiement sur cPanel et CI/CD : voir [DEPLOIEMENT_CPANEL.md](DEPLOIEMENT_CPANEL.md).
