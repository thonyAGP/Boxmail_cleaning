# CHG-001 : Audit complet de Boxmail — carnet de 32 tickets

> Un audit mesuré (backend, front, qualité/ops) contre-revu par Codex, à traiter ticket par ticket, une session par ticket.

## Metadata

| Champ | Valeur |
|-------|--------|
| ID | CHG-001 |
| Status | APPROVED |
| Priority | P1 |
| Created | 2026-09-03 |
| Author | Claude (session 01WysMShrxsVHJqS674t2YuA), validé par Anthony |
| Reviewer | Codex (contre-revue en lecture seule, thread 01a06933) |

---

## Context

### Problème / Besoin
L'usine, une fois rendue exécutable sur ce poste, a montré que le contrat de vérification ne
regardait pas le fichier le plus modifié du dépôt. Anthony a demandé un audit de **tout** ce qu'il y
a à voir, à traiter ensuite point par point par des sessions Opus séparées.

### Objectif
Un carnet de tickets **autoporteurs** — constat sourcé (fichier:ligne), action, preuve attendue,
niveau de cadrage — qu'une session neuve peut prendre sans relire l'audit.

### Source de vérité
**`docs/AUDIT-2026-09-03.md`** (copie : `.openspec/plans/2026-09-03-audit-complet.md`).
Ce change request n'en duplique pas le contenu.

### Hors scope
- Aucune implémentation dans ce CHG : chaque ticket ouvrira son propre cadrage (`/usine:cadrer`)
  s'il est marqué moyen/élevé.
- Les décisions listées « à Anthony » (historique git pour D4, valeurs de rate limit, rétention du
  journal, sort de `feature/recherche-conversationnelle`, écrans inatteignables, sauts de majeure).

---

## Spec Delta

### ADDED

| ID | Requirement | Priority |
|----|-------------|----------|
| R1 | Le projet SHALL brancher la suite `verdict:check` (175 assertions, verte) dans `npm test` et dans le contrat de l'usine (`checks.onStop`). | P1 |
| R2 | `esc()` SHALL encoder `"` et `'` ; aucune donnée issue d'un mail MUST NOT atteindre un attribut HTML sans cet encodage. | P1 |
| R3 | Toute suppression en lot SHALL passer par UNE fonction de service avec plafond, dry-run et journal ; la route bulk de l'interface SHALL exiger une confirmation explicite. | P1 |
| R4 | Les connexions IMAP/SMTP SHALL exiger TLS (`requireTLS`) dès que `secure` est faux. | P1 |
| R5 | Le supervisor Windows SHALL revenir au commit précédent après deux échecs d'installation ou de build, et l'écrire dans le statut lu par l'interface. | P1 |
| R6 | Aucune adresse e-mail de tiers réel MUST NOT figurer dans les sources ; les exemples SHALL utiliser `.invalid`. | P1 |
| R7 | Les jobs SHOULD survivre à un redémarrage (état en base, marquage « interrompu », timeout, verrou). | P2 |
| R8 | Les routes d'écriture SHOULD valider leurs entrées (Zod) et les erreurs SHOULD être rendues par un middleware unique sans message brut. | P2 |
| R9 | Les dialogues natifs (`alert`/`confirm`/`prompt`) SHOULD être remplacés par des composants à promesse, pour que les chemins de suppression soient rejouables par l'usine. | P2 |
| R10 | La documentation de référence (README, ROADMAP, DEPLOY-ORACLE, CLAUDE.md) SHALL être vraie sur les chiffres et les procédures qu'elle cite. | P2 |

### MODIFIED
Aucun requirement existant modifié.

### REMOVED
Aucun.

---

## Acceptance Criteria (par ticket, cf. carnet)
Chaque ticket porte sa propre preuve attendue. Critère commun à tous :
`npm run typecheck` vert, `npm run verdict:check` vert, `factory verify --all` sans régression,
drapeau de preuve puis commit sur `main`, journal et spec à jour.

## Scénario global
```
GIVEN le carnet docs/AUDIT-2026-09-03.md
WHEN une session prend un ticket
THEN elle relit le ticket, pull, cadre si moyen/élevé, implémente, prouve, commite, coche le ticket
```

---

## Avancement — 04/09/2026 (status : IMPLEMENTING)

| Req | État | Où |
|---|---|---|
| R1 | **SATISFAIT** | `npm test` = `verdict:check` ; `.factory.json` `checks.onStop` = `typecheck && test`. Preuve : 175 vérifications, exit 0. |
| R2 | **SATISFAIT** | `web/js/api.js:398-430` (table d'échappement, `"` et `'` compris) ; `app.js:12208-12209`. Preuve navigateur : `onmouseover` créé AVANT, `null` APRÈS. |
| R5 | **SATISFAIT** | `scripts/supervisor.mjs` : 2 tentatives puis retour au commit précédent + statut lu par ⚙️ Paramètres. Banc à 5 scénarios. |
| R3 | **CADRÉ, non implémenté** | `.chantier/2026-09-04-suppression-un-seul-chemin/change.md` (niveau élevé, 7 invariants). Deux décisions attendent Anthony : le seuil d'aperçu, un plafond ou deux. |
| R6 | en cours | passe du 04/09 |
| R4, R7-R10 | non commencés | — |

**Requirement ajouté le 04/09 — R11** : une annulation de suppression SHALL restaurer tous les mails
qu'elle annonce, ou SHALL dire exactement ce qu'elle a restauré et ce qui reste. Motif : la route
d'annulation tronque à 500 en silence (`admin.ts:2893-2901`) et le front ignore le compteur `restored`
— une annulation de 800 mails en restaure 500 et affiche un succès. Ticket **A8** du carnet.

**Correction apportée à R3 par le cadrage** : le constat parlait de trois implémentations, il y en a
**quatre** (`services/review.ts:1204-1225`, plafond 500), et deux autres routes portent le même trou
de 20 000 (`cleanup/execute`, `retention/apply` — cette dernière sans aucun plafond). Par ailleurs
« exiger une confirmation explicite » ne peut pas être inconditionnel : l'absence de double clic sur
le chemin boîte de réception est un choix d'Anthony daté du 10/08. R3 se lit donc **avec un seuil**.

**Correction apportée à R2 par l'implémentation** : la preuve écrite au carnet le 03/09 (« aucune
`<img>` injectée ») ne prouvait rien — l'ancien `esc()` échappait déjà `<` et `>`. La preuve valable
nie la **création d'un gestionnaire** (`onmouseover`), pas la présence d'une balise.
