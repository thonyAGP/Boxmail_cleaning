import { parseArgs } from 'node:util';
import { writeFileSync } from 'node:fs';
import { detecterAnomalies, phraseDe } from '../services/anomalies.js';
import { listerObligations, type Obligation } from '../services/obligations.js';
import { db } from '../db/client.js';

/**
 * Prépare l'AUDIT D'HISTOIRE (étape 3 du MVP, 26/08).
 *
 * « Le but n'est plus d'analyser le mail. Le but est de faire l'audit d'une
 * histoire. » — contre-revue du 26/08.
 *
 * Ce CLI n'appelle aucune IA : il assemble, pour les N fils les plus suspects,
 * un dossier COMPACT qu'un modèle pourra juger d'un coup. Compact est le mot
 * important : la leçon la plus chère du projet est qu'une conversation qui
 * cumule ses lots meurt vers 60 mails (plantages mesurés à 821 Ko et 934 Ko).
 * On vise donc ~2 Ko par fil, pas les messages entiers.
 *
 *   npm run audit:export -- --top 50 --out dossiers.txt
 */

const EXTRAIT_MAX = 260;
const MSG_MAX = 12;

const d10 = (t: number | Date) => new Date(t).toISOString().slice(0, 10);
const plat = (s: string | null, n = EXTRAIT_MAX) =>
  (s || '').replace(/\s+/g, ' ').trim().slice(0, n);

async function run() {
  const { values } = parseArgs({
    options: { top: { type: 'string' }, out: { type: 'string' }, seuil: { type: 'string' } },
  });
  const top = Number(values.top ?? 50);
  const seuil = Number(values.seuil ?? 50);

  const anomalies = (await detecterAnomalies({ seuil })).slice(0, top);
  const obligations = await listerObligations();
  const parFil = new Map<number, Obligation[]>();
  for (const o of obligations) {
    if (o.threadId == null) continue;
    const arr = parFil.get(o.threadId) ?? [];
    arr.push(o);
    parFil.set(o.threadId, arr);
  }

  const blocs: string[] = [];
  for (const [i, a] of anomalies.entries()) {
    // Les messages du fil, bornés : les plus anciens ET les plus récents, car
    // une histoire se juge par son début et par son état actuel.
    const msgs = await db.$queryRawUnsafe<
      {
        id: number; date: number; isOutbound: number; fromEmail: string | null;
        fromName: string | null; subject: string | null; snippet: string | null;
        att: number; noms: string | null;
      }[]
    >(
      `SELECT m.id, m.date, m.isOutbound, m.fromEmail, m.fromName, m.subject,
              m.snippet, COALESCE(m.attachmentCount,0) att, m.attachmentNames noms
         FROM Message m
        WHERE m.threadId = ?1 AND m.isDeleted = 0
        ORDER BY m.date ASC`,
      a.threadId,
    );

    const choisis =
      msgs.length <= MSG_MAX
        ? msgs
        : [...msgs.slice(0, 4), ...msgs.slice(-(MSG_MAX - 4))];
    const saute = msgs.length - choisis.length;

    const lignes = choisis.map((m) => {
      const sens = Number(m.isOutbound) === 1 ? 'MOI  →' : '← EUX';
      const pj = Number(m.att) > 0 ? ` [${m.att} PJ: ${plat(m.noms, 60)}]` : '';
      const txt = plat(m.snippet);
      return `  ${d10(Number(m.date))} ${sens} ${plat(m.subject, 64)}${pj}\n` +
        (txt ? `        « ${txt} »\n` : '');
    });

    const obs = (parFil.get(a.threadId) ?? []).map((o) => {
      const qui = o.cote === 'moi' ? 'MOI' : 'EUX';
      const due = o.dueAt ? ` avant ${d10(o.dueAt)}` : '';
      const ret = o.enRetardDeJours ? ` (retard ${o.enRetardDeJours} j)` : '';
      const mt = o.amount ? ` — ${o.amount.toFixed(2)} ${o.currency || 'EUR'}` : '';
      return `  · [${qui}] ${o.kind}${due}${ret}${mt} — ${plat(o.label, 90)}\n` +
        `    état actuel : ${o.etat} (${o.motif})`;
    });

    blocs.push(
      [
        `################ FIL ${i + 1}/${anomalies.length} — id ${a.threadId} — score ${a.score}`,
        `Boîte        : ${a.accountSlug}`,
        `Correspondant: ${a.correspondantNom || ''} <${a.correspondant}>`,
        `Sujet        : ${a.sujet}`,
        `Période      : ${d10(a.premierAt)} → ${d10(a.dernierAt)}` +
          `  (${Math.round((Date.now() - a.dernierAt.getTime()) / 86_400_000)} j sans mouvement)`,
        `Nature devinée: ${a.nature}${a.aObligation ? '' : '   ⚠️ AUCUNE obligation extraite par l’analyse'}`,
        `Pourquoi signalé : ${phraseDe(a)}`,
        '',
        'MESSAGES' + (saute > 0 ? ` (${saute} du milieu omis)` : ''),
        ...lignes,
        obs.length ? 'OBLIGATIONS DÉJÀ EXTRAITES' : 'OBLIGATIONS DÉJÀ EXTRAITES : aucune',
        ...obs,
        '',
      ].join('\n'),
    );
  }

  const texte = blocs.join('\n');
  const chemin = values.out || 'dossiers-audit.txt';
  writeFileSync(chemin, texte, 'utf8');
  console.log(
    `${anomalies.length} dossier(s) écrits dans ${chemin} — ${Math.round(texte.length / 1024)} Ko ` +
      `(${Math.round(texte.length / Math.max(anomalies.length, 1))} o par fil)`,
  );

  await db.$disconnect();
}

run().catch(async (err) => {
  console.error('\n❌', (err as Error).message, '\n');
  await db.$disconnect().catch(() => {});
  process.exit(1);
});
