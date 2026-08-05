import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { config } from '../config.js';
import { accessTokenFor, type AccountRecord } from './accounts.js';

/**
 * Envoi SMTP via XOAUTH2 (L5.3). Activé par défaut depuis le rattrapage
 * maquette (07/2026) — ENABLE_SMTP_SEND=false pour couper. Garde-fous côté
 * appelants : confirmation explicite avant envoi, journalisation complète,
 * jamais d'envoi automatique.
 *
 * Le message est composé UNE fois (RFC822 brut) : le même contenu part par
 * SMTP et est déposé dans « Éléments envoyés » (Outlook ne le fait pas tout
 * seul pour les envois SMTP).
 */

export interface OutgoingAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
  /** Image « en ligne » : identifiant référencé par le HTML (src="cid:…"). */
  cid?: string;
}

export interface OutgoingMail {
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  /** Version HTML du corps (images en ligne) — le texte reste la version de secours. */
  html?: string;
  /** Pièces jointes (et images en ligne via cid). */
  attachments?: OutgoingAttachment[];
  /** Message-ID du mail auquel on répond (fil de discussion). */
  inReplyTo?: string;
  references?: string[];
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Valide et normalise les destinataires ; jette une erreur claire sinon. */
export function validateRecipients(list: unknown, label: string): string[] {
  const arr = Array.isArray(list) ? list : typeof list === 'string' ? list.split(/[,;]/) : [];
  const out: string[] = [];
  for (const raw of arr) {
    if (typeof raw !== 'string') continue;
    const a = raw.trim();
    if (!a) continue;
    if (!EMAIL_RE.test(a)) {
      throw new Error(`Adresse invalide dans « ${label} » : ${a}`);
    }
    out.push(a);
  }
  return [...new Set(out.map((a) => a.toLowerCase()))].slice(0, 50);
}

/** Compose le message RFC822 (utilisé pour l'envoi ET la copie Envoyés). */
export async function composeMessage(from: string, msg: OutgoingMail): Promise<Buffer> {
  const composer = new MailComposer({
    from,
    to: msg.to,
    cc: msg.cc?.length ? msg.cc : undefined,
    subject: msg.subject,
    text: msg.text,
    html: msg.html || undefined,
    attachments: msg.attachments?.length ? msg.attachments : undefined,
    inReplyTo: msg.inReplyTo,
    references: msg.references?.length ? msg.references : undefined,
    date: new Date(),
  });
  return composer.compile().build();
}

export async function sendEmail(
  rec: AccountRecord,
  msg: OutgoingMail,
): Promise<{ raw: Buffer; recipients: string[]; from: string }> {
  if (!config.smtp.enabled) {
    throw new Error(
      "Envoi désactivé sur ce serveur (ENABLE_SMTP_SEND=false dans le .env).",
    );
  }
  if (msg.to.length === 0) throw new Error('Aucun destinataire.');
  if (!msg.subject.trim()) throw new Error('Objet vide.');

  const { accessToken, username } = await accessTokenFor(rec);
  const raw = await composeMessage(username, msg);
  const recipients = [...msg.to, ...(msg.cc ?? [])];

  const transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: false, // STARTTLS sur 587
    auth: {
      type: 'OAuth2',
      user: username,
      accessToken,
    },
  });
  await transport.sendMail({
    envelope: { from: username, to: recipients },
    raw,
  });
  return { raw, recipients, from: username };
}
