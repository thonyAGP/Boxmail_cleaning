import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { db, ensureDbReady } from '../db/client.js';
import { logger } from '../logger.js';
import { imapService } from './imap.js';
import type { AccountRecord } from './accounts.js';
import { stripQuotedText } from './attention.js';
import { detectIntent } from './categorize.js';
import { reparerMojibake } from './mojibake.js';
import { recordOperation } from './oplog.js';

/**
 * Extraits de texte (C1 — Série C, « comprendre le contenu »).
 *
 * L'index ne contenait AUCUN texte de mail : sujet, expéditeur, dates, drapeaux
 * et rien d'autre. Ni les heuristiques ni une IA ne peuvent juger un mail
 * qu'elles ne lisent pas — c'était le vrai plafond du tri. Ce service capture
 * ~500 caractères de texte par mail, via une descente IMAP qui ne télécharge
 * QUE la partie texte (jamais les pièces jointes).
 *
 * Deux usages :
 *  - rattrapage (job « extraits ») : les plus ANCIENS d'abord, reprenable ;
 *  - passe post-sync : les plus RÉCENTS d'abord, pour que le flux courant
 *    ait toujours son extrait.
 */

export const SNIPPET_MAX_CHARS = 500;
/** Fenêtre par défaut : les 3 derniers mois (la demande utilisateur). */
export const SNIPPET_WINDOW_DAYS = 90;

const DEFAULT_LIMIT = 300;
const MAX_LIMIT = 2000;
/** Délai avant de réessayer un mail dont la lecture a échoué (anti-boucle). */
const RETRY_AFTER_MS = 60 * 60_000;

/**
 * Transforme le texte brut d'un mail en extrait lisible : texte cité retiré
 * (on veut ce que l'expéditeur écrit, pas l'historique du fil), espaces et
 * sauts de ligne réduits, coupe à `maxChars`.
 *
 * Cas limite : un simple transfert peut n'être QUE du texte cité — retirer la
 * citation ne laisserait rien. Dans ce cas on garde le texte d'origine : un
 * extrait avec citation vaut mieux que pas d'extrait.
 */
/**
 * Certains mails n'ont AUCUNE partie `text/plain` : l'extrait capturé commence
 * alors par `<!doctype html>` et n'est que du balisage. Deux conséquences
 * mesurées lors du tour d'analyse du 30/07 : les heuristiques lisaient ce
 * balisage COMME DU TEXTE et pouvaient s'accrocher à n'importe quel mot trouvé
 * dedans, et l'IA jugeait ces mails inexploitables — donc ~110 mails sur la
 * seule boîte personnelle restaient protégés à vie faute de contenu lisible.
 *
 * On dégage donc le texte du balisage. Volontairement minimal et sans
 * dépendance : on retire ce qui ne s'affiche jamais (style, script, head), on
 * transforme les fins de bloc en sauts de ligne, on enlève les balises, puis on
 * décode les entités les plus courantes.
 */
function htmlEnTexte(raw: string): string {
  // Le courrier français est truffé d'entités accentuées : sans elles, « n°2281 »
  // devient « n 2281 » et « 840 € » perd son symbole. Les entités NUMÉRIQUES
  // sont décodées génériquement, ce qui couvre tout le reste.
  const entites: Record<string, string> = {
    lt: '<', gt: '>', quot: '"', apos: "'", amp: '&', nbsp: ' ',
    deg: '°', euro: '€', laquo: '«', raquo: '»', hellip: '…',
    rsquo: '’', lsquo: '‘', ndash: '–', mdash: '—', times: '×',
    copy: '©', reg: '®', trade: '™', eacute: 'é', egrave: 'è', ecirc: 'ê',
    agrave: 'à', acirc: 'â', ugrave: 'ù', ucirc: 'û', ccedil: 'ç',
    icirc: 'î', iuml: 'ï', ocirc: 'ô', euml: 'ë', uuml: 'ü', oelig: 'œ',
  };
  return raw
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/?(p|div|br|tr|td|th|li|h[1-6]|table)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);?/gi, (_m, h: string) => codePoint(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_m, d: string) => codePoint(Number(d)))
    .replace(/&([a-z]+);?/gi, (_m, e: string) => entites[e.toLowerCase()] ?? ' ');
}

/**
 * Convertit un point de code d'entité en caractère, en refusant ce qui ne peut
 * pas être écrit en base.
 *
 * DÉFAUT RÉEL, introduit puis corrigé le 30/07 : `String.fromCodePoint(55296)`
 * rend un DEMI-CARACTÈRE de substitution isolé — parfaitement valide en
 * JavaScript, mais impossible à encoder en UTF-8. Prisma refusait alors
 * l'écriture (« unexpected end of hex escape ») et l'erreur faisait échouer la
 * lecture des extraits de TOUTE une boîte, pas seulement du mail fautif.
 */
function codePoint(n: number): string {
  if (!Number.isFinite(n) || n < 0x20 || n > 0x10ffff) return ' ';
  if (n >= 0xd800 && n <= 0xdfff) return ' '; // demi-caractère isolé
  try {
    return String.fromCodePoint(n);
  } catch {
    return ' ';
  }
}

/** true si la chaîne est du balisage plutôt que du texte lisible. */
function ressembleAduHtml(s: string): boolean {
  const t = s.slice(0, 2000);
  if (/^\s*<(!doctype|html|head|table|meta|\?xml)/i.test(t)) return true;
  // Sinon : beaucoup de balises rapportées à la longueur du texte.
  const balises = (t.match(/<[a-z!/][^>]*>/gi) ?? []).length;
  return balises >= 5 && balises * 40 > t.length;
}

/**
 * Coupe le BLOC DE SIGNATURE et les pieds de page.
 *
 * Constat du tour d'analyse du 30/07, sur les derniers mails qui résistaient :
 * « les signatures HTML lourdes — logos, liens Facebook/LinkedIn, bouton
 * "Planifier un RDV" — noyaient le texte utile ». Concrètement, une relance de
 * bilan de deux lignes suivie de 800 caractères de signature donnait un extrait
 * de 500 caractères ne contenant QUE la signature : l'expéditeur passait pour
 * une newsletter et le moteur lisait « rendez-vous » là où il y avait une
 * relance.
 *
 * On coupe donc à la première marque de fin de message. Le texte utile est
 * TOUJOURS avant : couper ne perd rien et fait remonter l'essentiel.
 *
 * GARDE-FOU : si la coupe ne laisse presque rien (message réduit à sa formule
 * de politesse, ou marqueur en tout début), on rend le texte d'origine — un
 * extrait bavard vaut mieux qu'un extrait vide.
 */
const FIN_DE_MESSAGE_RE = new RegExp(
  [
    '^\\s*--\\s*$', // délimiteur de signature normalisé (RFC 3676)
    '^\\s*(bien\\s+)?(cordialement|sinc[èe]rement|amicalement|salutations|cdl?t|respectueusement)\\b',
    '^\\s*(bien\\s+[àa]\\s+vous|bonne\\s+(journ[ée]e|r[ée]ception|soir[ée]e)|[àa]\\s+bient[ôo]t)\\b',
    '^\\s*(envoy[ée]\\s+de\\s+mon|sent\\s+from\\s+my)\\b',
    'ce\\s+(message|courriel|e-?mail).{0,120}(confidentiel|destinataire)',
    'this\\s+(message|e-?mail).{0,120}(confidential|intended\\s+recipient)',
    '(se\\s+d[ée]sinscrire|se\\s+d[ée]sabonner|unsubscribe|g[ée]rer\\s+(mes|vos)\\s+pr[ée]f[ée]rences)',
    '(voir|afficher)\\s+(ce\\s+mail\\s+)?dans\\s+(le\\s+navigateur|votre\\s+navigateur)',
    '(suivez[- ]nous|planifier\\s+un\\s+rdv|prendre\\s+rendez[- ]vous\\s+en\\s+ligne)',
  ].join('|'),
  'im',
);

export function stripSignature(text: string): string {
  const m = FIN_DE_MESSAGE_RE.exec(text);
  if (!m) return text;
  const coupe = text.slice(0, m.index).trim();
  // Moins de 25 caractères utiles : la coupe a tout emporté, on garde l'original.
  return coupe.length >= 25 ? coupe : text;
}

export function cleanSnippet(raw: string, maxChars = SNIPPET_MAX_CHARS): string {
  const flatten = (s: string): string =>
    s
      .replace(/\r/g, '')
      .split('\n')
      .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
      .filter(Boolean)
      .join(' ')
      .trim();

  // Filet de sécurité, quelle que soit la provenance du texte : un demi-caractère
  // de substitution isolé ou un caractère de contrôle rend la chaîne
  // inencodable en UTF-8, et l'écriture échoue pour TOUTE la boîte, pas
  // seulement pour le mail fautif. Un corps de mail mal formé ne doit jamais
  // pouvoir bloquer une passe entière.
  // Et mojibake réparé À LA SOURCE : les nouveaux extraits sont lisibles dès
  // leur capture (« Ã©chÃ©ance » → « échéance ») et detectIntent lit un vrai texte.
  const sain = reparerMojibake(raw)
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, ' ')
    .replace(/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '$1 ')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ');
  const source = ressembleAduHtml(sain) ? htmlEnTexte(sain) : sain;
  // Ordre voulu : d'abord la citation (le fil recopié dessous), puis la
  // signature (le bloc de fin). Chacun a son propre repli si la coupe vide tout.
  let text = flatten(stripSignature(stripQuotedText(source)));
  if (!text) text = flatten(stripSignature(source));
  if (!text) text = flatten(source);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trimEnd()}…`;
}

/**
 * Version de ce qu'on ENVOIE à l'analyse. Distincte du schéma du verdict et
 * des consignes : trois choses qui évoluent séparément, et c'est ce triplet
 * qui permet de sélectionner quoi relire sans tout relire.
 *
 *   1 — l'extrait de 500 caractères, aplati (l'historique)
 *   2 — 2 200 caractères SÉLECTIONNÉS, structure conservée
 */
export const INPUT_VERSION = '2';

/** Budget de caractères envoyé à l'analyse pour le corps du mail. */
export const ANALYSIS_INPUT_CHARS = 2200;

/**
 * Prépare le texte envoyé à l'analyse : 1 500 à 2 500 caractères CHOISIS,
 * et non les 2 200 premiers.
 *
 * POURQUOI PAS SIMPLEMENT COUPER PLUS LOIN. La demande est très souvent en fin
 * de message — « merci de nous retourner le document signé avant le 30 » — et
 * un mail d'agence commence par trois paragraphes de politesse. Couper au
 * kilomètre garde le préambule et jette la demande. Mesuré sur ses boîtes : les
 * mails à deux sujets (un document à signer ET une assemblée générale) sont
 * systématiquement tronqués sur le premier.
 *
 * CE QUE CETTE FONCTION N'EST PAS. Elle ne classe rien et ne décide rien : elle
 * choisit ce que l'IA aura sous les yeux. C'est la part déterministe du
 * partage — « si deux programmeurs obtiennent la réponse sans comprendre une
 * phrase, c'est au serveur ». Un paragraphe mal noté dégrade la qualité de
 * l'entrée ; il ne produit jamais un classement faux en silence. C'est
 * précisément pourquoi une heuristique est acceptable ICI et ne l'était pas
 * dans les moteurs.
 *
 * LA STRUCTURE EST CONSERVÉE, contrairement à `cleanSnippet` qui aplatit tout
 * en une ligne. À 500 caractères c'était sans conséquence ; à 2 200, les
 * paragraphes sont ce qui permet de choisir.
 */
export function selectionnerPourAnalyse(raw: string, budget = ANALYSIS_INPUT_CHARS): string {
  if (!raw) return '';

  // Même assainissement que l'extrait : un demi-caractère de substitution isolé
  // rend la chaîne inencodable et fait échouer l'écriture pour TOUTE la boîte.
  const sain = reparerMojibake(raw)
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, ' ')
    .replace(/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '$1 ')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ');
  const source = ressembleAduHtml(sain) ? htmlEnTexte(sain) : sain;

  // Mêmes replis que cleanSnippet : un transfert peut n'être QUE du texte cité,
  // et tout retirer ne laisserait rien.
  let corps = stripSignature(stripQuotedText(source));
  if (corps.trim().length < 40) corps = stripSignature(source);
  if (corps.trim().length < 40) corps = source;

  const paragraphes = corps
    .replace(/\r/g, '')
    .split(/\n\s*\n|\n(?=\s*[-•*–]\s)/)
    .map((p) =>
      p
        .split('\n')
        .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
        .filter(Boolean)
        .join(' ')
        .trim(),
    )
    .filter((p) => p.length > 0);

  if (paragraphes.length === 0) return '';
  const total = paragraphes.reduce((n, p) => n + p.length + 1, 0);
  if (total <= budget) return paragraphes.join('\n');

  // Ce qui fait la valeur d'un paragraphe : un chiffre, une date, une somme,
  // une référence, une question, une formule de demande. Volontairement large.
  const PORTEUR =
    /(\d)|(€|EUR|euros?)|(\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b)|(janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre)|(merci de|veuillez|pouvez-vous|pourriez-vous|nous vous prions|il convient|avant le|au plus tard|dès que|dans l'attente|ci-joint|ci-joints|joint|référence|dossier|contrat|facture|échéance|signer|signature|régler|paiement|virement|rendez-vous|confirmer)|(\?)/i;

  const notes = paragraphes.map((p, i) => {
    let note = PORTEUR.test(p) ? 2 : 0;
    // Le début porte l'objet ; la fin porte la demande. Les deux comptent plus
    // que le milieu, indépendamment de leur contenu.
    if (i === 0) note += 3;
    if (i === paragraphes.length - 1) note += 2;
    if (i === paragraphes.length - 2) note += 1;
    // Un paragraphe très court est souvent une salutation ou un intertitre.
    if (p.length < 25) note -= 1;
    return note;
  });

  // On retient par note décroissante, puis on RÉTABLIT L'ORDRE DU MAIL : la
  // chronologie d'un message porte du sens, un texte recomposé dans le
  // désordre en perdrait.
  const ordre = paragraphes.map((_, i) => i).sort((a, b) => notes[b] - notes[a] || a - b);
  const retenus = new Set<number>();
  let reste = budget;
  for (const i of ordre) {
    const cout = paragraphes[i].length + 1;
    if (cout > reste) {
      // Le tout premier paragraphe est gardé même tronqué : sans lui, l'IA
      // ignore de quoi parle le mail.
      if (retenus.size === 0) {
        retenus.add(i);
        reste = 0;
      }
      continue;
    }
    retenus.add(i);
    reste -= cout;
    if (reste < 40) break;
  }

  const sortie: string[] = [];
  let trou = false;
  for (let i = 0; i < paragraphes.length; i++) {
    if (retenus.has(i)) {
      // Un passage sauté est SIGNALÉ. L'IA doit savoir qu'elle ne voit pas
      // tout : c'est ce qui lui permet de déclarer `truncated_input` et de
      // déclencher une relecture ciblée plutôt que d'affirmer à tort.
      if (trou) sortie.push('[…]');
      const p = paragraphes[i];
      sortie.push(p.length > budget ? `${p.slice(0, budget).trimEnd()}…` : p);
      trou = false;
    } else {
      trou = true;
    }
  }
  if (trou) sortie.push('[…]');
  return sortie.join('\n');
}

export interface BackfillOptions {
  /** Nombre de mails traités dans cette passe (défaut 300, max 2000). */
  limit?: number;
  /** Fenêtre en jours ; `null` = toute la boîte (défaut : 90 jours). */
  sinceDays?: number | null;
  /** 'oldest' = rattrapage (défaut) ; 'newest' = flux courant (post-sync). */
  order?: 'oldest' | 'newest';
  /**
   * false = ne pas recalculer la confiance ici (l'appelant s'en charge juste
   * après — c'est le cas de la sync, qui enchaîne sa propre passe).
   */
  recomputeConfidence?: boolean;
  onProgress?: (message: string) => void;
}

export interface BackfillResult {
  scanned: number;
  /** Mails ayant reçu un extrait non vide. */
  filled: number;
  /** Mails traités sans texte exploitable (structure atypique, corps vide). */
  empty: number;
  /** Mails dont l'intention s'est précisée grâce à l'extrait. */
  intentsImproved: number;
  /** Mails d'un dossier en panne, remis à plus tard (pas perdus). */
  deferred: number;
  /** Reste-t-il des mails sans extrait dans la fenêtre ? (pour reprendre) */
  remaining: number;
}

/**
 * Capture les extraits manquants d'une boîte. REPRENABLE : chaque passe traite
 * un lot borné et renvoie `remaining` — l'appelant relance tant qu'il reste du
 * travail. Une erreur sur un dossier n'arrête pas les autres.
 */
export async function backfillSnippets(
  rec: AccountRecord,
  opts: BackfillOptions = {},
): Promise<BackfillResult> {
  await ensureDbReady();
  const progress = opts.onProgress ?? (() => {});
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const sinceDays = opts.sinceDays === undefined ? SNIPPET_WINDOW_DAYS : opts.sinceDays;
  const order = opts.order ?? 'oldest';

  const where = {
    accountSlug: rec.account,
    isDeleted: false,
    isOutbound: false,
    // Deux raisons de descendre le texte d'un mail (11/08) : il n'a aucun
    // extrait, OU son texte d'analyse date d'une version antérieure.
    //
    // On ne pouvait PAS régler ça en remettant `snippet` à null pour forcer une
    // recapture : `snippet IS NOT NULL` est la définition même de « analysable »
    // (candidateWhere), donc vider la colonne aurait sorti le mail du vivier
    // d'analyse. Les deux critères se contredisaient dès qu'on voulait
    // rallonger l'existant — d'où une colonne distincte et sa version.
    OR: [
      { snippet: null },
      { analysisInputVersion: null },
      { analysisInputVersion: { not: INPUT_VERSION } },
    ],
    // Corbeille et spam : rien à comprendre là-dedans.
    folder: { is: { role: { notIn: ['trash', 'spam'] } } },
    ...(sinceDays !== null
      ? { date: { gte: new Date(Date.now() - sinceDays * 86_400_000) } }
      : {}),
  };

  // ANTI-BOUCLE (constaté en réel le 29/07) : quand un dossier échoue (socket
  // IMAP qui expire, boîte injoignable), ses mails restent sans extrait et
  // repartaient dans le lot suivant — le rattrapage tournait en rond sans
  // jamais avancer. On note donc la TENTATIVE (`snippetAt`) même en échec, et
  // on ne réessaie ces mails qu'après un délai. Rien n'est perdu : ils
  // restent comptés dans `remaining` et seront repris plus tard.
  // `AND` et non un second `OR` : deux clés `OR` au même niveau, la seconde
  // écraserait la première et le filtre de reprise disparaîtrait en silence.
  const selectWhere = {
    ...where,
    AND: [
      { OR: [{ snippetAt: null }, { snippetAt: { lt: new Date(Date.now() - RETRY_AFTER_MS) } }] },
    ],
  };

  const pending = await db.message.findMany({
    where: selectWhere,
    orderBy: { date: order === 'oldest' ? 'asc' : 'desc' },
    take: limit,
    select: {
      id: true,
      uid: true,
      subject: true,
      fromEmail: true,
      hasListUnsubscribe: true,
      intent: true,
      folder: { select: { path: true } },
    },
  });

  const result: BackfillResult = {
    scanned: 0,
    filled: 0,
    empty: 0,
    intentsImproved: 0,
    deferred: 0,
    remaining: 0,
  };
  if (pending.length === 0) {
    // Rien de sélectionnable : soit tout est lu, soit les mails restants sont
    // en attente de réessai (dossier en panne). `remaining` dit la vérité.
    result.remaining = await db.message.count({ where });
    return result;
  }

  // Regroupé par dossier : un seul verrouillage de boîte par dossier.
  const byFolder = new Map<string, typeof pending>();
  for (const m of pending) {
    const arr = byFolder.get(m.folder.path) ?? [];
    arr.push(m);
    byFolder.set(m.folder.path, arr);
  }
  progress(
    `${pending.length} mail(s) sans extrait dans ${byFolder.size} dossier(s) — récupération du texte…`,
  );

  const updates: { id: number; snippet: string; analysisInput: string }[] = [];
  const intentUpdates: { id: number; intent: string; reason: string }[] = [];
  /** Mails d'un dossier en panne : tentative datée, extrait laissé vide. */
  const failed: number[] = [];

  for (const [folderPath, messages] of byFolder) {
    try {
      const texts = await imapService.fetchSnippets(
        rec,
        folderPath,
        messages.map((m) => m.uid),
      );
      for (const m of messages) {
        result.scanned++;
        const raw = texts.get(m.uid);
        // Pas de texte exploitable : on enregistre un extrait VIDE (et non
        // null) pour marquer « déjà tenté » — sinon ce mail reviendrait à
        // chaque passe et le rattrapage n'avancerait jamais.
        const snippet = raw ? cleanSnippet(raw) : '';
        // Le texte d'analyse se calcule dans la MÊME descente : la partie
        // texte est déjà téléchargée, en tirer 2 200 caractères choisis ne
        // coûte pas un aller-retour IMAP de plus.
        const analysisInput = raw ? selectionnerPourAnalyse(raw) : '';
        if (snippet) result.filled++;
        else result.empty++;
        updates.push({ id: m.id, snippet, analysisInput });

        // L'extrait sert tout de suite, sans IA : quand le SUJET seul n'a rien
        // donné (intention « info »), on rejoue la détection avec le texte.
        // Le sujet garde la priorité — aucune régression sur les cas déjà bons.
        if (snippet && (m.intent === null || m.intent === 'info')) {
          const r = detectIntent({
            subject: m.subject,
            hasListUnsubscribe: m.hasListUnsubscribe,
            fromEmail: m.fromEmail,
            snippet,
          });
          // On n'entre ici que si l'intention valait null ou « info » : dès que
          // la relecture donne autre chose, c'est un gain.
          if (r.intent !== 'info') {
            intentUpdates.push({ id: m.id, intent: r.intent, reason: r.reason });
          }
        }
      }
    } catch (err) {
      logger.warn('extraits : dossier ignoré', {
        account: rec.account,
        folder: folderPath,
        error: (err as Error).message,
      });
      // Tentative datée sans extrait : ces mails ne reviendront pas au tour
      // suivant (sinon le rattrapage boucle sur le dossier en panne), mais
      // restent à faire et seront réessayés après RETRY_AFTER_MS.
      failed.push(...messages.map((m) => m.id));
      progress(
        `⚠️ ${folderPath} ignoré (${(err as Error).message}) — ${messages.length} mail(s) réessayés plus tard.`,
      );
    }
  }

  // Écriture groupée : SQLite est en connection_limit=1, une transaction par
  // paquet vaut mieux que des centaines d'écritures isolées.
  const now = new Date();
  for (let i = 0; i < updates.length; i += 100) {
    await db.$transaction(
      updates.slice(i, i + 100).map((u) =>
        db.message.update({
          where: { id: u.id },
          data: {
            snippet: u.snippet,
            snippetAt: now,
            analysisInput: u.analysisInput,
            // La version est posée MÊME quand le texte est vide : sinon le
            // mail repasserait à chaque tour et le rattrapage tournerait en
            // rond, exactement comme l'anti-boucle du 29/07.
            analysisInputVersion: INPUT_VERSION,
          },
        }),
      ),
    );
  }
  // Dossiers en panne : on date la tentative sans poser d'extrait.
  for (let i = 0; i < failed.length; i += 200) {
    await db.message.updateMany({
      where: { id: { in: failed.slice(i, i + 200) } },
      data: { snippetAt: now },
    });
  }
  for (let i = 0; i < intentUpdates.length; i += 100) {
    await db.$transaction(
      intentUpdates.slice(i, i + 100).map((u) =>
        db.message.update({
          where: { id: u.id },
          data: { intent: u.intent, intentReason: u.reason },
        }),
      ),
    );
  }
  result.intentsImproved = intentUpdates.length;

  // Les intentions ont changé ⇒ la confiance (B4) qui en découle doit suivre.
  // ATTENTION au piège : on ne remet PAS `analysisConfidence` à null pour
  // forcer un recalcul « onlyMissing ». Une confiance nulle n'est pas
  // « faible » — elle ne déclenche donc PAS la protection B1, et une rétention
  // automatique lancée entre-temps pourrait viser ces mails. On recalcule
  // directement, en entier : l'opération est idempotente et n'écrit que les
  // changements.
  if (result.intentsImproved > 0 && opts.recomputeConfidence !== false) {
    const { computeConfidenceForAccount } = await import('./categorize.js');
    await computeConfidenceForAccount(rec.account, {}, progress);
  }

  result.deferred = failed.length;
  result.remaining = await db.message.count({ where });
  progress(
    `${rec.account} : ${result.filled} extrait(s) capturé(s), ${result.empty} sans texte, ` +
      (result.deferred ? `${result.deferred} remis à plus tard, ` : '') +
      `${result.intentsImproved} intention(s) précisée(s) — reste ${result.remaining}.`,
  );
  return result;
}

// ----------------------------------------- Réparation des extraits en charabia

/**
 * Passe de réparation sur TOUS les extraits déjà en base, via `reparerMojibake`
 * (séquence par séquence — l'ancienne approche « chaîne entière » échouait dès
 * qu'une seule séquence était abîmée : 234 échecs sur 400, mesuré). Aucune
 * connexion IMAP : c'est une relecture du texte, pas des mails.
 *
 * Un extrait réparé peut changer la donne pour les moteurs : l'intention
 * détectée sur le charabia est REJOUÉE sur le texte lisible — uniquement le
 * calcul automatique (précédence manual > ai > auto, jamais écrasée) — puis la
 * confiance des boîtes touchées est recalculée (recalcul direct, jamais de
 * remise à null : cf. le piège documenté dans backfillSnippets).
 */
export async function repairSnippets(
  progress: (m: string) => void = () => {},
): Promise<{ scanned: number; repaired: number; intentsRecomputed: number }> {
  await ensureDbReady();
  let cursor = 0;
  let scanned = 0;
  let repaired = 0;
  let intentsRecomputed = 0;
  const touchedAccounts = new Set<string>();
  for (;;) {
    const batch = await db.message.findMany({
      where: { snippet: { not: null }, id: { gt: cursor } },
      orderBy: { id: 'asc' },
      take: 1000,
      select: {
        id: true, snippet: true, subject: true, fromEmail: true,
        hasListUnsubscribe: true, intent: true, intentSource: true, accountSlug: true,
      },
    });
    if (batch.length === 0) break;
    cursor = batch[batch.length - 1].id;
    scanned += batch.length;

    const fixes: { id: number; snippet: string; intent?: string; intentReason?: string }[] = [];
    for (const m of batch) {
      const fixed = reparerMojibake(m.snippet ?? '');
      if (fixed === m.snippet) continue;
      touchedAccounts.add(m.accountSlug);
      const fix: (typeof fixes)[number] = { id: m.id, snippet: fixed };
      if (m.intentSource === 'auto') {
        const r = detectIntent({
          subject: m.subject,
          hasListUnsubscribe: m.hasListUnsubscribe,
          fromEmail: m.fromEmail,
          snippet: fixed,
        });
        if (r.intent !== m.intent) {
          fix.intent = r.intent;
          fix.intentReason = r.reason;
          intentsRecomputed++;
        }
      }
      fixes.push(fix);
    }
    for (let i = 0; i < fixes.length; i += 100) {
      await db.$transaction(
        fixes.slice(i, i + 100).map((f) =>
          db.message.update({
            where: { id: f.id },
            data: {
              snippet: f.snippet,
              ...(f.intent ? { intent: f.intent, intentReason: f.intentReason } : {}),
            },
          }),
        ),
      );
    }
    repaired += fixes.length;
    if (scanned % 5000 === 0) progress(`${scanned} extraits examinés, ${repaired} réparés…`);
  }

  // Des intentions ont bougé ⇒ la confiance (B4) qui en découle doit suivre.
  if (intentsRecomputed > 0) {
    const { computeConfidenceForAccount } = await import('./categorize.js');
    for (const account of touchedAccounts) {
      await computeConfidenceForAccount(account, {}, progress);
    }
  }

  progress(
    `Réparation terminée : ${repaired} extrait(s) remis d'aplomb sur ${scanned}, ` +
      `${intentsRecomputed} intention(s) recalculée(s).`,
  );
  if (repaired > 0) {
    await recordOperation({
      account: '*',
      tool: 'repair_snippets',
      params: { scanned, repaired, intentsRecomputed },
      result: `${repaired} extrait(s) illisibles réparés (accents), ${intentsRecomputed} classement(s) recalculé(s)`,
    });
  }
  return { scanned, repaired, intentsRecomputed };
}

// ------------------------------------------- Rattrapage repris après redémarrage

export type BackfillScope = 'recent' | 'all';

export interface PendingBackfill {
  scope: BackfillScope;
  requestedAt: string;
}

/**
 * Marqueur sur DISQUE de « l'utilisateur a demandé un rattrapage ».
 *
 * POURQUOI un fichier et pas la mémoire : les jobs vivent dans le processus.
 * Or le serveur redémarre à chaque mise à jour — et depuis que celles-ci sont
 * automatiques, ça arrive toutes les nuits. Un rattrapage de plusieurs heures
 * mourait donc en silence, en laissant l'interface afficher des compteurs
 * figés (constaté en réel le 29/07 : le job est mort à 09h26, l'utilisateur
 * l'a vu bloqué sans comprendre pourquoi). Le marqueur permet au serveur de
 * REPRENDRE tout seul au démarrage suivant.
 */
const MARKER = (): string => resolve(process.cwd(), 'data', 'snippet-backfill.json');

export function requestBackfill(scope: BackfillScope): void {
  try {
    const path = MARKER();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ scope, requestedAt: new Date().toISOString() }), 'utf8');
  } catch (err) {
    logger.warn('marqueur de rattrapage non écrit', { error: (err as Error).message });
  }
}

export function pendingBackfill(): PendingBackfill | null {
  try {
    const path = MARKER();
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<PendingBackfill>;
    return raw.scope === 'all' || raw.scope === 'recent'
      ? { scope: raw.scope, requestedAt: raw.requestedAt ?? '' }
      : null;
  } catch {
    return null;
  }
}

export function clearBackfill(): void {
  try {
    const path = MARKER();
    if (existsSync(path)) unlinkSync(path);
  } catch {
    /* le marqueur disparaîtra au prochain passage */
  }
}

/** Plafond par passage : un job ne tourne pas indéfiniment (il est repris). */
const MAX_ROUNDS = 40;

/**
 * Rattrapage sur TOUTES les boîtes, par lots, jusqu'à épuisement ou plafond.
 * Partagé par le bouton de l'interface et par la reprise au démarrage — un
 * seul comportement. Le marqueur n'est effacé que lorsqu'il ne reste plus rien
 * à lire : tant qu'il subsiste du travail, un redémarrage reprend la main.
 */
export async function runBackfillAllAccounts(
  scope: BackfillScope,
  progress: (m: string) => void = () => {},
): Promise<Record<string, unknown>> {
  const { listAccountNames, resolveAccount } = await import('./accounts.js');
  const sinceDays = scope === 'all' ? null : undefined;
  const results: Record<string, unknown> = {};
  let leftOver = 0;

  for (const name of await listAccountNames()) {
    try {
      const rec = await resolveAccount(name);
      let filled = 0;
      let empty = 0;
      let intents = 0;
      let remaining = 0;
      for (let round = 0; round < MAX_ROUNDS; round++) {
        progress(`[${name}] lecture des mails — lot ${round + 1}…`);
        const r = await backfillSnippets(rec, { sinceDays, onProgress: progress });
        filled += r.filled;
        empty += r.empty;
        intents += r.intentsImproved;
        remaining = r.remaining;
        if (r.scanned === 0 || remaining === 0) break;
      }
      leftOver += remaining;
      results[name] = { filled, empty, intentsImproved: intents, remaining };
    } catch (err) {
      results[name] = { error: (err as Error).message };
      progress(`⚠️ ${name} en échec (${(err as Error).message}) — on continue.`);
    }
  }

  if (leftOver === 0) {
    clearBackfill();
    progress('✅ Plus aucun mail à lire — rattrapage terminé.');
  } else {
    progress(`⏸️ ${leftOver} mail(s) restants — la lecture reprendra automatiquement.`);
  }
  return { ...results, remaining: leftOver };
}

export interface AccountCoverage {
  account: string;
  /** Mails entrants indexés (hors corbeille/spam, non supprimés). */
  total: number;
  /** Idem, sur les 3 derniers mois. */
  recent: number;
  /** Mails sans extrait de texte (dans la fenêtre de 3 mois). */
  recentWithoutSnippet: number;
  /**
   * Mails sans extrait sur TOUTE la boîte. C'est ce chiffre qui bouge quand
   * le rattrapage « toute la boîte » tourne — sans lui, l'interface affichait
   * un compteur figé à 0 (celui des 3 mois) et donnait l'impression que rien
   * ne se passait (retour utilisateur 29/07).
   */
  withoutSnippet: number;
  /** Mails dont l'analyse est jugée « faible » ⇒ protégés de tout nettoyage. */
  lowConfidence: number;
  /** Part des mails porteurs d'un extrait, en % (0-100). */
  snippetCoveragePct: number;
}

/**
 * Photographie de l'état de l'analyse (C0) — la mesure « avant ». Sert à
 * dimensionner le rattrapage et, plus tard, à prouver le gain. Index-only.
 */
export async function analysisCoverage(): Promise<{
  accounts: AccountCoverage[];
  totals: Omit<AccountCoverage, 'account'>;
}> {
  await ensureDbReady();
  const { listAccountNames } = await import('./accounts.js');
  const names = await listAccountNames();
  const cutoff = new Date(Date.now() - SNIPPET_WINDOW_DAYS * 86_400_000);
  const base = {
    isDeleted: false,
    isOutbound: false,
    folder: { is: { role: { notIn: ['trash', 'spam'] } } },
  };

  const accounts: AccountCoverage[] = [];
  for (const account of names) {
    const scope = { ...base, accountSlug: account };
    const [total, recent, recentWithoutSnippet, lowConfidence, withSnippet] = await Promise.all([
      db.message.count({ where: scope }),
      db.message.count({ where: { ...scope, date: { gte: cutoff } } }),
      db.message.count({ where: { ...scope, date: { gte: cutoff }, snippet: null } }),
      db.message.count({ where: { ...scope, analysisConfidence: 'low' } }),
      db.message.count({ where: { ...scope, snippet: { not: null } } }),
    ]);
    accounts.push({
      account,
      total,
      recent,
      recentWithoutSnippet,
      withoutSnippet: total - withSnippet,
      lowConfidence,
      snippetCoveragePct: total === 0 ? 0 : Math.round((withSnippet / total) * 100),
    });
  }

  const sum = (pick: (a: AccountCoverage) => number): number =>
    accounts.reduce((n, a) => n + pick(a), 0);
  const totalAll = sum((a) => a.total);
  // Somme EXACTE des sans-extrait (et non une reconstitution à partir des
  // pourcentages arrondis, qui dérivait de quelques mails).
  const withoutSnippetAll = sum((a) => a.withoutSnippet);
  return {
    accounts,
    totals: {
      total: totalAll,
      recent: sum((a) => a.recent),
      recentWithoutSnippet: sum((a) => a.recentWithoutSnippet),
      withoutSnippet: withoutSnippetAll,
      lowConfidence: sum((a) => a.lowConfidence),
      snippetCoveragePct:
        totalAll === 0 ? 0 : Math.round(((totalAll - withoutSnippetAll) / totalAll) * 100),
    },
  };
}
