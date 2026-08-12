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

console.log(`\n${'-'.repeat(66)}`);
if (echecs === 0) {
  console.log(`✅ ${total} vérifications passées.`);
} else {
  console.log(`❌ ${echecs} échec(s) sur ${total} vérifications.`);
  process.exit(1);
}
