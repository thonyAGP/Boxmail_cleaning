import { db, ensureDbReady } from '../db/client.js';

/**
 * LES OBLIGATIONS (26/08) — moteur B, premier étage.
 *
 * Aucun appel IA ici : les actions typées existent DÉJÀ en base (21 982
 * verdicts, 5 822 actions dont l'acteur est l'utilisateur, 327 dont l'acteur
 * est un tiers), avec leur geste, leur acteur, leur échéance, leur montant et
 * leur citation. Elles n'étaient simplement lues par personne dès lors que
 * l'acteur n'était pas l'utilisateur : `getOpenActions()` (semantique.ts:1168)
 * filtre `acteur === 'user'`, et rien d'autre ne regardait `actor='sender'`.
 *
 * Ce service les relit toutes et leur donne un ÉTAT.
 *
 * NE JAMAIS FORCER open/closed (contre-revue du 26/08) : « l'erreur dangereuse
 * consiste à faire disparaître trop tôt une obligation ». D'où `probable` —
 * on a de bonnes raisons de croire que c'est fait, on ne l'affirme pas.
 *
 * LA SATISFACTION EST INCRÉMENTALE : « comme un système comptable, tu ne
 * recalcules pas tout le grand livre pour savoir si une facture vient d'être
 * réglée ; tu rapproches une nouvelle écriture d'une créance existante. » Ce
 * fichier ne fait donc que le NIVEAU 1 — le rapprochement déterministe. Les
 * niveaux 2 (plausible) et 3 (sémantique) viendront de l'audit ciblé.
 *
 * Faux positif mesuré le 26/08, et raison d'être du niveau 1 : « virement
 * programmé pour le 31/10/23 (13 200 TTC) » a été signalé comme promesse non
 * tenue depuis 1 031 jours. C'était une NOTIFICATION de virement, dans une
 * mission close normalement. Une promesse sans test de satisfaction produit de
 * fausses alarmes.
 */

export type EtatObligation =
  | 'ouverte'
  | 'probable'
  | 'satisfaite'
  | 'remplacee'
  | 'annulee'
  | 'inconnue';

export type Cote = 'moi' | 'eux';

export interface Obligation {
  actionId: number;
  messageId: number;
  threadId: number | null;
  accountSlug: string;
  /** Qui doit agir, vu de l'utilisateur. */
  cote: Cote;
  kind: string;
  label: string | null;
  strength: string | null;
  dueAt: Date | null;
  amount: number | null;
  currency: string | null;
  reference: string | null;
  certainty: string;
  evidence: string | null;
  /** Date du mail qui a créé l'obligation. */
  neeLe: Date;
  correspondant: string;
  sujet: string;
  etat: EtatObligation;
  /** Pourquoi cet état — affichable tel quel. */
  motif: string;
  enRetardDeJours: number | null;
}

/** Gestes dont la satisfaction se prouve par un mail SORTANT de l'utilisateur. */
const REPONDABLE = new Set(['reply', 'provide_document', 'sign', 'confirm', 'declare', 'book', 'call']);
/** Gestes dont la satisfaction se prouve par un mouvement d'argent. */
const PAYABLE = new Set(['pay']);

interface Ligne {
  id: number;
  messageId: number;
  kind: string;
  label: string | null;
  actor: string | null;
  strength: string | null;
  dueAt: number | null;
  expiresAt: number | null;
  amount: string | null;
  currency: string | null;
  reference: string | null;
  certainty: string | null;
  evidence: string | null;
  threadId: number | null;
  accountSlug: string;
  date: number;
  fromEmail: string | null;
  subject: string | null;
}

export interface OptionsObligations {
  /** 'moi' | 'eux' | undefined = les deux. */
  cote?: Cote;
  /** Ne garder que ce qui reste à faire. */
  ouvertesSeulement?: boolean;
  limite?: number;
}

/**
 * Toutes les obligations connues, avec leur état. Trois requêtes bornées, pas
 * une par obligation : les gros ensembles d'ids restent DANS SQLite (un
 * `id: { in: [...] }` de plus de 999 valeurs fait paniquer le moteur Prisma).
 */
export async function listerObligations(opts: OptionsObligations = {}): Promise<Obligation[]> {
  await ensureDbReady();
  const maintenant = Date.now();

  const lignes = await db.$queryRawUnsafe<Ligne[]>(
    `SELECT a.id, a.messageId, a.kind, a.label, a.actor, a.strength,
            a.dueAt, a.expiresAt, CAST(a.amount AS TEXT) amount, a.currency,
            a.reference, a.certainty, a.evidence,
            m.threadId, m.accountSlug, m.date, m.fromEmail, m.subject
       FROM VerdictAction a
       JOIN Message m ON m.id = a.messageId
       JOIN Folder f ON f.id = m.folderId
      WHERE m.isDeleted = 0 AND f.role NOT IN ('trash', 'spam')
      ORDER BY a.dueAt IS NULL, a.dueAt DESC`,
  );

  // Preuves de satisfaction, chargées EN BLOC pour les fils concernés.
  const fils = [...new Set(lignes.map((l) => l.threadId).filter((x): x is number => !!x))];
  const sorties = new Map<number, { date: number; pj: number }[]>();
  const entrees = new Map<number, number[]>();
  const recus = new Map<number, { montant: number; date: number }[]>();

  if (fils.length) {
    // SQLite tient très bien 10 000 ids dans un IN littéral ; c'est le
    // binder de Prisma qui plafonne. On passe donc par du SQL brut.
    const liste = fils.join(',');
    const msgs = await db.$queryRawUnsafe<
      { threadId: number; date: number; isOutbound: number; att: number }[]
    >(`SELECT threadId, date, isOutbound, COALESCE(attachmentCount, 0) att
         FROM Message WHERE threadId IN (${liste}) AND isDeleted = 0`);
    for (const m of msgs) {
      const t = Number(m.threadId);
      if (Number(m.isOutbound) === 1) {
        const arr = sorties.get(t) ?? [];
        arr.push({ date: Number(m.date), pj: Number(m.att) });
        sorties.set(t, arr);
      } else {
        const arr = entrees.get(t) ?? [];
        arr.push(Number(m.date));
        entrees.set(t, arr);
      }
    }
    const docs = await db.$queryRawUnsafe<
      { threadId: number; date: number; montant: string }[]
    >(`SELECT m.threadId, m.date, CAST(d.amount AS TEXT) montant
         FROM VerdictDocument d JOIN Message m ON m.id = d.messageId
        WHERE m.threadId IN (${liste}) AND d.kind = 'receipt' AND d.amount IS NOT NULL`);
    for (const d of docs) {
      const t = Number(d.threadId);
      const arr = recus.get(t) ?? [];
      arr.push({ montant: Number.parseFloat(d.montant || '0'), date: Number(d.date) });
      recus.set(t, arr);
    }
  }

  const out: Obligation[] = [];
  for (const l of lignes) {
    const cote: Cote = l.actor === 'user' ? 'moi' : 'eux';
    if (l.actor === 'unknown' || !l.actor) continue;
    if (opts.cote && opts.cote !== cote) continue;

    const nee = Number(l.date);
    const due = l.dueAt ? Number(l.dueAt) : null;
    const expire = l.expiresAt ? Number(l.expiresAt) : null;
    const montant = Number.parseFloat(l.amount || '0') || null;
    const t = l.threadId ? Number(l.threadId) : null;

    let etat: EtatObligation = 'ouverte';
    let motif = 'aucune preuve de réalisation trouvée';

    /**
     * L'ASYMÉTRIE DU SILENCE (mesurée le 26/08, et c'est la correction la plus
     * importante de ce fichier).
     *
     * Première version : 4 obligations « satisfaite » sur 6 258, et un haut de
     * classement rempli de factures de chantier de 2022-2023 présentées comme
     * impayées. Elles sont évidemment réglées — un maçon ne se tait pas deux
     * ans sur une facture ouverte.
     *
     * Le silence ne veut donc pas dire la même chose des deux côtés :
     *  · CE QUE JE DOIS — si le créancier ne relance plus depuis longtemps,
     *    c'est presque toujours qu'il a été payé. Le silence PROUVE.
     *  · CE QU'ILS ME DOIVENT — si le prestataire se tait, ce n'est pas fait.
     *    Le silence ACCUSE. C'est exactement le dossier Legalfree : quatorze
     *    mois de silence, rien au greffe.
     *
     * Sans cette distinction, on annonce 561 obligations en retard dont la
     * plupart sont réglées — soit le « 184 affaires nécessitent votre
     * attention » qui tue le produit.
     */
    const silenceJours = Math.round((maintenant - Number(l.date)) / 86_400_000);
    const dernierSigne = Math.max(
      ...(entrees.get(t ?? -1) ?? [0]),
      ...((sorties.get(t ?? -1) ?? []).map((s) => s.date)),
      nee,
    );
    const silenceDepuisDernierMouvement = Math.round((maintenant - dernierSigne) / 86_400_000);

    // 1. Périmée : agir n'a plus de sens (dueAt ≠ expiresAt — le cas Air France).
    if (expire && expire < maintenant) {
      etat = 'annulee';
      motif = "la date après laquelle agir n'a plus de sens est passée";
    } else if (cote === 'moi' && PAYABLE.has(l.kind) && montant && t) {
      // 2. Paiement : un reçu du même montant, après coup, dans le même fil.
      const ok = (recus.get(t) ?? []).find(
        (r) => r.date >= nee && Math.abs(r.montant - montant) < 0.02,
      );
      if (ok) {
        etat = 'satisfaite';
        motif = `un reçu de ${montant.toFixed(2)} € figure dans ce fil`;
      }
    } else if (cote === 'moi' && REPONDABLE.has(l.kind) && t) {
      // 3. Geste attendu de lui : a-t-il écrit après ? Avec une pièce jointe
      //    quand un document était demandé — c'est le niveau 1, on ne lit pas
      //    le contenu, donc on reste sur « probable ».
      const apres = (sorties.get(t) ?? []).filter((s) => s.date > nee);
      if (apres.length) {
        const besoinPJ = l.kind === 'provide_document' || l.kind === 'sign';
        const avecPJ = apres.some((s) => s.pj > 0);
        etat = 'probable';
        motif = besoinPJ && avecPJ
          ? 'tu as répondu avec une pièce jointe ensuite'
          : besoinPJ
            ? 'tu as répondu ensuite, mais sans pièce jointe'
            : 'tu as écrit dans ce fil après cette demande';
        if (besoinPJ && !avecPJ) etat = 'ouverte';
      }
    } else if (cote === 'eux' && t) {
      // 4. Promesse d'un tiers : ont-ils redonné signe de vie après l'échéance ?
      //    Sans échéance, on prend la naissance de l'obligation.
      const repere = due ?? nee;
      const apres = (entrees.get(t) ?? []).filter((d) => d > repere);
      if (apres.length) {
        etat = 'probable';
        motif = `ils ont réécrit ${apres.length} fois après cette promesse`;
      }
    }

    // Le silence, interprété selon le côté (cf. commentaire ci-dessus) — ET
    // selon la NATURE de ce qui est attendu.
    //
    // ⚠️ SPÉCIALISATION MESURÉE LE 26/08 (défaut n° 2 relevé par l'audit).
    // « Le créancier qui se tait a été payé » n'est vrai que d'une DEMANDE DE
    // PAIEMENT. Appliquée à une signature, un document ou une réponse
    // attendue, la règle produit un faux négatif dangereux : la convention
    // d'honoraires de son avocate dormait depuis 19 mois, personne ne l'avait
    // relancée, et ma règle en concluait que c'était fait — alors que son
    // action contre le maître d'œuvre n'avait tout simplement jamais démarré.
    //
    // Le demandeur d'une signature n'insiste pas comme un créancier : il
    // classe le dossier et attend. Son silence ne prouve donc rien.
    if (etat === 'ouverte') {
      if (cote === 'moi' && PAYABLE.has(l.kind) && silenceDepuisDernierMouvement > 180) {
        etat = 'probable';
        motif =
          `personne ne relance depuis ${Math.round(silenceDepuisDernierMouvement / 30)} mois` +
          ' — un créancier qui se tait aussi longtemps a généralement été payé';
      } else if (cote === 'moi' && silenceDepuisDernierMouvement > 180) {
        // Non monétaire : on NE conclut PAS. On le dit, c'est tout.
        motif =
          `sans mouvement depuis ${Math.round(silenceDepuisDernierMouvement / 30)} mois` +
          " — et rien ne prouve que ce soit fait : un document attendu ne se réclame pas comme une facture";
      } else if (cote === 'eux' && silenceDepuisDernierMouvement > 60) {
        // On ne change pas l'état — on le CONFIRME. Le silence d'un tiers qui
        // s'était engagé est précisément le signal recherché.
        motif =
          `aucun signe de vie depuis ${Math.round(silenceDepuisDernierMouvement / 30)} mois` +
          " alors qu'ils s'étaient engagés";
      }
    }
    void silenceJours;

    const enRetard = due && due < maintenant && etat !== 'satisfaite' && etat !== 'annulee'
      ? Math.round((maintenant - due) / 86_400_000)
      : null;

    if (opts.ouvertesSeulement && (etat === 'satisfaite' || etat === 'annulee')) continue;

    out.push({
      actionId: Number(l.id),
      messageId: Number(l.messageId),
      threadId: t,
      accountSlug: l.accountSlug,
      cote,
      kind: l.kind,
      label: l.label,
      strength: l.strength,
      dueAt: due ? new Date(due) : null,
      amount: montant,
      currency: l.currency,
      reference: l.reference,
      certainty: l.certainty || 'unknown',
      evidence: l.evidence,
      neeLe: new Date(nee),
      correspondant: l.fromEmail || '',
      sujet: l.subject || '(sans sujet)',
      etat,
      motif,
      enRetardDeJours: enRetard,
    });
  }

  // Le plus criant d'abord : en retard, puis par ancienneté de l'échéance.
  out.sort((a, b) => (b.enRetardDeJours ?? -1) - (a.enRetardDeJours ?? -1));
  return opts.limite ? out.slice(0, opts.limite) : out;
}

export interface BilanObligations {
  total: number;
  parCote: Record<Cote, number>;
  parEtat: Record<string, number>;
  ouvertesEnRetard: number;
  /** Promesses de tiers en retard et sans signe de vie : le cœur du sujet. */
  promessesNonTenues: number;
}

export function bilan(obligations: Obligation[]): BilanObligations {
  const b: BilanObligations = {
    total: obligations.length,
    parCote: { moi: 0, eux: 0 },
    parEtat: {},
    ouvertesEnRetard: 0,
    promessesNonTenues: 0,
  };
  for (const o of obligations) {
    b.parCote[o.cote]++;
    b.parEtat[o.etat] = (b.parEtat[o.etat] ?? 0) + 1;
    if (o.etat === 'ouverte' && o.enRetardDeJours) b.ouvertesEnRetard++;
    if (o.cote === 'eux' && o.etat === 'ouverte' && o.enRetardDeJours) b.promessesNonTenues++;
  }
  return b;
}
