# Changement — front-sous-controle

- **Date** : 2026-09-03 · **Niveau de risque** : **moyen**
- **Critères déclenchés** :
  - **(a) Taille** : passe mécanique sur `web/js/app.js` (12 303 lignes) —
    123 `querySelectorAll`, 66 `e.target` / `e.currentTarget`, plus une
    trentaine d'annotations ; 6 fichiers touchés au total.
  - **(c) Chemin critique** : deux corrections de comportement, dont une sur la
    boucle d'attente qui suit une mise à jour — le canal de livraison.
- **Domaines sensibles** : aucun secret, aucune migration, aucun envoi. Le seed
  n'écrit que sur deux slugs de démonstration.

## 1. Intention

- **Besoin** : `web/js/app.js` concentre 57 des 193 commits des 30 derniers
  jours et n'a aucun contrôle mécanique ; `.factory.json` déclare pourtant
  `npm run typecheck`, borné à `src/**/*.ts`. Le contrat rendait vert sans
  regarder le fichier le plus modifié du dépôt.
- **Critères de succès observables** : `npm run typecheck` couvre `src/` ET
  `web/` et sort vert ; une faute de frappe injectée dans le front fait sortir
  `factory check onEdit` en ROUGE ; les écrans quotidiens se rendent sans
  erreur console après la passe.
- **Non-objectifs** : ne PAS migrer `web/` en TypeScript (le JS vanilla servi
  tel quel est un choix du projet) ; ne pas toucher au rendu ni aux styles ;
  ne pas corriger les 3 écarts de socle de l'écran de connexion (autre sujet).

## 2. Carte d'impact

- **Direct** : `tsconfig.web.json` (nouveau), `package.json` (`typecheck`
  scindé en `:src` / `:web`, `seed:dev`), `web/js/app.js`, `web/js/api.js`,
  `scripts/seed-dev.mjs` (nouveau), `.factory/scenarios/tour-des-ecrans.json`
  (nouveau).
- **Indirect** : TOUS les écrans — la passe touche les gestionnaires de clic
  de l'application entière. C'est le risque principal du chantier, et la
  raison du scénario connecté.
- **Invariants** :
  - Aucun changement de rendu, de style ou de route.
  - `web/` reste du JavaScript servi tel quel : rien n'est compilé, rien n'est
    produit, `noEmit` partout.
  - Les deux corrections de comportement sont des RÉTABLISSEMENTS d'une
    intention déjà écrite (sonde publique de vie ; garde du brouillon), pas de
    nouvelles fonctions.
  - Le seed n'agit que sur `demo_perso` / `demo_pro`.

## 3. Décision

Vérifier le front avec TypeScript **en lecture seule** (`checkJs`, `noEmit`).
Tolérer le type dans les helpers de sélection (`ElementEcran`), et **laisser
`querySelector` écrit en toutes lettres rendre un `Element` strict** : c'est
cette sévérité qui a révélé `draft.value` sur un div contenteditable. Écarté :
la fusion d'interface qui élargirait `ParentNode.querySelector` (elle aurait
effacé le bug), et l'annotation des ~340 appels un par un.

## 4. Plan de preuve

| Ce qu'on veut établir | Comment | Résultat |
|---|---|---|
| Le front est contrôlé | `npm run typecheck` (src + web) | vert, 0 écart |
| Le barrage MORD | faute témoin `corps.datset` → `factory check onEdit` | ROUGE, ligne + suggestion, puis restaurée |
| Rien de cassé à l'écran | `factory verify tour-des-ecrans` (6 écrans, connecté, données du seed) | VERT, 0 erreur console |
| L'écran de refus tient | `factory verify login-ecran-refus` | VERT |
| Le socle n'a pas bougé | `factory audit /admin` | 3 écarts sur 9, identiques à avant |
| Les deux routes de santé diffèrent | `curl /health` et `curl /api/health` sans session | 200 public / 401 |

**Non prouvé** : l'Échap sur la modale de réponse (demande un corps de mail
réel, donc un IMAP réel) ; `decision-compteur-coherent` reste ROUGE, il lui
faut une file de dépouillement que le seed ne remplit pas.
