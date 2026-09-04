# Brancher le filet qui existait déjà (audit D1 + E3)

> Niveau **moyen**. Critères déclenchés : **(a) taille** — 6 fichiers touchés ;
> **(e) réversibilité** — une suppression de fichier, mais versionnée : `git revert`
> la rend en une commande et le fichier reste dans l'historique. C'est ce qui
> maintient le chantier à « moyen » plutôt qu'« élevé ».
> Contre-revue : déjà faite sur ce ticket le 03/09 (Codex, lecture seule du dépôt —
> D1 nuancé et reformulé à cette occasion, cf. `docs/AUDIT-2026-09-03.md` § Contre-revue).

## 1. Intention

**Besoin.** `src/cli/verdict-check.ts` porte 175 assertions pures sur douze services.
Elle est verte. Aucune documentation, aucun barrage, aucun contrat d'usine ne la
connaissait : `.factory.json` ne lançait que `typecheck`. L'audit du 03/09 partait du
prémisse « zéro test » — faux : le filet existait, débranché.

**Succès observable.** Dans trois mois, une régression sur `verdict`, `attention`,
`importance`, `today`, `search`, `dossiers` ou `accounting` fait échouer le barrage
d'arrêt de l'usine, sans que personne ait eu à y penser.

**Non-objectifs.** Migrer vers Vitest (viendra après, en migrant ce patron plutôt qu'en
le réécrivant) ; écrire de nouvelles assertions ; toucher au port `:8787`/`:8799`
(ticket D7).

## 2. Carte d'impact

| Zone | Touchée | Comment |
|---|---|---|
| `package.json` | directe | script `test` = `verdict:check` |
| `.factory.json` | directe | `checks.onStop` = `typecheck && test` |
| `.gitattributes` | directe | `docs/banc-etiquettes.json -diff` (E3) |
| `CLAUDE.md`, `README.md` | directe | doc : `npm test` dans « avant de pousser », lanceur supprimé |
| `start-boxmail.bat` | supprimé | E3/D7 |
| Poste d'Anthony | **indirecte** | un raccourci Bureau vers `start-boxmail.bat` cassera au prochain pull |
| Toute session future | **indirecte** | l'arrêt de l'usine coûte désormais le temps de `npm test` (~20 s) |

**Ce que ça fait remonter.** Le barrage d'arrêt devient bavard : la première session qui
casse une assertion verra un échec qu'elle n'attendait pas. C'est l'effet recherché, mais
c'est la première fois qu'il se produit.

**Invariants.**
- Le barrage d'arrêt passe seulement si `typecheck` ET les 175 assertions passent.
- `npm test` reste exécutable sans base, sans `.env` et sans réseau (fonctions pures).
- Un lanceur reste double-cliquable pour un utilisateur non technique : `MailAssistant.bat`.

## 3. Inconnues & hypothèses

- **Hypothèse** : Anthony n'a pas de raccourci actif vers `start-boxmail.bat` — sinon le
  README et `CLAUDE.md` lui disent quoi refaire. Non vérifiable depuis ici : annoncé.
- **Inconnue** : la durée de `npm test` sur le serveur Oracle n'a pas été mesurée. Sans
  effet ici (le barrage ne tourne qu'en session de développement).

## 5. Plan de preuve

| Ce qui est prouvé | Comment |
|---|---|
| Les 175 assertions passent | `npm run verdict:check`, exit 0 |
| Le nouveau script les lance vraiment | `npm test`, exit 0, même sortie |
| Rien n'est cassé côté types | `npm run typecheck` (couvre `src/` ET `web/`), exit 0 |
| Le diff correspond à la carte | `git diff --cached --stat` confronté au tableau ci-dessus |

## 6. Preuves exécutées (04/09)

- `npm run verdict:check` → « ✅ 175 vérifications passées. », `EXIT=0`.
- `npm test` → « ✅ 175 vérifications passées. », `TEST_EXIT=0` (le câblage fonctionne).
- `npm run typecheck` → `TYPECHECK_EXIT=0`.
- `git diff --cached --stat` → 6 fichiers, 12 insertions, 42 suppressions
  (`.factory.json`, `.gitattributes`, `CLAUDE.md`, `README.md`, `package.json`,
  `start-boxmail.bat` supprimé) — **conforme à la carte d'impact, aucune divergence**.
