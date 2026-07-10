import { db, ensureDbReady } from '../db/client.js';
import { AUTO_SENDER_RE } from './attention.js';

/**
 * Moteur de catégorisation (A1 — Cap V3, fondation de l'assistant).
 * Deux axes, calculés par heuristiques index-only et toujours EXPLIQUÉS :
 *  - QUI écrit ?      → Sender.category (banque, admin, marketplace, personne…)
 *  - POURQUOI il écrit ? → Message.intent (facture, code OTP, livraison…)
 * Aucune lecture de contenu, aucun LLM : sujets, adresses, en-têtes indexés.
 * Une catégorie corrigée à la main (categorySource=manual) n'est JAMAIS
 * écrasée par le recalcul — la correction est un signal d'apprentissage (A6).
 */

// ---------------------------------------------------------------- Qui écrit ?

export const SENDER_CATEGORIES = [
  'person',
  'company',
  'bank',
  'insurance',
  'admin',
  'marketplace',
  'social',
  'newsletter',
  'notification',
  'ad',
] as const;
export type SenderCategory = (typeof SENDER_CATEGORIES)[number];

export const SENDER_CATEGORY_LABELS: Record<SenderCategory, string> = {
  person: 'Personne',
  company: 'Entreprise',
  bank: 'Banque / argent',
  insurance: 'Assurance / mutuelle',
  admin: 'Administration',
  marketplace: 'Boutique en ligne',
  social: 'Réseau social',
  newsletter: 'Newsletter',
  notification: 'Notification / robot',
  ad: 'Publicité',
};

// Mêmes précautions que IMPORTANT_SENDER_RE (attention.ts) : tokens explicites,
// frontières de mots sur les mots courts, pas de domaines grand public.
const BANK_RE =
  /(\bbanque\b|\bbank(ing)?\b|banquepostale|labanquepostale|boursorama|boursobank|fortuneo|\bbnp\b|societe ?generale|socgen|credit[- ]?(agricole|mutuel|lyonnais)|\blcl\b|caisse[- ]?d?'?epargne|hellobank|\bn26\b|revolut|\bnickel\b|qonto|paypal|\bvisa\b|mastercard|\bdgfip.*paiement\b)/i;

const INSURANCE_RE =
  /(assurance|assureur|mutuelle|prevoyance|\bmaif\b|\bmacif\b|\bmatmut\b|\baxa\b|allianz|groupama|\bgmf\b|\bmaaf\b|harmonie|malakoff|\bapril\b|generali|swisslife|alan\.com)/i;

const ADMIN_RE =
  /(impot|impots|dgfip|finances ?publiques|tresor ?public|urssaf|ameli|\bcpam\b|\bmsa\b|\bcaf\b|gouv\.fr|prefecture|mairie|pole-?emploi|francetravail|service-?public|\bants\b|carsat|retraite|\bcnav\b|academie|education ?nationale)/i;

const SOCIAL_RE =
  /(facebook|facebookmail|instagram|twitter|\bx\.com$|linkedin|tiktok|snapchat|pinterest|whatsapp|\bmeta\b|youtube|discord|reddit|twitch|strava)/i;

const MARKETPLACE_RE =
  /(amazon|\bebay\b|leboncoin|vinted|cdiscount|aliexpress|\bfnac\b|darty|boulanger|booking|airbnb|abritel|zalando|\btemu\b|shein|rakuten|\betsy\b|veepee|showroomprive|ManoMano|leroymerlin|castorama|ikea|decathlon|sncf|ouigo|trainline|blablacar|uber|deliveroo)/i;

const AD_RE = /(\bpromo(tions?)?\b|marketing|offres?@|\bdeals?\b|\bsales?@|publicite|bonsplans)/i;

/** Domaines de messagerie grand public : un humain, sauf preuve du contraire. */
const PERSONAL_DOMAIN_RE =
  /@(gmail|googlemail|hotmail|outlook|live|msn|yahoo|orange|wanadoo|free|sfr|neuf|laposte|icloud|me|mac|protonmail|proton|gmx|aol)\.(com|fr|net|me|ch)$/i;

export interface SenderSignals {
  email: string;
  displayName?: string | null;
  messageCount: number;
  unsubscribeCount: number;
  /** true si au moins un fil avec cet expéditeur contient un message sortant. */
  conversational: boolean;
}

export interface CategoryResult {
  category: SenderCategory;
  reason: string;
}

/** Classifie un expéditeur — chaque décision porte sa raison en français. */
export function categorizeSender(s: SenderSignals): CategoryResult {
  const text = `${s.email} ${s.displayName ?? ''}`;
  let m: RegExpExecArray | null;

  // Marques identifiables d'abord (même conversationnelles : ta banque reste
  // ta banque — l'importance tient déjà compte de la conversation à part).
  if ((m = ADMIN_RE.exec(text))) return { category: 'admin', reason: `administration (« ${m[0]} »)` };
  if ((m = BANK_RE.exec(text))) return { category: 'bank', reason: `banque / argent (« ${m[0]} »)` };
  if ((m = INSURANCE_RE.exec(text)))
    return { category: 'insurance', reason: `assurance / mutuelle (« ${m[0]} »)` };
  if ((m = SOCIAL_RE.exec(text))) return { category: 'social', reason: `réseau social (« ${m[0]} »)` };
  if ((m = MARKETPLACE_RE.exec(text)))
    return { category: 'marketplace', reason: `boutique / plateforme (« ${m[0]} »)` };

  // Un humain : vraie conversation, ou adresse de messagerie grand public
  // qui n'est ni un robot ni une liste de diffusion.
  if (s.conversational) return { category: 'person', reason: 'vous avez déjà échangé (conversation)' };
  const newsletterRatio = s.messageCount > 0 ? s.unsubscribeCount / s.messageCount : 0;
  if (PERSONAL_DOMAIN_RE.test(s.email) && !AUTO_SENDER_RE.test(s.email) && newsletterRatio < 0.5) {
    return { category: 'person', reason: 'adresse de messagerie personnelle' };
  }

  if (newsletterRatio >= 0.8)
    return {
      category: 'newsletter',
      reason: `lien de désinscription sur ${Math.round(newsletterRatio * 100)} % des mails`,
    };
  if ((m = AUTO_SENDER_RE.exec(s.email)))
    return { category: 'notification', reason: `adresse automatique (« ${m[0]} »)` };
  if ((m = AD_RE.exec(text))) return { category: 'ad', reason: `expéditeur publicitaire (« ${m[0]} »)` };
  return { category: 'company', reason: 'entreprise / service (par défaut)' };
}

// ---------------------------------------------------------- Pourquoi il écrit ?

export const MESSAGE_INTENTS = [
  'otp',
  'invoice',
  'shipping',
  'appointment',
  'reminder',
  'confirmation',
  'document',
  'promo',
  'reply_expected',
  'info',
] as const;
export type MessageIntent = (typeof MESSAGE_INTENTS)[number];

export const MESSAGE_INTENT_LABELS: Record<MessageIntent, string> = {
  otp: 'Code de connexion',
  invoice: 'Facture / paiement',
  shipping: 'Livraison',
  appointment: 'Rendez-vous',
  reminder: 'Rappel / relance',
  confirmation: 'Confirmation',
  document: 'Document',
  promo: 'Promotion',
  reply_expected: 'Attend une réponse',
  info: 'Information',
};

// Ordre = priorité (le premier motif qui matche gagne). FR + EN courant.
// Les motifs FORTS priment sur une question ; les motifs FAIBLES (confirmation,
// document, promo) cèdent devant un sujet qui pose une question à un humain
// (« Peux-tu me renvoyer le contrat ? » = réponse attendue, pas « document »).
const STRONG_INTENTS: MessageIntent[] = ['otp', 'invoice', 'shipping', 'appointment', 'reminder'];
const INTENT_RULES: { intent: MessageIntent; re: RegExp; label: string }[] = [
  {
    intent: 'otp',
    re: /(code (de |d')?(v[ée]rification|s[ée]curit[ée]|confirmation|connexion|validation|activation)|verification code|security code|one[- ]?time (code|password|passcode)|\botp\b|votre code (est|:)|code unique)/i,
    label: 'code de connexion à usage unique',
  },
  {
    intent: 'invoice',
    re: /(factur|invoice|[àa] r[ée]gler|[ée]ch[ée]ance de paiement|avis d'[ée]ch[ée]ance|pr[ée]l[èe]vement|montant d[ûu]|paiement (refus[ée]|rejet[ée]|en attente|requis)|impay[ée]|votre abonnement.*(paiement|renouvel)|mise en demeure)/i,
    label: 'facture ou paiement demandé',
  },
  {
    intent: 'shipping',
    re: /(colis|exp[ée]di[ée]|en cours de livraison|a [ée]t[ée] livr[ée]|sera livr[ée]|\bshipped\b|shipping|out for delivery|suivi (de )?(commande|colis|livraison)|\btracking\b|transporteur|point relais)/i,
    label: 'suivi de livraison',
  },
  {
    intent: 'appointment',
    re: /(rendez[- ]?vous|\brdv\b|convocation|invitation [àa]|r[ée]union|\bmeeting\b|visioconf|cr[ée]neau)/i,
    label: 'rendez-vous ou convocation',
  },
  {
    intent: 'reminder',
    re: /(\brappel\b|relance|dernier avis|n'oubliez pas|\breminder\b|action requise|en attente de votre)/i,
    label: 'rappel ou relance',
  },
  {
    intent: 'confirmation',
    re: /(confirmation|confirm[ée](e|é)?\b|votre commande|order (confirmation|received)|r[ée]servation|re[çc]u de paiement|\breceipt\b|votre billet|inscription (valid[ée]e|enregistr[ée]e)|bienvenue|merci pour (votre|ton) (commande|achat|paiement|inscription))/i,
    label: 'confirmation (commande, réservation, inscription…)',
  },
  {
    intent: 'document',
    re: /(attestation|contrat|devis|justificatif|bulletin|relev[ée]|document (disponible|[àa] signer)|votre document|signature (requise|[ée]lectronique)|pi[èe]ce jointe)/i,
    label: 'document transmis ou à signer',
  },
  {
    intent: 'promo',
    re: /(\bpromo(tion)?s?\b|\bsoldes?\b|r[ée]duction|remise|% (de remise|off)|-\s?\d{1,2}\s?%|vente (flash|priv[ée]e)|black friday|bon plan|offre (sp[ée]ciale|exclusive|limit[ée]e)|derni[èe]re chance|d[ée]stockage|code promo|\bexclusif\b|\bgratuit\b)/i,
    label: 'offre commerciale',
  },
];

export interface IntentSignals {
  subject: string | null | undefined;
  hasListUnsubscribe: boolean;
  fromEmail?: string | null;
}

export interface IntentResult {
  intent: MessageIntent;
  reason: string;
}

/** Détecte l'intention d'un mail ENTRANT depuis son sujet et ses en-têtes. */
export function detectIntent(s: IntentSignals): IntentResult {
  const subject = (s.subject ?? '').trim();
  // Une question posée par autre chose qu'une liste de diffusion / un robot.
  const isQuestion =
    subject.includes('?') &&
    !s.hasListUnsubscribe &&
    !(s.fromEmail && AUTO_SENDER_RE.test(s.fromEmail));

  for (const rule of INTENT_RULES) {
    if (isQuestion && !STRONG_INTENTS.includes(rule.intent)) break;
    const m = rule.re.exec(subject);
    if (m) return { intent: rule.intent, reason: `${rule.label} (« ${m[0].trim()} »)` };
  }
  if (isQuestion) return { intent: 'reply_expected', reason: 'le sujet pose une question' };
  return { intent: 'info', reason: 'aucun motif particulier — mail d’information' };
}

// ------------------------------------------------- Confiance de l'analyse (B4)

export const CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

export const CONFIDENCE_LABELS: Record<ConfidenceLevel, string> = {
  high: 'forte',
  medium: 'moyenne',
  low: 'faible',
};

// Intentions détectées par un motif FORT (peu ambigu) vs mot générique seul.
const STRONG_INTENT_SET = new Set(['otp', 'invoice', 'shipping', 'appointment', 'reminder']);
const WEAK_INTENT_SET = new Set(['confirmation', 'document', 'promo']);

// Concordance expéditeur ↔ intention : « ma banque m'envoie une facture »
// est cohérent ; « une entreprise inconnue m'envoie une confirmation » non.
const CONCORDANT_INTENTS: Record<string, string[]> = {
  bank: ['invoice', 'document', 'reminder', 'appointment', 'otp', 'confirmation', 'info'],
  insurance: ['invoice', 'document', 'reminder', 'appointment', 'otp', 'confirmation', 'info'],
  admin: ['invoice', 'document', 'reminder', 'appointment', 'otp', 'confirmation', 'info'],
  marketplace: ['shipping', 'confirmation', 'invoice', 'promo', 'otp', 'reminder'],
  social: ['info', 'confirmation', 'otp', 'reminder'],
  newsletter: ['promo', 'info'],
  notification: ['otp', 'confirmation', 'shipping', 'reminder', 'info', 'document'],
  ad: ['promo', 'info'],
  person: ['reply_expected', 'info', 'appointment', 'document', 'question'],
};

export interface ConfidenceSignals {
  senderCategory: string | null;
  senderCategorySource: string; // auto | manual
  intent: string | null;
  /** Verdict B2 le plus récent sur ce mail (moteurs de catégorisation/nettoyage). */
  feedback?: 'correct' | 'incorrect' | 'unsure' | null;
}

export interface ConfidenceResult {
  level: ConfidenceLevel;
  reason: string;
}

/**
 * Confiance de l'analyse d'un mail (B4) :
 *  - forte : verdict « correct » (B2), catégorie corrigée à la main, ou
 *    expéditeur identifié ET intention concordante ;
 *  - moyenne : UN signal fort (expéditeur identifié OU motif d'intention fort) ;
 *  - faible : mot générique seul, ou verdict « incorrect » (B2).
 * FAIBLE ⇒ le mail est protégé de toute suppression automatique.
 */
export function computeConfidence(s: ConfidenceSignals): ConfidenceResult {
  if (s.feedback === 'incorrect') {
    return { level: 'low', reason: 'tu as jugé cette analyse incorrecte (Vérifier l’analyse)' };
  }
  if (s.feedback === 'correct') {
    return { level: 'high', reason: 'tu as jugé cette analyse correcte (Vérifier l’analyse)' };
  }
  if (s.senderCategorySource === 'manual' && s.senderCategory) {
    return { level: 'high', reason: 'catégorie de l’expéditeur choisie par toi' };
  }
  // « company » est la catégorie PAR DÉFAUT (aucune marque reconnue) : ce
  // n'est pas un signal. Toute autre catégorie posée l'est par un motif réel.
  const senderStrong = Boolean(s.senderCategory && s.senderCategory !== 'company');
  const intentStrong = Boolean(s.intent && STRONG_INTENT_SET.has(s.intent));
  if (senderStrong && s.intent && (CONCORDANT_INTENTS[s.senderCategory as string] ?? []).includes(s.intent)) {
    return {
      level: 'high',
      reason: `expéditeur (${SENDER_CATEGORY_LABELS[s.senderCategory as SenderCategory] ?? s.senderCategory}) et intention (${MESSAGE_INTENT_LABELS[s.intent as MessageIntent] ?? s.intent}) concordent`,
    };
  }
  if (senderStrong) {
    return {
      level: 'medium',
      reason: `un seul signal fort : expéditeur identifié (${SENDER_CATEGORY_LABELS[s.senderCategory as SenderCategory] ?? s.senderCategory})`,
    };
  }
  if (intentStrong) {
    return {
      level: 'medium',
      reason: `un seul signal fort : motif d’intention net (${MESSAGE_INTENT_LABELS[s.intent as MessageIntent] ?? s.intent})`,
    };
  }
  if (s.intent && WEAK_INTENT_SET.has(s.intent)) {
    return { level: 'low', reason: 'mot générique seul (« confirmation », « document », « promo »…)' };
  }
  return { level: 'low', reason: 'aucun signal fort (expéditeur non identifié, pas de motif net)' };
}

/**
 * Pose la confiance sur les mails ENTRANTS d'un compte (index-only,
 * idempotent). `onlyMissing` = passe incrémentale post-sync (mails jamais
 * évalués) ; le backfill 🏷️ recalcule tout. Les verdicts B2 des moteurs de
 * catégorisation/nettoyage (newsletter, notification, cleanup) priment.
 */
export async function computeConfidenceForAccount(
  accountSlug: string,
  opts: { onlyMissing?: boolean } = {},
  progress: (message: string) => void = () => {},
): Promise<number> {
  await ensureDbReady();
  const senders = new Map(
    (
      await db.sender.findMany({
        where: { accountSlug },
        select: { email: true, category: true, categorySource: true },
      })
    ).map((s) => [s.email, s]),
  );
  const feedback = new Map<number, string>();
  for (const f of await db.analysisFeedback.findMany({
    where: { accountSlug, engine: { in: ['newsletter', 'notification', 'cleanup'] } },
    orderBy: { updatedAt: 'asc' },
    select: { messageId: true, verdict: true },
  })) {
    feedback.set(f.messageId, f.verdict); // le plus récent gagne (tri asc)
  }

  let cursor = 0;
  let updated = 0;
  for (;;) {
    const batch = await db.message.findMany({
      where: {
        accountSlug,
        isDeleted: false,
        isOutbound: false,
        id: { gt: cursor },
        ...(opts.onlyMissing ? { analysisConfidence: null } : {}),
      },
      orderBy: { id: 'asc' },
      take: BATCH,
      select: {
        id: true,
        fromEmail: true,
        intent: true,
        analysisConfidence: true,
        analysisConfidenceReason: true,
      },
    });
    if (batch.length === 0) break;
    cursor = batch[batch.length - 1].id;

    const groups = new Map<string, { level: string; reason: string; ids: number[] }>();
    for (const msg of batch) {
      const sender = msg.fromEmail ? senders.get(msg.fromEmail) : undefined;
      const r = computeConfidence({
        senderCategory: sender?.category ?? null,
        senderCategorySource: sender?.categorySource ?? 'auto',
        intent: msg.intent,
        feedback: (feedback.get(msg.id) as 'correct' | 'incorrect' | 'unsure' | undefined) ?? null,
      });
      if (msg.analysisConfidence === r.level && msg.analysisConfidenceReason === r.reason) continue;
      const key = `${r.level} ${r.reason}`;
      const g = groups.get(key) ?? { level: r.level, reason: r.reason, ids: [] };
      g.ids.push(msg.id);
      groups.set(key, g);
    }
    for (const g of groups.values()) {
      await db.message.updateMany({
        where: { id: { in: g.ids } },
        data: { analysisConfidence: g.level, analysisConfidenceReason: g.reason },
      });
      updated += g.ids.length;
    }
    if (updated) progress(`${accountSlug} : confiance posée sur ${updated} mails…`);
  }
  return updated;
}

// ------------------------------------------------------------------- Backfill

const BATCH = 1000;

/**
 * Recalcule l'intention de TOUS les mails entrants indexés d'un compte
 * (idempotent : seuls les changements sont écrits), puis les catégories
 * d'expéditeurs via rebuildSenders (qui respecte categorySource=manual).
 * Index-only : aucune connexion IMAP.
 */
export async function categorizeAccount(
  accountSlug: string,
  progress: (message: string) => void = () => {},
): Promise<{
  messagesScanned: number;
  messagesUpdated: number;
  sendersUpdated: number;
  confidenceUpdated: number;
}> {
  await ensureDbReady();
  let cursor = 0;
  let scanned = 0;
  let updated = 0;
  for (;;) {
    const batch = await db.message.findMany({
      where: { accountSlug, isDeleted: false, isOutbound: false, id: { gt: cursor } },
      orderBy: { id: 'asc' },
      take: BATCH,
      select: {
        id: true,
        subject: true,
        fromEmail: true,
        hasListUnsubscribe: true,
        intent: true,
        intentReason: true,
      },
    });
    if (batch.length === 0) break;
    cursor = batch[batch.length - 1].id;
    scanned += batch.length;

    // Regroupe les écritures par (intent, raison) identiques → peu de requêtes.
    const groups = new Map<string, { intent: string; reason: string; ids: number[] }>();
    for (const msg of batch) {
      const r = detectIntent(msg);
      if (msg.intent === r.intent && msg.intentReason === r.reason) continue;
      const key = `${r.intent} ${r.reason}`;
      const g = groups.get(key) ?? { intent: r.intent, reason: r.reason, ids: [] };
      g.ids.push(msg.id);
      groups.set(key, g);
    }
    for (const g of groups.values()) {
      await db.message.updateMany({
        where: { id: { in: g.ids } },
        data: { intent: g.intent, intentReason: g.reason },
      });
      updated += g.ids.length;
    }
    progress(`${accountSlug} : ${scanned} mails analysés (${updated} mis à jour)…`);
  }

  const { rebuildSenders } = await import('./sync.js');
  const sendersUpdated = await rebuildSenders(accountSlug);
  progress(`${accountSlug} : catégories recalculées pour ${sendersUpdated} expéditeurs.`);

  // Confiance (B4) : recalcul COMPLET — les catégories viennent de changer.
  const confidenceUpdated = await computeConfidenceForAccount(accountSlug, {}, progress);
  progress(`${accountSlug} : confiance de l'analyse posée (${confidenceUpdated} mails mis à jour).`);
  return { messagesScanned: scanned, messagesUpdated: updated, sendersUpdated, confidenceUpdated };
}

// -------------------------------------------------- Priorité par relation (A5)

export const SENDER_PRIORITIES = ['normal', 'always_important', 'never_urgent'] as const;
export type SenderPriority = (typeof SENDER_PRIORITIES)[number];

/**
 * Priorité par relation (A5) : « Soraya, toujours important » / « Amazon,
 * jamais urgent ». Choix de l'utilisateur, jamais recalculé par la sync ;
 * pris en compte par le score d'importance (+40 / plafond 30).
 */
export async function setSenderPriority(
  accountSlug: string,
  email: string,
  priority: SenderPriority,
): Promise<{ email: string; priority: SenderPriority }> {
  await ensureDbReady();
  const normalized = email.trim().toLowerCase();
  const sender = await db.sender.findUnique({
    where: { accountSlug_email: { accountSlug, email: normalized } },
    select: { id: true },
  });
  if (!sender) throw new Error(`Expéditeur inconnu de l'index : ${normalized}`);
  await db.sender.update({ where: { id: sender.id }, data: { priority } });
  return { email: normalized, priority };
}

/**
 * Corrige la catégorie d'un expéditeur à la main (categorySource=manual —
 * plus jamais écrasée par la sync), ou repasse en automatique (category=null).
 */
export async function setSenderCategory(
  accountSlug: string,
  email: string,
  category: SenderCategory | null,
): Promise<{ email: string; category: string; source: string; reason: string }> {
  await ensureDbReady();
  const normalized = email.trim().toLowerCase();
  const sender = await db.sender.findUnique({
    where: { accountSlug_email: { accountSlug, email: normalized } },
  });
  if (!sender) throw new Error(`Expéditeur inconnu de l'index : ${normalized}`);

  if (category === null) {
    // Retour au calcul automatique, recalculé immédiatement pour cet expéditeur.
    const conv = await db.message.findFirst({
      where: {
        accountSlug,
        fromEmail: normalized,
        isDeleted: false,
        isOutbound: false,
        thread: { is: { messages: { some: { isOutbound: true, isDeleted: false } } } },
      },
      select: { id: true },
    });
    const auto = categorizeSender({
      email: normalized,
      displayName: sender.displayName,
      messageCount: sender.messageCount,
      unsubscribeCount: sender.unsubscribeCount,
      conversational: conv !== null,
    });
    await db.sender.update({
      where: { id: sender.id },
      data: { category: auto.category, categorySource: 'auto', categoryReason: auto.reason },
    });
    return { email: normalized, category: auto.category, source: 'auto', reason: auto.reason };
  }

  const reason = 'catégorie choisie par toi';
  await db.sender.update({
    where: { id: sender.id },
    data: { category, categorySource: 'manual', categoryReason: reason },
  });
  return { email: normalized, category, source: 'manual', reason };
}
