# Objectifs : actualisation, push et e-mails

Les changements de statut sont détectés par un flux SSE authentifié `/api/v1/notifications/stream`. Le serveur vérifie les données validées en base toutes les 3 secondes. Chaque utilisateur reçoit seulement ses notifications et une empreinte des objectifs autorisés. Le client recharge les données via les routes métier qui appliquent les permissions. La connexion se ferme si la session expire, est révoquée, ou si le rôle change, et le client se reconnecte après interruption. Le backoffice renouvelle sa session via son mécanisme existant.

Le flux actualise les cartes, listes et fiches du backoffice, la liste de la PWA et les cloches de notifications. Les brouillons/actions de la PWA encore en file de synchronisation sont préservés. La période de monitoring choisie reste inchangée.

Les événements OBJECTIVE_* existants (soumission, validation, correction, rejet, affectation, clôture) créent deux lignes dans notification_deliveries avec la notification : une pour l’e-mail et une pour le push. Dans les routes transactionnelles, tout est validé ou annulé ensemble. Les destinataires restent ceux du workflow : Direction/Administration pour une soumission, créateur/responsable pour la décision.

## Installation et activation

1. `npm ci` dans le backend.
2. Exécuter `npm run migrate:notifications`, puis `npm run migrate:objective-proposal-status` avant de démarrer la nouvelle API. La première migration ajoute les tables sans envoyer les anciennes notifications. La seconde corrige les propositions terrain historiquement marquées ASSIGNED en VALIDATED, seulement en l’absence d’affectation explicite, et journalise chaque correction. Ces migrations sont réexécutables.
3. Configurer SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD (ou SMTP_PASS), SMTP_FROM ; configurer VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT. Garder les clés VAPID stables par environnement. Ne jamais publier les secrets.
4. Démarrer l’API avec `npm start`. Le worker démarre dans le processus principal et cherche les envois toutes les 2 secondes. Pour un serveur qui importe seulement app, appeler explicitement startDeliveryWorker.
5. Construire et déployer les deux interfaces, y compris notification-sw.js et le service worker généré. Servir par HTTPS (localhost est accepté pour les tests).
6. Désactiver la mise en tampon et autoriser les connexions longues sur `/api/v1/notifications/stream` dans le proxy hébergeur ; le serveur fournit X-Accel-Buffering: no.

## Activation utilisateur

- PWA : Paramètres > Notifications > notifications push. Les préférences e-mail existantes sont respectées.
- Backoffice : cloche Notifications > Activer les push.
- L’autorisation du navigateur est nécessaire ; l’application ne peut pas l’accorder à la place de la personne.
- Les abonnements sont liés au compte et à l’appareil. La déconnexion explicite les désactive sur cet appareil. Les abonnements expirés (404/410) sont supprimés. Un clic sur le push ouvre Objectifs. Un maximum de dix appareils est enregistré par compte.

## Livraison et diagnostic

La livraison est effectuée après commit. Un échec d’envoi ne modifie pas la décision métier. Dix essais au maximum, avec temporisation exponentielle plafonnée à une heure. Les lignes processing sont récupérables après expiration du verrou de cinq minutes. Les statuts sont pending, processing, sent, skipped ou failed. Un canal désactivé, un e-mail absent ou l’absence d’abonnement est skipped, et non sent. Le SMTP doit accepter au moins un destinataire pour marquer sent.

Consulter notification_deliveries (status, attempts, last_error, sent_at) pour diagnostiquer. Les erreurs persistantes nécessitent une correction de configuration, puis une remise en attente contrôlée des seules lignes concernées. Aucun secret, adresse de destinataire ou endpoint push n’est journalisé par le worker.

La livraison est au moins une fois : un arrêt après acceptation par le fournisseur mais avant mise à jour de la base peut entraîner un doublon. Un Message-ID stable est envoyé pour l’e-mail et un tag par notification pour le push. La livraison finale dépend du fournisseur, du réseau, des préférences et du système de l’appareil ; elle ne peut pas être promise instantanée.

## Vérification

`npm run test:workflows` utilise une base temporaire, des transports e-mail/push simulés et un vrai flux HTTP SSE. Vérifications : commit/rollback de la file, isolation utilisateur, refus des endpoints locaux, appartenance des abonnements, reprise SMTP, préférences et retrait des abonnements expirés. Les tests ne contactent pas de destinataires réels.

En local, SMTP a été vérifié par connexion/authentification, les clés VAPID sont configurées et la migration est appliquée. La réception dans une boîte mail et l’affichage du push sur un appareil restent à confirmer avec un destinataire et un navigateur autorisé.
