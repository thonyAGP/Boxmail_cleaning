# Changement — contexte-mail

- **Date** : 2026-08-18 · **Niveau de risque** : **moyen**
- **Critères déclenchés** :
  - **(a) Taille** : 5 fichiers (correspondance.ts, admin.ts, api.js, app.js,
    styles.css), refonte d'un panneau existant + nouvelle route.
  - **(d) Ambiguïté** : « quel périmètre pour le contexte » avait au moins
    trois lectures (fil / dossier / tout) — tranché par contre-revue aveugle.
- **Domaines sensibles** : aucun (lecture seule, aucune écriture, aucun envoi).

## 1. Intention

- **Besoin** : trois reproches d'Anthony sur le panneau « Nos échanges »,
  ouvert depuis une mise en demeure URSSAF transférée par sa sœur :
  trop d'étapes, **impasse** (« plus de possibilité de revenir en arrière sur
  le mail principal »), et hors sujet (« nos échanges ne se cantonne pas qu'au
  sujet traité » — il y voyait « COUCOU » et « 100 ans de la PLM »).
- **Critères de succès observables** : depuis un mail, le contexte utile est
  visible en un clic ; le mail traité n'est jamais remplacé sans geste
  explicite ; ce qui s'affiche par défaut est lié au sujet, pas à la récence.
- **Non-objectifs** : pas de moteur de recherche dans l'historique ; pas de
  réglage à configurer ; on ne touche pas à `correspondance()` (l'ancienne
  fonction sert encore la vue élargie).

## 2. Carte d'impact

- **Direct** : `services/correspondance.ts` (+ `contexteDuMail`),
  `server/admin.ts` (route `/messages/:id/contexte`), `web/js/api.js`,
  `web/js/app.js` (panneau + pile de lecture), `web/styles.css`.
- **Indirect** : le **lecteur** (`openReader`/`closeReader`) — la pile touche
  tous les écrans qui ouvrent un mail ; `renderReaderAnalysis` (le bouton).
- **Invariants** :
  - Lecture seule : aucune écriture en base, aucun envoi.
  - Le mail courant n'est jamais remplacé sans le geste « Ouvrir ce mail ↗ ».
  - Fermer le lecteur vide la pile (pas de retour fantôme à la réouverture).
  - Aucun élargissement silencieux : une focale vide le dit.

## 3. Décision

**« Lié à ce mail »** = même correspondant ET ( même fil OU même sujet
normalisé OU ≥ 1 dossier en commun ). Trois focales, défaut au milieu.
Contre-revue **aveugle 2 tours** :
`.consult/2026-08-18-nos-echanges/synthese.md`. Trois mesures ont fait
abandonner la proposition initiale (défaut fondé sur le dossier) : 31 % de
couverture, 28 % de multiplicité, médiane de 1 mail par dossier.

## 4. Preuves exécutées

**Moteur, sur le cas réel (production)** — mail URSSAF de Mylène :
```
focale « sujet » : 2 mails (le fil URSSAF)
focale « lie »   : 11 mails — LIASSE LB2I, CFE, FACTURES ÉLECTRONIQUES,
                   FACT CERFRANCE ×2, Approbation des comptes, RELANCE GREFFE,
                   URSSAF + NET ENTREPRISES, RECOMMANDES URSSAF, URSSAF ×2
                   → « vous êtes ici » sur le mail courant
focale « tout »  : 599, regroupés en conversations
```
Plus aucun « COUCOU » ni « 100 ans de la PLM » dans le défaut.

**Distribution de la règle (250 mails réels, 120 derniers jours)**
| focale | médiane | 75e | 90e | 95e |
|---|---|---|---|---|
| Ce sujet | 0 | 2 | 12 | 30 |
| Lié à ce mail | 1 | 10 | 19 | 66 |
| Tout | 41 | 121 | 144 | 412 |
⇒ 92 % des cas ≤ 20 liés (plafond retenu) ; 41 % sans aucun lié (d'où le soin
apporté au cas vide) ; réduction médiane **41 → 1**.

**Interface (captures + écoute des erreurs JS)**
- Route `/api/messages/398/contexte` → **200**.
- Trois focales rendues avec leurs compteurs :
  `["Ce sujet · 0", "Lié à ce mail · 0", "Tout avec Rentila · 9"]`.
- Cas vide affiché correctement + bouton d'élargissement.
- Vue élargie : 9 conversations regroupées, dépliables.
- **L'INVARIANT CENTRAL vérifié** : titre du lecteur AVANT et APRÈS le
  dépliement d'un message du contexte → **identique**, donc le mail principal
  n'est pas remplacé. Corps dépliés simultanément : **1**.
- **Aucune erreur JS** (le 502 observé est l'IMAP absent en dev, attendu).

**Outils** : `npx tsc --noEmit` OK · `node --check web/js/*.js` OK ·
accolades CSS 470/470 · scan d'octets de contrôle : néant.

**Diff réel ↔ carte d'impact** : conforme.

**Divergence assumée** : la barre collante « MAIL EN COURS » proposée par la
contre-revue n'est pas implémentée dans cette passe — le panneau reste sous le
mail dans un lecteur déjà défilable, et le repère « vous êtes ici » suffit à ce
stade. À réévaluer au rodage si le défilement le justifie.

## 5. Mise en service

- Déploiement : `git pull` + `npm run build` + `pm2 restart` (aucun changement
  de schéma, donc pas de `db:generate` nécessaire — mais l'habitude ne coûte
  rien depuis le piège du 18/08 matin).
- Rollback : `git revert` + rebuild. Aucune donnée touchée.
- **Rodage** : 2-3 boucles de retours attendues de lui.
