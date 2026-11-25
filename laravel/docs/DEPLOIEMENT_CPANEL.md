# Déploiement de l'API Laravel sur cPanel (CI/CD GitHub Actions)

## Chaîne de livraison

```
branche feat/* ──PR──► Laravel API CI (qualité, sécurité, tests MySQL 8 + MariaDB 10.11, PHP 8.3/8.4)
                         │ revue + CI verte obligatoires (protection de branche)
                         ▼
                       merge sur main ──► CI ──► archive de release (artefact 14 j)
                                              └─► Deploy → environnement « staging » (automatique) + health check
                       Actions → Laravel API Deploy → « production » (manuel, approbation requise)
```

Fichiers : `.github/workflows/laravel-ci.yml`, `.github/workflows/laravel-deploy.yml`, `.github/actions/laravel-build/action.yml`, `.github/pull_request_template.md`, `.github/dependabot.yml`.

## 1. Réglages GitHub (une fois)

1. **Protection de `main`** (Settings → Branches → Add rule) : pull request obligatoire, 1 approbation, checks requis `Qualité et sécurité` et les trois `Tests (…)`, pas de push direct ni de force-push.
2. **Environnements** (Settings → Environments) : créer `staging` et `production` ; sur `production`, cocher *Required reviewers*.
3. **Secrets et variables par environnement** :

| Type | Nom | Exemple / rôle |
|---|---|---|
| secret | `CPANEL_HOST` | `ippc-cm.com` ou le nom du serveur cPanel |
| secret | `CPANEL_USER` | utilisateur cPanel (ou compte FTP dédié) |
| secret | `CPANEL_SSH_KEY` | clé privée ed25519 (mode `ssh`) — clé publique ajoutée dans cPanel → SSH Access |
| secret | `CPANEL_FTP_PASSWORD` | mot de passe du compte FTP (mode `ftp`) |
| variable | `DEPLOY_METHOD` | `ssh` si l'offre le permet (recommandé), sinon `ftp` |
| variable | `CPANEL_APP_DIR` | `remontada-api` (staging : `remontada-api-staging`) |
| variable | `CPANEL_PHP_BIN` | `/opt/cpanel/ea-php83/root/usr/bin/php` (mode `ssh`) |
| variable | `CPANEL_SSH_PORT` | `22` (certains hébergeurs : `2222` ou autre) |
| variable | `HEALTHCHECK_URL` | `https://remontada-api.ippc-cm.com/api/v1/health` |

Aucun secret applicatif (JWT, base, SMTP, VAPID) n'est stocké dans GitHub : ils vivent uniquement dans le `.env` du serveur.

## 2. Préparation du serveur cPanel (une fois par environnement)

1. **PHP** : *MultiPHP Manager* → PHP 8.3 (ou 8.4) pour le sous-domaine de l'API. *Select PHP Version / Extensions* : `pdo_mysql`, `mbstring`, `intl`, `gd`, `zip`, `bcmath`, `fileinfo`, `openssl`. Limites conseillées : `memory_limit=256M`, `upload_max_filesize=12M`, `post_max_size=60M` (5 pièces jointes de 10 Mo).
2. **Arborescence**

   | Mode | Code déployé | Racine web du sous-domaine |
   |---|---|---|
   | `ssh` | `~/remontada-api/releases/<sha>` + lien `~/remontada-api/current` | `remontada-api/current/public` |
   | `ftp` | `~/remontada-api/` | `remontada-api/public` |

   Créer le sous-domaine (cPanel → Domains) avec cette racine. **Ne jamais** faire pointer la racine sur le dossier de l'application : un `.htaccess` « deny all » y est placé par sécurité, mais `public/` est la seule racine valable.
3. **`.env` de production** : copier `.env.example`, renseigner les valeurs réelles, puis `php artisan key:generate`.
   - mode `ssh` : `~/remontada-api/shared/.env` ; mode `ftp` : `~/remontada-api/.env` (créé une fois via le gestionnaire de fichiers ; le déploiement ne l'écrase jamais).
   - `APP_ENV=production`, `APP_DEBUG=false`, `COOKIE_SECURE=true`, `NOTIFICATIONS_STREAM_MODE=snapshot`, `NOTIFICATION_DELIVERY_FREQUENCY=minute`, `CACHE_STORE=file`.
   - `UPLOAD_ROOT=/home/<cpuser>/remontada-data/uploads` (hors code déployé ; y copier `missions/`, `opportunities/`, `reports/` depuis l'ancien backend).
   - Réutiliser `JWT_SECRET` / `JWT_REFRESH_SECRET` du backend Node pour ne déconnecter personne — **sauf** s'ils ont figuré dans l'historique Git public (cas de `.env.production`) : générer alors de nouveaux secrets et prévenir les utilisateurs qu'ils devront se reconnecter.
4. **Tâche cron** (cPanel → Cron Jobs, chaque minute) :
   ```
   * * * * * cd /home/<cpuser>/remontada-api/current && /opt/cpanel/ea-php83/root/usr/bin/php artisan schedule:run >> /dev/null 2>&1
   ```
   (mode `ftp` : retirer `/current`). Elle envoie les notifications e-mail/push et les rappels de relance.
5. **Premier déploiement** : Actions → *Laravel API Deploy* → *Run workflow* → `staging`. Vérifier `HEALTHCHECK_URL`.

## 3. Bascule depuis Node.js sans perte de données

1. Sauvegarde complète de la base (cPanel → Backup ou phpMyAdmin → Exporter) et du dossier `uploads/`.
2. Vider la file hors-ligne des PWA (demander aux commerciaux de synchroniser) — les reçus de synchronisation créés par Node peuvent ne pas être reconnus par Laravel.
3. Recette complète sur `staging` branché sur une **copie** de la base.
4. Arrêter l'application Node (*Setup Node.js App* → Stop) **avant** d'activer le cron Laravel : deux planificateurs actifs enverraient chaque notification deux fois.
5. Pointer les frontends vers la nouvelle URL (`VITE_API_URL`) ou réutiliser l'ancien sous-domaine en changeant sa racine web.
6. Garder l'application Node arrêtée mais présente une à deux semaines (retour arrière = changer la racine web + rallumer Node + couper le cron Laravel).

`php artisan migrate` n'est **pas** utilisé : le schéma existant est conservé tel quel. Le fichier `database/schema/baseline-node.sql` sert uniquement à créer des bases vides (CI, recette) ; il est volontairement nommé pour que Laravel ne le charge jamais automatiquement sur une base existante.

## 4. Spécificités cPanel prises en compte

| Contrainte de l'hébergement mutualisé | Réponse |
|---|---|
| Nombre limité de processus simultanés (*entry processes*) | Flux de notifications en mode `snapshot` : un événement puis fermeture, au lieu d'une connexion tenue 55 s |
| Pas de démon permanent | Cron à la minute (`schedule:run`), livraison des notifications chaque minute |
| Pas de Redis | Cache fichier (un seul serveur) pour tickets MFA et limitation de débit |
| IP partagée des opérateurs mobiles (CGNAT) | Limitation de débit par session authentifiée et non par IP |
| En-tête `Authorization` supprimé par Apache/FastCGI | Réinjecté par `public/.htaccess` (indispensable pour la PWA) |
| Déploiement sans SSH | Mode `ftp` : miroir FTPS qui préserve `.env` et `storage/` |
| PHP 8.3 souvent maximum disponible | Dépendances verrouillées sur la plateforme PHP 8.3 (`config.platform.php`) |

## 5. Amélioration conseillée côté frontends (PR séparées)

Les deux clients (`pwa/src/notificationClient.js`, `backoffice/src/notificationClient.js`) se reconnectent toutes les 5 s. C'est compatible, mais ils peuvent respecter le délai `retry` envoyé par le serveur (20 s par défaut) et diviser la charge par quatre :

```diff
 export function connectNotifications({url,headers={},credentials='same-origin',onUpdate,onUnauthorized}) {
-  let stopped=false,controller,timer;
+  let stopped=false,controller,timer,delay=5000;
 ...
         while((end=buffer.indexOf('\n\n'))!==-1) {
           const event=buffer.slice(0,end);buffer=buffer.slice(end+2);
+          const retry=event.split('\n').find(line=>line.startsWith('retry: '));
+          if(retry) delay=Math.min(Math.max(Number(retry.slice(7))||5000,2000),120000);
           const data=event.split('\n').find(line=>line.startsWith('data: '));
 ...
-    if(!stopped) timer=setTimeout(connect,5000);
+    if(!stopped) timer=setTimeout(connect,delay);
```

Ces fichiers ne sont pas encore commités dans les dépôts `remontada-prospectia-pwa` et `remontada-prospectia-backoffice` : la modification est à intégrer au travail en cours avant sa PR.
