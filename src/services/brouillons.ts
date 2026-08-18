import { db, ensureDbReady } from '../db/client.js';

/**
 * BROUILLONS DE RELANCE ET DE RÉPONSE.
 *
 * CE QUE CE SERVICE NE FAIT PAS, ET NE FERA JAMAIS : envoyer. Il produit un
 * texte que l'utilisateur lit, corrige, puis envoie lui-même. Aucun import de
 * `smtp.ts` ici — c'est un invariant du chantier, pas une prudence passagère.
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
  const dernierEntrant = [...mails].reverse().find((m) => !m.isOutbound);
  const dernier = mails[mails.length - 1];

  // Destinataire : la saisie manuelle prime, sinon le dernier interlocuteur
  // humain connu du fil. On ne devine pas au-delà.
  const to = e.contactEmail ?? dernierEntrant?.fromEmail ?? '';
  const toName = e.contactName ?? dernierEntrant?.fromName ?? null;

  // Objet : reprendre CELUI DU FIL fait remonter la relance dans sa
  // messagerie à lui comme dans celle du destinataire.
  const sujetFil = dernier?.subject?.replace(/^((re|tr|fwd?)\s*:\s*)+/i, '').trim();
  const subject = sujetFil ? `Relance — ${sujetFil}` : `Relance — ${e.label}`;

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

  return { to, toName, subject, body: lignes.join('\n'), accountSlug: e.accountSlug ?? dernier?.accountSlug ?? null, appuis };
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
