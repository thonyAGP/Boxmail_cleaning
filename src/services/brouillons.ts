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
  /**
   * À qui écrire, quand ce n'est pas évident. Proposé plutôt que deviné :
   * une adresse choisie au hasard serait pire qu'un champ vide.
   */
  candidats?: Destinataire[];
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

/**
 * Brouillon depuis une ATTENTE (26/08). C'est le bouton que la contre-revue a
 * jugé le plus important de l'écran : « sans passage immédiat de la détection
 * à l'action, tu risques de fabriquer un très bon tableau de culpabilité »
 * — l'utilisateur apprend qu'il a oublié ceci, et cela, puis il referme
 * l'application. Le brouillon transforme « je t'informe d'un problème » en
 * « je t'ai préparé la prochaine étape ».
 *
 * Deux formes selon le côté, et c'est tout le sens de l'objet Attente :
 *  · EUX doivent quelque chose  → une relance (« où en est-on ? ») ;
 *  · MOI dois quelque chose     → une prise de contact (« voici où j'en suis »).
 *
 * Comme partout ici : ce service RÉDIGE, il n'envoie rien.
 */
/** Un destinataire plausible, avec de quoi choisir en connaissance de cause. */
export interface Destinataire {
  email: string;
  nom: string | null;
  /** fil = il a écrit dans cette conversation · nom = il porte le nom du correspondant. */
  origine: 'fil' | 'nom';
  messages: number;
  dernier: string | null;
  /** A-t-il déjà eu un échange réel (un sortant, une réponse) ? */
  dejaEchange: boolean;
}

/** Les mots qui identifient un correspondant : ≥ 4 lettres, sans civilité. */
function motsDuNom(qui: string): string[] {
  const CIVILITES = new Set(['maitre', 'madame', 'monsieur', 'cabinet', 'service', 'agence']);
  return [
    ...new Set(
      (qui || '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((m) => m.length >= 4 && !CIVILITES.has(m)),
    ),
  ].slice(0, 4);
}

/**
 * À QUI écrire — la question que le brouillon ne savait pas résoudre.
 *
 * Son retour, écran en main le 26/08 : « à quoi bon sans avoir le
 * destinataire ». Le champ arrivait vide dès que l'attente n'était rattachée à
 * aucun fil — le cas de toutes celles nées de l'audit. Deviner une adresse
 * unique serait pire : on proposerait la mauvaise sans le dire. On PRÉSENTE
 * donc les candidats, avec ce qui permet de trancher (combien d'échanges,
 * quand, et si la conversation a déjà eu lieu dans les deux sens).
 *
 * Deux sources, dans cet ordre : les correspondants DU FIL quand il y en a un,
 * puis ceux dont le nom recoupe celui du correspondant attendu — c'est ainsi
 * qu'on retrouve le comptable d'une attente qui ne porte que « Comptastar ».
 */
export async function destinatairesPossibles(attenteId: number): Promise<Destinataire[]> {
  await ensureDbReady();
  const a = await db.attente.findUnique({ where: { id: attenteId } });
  if (!a) return [];

  const SANS_REPONSE =
    /(no-?reply|donotreply|ne[-._]?pas[-._]?repondre|nepasrepondre|no[-._]?responder|notification[s]?@|mailer-daemon|postmaster)/i;
  const vus = new Map<string, Destinataire>();
  const ajouter = (d: Destinataire) => {
    const cle = d.email.toLowerCase();
    if (!cle || SANS_REPONSE.test(cle)) return;
    const deja = vus.get(cle);
    // Le fil prime sur le nom, et on garde le libellé le plus informatif.
    if (deja && !(d.origine === 'fil' && deja.origine === 'nom')) return;
    vus.set(cle, { ...d, nom: d.nom ?? deja?.nom ?? null });
  };

  // 1. Ceux qui ont écrit dans cette conversation.
  if (a.threadId) {
    for (const m of await db.message.findMany({
      where: { threadId: a.threadId, isOutbound: false, isDeleted: false },
      orderBy: { date: 'desc' },
      take: 40,
      select: { fromEmail: true, fromName: true, date: true },
    })) {
      if (!m.fromEmail) continue;
      ajouter({
        email: m.fromEmail,
        nom: m.fromName,
        origine: 'fil',
        messages: 0,
        dernier: m.date ? m.date.toISOString().slice(0, 10) : null,
        dejaEchange: false,
      });
    }
  }

  // 2. Ceux dont le nom recoupe celui du correspondant attendu.
  const mots = motsDuNom(a.qui);
  if (mots.length) {
    const senders = await db.sender.findMany({
      where: {
        accountSlug: a.accountSlug,
        OR: mots.flatMap((m) => [
          { displayName: { contains: m } },
          { email: { contains: m } },
        ]),
      },
      orderBy: { messageCount: 'desc' },
      take: 25,
      select: {
        email: true,
        displayName: true,
        messageCount: true,
        lastMessageAt: true,
        engagedAt: true,
      },
    });
    for (const s of senders) {
      ajouter({
        email: s.email,
        nom: s.displayName,
        origine: 'nom',
        messages: s.messageCount,
        dernier: s.lastMessageAt ? s.lastMessageAt.toISOString().slice(0, 10) : null,
        dejaEchange: !!s.engagedAt,
      });
    }
  }

  // Complète le volume des adresses trouvées par le fil : sans ça, un
  // correspondant de longue date apparaîtrait avec « 0 message ».
  const sansVolume = [...vus.values()].filter((d) => d.messages === 0);
  if (sansVolume.length) {
    for (const s of await db.sender.findMany({
      where: { accountSlug: a.accountSlug, email: { in: sansVolume.map((d) => d.email) } },
      select: { email: true, messageCount: true, lastMessageAt: true, engagedAt: true },
    })) {
      const d = vus.get(s.email.toLowerCase());
      if (!d) continue;
      d.messages = s.messageCount;
      d.dejaEchange = !!s.engagedAt;
      d.dernier = d.dernier ?? (s.lastMessageAt ? s.lastMessageAt.toISOString().slice(0, 10) : null);
    }
  }

  return [...vus.values()]
    .sort((x, y) => {
      if (x.origine !== y.origine) return x.origine === 'fil' ? -1 : 1;
      if (x.dejaEchange !== y.dejaEchange) return x.dejaEchange ? -1 : 1;
      return y.messages - x.messages;
    })
    .slice(0, 8);
}

export async function brouillonAttente(attenteId: number): Promise<Brouillon> {
  await ensureDbReady();
  const a = await db.attente.findUnique({ where: { id: attenteId } });
  if (!a) throw new Error('Attente introuvable.');

  const SANS_REPONSE =
    /(no-?reply|donotreply|ne[-._]?pas[-._]?repondre|nepasrepondre|no[-._]?responder|notification[s]?@|mailer-daemon|postmaster)/i;
  const repliable = (x: string | null | undefined): boolean => !!x && !SANS_REPONSE.test(x);

  // DESTINATAIRE : l'adresse portée par l'attente si on peut y écrire, sinon
  // le dernier correspondant RÉPONDABLE du fil. Une attente peut naître d'une
  // notification automatique ; proposer d'y répondre serait un faux service.
  let to = repliable(a.quiEmail) ? (a.quiEmail as string) : '';
  let toName: string | null = a.qui;
  if (!to && a.threadId) {
    const entrants = await db.message.findMany({
      where: { threadId: a.threadId, isOutbound: false, isDeleted: false },
      orderBy: { date: 'desc' },
      take: 12,
      select: { fromEmail: true, fromName: true },
    });
    const bon = entrants.find((m) => repliable(m.fromEmail));
    if (bon) {
      to = bon.fromEmail ?? '';
      toName = bon.fromName ?? a.qui;
    }
  }

  /**
   * QUAND LE FIL N'EST QU'UN TRANSFERT. Mesuré le 26/08 : l'attente
   * « Régler 418 € à l'URSSAF » proposait d'écrire à sa MÈRE — elle lui avait
   * transféré la mise en demeure, elle était donc le dernier entrant du fil.
   * Si un correspondant porte le nom du dossier (« urssaf »), il l'emporte
   * sur celui du fil ; sinon on garde le comportement d'origine.
   */
  const candidats = await destinatairesPossibles(attenteId);
  const clesDuNom = motsDuNom(a.qui);
  const porteLeNom = (c: Destinataire): boolean =>
    clesDuNom.some(
      (m) => c.email.toLowerCase().includes(m) || (c.nom ?? '').toLowerCase().includes(m),
    );
  if (!to || !porteLeNom({ email: to, nom: toName } as Destinataire)) {
    const mieux = candidats.find(porteLeNom);
    if (mieux) {
      to = mieux.email;
      // Le nom SUIT l'adresse, sans repli sur l'ancien : garder « Mylène LE
      // BERRE » en changeant pour dcl.bretagne@urssaf.fr produisait un mail
      // qui saluait sa mère et partait à l'URSSAF.
      toName = mieux.nom ?? null;
    }
  }

  const appuis: string[] = [];

  /**
   * ⚠️ NE JAMAIS RECOPIER `pourquoi` DANS LE CORPS. Ce champ est une
   * explication ADRESSÉE À L'UTILISATEUR, écrite à la deuxième personne :
   * « Tu as contesté le solde de tout compte le 25 avril 2024… ». Recopié
   * tel quel, il produisait un mail tutoyant l'assureur.
   *
   * MAIS LE JETER ÉTAIT PIRE (mesuré à l'écran le 26/08). Son retour, devant
   * un brouillon adressé à sa comptable : « manque clairement de contexte —
   * qui me l'a envoyé, à quel sujet, à quelle date […] pas juste coucou, je
   * reviens après ton dernier mail d'un an, on en est où ». Tout ce qui
   * manquait au corps était sous ses yeux dans « Sur quoi ce brouillon
   * s'appuie ». La bonne réponse n'est donc pas de recopier `pourquoi`,
   * c'est d'aller chercher les MÊMES FAITS à la source — le dernier message
   * du fil, daté et signé — et de les écrire à la troisième personne.
   */
  appuis.push(`constat : ${a.pourquoi.slice(0, 140)}`);

  // LE DERNIER MOUVEMENT DU FIL : qui a parlé, quand, de quoi. C'est ce qui
  // transforme « Je fais suite à » en « vous m'avez adressé le 16 octobre ».
  let dernierEntrant: { date: Date | null; fromName: string | null; subject: string | null } | null =
    null;
  let dernierSortant: { date: Date | null } | null = null;
  if (a.threadId) {
    dernierEntrant = await db.message.findFirst({
      where: { threadId: a.threadId, isOutbound: false, isDeleted: false },
      orderBy: { date: 'desc' },
      select: { date: true, fromName: true, subject: true },
    });
    dernierSortant = await db.message.findFirst({
      where: { threadId: a.threadId, isOutbound: true, isDeleted: false },
      orderBy: { date: 'desc' },
      select: { date: true },
    });
  }

  const moisDepuis = (d: Date | null | undefined): number | null =>
    d ? Math.floor((Date.now() - new Date(d).getTime()) / (1000 * 60 * 60 * 24 * 30.44)) : null;

  /** « trois mois », « près d'un an »… — pour l'écrire comme on le dirait. */
  const dureeEnClair = (mois: number): string => {
    if (mois >= 22) return `près de ${Math.round(mois / 12)} ans`;
    if (mois >= 11) return "près d'un an";
    if (mois >= 2) return `${mois} mois`;
    return 'plusieurs semaines';
  };

  const nettoyerObjet = (t: string | null): string =>
    t ? ` (« ${t.replace(/^((re|tr|fwd?)\s*:\s*)+/i, '').slice(0, 70)} »)` : '';

  /**
   * SALUTATION NOMMÉE quand on parle à QUELQU'UN. « Bonjour, » à un
   * interlocuteur connu depuis des années sonne comme un publipostage — mais
   * « Bonjour Insured — service juridique, » ou « Bonjour Comptastar, » sonne
   * pire encore (mesuré le 26/08). On ne nomme donc que ce qui ressemble à
   * une personne : deux ou trois mots, sans tiret de libellé, sans forme
   * juridique, sans mot de service.
   */
  const SOCIETE =
    /\b(sarl|sasu?|sci|scp|eurl|selarl|sa|sas|service|agence|cabinet|assurances?|banque|groupe|societe|société|direction|support|contact|comptabilit)/i;
  // PAS DE REPLI sur le nom du fil : `toName` suit déjà le destinataire
  // retenu. Le repli faisait saluer « Mylène LE BERRE » un mail adressé à
  // dcl.bretagne@urssaf.fr, parce qu'elle était le dernier entrant du fil.
  const civil = (toName || '').trim();
  const nu = civil.split(/[<(]/)[0].replace(/["']/g, '').trim();
  const motsCivil = nu.split(/\s+/).filter(Boolean);
  // DEUX MOTS AU MOINS — un prénom et un nom. Un mot seul est presque
  // toujours une raison sociale : « Bonjour Comptastar, » est passé à travers
  // le filtre des formes juridiques, parce qu'aucune liste ne contiendra
  // jamais le nom de son cabinet comptable.
  const personne =
    !!nu &&
    !nu.includes('@') &&
    !/[—–|,/]/.test(nu) &&
    motsCivil.length >= 2 &&
    motsCivil.length <= 3 &&
    !SOCIETE.test(nu);
  const lignes: string[] = [personne ? `Bonjour ${nu},` : 'Bonjour,', ''];

  if (a.cote === 'eux') {
    lignes.push(`Je reviens vers vous au sujet de : ${a.quoi}.`, '');

    // CE QUI S'EST PASSÉ, DATÉ. Un rappel vérifiable vaut mieux qu'un reproche.
    if (dernierEntrant?.date) {
      lignes.push(
        `Votre dernier message sur ce point date du ${dateFr(dernierEntrant.date)}${nettoyerObjet(dernierEntrant.subject)}.`,
      );
      appuis.push(`dernier message reçu : ${dateFr(dernierEntrant.date)}`);
    }
    if (dernierSortant?.date) {
      lignes.push(`Je vous avais écrit le ${dateFr(dernierSortant.date)}.`);
      appuis.push(`mon dernier envoi : ${dateFr(dernierSortant.date)}`);
    }
    if (dernierEntrant?.date || dernierSortant?.date) lignes.push('');

    if (a.dueAt) {
      lignes.push(
        `Sauf erreur de ma part, le délai annoncé était le ${dateFr(a.dueAt)} et je n'ai pas eu de retour depuis.`,
        '',
      );
      appuis.push(`échéance annoncée : ${dateFr(a.dueAt)}`);
    } else {
      const m = moisDepuis(dernierEntrant?.date ?? dernierSortant?.date ?? null);
      lignes.push(
        m != null && m >= 2
          ? `Sauf erreur de ma part, je n'ai pas eu de retour depuis, soit ${dureeEnClair(m)}.`
          : "Sauf erreur de ma part, je n'ai pas eu de retour sur ce point.",
        '',
      );
    }
    if (a.montant != null) {
      lignes.push(`Montant concerné : ${euros(a.montant)}.`, '');
      appuis.push(`montant : ${euros(a.montant)}`);
    }
    lignes.push(
      'Pourriez-vous me dire où en est ce point, ce qui reste éventuellement à fournir de mon côté, et sous quel délai il peut aboutir ?',
    );
  } else {
    // C'EST À LUI D'AGIR — donc c'est LUI qui est en retard. Le rappel du
    // contexte se double d'une EXCUSE quand le délai la rend nécessaire.
    if (dernierEntrant?.date) {
      lignes.push(
        `Je reviens vers vous au sujet de votre message du ${dateFr(dernierEntrant.date)}${nettoyerObjet(dernierEntrant.subject)} : ${a.quoi}`,
        '',
      );
      appuis.push(`message reçu le ${dateFr(dernierEntrant.date)}`);
    } else {
      lignes.push(`Je reviens vers vous au sujet de : ${a.quoi}`, '');
    }

    const m = moisDepuis(dernierEntrant?.date ?? null);
    if (m != null && m >= 3) {
      lignes.push(
        `Je vous prie de m'excuser pour ce délai de réponse — ${dureeEnClair(m)} se sont écoulés depuis votre message.`,
        '',
      );
      appuis.push(`ton délai de réponse : ${dureeEnClair(m)}`);
    }

    if (a.dueAt) appuis.push(`échéance : ${dateFr(a.dueAt)}`);
    if (a.montant != null) {
      lignes.push(`Montant concerné : ${euros(a.montant)}.`, '');
      appuis.push(`montant : ${euros(a.montant)}`);
    }
    lignes.push('[à compléter : ta réponse]', '');
  }

  lignes.push('', 'Je vous remercie par avance.', '', 'Cordialement,');

  return {
    to,
    toName,
    subject: a.cote === 'eux' ? `Relance — ${a.quoi}` : a.quoi,
    body: lignes.join('\n'),
    accountSlug: a.accountSlug,
    appuis,
    // Toujours proposés, même quand une adresse a été trouvée : le fil peut
    // compter plusieurs interlocuteurs, et c'est lui qui sait auquel écrire.
    // Cas mesuré le 26/08 : l'attente URSSAF pointait vers sa MÈRE, qui lui
    // avait transféré la mise en demeure — une adresse trouvée n'est pas une
    // adresse juste.
    candidats,
  };
}
