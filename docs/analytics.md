# Monitoring du backoffice

`GET /api/v1/analytics/:module?start=YYYY-MM-DD&end=YYYY-MM-DD`

Modules : dashboard, objectives, missions, institutions, opportunities, reports,
commerciaux, referentials, security, permissions. Session habituelle requise.
Dates inclusives ; période par défaut de 30 jours, maximum 366 jours, pas de date
future. Filtres inconnus et dates invalides : 400 ; module inconnu : 404.

Les requêtes sont des agrégats SQL, sans limite de pagination des listes métier.
Chaque réponse utilise une transaction en lecture seule avec snapshot cohérent.
Aucune migration ni donnée de démonstration n'est nécessaire.

## Interprétation

- `stockMetrics` : état actuel de tous les dossiers autorisés, indépendamment du
  filtre de création. Permet de conserver les anciens retards dans le monitoring.
- `metrics` : état actuel des dossiers créés dans la période ; `previous` concerne
  ceux créés dans la période précédente de même durée. Ce n'est pas une photographie
  de leur état passé. La journée courante est partielle.
- `trend` : créations / événements quotidiens, jours sans événement à zéro.
- `groups` : jusqu'à douze catégories par volume décroissant (aucune limite pour
  les profils d'habilitation). Valeurs exactes lisibles en texte.
- Référentiels et habilitations : snapshot de configuration, sans comparaison.
- Une moyenne / un ratio sans observations est `null`, affiché « — ».
- Réalisation quantitative : moyenne non pondérée des taux enregistrés pour les
  objectifs quantitatifs. Aucun recalcul métier ni mélange des unités de KPI.
- Qualitatifs atteints : évaluations ACHIEVED ou EXCEEDED.
- Conversion : WON / (WON + LOST). Montants estimés en FCFA ; le pipeline exclut
  WON, LOST, ARCHIVED et REJECTED. Une somme sans valeur disponible reste nulle.
- Délais de validation : moyenne en jours entre soumission et validation.
- Commerciaux : activité des missions par responsable principal, pas un classement
  général de performance ou une attribution aux associés.
- Alertes : signaux de revue, sans notification ni décision automatique.
- Les référentiels géographiques n'ont pas tous un état actif ; seuls les KPI et
  domaines participent au compteur d'inactivité.

## Accès

SYSTEM, ADMIN et DIRECTION voient le périmètre organisation. COMMERCIAL garde
le périmètre des routes existantes : objectifs créés / confiés / affectés,
missions principales ou associées, opportunités affectées, rapports propres ou
de ses missions principales. Les institutions restent partagées, comme leur API.
Commerciaux et référentiels : managers seulement. Sécurité et habilitations :
SYSTEM / ADMIN seulement, conformément à la navigation du backoffice.
Les fiches de poste ne remplacent pas les contrôles de rôle existants.

## Validation

`node --test test_analytics.js` : dates, rôles, SQL réel des dix modules,
transactions en lecture seule, fixtures temporaires pour deux commerciaux,
montants / conversion / jours vides / anciens dossiers et erreurs HTTP.
L'identité des tests HTTP est injectée dans un serveur de test isolé ; ces tests
ne remplacent pas un parcours de connexion navigateur complet.

Les panneaux sont actualisés à l'entrée du module, au changement de période ou
avec le bouton Actualiser. Redémarrer le processus API après mise à jour du code.

## Configuration locale vérifiée le 12 septembre 2026

L'API actuelle écoute sur `127.0.0.1:3012` (PORT dans le fichier `.env` local).
Le backoffice reste sur `5174` et la PWA sur `5175`. Leurs fichiers ignorés par
Git `.env.development.local` fixent `VITE_API_URL=/api/v1` et
`VITE_API_PROXY_TARGET=http://127.0.0.1:3012`. Les cookies restent sur l'origine
de chaque interface grâce au proxy. Ces réglages ne modifient pas la production.

Une ancienne API reste sur `3002`, son arrêt ayant été refusé par Windows.
Les deux interfaces de développement ne l'utilisent plus.
Le script `restart-local-api.ps1` cible maintenant `3012`.

Contrôles live : dix modules en HTTP 200 sur l'API et via chacun des deux proxies,
quatre périodes (7/30/90/365 jours), 401 sans session, 403 pour les modules
administratifs avec un commercial et dashboard commercial limité à son périmètre.
Ces contrôles HTTP ne constituent pas une validation visuelle du navigateur.
