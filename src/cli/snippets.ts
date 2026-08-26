import { parseArgs } from 'node:util';
import { getAccountRecord, listAccountNames } from '../services/accounts.js';
import { backfillSnippets } from '../services/snippets.js';
import { imapService } from '../services/imap.js';
import { db } from '../db/client.js';
import type { AccountRecord } from '../services/accounts.js';

/**
 * Rattrapage des extraits de mails — y compris les ENVOYÉS (26/08).
 *
 *   npm run snippets -- --sent                      # envoyés, toutes les boîtes
 *   npm run snippets -- --sent -a Brimmo -a lb2i    # envoyés, boîtes choisies
 *   npm run snippets -- --tout -a jojo56_jojo       # reçus + envoyés
 *   npm run snippets -- --sent --max 2000           # plafond par boîte
 *
 * REPRENABLE : chaque passe traite un lot borné et rend `remaining`. On
 * relance tant qu'il reste du travail ET que la passe avance — un dossier
 * IMAP en panne fait rendre 0 mail lu, on passe alors à la boîte suivante
 * plutôt que de tourner en rond (anti-boucle de backfillSnippets).
 */

interface Bilan {
  compte: string;
  lus: number;
  remplis: number;
  vides: number;
  reportes: number;
  liaisons: number;
  restant: number;
  erreur?: string;
}

async function traiterCompte(
  rec: AccountRecord,
  opts: { outbound: 'include' | 'only'; sinceDays: number | null; limit: number; max: number },
): Promise<Bilan> {
  const bilan: Bilan = {
    compte: rec.account,
    lus: 0,
    remplis: 0,
    vides: 0,
    reportes: 0,
    liaisons: 0,
    restant: 0,
  };

  for (let passe = 1; bilan.lus < opts.max; passe++) {
    let r;
    try {
      r = await backfillSnippets(rec, {
        limit: Math.min(opts.limit, opts.max - bilan.lus),
        sinceDays: opts.sinceDays,
        outbound: opts.outbound,
        order: 'oldest',
        onProgress: (m) => console.log(`     ${m}`),
      });
    } catch (err) {
      bilan.erreur = (err as Error).message;
      break;
    }

    bilan.lus += r.scanned;
    bilan.remplis += r.filled;
    bilan.vides += r.empty;
    bilan.reportes += r.deferred;
    bilan.liaisons += r.relies;
    bilan.restant = r.remaining;

    console.log(
      `   passe ${passe} : ${r.scanned} lu(s), ${r.filled} avec texte, ` +
        `${r.empty} sans, reste ${r.remaining}`,
    );

    if (r.remaining === 0) break;
    // Passe blanche : tout le reste attend un réessai (dossier en panne).
    // Insister ne servirait à rien, ces mails ne sont pas perdus.
    if (r.scanned === 0) {
      console.log(`   ⏸️  ${r.remaining} mail(s) en attente de réessai — on passe à la suite.`);
      break;
    }
  }

  return bilan;
}

async function run() {
  const { values } = parseArgs({
    options: {
      account: { type: 'string', short: 'a', multiple: true },
      sent: { type: 'boolean' },
      tout: { type: 'boolean' },
      since: { type: 'string' },
      limit: { type: 'string' },
      max: { type: 'string' },
    },
  });

  const outbound = values.tout ? ('include' as const) : ('only' as const);
  if (!values.sent && !values.tout) {
    console.log(
      '\nPrécise ce qu\'il faut lire :\n' +
        '  --sent   les mails ENVOYÉS seulement (le trou du 26/08)\n' +
        '  --tout   les reçus ET les envoyés\n',
    );
    process.exit(2);
  }

  const sinceDays = values.since ? Number(values.since) : null;
  const limit = values.limit ? Number(values.limit) : 300;
  const max = values.max ? Number(values.max) : Number.MAX_SAFE_INTEGER;

  const noms = values.account?.length ? values.account : await listAccountNames();
  const quoi = outbound === 'only' ? 'mails ENVOYÉS' : 'mails reçus ET envoyés';
  const fenetre = sinceDays === null ? 'tout l\'historique' : `${sinceDays} derniers jours`;
  console.log(`\n=== Extraits : ${quoi} — ${fenetre} — ${noms.length} boîte(s) ===\n`);

  const debut = Date.now();
  const bilans: Bilan[] = [];

  for (const nom of noms) {
    const rec = await getAccountRecord(nom);
    if (!rec) {
      console.log(`⚠️  ${nom} : compte introuvable, ignoré.`);
      continue;
    }
    console.log(`\n📬 ${rec.account}`);
    bilans.push(await traiterCompte(rec, { outbound, sinceDays, limit, max }));
  }

  console.log(`\n${'='.repeat(64)}`);
  console.log('Boîte            Lus   Avec texte   Sans   Reste   Liaisons');
  let totalLus = 0;
  let totalRemplis = 0;
  for (const b of bilans) {
    totalLus += b.lus;
    totalRemplis += b.remplis;
    console.log(
      `${b.compte.padEnd(16)} ${String(b.lus).padStart(5)} ` +
        `${String(b.remplis).padStart(12)} ${String(b.vides).padStart(6)} ` +
        `${String(b.restant).padStart(7)} ${String(b.liaisons).padStart(10)}` +
        (b.erreur ? `   ⚠️ ${b.erreur}` : ''),
    );
  }
  const min = ((Date.now() - debut) / 60_000).toFixed(1);
  console.log(`${'='.repeat(64)}`);
  console.log(`✅ ${totalRemplis} extrait(s) capturé(s) sur ${totalLus} mail(s) lu(s) en ${min} min\n`);

  await imapService.closeAll();
  await db.$disconnect();
}

run().catch(async (err) => {
  console.error('\n❌ Échec du rattrapage :', (err as Error).message, '\n');
  await imapService.closeAll().catch(() => {});
  await db.$disconnect().catch(() => {});
  process.exit(1);
});
