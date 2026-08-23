import { performance } from 'node:perf_hooks';
import { db, ensureDbReady } from '../db/client.js';
import { find } from '../services/find.js';
import { decouperTermes } from '../services/termes.js';
import { deplie } from '../services/accents.js';

/**
 * Le banc de la RECHERCHE (23/08) — `npm run banc:search`.
 *
 * À lancer SUR LE SERVEUR, jamais en local : ici la base ne compte qu'une
 * poignée de mails de test, et tout paraît parfait. C'est la leçon du banc
 * d'analyse (« le banc n'a de sens QUE sur le serveur »).
 *
 * Il rejoue des recherches réelles et dit, pour chacune : ce qui a été compris
 * de la phrase, combien de mails sortent, combien d'interlocuteurs, en combien
 * de temps, et s'il a fallu se rabattre sur moins de mots. Deux usages :
 *
 *  - AVANT / APRÈS une modification du moteur : garder la sortie et comparer ;
 *  - vérifier qu'une paire accentuée rend bien le MÊME nombre de mails —
 *    c'est le contrôle direct du défaut « republique / République ».
 *
 * Une recherche à ajouter ? La mettre dans RECHERCHES, ou en passer une en
 * argument : `npm run banc:search -- "facture électricité miron"`.
 */

/** Les recherches du banc. Les paires accentuées doivent CONVERGER. */
const RECHERCHES = [
  'facture',
  'republique',
  'République',
  'electricite',
  'électricité',
  'quittance loyer',
  'facture électricité',
  'avis imposition',
  'rib',
  'nimes',
];

interface Ligne {
  q: string;
  mots: string[];
  ecartes: string[];
  mails: number;
  groupes: number;
  ms: number;
  repli: string;
  absents: string[];
}

async function mesurer(q: string): Promise<Ligne> {
  const t = decouperTermes(q);
  const debut = performance.now();
  const r = await find({ q, maxGroups: 8, perGroup: 3 });
  return {
    q,
    mots: t.mots,
    ecartes: t.ecartes,
    mails: r.total,
    groupes: r.totalGroups,
    ms: Math.round(performance.now() - debut),
    repli: r.recherche.repli,
    absents: r.recherche.motsAbsents,
  };
}

async function main(): Promise<void> {
  await ensureDbReady();
  const demandees = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const liste = demandees.length ? demandees : RECHERCHES;

  const total = await db.message.count({ where: { isDeleted: false } });
  console.log(`\nBanc de recherche — ${total.toLocaleString('fr-FR')} mails indexés\n`);
  console.log(
    `${'recherche'.padEnd(24)}${'mots compris'.padEnd(34)}${'mails'.padStart(7)}` +
      `${'interloc.'.padStart(10)}${'temps'.padStart(9)}   repli`,
  );
  console.log('─'.repeat(100));

  const lignes: Ligne[] = [];
  for (const q of liste) {
    const l = await mesurer(q);
    lignes.push(l);
    const repli =
      l.repli === 'aucun'
        ? ''
        : l.repli === 'mots-absents'
          ? `sans « ${l.absents.join(' », « ')} »`
          : l.repli;
    console.log(
      `${l.q.padEnd(24)}${l.mots.join(' · ').slice(0, 32).padEnd(34)}` +
        `${l.mails.toLocaleString('fr-FR').padStart(7)}${String(l.groupes).padStart(10)}` +
        `${`${l.ms} ms`.padStart(9)}   ${repli}`,
    );
  }

  // --- Les paires accentuées convergent-elles ? ------------------------------
  // C'est le contrôle qui compte : deux orthographes du même mot doivent rendre
  // le même nombre de mails. Tant qu'elles divergent, le défaut est là — et il
  // est silencieux, donc personne ne le verrait sans cette ligne.
  const parCle = new Map<string, Ligne[]>();
  for (const l of lignes) {
    if (l.mots.length !== 1) continue;
    const cle = deplie(l.mots[0]);
    parCle.set(cle, [...(parCle.get(cle) ?? []), l]);
  }
  const paires = [...parCle.values()].filter((g) => g.length > 1);
  if (paires.length) {
    console.log('\n--- même mot, deux orthographes ---');
    for (const g of paires) {
      const memeCompte = g.every((l) => l.mails === g[0].mails);
      console.log(
        `  ${memeCompte ? '✅' : '❌'} ${g.map((l) => `« ${l.q} » ${l.mails}`).join('   /   ')}` +
          `${memeCompte ? '' : '   ← elles devraient rendre le même nombre'}`,
      );
    }
  }

  const moyenne = Math.round(lignes.reduce((s, l) => s + l.ms, 0) / lignes.length);
  const pire = lignes.reduce((a, b) => (b.ms > a.ms ? b : a));
  console.log(`\nTemps moyen ${moyenne} ms · le plus lent « ${pire.q} » à ${pire.ms} ms\n`);
  await db.$disconnect();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
