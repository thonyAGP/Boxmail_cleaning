import { config } from '../config.js';
import { db, ensureDbReady } from '../db/client.js';
import {
  candidatsRecherche,
  hydraterMessages,
  MATCH_CONTENU_PIECE,
  MATCH_NOM_PIECE,
  MATCH_RESUME,
  MATCH_SUJET,
  MATCH_TEXTE,
  type CandidatRecherche,
  type SearchResultItem,
} from './search.js';
import { decouperTermes } from './termes.js';

const MAX_PREUVES = 8;
const EXTRAIT_PAR_PREUVE = 2_400;
const NIE_RE = /\b[XYZ]\s*[- ]?\s*\d{7}\s*[- ]?\s*[A-Z]\b/iu;
const DEMANDE_RE = /\b(demande|solicitud|solicito|cita|rendez-vous|envoyer|envoi|tramitar|trámite|documentaci[oó]n requise)\b/iu;
const REPONSE_RE = /\b(consulat|consulado|polic[ií]a|extranjer[ií]a|resoluci[oó]n|certificat|certificado|asignaci[oó]n|concedido|documento adjunto)\b/iu;

export interface PreuveReponse {
  numero: number;
  item: SearchResultItem;
  extrait: string;
  score: number;
  signaux: string[];
}

export interface ReponseRecherche {
  question: string;
  answer: string | null;
  configured: boolean;
  model: string | null;
  warning: string | null;
  sources: PreuveReponse[];
}

/**
 * Score de PREUVE, distinct du score de résultat de find.ts.
 *
 * Une demande envoyée contenant « NIE » prouve seulement qu'on l'a demandé.
 * Un retour reçu, un document nommé NIE ou un texte portant la forme réelle
 * d'un NIE constituent des preuves. Ce score sert seulement à choisir le petit
 * dossier lu par le modèle ; le modèle doit encore citer ses sources.
 */
export function scorePreuve(
  c: Pick<CandidatRecherche, 'isOutbound' | 'hasAttachments' | 'mask' | 'subject' | 'attachmentNames'>,
  contenu = '',
): { score: number; signaux: string[] } {
  const signaux: string[] = [];
  let score = 0;
  if (!c.isOutbound) { score += 5; signaux.push('mail reçu'); }
  else { score -= 5; signaux.push('mail envoyé'); }
  if (c.hasAttachments) { score += 4; signaux.push('porte un document'); }
  if (c.mask & MATCH_NOM_PIECE) { score += 9; signaux.push('terme dans le nom du document'); }
  if (c.mask & MATCH_SUJET) score += 4;
  if (c.mask & MATCH_CONTENU_PIECE) { score += 5; signaux.push('terme lu dans le document'); }
  if (c.mask & MATCH_RESUME) score += 2;
  if (c.mask & MATCH_TEXTE) score += 1;

  const texte = `${c.subject}\n${c.attachmentNames}\n${contenu}`;
  if (NIE_RE.test(texte)) { score += 18; signaux.push('numéro au format NIE détecté'); }
  if (REPONSE_RE.test(texte)) { score += 6; signaux.push('émetteur ou vocabulaire administratif'); }
  if (DEMANDE_RE.test(texte)) { score -= c.isOutbound ? 10 : 4; signaux.push('semble être une demande'); }
  return { score, signaux };
}

function extraitAutour(texte: string, termes: string[]): string {
  const propre = texte.replace(/\u0000/g, '').replace(/[ \t]+/g, ' ').trim();
  if (propre.length <= EXTRAIT_PAR_PREUVE) return propre;
  const bas = propre.toLocaleLowerCase('fr');
  const positions = termes
    .map((t) => bas.indexOf(t.toLocaleLowerCase('fr')))
    .filter((n) => n >= 0);
  const nie = propre.search(NIE_RE);
  if (nie >= 0) positions.unshift(nie);
  const centre = positions[0] ?? 0;
  const debut = Math.max(0, centre - Math.floor(EXTRAIT_PAR_PREUVE / 3));
  return `${debut ? '…' : ''}${propre.slice(debut, debut + EXTRAIT_PAR_PREUVE)}${
    debut + EXTRAIT_PAR_PREUVE < propre.length ? '…' : ''
  }`;
}

async function preuves(question: string, account?: string): Promise<PreuveReponse[]> {
  await ensureDbReady();
  const termes = decouperTermes(question);
  if (!termes.mots.length) return [];
  // Deux viviers complémentaires :
  //  - tous les mots ensemble, pour la précision ;
  //  - chaque mot seul, pour ne pas exclure LA preuve parce qu'elle ne répète
  //    pas le contexte de la question. Cas réel : le retour du consulat peut
  //    porter « NIE » sans jamais écrire « Espagne », tandis que les demandes
  //    envoyées portent les deux mots et monopolisaient les résultats.
  const lots = await Promise.all([
    candidatsRecherche({ mots: termes.mots, account }),
    ...termes.mots.map((mot) => candidatsRecherche({ mots: [mot], account })),
  ]);
  const parId = new Map<number, CandidatRecherche>();
  for (const c of lots.flat()) {
    const precedent = parId.get(c.id);
    // Le passage multi-mots porte un masque et une concentration plus riches.
    if (!precedent || c.motsTrouves > precedent.motsTrouves) parId.set(c.id, c);
  }
  const candidats = [...parId.values()];

  // Premier tri sans corps : il ramène les documents, les reçus et les champs
  // forts avant de lire des textes plus lourds. On garde volontairement 40
  // candidats pour ne pas enterrer un retour consulaire ancien.
  const courts = candidats
    .map((c) => ({ c, ...scorePreuve(c) }))
    .sort((a, b) => b.score - a.score || String(b.c.date).localeCompare(String(a.c.date)))
    .slice(0, 40);
  if (!courts.length) return [];

  const lignes = await db.message.findMany({
    where: { id: { in: courts.map((x) => x.c.id) } },
    select: {
      id: true,
      analysisInput: true,
      attachmentText: true,
      aiSummary: true,
    },
  });
  const textes = new Map(
    lignes.map((m) => [m.id, [m.aiSummary, m.analysisInput, m.attachmentText].filter(Boolean).join('\n\n')]),
  );
  const classes = courts
    .map(({ c }) => {
      const contenu = textes.get(c.id) ?? '';
      return { c, contenu, ...scorePreuve(c, contenu) };
    })
    .sort((a, b) => b.score - a.score || String(b.c.date).localeCompare(String(a.c.date)))
    .slice(0, MAX_PREUVES);

  const items = await hydraterMessages(classes.map((x) => x.c.id));
  return classes.flatMap((x, i) => {
    const item = items.get(x.c.id);
    if (!item) return [];
    return [{
      numero: i + 1,
      item,
      extrait: extraitAutour(x.contenu || item.snippet || '', termes.mots),
      score: x.score,
      signaux: x.signaux,
    }];
  });
}

function dossierPourModele(question: string, sources: PreuveReponse[]): string {
  const docs = sources.map((s) => `
[${s.numero}]
Date: ${s.item.date ?? 'inconnue'}
Sens: ${s.item.isOutbound ? 'envoyé par Anthony' : 'reçu par Anthony'}
Expéditeur: ${s.item.fromName || s.item.fromEmail} <${s.item.fromEmail}>
Sujet: ${s.item.subject || '(sans sujet)'}
Fichiers: ${s.item.attachmentNames.join(', ') || 'aucun'}
Signaux: ${s.signaux.join(', ') || 'aucun'}
Extrait:
${s.extrait || '(aucun texte indexé)'}`).join('\n');
  return `Tu es le moteur de réponse de Boxmail, une archive email personnelle.
Réponds en français à la question à partir des seules preuves numérotées.
Une demande envoyée n'est PAS la preuve que le document ou la réponse a été reçu.
Privilégie un retour reçu et le contenu réel d'une pièce jointe.
N'invente jamais une valeur. Si les preuves ne suffisent pas, dis-le clairement.
Chaque affirmation factuelle doit citer sa preuve sous la forme [1], [2].
Réponse courte, directement utile, sans préambule générique.

QUESTION: ${question}

PREUVES:${docs}`;
}

async function appelerCloudflare(question: string, sources: PreuveReponse[]): Promise<string> {
  const accountId = config.ai.cloudflareAccountId;
  const token = config.ai.cloudflareApiToken;
  if (!accountId || !token) throw new Error('Workers AI n’est pas configuré.');
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${config.ai.cloudflareModel}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: 'Réponds uniquement à partir du dossier fourni et cite les preuves.' },
          { role: 'user', content: dossierPourModele(question, sources) },
        ],
        max_tokens: 700,
        temperature: 0.1,
      }),
      signal: controller.signal,
    });
    const payload = await response.json() as {
      success?: boolean;
      errors?: { message?: string }[];
      result?: { response?: string } | string;
    };
    if (!response.ok || payload.success === false) {
      throw new Error(payload.errors?.[0]?.message || `Workers AI a répondu ${response.status}.`);
    }
    const answer = typeof payload.result === 'string' ? payload.result : payload.result?.response;
    if (!answer?.trim()) throw new Error('Workers AI a rendu une réponse vide.');
    return answer.trim();
  } finally {
    clearTimeout(timeout);
  }
}

export async function repondreRecherche(opts: { question: string; account?: string }): Promise<ReponseRecherche> {
  const question = opts.question.trim();
  const sources = await preuves(question, opts.account);
  const configured = !!(config.ai.cloudflareAccountId && config.ai.cloudflareApiToken);
  if (!sources.length) {
    return { question, answer: null, configured, model: configured ? config.ai.cloudflareModel : null,
      warning: 'Je n’ai trouvé aucune preuve exploitable dans les mails indexés.', sources: [] };
  }
  if (!configured) {
    return { question, answer: null, configured: false, model: null,
      warning: 'La réponse IA n’est pas encore configurée. Voici les meilleures preuves trouvées.', sources };
  }
  try {
    return { question, answer: await appelerCloudflare(question, sources), configured: true,
      model: config.ai.cloudflareModel, warning: null, sources };
  } catch (err) {
    return { question, answer: null, configured: true, model: config.ai.cloudflareModel,
      warning: err instanceof Error ? err.message : 'La synthèse IA a échoué.', sources };
  }
}
