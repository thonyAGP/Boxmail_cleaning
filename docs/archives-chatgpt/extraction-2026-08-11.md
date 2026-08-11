# Contrat d'extraction — échange ChatGPT du 11/08/2026

Conversation dédiée : <https://chatgpt.com/c/6a7b1d49-7a74-83eb-97c9-30e4e500b8ec>

Synthèse et décisions : `docs/CONTRAT-EXTRACTION.md`

---

## Ma position, écrite AVANT de lire la réponse

# Ma position AVANT de lire la réponse de ChatGPT

Écrite d'abord pour pouvoir la confronter honnêtement, et non l'abandonner
silencieusement si l'autre réponse est mieux tournée.

## 1. La faute de fond, telle que je la comprends

J'ai inversé la répartition. J'ai **codé en dur ce qui exigeait du jugement**
(les expressions régulières de dossier, « un rappel attend une réponse ») et
j'ai **fait juger l'IA sur ce qui était mécanique** — pendant que je calculais
moi-même l'âge d'un mail ou le fait qu'il ait été lu.

La bonne ligne de partage :

| Déterministe (serveur, gratuit, rejouable sur 25 000 mails) | IA (jugement, une fois par mail) |
|---|---|
| expéditeur, date de réception, fil, dossier IMAP | ce que le mail VEUT dire |
| noms et tailles de pièces jointes, doublons | si une action est attendue DE LUI |
| lu / non lu, ai-je répondu | la date et sa NATURE |
| âge, seuils, comptages | le dossier, le vrai interlocuteur, les montants |
| rattachement d'un mail à un libellé déjà connu | la première apparition d'un libellé |

## 2. Les champs que je proposerais

**Ce que le mail veut** — `purpose` en liste fermée MAIS avec une porte de
sortie `other` + un texte libre, sinon on retombe sur le défaut actuel : une
liste qui oublie les cas nouveaux et qu'il faut rallonger à la main.

**Ce qu'il attend de lui** — `action_required` (booléen), `action` (texte court
en français : « confirmer par retour de mail », « payer 399 € HT »). C'est ce
qui manquait sur Air France : le rappel n'attendait rien de lui.

**Le temps, et c'est le gros trou actuel** — quatre choses distinctes :
- `action_due_at` : la date qui l'oblige à agir ;
- `event_at` : la date dont parle le mail (le vol, le rendez-vous) ;
- `expires_at` : **quand ce mail cesse de compter** — le champ absent qui
  aurait tué le cas Air France tout seul, sans veto ni rustine ;
- `retain` : une valeur documentaire durable (facture, acte) qui survit à
  l'expiration de l'utilité.

**De qui ça parle vraiment** — `counterparty` distinct de l'expéditeur. Le mail
de sa mère portant une facture Sosh a pour expéditeur « maman » et pour
interlocuteur réel « Sosh ». Ce seul champ réglait le troisième échec.

**Où ça se range** — `dossier` (libellé libre) + `dossier_kind`.

**Les chiffres** — `amount`, `currency`, `amount_kind` (dû / payé / devis),
`reference` (numéro de facture, de dossier, RG). Uniquement si écrits noir sur
blanc.

**La prudence** — `confidence`, et je pense qu'elle doit être **par champ
critique** plutôt que globale : on peut être sûr que c'est une facture et
incertain sur le montant. Aujourd'hui une confiance unique tire tout vers le bas.

**La sensibilité** — santé, justice, famille : un marqueur qui interdit à vie
toute suppression automatique, indépendamment du reste.

## 3. Ce que je ne demanderais PAS

- Une **priorité** ou un score d'importance : c'est une décision de produit,
  qui dépend de son agenda et de ses sociétés, pas une lecture du mail.
- La **catégorie de l'expéditeur** : son comportement de lecture la dit mieux,
  et gratuitement.
- Tout ce qui exige le corps complet alors qu'on n'envoie que 500 caractères.

## 4. Les deux questions que je n'ai pas tranchées

**La stabilité des libellés.** Pour que deux mails tombent dans le même
dossier, l'IA doit écrire exactement la même chose à un an d'intervalle. Une
consigne ne suffira pas. Il faut probablement lui **montrer les dossiers déjà
connus** dans le lot qu'on lui envoie, et lui demander de réutiliser un libellé
existant plutôt que d'en inventer un.

**L'évolution du schéma.** 17 000 mails ont été analysés avant l'existence du
champ `dossier`. Il faut une version de verdict, un marqueur « à relire », et
une priorité de relecture — sinon chaque évolution coûte 25 000 relectures.

---

## Ma question

```
Sujet autonome, et je veux qu'on le règle EN UNE FOIS : que doit extraire une IA qui lit un email, pour servir tous les usages présents ET futurs d'un assistant de messagerie ? Je viens de me faire reprendre par mon utilisateur, à juste titre, et je préfère un bon tour de conception maintenant qu'un champ ajouté à chaque besoin.

LE REPROCHE, MOT POUR MOT
« Tu peux faire en sorte que l'extraction vienne du moteur IA qui parse les emails plutôt que les règles en dur faites par script. J'ai vraiment peur de ta conception qui est à corriger à chaque nouveau cas et qui en oublie systématiquement tant que je ne passe pas manuellement dessus. »
Il a raison. J'ai ajouté mes champs un par un, au fil des besoins, et j'ai écrit des règles codées qui ratent tout ce que je n'ai pas prévu.

L'UTILISATEUR
Anthony, non technique. 7 boîtes mail, ~25 000 mails sur dix ans. Il dirige 5 sociétés (SCI, SARL de gestion immobilière, SASU de négoce de VÉHICULES, holding) et possède plusieurs biens immobiliers, dont un en location saisonnière à Paris et un immeuble à Brest. Il a aussi une vie personnelle dans la même boîte : famille, santé, école. Objectif qu'il répète : « réduire ma charge neuronale ».

L'ARCHITECTURE, ET SA CONTRAINTE PRINCIPALE
Serveur Node + SQLite sur un petit VPS. AUCUNE clé d'API d'IA côté serveur — décision assumée : l'analyse tourne sur SON abonnement Claude, via un connecteur MCP. Concrètement : le serveur prépare un lot de mails (jusqu'à 100), Claude les lit dans sa fenêtre de conversation et renvoie un tableau de verdicts JSON que le serveur enregistre.
Ce que le serveur envoie aujourd'hui pour chaque mail : expéditeur (nom + adresse), sujet, date, boîte, et un EXTRAIT d'environ 500 caractères du corps (texte cité retiré). Quand la pièce jointe a pu être lue localement, son texte est aussi disponible (PDF, Office). Le corps complet n'est PAS envoyé : ce serait trop coûteux sur 25 000 mails.
Conséquence importante : l'analyse coûte le temps et le quota de l'utilisateur. On ne relit pas 25 000 mails à chaque évolution du schéma.

CE QUI EST EXTRAIT AUJOURD'HUI (ajouté au fil de l'eau, d'où ma question)
- intent : liste fermée — otp, invoice, shipping, appointment, reminder, confirmation, document, promo, reply_expected, action_required, info
- action : liste fermée — reply, pay, read, archive, none
- summary : une ligne en français
- confidence : high | medium | low (low ⇒ le mail est protégé de tout nettoyage)
- reason : pourquoi, en français, affiché tel quel à l'utilisateur
- senderCategory : person, company, bank, insurance, admin, marketplace, social, newsletter, notification, ad
- dossier (ajouté aujourd'hui) : libellé LIBRE du sujet de vie auquel le mail se rattache (« 46 rue de la République », « Affaire ODAS »), justement pour ne plus dépendre de règles codées.

QUI CONSOMME CES CHAMPS
Un briefing quotidien (« 3 choses méritent ton attention »), une liste de réponses attendues, des relances, un calendrier d'échéances, un moteur de nettoyage, une recherche « retrouver sans classer », un connecteur qui envoie les factures vers son logiciel comptable, un connecteur vers son logiciel de gestion locative, et maintenant les dossiers.

TROIS ÉCHECS RÉELS QUI MONTRENT CE QUI MANQUE
1. Un mail Air France « Enregistrez-vous pour votre voyage du 16/06 » est arrivé PREMIÈRE priorité du jour, deux mois après le vol. L'analyse avait pourtant écrit « rappel d'enregistrement classique » — mais aucune heuristique ne la consultait, et surtout rien ne disait que l'objet du mail était PÉRIMÉ.
2. Un message annonçant l'arrêt d'un service le 12 mai a été transformé en échéance à honorer. Rien ne distinguait « date dont je dois me souvenir » de « date qui m'oblige à agir ».
3. Un mail de sa mère portant le scan d'une facture Sosh a été classé « payer maman ». L'expéditeur ne dit pas de quoi parle le document.

MA QUESTION, EN UN SEUL BLOC
Conçois le CONTRAT D'EXTRACTION complet — celui qu'on écrit une fois et qu'on ne rouvre plus tous les quinze jours.

1. Quels champs ? Donne le schéma que tu recommandes, champ par champ, avec pour chacun : son type, s'il est en liste fermée ou en texte libre, s'il est obligatoire, et SURTOUT quel usage concret il sert. Inclus ce que j'ai oublié.
2. Liste fermée ou texte libre : où passe la frontière ? Mon `intent` fermé a raté le cas « information dont la date est passée ». Mais tout ouvrir rendrait les données inexploitables. Quel est le bon compromis, et comment fait-on évoluer une liste fermée sans réanalyser 25 000 mails ?
3. Les ENTITÉS : dois-je demander à l'IA d'extraire montants, dates, numéros de facture, références de dossier, noms de personnes, adresses de biens, sociétés concernées ? Si oui, sous quelle forme exacte, et comment j'évite qu'elle invente ? Comment obtenir la MÊME orthographe d'un mail à l'autre pour qu'ils se regroupent (c'est mon problème du dossier) ?
4. Le TEMPS. Il me faut distinguer : une date qui oblige à agir, une date d'événement, une date d'information, et surtout savoir quand un mail est PÉRIMÉ. Quels champs temporels demander pour que l'assistant sache tout seul qu'un mail ne mérite plus d'être montré ?
5. Ce qu'il ne faut PAS demander : qu'est-ce qui coûte cher, invite à l'hallucination, ou sera de toute façon mal fait sur un extrait de 500 caractères ?
6. Le doute. Comment structurer « je ne sais pas » pour que ce soit exploitable plutôt qu'un trou ? Faut-il une confiance globale, ou une confiance par champ ?
7. L'ENTRÉE. Est-ce que 500 caractères suffisent ? Faut-il envoyer le fil de discussion, l'historique avec l'expéditeur, le nom des pièces jointes ? Qu'est-ce qui améliorerait le plus la qualité pour le moindre coût ?
8. LA VERSION. Comment je gère l'évolution du schéma dans le temps sans tout réanalyser : versionner le verdict, marquer les mails à relire, prioriser lesquels ?
9. La RÉPARTITION. Qu'est-ce qui doit rester déterministe côté serveur (donc gratuit et rejouable sur 25 000 mails) et qu'est-ce qui exige vraiment le jugement de l'IA ? C'est le cœur de mon erreur : j'ai codé en dur ce qui demandait du jugement, et j'ai fait juger l'IA sur ce qui était mécanique.

Donne un schéma concret, prêt à coder, avec des exemples de verdicts remplis sur deux ou trois de mes cas réels ci-dessus. Sois sévère sur ce que je propose déjà : dis-moi ce qui est à supprimer, pas seulement ce qui est à ajouter.
```

## Réponse

Oui : ton utilisateur a raison sur le diagnostic, mais la correction n'est pas « demander davantage de champs à Claude ». Sinon tu vas simplement fabriquer un formulaire d'extraction de 40 champs au lieu de 7, et tu recommenceras dans six mois.

La bonne abstraction est :

l'IA extrait une représentation sémantique du mail ; le serveur en déduit les usages.

Tu ne dois plus demander à Claude « faut-il l'afficher dans le briefing ? », « faut-il créer une échéance ? », « faut-il l'archiver ? ». Ce sont des projections d'une vérité sémantique commune.

Et première correction de vocabulaire : tu ne pourras pas écrire un schéma que tu ne modifieras jamais. En revanche, tu peux écrire aujourd'hui une enveloppe qui ne nécessitera plus d'ajouter un champ top-level pour chaque nouvelle fonctionnalité.

1. Ce que je supprimerais de ton contrat actuel

Je commencerais par casser plusieurs choses.

Champ actuel	Verdict
intent	À supprimer/remplacer. Il mélange fonction du message et domaine métier.
action	À supprimer comme verdict IA. pay/read/archive/none est une décision produit, pas un fait extrait.
summary	À garder, mais purement descriptif et jamais utilisé comme donnée métier.
confidence globale	À supprimer. Trop grossière.
reason	À supprimer. Redondant avec summary + preuves et très coûteux en tokens.
senderCategory	À sortir du cœur du verdict. Le type de l'expéditeur n'est pas le sujet du mail.
dossier libre	À remplacer. Bonne intuition fonctionnelle, mauvaise identité technique.

Ton accident Sosh vient précisément de là :

sender = maman

a contaminé :

sujet financier = maman.

Il faut représenter séparément qui envoie, qui émet le document, qui est concerné, qui doit agir.

2. Le contrat que je figerais

Je partirais sur cette structure.

TypeScript
interface MailSemanticVerdict {
  schemaVersion: string;
  promptVersion: string;

  analysis: AnalysisInfo;

  communication: Communication;

  attention: AttentionWindow;

  entities: EntityMention[];
  relations: Relation[];

  actions: ActionItem[];
  events: EventItem[];
  documents: DocumentItem[];

  contextHints: ContextHint[];

  facts: SemanticFact[];

  uncertainties: Uncertainty[];
}

Le cœur est volontairement constitué de petites collections sémantiques indépendantes. Un mail peut contenir zéro, une ou plusieurs actions, événements, documents ou faits.

C'est beaucoup plus durable qu'un unique intent.

Les champs
Champ	Type	Fermé/libre	Obligatoire	Sert à
schemaVersion	string	contrôlé	oui	migrations
promptVersion	string	contrôlé	oui	savoir avec quelles instructions le verdict a été produit
analysis.status	enum	fermé	oui	savoir si le verdict est exploitable
analysis.inputCoverage	objet	fermé	oui	savoir ce que Claude a réellement vu
communication.purpose	enum	fermé	oui	nature communicative générale
communication.subtype	string/null	libre	non	précision sans modifier l'enum
communication.summary	string	libre	oui	affichage/recherche humaine
attention.mode	enum	fermé	oui	déterminer si le mail mérite encore l'attention
attention.until	date/null	normalisé	non	péremption
entities[]	objets	hybride	oui, tableau vide accepté	recherche, regroupement, connecteurs
relations[]	objets	hybride	oui	différencier expéditeur, émetteur, bénéficiaire, bien concerné…
actions[]	objets	hybride	oui	réponses, paiements, relances, tâches
events[]	objets	hybride	oui	calendrier, voyages, RDV, indisponibilités
documents[]	objets	hybride	oui	comptabilité, PMS, archivage documentaire
contextHints[]	objets	libre + type fermé	oui	dossiers/projets/affaires
facts[]	objets génériques	extensible	oui	échappatoire pour besoins futurs
uncertainties[]	objets	fermé + texte	oui	réanalyse ciblée

L'intérêt de facts[] est important : c'est ton soupape d'extension. Un jour tu découvriras qu'il faut mémoriser « assurance résiliée », « abonnement passe à 49 € », « colis remis au voisin », etc. Tu ne rajoutes pas immédiatement trois colonnes au schéma.

3. communication : remplace intent

Je limiterais la liste fermée à des fonctions très stables :

TypeScript
type MessagePurpose =
  | "request"
  | "response"
  | "notification"
  | "confirmation"
  | "transaction_record"
  | "document_delivery"
  | "security"
  | "marketing"
  | "conversation"
  | "other"
  | "unknown";

interface Communication {
  purpose: MessagePurpose;
  subtype: string | null;
  summary: string;
}

Par exemple :

JSON
{
  "purpose": "notification",
  "subtype": "temporary_service_outage",
  "summary": "PayFiP sera indisponible le 12 mai entre 10h30 et 17h30."
}

temporary_service_outage n'a aucun besoin d'entrer dans l'enum.

C'est exactement la frontière que tu cherchais :

fermé pour ce qui déclenche du code ; libre pour ce qui enrichit le sens.

Un subtype nouveau peut apparaître demain sans migration et sans réanalyse de 25 000 mails.

4. L'unité essentielle : actions[]

C'est probablement le plus important de tout le schéma.

TypeScript
interface ActionItem {
  id: string;

  type:
    | "reply"
    | "pay"
    | "submit"
    | "sign"
    | "review"
    | "book"
    | "attend"
    | "call"
    | "send"
    | "renew"
    | "cancel"
    | "collect"
    | "check_in"
    | "other";

  subtype: string | null;
  description: string;

  actor:
    | "user"
    | "sender"
    | "third_party"
    | "unknown";

  strength:
    | "required"
    | "requested"
    | "recommended"
    | "optional";

  stateAtMessage:
    | "pending"
    | "already_completed"
    | "cancelled"
    | "unknown";

  availableFrom: TemporalValue | null;
  dueAt: TemporalValue | null;
  expiresAt: TemporalValue | null;

  evidence: Evidence[];
  certainty: Certainty;
}

La distinction absolument fondamentale est :

dueAt ≠ expiresAt

Un paiement peut être dû le 15 juin et rester à faire le 16.

Un check-in peut être disponible le 15 juin mais expirer le 16 lorsque l'avion part.

C'est cela qui aurait empêché ton Air France d'apparaître deux mois plus tard.

Et surtout :

actions[] = []

est parfaitement valide.

Le mail PayFiP contenant le mot « paiement » et une date ne possède tout simplement aucune action.

5. Le temps : ne demande jamais simplement date

Je modéliserais les dates ainsi :

TypeScript
interface TemporalValue {
  raw: string;

  normalized: string | null; // ISO 8601 si possible

  precision:
    | "datetime"
    | "date"
    | "month"
    | "year"
    | "range"
    | "unknown";

  explicitness:
    | "explicit"
    | "inferred";

  evidence: Evidence[];
  certainty: Certainty;
}

Puis le rôle de la date est porté par l'objet qui la contient.

Par exemple :

action.dueAt
action.expiresAt

event.startsAt
event.endsAt

document.issueDate
document.dueDate

fact.validFrom
fact.validUntil

C'est infiniment meilleur que :

JSON
"dates": ["2026-05-12"]

car ce dernier format oblige ensuite le serveur à réinterpréter la sémantique.

Et la péremption du mail

Je rajouterais un concept spécifique :

TypeScript
interface AttentionWindow {
  mode:
    | "persistent"
    | "until_time"
    | "while_action_open"
    | "while_event_future"
    | "until_superseded"
    | "none"
    | "unknown";

  until: TemporalValue | null;

  basis:
    | "action_window"
    | "event_window"
    | "information_window"
    | "security_code"
    | "promotion"
    | "other"
    | null;

  evidence: Evidence[];
  certainty: Certainty;
}

Attention au nom : ce n'est pas une durée de conservation.

Une facture de 2019 peut être :

attention = none

tout en restant extrêmement importante comme archive.

Le serveur calcule ensuite gratuitement :

TypeScript
isStaleForAttention(verdict, now)

à n'importe quelle date.

Claude n'a pas à réanalyser le mail en août pour comprendre que le 12 mai est passé.

6. Les événements
TypeScript
interface EventItem {
  id: string;

  type:
    | "appointment"
    | "travel"
    | "delivery"
    | "service_window"
    | "meeting"
    | "reservation"
    | "deadline"
    | "renewal"
    | "other";

  subtype: string | null;
  description: string;

  startsAt: TemporalValue | null;
  endsAt: TemporalValue | null;

  participation:
    | "user_expected"
    | "user_optional"
    | "informational"
    | "unknown";

  entityRefs: string[];

  evidence: Evidence[];
  certainty: Certainty;
}

Ton PayFiP devient donc :

event = service_window
participation = informational

et non :

action = pay

Cette distinction doit être faite par l'IA parce qu'elle dépend du sens de la phrase.

7. Les documents : oui, demande-les explicitement

Oui, absolument.

Sinon ton connecteur comptable va continuer à reconstruire des documents à partir de mots-clés.

TypeScript
interface DocumentItem {
  id: string;

  type:
    | "invoice"
    | "credit_note"
    | "receipt"
    | "quote"
    | "statement"
    | "contract"
    | "tax_notice"
    | "insurance_document"
    | "reservation_document"
    | "ticket"
    | "identity_document"
    | "other"
    | "unknown";

  subtype: string | null;

  title: string | null;

  issuerEntityRef: string | null;
  recipientEntityRef: string | null;

  reference: ExtractedIdentifier | null;

  issueDate: TemporalValue | null;
  dueDate: TemporalValue | null;

  totalAmount: Money | null;

  attachmentName: string | null;

  evidence: Evidence[];
  certainty: Certainty;
}

Montant :

TypeScript
interface Money {
  value: string;       // "129.90"
  currency: string;    // "EUR"
  raw: string;         // "129,90 €"
}

Numéro :

TypeScript
interface ExtractedIdentifier {
  kind:
    | "invoice_number"
    | "order_number"
    | "reservation_code"
    | "contract_number"
    | "customer_number"
    | "case_number"
    | "tracking_number"
    | "other";

  raw: string;

  evidence: Evidence[];
}
Règle anti-hallucination

Aucun :

montant ;

numéro ;

adresse ;

identifiant ;

date explicite

ne doit être accepté sans preuve textuelle.

8. Les preuves sont obligatoires

C'est l'autre grosse chose absente de ton contrat actuel.

TypeScript
interface Evidence {
  source:
    | "subject"
    | "body"
    | "attachment_name"
    | "attachment_text"
    | "thread_context";

  quote: string;
}

Exemple :

JSON
{
  "normalized": "2026-06-16",
  "raw": "16/06",
  "evidence": [
    {
      "source": "subject",
      "quote": "Enregistrez-vous pour votre voyage du 16/06"
    }
  ]
}

Une IA peut normaliser :

16/06 → 2026-06-16

si l'année se déduit raisonnablement de la date du mail.

Mais elle doit déclarer :

JSON
"explicitness": "inferred"

Le principe devient :

extraire ce qui est vu ; inférer seulement ce qui est nécessaire ; toujours distinguer les deux.

9. Les entités : oui, mais Claude ne doit PAS les canoniser

C'est probablement l'erreur que tu allais faire avec dossier.

Je demanderais :

TypeScript
interface EntityMention {
  id: string;

  type:
    | "person"
    | "organization"
    | "property"
    | "vehicle"
    | "place"
    | "account"
    | "contract"
    | "case"
    | "trip"
    | "reservation"
    | "order"
    | "service"
    | "other"
    | "unknown";

  nameRaw: string;

  identifiers: ExtractedIdentifier[];

  evidence: Evidence[];
  certainty: Certainty;
}

Puis des relations :

TypeScript
interface Relation {
  sourceRef: string;
  targetRef: string;

  type:
    | "sent_by"
    | "issued_by"
    | "addressed_to"
    | "concerns"
    | "billed_to"
    | "provided_by"
    | "related_to"
    | "other";

  subtype: string | null;

  evidence: Evidence[];
  certainty: Certainty;
}

Et surtout :

ne demande jamais à Claude de produire ton canonicalEntityId.

Il écrira un jour :

46 rue de la République

puis :

Immeuble République

puis :

46 Rue République Brest

Ce n'est pas un bug du modèle. C'est le mauvais outil pour assurer l'identité.

Le serveur doit avoir :

entities
entity_aliases
entity_identifiers

Par exemple :

ENTITY #property-17
canonical_name = "46 rue de la République, Brest"

aliases:
- "46 rue de la République"
- "République"
- "immeuble République"

L'IA fournit les mentions et indices d'identité.

Le résolveur local fournit l'identité persistante.

10. Et donc ton dossier

Je ne le supprimerais pas fonctionnellement.

Je supprimerais le dossier comme chaîne servant de clé.

L'IA peut produire :

TypeScript
interface ContextHint {
  type:
    | "property"
    | "company"
    | "legal_case"
    | "trip"
    | "project"
    | "contract"
    | "person"
    | "vehicle"
    | "other";

  label: string;

  anchorEntityRefs: string[];

  evidence: Evidence[];

  certainty: Certainty;
}

Exemple :

JSON
{
  "type": "property",
  "label": "46 rue de la République",
  "anchorEntityRefs": ["e3"],
  "certainty": "explicit"
}

Puis ton serveur le résout vers :

context_id = ctx_property_17

Le regroupement utilise l'ID, jamais la chaîne IA.

11. Le champ générique qui t'évitera la prochaine migration

Je mettrais également :

TypeScript
interface SemanticFact {
  predicate: string;
  subjectEntityRef: string | null;

  value:
    | string
    | number
    | boolean
    | null;

  validFrom: TemporalValue | null;
  validUntil: TemporalValue | null;

  evidence: Evidence[];
  certainty: Certainty;
}

Exemples :

JSON
{
  "predicate": "service_availability",
  "value": "unavailable"
}

ou demain :

JSON
{
  "predicate": "subscription_new_monthly_price",
  "value": 49
}

ou :

JSON
{
  "predicate": "shipment_status",
  "value": "delivered_to_neighbor"
}

Attention : le serveur ne doit pas commencer à faire des règles critiques sur n'importe quel predicate libre.

C'est d'abord utile pour :

recherche ;

regroupement ;

affichage ;

futures migrations.

Quand un fait devient structurellement important, tu peux ensuite le promouvoir dans le contrat typé.

Et tu peux le faire sans perdre l'ancien contenu.

12. Le doute : surtout pas une confiance globale

Ton :

confidence = low
→ protéger tout le mail

est trop brutal.

Imagine :

document.type = invoice       → certain
issuer = Sosh                 → certain
amount = 42,90 €              → certain
recipient = Anthony           → incertain
payment required = ???        → inconnu

Pourquoi interdire le classement documentaire parce que le bénéficiaire est incertain ?

Je prendrais :

TypeScript
type Certainty =
  | "explicit"
  | "strong_inference"
  | "weak_inference"
  | "unknown";

Par affirmation.

Et :

TypeScript
interface Uncertainty {
  fieldPath: string;

  reason:
    | "not_present"
    | "ambiguous"
    | "truncated_input"
    | "missing_attachment"
    | "missing_thread_context"
    | "conflicting_evidence"
    | "other";

  description: string;

  resolvableWith:
    | "full_body"
    | "attachment_text"
    | "thread_context"
    | "manual_review"
    | "unknown";
}

Voilà un « je ne sais pas » exploitable.

Exemple :

JSON
{
  "fieldPath": "actions",
  "reason": "missing_attachment",
  "description": "Impossible de déterminer si la facture jointe est déjà payée.",
  "resolvableWith": "attachment_text"
}

Ça te permet même de faire de la réanalyse sélective.

13. Les 500 caractères : non, ce n'est pas suffisant

Pas pour le contrat que tu veux obtenir.

Ça suffit souvent pour :

newsletter ;

OTP ;

confirmation simple ;

notification triviale.

Ça ne suffit pas fiablement pour :

document transféré ;

demande cachée en fin de mail ;

réponse dans une conversation ;

échéance avec conditions ;

facture ;

contrat ;

mail contenant plusieurs sujets.

Mais je ne passerais surtout pas de 500 caractères à « corps intégral partout ».

Je ferais un budget d'entrée adaptatif.

Pour chaque message, en première passe :

From
To / Cc
date
subject
mailbox
direction
attachment filenames + MIME types
~1 500 à 2 500 caractères de contenu utile
metadata de thread

Le gain principal immédiat est probablement de passer de 500 caractères naïfs à 1 500–2 500 caractères sélectionnés intelligemment.

Pas obligatoirement les 2 000 premiers caractères.

Ton préprocesseur local peut gratuitement retirer :

signatures ;

disclaimers ;

historique cité ;

gros blocs HTML ;

navigation.

Et conserver :

début du message ;

paragraphes avec chiffres/dates ;

fin sémantique du message.

Ce prétraitement est exactement le genre de déterminisme qui est sain.

14. Deux informations que tu n'envoies pas aujourd'hui et qui sont très rentables
Les destinataires

To / Cc / identité de la boîte concernée.

Claude doit pouvoir distinguer :

Anthony est destinataire direct

de :

Anthony est en copie

ou :

mail envoyé par Anthony

Ça change énormément l'interprétation de reply_expected.

Les noms des pièces jointes

Toujours.

FACTURE_SOSH_052026.pdf
Contrat_RESILIATION.pdf
Billet_AF123.pdf

coûte presque rien et donne énormément de signal.

15. Le fil : oui, mais pas intégral

Je n'enverrais pas dix messages précédents.

J'enverrais des métadonnées :

threadMessageCount: 7
lastMessageDirection: incoming
userHasRepliedAfterThisMessage: false

et, lorsque nécessaire :

previousMessageExcerpt: ~300-500 caractères

Particulièrement pour :

réponse attendue ;

relance ;

accord/refus ;

« merci, c'est fait » ;

mail qui clôt une demande précédente.

Le serveur sait déjà mécaniquement beaucoup de choses sur le fil. Ne dépense pas Claude pour les découvrir.

16. Je mettrais une vraie seconde passe

C'est une conséquence importante de ta contrainte Claude.

Ne traite pas les 25 000 mails avec la même quantité de contexte.

Passe A

Analyse compacte de tous les mails.

Passe B uniquement lorsque le verdict dit
truncated_input
missing_attachment
missing_thread_context

et que le mail est candidat à quelque chose de sensible :

paiement ;

échéance ;

réponse ;

document comptable ;

briefing ;

suppression risquée.

Tu relis alors 2 % ou 5 % des mails avec davantage de contenu.

C'est beaucoup plus économique qu'envoyer 5 000 caractères sur 25 000 mails.

17. Exemple 1 — Air France

Mail :

Enregistrez-vous pour votre voyage du 16/06

Je voudrais quelque chose proche de :

JSON
{
  "schemaVersion": "3.0",
  "promptVersion": "semantic-2026-08",

  "analysis": {
    "status": "complete"
  },

  "communication": {
    "purpose": "request",
    "subtype": "flight_check_in_reminder",
    "summary": "Air France invite à effectuer l'enregistrement pour le voyage du 16 juin."
  },

  "attention": {
    "mode": "until_time",
    "until": {
      "raw": "16/06",
      "normalized": "2026-06-16",
      "precision": "date",
      "explicitness": "inferred",
      "certainty": "strong_inference",
      "evidence": [
        {
          "source": "subject",
          "quote": "votre voyage du 16/06"
        }
      ]
    },
    "basis": "action_window",
    "certainty": "strong_inference"
  },

  "entities": [
    {
      "id": "e1",
      "type": "organization",
      "nameRaw": "Air France",
      "identifiers": [],
      "certainty": "explicit",
      "evidence": [
        {
          "source": "sender",
          "quote": "Air France"
        }
      ]
    }
  ],

  "relations": [],

  "actions": [
    {
      "id": "a1",
      "type": "check_in",
      "subtype": "flight",
      "description": "Effectuer l'enregistrement du voyage",
      "actor": "user",
      "strength": "requested",
      "stateAtMessage": "pending",
      "availableFrom": null,
      "dueAt": null,
      "expiresAt": {
        "raw": "16/06",
        "normalized": "2026-06-16",
        "precision": "date",
        "explicitness": "inferred",
        "certainty": "strong_inference",
        "evidence": [
          {
            "source": "subject",
            "quote": "votre voyage du 16/06"
          }
        ]
      },
      "certainty": "strong_inference"
    }
  ],

  "events": [
    {
      "id": "ev1",
      "type": "travel",
      "subtype": "flight",
      "description": "Voyage Air France",
      "startsAt": {
        "raw": "16/06",
        "normalized": "2026-06-16",
        "precision": "date",
        "explicitness": "inferred",
        "certainty": "strong_inference",
        "evidence": [
          {
            "source": "subject",
            "quote": "voyage du 16/06"
          }
        ]
      },
      "endsAt": null,
      "participation": "user_expected",
      "entityRefs": ["e1"],
      "certainty": "strong_inference"
    }
  ],

  "documents": [],
  "contextHints": [],
  "facts": [],
  "uncertainties": []
}

Le 11 août, aucune IA n'est rappelée.

Le serveur constate simplement :

attention.until < now
action.expiresAt < now

Donc :

ne pas mettre dans le briefing
ne pas proposer comme tâche
conserver dans recherche/historique
18. Exemple 2 — PayFiP indisponible le 12 mai

C'est précisément le cas qui montre pourquoi ton ancien intent était mauvais.

JSON
{
  "communication": {
    "purpose": "notification",
    "subtype": "temporary_service_unavailability",
    "summary": "Les paiements PayFiP seront temporairement indisponibles le 12 mai."
  },

  "attention": {
    "mode": "until_time",
    "until": {
      "raw": "12 mai 2026 à 17h30",
      "normalized": "2026-05-12T17:30:00",
      "precision": "datetime",
      "explicitness": "explicit",
      "certainty": "explicit",
      "evidence": [
        {
          "source": "body",
          "quote": "indisponibles le mardi 12 mai de 10h30 à 17h30"
        }
      ]
    },
    "basis": "information_window",
    "certainty": "explicit"
  },

  "actions": [],

  "events": [
    {
      "id": "ev1",
      "type": "service_window",
      "subtype": "service_unavailability",
      "description": "Indisponibilité temporaire de PayFiP",
      "startsAt": {
        "raw": "12 mai de 10h30",
        "normalized": "2026-05-12T10:30:00",
        "precision": "datetime",
        "explicitness": "explicit",
        "certainty": "explicit",
        "evidence": [
          {
            "source": "body",
            "quote": "le mardi 12 mai de 10h30 à 17h30"
          }
        ]
      },
      "endsAt": {
        "raw": "17h30",
        "normalized": "2026-05-12T17:30:00",
        "precision": "datetime",
        "explicitness": "explicit",
        "certainty": "explicit",
        "evidence": [
          {
            "source": "body",
            "quote": "de 10h30 à 17h30"
          }
        ]
      },
      "participation": "informational",
      "entityRefs": [],
      "certainty": "explicit"
    }
  ],

  "documents": [],
  "contextHints": [],

  "facts": [
    {
      "predicate": "service_availability",
      "subjectEntityRef": null,
      "value": "unavailable",
      "validFrom": {
        "normalized": "2026-05-12T10:30:00"
      },
      "validUntil": {
        "normalized": "2026-05-12T17:30:00"
      },
      "certainty": "explicit"
    }
  ],

  "uncertainties": []
}

Le mot paiement n'a absolument aucune importance décisionnelle.

Il ne déclenche rien.

La sémantique dit :

0 action
1 événement informatif
information valable jusqu'à 17h30

Fin du problème.

19. Exemple 3 — maman transmet une facture Sosh

Supposons que le seul fait certain soit qu'elle transmet une facture Sosh.

JSON
{
  "communication": {
    "purpose": "document_delivery",
    "subtype": "forwarded_invoice",
    "summary": "La mère de l'utilisateur transmet une facture émise par Sosh."
  },

  "attention": {
    "mode": "unknown",
    "until": null,
    "basis": null,
    "certainty": "unknown"
  },

  "entities": [
    {
      "id": "e1",
      "type": "person",
      "nameRaw": "Maman",
      "identifiers": [],
      "certainty": "explicit",
      "evidence": [
        {
          "source": "sender",
          "quote": "..."
        }
      ]
    },
    {
      "id": "e2",
      "type": "organization",
      "nameRaw": "Sosh",
      "identifiers": [],
      "certainty": "explicit",
      "evidence": [
        {
          "source": "attachment_text",
          "quote": "Sosh"
        }
      ]
    }
  ],

  "relations": [
    {
      "sourceRef": "e1",
      "targetRef": "e2",
      "type": "related_to",
      "subtype": "forwards_document_from",
      "certainty": "strong_inference"
    }
  ],

  "actions": [],

  "events": [],

  "documents": [
    {
      "id": "d1",
      "type": "invoice",
      "subtype": "telecom",
      "title": "Facture Sosh",
      "issuerEntityRef": "e2",
      "recipientEntityRef": null,
      "reference": null,
      "issueDate": null,
      "dueDate": null,
      "totalAmount": null,
      "attachmentName": "facture.pdf",
      "certainty": "explicit",
      "evidence": [
        {
          "source": "attachment_text",
          "quote": "Sosh ... Facture"
        }
      ]
    }
  ],

  "contextHints": [],

  "facts": [],

  "uncertainties": [
    {
      "fieldPath": "documents[0].recipientEntityRef",
      "reason": "not_present",
      "description": "Le destinataire de la facture n'est pas établi dans le contenu disponible.",
      "resolvableWith": "attachment_text"
    },
    {
      "fieldPath": "actions",
      "reason": "ambiguous",
      "description": "Aucune demande explicite de paiement par l'utilisateur n'est visible.",
      "resolvableWith": "full_body"
    }
  ]
}

Donc surtout pas :

sender=maman
→ facture de maman
→ payer maman

L'IA a suffisamment de compréhension pour refuser ce raccourci.

20. Ce qui DOIT rester déterministe

Voilà la séparation que je figerais architecturalement.

Serveur déterministe	IA
Date de réception	signification d'une date
Âge du mail	savoir si une action expire avec un événement
From/To/Cc	identifier qui est réellement acteur/bénéficiaire
Thread IDs	comprendre si le message clôt une demande
Mail entrant/sortant	nature de la réponse
MIME / pièces jointes	nature sémantique du document
Hash / doublons	savoir de quoi parle le document
Parsing ISO des dates après extraction	associer date ↔ événement/action
now > expiresAt	déterminer la fenêtre sémantique pertinente
Calcul « périmé aujourd'hui »	dire qu'une information cesse d'être utile après cet événement
Résolution d'entités	proposer les mentions / relations
Canonicalisation des dossiers	reconnaître le sujet de vie
Compteurs par expéditeur	classer la fonction du message
Fréquence / ancienneté	détecter demande/action/document
Index recherche	faire le résumé sémantique
Priorisation selon données extraites	extraire les obligations
Règles de sécurité	comprendre les ambiguïtés
Routage connecteurs à partir des faits	identifier facture/réservation/etc.
Décision de nettoyage	jamais l'action physique elle-même

La règle générale :

Si deux programmeurs raisonnables peuvent obtenir la réponse avec les mêmes données sans comprendre une phrase, serveur.

S'il faut comprendre ce que veut dire une phrase dans son contexte, IA.

C'est la frontière.

21. Comment ne pas réanalyser 25 000 mails quand le schéma évolue

Trois versions distinctes :

schemaVersion
promptVersion
inputVersion

Je stockerais également :

TypeScript
analysisCapabilities: string[]

Exemple ancien :

JSON
[
  "communication",
  "summary",
  "actions-v1"
]

Nouveau :

JSON
[
  "communication",
  "attention-window-v1",
  "entities-v1",
  "actions-v2",
  "events-v1",
  "documents-v1"
]

Ainsi un verdict n'est jamais simplement « ancien ».

Tu sais ce qui manque.

Et surtout chaque évolution reçoit une stratégie :

A. Champ dérivable des données déjà extraites

Zéro réanalyse.

Exemple :

isExpired

est calculé à partir de expiresAt.

B. Nouveau vocabulaire libre

Zéro réanalyse obligatoire.

subtype = service_outage apparaîtra seulement sur les nouveaux mails.

Pas grave.

C. Nouvelle information nécessitant une compréhension

Marque :

missingCapability = "attention-window-v1"

et ne réanalyse que les candidats pertinents.

Par exemple pour ajouter attention-window-v1 :

mails non archivés
OU < 1 an
OU possèdent une action
OU événement/date détecté
OU apparaissent dans briefing/recherche récente

Puis le reste en lazy migration quand l'utilisateur ouvre/recherche le mail.

D. Nouvelle fonction sur l'historique

Tu sélectionnes les candidats par les anciennes données et les métadonnées déterministes, puis tu réanalyses uniquement ceux-là.

Tu ne dois quasiment jamais avoir une raison valable de rejouer 25 000 mails.

22. Priorisation des réanalyses

Je ferais quelque chose comme :

P0
mail actif susceptible de provoquer paiement/réponse/échéance

P1
mail récent et non archivé

P2
documents comptables / contrats / réservations

P3
mails retrouvés ou ouverts par l'utilisateur

P4
historique dormant

P5
newsletters/promotions périmées

P4/P5 peuvent rester éternellement sur l'ancien schéma tant qu'aucune fonctionnalité ne les réclame.

23. Ce que je ne demanderais surtout PAS à l'IA

Je retirerais explicitement du prompt :

« importance de 1 à 10 » ;

score numérique de confiance ;

catégorie définitive de dossier ;

ID canonique ;

recommandation d'archivage ;

recommandation de suppression ;

priorité quotidienne absolue ;

« faut-il envoyer au logiciel X ? » ;

interprétation comptable définitive ;

interprétation juridique ;

conséquence fiscale ;

résumé long ;

justification narrative de chaque décision ;

recherche exhaustive de toutes les personnes ou organisations citées dans le mail.

Ces choses sont soit :

dérivables, trop dépendantes du produit, trop coûteuses, ou trop dangereuses sur 500 caractères.

Pour les entités notamment, indique :

extraire seulement les entités participant au sens opérationnel du message.

Pas le président de la société mentionné dans le footer, l'adresse légale dans les CGV et quatre marques du disclaimer.

24. La conséquence sur tes fonctionnalités actuelles

Avec cette seule représentation :

Brief quotidien
→ actions ouvertes + événements futurs + attention active + scoring local.

Réponses attendues
→ actions reply, état du thread, direction.

Relances
→ action demandée à un tiers + aucune réponse ultérieure.

Calendrier
→ events[] + actions[].dueAt.

Nettoyage
→ aucune action ouverte + aucune attention active + âge + fonction du message + protections.

Recherche sans dossiers
→ résumé + entités + contextes + documents + faits.

Factures vers comptabilité
→ documents[type=invoice], issuer, recipient, amount, référence.

Gestion locative
→ réservation/propriété dans entités/contextes + documents/events.

Dossiers
→ résolution locale de contextHints + entities.

Tu n'as plus sept modèles mentaux différents.

25. Le point architectural que je considérerais non négociable

Je stockerais le verdict IA original comme JSON immuable, puis des projections locales.

Par exemple :

mail_ai_verdict
mail_actions
mail_events
mail_documents
entity_mentions
entity_links
mail_context_links

Pourquoi ?

Parce que dans six mois tu voudras changer :

comment le briefing fonctionne

sans changer :

ce que Claude avait compris du mail.

Si ton verdict IA dit simplement :

JSON
"action": "read"

tu as perdu l'information.

Si ton verdict dit :

information temporaire
du 12/05 10:30 au 12/05 17:30
aucune action demandée

tu peux inventer dix assistants différents au-dessus.

Ma recommandation finale

Ton ancien modèle était essentiellement :

mail
→ IA
→ décision produit

Il faut passer à :

                       ┌→ briefing
                       ├→ tâches
mail → IA → sémantique ├→ calendrier
                       ├→ recherche
                       ├→ comptabilité
                       ├→ PMS
                       └→ nettoyage

Avec entre la sémantique et les usages :

résolution d'identités
normalisation
calcul temporel
règles de sécurité
projections

Le champ le plus important que tu avais oublié n'est pas un nouveau intent. C'est la combinaison action/event/document + rôle temporel + preuve + incertitude par assertion.

Et la correction la plus importante à faire maintenant est de supprimer action, confidence, reason et le dossier libre comme vérités métier, plutôt que de simplement leur ajouter dix cousins.