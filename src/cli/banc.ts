import { parseArgs } from 'node:util';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { db, ensureDbReady } from '../db/client.js';
import { getUnansweredEmails } from '../services/attention.js';
import { listDeadlines } from '../services/deadlines.js';
import { generateToday } from '../services/today.js';
import { getImportantEmails } from '../services/importance.js';

/**
 * Banc de mesure — `npm run banc`
 *
 * POURQUOI CE SCRIPT EXISTE. La refonte de la couche d'analyse remplace, moteur
 * par moteur, ce qui décide de montrer ou de taire un mail. Anthony a accepté
 * une bascule rapide avec des régressions temporaires ; sans instrument, cette
 * bascule serait à l'aveugle, et une régression sur « ce qui ne doit jamais
 * disparaître » ne se verrait qu'au moment où ça lui coûte de l'argent.
 *
 * CE QU'IL MESURE. Une seule chose, la seule qui compte : **le taux de fuite**.
 * Parmi les mails dont l'oubli a une conséquence (MUST_SURFACE), combien
 * n'apparaissent AUJOURD'HUI sur aucune surface du produit ? Objectif < 1 %
 * (docs/PLAN-ASSISTANT.md § 4).
 *
 * LES ÉTIQUETTES SONT GELÉES, ET C'EST LE POINT CRITIQUE. MUST_SURFACE se
 * définit en partie à partir de `aiAction` — un champ que la refonte va
 * justement supprimer. Recalculer les étiquettes après chaque lot rendrait la
 * comparaison circulaire : le moteur serait jugé sur une règle qu'il vient
 * lui-même de changer. On les calcule donc UNE FOIS (`--geler`), on les
 * versionne, et toutes les mesures suivantes s'y réfèrent.
 *
 * CE QU'IL N'EST PAS. Les étiquettes sont des APPROXIMATIONS observables, pas
 * une vérité terrain : personne n'a annoté 25 000 mails à la main. Un « document
 * à conséquence » est reconnu par une liste de mots. Cette liste a le droit
 * d'être imparfaite — elle est le mètre étalon, pas le moteur. Ce qui compte
 * est qu'elle ne bouge plus.
 *
 *   npm run banc -- --geler        # calcule et fige les étiquettes (une fois)
 *   npm run banc                   # mesure, écrit docs/BANC.md
 *   npm run banc -- --out logs     # sur le serveur (docs/ salirait l'arbre Git)
 *   npm run banc -- --compare <fichier.json>   # écart avec une mesure passée
 */

const ROOT = resolve(process.cwd());
let OUT_DIR = 'docs';

/**
 * Les étiquettes gelées sont VERSIONNÉES (c'est le mètre étalon, il doit vivre
 * dans Git). Mais elles se calculent sur les vraies données, donc sur le
 * serveur — où écrire dans `docs/` salirait l'arbre de travail et ferait
 * échouer le `git merge --ff-only` de la mise à jour automatique. D'où :
 * écriture dans `--out`, lecture avec repli sur `docs/`. Sur le serveur, on
 * gèle avec `--out logs`, on rapatrie le fichier, et on le commite d'ici.
 */
const fEtiquettesEcriture = (): string => join(ROOT, OUT_DIR, 'banc-etiquettes.json');
const fEtiquettesLecture = (): string => {
  const local = join(ROOT, OUT_DIR, 'banc-etiquettes.json');
  return existsSync(local) ? local : join(ROOT, 'docs', 'banc-etiquettes.json');
};
const fTemoins = (): string => join(ROOT, 'docs', 'banc-temoins.json');
const fRapport = (): string => join(ROOT, OUT_DIR, 'BANC.md');
const fMesure = (): string => join(ROOT, OUT_DIR, 'banc-mesure.json');

// ------------------------------------------------------------- le modèle

/** Étiquette figée d'un mail. Ne doit JAMAIS être recalculée après le gel. */
export interface Etiquette {
  id: number;
  compte: string;
  annee: number;
  /** L'oubli de ce mail a une conséquence. */
  mustSurface: boolean;
  /**
   * Le sujet est CLOS : il a répondu, il a pris une décision de dépouillement,
   * ou l'échéance est faite/écartée. Un mail résolu ne peut pas « fuir » — il
   * a de la valeur comme étiquette (il prouve que ce type de mail compte),
   * pas comme reproche fait au produit. Sans cette distinction, un mail de
   * 2019 auquel il a répondu compterait comme une fuite pour l'éternité.
   */
  resolu: boolean;
  /** Rien n'indique de conséquence : candidat au traitement automatique. */
  faibleRisque: boolean;
  /** Âge en jours à la date du gel — sert à isoler la fenêtre active. */
  jours: number;
  /** Pourquoi mustSurface — sert à l'ablation (retirer un signal, voir si les autres rattrapent). */
  motifs: string[];
  /** Sous-populations : sans elles, une bonne moyenne masque le trou des inconnus. */
  expediteurConnu: boolean;
  avecPiece: boolean;
  avecVerdict: boolean;
  avecEcheance: boolean;
}

interface Mesure {
  genereLe: string;
  version: string;
  etiquettesGeleesLe: string;
  total: number;
  mustSurface: number;
  faibleRisque: number;
  /** MUST_SURFACE non résolus dans la fenêtre active — la population jugée. */
  aTraiter: number;
  /** LE chiffre : parmi ceux-là, combien n'apparaissent nulle part. */
  fuite: { nombre: number; taux: number };
  /** Même calcul sur tout le stock, pour situer — jamais le chiffre directeur. */
  fuiteStock: { nombre: number; base: number; taux: number };
  parSurface: Record<string, number>;
  decoupages: Decoupage[];
  temoins: ResultatTemoin[];
}

interface Decoupage {
  axe: string;
  tranches: { nom: string; mustSurface: number; fuite: number; taux: number }[];
}

interface ResultatTemoin {
  nom: string;
  attendu: string;
  trouve: boolean;
  surfaces: string[];
  verdict: 'ok' | 'échec' | 'mail introuvable';
}

/**
 * Mots qui font d'une pièce jointe un document à conséquence.
 *
 * Volontairement large : une fausse alerte coûte un mail de trop dans la liste,
 * un oubli coûte une pénalité de retard. Les variantes sans accent sont
 * présentes parce que SQLite ne replie pas la casse des caractères accentués.
 */
const MOTS_CONSEQUENCE = [
  'facture',
  'appel de fonds',
  'contrat',
  'convocation',
  'mise en demeure',
  'assurance',
  'imposition',
  'impot',
  'impôt',
  'echeance',
  'échéance',
  'quittance',
  'bail',
  'huissier',
  'sinistre',
  'attestation',
  'devis',
  'prelevement',
  'prélèvement',
  'cotisation',
  'amende',
  'mandat',
  'signature',
  'avenant',
  'resiliation',
  'résiliation',
  'decompte',
  'décompte',
  'regularisation',
  'régularisation',
  'relance',
  'acte',
  'notaire',
  'greffe',
];

// ------------------------------------------------------------- étiquetage

interface LigneBrute {
  id: number;
  compte: string;
  annee: number | null;
  repondu: number;
  verdict: string | null;
  echeance: number;
  piece: number;
  docConsequence: number;
  senderCount: number | null;
  decide: number;
  echeanceClose: number;
  jours: number | null;
}

/**
 * Étiquetage. Périmètre : mails ENTRANTS de la boîte de réception, non
 * supprimés. Les envois, la corbeille et le spam sont hors sujet — on mesure
 * ce que le produit doit montrer à Anthony, pas ce qu'il a déjà traité.
 */
async function etiqueter(): Promise<Etiquette[]> {
  const motifs = MOTS_CONSEQUENCE.map(
    (m) => `LOWER(COALESCE(m.subject,'') || ' ' || COALESCE(m.attachmentNames,'')) LIKE '%${m}%'`,
  ).join(' OR ');

  const sql = `
    SELECT m.id                                    AS id,
           m.accountSlug                           AS compte,
           CAST(strftime('%Y', m.date / 1000, 'unixepoch') AS INTEGER) AS annee,
           -- Réponse humaine ultérieure DANS LE MÊME FIL : le signal le plus
           -- solide dont on dispose, parce qu'il est observé et non déduit.
           (SELECT COUNT(*) FROM Message r
              WHERE r.threadId = m.threadId AND r.isOutbound = 1
                AND r.date > m.date)               AS repondu,
           m.aiAction                              AS verdict,
           (SELECT COUNT(*) FROM Deadline d
              WHERE d.messageId = m.id
                AND d.status IN ('proposed','confirmed','done')) AS echeance,
           CASE WHEN m.hasAttachments = 1 THEN 1 ELSE 0 END      AS piece,
           CASE WHEN m.hasAttachments = 1 AND (${motifs}) THEN 1 ELSE 0 END AS docConsequence,
           s.messageCount                          AS senderCount,
           -- Décision de dépouillement prise (rangé, gardé, traité…).
           CASE WHEN m.reviewedAt IS NOT NULL THEN 1 ELSE 0 END AS decide,
           (SELECT COUNT(*) FROM Deadline d2
              WHERE d2.messageId = m.id
                AND d2.status IN ('done','dismissed'))          AS echeanceClose,
           CAST((${Date.now()} - m.date) / 86400000 AS INTEGER)  AS jours
      FROM Message m
      JOIN Folder f ON f.id = m.folderId
      LEFT JOIN Sender s ON s.accountSlug = m.accountSlug AND s.email = m.fromEmail
     WHERE m.isDeleted = 0 AND m.isOutbound = 0 AND f.role = 'inbox'`;

  const lignes = await db.$queryRawUnsafe<LigneBrute[]>(sql);

  return lignes.map((l) => {
    const repondu = Number(l.repondu) > 0;
    const echeance = Number(l.echeance) > 0;
    const doc = Number(l.docConsequence) > 0;
    const verdictFort = l.verdict === 'reply' || l.verdict === 'pay';

    const motifs: string[] = [];
    if (repondu) motifs.push('réponse humaine');
    if (verdictFort) motifs.push(`verdict ${l.verdict}`);
    if (echeance) motifs.push('échéance');
    if (doc) motifs.push('document à conséquence');

    return {
      id: Number(l.id),
      compte: l.compte,
      // Number() n'est pas décoratif : SQLite rend les CAST … AS INTEGER sous
      // forme de BigInt, que JSON.stringify refuse de sérialiser.
      annee: Number(l.annee ?? 0),
      mustSurface: motifs.length > 0,
      resolu: repondu || Number(l.decide) > 0 || Number(l.echeanceClose) > 0,
      faibleRisque: l.verdict === 'archive' && !repondu && !echeance && !doc,
      motifs,
      jours: Number(l.jours ?? 99_999),
      expediteurConnu: Number(l.senderCount ?? 0) >= 3,
      avecPiece: Number(l.piece) > 0,
      avecVerdict: l.verdict != null,
      avecEcheance: echeance,
    };
  });
}

// -------------------------------------------------------------- surfaces

/**
 * Ce que le produit montre aujourd'hui. On appelle les VRAIS moteurs — jamais
 * une réécriture de leurs critères : réimplémenter la règle qu'on veut tester
 * reviendrait à vérifier son propre `if`.
 */
async function surfaces(comptes: string[]): Promise<Map<number, Set<string>>> {
  const vu = new Map<number, Set<string>>();
  const marquer = (id: number | null | undefined, ou: string): void => {
    if (typeof id !== 'number' || !Number.isFinite(id)) return;
    const set = vu.get(id) ?? new Set<string>();
    set.add(ou);
    vu.set(id, set);
  };

  for (const compte of comptes) {
    try {
      const r = await getUnansweredEmails(compte, { sinceDays: 365, limit: 1000 });
      for (const it of r.items) marquer(it.messageId, 'réponses attendues');
    } catch (e) {
      console.error(`  ! réponses attendues (${compte}) : ${(e as Error).message}`);
    }
    try {
      for (const d of await listDeadlines(compte, { limit: 1000 })) {
        if (d.status === 'proposed' || d.status === 'confirmed') marquer(d.messageId, 'échéances');
      }
    } catch (e) {
      console.error(`  ! échéances (${compte}) : ${(e as Error).message}`);
    }
    try {
      const imp = await getImportantEmails(compte, {
        sinceDays: 365,
        limit: 1000,
        minScore: 40,
        // Le banc mesure la PORTÉE du moteur, pas l'écran : un mail lu mais
        // jamais traité doit compter comme atteignable. La résolution est
        // jugée à part (voir `resolu`), pas par « lu / non lu » — ouvrir un
        // mail n'est pas le traiter, et c'est précisément son problème.
        includeRead: true,
      });
      for (const it of imp.items) marquer(it.messageId, 'importants');
    } catch (e) {
      console.error(`  ! importants (${compte}) : ${(e as Error).message}`);
    }
  }

  try {
    const t = await generateToday();
    for (const it of t.todo.replies) marquer(it.messageId, "aujourd'hui");
    for (const it of t.important) marquer(it.messageId, "aujourd'hui");
    for (const it of t.todo.deadlines) marquer(it.messageId, "aujourd'hui");
  } catch (e) {
    console.error(`  ! aujourd'hui : ${(e as Error).message}`);
  }

  return vu;
}

// ------------------------------------------------------------- découpages

/** `population` est déjà restreinte aux MUST_SURFACE non résolus de la fenêtre. */
function decouper(
  population: Etiquette[],
  vu: Map<number, Set<string>>,
  axe: string,
  tranche: (e: Etiquette) => string,
): Decoupage {
  const acc = new Map<string, { must: number; fuite: number }>();
  for (const e of population) {
    const nom = tranche(e);
    const cur = acc.get(nom) ?? { must: 0, fuite: 0 };
    cur.must += 1;
    if (!vu.has(e.id)) cur.fuite += 1;
    acc.set(nom, cur);
  }
  return {
    axe,
    tranches: [...acc.entries()]
      .map(([nom, v]) => ({
        nom,
        mustSurface: v.must,
        fuite: v.fuite,
        taux: v.must ? Math.round((v.fuite / v.must) * 1000) / 10 : 0,
      }))
      .sort((a, b) => (a.nom < b.nom ? -1 : 1)),
  };
}

// --------------------------------------------------------------- témoins

interface Temoin {
  nom: string;
  compte?: string;
  sujetContient: string;
  /** 'visible' = doit apparaître quelque part ; 'absent' = ne doit apparaître nulle part. */
  attendu: 'visible' | 'absent';
  /** Pourquoi ce cas est gardé — lu par un humain, jamais par le script. */
  note?: string;
}

async function verifierTemoins(vu: Map<number, Set<string>>): Promise<ResultatTemoin[]> {
  if (!existsSync(fTemoins())) return [];
  const temoins = JSON.parse(readFileSync(fTemoins(), 'utf8')) as Temoin[];
  const out: ResultatTemoin[] = [];

  for (const t of temoins) {
    const rows = await db.message.findMany({
      where: {
        ...(t.compte ? { accountSlug: t.compte } : {}),
        isDeleted: false,
        subject: { contains: t.sujetContient },
      },
      select: { id: true },
      take: 20,
    });
    if (rows.length === 0) {
      out.push({ nom: t.nom, attendu: t.attendu, trouve: false, surfaces: [], verdict: 'mail introuvable' });
      continue;
    }
    const ou = new Set<string>();
    for (const r of rows) for (const s of vu.get(r.id) ?? []) ou.add(s);
    const visible = ou.size > 0;
    out.push({
      nom: t.nom,
      attendu: t.attendu,
      trouve: true,
      surfaces: [...ou],
      verdict: (t.attendu === 'visible') === visible ? 'ok' : 'échec',
    });
  }
  return out;
}

// ---------------------------------------------------------------- rapport

function ecrire(chemin: string, contenu: string): void {
  mkdirSync(dirname(chemin), { recursive: true });
  writeFileSync(chemin, contenu, 'utf8');
}

function pct(n: number, d: number): number {
  return d ? Math.round((n / d) * 1000) / 10 : 0;
}

function rendre(m: Mesure, precedente: Mesure | null): string {
  const l: string[] = [];
  const ecart = (a: number, b: number): string => {
    const d = Math.round((a - b) * 10) / 10;
    return d === 0 ? '' : d > 0 ? ` (+${d})` : ` (${d})`;
  };

  l.push('# Banc de mesure');
  l.push('');
  l.push(`> Mesuré le ${m.genereLe.slice(0, 16).replace('T', ' à ')} · étiquettes gelées le ${m.etiquettesGeleesLe.slice(0, 10)}`);
  l.push('>');
  l.push("> Ce fichier est produit par `npm run banc`. Il ne se modifie pas à la main.");
  l.push('');
  l.push('## Le chiffre');
  l.push('');
  const t = m.fuite.taux;
  const verdict = t < 1 ? '✅ sous l\'objectif' : t < 3 ? '⚠️ au-dessus de l\'objectif' : '❌ hors limite';
  l.push(
    `**Taux de fuite : ${t} %**${precedente ? ecart(t, precedente.fuite.taux) : ''} — ${verdict} (< 1 %).`,
  );
  l.push('');
  l.push(
    `${m.fuite.nombre} mails sur ${m.aTraiter} dont l'oubli a une conséquence, et qui restent à traiter, n'apparaissent sur aucune surface du produit.`,
  );
  l.push('');
  l.push(
    `Périmètre : ${m.total} mails entrants de boîte de réception. ${m.mustSurface} MUST_SURFACE (${pct(m.mustSurface, m.total)} %), dont **${m.aTraiter} non résolus dans les 12 derniers mois** — c'est la population jugée. ${m.faibleRisque} mails à faible risque (${pct(m.faibleRisque, m.total)} %).`,
  );
  l.push('');
  l.push(
    `Sur tout le stock non résolu, sans limite d'âge : ${m.fuiteStock.nombre} / ${m.fuiteStock.base} (${m.fuiteStock.taux} %). Ce chiffre situe l'arriéré ; il n'est pas le critère — reprocher au produit de ne pas afficher un mail de 2019 n'aurait pas de sens.`,
  );
  l.push('');

  l.push('## Où les mails apparaissent');
  l.push('');
  l.push('| Surface | Mails |');
  l.push('|---|---|');
  for (const [k, v] of Object.entries(m.parSurface).sort((a, b) => b[1] - a[1])) {
    l.push(`| ${k} | ${v} |`);
  }
  l.push('');

  l.push('## Découpages');
  l.push('');
  l.push("Une moyenne flatteuse masque toujours un trou. Le backtest du 10/08 l'a montré : 43 % du flux vient d'expéditeurs jamais vus.");
  l.push('');
  for (const d of m.decoupages) {
    l.push(`### ${d.axe}`);
    l.push('');
    l.push('| Tranche | MUST_SURFACE | Fuite | Taux |');
    l.push('|---|---|---|---|');
    for (const tr of d.tranches) {
      const alerte = tr.taux >= 3 ? ' ⚠️' : '';
      l.push(`| ${tr.nom} | ${tr.mustSurface} | ${tr.fuite} | ${tr.taux} %${alerte} |`);
    }
    l.push('');
  }

  if (m.temoins.length) {
    l.push('## Cas témoins');
    l.push('');
    l.push("Les échecs connus, gardés en dur. Un lot qui les casse à nouveau se voit ici.");
    l.push('');
    l.push('| Cas | Attendu | Constaté | Verdict |');
    l.push('|---|---|---|---|');
    for (const t2 of m.temoins) {
      const c = t2.verdict === 'mail introuvable' ? '—' : t2.surfaces.length ? t2.surfaces.join(', ') : 'nulle part';
      const v = t2.verdict === 'ok' ? '✅' : t2.verdict === 'échec' ? '❌' : '· introuvable';
      l.push(`| ${t2.nom} | ${t2.attendu} | ${c} | ${v} |`);
    }
    l.push('');
  }

  l.push('## Méthode');
  l.push('');
  l.push('**MUST_SURFACE** — réponse humaine ultérieure dans le fil, OU verdict IA `reply`/`pay`, OU échéance retenue, OU pièce jointe dont le nom ou le sujet porte un mot à conséquence.');
  l.push('');
  l.push("**Résolu** — il a répondu, il a pris une décision de dépouillement, ou l'échéance est faite ou écartée. Un mail résolu ne peut pas fuir : il garde sa valeur d'étiquette (il prouve que ce type de mail compte) mais ne constitue pas un reproche. « Lu » ne vaut PAS résolu — ouvrir un mail n'est pas le traiter, et c'est exactement son problème.");
  l.push('');
  l.push('**Étiquettes gelées.** MUST_SURFACE se définit en partie sur `aiAction`, un champ que la refonte supprime. Les recalculer après chaque lot rendrait la mesure circulaire — le moteur serait jugé sur une règle qu\'il vient de changer. Elles sont donc figées une fois pour toutes dans `docs/banc-etiquettes.json`.');
  l.push('');
  l.push("**Ce n'est pas une vérité terrain.** Personne n'a annoté 25 000 mails. Un « document à conséquence » est reconnu par une liste de mots. Cette liste a le droit d'être imparfaite : elle est le mètre étalon, pas le moteur. Ce qui compte est qu'elle ne bouge plus.");
  l.push('');
  return l.join('\n');
}

// ------------------------------------------------------------------ main

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      out: { type: 'string' },
      geler: { type: 'boolean' },
      compare: { type: 'string' },
      'dry-run': { type: 'boolean' },
    },
    allowPositionals: true,
  });
  if (values.out) OUT_DIR = values.out;

  await ensureDbReady();

  // 1. Étiquettes — calculées une fois, puis relues.
  let etiquettes: Etiquette[];
  let geleesLe: string;
  if (values.geler || !existsSync(fEtiquettesLecture())) {
    if (!values.geler) {
      console.log('Aucune étiquette gelée : premier calcul (équivaut à --geler).');
    }
    console.log('Étiquetage…');
    etiquettes = await etiqueter();
    geleesLe = new Date().toISOString();
    if (!values['dry-run']) {
      ecrire(fEtiquettesEcriture(), JSON.stringify({ geleesLe, etiquettes }, null, 0));
      console.log(`${etiquettes.length} étiquettes gelées dans ${fEtiquettesEcriture()}`);
      console.log('→ à rapatrier et à commiter : ce fichier est le mètre étalon.');
    }
  } else {
    const brut = JSON.parse(readFileSync(fEtiquettesLecture(), 'utf8')) as {
      geleesLe: string;
      etiquettes: Etiquette[];
    };
    etiquettes = brut.etiquettes;
    geleesLe = brut.geleesLe;
    console.log(`${etiquettes.length} étiquettes relues (gelées le ${geleesLe.slice(0, 10)}).`);
  }

  // 2. Surfaces réelles.
  const comptes = (await db.account.findMany({ select: { slug: true } })).map((a) => a.slug);
  console.log(`Interrogation des moteurs sur ${comptes.length} boîtes…`);
  const vu = await surfaces(comptes);

  // 3. Mesure.
  //
  // La population jugée n'est PAS « tous les MUST_SURFACE » : c'est ceux qui
  // restent à traiter, dans la fenêtre où le produit prétend agir (365 j, la
  // portée maximale des moteurs interrogés). Au-delà, un mail non résolu est de
  // l'archéologie : le reprocher au produit ferait un chiffre spectaculaire et
  // inutile. Le stock complet est mesuré à part, pour situer.
  const FENETRE_JOURS = 365;
  const must = etiquettes.filter((e) => e.mustSurface);
  const aTraiter = must.filter((e) => !e.resolu && e.jours <= FENETRE_JOURS);
  const fuite = aTraiter.filter((e) => !vu.has(e.id));
  const stock = must.filter((e) => !e.resolu);
  const fuiteStock = stock.filter((e) => !vu.has(e.id));

  const parSurface: Record<string, number> = {};
  for (const set of vu.values()) for (const s of set) parSurface[s] = (parSurface[s] ?? 0) + 1;

  const mesure: Mesure = {
    genereLe: new Date().toISOString(),
    version: '1',
    etiquettesGeleesLe: geleesLe,
    total: etiquettes.length,
    mustSurface: must.length,
    faibleRisque: etiquettes.filter((e) => e.faibleRisque).length,
    aTraiter: aTraiter.length,
    fuite: { nombre: fuite.length, taux: pct(fuite.length, aTraiter.length) },
    fuiteStock: {
      nombre: fuiteStock.length,
      base: stock.length,
      taux: pct(fuiteStock.length, stock.length),
    },
    parSurface,
    decoupages: [
      decouper(aTraiter, vu, 'Par boîte', (e) => e.compte),
      decouper(aTraiter, vu, 'Par année', (e) => String(e.annee || 'inconnue')),
      decouper(aTraiter, vu, 'Expéditeur', (e) => (e.expediteurConnu ? 'connu' : 'inconnu')),
      decouper(aTraiter, vu, 'Pièce jointe', (e) => (e.avecPiece ? 'avec' : 'sans')),
      decouper(aTraiter, vu, 'Verdict IA', (e) => (e.avecVerdict ? 'analysé' : 'jamais analysé')),
      decouper(aTraiter, vu, 'Motif', (e) => e.motifs[0] ?? '—'),
    ],
    temoins: await verifierTemoins(vu),
  };

  let precedente: Mesure | null = null;
  const cheminCompare = values.compare ?? (existsSync(fMesure()) ? fMesure() : null);
  if (cheminCompare && existsSync(cheminCompare)) {
    try {
      precedente = JSON.parse(readFileSync(cheminCompare, 'utf8')) as Mesure;
    } catch {
      /* une mesure précédente illisible ne doit pas empêcher celle-ci */
    }
  }

  const md = rendre(mesure, precedente);
  if (values['dry-run']) {
    console.log(md);
  } else {
    ecrire(fRapport(), md);
    ecrire(fMesure(), JSON.stringify(mesure, null, 1));
    console.log(`\nRapport : ${fRapport()}`);
  }

  console.log(
    `\nTaux de fuite : ${mesure.fuite.taux} % (${mesure.fuite.nombre} / ${mesure.mustSurface})`,
  );
  const echecs = mesure.temoins.filter((t) => t.verdict === 'échec');
  if (echecs.length) console.log(`Témoins en échec : ${echecs.map((t) => t.nom).join(', ')}`);

  await db.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await db.$disconnect().catch(() => {});
  process.exit(1);
});
