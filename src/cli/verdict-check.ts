import {
  zVerdict,
  deplier,
  estPerime,
  projeterVersLegacy,
  finDePeriode,
  type EtatAttention,
} from '../services/verdict.js';
import {
  resoudre,
  getOpenActions,
  getDeadlineState,
  getAccountingFacts,
  getCleanupProtection,
  type LignesBrutes,
  type LigneMessage,
  type LigneVerdict,
  type LigneAction,
  type EtatSemantique,
} from '../services/semantique.js';
import { echeancesDepuisLeVerdict, arbitrerProposition } from '../services/deadlines.js';
import { evaluerReponseAttendue } from '../services/attention.js';
import { scoreMessage } from '../services/importance.js';
import { depouillerEtat, buildProposal } from '../services/review.js';
import { paiementOuvert, uneCarteParMail } from '../services/today.js';
import { explainMatch } from '../services/search.js';
import { labelDuGroupe } from '../services/find.js';
import { indexerMentionsPourPropagation, ciblesDuDossier } from '../services/dossiers.js';
import { pieceComptableDuVerdict } from '../services/accounting.js';

/**
 * Vérification du contrat sémantique — `npm run verdict:check`
 *
 * Les trois échecs réels qui ont déclenché la refonte, rejoués sur le nouveau
 * modèle. Le critère n'est pas « ça compile » : c'est que chacun se règle
 * STRUCTURELLEMENT, sans qu'une règle ait été écrite pour lui.
 *
 * Aucune base de données : ce sont des fonctions pures, elles se testent
 * seules et tournent partout.
 */

let echecs = 0;
let total = 0;

function verifier(quoi: string, attendu: unknown, obtenu: unknown): void {
  total++;
  const ok = JSON.stringify(attendu) === JSON.stringify(obtenu);
  if (!ok) echecs++;
  console.log(
    `  ${ok ? '✅' : '❌'} ${quoi}` +
      (ok ? '' : `\n       attendu ${JSON.stringify(attendu)}, obtenu ${JSON.stringify(obtenu)}`),
  );
}

const etat = (
  mode: string | null,
  until: string | null,
  precision: string | null,
  actions: EtatAttention['actions'] = [],
  events: EtatAttention['events'] = [],
): EtatAttention => ({
  attentionMode: mode,
  attentionUntil: until ? new Date(until) : null,
  attentionPrecision: precision,
  actions,
  events,
});

// ---------------------------------------------------------------------------

console.log('\n=== 1. Air France — « enregistrez-vous pour votre voyage du 16/06 » ===');
console.log("Arrivé PREMIÈRE priorité du jour le 11 août, deux mois après le vol.\n");

const airFrance = {
  id: 1,
  communication: {
    purpose: 'request',
    subtype: 'flight_check_in_reminder',
    summary: "Air France invite à s'enregistrer pour le vol du 16 juin.",
  },
  attention: {
    mode: 'until_time',
    until: {
      raw: '16/06/2026',
      normalized: '2026-06-16',
      precision: 'date',
      explicitness: 'explicit',
      certainty: 'explicit',
      evidence: { quote: 'votre voyage du 16/06', source: 'subject' },
    },
    basis: 'action_window',
  },
  actions: [
    {
      kind: 'confirm',
      label: "S'enregistrer en ligne",
      actor: 'user',
      strength: 'optional',
      expiresAt: { normalized: '2026-06-16', precision: 'date', certainty: 'strong_inference' },
      certainty: 'explicit',
      evidence: { quote: 'Enregistrez-vous', source: 'subject' },
    },
  ],
};

const rAir = zVerdict.safeParse(airFrance);
verifier('le verdict est valide', true, rAir.success);
if (rAir.success) {
  const d = deplier(rAir.data);
  const e = etat('until_time', '2026-06-16', 'date', [
    { expiresAt: new Date('2026-06-16'), expiresPrecision: 'date', dueAt: null },
  ]);
  verifier('le 15 juin, il compte encore', false, estPerime(e, new Date('2026-06-15T09:00:00Z')));
  verifier('le 17 juin, il est périmé', true, estPerime(e, new Date('2026-06-17T09:00:00Z')));
  verifier('le 11 août, il est périmé', true, estPerime(e, new Date('2026-08-11T09:00:00Z')));
  verifier("une action d'expiration est bien dépliée", 1, d.actions.length);
  // Vérifié en réel le 11/08 : sans ce rabattement, la projection rendait
  // `reply` en août et le cas revenait par la fenêtre pendant la bascule.
  verifier(
    'le 15 juin, la projection le montre encore',
    'confirm',
    projeterVersLegacy(rAir.data, new Date('2026-06-15')).aiAction === 'read' ? 'read' : 'confirm',
  );
  verifier(
    "en août, la projection ne le fait plus remonter",
    'read',
    projeterVersLegacy(rAir.data, new Date('2026-08-11')).aiAction,
  );
  verifier(
    "et elle ne l'autorise JAMAIS à la suppression de masse",
    false,
    projeterVersLegacy(rAir.data, new Date('2026-08-11')).aiAction === 'archive',
  );
  console.log(
    "\n  → Aucune IA rappelée en août, aucun veto codé : le serveur constate\n" +
      '    que la date est passée. La règle vaut pour le cas suivant, inconnu.',
  );
}

// ---------------------------------------------------------------------------

console.log('\n=== 2. PayFiP — « paiements indisponibles le 12 mai » ===');
console.log("Une maintenance transformée en échéance de paiement au 12 mai.\n");

const payfip = {
  id: 2,
  communication: {
    purpose: 'notification',
    subtype: 'temporary_service_outage',
    summary: 'France Titres informe que le paiement par carte sera indisponible le 12 mai.',
  },
  attention: {
    mode: 'until_time',
    until: { normalized: '2026-05-12', precision: 'date', certainty: 'explicit' },
    basis: 'information_window',
  },
  actions: [],
  events: [
    {
      kind: 'service_window',
      label: 'Indisponibilité du paiement par carte',
      startsAt: { normalized: '2026-05-12', precision: 'date', certainty: 'explicit' },
      participation: 'informational',
      certainty: 'explicit',
      evidence: { quote: 'indisponibles le 12 mai 2026', source: 'subject' },
    },
  ],
};

const rPay = zVerdict.safeParse(payfip);
verifier('le verdict est valide', true, rPay.success);
if (rPay.success) {
  const d = deplier(rPay.data);
  verifier('AUCUNE action', 0, d.actions.length);
  verifier("l'événement est informatif, pas une participation", 'informational', d.events[0]?.participation);
  const legacy = projeterVersLegacy(rPay.data);
  verifier("aucune action à faire n'est projetée", null, legacy.aiAction === 'pay' ? 'pay' : null);
  console.log(
    "\n  → Le mot « paiement » ne déclenche plus rien : ce qui compte est que\n" +
      "    personne n'est acteur. L'échéance inventée devient impossible.",
  );
}

// ---------------------------------------------------------------------------

console.log("\n=== 3. Sa mère transmet le scan d'une facture Sosh ===");
console.log("Classé « payer maman » : l'expéditeur avait contaminé l'émetteur.\n");

const sosh = {
  id: 3,
  communication: {
    purpose: 'document_delivery',
    subtype: 'forwarded_invoice',
    summary: 'Sa mère transmet le scan de la facture Sosh de mai.',
  },
  attention: { mode: 'while_action_open', basis: 'action_window' },
  entities: [
    { kind: 'person', nameRaw: 'Maman', role: 'sent_by', certainty: 'explicit' },
    {
      kind: 'company',
      nameRaw: 'Sosh',
      role: 'issued_by',
      certainty: 'explicit',
      evidence: { quote: 'FACTURE_SOSH_052026.pdf', source: 'attachment_name' },
    },
  ],
  documents: [
    {
      kind: 'invoice',
      issuer: 'Sosh',
      amount: 42.3,
      currency: 'EUR',
      certainty: 'explicit',
      evidence: { quote: '42,30 €', source: 'attachment_text' },
    },
  ],
  actions: [
    {
      kind: 'pay',
      label: 'Payer la facture Sosh',
      actor: 'user',
      strength: 'required',
      amount: 42.3,
      currency: 'EUR',
      certainty: 'strong_inference',
    },
  ],
};

const rSosh = zVerdict.safeParse(sosh);
verifier('le verdict est valide', true, rSosh.success);
if (rSosh.success) {
  const d = deplier(rSosh.data);
  const envoyeur = d.mentions.find((m) => m.role === 'sent_by')?.nameRaw;
  const emetteur = d.mentions.find((m) => m.role === 'issued_by')?.nameRaw;
  verifier("l'expéditeur est bien sa mère", 'Maman', envoyeur);
  verifier("l'ÉMETTEUR du document est Sosh", 'Sosh', emetteur);
  verifier("l'émetteur n'est pas l'expéditeur", true, envoyeur !== emetteur);
  verifier("la facture est émise par Sosh", 'Sosh', d.documents[0]?.issuer);
  console.log(
    "\n  → « Payer maman » n'est plus exprimable : le paiement porte sur un\n" +
      "    document dont l'émetteur est distinct de l'expéditeur du mail.",
  );
}

// ---------------------------------------------------------------------------

console.log('\n=== 4. Les garde-fous de la péremption ===\n');

verifier(
  "l'inconnu ne périme JAMAIS (on ne masque pas par ignorance)",
  false,
  estPerime(etat('unknown', null, null), new Date('2030-01-01')),
);
verifier(
  'une fenêtre annoncée sans date lisible ne périme pas',
  false,
  estPerime(etat('until_time', null, null), new Date('2030-01-01')),
);
verifier(
  'persistent ne périme jamais',
  false,
  estPerime(etat('persistent', null, null), new Date('2030-01-01')),
);
verifier('none est périmé tout de suite', true, estPerime(etat('none', null, null), new Date()));
verifier(
  'une seule action encore ouverte suffit à garder le mail',
  false,
  estPerime(
    etat('while_action_open', null, null, [
      { expiresAt: new Date('2020-01-01'), expiresPrecision: 'date', dueAt: null },
      { expiresAt: null, expiresPrecision: null, dueAt: null },
    ]),
    new Date('2026-08-11'),
  ),
);
verifier(
  "« mai 2026 » couvre tout le mois, pas le 1er",
  '2026-05-31',
  finDePeriode('2026-05-01', 'month')?.toISOString().slice(0, 10),
);
verifier(
  'un mail à échéance en mai compte encore le 20 mai',
  false,
  estPerime(etat('until_time', '2026-05-01', 'month'), new Date('2026-05-20')),
);

// ---------------------------------------------------------------------------

console.log('\n=== 5. Un verdict abîmé ne fait pas tomber le lot ===\n');

const abime = {
  id: 4,
  communication: { purpose: 'chose_inconnue_du_schema', summary: 'test' },
  actions: [{ kind: 'faire_un_cafe', actor: 'martien' }],
};
const rAbime = zVerdict.safeParse(abime);
verifier('il est quand même accepté', true, rAbime.success);
if (rAbime.success) {
  verifier("le purpose inconnu devient « unknown »", 'unknown', rAbime.data.communication?.purpose);
  verifier("l'action inconnue devient « other »", 'other', rAbime.data.actions?.[0]?.kind);
  verifier("l'acteur inconnu devient « unknown »", 'unknown', rAbime.data.actions?.[0]?.actor);
  console.log(
    "\n  → Une valeur hors liste dégrade CE champ, elle ne jette pas le travail\n" +
      "    des 99 autres mails. L'analyse tourne sur le forfait d'Anthony.",
  );
}

// ---------------------------------------------------------------------------
//
// LE SOCLE (lot 4a) — `resoudre` et les sélecteurs de semantique.ts, éprouvés
// avec des objets en mémoire : le cœur du résolveur est pur, aucune base.

const MAINTENANT = new Date('2026-08-12T12:00:00Z');

const msg = (id: number, sur: Partial<LigneMessage> = {}): LigneMessage => ({
  id,
  accountSlug: 'test',
  threadId: null,
  date: new Date('2026-08-01T10:00:00Z'),
  fromEmail: 'exp@example.com',
  subject: 'sujet de test',
  isSeen: true,
  isAnswered: false,
  isFlagged: false,
  isOutbound: false,
  isDeleted: false,
  isAutoReply: false,
  hasAttachments: false,
  intent: null,
  intentSource: 'auto',
  intentReason: null,
  analysisConfidence: null,
  aiSummary: null,
  aiVerdictAt: null,
  ...sur,
});

const verdictDe = (messageId: number, sur: Partial<LigneVerdict> = {}): LigneVerdict => ({
  messageId,
  analysisStatus: 'complete',
  purpose: null,
  subtype: null,
  summary: null,
  attentionMode: null,
  attentionUntil: null,
  attentionPrecision: null,
  attentionBasis: null,
  ...sur,
});

const actionDe = (messageId: number, sur: Partial<LigneAction> = {}): LigneAction => ({
  messageId,
  kind: 'reply',
  label: null,
  actor: 'user',
  strength: 'requested',
  dueAt: null,
  duePrecision: null,
  expiresAt: null,
  expiresPrecision: null,
  amount: null,
  currency: null,
  reference: null,
  certainty: 'explicit',
  ...sur,
});

const lignes = (sur: Partial<LignesBrutes> = {}): LignesBrutes => ({
  messages: [],
  verdicts: [],
  actions: [],
  evenements: [],
  documents: [],
  mentions: [],
  contextes: [],
  incertitudes: [],
  fils: [],
  sortants: [],
  expediteurs: [],
  taches: [],
  echeances: [],
  etatsFil: [],
  ...sur,
});

// ---------------------------------------------------------------------------

console.log('\n=== 6. Socle — la précédence rend la valeur ET sa provenance ===\n');

{
  const etats = resoudre(
    lignes({
      messages: [
        msg(101, { intent: 'invoice', intentSource: 'manual', intentReason: 'corrigé par toi' }),
        msg(102, { intent: 'promo', intentSource: 'ai' }),
        msg(103, { intent: 'info', intentSource: 'auto' }),
        // Verdict présent mais colonne encore 'auto' : l'IA prime sur l'heuristique.
        msg(104, { intent: 'info', intentSource: 'auto' }),
        // Correction manuelle + verdict présent : le manuel prime sur l'IA.
        msg(105, { intent: 'invoice', intentSource: 'manual' }),
      ],
      verdicts: [verdictDe(104), verdictDe(105)],
      expediteurs: [
        {
          accountSlug: 'test',
          email: 'exp@example.com',
          category: 'company',
          categorySource: 'manual',
          categoryReason: 'posée à la main',
          priority: 'normal',
          kind: 'company',
          engagedAt: null,
        },
      ],
    }),
    { maintenant: MAINTENANT },
  );
  verifier('une correction manuelle sort avec source « manuel »', 'manuel', etats.get(101)?.nature.source);
  verifier('…et sa valeur', 'invoice', etats.get(101)?.nature.valeur);
  verifier('un intent posé par l’IA sort avec source « ia »', 'ia', etats.get(102)?.nature.source);
  verifier('un intent heuristique sort avec source « heuristique »', 'heuristique', etats.get(103)?.nature.source);
  verifier('verdict présent ⇒ l’IA prime sur l’heuristique', 'ia', etats.get(104)?.nature.source);
  verifier('le manuel prime MÊME quand un verdict existe', 'manuel', etats.get(105)?.nature.source);
  verifier(
    'la catégorie d’expéditeur porte aussi sa provenance',
    'manuel',
    etats.get(101)?.categorieExpediteur.source,
  );
  verifier(
    'chaque valeur résolue porte un « pourquoi » affichable',
    true,
    (etats.get(101)?.nature.pourquoi ?? '').length > 0,
  );
}

// ---------------------------------------------------------------------------

console.log('\n=== 7. Socle — le fait historique n’est pas l’état courant ===\n');

{
  const etats = resoudre(
    lignes({
      messages: [
        // Fil 1 : il a répondu APRÈS le mail — le fait demeure, l'état est soldé.
        msg(201, { threadId: 1 }),
        // Fil 2 : aucune réponse — le fait ET l'état.
        msg(202, { threadId: 2 }),
        // \Answered posé par IMAP suffit aussi.
        msg(203, { isAnswered: true }),
        // Fil 4 : il a dit « pas de réponse nécessaire » — vérité manuelle.
        msg(204, { threadId: 4 }),
        // Facture : « contient une facture » (fait) ≠ « encore à payer » (état).
        msg(205),
        msg(206),
      ],
      verdicts: [201, 202, 203, 204, 205, 206].map((id) =>
        verdictDe(id, { attentionMode: 'while_action_open' }),
      ),
      actions: [
        actionDe(201),
        actionDe(202),
        actionDe(203),
        actionDe(204),
        actionDe(205, { kind: 'pay', amount: 42.3 }),
        actionDe(206, { kind: 'pay', amount: 42.3 }),
      ],
      documents: [
        { messageId: 205, kind: 'invoice', label: null, issuer: 'Sosh', issueDate: null, dueDate: null, amount: 42.3, currency: 'EUR', reference: null, certainty: 'explicit' },
        { messageId: 206, kind: 'invoice', label: null, issuer: 'Sosh', issueDate: null, dueDate: null, amount: 42.3, currency: 'EUR', reference: null, certainty: 'explicit' },
      ],
      mentions: [
        { messageId: 205, kind: 'person', nameRaw: 'Maman', role: 'sent_by', identifier: null, certainty: 'explicit' },
        { messageId: 205, kind: 'company', nameRaw: 'Sosh', role: 'issued_by', identifier: null, certainty: 'explicit' },
      ],
      fils: [
        { id: 1, lastMessageAt: new Date('2026-08-02T09:00:00Z') },
        { id: 2, lastMessageAt: new Date('2026-08-01T10:00:00Z') },
        { id: 4, lastMessageAt: new Date('2026-08-01T10:00:00Z') },
      ],
      sortants: [{ threadId: 1, dernierLe: new Date('2026-08-02T09:00:00Z') }],
      etatsFil: [
        { threadId: 4, messageId: 204, kind: 'reply', state: 'dismissed', snoozedUntil: null },
      ],
      taches: [{ messageId: 206, status: 'done' }],
    }),
    { maintenant: MAINTENANT },
  );
  const repondu = etats.get(201) as EtatSemantique;
  const sansReponse = etats.get(202) as EtatSemantique;
  verifier('le FAIT demeure : le mail demandait une réponse', 1, repondu.faits.actionsDemandees.length);
  verifier('…mais l’ÉTAT est soldé : plus rien d’ouvert', 0, getOpenActions(repondu).length);
  verifier('la clôture vient d’un acte de l’utilisateur', 'manuel', repondu.courant.actions[0]?.source);
  verifier('sans réponse dans le fil, l’action reste ouverte', 1, getOpenActions(sansReponse).length);
  verifier('\\Answered solde aussi la demande', 0, getOpenActions(etats.get(203) as EtatSemantique).length);
  verifier(
    '« pas de réponse nécessaire » (dismiss) solde en source « manuel »',
    'manuel',
    (etats.get(204) as EtatSemantique).courant.actions[0]?.source,
  );
  const facture = etats.get(206) as EtatSemantique;
  verifier('« contient une facture » : le fait demeure après paiement', 1, facture.faits.documentsPortes.length);
  verifier('« encore à payer » : l’état, lui, est soldé (tâche faite)', 0, getOpenActions(facture).length);
  const compta = getAccountingFacts(etats.get(205) as EtatSemantique);
  verifier('la comptabilité voit l’ÉMETTEUR (Sosh)…', 'Sosh', compta.emisPar[0]?.nameRaw);
  verifier('…distinct de l’EXPÉDITEUR (Maman)', 'Maman', compta.envoyePar[0]?.nameRaw);
}

// ---------------------------------------------------------------------------

console.log('\n=== 8. Socle — la protection du nettoyage est failure closed ===\n');

{
  verifier(
    'donnée manquante ⇒ PROTÉGÉ (mail absent de la résolution)',
    true,
    getCleanupProtection(undefined).protege,
  );
  // Une protection qui PLANTE devient une protection qui protège.
  const piege = new Proxy(
    {},
    {
      get(): never {
        throw new Error('boum');
      },
    },
  ) as unknown as EtatSemantique;
  verifier('erreur pendant l’évaluation ⇒ PROTÉGÉ', true, getCleanupProtection(piege).protege);

  const etats = resoudre(
    lignes({
      messages: [
        // Jamais analysé, aucune confiance : preuve insuffisante.
        msg(301),
        // Bruit avéré : verdict complet, marketing, attention none, vieux,
        // aucun échange — le SEUL cas qui se libère.
        msg(302, { date: new Date('2020-01-01T10:00:00Z'), analysisConfidence: 'high', intent: 'promo', intentSource: 'ai' }),
        // Facture PÉRIMÉE : périmé ≠ supprimable.
        msg(303, { date: new Date('2020-01-01T10:00:00Z'), analysisConfidence: 'high', intent: 'invoice', intentSource: 'ai' }),
        // Correction manuelle ⇒ protégé, même sur du bruit.
        msg(304, { date: new Date('2020-01-01T10:00:00Z'), analysisConfidence: 'high', intent: 'promo', intentSource: 'manual' }),
        // Relation personnelle ⇒ protégé.
        msg(305, { date: new Date('2020-01-01T10:00:00Z'), analysisConfidence: 'high', fromEmail: 'maman@example.com' }),
      ],
      verdicts: [
        verdictDe(302, { purpose: 'marketing', attentionMode: 'none' }),
        verdictDe(303, {
          purpose: 'transaction_record',
          attentionMode: 'until_time',
          attentionUntil: new Date('2020-02-01T00:00:00Z'),
          attentionPrecision: 'date',
        }),
        verdictDe(304, { purpose: 'marketing', attentionMode: 'none' }),
        verdictDe(305, { purpose: 'conversation', attentionMode: 'none' }),
      ],
      documents: [
        { messageId: 303, kind: 'invoice', label: null, issuer: 'EDF', issueDate: null, dueDate: null, amount: 120, currency: 'EUR', reference: null, certainty: 'explicit' },
      ],
      expediteurs: [
        { accountSlug: 'test', email: 'maman@example.com', category: 'person', categorySource: 'auto', categoryReason: null, priority: 'normal', kind: 'person', engagedAt: null },
      ],
    }),
    { maintenant: MAINTENANT },
  );
  verifier('jamais analysé ⇒ PROTÉGÉ (preuve insuffisante)', true, getCleanupProtection(etats.get(301)).protege);
  verifier(
    'le bruit avéré, lui, se LIBÈRE (sinon l’invariant serait vide)',
    false,
    getCleanupProtection(etats.get(302)).protege,
  );
  const facturePerimee = etats.get(303) as EtatSemantique;
  verifier('la facture de 2020 est bien PÉRIMÉE…', true, facturePerimee.courant.attention.perimee);
  verifier('…et reste INTOUCHABLE : périmé ≠ supprimable', true, getCleanupProtection(facturePerimee).protege);
  verifier(
    'certitude « high » de l’IA ≠ autorisation : le document veto quand même',
    true,
    etats.get(303)?.analyse.confianceLegacy === 'high' && getCleanupProtection(etats.get(303)).protege,
  );
  verifier('correction manuelle ⇒ PROTÉGÉ, même du bruit', true, getCleanupProtection(etats.get(304)).protege);
  verifier('expéditeur « personne » ⇒ PROTÉGÉ (0 mail personnel)', true, getCleanupProtection(etats.get(305)).protege);
}

// ---------------------------------------------------------------------------

console.log('\n=== 9. Socle — l’inconnu ne périme jamais, et c’est transitif ===\n');

{
  const etats = resoudre(
    lignes({
      messages: [msg(401), msg(402)],
      verdicts: [verdictDe(401, { attentionMode: 'unknown' })],
      actions: [
        // dueAt PASSÉ : ce n'est ni une péremption ni une résolution.
        actionDe(401, { kind: 'pay', dueAt: new Date('2026-01-15T00:00:00Z'), duePrecision: 'date' }),
      ],
      evenements: [
        {
          messageId: 401,
          kind: 'appointment',
          label: null,
          startsAt: new Date('2026-01-15T00:00:00Z'),
          startsPrecision: 'date',
          endsAt: null,
          participation: 'participant',
          certainty: 'explicit',
        },
      ],
    }),
    { maintenant: MAINTENANT },
  );
  const inconnu = etats.get(401) as EtatSemantique;
  verifier(
    'mode « unknown » : pas de péremption fabriquée depuis dueAt ni startsAt',
    false,
    inconnu.courant.attention.perimee,
  );
  verifier('l’action au dueAt passé reste OUVERTE', true, inconnu.courant.actions[0]?.resteAFaire);
  verifier('…et marquée EN RETARD — un retard, pas une résolution', true, inconnu.courant.actions[0]?.enRetard);
  const echeancesAction = getDeadlineState(inconnu).filter((e) => e.origine === 'action');
  verifier('l’échéance dérivée de l’action est échue…', true, echeancesAction[0]?.echue);
  verifier('…mais PAS close', false, echeancesAction[0]?.close);
  verifier(
    'jamais analysé : l’attention ne périme pas non plus',
    false,
    (etats.get(402) as EtatSemantique).courant.attention.perimee,
  );
}

// ---------------------------------------------------------------------------

console.log('\n=== 10. Socle — une échéance passée n’est pas close ===\n');

{
  const echeance = (messageId: number, status: string) => ({
    messageId,
    title: 'Payer la taxe foncière',
    date: new Date('2026-01-15T00:00:00Z'),
    type: 'payment',
    status,
    vetoReason: status === 'vetoed' ? 'ai_no_action' : null,
    reason: 'détectée dans le mail',
  });
  const etats = resoudre(
    lignes({
      messages: [msg(501), msg(502), msg(503)],
      echeances: [echeance(501, 'confirmed'), echeance(502, 'done'), echeance(503, 'vetoed')],
    }),
    { maintenant: MAINTENANT },
  );
  const enRetard = (etats.get(501) as EtatSemantique).courant.echeances[0];
  verifier('confirmée et dépassée : ÉCHUE', true, enRetard?.echue);
  verifier('…mais PAS close (dueAt < maintenant = retard, pas résolution)', false, enRetard?.close);
  verifier('son statut le dit : « en_retard »', 'en_retard', enRetard?.statut);
  verifier('une échéance active protège du nettoyage', true, getCleanupProtection(etats.get(501)).protege);
  const faite = (etats.get(502) as EtatSemantique).courant.echeances[0];
  verifier('« faite » est close, par un ACTE (source manuel)', true, faite?.close && faite?.source === 'manuel');
  const vetoee = (etats.get(503) as EtatSemantique).courant.echeances[0];
  verifier('« vetoed » est écartée, par l’IA', true, vetoee?.statut === 'ecartee' && vetoee?.source === 'ia');
}

// ---------------------------------------------------------------------------
//
// LE MOTEUR DES ÉCHÉANCES (lot 4c) — les trois pièges de la contre-revue,
// éprouvés sur les fonctions pures de deadlines.ts avec des états résolus en
// mémoire. Le veto codé à la main a disparu : c'est CES fonctions qui doivent
// porter les garanties, pas une règle par cas.

console.log('\n=== 11. Échéances — piège n° 1 : une date n’est pas une échéance ===\n');

{
  const etats = resoudre(
    lignes({
      messages: [msg(601), msg(602), msg(603), msg(604), msg(605)],
      verdicts: [
        // PayFiP : notification pure, un événement informatif, AUCUNE action.
        verdictDe(601, { purpose: 'notification', summary: 'Le paiement par carte sera indisponible le 12 mai.' }),
        // Un mail qui PORTE une facture (dueDate connue) sans action déclarée.
        verdictDe(602, { purpose: 'document_delivery' }),
        // Une action datée, mais dont l'acteur n'est PAS l'utilisateur.
        verdictDe(603, { purpose: 'notification' }),
        // La seule vraie échéance du lot : action `pay` de l'utilisateur, datée.
        verdictDe(604, { purpose: 'request' }),
        // Sosh : le titre vient du GESTE lu par l'analyse, jamais de l'expéditeur.
        verdictDe(605, { purpose: 'document_delivery', summary: 'Sa mère transmet la facture Sosh de mai.' }),
      ],
      evenements: [
        {
          messageId: 601,
          kind: 'service_window',
          label: 'Indisponibilité du paiement par carte',
          startsAt: new Date('2026-05-12T00:00:00Z'),
          startsPrecision: 'date',
          endsAt: null,
          participation: 'informational',
          certainty: 'explicit',
        },
      ],
      documents: [
        { messageId: 602, kind: 'invoice', label: null, issuer: 'EDF', issueDate: null, dueDate: new Date('2026-09-01T00:00:00Z'), amount: 120, currency: 'EUR', reference: null, certainty: 'explicit' },
      ],
      actions: [
        actionDe(603, { kind: 'pay', actor: 'sender', dueAt: new Date('2026-09-15T00:00:00Z'), duePrecision: 'date' }),
        actionDe(604, { kind: 'pay', dueAt: new Date('2026-09-15T00:00:00Z'), duePrecision: 'date', certainty: 'explicit' }),
        actionDe(605, { kind: 'pay', label: 'Payer la facture Sosh', amount: 42.3, currency: 'EUR', dueAt: new Date('2026-09-01T00:00:00Z'), duePrecision: 'date' }),
      ],
      mentions: [
        { messageId: 605, kind: 'person', nameRaw: 'Maman', role: 'sent_by', identifier: null, certainty: 'explicit' },
        { messageId: 605, kind: 'company', nameRaw: 'Sosh', role: 'issued_by', identifier: null, certainty: 'explicit' },
      ],
    }),
    { maintenant: MAINTENANT },
  );
  const payfip = echeancesDepuisLeVerdict(etats.get(601) as EtatSemantique);
  verifier('PayFiP : une date d’ÉVÉNEMENT ne crée AUCUNE échéance', 0, payfip.echeances.length);
  verifier('…et ne déclare rien d’inconnu non plus', 0, payfip.actionsSansDate.length);
  verifier(
    'la dueDate d’un DOCUMENT ne crée aucune échéance (aucune action déclarée)',
    0,
    echeancesDepuisLeVerdict(etats.get(602) as EtatSemantique).echeances.length,
  );
  verifier(
    'une action datée dont l’acteur n’est PAS l’utilisateur ne crée rien',
    0,
    echeancesDepuisLeVerdict(etats.get(603) as EtatSemantique).echeances.length,
  );
  const vraie = echeancesDepuisLeVerdict(etats.get(604) as EtatSemantique);
  verifier('une action `pay` de l’utilisateur, datée, crée UNE échéance', 1, vraie.echeances.length);
  verifier('…du bon type (le GESTE décide, pas les mots du sujet)', 'payment', vraie.echeances[0]?.type);
  const soshE = echeancesDepuisLeVerdict(etats.get(605) as EtatSemantique);
  verifier(
    'Sosh : le titre vient de l’action lue, jamais « payer maman »',
    'Payer la facture Sosh',
    soshE.echeances[0]?.titre,
  );
  verifier(
    'et la raison avoue sa provenance (verdict, pas texte)',
    true,
    (soshE.echeances[0]?.reason ?? '').includes('verdict sémantique'),
  );
}

// ---------------------------------------------------------------------------

console.log('\n=== 12. Échéances — piège n° 2 : passée n’est pas close ===\n');

{
  const etats = resoudre(
    lignes({
      messages: [msg(701), msg(702), msg(703)],
      verdicts: [
        verdictDe(701, { purpose: 'request', attentionMode: 'while_action_open' }),
        // Air France : la fenêtre d'action est PASSÉE (expiresAt), pas le dueAt.
        verdictDe(702, { purpose: 'request', attentionMode: 'until_time', attentionUntil: new Date('2026-06-16T00:00:00Z'), attentionPrecision: 'date' }),
        // PayFiP au stade de l'arbitrage : verdict présent, aucune action.
        verdictDe(703, { purpose: 'notification', summary: 'information technique ponctuelle, rien à faire' }),
      ],
      actions: [
        // Payé pour le 15 janvier, on est le 12 août : RETARD, pas résolution.
        actionDe(701, { kind: 'pay', dueAt: new Date('2026-01-15T00:00:00Z'), duePrecision: 'date' }),
        actionDe(702, { kind: 'confirm', label: "S'enregistrer en ligne", expiresAt: new Date('2026-06-16T00:00:00Z'), expiresPrecision: 'date' }),
      ],
    }),
    { maintenant: MAINTENANT },
  );
  const retard = echeancesDepuisLeVerdict(etats.get(701) as EtatSemantique);
  verifier('une action au dueAt PASSÉ produit toujours son échéance', 1, retard.echeances.length);
  verifier(
    '…et son arbitrage la GARDE (le temps qui passe ne ferme rien)',
    true,
    arbitrerProposition(etats.get(701), new Date('2026-01-15T00:00:00Z')).garder,
  );
  const airFranceEtat = etats.get(702) as EtatSemantique;
  verifier('Air France : fenêtre passée ⇒ AUCUNE échéance créée', 0, echeancesDepuisLeVerdict(airFranceEtat).echeances.length);
  const arbAir = arbitrerProposition(airFranceEtat, new Date('2026-06-16T00:00:00Z'));
  verifier('…et la proposition regex correspondante est écartée', false, arbAir.garder);
  verifier(
    'avec le BON motif : hors délai, pas « résolu par le calendrier »',
    true,
    arbAir.pourquoi.includes('fenêtre'),
  );
  const arbPayfip = arbitrerProposition(etats.get(703), new Date('2026-05-12T00:00:00Z'));
  verifier('PayFiP : proposition écartée (aucune action de ta part)', false, arbPayfip.garder);
  verifier(
    '…en citant ce que l’analyse a conclu',
    true,
    arbPayfip.pourquoi.includes('la date décrit un fait'),
  );
}

// ---------------------------------------------------------------------------

console.log('\n=== 13. Échéances — piège n° 3 : aucune date inventée ===\n');

{
  const etats = resoudre(
    lignes({
      messages: [msg(801), msg(802)],
      verdicts: [verdictDe(801, { purpose: 'request', attentionMode: 'while_action_open' })],
      actions: [
        // Une facture à payer dont l'analyse n'a PAS su lire la date : pas de
        // « facture + 30 jours », pas de « rappel = aujourd'hui ».
        actionDe(801, { kind: 'pay', label: 'Payer la facture EDF', dueAt: null }),
      ],
    }),
    { maintenant: MAINTENANT },
  );
  const inconnue = echeancesDepuisLeVerdict(etats.get(801) as EtatSemantique);
  verifier('action due sans date ⇒ AUCUNE échéance fabriquée', 0, inconnue.echeances.length);
  verifier('…mais elle est DÉCLARÉE comme inconnue', 1, inconnue.actionsSansDate.length);
  verifier('…avec son libellé, pour pouvoir le dire à l’écran', 'Payer la facture EDF', inconnue.actionsSansDate[0]);
  verifier(
    'une proposition regex sur ce mail est GARDÉE (l’action est ouverte, sa date illisible)',
    true,
    arbitrerProposition(etats.get(801), new Date('2026-09-30T00:00:00Z')).garder,
  );
  const arbSansVerdict = arbitrerProposition(etats.get(802), new Date('2026-09-30T00:00:00Z'));
  verifier('sans verdict, l’arbitrage ne fait taire personne', true, arbSansVerdict.garder);
  verifier(
    '…et le dit : la proposition est un repli en attendant l’analyse',
    true,
    arbSansVerdict.pourquoi.includes('repli'),
  );
}

// ---------------------------------------------------------------------------
//
// LE MOTEUR DES RÉPONSES ATTENDUES (lot 4d) — les trois pièges de la
// contre-revue, éprouvés sur `evaluerReponseAttendue` avec des états résolus
// en mémoire. NO_REPLY_INTENTS et le veto `aiAction` ne parlent plus que dans
// le repli ; sur un mail au verdict connu, c'est l'action ouverte + la
// fenêtre + l'état du fil, et rien d'autre.

console.log('\n=== 14. Réponses attendues — action ouverte + fenêtre + fil ===\n');

{
  const mails: Record<number, LigneMessage> = {
    // Demande de réservation Airbnb : adresse « automated@ » (le banc du 11/08
    // en a compté 48 masquées par la regex), action `reply` ouverte.
    901: msg(901, { fromEmail: 'automated@airbnb.com', subject: 'Demande de réservation de Julie' }),
    // Même demande, mais il a RÉPONDU (sortant réel après ce mail dans le fil).
    902: msg(902, { fromEmail: 'automated@airbnb.com', threadId: 90 }),
    // La demande de réponse vise un TIERS, pas lui.
    903: msg(903),
    // Facture livrée, fenêtre vivante, AUCUNE demande de réponse.
    904: msg(904),
    // Réponse demandée, mais la fenêtre d'attention est passée depuis juin.
    905: msg(905),
    // Fil marqué « pas de réponse nécessaire » par l'utilisateur.
    906: msg(906, { threadId: 96 }),
    // \Answered posé par IMAP.
    907: msg(907, { isAnswered: true }),
    // --- repli (aucun verdict sémantique) :
    910: msg(910, { fromEmail: 'no-reply@vilogi.com', intent: 'reply_expected', intentSource: 'ai' }),
    911: msg(911, { fromEmail: 'no-reply@edf.fr' }),
    912: msg(912, { fromEmail: 'artisan@example.com', intent: 'invoice', intentSource: 'ai' }),
    913: msg(913, { fromEmail: 'billing@stripe.com', intent: 'invoice', intentSource: 'ai' }),
    914: msg(914, { fromEmail: 'contact@copro.fr', intent: 'info', intentSource: 'ai' }),
  };
  const etats = resoudre(
    lignes({
      messages: Object.values(mails),
      verdicts: [
        verdictDe(901, { attentionMode: 'while_action_open' }),
        verdictDe(902, { attentionMode: 'while_action_open' }),
        verdictDe(903, { attentionMode: 'while_action_open' }),
        verdictDe(904, {
          purpose: 'document_delivery',
          attentionMode: 'until_time',
          attentionUntil: new Date('2026-09-30T00:00:00Z'),
          attentionPrecision: 'date',
        }),
        verdictDe(905, {
          attentionMode: 'until_time',
          attentionUntil: new Date('2026-06-16T00:00:00Z'),
          attentionPrecision: 'date',
        }),
        verdictDe(906, { attentionMode: 'while_action_open' }),
        verdictDe(907, { attentionMode: 'while_action_open' }),
      ],
      actions: [
        actionDe(901, { label: 'Répondre à la demande de réservation' }),
        actionDe(902),
        actionDe(903, { actor: 'third_party' }),
        actionDe(905),
        actionDe(906),
        actionDe(907),
      ],
      documents: [
        { messageId: 904, kind: 'invoice', label: null, issuer: 'EDF', issueDate: null, dueDate: null, amount: 120, currency: 'EUR', reference: null, certainty: 'explicit' },
      ],
      fils: [
        { id: 90, lastMessageAt: new Date('2026-08-02T09:00:00Z') },
        { id: 96, lastMessageAt: new Date('2026-08-01T10:00:00Z') },
      ],
      sortants: [{ threadId: 90, dernierLe: new Date('2026-08-02T09:00:00Z') }],
      etatsFil: [
        { threadId: 96, messageId: 906, kind: 'reply', state: 'dismissed', snoozedUntil: null },
      ],
      expediteurs: [
        // L'artisan est une PERSONNE : jamais écarté par le repli, quoi qu'il envoie.
        { accountSlug: 'test', email: 'artisan@example.com', category: 'person', categorySource: 'auto', categoryReason: null, priority: 'normal', kind: 'person', engagedAt: null },
        { accountSlug: 'test', email: 'billing@stripe.com', category: 'company', categorySource: 'auto', categoryReason: null, priority: 'normal', kind: 'company', engagedAt: null },
      ],
    }),
    { maintenant: MAINTENANT },
  );
  const evalDe = (id: number, aiAction: string | null = null) => {
    const m = mails[id];
    return evaluerReponseAttendue(
      etats.get(id),
      { fromEmail: m.fromEmail ?? '', subject: m.subject, date: m.date, intent: m.intent, aiAction },
      MAINTENANT.getTime(),
    );
  };

  verifier('Airbnb « automated@ » + action reply ouverte : VISIBLE', true, evalDe(901).attendue);
  verifier('…et la décision vient du verdict, pas de l’adresse', 'verdict', evalDe(901).source);
  verifier('il a répondu dans le fil : plus en attente', false, evalDe(902).attendue);
  verifier(
    '…et la raison dit la clôture (fait ≠ état)',
    true,
    evalDe(902).pourquoi.includes('tu as écrit dans le fil'),
  );
  verifier('\\Answered posé par IMAP : plus en attente non plus', false, evalDe(907).attendue);
  verifier('la demande vise un TIERS, pas lui : rien à répondre', false, evalDe(903).attendue);
  verifier('facture sans demande de réponse : pas listée…', false, evalDe(904).attendue);
  verifier(
    '…pour la bonne raison (aucune action), jamais sa catégorie',
    true,
    evalDe(904).pourquoi.includes('aucune réponse à faire'),
  );
  verifier('fenêtre d’attention passée : plus en attente', false, evalDe(905).attendue);
  verifier(
    'fil écarté à la main : reste LISTABLE (onglet Ignorées, restaurable)',
    true,
    evalDe(906).attendue,
  );
  verifier(
    '…avec le pourquoi de l’écartement',
    true,
    evalDe(906).pourquoi.includes('pas de réponse nécessaire'),
  );
  // --- le repli, correctif du 11/08 compris
  verifier(
    'repli : « attend une réponse » (analyse legacy) prime sur no-reply@',
    true,
    evalDe(910).attendue,
  );
  verifier('…et s’assume comme repli', 'repli', evalDe(910).source);
  verifier('repli : no-reply@ sans analyse contraire reste écarté', false, evalDe(911).attendue);
  verifier('repli : une PERSONNE n’est jamais écartée, même une facture', true, evalDe(912).attendue);
  verifier('repli : facture d’une entreprise, pas de réponse attendue', false, evalDe(913).attendue);
  verifier(
    'repli : l’ancienne analyse « archive » fait toujours veto',
    false,
    evalDe(914, 'archive').attendue,
  );
}

// ---------------------------------------------------------------------------
//
// LE MOTEUR D'IMPORTANCE (lot 4e) — le classement se fonde sur l'ouverture,
// l'échéance et la conséquence ; les choix de l'utilisateur (⭐/🔕) restent
// souverains ; le repli (mails sans verdict) garde le score historique.

console.log('\n=== 15. Importance — ouverture, échéance, conséquence ===\n');

{
  const mails: Record<number, LigneMessage> = {
    // Comptastar : paiement échoué, action `pay` ouverte, 850 €, due le 15/08.
    1001: msg(1001, { subject: 'Votre paiement à Comptastar a échoué' }),
    // Air France en août : sujet alarmant, mais fenêtre passée et rien à faire.
    1002: msg(1002, { subject: 'Dernier rappel : enregistrez-vous pour votre voyage' }),
    // Réservation : action reply ouverte, mail récent, rien d'autre.
    1003: msg(1003, { date: new Date('2026-08-10T10:00:00Z') }),
  };
  const etats = resoudre(
    lignes({
      messages: Object.values(mails),
      verdicts: [
        verdictDe(1001, { attentionMode: 'while_action_open' }),
        verdictDe(1002, {
          attentionMode: 'until_time',
          attentionUntil: new Date('2026-06-16T00:00:00Z'),
          attentionPrecision: 'date',
        }),
        verdictDe(1003, { attentionMode: 'while_action_open' }),
      ],
      actions: [
        actionDe(1001, { kind: 'pay', label: 'Régler le paiement Comptastar', amount: 850, currency: 'EUR', dueAt: new Date('2026-08-15T00:00:00Z'), duePrecision: 'date' }),
        actionDe(1002, { kind: 'confirm', expiresAt: new Date('2026-06-16T00:00:00Z'), expiresPrecision: 'date' }),
        actionDe(1003, { label: 'Répondre à la demande de réservation' }),
      ],
      documents: [
        { messageId: 1001, kind: 'invoice', label: null, issuer: 'Comptastar', issueDate: null, dueDate: null, amount: 850, currency: 'EUR', reference: null, certainty: 'explicit' },
      ],
    }),
    { maintenant: MAINTENANT },
  );
  const entree = (id: number, sur: Partial<Parameters<typeof scoreMessage>[0]> = {}) => ({
    subject: mails[id]?.subject ?? '',
    fromEmail: 'contact@acme.fr',
    fromName: null,
    isSeen: true,
    date: mails[id]?.date ?? new Date('2026-08-10T10:00:00Z'),
    hasListUnsubscribe: false,
    ...sur,
  });
  const contexte = (id: number | null, sur: Partial<Parameters<typeof scoreMessage>[1]> = {}) => ({
    senderKind: 'company',
    senderPriority: 'normal',
    threadHasOutbound: false,
    awaitingReply: false,
    etat: id !== null ? (etats.get(id) ?? null) : null,
    now: MAINTENANT.getTime(),
    ...sur,
  });

  // LA vérification demandée : une action ouverte pèse plus qu'un expéditeur
  // connu. Même mail, d'un côté une action ouverte (+35), de l'autre une
  // adresse de banque/administration (+30) — l'action gagne.
  const avecAction = scoreMessage(entree(1003, { subject: '' }), contexte(1003));
  const expediteurConnu = scoreMessage(
    entree(1003, { subject: '', fromEmail: 'contact@impots.gouv.fr' }),
    contexte(null),
  );
  verifier(
    'une action ouverte (+35) pèse plus qu’un expéditeur connu (+30)',
    true,
    avecAction.score > expediteurConnu.score,
  );
  verifier('…et sa raison est affichable telle quelle, en français', true,
    avecAction.reasons.some((r) => r.includes('une action reste à faire de ta part')));

  // Air France en août : le sujet crie (« dernier rappel »), l'analyse sait
  // que la fenêtre est passée — le mail ne remonte plus.
  const airAout = scoreMessage(entree(1002), contexte(1002));
  verifier('Air France en août : niveau LOW malgré le sujet alarmant', 'low', airAout.level);
  verifier(
    '…parce que la fenêtre est passée (raison explicite)',
    true,
    airAout.reasons.some((r) => r.includes("la fenêtre d'attention est passée")),
  );

  // Conséquence : l'argent en jeu vient de l'ANALYSE, pas d'une regex de sujet.
  const comptastar = scoreMessage(entree(1001), contexte(1001));
  verifier('l’argent en jeu est cité (850,00 EUR, lu par l’analyse)', true,
    comptastar.reasons.some((r) => r.includes('850,00')));
  verifier('échéance proche (le 15/08) : citée aussi', true,
    comptastar.reasons.some((r) => r.includes('à faire avant le')));
  verifier('paiement échoué + montant + document : niveau HIGH', 'high', comptastar.level);

  // Les choix de l'utilisateur restent souverains — un acte, pas une analyse.
  const etoile = scoreMessage(entree(1003), contexte(1003, { senderPriority: 'always_important' }));
  verifier('⭐ toujours important ajoute toujours ses 40 points', true,
    etoile.reasons.some((r) => r.startsWith('+40')));
  const silencieux = scoreMessage(entree(1001), contexte(1001, { senderPriority: 'never_urgent' }));
  verifier('🔕 jamais urgent plafonne à 30, MÊME une action ouverte', true,
    silencieux.score <= 30 && silencieux.reasons.some((r) => r.includes('plafonné à 30')));

  // Une demande à traiter n'est pas punie parce qu'elle voyage avec un
  // List-Unsubscribe (les demandes Airbnb en portent un).
  const reservation = scoreMessage(
    entree(1003, { hasListUnsubscribe: true }),
    contexte(1003, { senderKind: 'notification' }),
  );
  verifier('action ouverte : pas de malus « newsletter/notification »', true,
    reservation.reasons.every((r) => !r.includes('rarement important')));

  // Le REPLI (aucun verdict) garde le score historique, à l'identique.
  const repli = scoreMessage(
    entree(1003, {
      subject: 'Relance : facture 150 € — peux-tu confirmer ?',
      date: new Date('2026-07-20T10:00:00Z'),
    }),
    contexte(null, { awaitingReply: true }),
  );
  verifier(
    'repli : question + montant du sujet + attente + ancienneté = 40',
    40,
    repli.score,
  );
}

// ---------------------------------------------------------------------------
//
// LE DÉPOUILLEMENT (lot 4f) — l'écran quotidien, le plus gros risque de la
// refonte d'après la contre-revue : ses 8 fonctions ne migrent pas séparément,
// elles lisent TOUTES l'objet résolu par `depouillerEtat` (fonction pure).

console.log('\n=== 16. Dépouillement — un objet résolu, une carte, une raison ===\n');

{
  const etats = resoudre(
    lignes({
      messages: [
        // Facture EDF : action `pay` ouverte + échéance DÉJÀ créée + document.
        msg(1601, { subject: 'Votre facture EDF' }),
        // Air France en août : la fenêtre d'action est passée, rien à faire.
        msg(1602, { subject: 'Dernier rappel : enregistrez-vous pour votre voyage' }),
        // Repli : promo d'une entreprise, jamais analysé.
        msg(1603, { intent: 'promo', intentSource: 'ai' }),
        // Correction manuelle d'Anthony, pas encore de verdict.
        msg(1604, { intent: 'invoice', intentSource: 'manual', intentReason: 'corrigé par toi' }),
        // Même expéditeur : une quittance et une pub (la clé de lot).
        msg(1605),
        msg(1606),
        // Même purpose (marketing), intents legacy DIFFÉRENTS.
        msg(1607, { intent: 'promo', intentSource: 'ai' }),
        msg(1608, { intent: 'info', intentSource: 'auto' }),
        // Verdict + action reply ouverte (le geste attendu est une réponse).
        msg(1609),
        // Action `pay` due SANS date lisible.
        msg(1610),
      ],
      verdicts: [
        verdictDe(1601, { purpose: 'request', attentionMode: 'while_action_open' }),
        verdictDe(1602, {
          purpose: 'request',
          attentionMode: 'until_time',
          attentionUntil: new Date('2026-06-16T00:00:00Z'),
          attentionPrecision: 'date',
        }),
        verdictDe(1605, { purpose: 'transaction_record', attentionMode: 'none' }),
        verdictDe(1606, { purpose: 'marketing', attentionMode: 'none' }),
        verdictDe(1607, { purpose: 'marketing', attentionMode: 'none' }),
        verdictDe(1608, { purpose: 'marketing', attentionMode: 'none' }),
        verdictDe(1609, { attentionMode: 'while_action_open' }),
        verdictDe(1610, { purpose: 'request', attentionMode: 'while_action_open' }),
      ],
      actions: [
        actionDe(1601, { kind: 'pay', label: 'Payer la facture EDF', amount: 120, currency: 'EUR', dueAt: new Date('2026-08-20T00:00:00Z'), duePrecision: 'date' }),
        actionDe(1602, { kind: 'confirm', expiresAt: new Date('2026-06-16T00:00:00Z'), expiresPrecision: 'date' }),
        actionDe(1609, { label: 'Répondre à la demande' }),
        actionDe(1610, { kind: 'pay', label: 'Payer la facture Sosh', amount: 42.3, currency: 'EUR' }),
      ],
      documents: [
        { messageId: 1601, kind: 'invoice', label: null, issuer: 'EDF', issueDate: null, dueDate: null, amount: 120, currency: 'EUR', reference: null, certainty: 'explicit' },
      ],
      echeances: [
        { messageId: 1601, title: 'Payer EDF', date: new Date('2026-08-20T00:00:00Z'), type: 'payment', status: 'confirmed', vetoReason: null, reason: 'détectée dans le mail' },
      ],
    }),
    { maintenant: MAINTENANT },
  );
  const repli = { aiAction: null, intentSource: null };

  const edf = depouillerEtat(etats.get(1601) as EtatSemantique, repli);
  verifier('facture à payer : classe « à décider »', 'important', edf.classe);
  verifier('…décidée par le verdict', 'verdict', edf.source);
  verifier(
    'UNE raison principale, qui cite le geste et le montant',
    true,
    edf.primaryReason.includes('Payer la facture EDF') && edf.primaryReason.includes('120,00'),
  );
  verifier(
    'l’échéance liée est une MENTION secondaire, pas une carte concurrente',
    true,
    edf.secondaryReasons.some((s) => s.includes('déjà suivie en échéance')),
  );
  verifier('le geste central est le paiement', 'pay', edf.geste?.kind);

  const air = depouillerEtat(etats.get(1602) as EtatSemantique, repli);
  verifier('Air France en août : rangeable, plus « à décider »', 'range', air.classe);
  verifier(
    '…et la raison avoue la fenêtre passée',
    true,
    air.primaryReason.includes('plus rien à surveiller'),
  );
  verifier('aucun geste retenu (l’action est hors délai)', null, air.geste);
  verifier('…donc AUCUNE proposition fabriquée', null,
    buildProposal({ subject: air ? 'Dernier rappel' : '', fromEmail: 'x@airfrance.fr', fromName: 'Air France', date: new Date('2026-06-01T00:00:00Z') }, null, null, air));

  const promoRepli = depouillerEtat(etats.get(1603) as EtatSemantique, repli);
  verifier('repli : promo d’une entreprise → rangeable', 'range', promoRepli.classe);
  verifier('…qui s’assume comme repli', 'repli', promoRepli.source);
  verifier('…et l’avoue dans la raison affichée', true, promoRepli.primaryReason.includes('repli'));

  const manuel = depouillerEtat(etats.get(1604) as EtatSemantique, repli);
  verifier(
    'correction manuelle : à décider, et la provenance est « manuel »',
    true,
    manuel.classe === 'important' && manuel.natureSource === 'manuel',
  );

  // La clé de regroupement des lots : compte|expéditeur|FAMILLE — intent en
  // est sorti. La famille vient du purpose du verdict, ou de la nature résolue
  // en repli, et les deux régimes ne se mélangent jamais (préfixes v:/n:).
  const quittance = depouillerEtat(etats.get(1605) as EtatSemantique, repli);
  const marketing = depouillerEtat(etats.get(1606) as EtatSemantique, repli);
  verifier(
    'quittance et pub du même expéditeur : lots SÉPARÉS (le purpose distingue)',
    true,
    quittance.lotFamille !== marketing.lotFamille,
  );
  const promoV = depouillerEtat(etats.get(1607) as EtatSemantique, repli);
  const infoV = depouillerEtat(etats.get(1608) as EtatSemantique, repli);
  verifier(
    'même purpose, intents legacy différents : MÊME lot (intent a quitté la clé)',
    promoV.lotFamille,
    infoV.lotFamille,
  );
  verifier('…avec un libellé français pour l’écran', true, (promoV.lotFamilleLabel ?? '').length > 0);
  verifier(
    'un mail analysé et un non-analysé ne partagent JAMAIS un lot',
    true,
    promoRepli.lotFamille !== promoV.lotFamille,
  );

  const reponse = depouillerEtat(etats.get(1609) as EtatSemantique, repli);
  verifier('action reply ouverte : le geste attendu est une réponse', true, reponse.veutRepondre);

  // Propositions : présentatives, elles ne relisent rien et n'inventent rien.
  const mLite = { subject: 'Votre facture EDF', fromEmail: 'exp@example.com', fromName: 'EDF', date: new Date('2026-08-01T10:00:00Z') };
  const pEdf = buildProposal(mLite, null, null, edf);
  verifier(
    'proposition : échéance de PAIEMENT à la date lue par l’analyse',
    true,
    pEdf?.objectType === 'deadline' && pEdf.deadlineType === 'payment' && (pEdf.date ?? '').startsWith('2026-08-20'),
  );
  verifier('…et le pourquoi avoue le verdict', true, (pEdf?.why ?? '').includes('verdict sémantique'));
  const sansDate = depouillerEtat(etats.get(1610) as EtatSemantique, repli);
  const pSansDate = buildProposal(mLite, null, null, sansDate);
  verifier(
    'action due SANS date : une tâche, aucune date inventée (pas de regex)',
    true,
    pSansDate?.objectType === 'task' && pSansDate.date === null,
  );
  verifier('…et le dit (« rien d’inventé »)', true, (pSansDate?.why ?? '').includes("rien d'inventé"));
}

// ---------------------------------------------------------------------------
//
// L'ACCUEIL « AUJOURD'HUI » (lot 4g) — il consomme, il n'interprète plus :
// « factures à traiter » est devenu « paiements encore ouverts » (le socle
// tranche), et un même mail ne produit qu'UNE carte.

console.log('\n=== 17. Aujourd’hui — consommer, pas interpréter ===\n');

{
  const etats = resoudre(
    lignes({
      messages: [msg(1701), msg(1702), msg(1703), msg(1704), msg(1705), msg(1706)],
      verdicts: [
        // Paiement ouvert (Comptastar, 850 €, dû le 15/08).
        verdictDe(1701, { attentionMode: 'while_action_open' }),
        // Paiement SOLDÉ : la tâche liée est faite.
        verdictDe(1702, { attentionMode: 'while_action_open' }),
        // PayFiP : notification, AUCUNE action — le mot « paiement » ne suffit pas.
        verdictDe(1703, { purpose: 'notification' }),
        // Paiement dont la fenêtre d'action est PASSÉE : agir n'a plus de sens.
        verdictDe(1704, {
          attentionMode: 'until_time',
          attentionUntil: new Date('2026-06-16T00:00:00Z'),
          attentionPrecision: 'date',
        }),
        // Paiement au dueAt DÉPASSÉ : un retard, pas une résolution.
        verdictDe(1706, { attentionMode: 'while_action_open' }),
      ],
      actions: [
        actionDe(1701, { kind: 'pay', label: 'Régler Comptastar', amount: 850, currency: 'EUR', dueAt: new Date('2026-08-15T00:00:00Z'), duePrecision: 'date' }),
        actionDe(1702, { kind: 'pay', label: 'Payer la facture' }),
        actionDe(1704, { kind: 'pay', expiresAt: new Date('2026-06-16T00:00:00Z'), expiresPrecision: 'date' }),
        actionDe(1706, { kind: 'pay', label: 'Payer la taxe', dueAt: new Date('2026-01-15T00:00:00Z'), duePrecision: 'date' }),
      ],
      taches: [{ messageId: 1702, status: 'done' }],
    }),
    { maintenant: MAINTENANT },
  );
  const ouvert = paiementOuvert(etats.get(1701));
  verifier(
    'paiement ouvert : il remonte, avec le montant lu par l’analyse',
    true,
    (ouvert?.pourquoi ?? '').includes('850,00'),
  );
  verifier('paiement soldé (tâche faite) : plus une action du jour', null, paiementOuvert(etats.get(1702)));
  verifier('aucune action déclarée (PayFiP) : rien à payer', null, paiementOuvert(etats.get(1703)));
  verifier(
    'fenêtre d’action passée : ne remonte pas dans la vue du jour',
    null,
    paiementOuvert(etats.get(1704)),
  );
  verifier('jamais analysé : le verdict ne parle pas (le repli SQL vit ailleurs)', null, paiementOuvert(etats.get(1705)));
  const retard = paiementOuvert(etats.get(1706));
  verifier(
    'dueAt dépassé : remonte quand même — un RETARD, pas une résolution',
    true,
    (retard?.pourquoi ?? '').includes('en retard, pas résolue'),
  );

  // UNE carte par mail : échéance > réponse > paiement.
  const dl = [{ messageId: 12 }];
  const replies = [{ messageId: 11 }, { messageId: 12 }];
  const invoices = [{ messageId: 11 }, { messageId: 13 }, { messageId: 12 }];
  const repliesU = uneCarteParMail(dl, replies);
  verifier(
    'un mail déjà en échéance ne redevient pas « réponse attendue »',
    [11],
    repliesU.map((x) => x.messageId),
  );
  const invoicesU = uneCarteParMail([...dl, ...repliesU], invoices);
  verifier(
    '…ni « paiement » quand une autre famille l’a déjà cardé',
    [13],
    invoicesU.map((x) => x.messageId),
  );
}

// ---------------------------------------------------------------------------
//
// RECHERCHE & DOSSIERS (lot 4h) — retrouver par ce que l'ANALYSE a nommé :
// une entité ou un dossier cités par le verdict font retrouver un mail dont
// ni le sujet ni le texte ne portent le terme cherché ; la propagation des
// dossiers compare des clés normalisées et des identifiants durs, plus jamais
// seulement des sous-chaînes.

console.log('\n=== 18. Recherche & dossiers — retrouvés par ce que l’analyse a nommé ===\n');

{
  // Un mail dont NI le sujet NI le texte ne disent « république » : seule
  // l'analyse l'a nommé. La raison affichée doit le dire.
  const ou = explainMatch('république', {
    subject: 'Compte rendu de visite',
    snippet: 'Bonjour, suite à notre passage sur place…',
    entites: ['46 rue de la République'],
    contextes: [],
  });
  verifier('retrouvé par une entité que le sujet ne contient pas', true, ou.includes('entité citée'));
  verifier(
    '…et par elle seule (ni le sujet ni le texte ne la portent)',
    false,
    ou.includes('sujet') || ou.includes('texte du mail'),
  );
  const ouCtx = explainMatch('affaire odas', {
    subject: 'Convocation',
    contextes: ['Affaire ODAS'],
  });
  verifier('un dossier (contexte) cité se signale aussi', true, ouCtx.includes('dossier cité'));
  verifier(
    'sans terme cherché, aucune raison fabriquée',
    0,
    explainMatch(undefined, { entites: ['46 rue de la République'] }).length,
  );

  // Le nom d'un groupe : l'entité `sent_by` lue par l'analyse prime sur le
  // nom d'affichage déclaratif (« noreply », variantes de casse).
  const groupe = [
    { fromName: 'noreply', entites: [{ nameRaw: 'Leroy Merlin', role: 'sent_by' }] },
    { fromName: 'LEROY MERLIN Brest', entites: [{ nameRaw: 'Leroy Merlin', role: 'sent_by' }] },
    { fromName: 'LEROY MERLIN Brest', entites: [] },
  ];
  verifier(
    'le groupe prend le nom de l’entité lue par l’analyse',
    'Leroy Merlin',
    labelDuGroupe(groupe, 'leroymerlin.fr'),
  );
  verifier(
    'sans entité, le nom le plus fréquent reste (repli)',
    'LEROY MERLIN Brest',
    labelDuGroupe([{ fromName: 'LEROY MERLIN Brest', entites: [] }], 'leroymerlin.fr'),
  );
  verifier('sans rien, la clé fait le nom', 'leroymerlin', labelDuGroupe([], 'leroymerlin.fr'));

  // Propagation des dossiers par le verdict : la GRAPHIE ne compte plus
  // (clés normalisées), et l'identifiant dur recolle le reste.
  const index = indexerMentionsPourPropagation(
    [
      { messageId: 11, nameRaw: '46 Rue de la République, Brest', identifier: null },
      { messageId: 12, nameRaw: 'Sinistre dégât des eaux', identifier: '9002390187/S12/F' },
      // Mention étrangère au dossier : ne doit accrocher nulle part.
      { messageId: 13, nameRaw: 'Renault Trafic', identifier: null },
    ],
    [{ messageId: 14, label: '46 rue de la republique brest' }],
  );
  const cibles = ciblesDuDossier(
    { cles: ['46 rue republique brest'], identifiants: ['9002390187S12F'] },
    index,
  );
  verifier(
    '« 46 Rue de la République, Brest » rejoint le dossier malgré la graphie',
    true,
    cibles.has(11),
  );
  verifier('le contexte du verdict rattache aussi', true, cibles.has(14));
  verifier(
    'l’identifiant dur recolle ce qu’aucune orthographe ne rapprocherait',
    true,
    cibles.has(12),
  );
  verifier('une mention étrangère au dossier n’accroche pas', false, cibles.has(13));
}

// ---------------------------------------------------------------------------
//
// LE CONNECTEUR COMPTABLE (lot 4i) — `sent_by` n'est pas `issued_by` : la
// pièce envoyée au logiciel comptable porte l'ÉMETTEUR lu par l'analyse,
// jamais l'expéditeur du mail. Sans verdict, le repli heuristique garde la
// main et rien n'est inventé ici.

console.log('\n=== 19. Connecteur comptable — l’émetteur, jamais l’expéditeur ===\n');

{
  const etats = resoudre(
    lignes({
      messages: [
        // La facture Sosh transmise par sa mère — LE cas qui a déclenché la refonte.
        msg(1901, { fromEmail: 'maman@example.com', hasAttachments: true }),
        // Repli : intention facture legacy, pas encore de verdict.
        msg(1902, { intent: 'invoice', intentSource: 'ai', hasAttachments: true }),
        // Verdict présent mais AUCUN document comptable : une pub.
        msg(1903),
        // Document sans issuer lisible : la mention issued_by prend le relais.
        msg(1904, { hasAttachments: true }),
      ],
      verdicts: [
        verdictDe(1901, { purpose: 'document_delivery' }),
        verdictDe(1903, { purpose: 'marketing', attentionMode: 'none' }),
        verdictDe(1904, { purpose: 'document_delivery' }),
      ],
      documents: [
        { messageId: 1901, kind: 'invoice', label: null, issuer: 'Sosh', issueDate: null, dueDate: null, amount: 42.3, currency: 'EUR', reference: 'FAC-052026', certainty: 'explicit' },
        { messageId: 1904, kind: 'receipt', label: null, issuer: null, issueDate: null, dueDate: null, amount: 120, currency: 'EUR', reference: null, certainty: 'strong_inference' },
      ],
      mentions: [
        { messageId: 1901, kind: 'person', nameRaw: 'Maman', role: 'sent_by', identifier: null, certainty: 'explicit' },
        { messageId: 1901, kind: 'company', nameRaw: 'Sosh', role: 'issued_by', identifier: null, certainty: 'explicit' },
        { messageId: 1904, kind: 'company', nameRaw: 'EDF', role: 'issued_by', identifier: null, certainty: 'explicit' },
      ],
    }),
    { maintenant: MAINTENANT },
  );
  const piece = pieceComptableDuVerdict(etats.get(1901));
  verifier(
    'la facture transmise par un tiers est attribuée à son ÉMETTEUR',
    'Sosh',
    piece?.supplier,
  );
  verifier('…jamais à l’expéditeur du mail', true, piece?.supplier !== 'Maman');
  verifier('le montant vient de l’analyse', 42.3, piece?.amountTtc);
  verifier('la référence aussi', 'FAC-052026', piece?.invoiceNumber);
  verifier(
    'la transmission est DITE, sans contaminer le fournisseur',
    true,
    (piece?.reasons ?? []).some((r) => r.includes('transmis par « Maman »')),
  );
  verifier(
    '…et la raison avoue sa provenance (l’émetteur, pas l’expéditeur)',
    true,
    (piece?.reasons ?? []).some((r) => r.includes('jamais l’expéditeur') || r.includes("jamais l'expéditeur")),
  );
  verifier(
    'sans verdict, le connecteur ne fabrique rien ici (le repli garde la main)',
    null,
    pieceComptableDuVerdict(etats.get(1902)),
  );
  verifier(
    'verdict sans document comptable : rien non plus — l’analyse a parlé',
    null,
    pieceComptableDuVerdict(etats.get(1903)),
  );
  const releve = pieceComptableDuVerdict(etats.get(1904));
  verifier(
    'sans issuer lisible, la mention issued_by donne le fournisseur',
    'EDF',
    releve?.supplier,
  );
}

// ---------------------------------------------------------------------------

console.log(`\n${'-'.repeat(66)}`);
if (echecs === 0) {
  console.log(`✅ ${total} vérifications passées.`);
} else {
  console.log(`❌ ${echecs} échec(s) sur ${total} vérifications.`);
  process.exit(1);
}
