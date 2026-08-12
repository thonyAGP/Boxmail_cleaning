import { db, ensureDbReady } from '../db/client.js';
import { logger } from '../logger.js';

/**
 * DOSSIERS — un sujet de vie qui traverse les interlocuteurs (11/08).
 *
 * Un bien immobilier passe par l'agence, le notaire, la banque, le syndic,
 * l'assureur, l'architecte, le fournisseur d'énergie. Regrouper par expéditeur
 * éclate le dossier ; le regrouper par SUJET le reconstitue. Mesuré sur ses
 * boîtes : « 46 rue de la République » apparaît chez 45 correspondants
 * différents, dans 4 boîtes.
 *
 * D'OÙ VIENT LE DOSSIER — et c'est la décision structurante.
 *
 * J'avais d'abord écrit des expressions régulières (rue|avenue|boulevard…).
 * Reproche de l'utilisateur, et il a raison : « j'ai vraiment peur de ta
 * conception qui est à corriger à chaque nouveau cas et qui en oublie
 * systématiquement tant que je ne passe pas manuellement dessus ». Ces règles
 * rateraient un lieu-dit, une résidence, un bien à l'étranger, un véhicule
 * (Colocar fait du négoce automobile), une affaire judiciaire.
 *
 * Le dossier est donc DÉCLARÉ PAR L'ANALYSE, qui lit le mail entier : elle
 * renvoie un libellé libre (« 46 rue de la République », « Affaire ODAS »,
 * « Renault Trafic AB-123-CD »). Aucun vocabulaire n'est codé ici.
 *
 * Le code ne fait que deux choses, et elles sont mécaniques :
 *  1. NORMALISER le libellé pour que « 46 rue de la République » et
 *     « 46 Rue de la Republique » soient le même dossier ;
 *  2. PROPAGER : une fois qu'un dossier existe, rattacher les autres mails qui
 *     citent le même libellé. Ce n'est pas un vocabulaire inventé — c'est celui
 *     que l'analyse a produit, appliqué aux 25 000 mails sans les réanalyser.
 *     Depuis le lot 4h, les MENTIONS et CONTEXTES des verdicts existants sont
 *     la première source de rattachement (comparaison par clé normalisée et
 *     par identifiant dur) — la sous-chaîne ne couvre plus que les mails
 *     jamais analysés.
 */

/** Libellés trop vagues pour faire un dossier : on les refuse. */
const TROP_VAGUE = new Set([
  'divers', 'autre', 'autres', 'general', 'general', 'inconnu', 'aucun', 'n/a', 'na',
  'personnel', 'perso', 'pro', 'professionnel', 'administratif', 'banque', 'assurance',
  'facture', 'factures', 'impots', 'comptabilite', 'courrier', 'mail', 'email',
]);

const sansAccent = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

/**
 * Clé stable d'un libellé : minuscules, accents retirés, ponctuation réduite,
 * mots de liaison supprimés. « 46 rue de la République, Brest » et
 * « 46 Rue République » tombent sur la même clé.
 */
export function cleDossier(label: string): string | null {
  const brut = sansAccent(String(label ?? ''))
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!brut) return null;
  const mots = brut
    .split(' ')
    .filter((w) => w && !['de', 'du', 'des', 'la', 'le', 'les', "l'", 'a', 'au', 'aux'].includes(w));
  const cle = mots.join(' ').trim();
  if (cle.length < 4) return null;
  if (TROP_VAGUE.has(cle)) return null;
  // Un libellé d'un seul mot très court n'identifie rien.
  if (mots.length === 1 && cle.length < 6) return null;
  return cle.slice(0, 120);
}

const KINDS = ['bien', 'affaire', 'vehicule', 'societe', 'personne', 'reference', 'autre'];

/**
 * Forme comparable d'un identifiant dur : majuscules, séparateurs retirés.
 * « 9002390187/S12/F » et « 9002390187 S12 F » désignent le même sinistre.
 */
export function normaliserIdentifiant(v: string): string | null {
  const s = String(v ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  // Moins de 5 caractères : ce n'est pas un identifiant, c'est un mot.
  return s.length >= 5 ? s.slice(0, 60) : null;
}

/**
 * Suit la chaîne des fusions. Sans ça, une fusion serait défaite au premier
 * mail qui arrive avec l'ancienne orthographe — et l'utilisateur devrait
 * refusionner indéfiniment. La borne à 10 sauts protège d'un cycle qu'une
 * fusion croisée pourrait créer.
 */
async function suivreFusion(id: number): Promise<number> {
  let courant = id;
  for (let i = 0; i < 10; i++) {
    const d = await db.dossier.findUnique({
      where: { id: courant },
      select: { mergedIntoId: true },
    });
    if (!d?.mergedIntoId || d.mergedIntoId === courant) return courant;
    courant = d.mergedIntoId;
  }
  logger.warn('chaîne de fusion trop longue, arrêt', { depart: id, arrivee: courant });
  return courant;
}

export interface Mention {
  label: string;
  kind?: string | null;
  /** Numéro de contrat, de sinistre, SIRET, plaque… quand l'analyse en a lu un. */
  identifier?: string | null;
  source?: string;
}

/**
 * RÉSOLUTION — le cœur du lot 3. L'IA propose une mention, le serveur décide
 * de l'identité.
 *
 * L'ordre n'est pas arbitraire : un identifiant DUR prime sur l'orthographe.
 * Deux mails qui citent le même numéro de sinistre parlent du même dossier,
 * même si l'un dit « Sinistre dégât des eaux » et l'autre « DOSSIER
 * 9002390187/S12/F ». C'est la seule façon de recoller ce qu'aucune
 * normalisation de chaîne ne rapprocherait.
 */
export async function resoudre(m: Mention): Promise<{ dossierId: number; cree: boolean } | null> {
  await ensureDbReady();
  const label = String(m.label ?? '').trim().slice(0, 160);
  const cle = cleDossier(label);
  const ident = m.identifier ? normaliserIdentifiant(m.identifier) : null;
  if (!cle && !ident) return null;

  // 1. Par identifiant dur.
  if (ident) {
    const trouve = await db.dossierIdentifier.findFirst({
      where: { value: ident },
      select: { dossierId: true },
    });
    if (trouve) {
      const cible = await suivreFusion(trouve.dossierId);
      if (cle) await ajouterAlias(cible, cle, label, m.source ?? 'ia');
      return { dossierId: cible, cree: false };
    }
  }

  // 2. Par orthographe déjà rencontrée.
  if (cle) {
    const alias = await db.dossierAlias.findUnique({
      where: { key: cle },
      select: { dossierId: true },
    });
    if (alias) {
      const cible = await suivreFusion(alias.dossierId);
      if (ident) await ajouterIdentifiant(cible, ident, m.kind, m.source ?? 'ia');
      return { dossierId: cible, cree: false };
    }
    // 3. Repli sur la clé du dossier lui-même : les dossiers créés avant la
    //    table d'alias n'ont pas encore de ligne correspondante.
    const direct = await db.dossier.findUnique({ where: { key: cle }, select: { id: true } });
    if (direct) {
      const cible = await suivreFusion(direct.id);
      await ajouterAlias(cible, cle, label, 'reprise');
      if (ident) await ajouterIdentifiant(cible, ident, m.kind, m.source ?? 'ia');
      return { dossierId: cible, cree: false };
    }
  }

  // 4. Rien de connu : on crée. Un dossier sans libellé exploitable prend son
  //    identifiant comme nom — mieux vaut « DOSSIER 9002390187 » que rien.
  const cleFinale = cle ?? `ref ${ident}`.toLowerCase();
  const dossier = await db.dossier.create({
    data: {
      key: cleFinale,
      label: label || `Réf. ${ident}`,
      kind: m.kind && KINDS.includes(m.kind) ? m.kind : 'autre',
      aliases: JSON.stringify([label || `Réf. ${ident}`]),
    },
  });
  await ajouterAlias(dossier.id, cleFinale, label || `Réf. ${ident}`, m.source ?? 'ia');
  if (ident) await ajouterIdentifiant(dossier.id, ident, m.kind, m.source ?? 'ia');
  logger.info('dossier créé', { key: cleFinale, label: dossier.label });
  return { dossierId: dossier.id, cree: true };
}

async function ajouterAlias(
  dossierId: number,
  key: string,
  label: string,
  source: string,
): Promise<void> {
  // `key` est unique GLOBALEMENT : si l'alias existe déjà ailleurs, il désigne
  // un autre dossier et on ne le vole pas en silence.
  const existe = await db.dossierAlias.findUnique({ where: { key }, select: { id: true } });
  if (existe) return;
  await db.dossierAlias.create({ data: { dossierId, key, label: label.slice(0, 160), source } });
}

async function ajouterIdentifiant(
  dossierId: number,
  value: string,
  kind: string | null | undefined,
  source: string,
): Promise<void> {
  const k = kind && KINDS.includes(kind) ? kind : 'other';
  await db.dossierIdentifier
    .create({ data: { dossierId, kind: k, value, source } })
    .catch(() => undefined); // unique [kind, value] : déjà connu, rien à faire
}

/**
 * Rattache un mail à un dossier à partir de ce que l'analyse a lu.
 * Crée le dossier au besoin. Idempotent.
 */
export async function rattacher(opts: {
  messageId: number;
  label: string;
  kind?: string;
  identifier?: string | null;
  source?: string;
}): Promise<{ dossierId: number; cree: boolean } | null> {
  const r = await resoudre({
    label: opts.label,
    kind: opts.kind,
    identifier: opts.identifier ?? null,
    source: opts.source,
  });
  if (!r) return null;

  await db.dossierMessage.upsert({
    where: { dossierId_messageId: { dossierId: r.dossierId, messageId: opts.messageId } },
    create: { dossierId: r.dossierId, messageId: opts.messageId, source: opts.source ?? 'ia' },
    update: {},
  });
  return r;
}

function safeJson(s: string | null): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Index des mentions et contextes de TOUS les verdicts, sous leur forme
 * NORMALISÉE (cleDossier / normaliserIdentifiant). Fonction pure — le banc
 * l'éprouve avec des lignes en mémoire.
 *
 * C'est la matière première de la propagation par le verdict (lot 4h) : là où
 * la sous-chaîne exige la même graphie au caractère près, la clé rapproche
 * « 46 Rue de la République » et « 46 rue republique », et l'identifiant dur
 * rapproche ce qu'aucune orthographe ne rapprocherait.
 */
export interface IndexMentions {
  /** cleDossier(nameRaw/label) → mails dont le verdict porte cette mention. */
  parCle: Map<string, Set<number>>;
  /** normaliserIdentifiant(identifier) → mails porteurs de cet identifiant. */
  parIdentifiant: Map<string, Set<number>>;
}

export function indexerMentionsPourPropagation(
  mentions: { messageId: number; nameRaw: string; identifier: string | null }[],
  contextes: { messageId: number; label: string }[],
): IndexMentions {
  const parCle = new Map<string, Set<number>>();
  const parIdentifiant = new Map<string, Set<number>>();
  const poser = (map: Map<string, Set<number>>, cle: string | null, id: number) => {
    if (!cle) return;
    const s = map.get(cle);
    if (s) s.add(id);
    else map.set(cle, new Set([id]));
  };
  for (const m of mentions) {
    poser(parCle, cleDossier(m.nameRaw), m.messageId);
    if (m.identifier) poser(parIdentifiant, normaliserIdentifiant(m.identifier), m.messageId);
  }
  for (const c of contextes) {
    poser(parCle, cleDossier(c.label), c.messageId);
  }
  return { parCle, parIdentifiant };
}

/**
 * Les mails que le VERDICT rattache à un dossier : mêmes clés normalisées,
 * ou même identifiant dur. Fonction pure, éprouvée par le banc.
 */
export function ciblesDuDossier(
  d: { cles: Iterable<string>; identifiants: Iterable<string> },
  index: IndexMentions,
): Set<number> {
  const out = new Set<number>();
  for (const k of d.cles) for (const id of index.parCle.get(k) ?? []) out.add(id);
  for (const v of d.identifiants) for (const id of index.parIdentifiant.get(v) ?? []) out.add(id);
  return out;
}

/**
 * PROPAGATION : rattache au dossier les mails qui le citent sans que
 * l'analyse ait été rejouée. C'est ce qui évite d'attendre que l'IA ait relu
 * les 25 000 mails pour qu'un dossier soit complet.
 *
 * Deux voies, dans cet ordre (lot 4h) :
 *  1. le VERDICT : les mentions (`EntityMention`) et contextes
 *     (`VerdictContext`) déjà produits par l'analyse, comparés aux alias du
 *     dossier par CLÉ NORMALISÉE et par IDENTIFIANT DUR — plus fiable qu'une
 *     sous-chaîne, insensible à la graphie, source « verdict » ;
 *  2. la SOUS-CHAÎNE (historique) : le libellé cherché tel quel dans le
 *     sujet, le résumé, l'extrait et les pièces — c'est elle qui couvre les
 *     mails jamais analysés, source « propagation ».
 *
 * BUDGET : les mentions/contextes forts sont chargés UNE fois pour tous les
 * dossiers (2 requêtes, indépendantes du nombre de dossiers), puis la voie
 * verdict ne coûte que la validation des cibles (1 requête par lot de 900).
 * La voie sous-chaîne garde son coût historique (1 requête par terme).
 */
export async function propager(dossierId?: number): Promise<{ dossiers: number; ajouts: number }> {
  await ensureDbReady();
  const dossiers = await db.dossier.findMany({
    // Ni masqués ni absorbés : propager sur un dossier fusionné y remettrait
    // les mails qu'on vient d'en sortir.
    where: { status: { notIn: ['hidden', 'merged'] }, ...(dossierId ? { id: dossierId } : {}) },
    select: {
      id: true,
      key: true,
      label: true,
      aliases: true,
      aliasRows: { select: { key: true, label: true } },
      identifiers: { select: { value: true } },
    },
  });
  if (dossiers.length === 0) return { dossiers: 0, ajouts: 0 };

  // Les inférences faibles ne rattachent rien : un dossier pollué par un
  // doute d'analyse coûterait plus cher à nettoyer que le mail manquant.
  const [mentionsV, contextesV] = await Promise.all([
    db.entityMention.findMany({
      where: { certainty: { in: ['explicit', 'strong_inference'] } },
      select: { messageId: true, nameRaw: true, identifier: true },
    }),
    db.verdictContext.findMany({
      where: { certainty: { in: ['explicit', 'strong_inference'] } },
      select: { messageId: true, label: true },
    }),
  ]);
  const index = indexerMentionsPourPropagation(mentionsV, contextesV);

  let ajouts = 0;
  for (const d of dossiers) {
    const termes = [d.label, ...safeJson(d.aliases), ...d.aliasRows.map((a) => a.label)]
      .map((t) => t.trim())
      .filter((t) => t.length >= 6);

    // --- Voie 1 : le verdict. Toutes les écritures connues du dossier,
    // normalisées, plus ses identifiants durs (déjà normalisés à l'insertion).
    const cles = new Set<string>([d.key, ...d.aliasRows.map((a) => a.key)]);
    for (const t of termes) {
      const k = cleDossier(t);
      if (k) cles.add(k);
    }
    const cibles = [...ciblesDuDossier(
      { cles, identifiants: d.identifiers.map((i) => i.value) },
      index,
    )];
    for (let i = 0; i < cibles.length; i += 900) {
      // Mêmes exclusions que la voie sous-chaîne : ni corbeille, ni spam.
      const valides = await db.message.findMany({
        where: {
          id: { in: cibles.slice(i, i + 900) },
          isDeleted: false,
          folder: { role: { notIn: ['spam', 'trash'] } },
        },
        select: { id: true },
      });
      for (const m of valides) {
        const r = await db.dossierMessage.upsert({
          where: { dossierId_messageId: { dossierId: d.id, messageId: m.id } },
          create: { dossierId: d.id, messageId: m.id, source: 'verdict' },
          update: {},
        });
        if (r) ajouts++;
      }
    }

    // --- Voie 2 : la sous-chaîne (historique, couvre les mails sans verdict).
    const vus = new Set<string>();
    for (const terme of termes) {
      const k = terme.toLowerCase();
      if (vus.has(k)) continue;
      vus.add(k);
      const trouves = await db.message.findMany({
        where: {
          isDeleted: false,
          folder: { role: { notIn: ['spam', 'trash'] } },
          OR: [
            { subject: { contains: terme } },
            { aiSummary: { contains: terme } },
            { snippet: { contains: terme } },
            { attachmentNames: { contains: terme } },
            { attachmentText: { contains: terme } },
          ],
        },
        select: { id: true },
        take: 2000,
      });
      for (const m of trouves) {
        const r = await db.dossierMessage.upsert({
          where: { dossierId_messageId: { dossierId: d.id, messageId: m.id } },
          create: { dossierId: d.id, messageId: m.id, source: 'propagation' },
          update: {},
        });
        if (r) ajouts++;
      }
    }
    await rafraichir(d.id);
  }
  return { dossiers: dossiers.length, ajouts };
}

/** Recompte les mails d'un dossier et met à jour ses bornes de date. */
export async function rafraichir(dossierId: number): Promise<void> {
  const liens = await db.dossierMessage.findMany({
    where: { dossierId },
    select: { message: { select: { date: true } } },
  });
  const dates = liens
    .map((l) => l.message?.date)
    .filter((d): d is Date => !!d)
    .sort((a, b) => a.getTime() - b.getTime());
  await db.dossier.update({
    where: { id: dossierId },
    data: {
      messageCount: liens.length,
      firstAt: dates[0] ?? null,
      lastAt: dates[dates.length - 1] ?? null,
    },
  });
}

// ---------------------------------------------------------------------------
// LES TROIS GESTES DE L'UTILISATEUR
//
// Demandés explicitement le 11/08 : renommer, fusionner, masquer. Le point
// commun des trois, et la seule chose qui compte : sa correction ne doit
// JAMAIS être effacée par une réanalyse. Sinon il corrigerait une fois,
// verrait revenir la même erreur, et ne recommencerait pas — c'est exactement
// ce qui s'est passé avec les 114 règles de classement suggérées dont aucune
// n'a jamais été activée.
// ---------------------------------------------------------------------------

/** Renomme un dossier. Le libellé devient MANUEL et n'est plus jamais réécrit. */
export async function renommer(id: number, label: string): Promise<{ label: string }> {
  await ensureDbReady();
  const propre = String(label ?? '').trim().slice(0, 160);
  if (propre.length < 2) throw new Error('Le nom du dossier est trop court.');
  const d = await db.dossier.update({
    where: { id },
    data: { label: propre, labelSource: 'manual' },
    select: { id: true, label: true, key: true },
  });
  // L'ancienne orthographe reste un alias : les mails qui la citent doivent
  // continuer d'atterrir ici.
  const cle = cleDossier(propre);
  if (cle) await ajouterAlias(d.id, cle, propre, 'manuel');
  logger.info('dossier renommé', { id, label: propre });
  return { label: d.label };
}

/**
 * Fusionne deux dossiers. Tout part vers la cible : alias, identifiants,
 * mails. Le dossier absorbé reste en base avec un RENVOI — c'est lui qui fait
 * que la fusion tient dans le temps, puisque la résolution suit le renvoi.
 */
export async function fusionner(
  sourceId: number,
  cibleId: number,
): Promise<{ dossierId: number; mailsDeplaces: number; aliasDeplaces: number }> {
  await ensureDbReady();
  if (sourceId === cibleId) throw new Error('Un dossier ne se fusionne pas avec lui-même.');
  const [source, cible] = await Promise.all([
    db.dossier.findUnique({ where: { id: sourceId }, select: { id: true, key: true, label: true } }),
    db.dossier.findUnique({ where: { id: cibleId }, select: { id: true, label: true } }),
  ]);
  if (!source || !cible) throw new Error('Dossier introuvable.');

  // Alias : on repointe ceux qui ne créeraient pas de collision, on jette les
  // autres (ils désignent déjà la cible).
  const alias = await db.dossierAlias.findMany({ where: { dossierId: sourceId } });
  let aliasDeplaces = 0;
  for (const a of alias) {
    const conflit = await db.dossierAlias.findFirst({
      where: { key: a.key, dossierId: cibleId },
      select: { id: true },
    });
    if (conflit) {
      await db.dossierAlias.delete({ where: { id: a.id } });
    } else {
      await db.dossierAlias.update({
        where: { id: a.id },
        data: { dossierId: cibleId, source: 'fusion' },
      });
      aliasDeplaces++;
    }
  }
  // La clé PROPRE du dossier absorbé devient un alias de la cible : sans ça,
  // un mail qui arrive demain avec l'ancienne écriture recréerait le dossier.
  await ajouterAlias(cibleId, source.key, source.label, 'fusion');

  for (const i of await db.dossierIdentifier.findMany({ where: { dossierId: sourceId } })) {
    await db.dossierIdentifier
      .update({ where: { id: i.id }, data: { dossierId: cibleId, source: 'fusion' } })
      .catch(async () => {
        await db.dossierIdentifier.delete({ where: { id: i.id } }).catch(() => undefined);
      });
  }

  const liens = await db.dossierMessage.findMany({ where: { dossierId: sourceId } });
  let mailsDeplaces = 0;
  for (const l of liens) {
    await db.dossierMessage.upsert({
      where: { dossierId_messageId: { dossierId: cibleId, messageId: l.messageId } },
      create: { dossierId: cibleId, messageId: l.messageId, source: l.source },
      update: {},
    });
    mailsDeplaces++;
  }
  await db.dossierMessage.deleteMany({ where: { dossierId: sourceId } });

  await db.dossier.update({
    where: { id: sourceId },
    data: { status: 'merged', mergedIntoId: cibleId, messageCount: 0 },
  });
  await rafraichir(cibleId);
  logger.info('dossiers fusionnés', {
    source: source.label,
    cible: cible.label,
    mailsDeplaces,
  });
  return { dossierId: cibleId, mailsDeplaces, aliasDeplaces };
}

/** Masque (ou réaffiche) un dossier sans rien perdre. */
export async function masquer(id: number, masque = true): Promise<{ status: string }> {
  await ensureDbReady();
  const d = await db.dossier.update({
    where: { id },
    data: { status: masque ? 'hidden' : 'confirmed' },
    select: { status: true },
  });
  return { status: d.status };
}

/**
 * Reprise des alias stockés en JSON vers la table indexée. Idempotent : on
 * peut la rejouer sans risque, et elle ne fait rien une fois passée.
 */
export async function migrerAliasJson(): Promise<{ dossiers: number; alias: number }> {
  await ensureDbReady();
  const dossiers = await db.dossier.findMany({
    select: { id: true, key: true, label: true, aliases: true },
  });
  let alias = 0;
  for (const d of dossiers) {
    const candidats = [d.label, ...safeJson(d.aliases)];
    // La clé propre du dossier doit exister comme alias, sinon la résolution
    // par alias le raterait et en créerait un doublon.
    const avant = await db.dossierAlias.count({ where: { dossierId: d.id } });
    await ajouterAlias(d.id, d.key, d.label, 'reprise');
    for (const c of candidats) {
      const k = cleDossier(c);
      if (k) await ajouterAlias(d.id, k, c, 'reprise');
    }
    const apres = await db.dossierAlias.count({ where: { dossierId: d.id } });
    alias += apres - avant;
  }
  if (alias > 0) logger.info('alias de dossiers repris', { dossiers: dossiers.length, alias });
  return { dossiers: dossiers.length, alias };
}

/**
 * Rattache un mail aux dossiers que son VERDICT SÉMANTIQUE désigne (lot 1).
 * Les `contextHints` sont les dossiers proprement dits ; les entités de type
 * bien, véhicule, société ou contrat en sont aussi, avec leur identifiant s'il
 * a été lu — c'est ce dernier qui recolle ce qu'aucune orthographe ne
 * rapprocherait.
 */
export async function rattacherDepuisVerdict(
  messageId: number,
): Promise<{ rattaches: number }> {
  await ensureDbReady();
  const [contextes, mentions] = await Promise.all([
    db.verdictContext.findMany({
      where: { messageId },
      select: { kind: true, label: true, certainty: true },
    }),
    db.entityMention.findMany({
      where: { messageId, kind: { in: ['property', 'vehicle', 'company', 'contract'] } },
      select: { kind: true, nameRaw: true, identifier: true, certainty: true, role: true },
    }),
  ]);

  const TRAD: Record<string, string> = {
    property: 'bien',
    vehicle: 'vehicule',
    company: 'societe',
    contract: 'reference',
    affair: 'affaire',
    reference: 'reference',
  };

  let rattaches = 0;
  const touches = new Set<number>();
  for (const c of contextes) {
    const r = await rattacher({
      messageId,
      label: c.label,
      kind: TRAD[c.kind] ?? 'autre',
      source: 'ia',
    });
    if (r) {
      rattaches++;
      touches.add(r.dossierId);
    }
  }
  for (const m of mentions) {
    // L'EXPÉDITEUR NE FAIT PAS UN DOSSIER (corrigé le 12/08, sur les cinq
    // premiers verdicts réels). Trois dossiers sur cinq venaient d'être créés
    // ainsi : « LinkedIn », « Revolut Business », « igloohome ». Ce ne sont pas
    // des sujets de vie, ce sont des expéditeurs — et on les suit déjà comme
    // tels dans la table Sender. Un dossier vient de ce dont le mail PARLE :
    // qui émet le document, qui est concerné, qui est facturé.
    if (m.role === 'sent_by') continue;
    // Une société simplement CITÉE ne fait pas un dossier non plus — sinon
    // chaque signature de bas de page en créerait un. Il faut qu'elle soit
    // partie prenante, ou qu'un identifiant dur l'accroche.
    if (m.kind === 'company' && m.role === 'mentioned' && !m.identifier) continue;
    if (m.certainty === 'weak_inference' || m.certainty === 'unknown') continue;
    const r = await rattacher({
      messageId,
      label: m.nameRaw,
      kind: TRAD[m.kind] ?? 'autre',
      identifier: m.identifier,
      source: 'ia',
    });
    if (r) {
      rattaches++;
      touches.add(r.dossierId);
    }
  }
  // Le compteur affiché est recalculé ici : sans ça, l'écran « Mes dossiers »
  // annonçait « 0 mail » sur des dossiers qui venaient d'en recevoir un.
  for (const id of touches) await rafraichir(id);
  return { rattaches };
}

export interface DossierResume {
  id: number;
  key: string;
  label: string;
  kind: string;
  status: string;
  /** manual = renommé par l'utilisateur ; l'analyse ne le réécrira pas. */
  labelSource: string;
  /** Orthographes rencontrées — ce qui explique pourquoi ces mails sont ensemble. */
  aliases: string[];
  /** Identifiants durs (n° de sinistre, de contrat…) qui accrochent le dossier. */
  identifiers: string[];
  messageCount: number;
  firstAt: string | null;
  lastAt: string | null;
  /** Boîtes concernées. */
  accounts: string[];
  /** Nombre d'interlocuteurs distincts — la mesure de « ça traverse ». */
  correspondents: number;
  withAttachments: number;
}

export async function listerDossiers(opts: { limit?: number } = {}): Promise<{
  dossiers: DossierResume[];
  total: number;
}> {
  await ensureDbReady();
  const limit = Math.min(Math.max(opts.limit ?? 40, 1), 200);
  const lignes = await db.dossier.findMany({
    where: { status: { notIn: ['hidden', 'merged'] } },
    orderBy: [{ messageCount: 'desc' }],
    take: limit,
    select: {
      id: true,
      key: true,
      label: true,
      kind: true,
      status: true,
      labelSource: true,
      messageCount: true,
      firstAt: true,
      lastAt: true,
      aliasRows: { select: { label: true }, take: 8 },
      identifiers: { select: { value: true, kind: true }, take: 5 },
      messages: {
        select: {
          message: { select: { accountSlug: true, fromEmail: true, hasAttachments: true } },
        },
      },
    },
  });
  const total = await db.dossier.count({ where: { status: { notIn: ['hidden', 'merged'] } } });
  return {
    total,
    dossiers: lignes.map((d) => {
      const msgs = d.messages.map((x) => x.message).filter(Boolean);
      return {
        id: d.id,
        key: d.key,
        label: d.label,
        kind: d.kind,
        status: d.status,
        labelSource: d.labelSource,
        aliases: [...new Set(d.aliasRows.map((a) => a.label))].filter((a) => a !== d.label),
        identifiers: d.identifiers.map((i) => i.value),
        messageCount: d.messageCount,
        firstAt: d.firstAt?.toISOString() ?? null,
        lastAt: d.lastAt?.toISOString() ?? null,
        accounts: [...new Set(msgs.map((m) => m!.accountSlug))],
        correspondents: new Set(msgs.map((m) => m!.fromEmail).filter(Boolean)).size,
        withAttachments: msgs.filter((m) => m!.hasAttachments).length,
      };
    }),
  };
}
