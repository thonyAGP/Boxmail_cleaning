import { parseArgs } from 'node:util';
import { detecterAnomalies, phraseDe, type Anomalie } from '../services/anomalies.js';
import { listerObligations, bilan } from '../services/obligations.js';
import { db } from '../db/client.js';

/**
 * Mesure du détecteur de fumée et des obligations — AVANT tout écran.
 *
 *   npm run anomalies                    # top 30 + bilan des obligations
 *   npm run anomalies -- --top 50        # le lot à auditer (étape 3)
 *   npm run anomalies -- --seuil 70
 *   npm run anomalies -- --obligations   # détail des promesses non tenues
 *
 * La règle maison : on simule sur les données réelles et on LIT le résultat à
 * la main avant de coder quoi que ce soit d'utilisateur. Ce qui compte n'est
 * pas le volume détecté mais la proportion de vrais positifs dans le haut du
 * classement.
 */

const jours = (d: Date) => Math.round((Date.now() - d.getTime()) / 86_400_000);

function ligne(a: Anomalie, i: number): void {
  const age = jours(a.dernierAt);
  const quand = age > 60 ? `${Math.round(age / 30)} mois` : `${age} j`;
  console.log(
    `\n${String(i + 1).padStart(3)}. [${String(a.score).padStart(3)}] ${a.correspondantNom || a.correspondant}`,
  );
  console.log(`     ${a.sujet.slice(0, 74)}`);
  console.log(
    `     ${a.accountSlug} · ${a.nature} · dernier mouvement il y a ${quand}` +
      (a.aObligation ? '' : '  ⚠️ aucune obligation extraite'),
  );
  console.log(`     → ${phraseDe(a)}`);
}

async function run() {
  const { values } = parseArgs({
    options: {
      top: { type: 'string' },
      seuil: { type: 'string' },
      depuis: { type: 'string' },
      obligations: { type: 'boolean' },
    },
  });

  const top = Number(values.top ?? 30);
  const seuil = Number(values.seuil ?? 50);
  const depuis = values.depuis ? Number(values.depuis) : null;

  console.log(`\n=== DÉTECTEUR DE FUMÉE — seuil ${seuil}${depuis ? `, ${depuis} derniers jours` : ''} ===`);
  const t0 = Date.now();
  const anomalies = await detecterAnomalies({ seuil, depuisJours: depuis });
  console.log(`${anomalies.length} fil(s) retenu(s) en ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  // Répartition : c'est elle qui dit si le tri sépare vraiment.
  const parNature = new Map<string, number>();
  const sansObligation = anomalies.filter((a) => !a.aObligation).length;
  for (const a of anomalies) parNature.set(a.nature, (parNature.get(a.nature) ?? 0) + 1);
  console.log(
    '  par nature :',
    [...parNature.entries()].sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k}=${v}`).join(' · '),
  );
  console.log(
    `  sans obligation extraite : ${sansObligation}` +
      ` (${Math.round((sansObligation / Math.max(anomalies.length, 1)) * 100)} %)` +
      ' — ce sont les angles morts de l’analyse',
  );

  console.log(`\n=== TOP ${top} ===`);
  anomalies.slice(0, top).forEach(ligne);

  console.log('\n\n=== OBLIGATIONS (converties des verdicts, sans IA) ===');
  const obligations = await listerObligations();
  const b = bilan(obligations);
  console.log(`  total : ${b.total}  |  moi : ${b.parCote.moi}  |  eux : ${b.parCote.eux}`);
  console.log(
    '  par état :',
    Object.entries(b.parEtat).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k}=${v}`).join(' · '),
  );
  console.log(`  ouvertes ET en retard : ${b.ouvertesEnRetard}`);
  console.log(`  PROMESSES DE TIERS non tenues : ${b.promessesNonTenues}`);

  if (values.obligations) {
    console.log('\n=== promesses de tiers, en retard, sans signe de vie ===');
    obligations
      .filter((o) => o.cote === 'eux' && o.etat === 'ouverte' && o.enRetardDeJours)
      .slice(0, 25)
      .forEach((o) => {
        console.log(`\n  ${o.correspondant.slice(0, 40)} · ${o.accountSlug}`);
        console.log(`    ${o.sujet.slice(0, 66)}`);
        console.log(`    [${o.kind}] ${(o.label || '').slice(0, 68)}`);
        console.log(`    en retard de ${o.enRetardDeJours} j — ${o.motif}`);
        if (o.evidence) console.log(`    « ${o.evidence.replace(/\s+/g, ' ').slice(0, 76)} »`);
      });

    console.log('\n=== ce que je dois faire, en retard ===');
    obligations
      .filter((o) => o.cote === 'moi' && o.etat === 'ouverte' && o.enRetardDeJours)
      .slice(0, 15)
      .forEach((o) => {
        const m = o.amount ? ` — ${o.amount.toFixed(2)} €` : '';
        console.log(
          `  ${String(o.enRetardDeJours).padStart(5)} j | ${o.kind.padEnd(17)} | ` +
            `${(o.label || o.sujet).slice(0, 52)}${m}`,
        );
      });
  }

  console.log('');
  await db.$disconnect();
}

run().catch(async (err) => {
  console.error('\n❌', (err as Error).message, '\n');
  await db.$disconnect().catch(() => {});
  process.exit(1);
});
