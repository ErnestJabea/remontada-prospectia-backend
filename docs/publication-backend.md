# Publication du backend

Cette mise à jour retire `.env.production` du suivi Git. Le fichier local reste
présent et ignoré. Les futurs fichiers `.env.*` sont ignorés, sauf `.env.example`.

## Avant de mettre à jour un serveur déployé

1. Sauvegarder la configuration d'environnement hors du checkout Git, ou la
   déplacer dans le gestionnaire de variables de l'hébergement. Un `git pull`
   peut supprimer l'ancienne copie suivie de `.env.production`.
2. Renouveler les secrets déjà présents dans l'historique du dépôt : mot de passe
   de base de données, clés JWT et mot de passe SMTP. Le retrait du fichier du
   dernier commit ne les efface pas des anciens commits.
3. Sauvegarder la base avant les migrations. Installer les dépendances avec
   `npm ci --omit=dev` et vérifier la version de Node utilisée par l'hébergement.
4. Appliquer `npm run migrate:workflow-integrity` avant de démarrer le nouveau
   code : l'authentification et la synchronisation utilisent les colonnes et
   tables ajoutées par cette migration.
5. Vérifier les migrations objectifs, déplacements et cibles de mission selon
   la version déjà installée. Ne pas exécuter `init_db_crm.sql` ou `setup_users.js`
   sur une base métier existante.
6. Redémarrer l'API et contrôler les routes authentifiées, les accès interdits,
   la génération PDF et les deux clients.

La publication Git ne lance pas de déploiement depuis cet espace de travail.
Un éventuel mécanisme de déploiement configuré sur l'hébergement doit être
vérifié séparément. Aucune rotation de secrets distants ni réécriture forcée
de l'historique n'est effectuée par ce commit.

Les tests et leurs limites sont décrits dans
`verification-workflows-2026-09-15.md`. Les modifications du backoffice et de la
PWA appartiennent à leurs dépôts respectifs et ne sont pas incluses dans le push
du backend.
