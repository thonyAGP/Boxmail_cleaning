# Reprise — chantier « Ce qui part à la compta » (session du 27/08 morte de trop-plein)

> La session `562b1ce4` est morte à 21h07 : 909k tokens + 19 images → corps de requête ~5,5 Mo tronqué, plus AUCUN envoi possible (erreur « request body is not valid JSON »). Rien n'est perdu : cette fiche est extraite de son transcript. **Ne pas la rouvrir ni « continue »** — repartir d'une session neuve avec cette fiche.

## Ce qui est LIVRÉ et vérifié (ne pas refaire)

- **Lien en navigation** : `🧾 Ce qui part à la compta` visible sans déplier « PLUS », une seule entrée (doublon retiré, vérifié à l'écran).
- **Correctif du repli de lecture des pièces** : le repli qui lit le texte du document n'était consulté que si l'analyse était totalement muette — dès qu'elle disait « facture de X » sans montant, la lecture était court-circuitée. Corrigé. Mesure avant/après sur les 213 pièces : 182 → **186 complètes**, 25 → **20 sans montant**. Récupérés notamment : **Air France 211,78 €** et **Air France 441,78 €** (chaque ligne dit sa source : « montant lu DANS LE DOCUMENT »).
- **Garde-fou anti-100 000 €** : le repli a deux niveaux — total **étiqueté** (« Total TTC : … ») gardé, **devinette** (« montant le plus élevé trouvé ») écartée : c'est elle qui inventait 100 000,00 €.

## Ce qui était EN COURS au moment du crash (à reprendre ici)

1. **Qualité OCR des « montants présents »** : beaucoup sont en réalité de l'OCR illisible (ex. `TOTAL H.T. Ss 2. €.`). L'examen des cas au texte propre était commencé.
2. **Ticket Decathlon** : 4 340 caractères extraits et zéro somme — impossible si le texte était réel ; il fallait regarder le texte brut réellement extrait.
3. **Dernier message d'Anthony, JAMAIS TRAITÉ** : « ça c'est bon comme document de facture pour les voyages airfrance » avec un exemple de facture → image sauvée ici : `docs/exemple-facture-airfrance-2026-08-27.png`. À analyser comme référence du format attendu.

## Leçon (déjà 3e occurrence : 13/08 ×2, 27/08)

Le travail par lots sur les mails/pièces DOIT se faire en contextes neufs (un sous-agent par lot, ou /clear entre vagues) — au-delà de ~50 mails ou d'une dizaine d'images dans une même conversation, la session dépasse le plafond de requête et meurt sans retour. C'est écrit dans l'outil `next_analysis_batch` ; cette fiche en est la 3e preuve.
