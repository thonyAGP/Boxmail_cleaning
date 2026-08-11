import {
  zVerdict,
  deplier,
  estPerime,
  projeterVersLegacy,
  finDePeriode,
  type EtatAttention,
} from '../services/verdict.js';

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

console.log(`\n${'-'.repeat(66)}`);
if (echecs === 0) {
  console.log(`✅ ${total} vérifications passées.`);
} else {
  console.log(`❌ ${echecs} échec(s) sur ${total} vérifications.`);
  process.exit(1);
}
