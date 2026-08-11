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

/**
 * Rattache un mail à un dossier à partir du libellé donné par l'analyse.
 * Crée le dossier au besoin. Idempotent.
 */
export async function rattacher(opts: {
  messageId: number;
  label: string;
  kind?: string;
  source?: string;
}): Promise<{ dossierId: number; cree: boolean } | null> {
  await ensureDbReady();
  const label = String(opts.label ?? '').trim().slice(0, 160);
  const cle = cleDossier(label);
  if (!cle) return null;

  let dossier = await db.dossier.findUnique({ where: { key: cle } });
  let cree = false;
  if (!dossier) {
    dossier = await db.dossier.create({
      data: {
        key: cle,
        label,
        kind: opts.kind && ['bien', 'affaire', 'vehicule', 'societe', 'personne', 'autre'].includes(opts.kind)
          ? opts.kind
          : 'autre',
        aliases: JSON.stringify([label]),
      },
    });
    cree = true;
    logger.info('dossier créé', { key: cle, label });
  } else if (dossier.label !== label) {
    // On mémorise l'orthographe rencontrée : elle servira à la propagation.
    const alias: string[] = safeJson(dossier.aliases);
    if (!alias.includes(label)) {
      alias.push(label);
      await db.dossier.update({
        where: { id: dossier.id },
        data: { aliases: JSON.stringify(alias.slice(0, 20)) },
      });
    }
  }

  await db.dossierMessage.upsert({
    where: { dossierId_messageId: { dossierId: dossier.id, messageId: opts.messageId } },
    create: { dossierId: dossier.id, messageId: opts.messageId, source: opts.source ?? 'ia' },
    update: {},
  });
  return { dossierId: dossier.id, cree };
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
 * PROPAGATION : rattache au dossier les mails qui citent son libellé sans
 * avoir été analysés. C'est ce qui évite d'attendre que l'IA ait relu les
 * 25 000 mails pour qu'un dossier soit complet — le vocabulaire vient d'elle,
 * la recherche est mécanique et gratuite.
 */
export async function propager(dossierId?: number): Promise<{ dossiers: number; ajouts: number }> {
  await ensureDbReady();
  const dossiers = await db.dossier.findMany({
    where: { status: { not: 'hidden' }, ...(dossierId ? { id: dossierId } : {}) },
    select: { id: true, label: true, aliases: true },
  });
  let ajouts = 0;
  for (const d of dossiers) {
    const termes = [d.label, ...safeJson(d.aliases)]
      .map((t) => t.trim())
      .filter((t) => t.length >= 6);
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

export interface DossierResume {
  id: number;
  key: string;
  label: string;
  kind: string;
  status: string;
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
    where: { status: { not: 'hidden' } },
    orderBy: [{ messageCount: 'desc' }],
    take: limit,
    select: {
      id: true,
      key: true,
      label: true,
      kind: true,
      status: true,
      messageCount: true,
      firstAt: true,
      lastAt: true,
      messages: {
        select: {
          message: { select: { accountSlug: true, fromEmail: true, hasAttachments: true } },
        },
      },
    },
  });
  const total = await db.dossier.count({ where: { status: { not: 'hidden' } } });
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
