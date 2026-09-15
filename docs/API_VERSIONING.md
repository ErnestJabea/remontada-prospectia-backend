# Contrat et versionnement de l'API

La version stable courante est `v1`. Toute nouvelle integration doit utiliser
le prefixe canonique `/api/v1`.

## Compatibilite

- Canonique : `/api/v1/...`
- Ancien prefixe temporaire : `/api/...`
- Version inconnue : reponse `404` avec le code `API_VERSION_UNSUPPORTED`

Le prefixe historique reste disponible pendant la migration des clients et
renvoie les en-tetes `Deprecation: true`, `Warning` et un lien vers `/api/v1`.
Aucune date de suppression n'est annoncee tant qu'elle n'a pas ete validee.

## Regles de securite

- Toutes les ressources metier sont authentifiees par defaut.
- Les seules exceptions publiques sont la sante de l'API, les operations
  necessaires a l'authentification et la verification tokenisee d'un ordre de
  mission.
- Le portail web utilise exclusivement les cookies HttpOnly ; le Bearer JWT est
  reserve a la PWA mobile.
- Les reponses API portent un identifiant `X-Request-ID`, ne sont pas mises en
  cache et n'exposent pas la pile d'erreur.
- Les requetes d'ecriture par cookie exigent une origine CORS autorisee.
- Les contenus, tailles, methodes et parametres ambigus sont rejetes avant les
  routes metier.

## Evolution

Une nouvelle version majeure (`v2`) est requise lorsqu'un changement casse le
contrat existant. Les ajouts retrocompatibles restent dans `v1`. La version
historique doit rester en deprecation le temps de migrer les clients et leurs
tests avant toute suppression.
