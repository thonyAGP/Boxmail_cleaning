# Contrat d'extraction — ce que l'IA lit dans un mail

> Demande du 11/08 : « fais une confrontation avec ChatGPT de tout ce qui peut
> servir et qui doit être extrait par l'IA à la lecture. Mieux vaut un bon tour
> là-dessus que de revenir à chaque besoin. »
>
> Née du reproche fondateur : « j'ai vraiment peur de ta conception qui est à
> corriger à chaque nouveau cas et qui en oublie systématiquement tant que je
> ne passe pas manuellement dessus. »

Ma position écrite AVANT la confrontation : `docs/archives-chatgpt/`.
Transcription complète : `docs/archives-chatgpt/extraction-2026-08-11.md`.
**Rien n'est codé à ce jour — ce document sert à décider.**

---

## 0. La correction principale

Ma proposition était d'ajouter les bons champs. La réponse commence par la
refuser :

> « La correction n'est pas de demander davantage de champs. Sinon tu vas
> fabriquer un formulaire de 40 champs au lieu de 7, et tu recommenceras dans
> six mois. »

La bonne abstraction :

> **L'IA extrait une représentation SÉMANTIQUE du mail ; le serveur en déduit
> les usages.**

On cesse donc de demander « faut-il l'afficher dans le briefing ? », « faut-il
créer une échéance ? », « faut-il l'archiver ? ». Ce sont des **projections**
d'une même vérité sémantique — des décisions de produit, pas des faits lus.

Et une nuance de vocabulaire à assumer : on n'écrira pas un schéma qu'on ne
modifiera jamais. On peut en revanche écrire une **enveloppe** qui n'oblige
plus à ajouter un champ de premier niveau à chaque nouvelle fonctionnalité.

---

## 1. Ce qui est à SUPPRIMER du contrat actuel

| Champ actuel | Verdict |
|---|---|
| `intent` (liste fermée) | **À remplacer** — mélange la fonction du message et le domaine métier |
| `action` (reply/pay/read/archive/none) | **À supprimer** — c'est une décision produit, pas un fait extrait |
| `summary` | À garder, mais **purement descriptif**, jamais utilisé comme donnée métier |
| `confidence` globale | **À supprimer** — beaucoup trop grossière |
| `reason` | **À supprimer** — redondant avec le résumé + les preuves, et coûteux |
| `senderCategory` | **À sortir du cœur** — le type de l'expéditeur n'est pas le sujet du mail |
| `dossier` en texte libre | **À remplacer** — bonne intuition fonctionnelle, mauvaise identité technique |

L'accident « payer maman » vient précisément de là : `sender = maman` a
contaminé « sujet financier = maman ». Il faut représenter **séparément** qui
envoie, qui émet le document, qui est concerné, et qui doit agir.

---

## 2. La structure retenue

Des **collections sémantiques indépendantes** plutôt qu'une intention unique.
Un mail peut porter zéro, une ou plusieurs actions, événements, documents.

```
verdict {
  schemaVersion, promptVersion        ← migrations
  analysis { status, inputCoverage }  ← ce que l'IA a RÉELLEMENT vu
  communication { purpose, subtype, summary }
  attention { mode, until, basis }    ← la péremption
  entities[]        ← personnes, sociétés, biens, véhicules, contrats…
  relations[]       ← qui envoie / émet / est concerné / est facturé
  actions[]         ← ce qui est attendu, de QUI, pour quand, jusqu'à quand
  events[]          ← rendez-vous, voyages, fenêtres de service
  documents[]       ← facture, devis, contrat, avis d'imposition…
  contextHints[]    ← le dossier, en MENTION et non en identité
  facts[]           ← soupape d'extension, sans migration
  uncertainties[]   ← le doute, exploitable
}
```

### La frontière fermé / libre

> **Fermé pour ce qui déclenche du code ; libre pour ce qui enrichit le sens.**

`purpose` est une liste courte et très stable — `request`, `response`,
`notification`, `confirmation`, `transaction_record`, `document_delivery`,
`security`, `marketing`, `conversation`, `other`, `unknown` — accompagnée d'un
`subtype` **libre** (`flight_check_in_reminder`, `temporary_service_outage`).
Un sous-type nouveau apparaît demain **sans migration et sans réanalyse**.

---

## 3. Le temps — ce qui manquait vraiment

Jamais un simple `date`. Chaque date est un objet portant sa **précision**
(datetime / date / mois / année / plage), son **explicitness** (lu ou inféré),
sa **preuve** et sa **certitude**. Et son rôle est porté par l'objet qui la
contient : `action.dueAt`, `action.expiresAt`, `event.startsAt`,
`document.issueDate`, `fact.validUntil`.

**La distinction fondamentale : `dueAt` ≠ `expiresAt`.**
Un paiement dû le 15 juin reste à faire le 16. Un enregistrement disponible le
15 juin **expire** le 16 quand l'avion décolle.

Puis une fenêtre d'attention propre au mail :

```
attention {
  mode: persistent | until_time | while_action_open |
        while_event_future | until_superseded | none | unknown
  until: <date>            basis: action_window | event_window |
                                   information_window | security_code | promotion
}
```

⚠️ **Attention ≠ conservation.** Une facture de 2019 a `attention = none` et
reste une archive précieuse. Ce sont deux axes distincts — c'est exactement la
confusion qui a fait dérailler le nettoyage.

Le serveur calcule ensuite gratuitement, à n'importe quelle date :
`estPérimé(verdict, maintenant)`. **Aucune IA n'est rappelée en août pour
comprendre que le 12 mai est passé.**

---

## 4. Les preuves, obligatoires

Chaque montant, numéro, adresse, identifiant ou date explicite doit porter une
**citation du texte** et sa source (`subject`, `body`, `attachment_name`,
`attachment_text`, `thread_context`).

> Extraire ce qui est vu ; inférer seulement ce qui est nécessaire ;
> **toujours distinguer les deux**.

C'est la règle anti-invention, et elle manquait totalement.

---

## 5. Les entités — et l'erreur que j'allais commettre

L'IA fournit des **mentions** (`nameRaw`, identifiants, preuves). Elle ne
produit **jamais** l'identifiant canonique.

> « Il écrira un jour "46 rue de la République", puis "Immeuble République",
> puis "46 Rue République Brest". Ce n'est pas un bug du modèle : c'est le
> mauvais outil pour assurer l'identité. »

C'est exactement l'erreur que j'étais en train de faire avec `dossier` en
texte libre servant de clé. **Le serveur tient l'identité** : une table
d'entités, une table d'alias, une table d'identifiants. L'IA propose, le
résolveur local décide.

Le dossier survit donc comme **`contextHint`** (type + libellé + entités
d'ancrage + preuve), résolu localement vers un identifiant stable. Le
regroupement se fait sur l'identifiant, **jamais sur la chaîne produite par
l'IA**.

---

## 6. Le doute, rendu exploitable

Plus de confiance globale : une **certitude par affirmation**
(`explicit` / `strong_inference` / `weak_inference` / `unknown`).

> « Pourquoi interdire le classement documentaire parce que le bénéficiaire est
> incertain ? »

Et un doute structuré, qui dit **comment le lever** :

```
uncertainty {
  fieldPath, reason: not_present | ambiguous | truncated_input |
                     missing_attachment | missing_thread_context | conflicting_evidence
  description, resolvableWith: full_body | attachment_text |
                               thread_context | manual_review
}
```

C'est ce qui permet une **réanalyse ciblée** au lieu de tout relire.

---

## 7. L'entrée : 500 caractères ne suffisent pas

Suffisant pour une newsletter, un code, une confirmation simple. **Insuffisant**
pour un document transféré, une demande cachée en fin de mail, une facture, un
mail à plusieurs sujets.

Budget d'entrée recommandé : **1 500 à 2 500 caractères SÉLECTIONNÉS** — pas
les 2 000 premiers. Le prétraitement local (gratuit, déterministe) retire
signatures, avertissements juridiques, historique cité, navigation HTML, et
conserve le début, les paragraphes portant chiffres et dates, et la fin.

**Deux informations très rentables que je n'envoie pas aujourd'hui :**
- **les destinataires** (À / Copie) : Anthony destinataire direct, en copie, ou
  expéditeur — ça change tout le jugement « une réponse est-elle attendue » ;
- **le nom des pièces jointes** : `FACTURE_SOSH_052026.pdf` coûte trois mots et
  donne un signal énorme (déjà collecté depuis ce matin).

Le fil : **des métadonnées, pas les messages** — nombre de messages, direction
du dernier, « a-t-il répondu après celui-ci », et seulement si nécessaire un
extrait du message précédent.

---

## 8. Deux passes plutôt qu'une

- **Passe A** : analyse compacte de tous les mails.
- **Passe B** : uniquement ceux dont le verdict signale `truncated_input`,
  `missing_attachment` ou `missing_thread_context` **et** qui touchent à
  quelque chose de sensible (paiement, échéance, réponse, pièce comptable,
  briefing, suppression risquée).

On relit alors 2 à 5 % des mails avec plus de contexte, au lieu d'envoyer
5 000 caractères sur 25 000 mails.

---

## 9. La frontière serveur / IA — la règle à retenir

> Si deux programmeurs raisonnables obtiennent la réponse avec les mêmes
> données **sans comprendre une phrase** → serveur.
> S'il faut **comprendre ce que veut dire une phrase dans son contexte** → IA.

| Serveur (gratuit, rejouable sur 25 000 mails) | IA (une fois par mail) |
|---|---|
| date de réception, âge, `maintenant > expiresAt` | ce que SIGNIFIE une date |
| De / À / Copie, fils, entrant-sortant | qui est réellement acteur ou bénéficiaire |
| types MIME, pièces jointes, empreintes, doublons | nature sémantique du document |
| résolution d'entités, canonicalisation des dossiers | reconnaître le sujet de vie, proposer les mentions |
| compteurs par expéditeur, fréquence, index | classer la fonction du message, résumer |
| priorisation, règles de sécurité, décision de nettoyage | extraire les obligations, comprendre les ambiguïtés |

**C'était exactement mon erreur** : j'ai codé en dur ce qui exigeait du
jugement, et fait juger l'IA sur ce qui était mécanique.

---

## 10. Ce qu'il ne faut SURTOUT PAS demander

Une importance de 1 à 10 · un score numérique de confiance · une catégorie
définitive de dossier · un identifiant canonique · une recommandation
d'archivage ou de suppression · une priorité quotidienne · « faut-il envoyer au
logiciel X ? » · une interprétation comptable, juridique ou fiscale définitive ·
un résumé long · une justification narrative de chaque décision · la recherche
exhaustive de toutes les personnes citées.

Consigne à donner explicitement : **n'extraire que les entités qui participent
au sens opérationnel du message** — pas le président cité dans la signature,
l'adresse légale des CGV et les quatre marques du bas de page.

---

## 11. Versions et réanalyse

Trois versions distinctes : `schemaVersion`, `promptVersion`, `inputVersion`.
On sélectionne les mails à relire **par les anciennes données et les
métadonnées déterministes**, puis on ne réanalyse que ceux-là.

Priorité de relecture : ce qui touche à l'argent, aux échéances, aux réponses
attendues, aux dossiers actifs, aux mails récents.

---

## 12. Le point non négociable

> **Stocker le verdict IA d'origine comme un JSON immuable**, puis en dériver
> des projections locales (`mail_actions`, `mail_events`, `mail_documents`,
> `entity_mentions`, `mail_context_links`…).

Parce que dans six mois on voudra changer **le fonctionnement du briefing**
sans changer **ce que l'IA avait compris du mail**. Aujourd'hui les deux sont
confondus : le verdict écrit directement dans `intent`, `aiAction`,
`analysisConfidence`. Toute évolution de produit impose donc une réanalyse.

---

## 13. Ce que ça donne sur les trois échecs réels

**Air France, « enregistrez-vous pour le voyage du 16/06 »** —
`purpose: request`, `subtype: flight_check_in_reminder`, une action
`check_in` d'`actor: user`, `strength: requested`, **`expiresAt: 2026-06-16`**
(inféré, avec citation du sujet), `attention.mode: until_time`.
Le 11 août, aucune IA n'est rappelée : le serveur constate `until < maintenant`
et le mail ne peut plus entrer dans le briefing. **Sans veto, sans rustine.**

**PayFiP indisponible le 12 mai** — zéro action, un événement
`service_window` de participation `informational`. Le mot « paiement » ne
déclenche plus rien. Fin du problème d'échéance inventée.

**Maman transmet une facture Sosh** — deux entités (maman = `sent_by`,
Sosh = `issued_by`), un document `invoice`, et surtout **aucune action de
paiement envers maman**. Le raccourci devient structurellement impossible.

---

## 14. Ce que ça implique concrètement

Ce n'est pas une retouche : c'est une **refonte de la couche d'analyse**.

1. Nouveau contrat côté MCP (`submit_analysis_batch`) et nouveau lot envoyé
   (destinataires, noms de pièces, métadonnées de fil, 1 500-2 500 caractères
   sélectionnés).
2. Stockage du verdict brut immuable + tables de projection.
3. Résolveur d'entités et de dossiers côté serveur (alias, identifiants).
4. Réécriture des consommateurs (briefing, échéances, réponses attendues,
   nettoyage, connecteurs) pour lire les projections au lieu de `intent` et
   `aiAction`.
5. Compatibilité : les 17 000 verdicts actuels restent lisibles ; on ne
   réanalyse que par priorité.

**À arbitrer avec Anthony avant d'écrire une ligne** : c'est plusieurs jours de
travail, et ça touche tout ce qui marche aujourd'hui.
