import { ImapFlow, type ListResponse, type SearchObject } from 'imapflow';
import { simpleParser } from 'mailparser';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { accessTokenFor, type AccountRecord } from './accounts.js';

/**
 * Couche IMAP (imapflow + XOAUTH2). Un pool d'une connexion par compte actif ;
 * la connexion est recréée quand l'access token approche de l'expiration ou
 * que la socket n'est plus utilisable.
 *
 * Toutes les opérations verrouillent la mailbox le temps de la commande.
 */

interface PooledClient {
  client: ImapFlow;
  expiresAt: number;
}

export interface FolderInfo {
  path: string;
  name: string;
  delimiter: string;
  parentPath: string;
  specialUse: string | null;
  subscribed: boolean;
}

export interface SenderStat {
  address: string;
  name: string;
  count: number;
  latestDate: string | null;
  totalSizeBytes: number;
  unsubscribeCount: number;
  /** Part des mails de cet expéditeur portant un header List-Unsubscribe. */
  unsubscribePct: number;
}

export interface EmailMeta {
  uid: number;
  from: string;
  fromName: string;
  subject: string;
  date: string | null;
  flags: string[];
}

export interface EmailBody {
  uid: number;
  subject: string;
  from: string;
  to: string;
  date: string | null;
  text: string;
  truncated: boolean;
  attachments: { filename: string; contentType: string; sizeBytes: number }[];
}

export interface DeletePreview {
  count: number;
  senders: { address: string; name: string; count: number }[];
  sampleSubjects: string[];
  dateRange: { from: string | null; to: string | null };
  /** Détail par mail (sujet + date), pour la journalisation exacte. */
  items: { subject: string; date: string | null }[];
}

export function normalizeSubject(subject: string | undefined): string {
  if (!subject) return '';
  // Retire les préfixes de réponse/transfert répétés (multi-langue).
  return subject
    .replace(/^(\s*(re|fwd?|tr|aw|wg|sv|antw)\s*(\[\d+\])?\s*:\s*)+/i, '')
    .trim()
    .toLowerCase();
}

function toIso(d: Date | string | undefined | null): string | null {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

class ImapService {
  private pool = new Map<string, PooledClient>();

  private async getClient(rec: AccountRecord): Promise<ImapFlow> {
    const existing = this.pool.get(rec.account);
    if (existing && existing.client.usable && existing.expiresAt > Date.now() + 5 * 60_000) {
      return existing.client;
    }
    if (existing) {
      try {
        await existing.client.logout();
      } catch {
        /* ignore */
      }
      this.pool.delete(rec.account);
    }

    const { accessToken, username, expiresOn } = await accessTokenFor(rec);
    const client = new ImapFlow({
      host: config.imap.host,
      port: config.imap.port,
      secure: true,
      auth: { user: username, accessToken },
      logger: false,
      // Ne pas garder d'IDLE ouvert : connexions courtes déclenchées à la demande.
      disableAutoIdle: true,
    });

    client.on('error', (err) => {
      logger.warn('erreur socket IMAP', { account: rec.account, error: (err as Error).message });
    });

    await client.connect();
    this.pool.set(rec.account, {
      client,
      expiresAt: expiresOn ? expiresOn.getTime() : Date.now() + 50 * 60_000,
    });
    logger.debug('connexion IMAP établie', { account: rec.account });
    return client;
  }

  /**
   * Prête la connexion du pool à un appelant (ex. le moteur de sync) le temps
   * d'un traitement. La connexion reste gérée par le pool.
   */
  async withClient<T>(rec: AccountRecord, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const client = await this.getClient(rec);
    return fn(client);
  }

  /** Ferme toutes les connexions (arrêt propre). */
  async closeAll(): Promise<void> {
    for (const [name, pc] of this.pool) {
      try {
        await pc.client.logout();
      } catch {
        /* ignore */
      }
      this.pool.delete(name);
    }
  }

  // --- Dossiers -------------------------------------------------------------

  async listFolders(rec: AccountRecord): Promise<FolderInfo[]> {
    const client = await this.getClient(rec);
    const list: ListResponse[] = await client.list();
    return list.map((m) => ({
      path: m.path,
      name: m.name,
      delimiter: m.delimiter,
      parentPath: m.parentPath,
      specialUse: m.specialUse ?? null,
      subscribed: m.subscribed,
    }));
  }

  /** Compteurs d'un dossier (messages / non lus) — utile pour le diagnostic. */
  async getStatus(
    rec: AccountRecord,
    folder = 'INBOX',
  ): Promise<{ path: string; messages: number; unseen: number }> {
    const client = await this.getClient(rec);
    const status = await client.status(folder, { messages: true, unseen: true });
    return { path: folder, messages: status.messages ?? 0, unseen: status.unseen ?? 0 };
  }

  async createFolder(rec: AccountRecord, path: string): Promise<{ created: boolean; path: string }> {
    const client = await this.getClient(rec);
    const res = await client.mailboxCreate(path);
    return { created: Boolean(res?.created), path: res?.path ?? path };
  }

  private async findSpecialFolder(client: ImapFlow, use: string): Promise<string | null> {
    const list = await client.list();
    const match = list.find((m) => m.specialUse === use);
    return match?.path ?? null;
  }

  // --- Statistiques par expéditeur -----------------------------------------

  async getSenderStats(
    rec: AccountRecord,
    folder: string,
    limit: number,
    since?: string,
  ): Promise<{ totalMessages: number; senders: SenderStat[] }> {
    const client = await this.getClient(rec);
    const lock = await client.getMailboxLock(folder);
    try {
      const range: SearchObject = since ? { since: new Date(since) } : { all: true };
      type Agg = {
        address: string;
        name: string;
        count: number;
        latest: number | null;
        size: number;
        unsub: number;
      };
      const map = new Map<string, Agg>();
      let total = 0;

      for await (const msg of client.fetch(
        range,
        { uid: true, envelope: true, size: true, internalDate: true, headers: ['list-unsubscribe'] },
        { uid: true },
      )) {
        total++;
        const fromAddr = msg.envelope?.from?.[0];
        const address = (fromAddr?.address ?? 'unknown').toLowerCase();
        const name = fromAddr?.name ?? '';
        const ts = msg.internalDate
          ? (msg.internalDate instanceof Date
              ? msg.internalDate
              : new Date(msg.internalDate)
            ).getTime()
          : null;
        const hasUnsub =
          !!msg.headers && /list-unsubscribe\s*:/i.test(msg.headers.toString('utf8'));

        const agg = map.get(address) ?? {
          address,
          name,
          count: 0,
          latest: null,
          size: 0,
          unsub: 0,
        };
        agg.count++;
        if (!agg.name && name) agg.name = name;
        if (ts !== null && (agg.latest === null || ts > agg.latest)) agg.latest = ts;
        agg.size += msg.size ?? 0;
        if (hasUnsub) agg.unsub++;
        map.set(address, agg);
      }

      const senders: SenderStat[] = [...map.values()]
        .sort((a, b) => b.count - a.count)
        .slice(0, limit)
        .map((a) => ({
          address: a.address,
          name: a.name,
          count: a.count,
          latestDate: a.latest ? new Date(a.latest).toISOString() : null,
          totalSizeBytes: a.size,
          unsubscribeCount: a.unsub,
          unsubscribePct: a.count ? Math.round((a.unsub / a.count) * 100) : 0,
        }));

      return { totalMessages: total, senders };
    } finally {
      lock.release();
    }
  }

  // --- Recherche ------------------------------------------------------------

  async searchEmails(
    rec: AccountRecord,
    params: {
      folder: string;
      from?: string;
      subject?: string;
      since?: string;
      before?: string;
      seen?: boolean;
      limit: number;
    },
  ): Promise<{ total: number; emails: EmailMeta[] }> {
    const client = await this.getClient(rec);
    const lock = await client.getMailboxLock(params.folder);
    try {
      const query: SearchObject = {};
      if (params.from) query.from = params.from;
      if (params.subject) query.subject = params.subject;
      if (params.since) query.since = new Date(params.since);
      if (params.before) query.before = new Date(params.before);
      if (typeof params.seen === 'boolean') query.seen = params.seen;
      if (Object.keys(query).length === 0) query.all = true;

      const uids = (await client.search(query, { uid: true })) || [];
      // Les plus récents d'abord (UID croissant ≈ chronologique).
      const selected = uids.slice(-params.limit).reverse();
      const emails = selected.length
        ? await this.fetchMetaByUids(client, params.folder, selected)
        : [];
      return { total: uids.length, emails };
    } finally {
      lock.release();
    }
  }

  private async fetchMetaByUids(
    client: ImapFlow,
    _folder: string,
    uids: number[],
  ): Promise<EmailMeta[]> {
    const out: EmailMeta[] = [];
    for await (const msg of client.fetch(
      uids,
      { uid: true, envelope: true, flags: true, internalDate: true },
      { uid: true },
    )) {
      const from = msg.envelope?.from?.[0];
      out.push({
        uid: msg.uid,
        from: from?.address ?? '',
        fromName: from?.name ?? '',
        subject: msg.envelope?.subject ?? '',
        date: toIso(msg.internalDate ?? msg.envelope?.date),
        flags: msg.flags ? [...msg.flags] : [],
      });
    }
    // Conserver l'ordre demandé.
    const byUid = new Map(out.map((e) => [e.uid, e]));
    return uids.map((u) => byUid.get(u)).filter((e): e is EmailMeta => Boolean(e));
  }

  // --- Lecture d'un mail ----------------------------------------------------

  async readEmail(rec: AccountRecord, folder: string, uid: number): Promise<EmailBody> {
    const client = await this.getClient(rec);
    const lock = await client.getMailboxLock(folder);
    try {
      const dl = await client.download(String(uid), undefined, { uid: true });
      const parsed = await simpleParser(dl.content);

      let text = parsed.text ?? '';
      if (!text && parsed.html) {
        text = htmlToText(parsed.html);
      }
      const truncated = text.length > config.limits.maxBodyChars;
      if (truncated) text = text.slice(0, config.limits.maxBodyChars);

      const fromText = parsed.from?.text ?? '';
      const toText = Array.isArray(parsed.to)
        ? parsed.to.map((a) => a.text).join(', ')
        : parsed.to?.text ?? '';

      return {
        uid,
        subject: parsed.subject ?? '',
        from: fromText,
        to: toText,
        date: parsed.date ? parsed.date.toISOString() : null,
        text,
        truncated,
        attachments: (parsed.attachments ?? []).map((a) => ({
          filename: a.filename ?? '(sans nom)',
          contentType: a.contentType ?? 'application/octet-stream',
          sizeBytes: a.size ?? 0,
        })),
      };
    } finally {
      lock.release();
    }
  }

  /**
   * Télécharge UNE pièce jointe d'un mail (L5.9). `index` = position dans la
   * liste `attachments` renvoyée par readEmail (même parseur, même ordre).
   * Retourne null si l'index n'existe pas. Le mail complet est téléchargé puis
   * parsé — le cap de taille est vérifié en amont (route) sur sizeBytes.
   */
  async downloadAttachment(
    rec: AccountRecord,
    folder: string,
    uid: number,
    index: number,
  ): Promise<{ filename: string; contentType: string; content: Buffer } | null> {
    const client = await this.getClient(rec);
    const lock = await client.getMailboxLock(folder);
    try {
      const dl = await client.download(String(uid), undefined, { uid: true });
      const parsed = await simpleParser(dl.content);
      const att = (parsed.attachments ?? [])[index];
      if (!att) return null;
      return {
        filename: att.filename ?? `piece-jointe-${index + 1}`,
        contentType: att.contentType ?? 'application/octet-stream',
        content: att.content,
      };
    } finally {
      lock.release();
    }
  }

  // --- Fil de discussion ----------------------------------------------------

  async getThread(rec: AccountRecord, folder: string, uid: number): Promise<EmailMeta[]> {
    const client = await this.getClient(rec);
    const lock = await client.getMailboxLock(folder);
    try {
      const seed = await client.fetchOne(String(uid), { uid: true, envelope: true }, { uid: true });
      if (!seed || !seed.envelope) return [];
      const normSubject = normalizeSubject(seed.envelope.subject);
      const seedMsgId = seed.envelope.messageId;

      // Recherche large par sujet normalisé (substring IMAP), puis filtrage fin.
      const candidates = normSubject
        ? (await client.search({ subject: normSubject }, { uid: true })) || []
        : [uid];
      if (!candidates.includes(uid)) candidates.push(uid);

      const metas = await this.fetchMetaByUids(client, folder, candidates);
      // On garde ceux qui partagent le sujet normalisé (heuristique robuste et
      // suffisante ; References/In-Reply-To pourrait affiner en v2).
      const filtered = metas.filter((m) => normalizeSubject(m.subject) === normSubject || m.uid === uid);
      // Tri chronologique.
      filtered.sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
      void seedMsgId;
      return filtered;
    } finally {
      lock.release();
    }
  }

  // --- Écriture -------------------------------------------------------------

  async moveEmails(
    rec: AccountRecord,
    folder: string,
    uids: number[],
    destination: string,
  ): Promise<{ moved: number; destination: string }> {
    const client = await this.getClient(rec);
    const lock = await client.getMailboxLock(folder);
    try {
      if (uids.length === 0) return { moved: 0, destination };
      await client.messageMove(uids, destination, { uid: true });
      return { moved: uids.length, destination };
    } finally {
      lock.release();
    }
  }

  async markEmails(
    rec: AccountRecord,
    folder: string,
    uids: number[],
    add: string[],
    remove: string[],
  ): Promise<{ affected: number }> {
    const client = await this.getClient(rec);
    const lock = await client.getMailboxLock(folder);
    try {
      if (uids.length === 0) return { affected: 0 };
      if (add.length) await client.messageFlagsAdd(uids, add, { uid: true });
      if (remove.length) await client.messageFlagsRemove(uids, remove, { uid: true });
      return { affected: uids.length };
    } finally {
      lock.release();
    }
  }

  /** "Suppression" = déplacement vers Trash (soft delete, SPEC §6.2). */
  async moveToTrash(
    rec: AccountRecord,
    folder: string,
    uids: number[],
  ): Promise<{ moved: number; destination: string }> {
    const client = await this.getClient(rec);
    const trash = (await this.findSpecialFolder(client, '\\Trash')) ?? 'Deleted';
    if (folder === trash) {
      // Déjà dans la corbeille : ne rien faire (jamais d'EXPUNGE définitif en v1).
      return { moved: 0, destination: trash };
    }
    return this.moveEmails(rec, folder, uids, trash);
  }

  /**
   * Dépose une copie d'un mail envoyé dans « Éléments envoyés » (APPEND).
   * Outlook ne copie PAS automatiquement les envois SMTP : sans ça, le mail
   * n'apparaîtrait nulle part dans la boîte.
   */
  async appendToSent(rec: AccountRecord, raw: Buffer): Promise<{ folder: string }> {
    const client = await this.getClient(rec);
    const sent = (await this.findSpecialFolder(client, '\\Sent')) ?? 'Sent';
    await client.append(sent, raw, ['\\Seen']);
    return { folder: sent };
  }

  /** UIDs correspondant à une recherche (utilisé par bulk_delete_by_sender). */
  async searchUids(rec: AccountRecord, folder: string, query: SearchObject): Promise<number[]> {
    const client = await this.getClient(rec);
    const lock = await client.getMailboxLock(folder);
    try {
      return (await client.search(query, { uid: true })) || [];
    } finally {
      lock.release();
    }
  }

  /** Résumé "ce qui SERAIT supprimé" pour le mode dry-run (SPEC §6.1). */
  async summarize(rec: AccountRecord, folder: string, uids: number[]): Promise<DeletePreview> {
    if (uids.length === 0) {
      return {
        count: 0,
        senders: [],
        sampleSubjects: [],
        dateRange: { from: null, to: null },
        items: [],
      };
    }
    const metas = await (async () => {
      const client = await this.getClient(rec);
      const lock = await client.getMailboxLock(folder);
      try {
        return this.fetchMetaByUids(client, folder, uids);
      } finally {
        lock.release();
      }
    })();

    const senderMap = new Map<string, { address: string; name: string; count: number }>();
    let minDate: string | null = null;
    let maxDate: string | null = null;
    for (const m of metas) {
      const key = m.from.toLowerCase();
      const s = senderMap.get(key) ?? { address: m.from, name: m.fromName, count: 0 };
      s.count++;
      senderMap.set(key, s);
      if (m.date) {
        if (!minDate || m.date < minDate) minDate = m.date;
        if (!maxDate || m.date > maxDate) maxDate = m.date;
      }
    }

    return {
      count: metas.length,
      senders: [...senderMap.values()].sort((a, b) => b.count - a.count),
      sampleSubjects: metas.slice(0, 20).map((m) => m.subject),
      dateRange: { from: minDate, to: maxDate },
      items: metas.slice(0, 500).map((m) => ({ subject: m.subject, date: m.date })),
    };
  }
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const imapService = new ImapService();
