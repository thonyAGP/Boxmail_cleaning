import { db, ensureDbReady } from '../db/client.js';

/**
 * BROUILLONS DE RELANCE ET DE RÉPONSE.
 *
 * CE SERVICE N'ENVOIE RIEN : il RÉDIGE. Aucun import de `smtp.ts` ici.
 *
 * NUANCE APPRISE LE 18/08 : l'invariant est « rien ne part sans un clic
 * explicite d'Anthony », PAS « rien ne part ». Livré sans bouton d'envoi, le
 * brouillon était inutile — il devait le copier-coller dans sa messagerie
 * (« super le brouillon, je ne peux même pas l'envoyer… »). L'interface a donc
 * un bouton « ✉️ Envoyer » qui passe par la route d'envoi existante, après
 * confirmation nommant le destinataire et la boîte. Le geste reste le sien ;
 * ce service, lui, ne sait toujours pas envoyer.
 *
 * D'OÙ VIENT LA MATIÈRE. Anthony l'a formulé exactement : « j'ai déjà dû
 * envoyer des mails en ce sens, donc tu dois avoir l'email et les détails ».
 * C'est vrai : le destinataire, l'objet du fil, la date d'engagement et les
 * montants sont déjà en base. Le brouillon les rassemble — il ne les invente
 * pas. Tout ce qui est écrit ici est traçable à un mail ou à une saisie.
 *
 * LIMITE ASSUMÉE : les 6 246 mails ENVOYÉS n'ont ni extrait ni verdict (ils
 * n'ont jamais été lus par l'analyse). On dispose donc de leur objet et de
 * leur destinataire, pas de leur contenu. Le brouillon rappelle donc ce qui
 * est prouvé, sans prétendre citer ce qu'il a écrit.
 */

export interface Brouillon {
  to: string;
  toName: string | null;
  subject: string;
  body: string;
  accountSlug: string | null;
  /** Ce sur quoi le brouillon s'appuie — affiché pour qu'il puisse vérifier. */
  appuis: string[];
}

const dateFr = (d: Date | string | null | undefined): string =>
  d ? new Date(d).toLocaleDateString('fr-FR') : '';

const euros = (n: number | null | undefined): string =>
  n != null ? `${n.toFixed(2).replace('.', ',')} €` : '';

/**
 * Brouillon de RELANCE d'une affaire en cours. Structure : ce que j'ai engagé,
 * quand, ce que j'ai payé, ce que je constate, ce que je demande.
 */
export async function brouillonRelance(engagementId: number): Promise<Brouillon> {
  await ensureDbReady();
  const e = await db.engagement.findUnique({
    where: { id: engagementId },
    include: {
      messages: {
        include: {
          message: {
            select: {
              id: true, subject: true, date: true, fromEmail: true, fromName: true,
              toEmails: true, isOutbound: true, accountSlug: true,
            },
          },
        },
      },
    },
  });
  if (!e) throw new Error('Affaire introuvable.');

  const mails = e.messages.map((m) => m.message).sort(
    (a, b) => (a.date?.getTime() ?? 0) - (b.date?.getTime() ?? 0),
  );

  /**
   * ADRESSE À LAQUELLE ON NE PEUT PAS RÉPONDRE. Mesuré le 18/08 : le brouillon
   * URSSAF proposait d'écrire à `veuillez-ne-pas-repondre@urssaf.fr`. Le motif
   * doit couvrir les formes françaises composées, pas seulement `noreply`.
   */
  const SANS_REPONSE = /(no-?reply|donotreply|ne[-._]?pas[-._]?repondre|nepasrepondre|no[-._]?responder|notification[s]?@|mailer-daemon|postmaster)/i;
  const repliable = (adresse: string | null | undefined): boolean =>
    !!adresse && !SANS_REPONSE.test(adresse);

  // DESTINATAIRE : la saisie manuelle prime TOUJOURS — c'est le seul repère
  // qu'Anthony contrôle et qu'il peut corriger en un endroit. À défaut, le
  // dernier interlocuteur à qui l'on PEUT écrire. Jamais une adresse
  // no-reply : proposer d'y répondre serait un faux service.
  const entrants = mails.filter((m) => !m.isOutbound);
  const dernierEntrant = [...entrants].reverse().find((m) => repliable(m.fromEmail));
  const to = (repliable(e.contactEmail) ? e.contactEmail : null) ?? dernierEntrant?.fromEmail ?? '';
  const toName = e.contactName ?? dernierEntrant?.fromName ?? null;

  /**
   * OBJET : l'INTITULÉ DE L'AFFAIRE, point.
   *
   * J'ai essayé deux fois de le déduire du fil, et deux fois c'était faux :
   * d'abord le dernier message (« Relance — Invitation: LE BERRE et Romain |
   * Legalfree - mar. 20 janv. 2026 11:45 »), puis le plus ancien de fond
   * (« Relance — [LEGALFREE] Des informations sur ANTHONY LE BERRE sont
   * manquantes… »). Les fils administratifs sont faits de LEURS notifications,
   * pas du nom de l'affaire. Celui qui sait nommer le dossier, c'est lui —
   * et il l'a déjà fait en saisissant l'affaire.
   */
  const subject = `Relance — ${e.label}`;

  const appuis: string[] = [];
  const lignes: string[] = ['Bonjour,', ''];

  // Formulation neutre : `expected` est une phrase libre saisie par
  // l'utilisateur (« les parts inscrites au greffe »), on ne peut donc pas
  // accorder un participe derrière. On sépare en deux phrases.
  const quoi = e.expected?.trim() || e.label;
  lignes.push(`Je reviens vers vous au sujet de ${e.label}.`, '');
  if (e.openedAt) {
    lignes.push(`Cette démarche a été engagée le ${dateFr(e.openedAt)}.`);
    appuis.push(`date d'engagement : ${dateFr(e.openedAt)}`);
  }
  if (e.expected?.trim()) lignes.push(`Ce que j'attends : ${quoi}.`);
  lignes.push('');

  if (e.amountPaid != null) {
    lignes.push(`À ce jour, ${euros(e.amountPaid)} ont été réglés pour cette prestation.`);
    appuis.push(`montant déjà réglé : ${euros(e.amountPaid)}`);
    lignes.push('');
  }

  if (dernierEntrant?.date) {
    lignes.push(
      `Votre dernier message sur ce sujet date du ${dateFr(dernierEntrant.date)}` +
        `${dernierEntrant.subject ? ` (« ${dernierEntrant.subject.slice(0, 70)} »)` : ''}, ` +
        `et la procédure ne semble pas avoir abouti depuis.`,
    );
    appuis.push(`dernier message reçu : ${dateFr(dernierEntrant.date)}`);
    lignes.push('');
  }

  lignes.push(
    'Pourriez-vous me confirmer où en est le dossier, ce qui reste à fournir de mon côté, et sous quel délai il peut être finalisé ?',
    '',
    'Je vous remercie par avance.',
    '',
    'Cordialement,',
  );

  if (mails.length) appuis.push(`${mails.length} mail(s) rattachés à l'affaire`);

  return {
    to,
    toName,
    subject,
    body: lignes.join('\n'),
    // Compte d'envoi : celui saisi sur l'affaire, sinon celui des mails
    // rattachés. Sans lui, le bouton « Envoyer » ne saurait pas d'où partir.
    accountSlug: e.accountSlug ?? mails[mails.length - 1]?.accountSlug ?? null,
    appuis,
  };
}

/**
 * Brouillon de RÉPONSE à un mail qui en attend une. On s'appuie sur les faits
 * que l'analyse a extraits (action demandée, montant, échéance, référence) —
 * jamais sur une paraphrase inventée du message.
 */
export async function brouillonReponse(messageId: number): Promise<Brouillon> {
  await ensureDbReady();
  const m = await db.message.findUnique({
    where: { id: messageId },
    select: {
      id: true, subject: true, date: true, fromEmail: true, fromName: true,
      accountSlug: true, snippet: true,
      verdict: {
        select: {
          summary: true,
          actions: {
            select: { kind: true, actor: true, label: true, amount: true, dueAt: true, reference: true },
          },
        },
      },
    },
  });
  if (!m) throw new Error('Mail introuvable.');

  const appuis: string[] = [];
  const sujet = m.subject?.replace(/^((re|tr|fwd?)\s*:\s*)+/i, '').trim() ?? '(sans objet)';
  const lignes: string[] = [`Bonjour${m.fromName ? ` ${m.fromName.split(' ')[0]}` : ''},`, ''];

  // Les actions que l'analyse déclare à SA charge : c'est ce à quoi il répond.
  const siennes = (m.verdict?.actions ?? []).filter((a) => a.actor === 'user');
  if (siennes.length) {
    const a = siennes[0];
    appuis.push(`action analysée : ${a.kind}${a.label ? ` — ${a.label}` : ''}`);
    lignes.push(`Je fais suite à votre message du ${dateFr(m.date)} concernant ${a.label ?? sujet}.`, '');
    if (a.amount != null) {
      lignes.push(`Montant concerné : ${euros(a.amount)}${a.reference ? ` (réf. ${a.reference})` : ''}.`);
      appuis.push(`montant : ${euros(a.amount)}`);
      lignes.push('');
    }
    if (a.dueAt) {
      lignes.push(`J'ai bien noté l'échéance du ${dateFr(a.dueAt)}.`, '');
      appuis.push(`échéance : ${dateFr(a.dueAt)}`);
    }
  } else {
    lignes.push(`Je fais suite à votre message du ${dateFr(m.date)} concernant « ${sujet} ».`, '');
  }

  lignes.push(
    '[à compléter : ta réponse]',
    '',
    'Cordialement,',
  );

  if (m.verdict?.summary) appuis.push(`résumé d'analyse : ${m.verdict.summary.slice(0, 120)}`);

  return {
    to: m.fromEmail ?? '',
    toName: m.fromName,
    subject: `Re: ${sujet}`,
    body: lignes.join('\n'),
    accountSlug: m.accountSlug,
    appuis,
  };
}
