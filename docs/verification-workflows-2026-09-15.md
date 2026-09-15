# Corrections et vérification des workflows - 15 septembre 2026

Les corrections ci-dessous sont présentes dans le code local. La migration
`migrate_workflow_integrity.js` a été appliquée à la base locale configurée.
L'API qui écoute sur 3012 est le processus 39104, vérifié après redémarrage.
Les tests de mutation utilisent une base MySQL temporaire, créée à partir du
schéma seulement, sans copie des données métier. Les bases et fichiers de test
ont été supprimés après les vérifications.

## Corrections appliquées

- Libellés du backoffice, de la PWA et messages applicatifs : remplacement des
  esperluettes textuelles par « et » et des tirets longs par le tiret simple.
  Les opérateurs JavaScript, les sélecteurs CSS et l'échappement HTML sont conservés.
- Maintien du masquage du titre, du bouton d'impression et des quatre anciennes
  cartes de pilotage demandés précédemment.
- Habilitations : correction du double encodage JSON lors des enregistrements,
  contrôle serveur des droits de fiche de poste, filtrage des modules accessibles
  dans la navigation et transmission des droits par le profil authentifié.
- Sessions : révocation du jeton à la déconnexion, invalidation après changement
  de mot de passe, rotation concurrente protégée et un seul renouvellement côté
  backoffice lorsqu'un groupe de requêtes reçoit une réponse 401.
- Conservation des actions et pièces jointes chiffrées à la déconnexion PWA.
  Un autre compte ne peut pas écraser une file en attente. Une clé incorrecte
  produit une erreur explicite en conservant les données.
- Synchronisation : lots limités à 100 actions et bornés en taille, reprise des
  pièces jointes seules, correspondances d'identifiants persistantes, conservation
  des actions sans accusé de réception et rejeu du même contenu après interruption.
  Le serveur conserve les accusés de réception et les alias locaux par utilisateur.
- Les opportunités hors ligne suivent désormais la soumission du workflow ; un
  changement d'étape arbitraire n'est plus accepté par la mise à jour ordinaire.
- Transactions pour les transitions des opportunités et rapports, les actions
  de mission et les validations/affectations/évaluations/clôtures d'objectifs.
  Les historiques et notifications de ces transitions participent à la transaction.
- Une mission n'est pas marquée terminée si la création automatique de son rapport
  échoue. Les coordonnées invalides sont refusées et la valeur zéro est conservée.
- Contrôles supplémentaires sur les rattachements aux objectifs et missions d'un
  autre commercial. Suppression des doubles libérations de connexion dans la
  modification d'un rapport.
- Monitoring des rapports : prise en compte du statut métier `SOUMIS`.
  Le tableau de bord affiche une erreur explicite lorsque ses données ne chargent pas.
- Téléchargement des rapports PDF et pièces jointes : chemins transmis relativement
  à une racine autorisée. Cela corrige les 404 causées par le dossier local `.gemini`.
- Référentiels géographiques : refus de supprimer un lieu encore utilisé par
  la hiérarchie ou par les dossiers vérifiés.
- Redémarrage : recherche du processus via `netstat`, contrôle de son identité,
  puis contrôle du PID réellement à l'écoute. Un port occupé provoque un échec
  explicite et n'affiche plus une annonce de disponibilité trompeuse.
- Nettoyage des erreurs ESLint du backoffice, séparation du contexte/API et
  chargements initiaux différés avec annulation avant lancement en Strict Mode.

## Parcours vérifiés

| Module | Étapes et résultat observé |
| --- | --- |
| Authentification | Connexion API, MFA avec transport e-mail simulé, accès sans session refusé, double renouvellement concurrent, déconnexion et révocation après changement de mot de passe : OK. |
| Institutions | Création, ajout de contact, lecture et refus de modification par un autre commercial : OK. |
| Objectifs | Propositions quantitative et qualitative, auto-affectation, soumission, correction, modification, nouvelle soumission, validation et type déduit du KPI : OK via HTTP et contrôles SQL. |
| Missions | Brouillon, soumission, demande de complément, validation, démarrage, coordonnées invalides, terminaison et rapport automatique : OK via HTTP. Une panne injectée annule la terminaison. |
| Rapports | Contenu incomplet refusé, soumission, correction, nouvelle soumission, validation, clôture de mission et archive : OK. Génération réelle du PDF et téléchargement HTTP 200 avec signature PDF vérifiée. |
| Opportunités | Création API ; soumission, correction, validation, analyse, plan d'action, proposition, négociation, décision, gain et archive dans le service métier : OK. Un plan invalide ne laisse ni changement de statut ni action partielle. |
| Pièces jointes | Envoi multipart réel, téléchargement avec comparaison des octets, refus pour un autre commercial, suppression et 404 après suppression dans Missions, Rapports et Opportunités : OK. |
| Référentiels | Création et modification d'un pays, ajout d'une région, refus de suppression du parent utilisé, suppression enfant puis parent, 404 sur seconde suppression : OK. |
| Commerciaux | Création d'un compte, consultation, génération du ticket d'initialisation de mot de passe : OK. L'envoi e-mail est simulé. |
| Habilitations | Lecture, enregistrement via API, profil actualisé, refus des écritures directes et hors ligne pour un profil en lecture seule : OK. |
| Sécurité | Refus des journaux pour Commercial et Direction, accès autorisé et monitoring administratif : OK. |
| Notifications | Création durant les workflows, lecture et marquage limité au propriétaire : OK. |
| Synchronisation | Références au sein d'un lot et entre requêtes, rejeu sans doublon, soumission avec historique, commentaires et refus des actions d'un autre compte : OK. |
| Pilotage | Dix modules vérifiés aux périodes de 30 et 365 jours, directement sur l'API et via les deux proxies Vite : 60 réponses authentifiées HTTP 200. Les appels sans session sont refusés. |

## Résultats reproductibles

Depuis `backend` :

```powershell
npm run test:workflows
node --test test_mission_targets_unit.js test_mission_travel_unit.js test_objective_proposal_unit.js
npm run test:analytics
npm run test:live-readonly
```

- `test:workflows` : 15 scénarios réussis sur base isolée, avec authentification
  HTTP réelle pour les utilisateurs de test. Les refus et la panne volontaire
  affichent des erreurs attendues dans le journal de test.
- Tests unitaires objectifs/cibles/déplacements : 16 réussis.
- Monitoring : 5 tests réussis ; snapshots en lecture seule et tables temporaires.
- `test:live-readonly` : 60 réponses analytics réussies, les trois routes health,
  les refus 401, le nouveau contrat de profil et les deux pages HTML vérifiés.
  Ce test émet seulement des GET avec un jeton technique de 120 secondes gardé
  en mémoire pour un compte SYSTEM local existant. Le middleware met à jour
  son activité ; aucun dossier métier n'est modifié.
- Port API déjà occupé : démarrage refusé avec code de sortie 1, sans fausse
  annonce de disponibilité.

Depuis `pwa` : `npm run test:offline`, `npm run lint`, `npm run build`.
Huit scénarios hors ligne réussis avec IndexedDB en mémoire et WebCrypto réel.
Ils couvrent notamment 205 actions envoyées en trois lots, une réponse interrompue,
une pièce jointe seule et la protection des données entre deux comptes.
Les échanges HTTP de cette suite cliente sont simulés ; les envois multipart
réels sont vérifiés par la suite backend.

Depuis `backoffice` : `npm run test:api`, `npm run lint`, `npm run build`.
Trois scénarios clients réussis : renouvellement partagé avec réponse tardive,
encodage du corps de requête et fin de session si le renouvellement est refusé.
ESLint et compilation réussissent pour les deux interfaces, sans erreur.

## Adresses locales actives

- Backoffice : http://127.0.0.1:5174
- PWA : http://127.0.0.1:5175
- API : http://127.0.0.1:3012/api/v1/health

Le redémarrage conserve la cible 3012 des deux proxies. Une reconnexion permet
à une session déjà ouverte de recevoir les nouveaux champs de profil.

## Limites de cette validation

Cette vérification ne constitue pas une validation visuelle de chaque écran et
de chaque clic dans le navigateur. L'accès automatisé au navigateur local était
indisponible dans cette session. La mise en page du PDF n'a pas été inspectée
visuellement, même si sa génération et son téléchargement ont été vérifiés.

La réception effective des e-mails/OTP/invitations, les permissions GPS sur un
téléphone réel, l'installation et les mises à jour du service worker ainsi que
le comportement sur un réseau mobile réel restent à vérifier sur appareil.
Les tests ne prétendent pas couvrir chaque branche de tous les formulaires.

Les sujets de publication et de rotation des secrets de l'audit antérieur ne
sont pas déclarés clos par cette passe. Aucun déploiement distant ni push Git
n'a été réalisé ; les modifications préexistantes du workspace sont conservées.
