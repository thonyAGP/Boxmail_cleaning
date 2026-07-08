import nodemailer from 'nodemailer';
import { config } from '../config.js';
import { accessTokenFor, type AccountRecord } from './accounts.js';

/**
 * Envoi SMTP via XOAUTH2 — HORS SCOPE v1 (SPEC §5). Gardé derrière le flag
 * ENABLE_SMTP_SEND (défaut false). Le code existe pour la v2 mais refuse de
 * s'exécuter tant que le flag n'est pas explicitement activé.
 */
export async function sendEmail(
  rec: AccountRecord,
  msg: { to: string; subject: string; text: string },
): Promise<{ messageId: string }> {
  if (!config.smtp.enabled) {
    throw new Error(
      "Envoi SMTP désactivé (ENABLE_SMTP_SEND=false). Fonctionnalité hors scope v1.",
    );
  }

  const { accessToken, username } = await accessTokenFor(rec);
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

  const info = await transport.sendMail({
    from: username,
    to: msg.to,
    subject: msg.subject,
    text: msg.text,
  });
  return { messageId: info.messageId };
}
