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
  {
    cote: 'moi',
    quoi: 'Régler 418 € à l’URSSAF avant le 29 août',
    qui: 'URSSAF — LB2I',
    accountSlug: 'lb2i',
    importance: 'haute',
    urgence: 'critique',
    pourquoi:
      'Dernier avis avant poursuites reçu le 13 août, après deux recommandés. 1 089 € sont déjà en retard (mars-avril-mai) et rien n’indique un règlement.',
    risque: 'Poursuites annoncées — majorations et recouvrement forcé',
    dueAt: '2026-08-29',
    montant: 418,
  },
  {
    cote: 'eux',
    quoi: 'Réponse à ma réclamation sur le sinistre MECHACHE',
    qui: 'Insured — service juridique',
    quiEmail: 'servicejuridique@insured.fr',
    accountSlug: 'Altoen',
    importance: 'haute',
    urgence: 'haute',
    pourquoi:
      'Tu as contesté le solde de tout compte le 25 avril 2024. Ils se sont engagés PAR ÉCRIT à répondre sous deux mois. Vingt-huit mois plus tard, rien.',
    risque: 'Prescription biennale en assurance — le délai d’action se referme',
    dueAt: '2024-06-26',
  },
  {
    cote: 'moi',
    quoi: 'Signature de la convention d’honoraires',
    qui: 'Me Zanitti — avocate',
    accountSlug: 'Brimmo',
    importance: 'haute',
    urgence: 'haute',
    pourquoi:
      'Convention envoyée le 28 janvier 2025, relancée le 17 février. Sans ta signature, ton action contre le maître d’œuvre du 46 rue de la République n’a jamais démarré.',
    risque: 'Délais de l’action en construction — ils courent depuis la réception des travaux',
  },
  {
    cote: 'eux',
    quoi: 'L’acte de vente du 46 rue de la République',
    qui: 'Me Poitevin — notaire',
    accountSlug: 'Brimmo',
    importance: 'haute',
    urgence: 'moyenne',
    pourquoi:
      'Tu l’as demandé le 14 novembre 2023 et n’as jamais eu de réponse. La copropriété a bien été créée et publiée, mais l’acte lui-même ne t’est jamais parvenu.',
    risque: 'Pièce structurante pour la SARL : comptabilité, banque, revente',
    dueAt: '2023-11-28',
  },
  {
    cote: 'eux',
    quoi: 'Indemnisation de la détérioration immobilière + 2 mois de récupération des meubles',
    qui: 'Insured — garantie loyers impayés',
    accountSlug: 'Altoen',
    importance: 'haute',
    urgence: 'moyenne',
    pourquoi:
      'L’assureur s’est engagé à indemniser après l’état des lieux de sortie obtenu en février 2024, puis n’a plus donné suite. Tes deux relances de novembre 2025 sont restées sans réponse.',
    dueAt: '2025-12-27',
  },
  {
    cote: 'eux',
    quoi: 'Le point sur les prises de garanties de BRIMMO après le rachat des parts',
    qui: 'Crédit Agricole du Morbihan',
    accountSlug: 'Brimmo',
    importance: 'haute',
    urgence: 'moyenne',
    pourquoi:
      'Ton conseiller a accusé réception le 25 septembre 2024 et annoncé revenir « début de semaine prochaine ». Vingt-trois mois de silence : les garanties peuvent être restées à l’ancienne répartition.',
    risque: 'Garanties bancaires potentiellement inexactes après cession de parts',
    dueAt: '2024-10-02',
  },
  {
    cote: 'eux',
    quoi: 'Le bilan 2025 de la SARL ECONOM',
    qui: 'Comptastar',
    accountSlug: 'Econom',
    importance: 'haute',
    urgence: 'haute',
    pourquoi:
      'Tu as transmis les relevés bancaires 2025 le 10 avril 2026, via Pennylane et par mail. Aucun retour depuis quatre mois et demi.',
    risque: 'Le dépôt des comptes a une échéance légale',
  },
  {
    cote: 'eux',
    quoi: 'Le juriste annoncé pour l’AG et le dépôt des comptes 2024 d’ECONOM',
    qui: 'Comptastar — Loïse Barbis',
    accountSlug: 'Econom',
    importance: 'haute',
    urgence: 'moyenne',
    pourquoi:
      'Tu as donné ton accord le 1er septembre 2025 ; le cabinet a confirmé qu’« un juriste va vous contacter ». Douze mois plus tard, aucune trace par mail. Le dépôt au RCS se vérifie en ligne.',
    risque: 'Obligation légale de dépôt des comptes au greffe',
  },
  {
    cote: 'eux',
    quoi: 'Les plans numériques du 46 rue de la République',
    qui: 'Cabinet KIBLER — géomètre',
    accountSlug: 'Brimmo',
    importance: 'moyenne',
    urgence: 'faible',
    pourquoi:
      'Tu as réglé la facture de 2 281 € le jour de la relance et demandé les plans au format numérique, prévus au devis. Jamais reçus, jamais refusés.',
    montant: 2281,
  },
  {
    cote: 'moi',
    quoi: 'Proposition d’honoraires pour le 31/33 rue François Miron',
    qui: 'Atelier d’Architecture Jérôme Leroy',
    accountSlug: 'thony56_gtr',
    importance: 'moyenne',
    urgence: 'haute',
    pourquoi:
      'Proposition de mission, estimatif et devis couverture reçus le 4 mai 2026, sans réponse de ta part. L’AG du 3 juin est passée et tu ne sais pas ce qui y a été voté.',
  },
  {
    cote: 'moi',
    quoi: 'Facture de la mission à émettre',
    qui: 'Jump — portage LB2I',
    accountSlug: 'lb2i',
    importance: 'haute',
    urgence: 'haute',
    pourquoi:
      'Le 29 juillet 2026, Jump a confirmé que le contrat LB2I est signé des deux parties et la mission en cours : « vous pouvez dès à présent facturer ». La facture n’est pas partie.',
  },
  {
    cote: 'moi',
    quoi: 'Régler 150 € de franchise (sinistre K0021606)',
    qui: 'Resilians — agence de Brest',
    accountSlug: 'Brimmo',
    importance: 'moyenne',
    urgence: 'moyenne',
    pourquoi:
      'Deuxième relance le 8 juin 2026, RIB joint. À noter : ils t’avaient d’abord réclamé 577,79 € TVA comprise avant de reconnaître que seule la franchise de 150 € reste due.',
    montant: 150,
  },
  {
    cote: 'moi',
    quoi: 'Facture BIONAT F202601-4836 — à régler ou contester',
    qui: 'Lydia — BIONAT ENERGIES',
    accountSlug: 'Au-marais',
    importance: 'moyenne',
    urgence: 'moyenne',
    pourquoi:
      'Facture du 22 janvier 2026 relancée deux fois, le 19 mars puis le 9 avril sur un ton qui monte. Tu n’as jamais répondu.',
    montant: 258.5,
  },
  {
    cote: 'moi',
    quoi: 'Paiement des deux factures de plomberie Jaffrès 2026',
    qui: 'Jaffrès plomberie — chantier 46 rue de la République',
    accountSlug: 'Brimmo',
    importance: 'moyenne',
    urgence: 'faible',
    pourquoi:
      'Les factures 2026-25 (janvier) et 2026-86 (avril) sont sans trace de règlement, sur un chantier encore actif. Les factures antérieures, elles, n’ont jamais été relancées.',
  },
];

async function run() {
  const raz = process.argv.includes('--raz');
  if (raz) {
    const n = await db.attente.deleteMany({ where: { source: 'audit' } });
    console.log(`${n.count} attente(s) issues de l'audit supprimée(s).`);
    await db.$disconnect();
    return;
  }

  let ajoutees = 0;
  for (const g of GRAINES) {
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
