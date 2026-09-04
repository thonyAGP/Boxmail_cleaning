import { readFileSync } from 'node:fs';
import { db } from '../db/client.js';

/**
 * Les 14 attentes établies par l'AUDIT du 26/08 (50 histoires relues une par
 * une, 15 vrais positifs dont 2 doublons fusionnés).
 *
 * POURQUOI EN DUR ICI, et pourquoi c'est provisoire : l'audit a été mené par
 * un modèle sur des dossiers compacts, hors du serveur. L'automatiser est
 * l'étape suivante. En attendant, ces attentes sont RÉELLES et vérifiées — les
 * inventer aurait été le pire des raccourcis, les jeter aurait fait perdre le
 * seul contenu qui permet de juger l'écran.
 *
 * Chaque ligne porte sa justification, telle qu'elle s'affichera : « la
 * possibilité d'expliquer pourquoi est presque aussi importante que la
 * détection ».
 *
 *   npm run attentes:seed          # insère ce qui manque (idempotent)
 *   npm run attentes:seed -- --raz # efface les attentes issues de l'audit
 */

interface Graine {
  cote: 'moi' | 'eux';
  quoi: string;
  qui: string;
  quiEmail?: string;
  accountSlug: string;
  importance: 'haute' | 'moyenne' | 'faible';
  urgence: 'critique' | 'haute' | 'moyenne' | 'faible';
  pourquoi: string;
  risque?: string;
  dueAt?: string;
  montant?: number;
}

const GRAINES: Graine[] = [
  // Trois attentes INVENTÉES, pour qu'un poste neuf ait de quoi rendre l'écran.
  // Les vraies vivent dans data/ (voir chargerGraines ci-dessous).
  {
    cote: 'moi',
    quoi: 'Régler 418 € à la caisse de cotisations avant le 29 août',
    qui: 'Caisse de cotisations — ACME',
    accountSlug: 'demo_pro',
    importance: 'haute',
    urgence: 'critique',
    pourquoi: 'Mise en demeure reçue, majorations au-delà de la date.',
    montant: 418,
  },
  {
    cote: 'eux',
    quoi: 'Attendre le devis du charpentier pour la toiture',
    qui: 'ACME charpente',
    accountSlug: 'demo_pro',
    importance: 'moyenne',
    urgence: 'moyenne',
    pourquoi: 'Demandé il y a trois semaines, relancé une fois, sans réponse.',
  },
  {
    cote: 'eux',
    quoi: 'Attendre le remboursement du trop-perçu de charges',
    qui: 'Syndic ACME',
    accountSlug: 'demo_perso',
    importance: 'moyenne',
    urgence: 'faible',
    pourquoi: 'Régularisation annuelle annoncée en juin, jamais versée.',
    montant: 236.4,
  },
];


/**
 * Les attentes RÉELLES ne sont pas dans le dépôt (04/09/2026) : ce fichier est
 * publié, et elles nomment des personnes physiques — une avocate, un géomètre,
 * un assuré — avec des montants et des litiges en cours. Elles vivent
 * désormais dans `data/attentes-reelles.json`, que .gitignore couvre.
 *
 * Sans ce fichier (poste neuf, clone frais), le seed pose les trois graines
 * fictives ci-dessus : l'écran a de quoi se rendre, personne n'est nommé.
 */
function chargerGraines(): Graine[] {
  const chemin = new URL('../../data/attentes-reelles.json', import.meta.url);
  try {
    const brut = readFileSync(chemin, 'utf8');
    const graines = JSON.parse(brut) as Graine[];
    if (!Array.isArray(graines) || graines.length === 0) throw new Error('fichier vide');
    console.log(`${graines.length} attentes réelles chargées depuis data/attentes-reelles.json`);
    return graines;
  } catch (e) {
    const raison = e instanceof Error ? e.message : String(e);
    console.log(`data/attentes-reelles.json illisible (${raison}) — graines fictives utilisées.`);
    return GRAINES;
  }
}

async function run() {
  const raz = process.argv.includes('--raz');
  if (raz) {
    const n = await db.attente.deleteMany({ where: { source: 'audit' } });
    console.log(`${n.count} attente(s) issues de l'audit supprimée(s).`);
    await db.$disconnect();
    return;
  }

  let ajoutees = 0;
  for (const g of chargerGraines()) {
    // Idempotent : la paire (qui, quoi) identifie l'attente.
    const deja = await db.attente.findFirst({ where: { qui: g.qui, quoi: g.quoi } });
    if (deja) continue;
    await db.attente.create({
      data: {
        cote: g.cote,
        quoi: g.quoi,
        qui: g.qui,
        quiEmail: g.quiEmail ?? null,
        accountSlug: g.accountSlug,
        importance: g.importance,
        urgence: g.urgence,
        pourquoi: g.pourquoi,
        risque: g.risque ?? null,
        dueAt: g.dueAt ? new Date(g.dueAt) : null,
        montant: g.montant ?? null,
        devise: g.montant ? 'EUR' : null,
        source: 'audit',
      },
    });
    ajoutees++;
  }
  const total = await db.attente.count({ where: { etat: { in: ['ouverte', 'probable'] } } });
  console.log(`${ajoutees} attente(s) ajoutée(s) — ${total} ouverte(s) au total.`);
  await db.$disconnect();
}

run().catch(async (err) => {
  console.error('\n❌', (err as Error).message, '\n');
  await db.$disconnect().catch(() => {});
  process.exit(1);
});
