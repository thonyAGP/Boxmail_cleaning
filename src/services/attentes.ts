import { db, ensureDbReady } from '../db/client.js';
import { recordOperation } from './oplog.js';

/**
 * LE SUIVI DES ATTENTES (26/08) — ce que l'écran montre.
 *
 * Trois règles de présentation, toutes issues de la contre-revue et des 50
 * histoires auditées :
 *
 * 1. LE PLAFOND NE S'APPLIQUE JAMAIS À L'URGENT. « 184 affaires nécessitent
 *    votre attention » tue le produit — d'où un budget de 3 à 7 nouveautés
 *    ordinaires par jour. Mais « le plafond protège l'attention, jamais
 *    l'utilisateur contre une information critique » : une prescription qui
 *    court ou un dernier avis avant poursuites passe HORS QUOTA, même s'il y
 *    en a onze.
 *
 * 2. IMPORTANCE ET URGENCE SONT DEUX AXES, jamais un score unique. Un acte
 *    notarié jamais reçu depuis 2023 : important, pas urgent. Une mise en
 *    demeure à J-3 : les deux.
 *
 * 3. LE SCORE MÉCANIQUE NE DÉCIDE PAS DE L'AFFICHAGE. Mesuré : 30 % de vrais
 *    positifs — excellent pour choisir QUOI EXAMINER, désastreux si on
 *    l'affiche tel quel. Ce qui arrive ici a été audité (source='audit').
 */

export type Cote = 'moi' | 'eux';
export type Urgence = 'critique' | 'haute' | 'moyenne' | 'faible';
export type Importance = 'haute' | 'moyenne' | 'faible';
export type EtatAttente = 'ouverte' | 'probable' | 'satisfaite' | 'ecartee';

const RANG_URGENCE: Record<string, number> = { critique: 0, haute: 1, moyenne: 2, faible: 3 };
const RANG_IMPORTANCE: Record<string, number> = { haute: 0, moyenne: 1, faible: 2 };

/** Budget d'attention pour l'ORDINAIRE. L'urgent n'est pas concerné. */
const BUDGET_ORDINAIRE = 7;

export interface AttenteVue {
  id: number;
  cote: Cote;
  quoi: string;
  qui: string;
  quiEmail: string | null;
  accountSlug: string;
  threadId: number | null;
  messageId: number | null;
  importance: string;
  urgence: string;
  etat: string;
  pourquoi: string;
  risque: string | null;
  dueAt: string | null;
  /** Jours restants (négatif = dépassé), null si pas de date. */
  dansJours: number | null;
  montant: number | null;
  devise: string | null;
  /** Les gestes proposés, DÉDUITS de l'état — pas trois boutons partout. */
  actions: ActionProposee[];
}

export interface ActionProposee {
  code: 'voir' | 'relancer' | 'repondre' | 'ouvrir-document' | 'contester' | 'regle' | 'ecarter';
  libelle: string;
  /** true = action principale de la carte. */
  principale?: boolean;
}

export interface Suivi {
  /** Hors quota : ce qui coûte un droit ou une pénalité si on attend. */
  urgences: AttenteVue[];
  /** Ce que l'utilisateur doit faire. */
  aToi: AttenteVue[];
  /** Ce qu'il attend des autres. */
  tuAttends: AttenteVue[];
  /** Le stock ancien, en retrait. */
  retrouve: AttenteVue[];
  compteurs: { urgences: number; aToi: number; tuAttends: number; retrouve: number; total: number };
  /** Combien ont été masquées par le budget d'attention (jamais des urgences). */
  enReserve: number;
}

/**
 * Les actions dépendent de ce qui est attendu, et de qui l'attend.
 * « Le système sait déjà ce qu'il attend. Les actions proposées doivent
 * découler de cet état. »
 */
function actionsDe(a: { cote: string; quoi: string; montant: number | null }): ActionProposee[] {
  const out: ActionProposee[] = [{ code: 'voir', libelle: "Voir l'histoire" }];
  const q = (a.quoi || '').toLowerCase();

  if (a.cote === 'eux') {
    out.unshift({ code: 'relancer', libelle: 'Préparer une relance', principale: true });
  } else if (/sign|convention|contrat|mandat/.test(q)) {
    out.unshift({ code: 'ouvrir-document', libelle: 'Ouvrir le document', principale: true });
  } else if (a.montant && /contest|erreur|trop|indu/.test(q)) {
    out.unshift({ code: 'contester', libelle: 'Préparer une contestation', principale: true });
  } else {
    out.unshift({ code: 'repondre', libelle: 'Préparer une réponse', principale: true });
  }

  // Les deux gestes d'effacement restent en retrait : ils sont FACULTATIFS.
  // Le système doit fonctionner si l'utilisateur n'y touche jamais.
  out.push({ code: 'regle', libelle: "C'est réglé" }, { code: 'ecarter', libelle: 'Sans suite' });
  return out;
}

function vue(a: Record<string, unknown>): AttenteVue {
  const due = a.dueAt ? new Date(a.dueAt as string) : null;
  const montant = a.montant == null ? null : Number(a.montant);
  return {
    id: Number(a.id),
    cote: a.cote as Cote,
    quoi: String(a.quoi),
    qui: String(a.qui),
    quiEmail: (a.quiEmail as string) ?? null,
    accountSlug: String(a.accountSlug),
    threadId: a.threadId == null ? null : Number(a.threadId),
    messageId: a.messageId == null ? null : Number(a.messageId),
    importance: String(a.importance),
    urgence: String(a.urgence),
    etat: String(a.etat),
    pourquoi: String(a.pourquoi),
    risque: (a.risque as string) ?? null,
    dueAt: due ? due.toISOString() : null,
    dansJours: due ? Math.round((due.getTime() - Date.now()) / 86_400_000) : null,
    montant,
    devise: (a.devise as string) ?? null,
    actions: actionsDe({ cote: String(a.cote), quoi: String(a.quoi), montant }),
  };
}

const trier = (a: AttenteVue, b: AttenteVue): number =>
  RANG_URGENCE[a.urgence] - RANG_URGENCE[b.urgence] ||
  RANG_IMPORTANCE[a.importance] - RANG_IMPORTANCE[b.importance] ||
  (a.dansJours ?? 9999) - (b.dansJours ?? 9999);

export async function suivi(): Promise<Suivi> {
  await ensureDbReady();
  const brut = await db.attente.findMany({
    where: { etat: { in: ['ouverte', 'probable'] } },
    orderBy: { id: 'asc' },
  });
  const toutes = brut.map((a) => vue(a as unknown as Record<string, unknown>));

  // 1. L'urgent, hors quota et sans distinction de côté.
  const urgences = toutes.filter((a) => a.urgence === 'critique' || !!a.risque).sort(trier);
  const reste = toutes.filter((a) => !urgences.includes(a));

  // 2. Le reste, séparé par côté puis borné par le budget d'attention.
  //    « Retrouvé » = ce qui dort depuis plus de six mois : c'est du stock,
  //    il recule à l'arrière-plan à mesure que le flux prend la place.
  //
  //    ⚠️ Une attente SANS DATE n'est pas vieille : elle est sans date. La
  //    première version écrivait `(a.dansJours ?? -9999) < -180`, ce qui
  //    envoyait au stock tout ce qui n'avait pas d'échéance — mesuré à
  //    l'écran : « à toi 0, tu attends 0 », les deux sections du milieu vides
  //    alors qu'elles portent l'essentiel du quotidien.
  const vieux = (a: AttenteVue) => a.dansJours !== null && a.dansJours < -180;
  const recent = reste.filter((a) => !vieux(a)).sort(trier);
  const ancien = reste.filter(vieux).sort(trier);

  const aToi = recent.filter((a) => a.cote === 'moi');
  const tuAttends = recent.filter((a) => a.cote === 'eux');

  const budgetToi = Math.ceil(BUDGET_ORDINAIRE / 2);
  const enReserve =
    Math.max(0, aToi.length - budgetToi) + Math.max(0, tuAttends.length - (BUDGET_ORDINAIRE - budgetToi));

  return {
    urgences,
    aToi: aToi.slice(0, budgetToi),
    tuAttends: tuAttends.slice(0, BUDGET_ORDINAIRE - budgetToi),
    retrouve: ancien.slice(0, 10),
    compteurs: {
      urgences: urgences.length,
      aToi: aToi.length,
      tuAttends: tuAttends.length,
      retrouve: ancien.length,
      total: toutes.length,
    },
    enReserve,
  };
}

export type Geste = 'regle' | 'ecarter' | 'rouvrir';

/**
 * Le geste de l'utilisateur est une PREUVE, pas un ordre administratif : il
 * n'efface rien, il ajoute une information que le système ne pouvait pas
 * observer (un paiement par téléphone, une signature sur place). D'où
 * `assertionAt` conservé — c'est lui qui permettra de dire plus tard « tu
 * avais indiqué que c'était réglé, mais ils viennent de relancer ».
 */
export async function marquer(id: number, geste: Geste): Promise<void> {
  await ensureDbReady();
  const etat = geste === 'regle' ? 'satisfaite' : geste === 'ecarter' ? 'ecartee' : 'ouverte';
  const a = await db.attente.update({
    where: { id },
    data: {
      etat,
      assertionAt: geste === 'rouvrir' ? null : new Date(),
    },
  });
  await recordOperation({
    tool: `attente.${geste}`,
    account: a.accountSlug,
    params: { id: a.id, quoi: a.quoi.slice(0, 120), qui: a.qui, etat },
    result: etat,
  });
}
