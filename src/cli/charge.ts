import { db } from '../db/client.js';
import { chargeDecisionnelle } from '../services/oplog.js';

/**
 * LA CHARGE DÉCISIONNELLE — combien de fois le produit a demandé à Anthony de
 * trancher, rapporté à ce qu'il a reçu.
 *
 * POURQUOI CE CLI EXISTE. Le KPI était écrit depuis le 10/08 dans
 * `docs/PLAN-ASSISTANT.md` : « nombre de décisions humaines pour 100 mails
 * reçus. Cible : 100 mails → 10 à 20 décisions, puis 5 à 10 ». Assorti d'une
 * règle de passage : « on ne passe pas à la phase suivante parce que la
 * fonctionnalité est finie, mais quand le nombre de décisions demandées a
 * réellement baissé ». Douze livraisons ont suivi sans qu'il soit mesuré une
 * seule fois — donc sans qu'on sache si sa charge montait ou descendait.
 *
 * ⚠️ CE CHIFFRE NE SE LIT JAMAIS SEUL. Il s'optimise pathologiquement : le
 * meilleur produit du monde selon cette métrique serait celui qui ne montre
 * RIEN. Il se lit contre ce qui a été MANQUÉ, et la règle est de faire baisser
 * la charge À COUVERTURE CONSTANTE OU MEILLEURE. C'est pourquoi la sortie
 * affiche toujours les deux colonnes, et refuse de conclure à la place du
 * lecteur.
 *
 *   npm run charge              # 14 jours
 *   npm run charge -- --jours 30
 */

const arg = (nom: string): string | undefined => {
  const i = process.argv.indexOf(`--${nom}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function run() {
  const jours = Math.min(Math.max(Number(arg('jours') ?? 14), 1), 120);
  const charge = await chargeDecisionnelle(jours);

  console.log(`\n=== CHARGE DÉCISIONNELLE — ${jours} derniers jours ===\n`);
  if (!charge.length) {
    console.log('Aucune décision classée dans le journal.');
    console.log('Normal juste après la mise en place : le champ `decision` ne');
    console.log('vaut que pour les opérations écrites depuis.\n');
    await db.$disconnect();
    return;
  }

  console.log('jour         reçus   demandées   pour 100   autonomes   annulées');
  console.log('─'.repeat(70));

  let totalRecus = 0;
  let totalHumaines = 0;
  let totalAuto = 0;
  let totalAnnulees = 0;

  for (const j of charge) {
    const debut = new Date(`${j.jour}T00:00:00.000Z`);
    const fin = new Date(debut.getTime() + 86_400_000);
    // Même définition de « mail reçu » que le brief : entrant, hors corbeille,
    // daté par son indexation.
    const recus = await db.message.count({
      where: {
        isDeleted: false,
        isOutbound: false,
        createdAt: { gte: debut, lt: fin },
        folder: { is: { role: { notIn: ['trash', 'spam', 'drafts'] } } },
      },
    });
    totalRecus += recus;
    totalHumaines += j.humaines;
    totalAuto += j.auto;
    totalAnnulees += j.annulees;
    const pour100 = recus > 0 ? ((100 * j.humaines) / recus).toFixed(1) : '—';
    console.log(
      `${j.jour}   ${String(recus).padStart(5)}   ${String(j.humaines).padStart(9)}   ` +
        `${pour100.padStart(8)}   ${String(j.auto).padStart(9)}   ${String(j.annulees).padStart(8)}`,
    );
  }

  console.log('─'.repeat(70));
  const global = totalRecus > 0 ? ((100 * totalHumaines) / totalRecus).toFixed(1) : '—';
  console.log(
    `TOTAL        ${String(totalRecus).padStart(5)}   ${String(totalHumaines).padStart(9)}   ` +
      `${global.padStart(8)}   ${String(totalAuto).padStart(9)}   ${String(totalAnnulees).padStart(8)}`,
  );

  console.log(`\n— DÉCISIONS DEMANDÉES POUR 100 MAILS REÇUS : ${global} —`);
  console.log('  Cible du plan : 10 à 20, puis 5 à 10.');

  if (totalAuto > 0) {
    const contradiction = ((100 * totalAnnulees) / totalAuto).toFixed(1);
    console.log(
      `\n— TAUX DE CONTRADICTION : ${contradiction} % (${totalAnnulees} annulations ` +
        `sur ${totalAuto} décisions autonomes) —`,
    );
    console.log("  Obtenu sans lui poser une seule question. Au-delà de ~10 %,");
    console.log('  ce n’est plus lui qui se ravise : c’est l’assistant qui se trompe.');
  }

  console.log('\n⚠️  Ce chiffre ne vaut RIEN seul : une charge qui baisse parce que');
  console.log("   l'écran montre moins n'est pas un progrès, c'est un enterrement.");
  console.log('   À lire contre la couverture — ce qui a été manqué.\n');

  await db.$disconnect();
}

run().catch(async (err) => {
  console.error('\n❌', (err as Error).message, '\n');
  await db.$disconnect().catch(() => {});
  process.exit(1);
});
