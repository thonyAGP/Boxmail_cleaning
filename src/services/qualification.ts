import { db, ensureDbReady } from '../db/client.js';
import { detecterAnomalies, phraseDe, type Anomalie } from './anomalies.js';

/**
 * LA BOUCLE : détecteur mécanique → qualification par l'IA → attentes.
 *
 * POURQUOI CE FICHIER EXISTE. Le détecteur (anomalies.ts) trouve 305 fils qui
 * sentent le roussi, en SQL, sans IA et sans rien coûter. Mais il ne sait pas
 * lire : il voit « échéance dépassée depuis 982 jours », pas « cette facture a
 * été réglée par virement le mois suivant, le fil n'a simplement jamais été
 * clos ». Seule la lecture tranche.
 *
 * Les 14 premières attentes ont été établies à la main le 26/08 — un modèle a
 * relu 50 histoires hors du serveur. C'était juste, mais figé : rien ne les
 * régénère. Ce fichier automatise exactement ce geste-là.
 *
 * L'ARCHITECTURE EST CELLE, ÉPROUVÉE, DU RATTRAPAGE D'ANALYSE : un vivier
 * servi par lots (`prochainsDossiers`), un agent qui juge sur le forfait de
 * l'utilisateur, des verdicts renvoyés (`enregistrerQualifications`). Aucune
 * clé API côté serveur — décision du 10/07, toujours valable.
 *
 * DEUX CONTRAINTES DE VOLUME, PAYÉES CHER SUR LE RATTRAGE D'ANALYSE :
 *  - une conversation ne tient pas plus d'une soixantaine d'éléments (elle
 *    CUMULE les lots et meurt) : lots courts, contexte neuf entre les vagues ;
 *  - un dossier compact doit rester compact. Un fil de 40 messages n'est pas
 *    envoyé en entier : on garde le DÉBUT (d'où vient l'histoire) et la FIN
 *    (où elle en est), et on annonce ce qui manque.
 */

/** Un message tel qu'il part à l'IA : daté, orienté, court. */
export interface MessageDossier {
  date: string;
  sens: 'reçu' | 'envoyé';
  de: string;
  sujet: string;
  extrait: string | null;
}

/** Le dossier compact d'un fil : de quoi juger sans avoir tout le fil. */
export interface DossierCompact {
  threadId: number;
  score: number;
  compte: string;
  correspondant: string;
  sujet: string;
  /** dette | reglementaire | ponctuel | inconnu — ce que l'âge fait au sujet. */
  nature: string;
  /** Sens de l'argent, quand on le connaît. */
  direction: string;
  montant: number | null;
  echeanceDepassee: string | null;
  premierAt: string;
  dernierAt: string;
  moisSansMouvement: number;
  /** Messages reçus depuis sa dernière réponse (0 = il a le dernier mot). */
  entrantsDepuisReponse: number;
  aDejaRepondu: boolean;
  correspondants: number;
  /** Ce que le détecteur mécanique a vu, en clair. */
  pourquoiRetenu: string;
  signaux: string[];
  /** Ce que l'analyse avait déjà extrait de ces mails, s'il y a lieu. */
  obligations: string[];
  messages: MessageDossier[];
  /** Nombre de messages non transmis, s'il a fallu élaguer. */
  messagesOmis: number;
}

/** Ce que l'IA renvoie pour un dossier. */
export interface Qualif {
  threadId: number;
  /** attente = il y a quelque chose à suivre · rien = classé · doute = illisible. */
  verdict: 'attente' | 'rien' | 'doute';
  motif?: string;
  attente?: {
    cote: 'moi' | 'eux';
    quoi: string;
    qui: string;
    importance?: 'haute' | 'moyenne' | 'faible';
    urgence?: 'critique' | 'haute' | 'moyenne' | 'faible';
    pourquoi: string;
    risque?: string;
    dueAt?: string;
    montant?: number;
  };
}

const DEBUT = 3;
const FIN = 4;
const EXTRAIT_MAX = 420;

function moisEntre(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24 * 30.44));
}

/** Mots distinctifs d'un libellé : sans accents, ≥ 5 lettres, hors mots creux. */
const CREUX = new Set([
  'avant',
  'aupres',
  'apres',
  'cette',
  'leurs',
  'notre',
  'votre',
  'pour',
  'dossier',
  'demande',
  'facture',
  'reponse',
  'obtenir',
  'savoir',
  'regler',
  'payer',
  'service',
  'societe',
  'monsieur',
  'madame',
]);

function motsDistinctifs(t: string): Set<string> {
  return new Set(
    (t || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((m) => m.length >= 5 && !CREUX.has(m)),
  );
}

function seRecoupent(a: string, b: string, minimum = 1): boolean {
  const x = motsDistinctifs(a);
  let n = 0;
  for (const m of motsDistinctifs(b)) if (x.has(m) && ++n >= minimum) return true;
  return false;
}

export const RANG_URGENCE = ['faible', 'moyenne', 'haute', 'critique'];
export const RANG_IMPORTANCE = ['faible', 'moyenne', 'haute'];

/**
 * De deux jugements sur la même attente, on garde LE PLUS SÉVÈRE.
 *
 * Rapprocher deux cartes ne doit jamais faire disparaître une alarme. Mesuré :
 * l'audit voyait le dossier Comptastar « moyenne », la relecture automatique
 * « haute » — et inversement sur la convention Zanitti, « haute » à l'audit et
 * « faible » à la relecture. Prendre le maximum est le seul choix qui ne perde
 * rien dans les deux sens.
 */
export function plusSevere(a: string, b: string, echelle: string[]): string {
  return echelle.indexOf(b) > echelle.indexOf(a) ? b : a;
}

/** Une attente, réduite à ce qui sert à reconnaître un doublon. */
interface Signature {
  qui: string;
  quoi: string;
  dueAt: Date | string | null;
}

/**
 * Parmi des attentes du MÊME compte et du MÊME côté, celle qui raconte déjà
 * cette histoire — ou rien.
 *
 * Le correspondant doit se recouper (un mot distinctif suffit), PUIS l'un des
 * deux signaux suivants doit confirmer :
 *
 *  · DEUX mots communs sur l'objet. Un seul ne suffit pas : les deux attentes
 *    Comptastar (« Le bilan 2025 de la SARL ECONOM » et « Le juriste annoncé
 *    pour l'AG et le dépôt des comptes 2024 d'ECONOM ») partagent « econom »
 *    et doivent rester séparées. La convention Zanitti en partage deux
 *    (« convention », « honoraires »), le sinistre MECHACHE aussi.
 *
 *  · ou LA MÊME ÉCHÉANCE, au jour près. Ajouté sur un doublon mesuré que le
 *    seul critère de mots ratait : « Régler 418 € à l'URSSAF avant le 29 août »
 *    et « Régler la mise en demeure URSSAF LB2I : 1089€ (mars-mai) + 418€
 *    (juin), avant le 29/08/2026 » n'ont que « urssaf » en commun — mais la
 *    même date, et c'étaient les DEUX seules urgences critiques de l'écran.
 *    Deux cartes rouges pour une seule dette : le plus sûr moyen de lui faire
 *    perdre confiance.
 */
export function jumelleDe<T extends Signature>(candidates: T[], a: Signature): T | undefined {
  const jour = (d: Date | string | null) =>
    d ? new Date(d).toISOString().slice(0, 10) : null;
  const sien = jour(a.dueAt);

  /**
   * ⚠️ LE NOM DU CORRESPONDANT NE PROUVE RIEN — il est déjà exigé par le
   * premier test, et il se répète presque toujours DANS le libellé
   * (« Reprendre contact avec Julie Le Priol (Cerfrance) pour… »). Le compter
   * une seconde fois faisait atteindre le seuil de deux mots à des attentes
   * sans rapport : chez le même comptable, « caler un rendez-vous de
   * restitution » et « transmettre les pièces du bilan 2025 ».
   */
  //
  // L'ADRESSE NON PLUS ne prouve rien — chez lui, presque tout Brimmo tourne
  // autour du 46 rue de la République. « Envoyer la preuve du virement de la
  // facture F202509 (climatisation, 33 rue François Miron) » et « décider
  // d'installer le module de pilotage (33 rue François Miron) » n'ont en
  // commun que le fournisseur et le lieu : deux sujets, pas un doublon.
  const sansAdresse = (t: string): string =>
    (t || '').replace(
      /(rue|avenue|av|boulevard|bd|place|chemin|impasse|all[ée]e|quai|route)[^,;.()]{0,40}/gi,
      ' ',
    );
  const objetSansLeNom = (quoi: string, qui: string): string => {
    const nom = motsDistinctifs(qui);
    return [...motsDistinctifs(sansAdresse(quoi))].filter((m) => !nom.has(m)).join(' ');
  };

  /**
   * DEUX EXERCICES NE SONT PAS LA MÊME AFFAIRE. « Clôturer la compta BRIMMO
   * 2024 » et « les pièces du bilan 2025 » partagent le cabinet, le mot
   * « pièces » et le nom de la société — et sont deux dossiers distincts, l'un
   * à solder, l'autre à monter. Une année citée de part et d'autre, mais
   * différente, interdit le rapprochement.
   */
  const annees = (t: string): string[] => (t || '').match(/\b20\d{2}\b/g) ?? [];
  const anneesIncompatibles = (x: string, y: string): boolean => {
    const ax = annees(x);
    const ay = annees(y);
    return ax.length > 0 && ay.length > 0 && !ax.some((v) => ay.includes(v));
  };

  return candidates.find((o) => {
    if (!seRecoupent(o.qui, a.qui)) return false;
    if (anneesIncompatibles(o.quoi, a.quoi)) return false;
    if (!!sien && jour(o.dueAt) === sien) return true;
    return seRecoupent(objetSansLeNom(o.quoi, o.qui), objetSansLeNom(a.quoi, a.qui), 2);
  });
}

function raccourcir(t: string | null): string | null {
  if (!t) return null;
  const p = t.replace(/\s+/g, ' ').trim();
  return p.length > EXTRAIT_MAX ? p.slice(0, EXTRAIT_MAX) + ' […]' : p;
}

/**
 * Les fils qui méritent une lecture, du plus alarmant au moins.
 *
 * Un fil déjà qualifié ne revient QUE si un message est arrivé depuis. C'est
 * ce qui vide le vivier — et ce qui fait qu'un nouveau rappel rouvre le
 * dossier au lieu de le rejuger à zéro.
 */
export async function prochainsDossiers(opts: {
  limite?: number;
  seuil?: number;
  compte?: string;
} = {}): Promise<{ dossiers: DossierCompact[]; restants: number; total: number }> {
  await ensureDbReady();
  const limite = Math.min(Math.max(opts.limite ?? 8, 1), 15);

  const anomalies = await detecterAnomalies({ seuil: opts.seuil ?? 50, limite: 2000 });
  const retenues = opts.compte
    ? anomalies.filter((a) => a.accountSlug.toLowerCase() === opts.compte!.toLowerCase())
    : anomalies;

  // Ce qui a déjà été lu, et jusqu'à quand.
  const deja = new Map<number, Date>();
  for (const q of await db.qualification.findMany({ select: { threadId: true, jusquAu: true } })) {
    deja.set(q.threadId, q.jusquAu);
  }

  const candidats = retenues.filter((a) => {
    const vu = deja.get(a.threadId);
    return !vu || a.dernierAt.getTime() > vu.getTime();
  });

  const lot = candidats.slice(0, limite);
  const dossiers: DossierCompact[] = [];
  for (const a of lot) dossiers.push(await composer(a));

  return { dossiers, restants: Math.max(0, candidats.length - lot.length), total: retenues.length };
}

async function composer(a: Anomalie): Promise<DossierCompact> {
  const tous = await db.message.findMany({
    where: { threadId: a.threadId, isDeleted: false },
    orderBy: { date: 'asc' },
    select: {
      date: true,
      isOutbound: true,
      fromName: true,
      fromEmail: true,
      subject: true,
      snippet: true,
    },
  });

  // Début + fin : d'où vient l'histoire, et où elle en est.
  let gardes = tous;
  let omis = 0;
  if (tous.length > DEBUT + FIN) {
    gardes = [...tous.slice(0, DEBUT), ...tous.slice(-FIN)];
    omis = tous.length - gardes.length;
  }

  const messages: MessageDossier[] = gardes.map((m) => ({
    date: (m.date ?? new Date(0)).toISOString().slice(0, 10),
    sens: m.isOutbound ? 'envoyé' : 'reçu',
    de: m.fromName || m.fromEmail || '?',
    sujet: m.subject ?? '',
    extrait: raccourcir(m.snippet),
  }));

  // Ce que l'analyse avait déjà compris de ces mails : on ne le redemande pas.
  const actions = await db.verdictAction.findMany({
    where: { verdict: { message: { threadId: a.threadId } } },
    select: { kind: true, label: true, actor: true, dueAt: true, amount: true },
    take: 12,
  });
  const obligations = actions.map((x) => {
    const qui = x.actor === 'user' ? 'toi' : x.actor === 'sender' ? 'eux' : '?';
    const quand = x.dueAt ? ` — avant le ${x.dueAt.toISOString().slice(0, 10)}` : '';
    const combien = x.amount ? ` — ${x.amount} €` : '';
    return `[${x.kind}] ${x.label ?? ''} (acteur : ${qui})${quand}${combien}`.trim();
  });

  return {
    threadId: a.threadId,
    score: a.score,
    compte: a.accountSlug,
    correspondant: a.correspondantNom || a.correspondant,
    sujet: a.sujet,
    nature: a.nature,
    direction: a.direction,
    montant: a.montantMax,
    echeanceDepassee: a.echeanceDepassee ? a.echeanceDepassee.toISOString().slice(0, 10) : null,
    premierAt: a.premierAt.toISOString().slice(0, 10),
    dernierAt: a.dernierAt.toISOString().slice(0, 10),
    moisSansMouvement: moisEntre(a.dernierAt, new Date()),
    entrantsDepuisReponse: a.entrantsDepuisReponse,
    aDejaRepondu: a.aDejaRepondu,
    correspondants: a.correspondants,
    pourquoiRetenu: phraseDe(a),
    signaux: a.signaux.filter((s) => s.poids !== 0).map((s) => s.phrase),
    obligations,
    messages,
    messagesOmis: omis,
  };
}

/**
 * Enregistre les verdicts : la trace de lecture toujours, l'attente quand il y
 * en a une.
 *
 * IDEMPOTENT par `threadId` : rejouer un lot ne duplique pas les attentes.
 */
export async function enregistrerQualifications(
  qualifs: Qualif[],
): Promise<{ lus: number; attentes: number; rejets: string[] }> {
  await ensureDbReady();
  const rejets: string[] = [];
  let lus = 0;
  let attentes = 0;

  for (const q of qualifs) {
    if (!q?.threadId || !['attente', 'rien', 'doute'].includes(q.verdict)) {
      rejets.push(`fil ${q?.threadId ?? '?'} : verdict absent ou inconnu`);
      continue;
    }

    const dernier = await db.message.findFirst({
      where: { threadId: q.threadId, isDeleted: false },
      orderBy: { date: 'desc' },
      select: { id: true, date: true, accountSlug: true },
    });
    if (!dernier) {
      rejets.push(`fil ${q.threadId} : introuvable`);
      continue;
    }

    await db.qualification.upsert({
      where: { threadId: q.threadId },
      create: {
        threadId: q.threadId,
        jusquAu: dernier.date ?? new Date(),
        verdict: q.verdict,
        motif: q.motif ?? null,
      },
      update: {
        jusquAu: dernier.date ?? new Date(),
        verdict: q.verdict,
        motif: q.motif ?? null,
        qualifieAt: new Date(),
      },
    });
    lus++;

    if (q.verdict !== 'attente' || !q.attente) continue;
    const a = q.attente;
    if (!a.quoi || !a.qui || !a.pourquoi) {
      rejets.push(`fil ${q.threadId} : attente incomplète (quoi/qui/pourquoi obligatoires)`);
      continue;
    }

    // ⚠️ NE JAMAIS ÉCRASER une attente que l'utilisateur a déjà traitée : son
    // geste prime sur une relecture automatique.
    let existante = await db.attente.findFirst({ where: { threadId: q.threadId } });

    // DOUBLON AVEC L'AUDIT (mesuré à la première exécution, 26/08). Les 14
    // attentes établies à la main n'ont PAS de threadId : la boucle a donc
    // recréé la convention Zanitti et le sinistre MECHACHE une seconde fois.
    // Deux cartes pour une même affaire, et il cesse de faire confiance.
    //
    // On ne rapproche qu'avec TROIS signaux concordants — même compte, même
    // côté, ET un mot distinctif commun dans le correspondant ET dans l'objet.
    // Les deux derniers sont indispensables : Comptastar porte à lui seul deux
    // attentes bien distinctes (le bilan 2025, le juriste pour l'AG), qu'un
    // rapprochement sur le seul nom aurait fusionnées à tort.
    if (!existante) {
      // ⚠️ SEULEMENT LES ATTENTES SANS FIL — celles de l'audit. J'ai essayé
      // d'étendre le rapprochement à TOUTES les attentes du compte, puisqu'une
      // affaire se raconte souvent dans plusieurs fils. Relecture des 9 paires
      // proposées sur les données réelles : la plupart étaient FAUSSES.
      // « Caler un rendez-vous de restitution » et « transmettre les pièces du
      // bilan 2025 » chez le même comptable sont deux choses distinctes ;
      // « clôturer la compta BRIMMO 2024 » et « le bilan 2025 » sont deux
      // exercices ; « envoyer la preuve du virement » et « décider d'installer
      // le module de climatisation » n'ont en commun que le fournisseur et
      // l'adresse. Fusionner aurait SUPPRIMÉ des tâches réelles — bien pire
      // que deux cartes voisines. On s'en tient donc au cas sûr.
      const orphelines = await db.attente.findMany({
        where: {
          threadId: null,
          accountSlug: dernier.accountSlug,
          cote: a.cote === 'eux' ? 'eux' : 'moi',
          etat: { in: ['ouverte', 'probable'] },
        },
      });
      const jumelle = jumelleDe(orphelines, {
        qui: a.qui,
        quoi: a.quoi,
        dueAt: a.dueAt ?? null,
      });
      if (jumelle) {
        // On la rattache au fil — elle devient dédoublonnable pour de bon, et
        // le lecteur pourra ouvrir la conversation depuis la carte — mais on
        // ne TOUCHE À RIEN D'AUTRE : l'attente d'origine a été écrite en
        // relisant le dossier entier, elle est mieux jugée. Mesuré : la boucle
        // classait la convention Zanitti « faible/faible » quand l'audit la
        // voyait « haute/haute », à raison — sans cette signature, son action
        // contre le maître d'œuvre n'a jamais démarré.
        await db.attente.update({
          where: { id: jumelle.id },
          data: {
            threadId: q.threadId,
            messageId: dernier.id,
            urgence: plusSevere(jumelle.urgence, a.urgence ?? 'moyenne', RANG_URGENCE),
            importance: plusSevere(
              jumelle.importance,
              a.importance ?? 'moyenne',
              RANG_IMPORTANCE,
            ),
            // Un risque nommé par l'une des deux lectures ne se perd pas.
            risque: jumelle.risque ?? a.risque ?? null,
          },
        });
        attentes++;
        continue;
      }
    }
    if (existante) {
      if (existante.etat === 'ouverte' || existante.etat === 'probable') {
        await db.attente.update({
          where: { id: existante.id },
          data: {
            quoi: a.quoi,
            pourquoi: a.pourquoi,
            risque: a.risque ?? null,
            importance: a.importance ?? existante.importance,
            urgence: a.urgence ?? existante.urgence,
            dueAt: a.dueAt ? new Date(a.dueAt) : existante.dueAt,
            montant: a.montant ?? existante.montant,
          },
        });
        attentes++;
      }
      continue;
    }

    await db.attente.create({
      data: {
        cote: a.cote === 'eux' ? 'eux' : 'moi',
        quoi: a.quoi,
        qui: a.qui,
        accountSlug: dernier.accountSlug,
        threadId: q.threadId,
        messageId: dernier.id,
        importance: a.importance ?? 'moyenne',
        urgence: a.urgence ?? 'moyenne',
        pourquoi: a.pourquoi,
        risque: a.risque ?? null,
        dueAt: a.dueAt ? new Date(a.dueAt) : null,
        montant: a.montant ?? null,
        devise: a.montant ? 'EUR' : null,
        source: 'mecanique',
      },
    });
    attentes++;
  }

  return { lus, attentes, rejets };
}

/** Où en est la boucle — pour l'afficher et pour savoir quand s'arrêter. */
export async function avancementQualification(): Promise<{
  detectes: number;
  qualifies: number;
  restants: number;
  attentes: number;
  parVerdict: Record<string, number>;
}> {
  await ensureDbReady();
  const anomalies = await detecterAnomalies({ seuil: 50, limite: 2000 });
  const deja = new Map<number, Date>();
  for (const q of await db.qualification.findMany({ select: { threadId: true, jusquAu: true } })) {
    deja.set(q.threadId, q.jusquAu);
  }
  const restants = anomalies.filter((a) => {
    const vu = deja.get(a.threadId);
    return !vu || a.dernierAt.getTime() > vu.getTime();
  }).length;

  const groupes = await db.qualification.groupBy({ by: ['verdict'], _count: { verdict: true } });
  const parVerdict: Record<string, number> = {};
  for (const g of groupes) parVerdict[g.verdict] = g._count.verdict;

  return {
    detectes: anomalies.length,
    qualifies: deja.size,
    restants,
    attentes: await db.attente.count({ where: { etat: { in: ['ouverte', 'probable'] } } }),
    parVerdict,
  };
}
