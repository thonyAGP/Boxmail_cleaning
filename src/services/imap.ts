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
      // 1. Métadonnées + structure du mail SANS télécharger le corps (rapide).
      const info = await client.fetchOne(
        String(uid),
        { uid: true, envelope: true, bodyStructure: true },
        { uid: true },
      );
      // Sans ce garde-fou, on descendait jusqu'à mailparser qui plantait sur
      // « Input cannot be null or undefined » — incompréhensible pour
      // l'utilisateur (constaté le 01/08 sur un mail du dossier Sent).
      if (!info) {
        throw new Error(
          'mail introuvable à cet emplacement — déplacé ou supprimé depuis la dernière synchronisation',
        );
      }
      const bs = (info && info.bodyStructure ? info.bodyStructure : null) as BodyNode | null;
      const textNode = findTextNode(bs);

      // 2. Chemin rapide : ne télécharger QUE la partie texte (quelques Ko),
      //    pas les pièces jointes. Repli plus bas si la structure est atypique.
      if (info && info.envelope && textNode && textNode.part) {
        try {
          const dl = await client.download(String(uid), textNode.part, { uid: true });
          const raw = await streamToBuffer(dl.content);
          let text = decodeText(raw, textNode.parameters?.charset);
          if ((textNode.type ?? '').toLowerCase() === 'text/html') text = htmlToText(text);
          const truncated = text.length > config.limits.maxBodyChars;
          if (truncated) text = text.slice(0, config.limits.maxBodyChars);
          const env = info.envelope;
          return {
            uid,
            subject: env.subject ?? '',
            from: formatEnvelopeAddr(env.from?.[0]),
            to: (env.to ?? []).map(formatEnvelopeAddr).filter(Boolean).join(', '),
            date: toIso(env.date),
            text,
            truncated,
            attachments: listAttachmentParts(bs).map((a) => ({
              filename: a.filename,
              contentType: a.contentType,
              sizeBytes: a.sizeBytes,
            })),
          };
        } catch (err) {
          logger.warn('readEmail: fetch partiel échoué, repli sur le mail complet', {
            message: (err as Error).message,
          });
        }
      }

      // 3. Repli : télécharger le mail complet et le parser (comportement d'origine).
      return await this.readEmailFull(client, uid);
    } finally {
      lock.release();
    }
  }

  /** Repli : mail complet + mailparser (structure atypique ou fetch partiel KO). */
  private async readEmailFull(client: ImapFlow, uid: number): Promise<EmailBody> {
    const dl = await client.download(String(uid), undefined, { uid: true });
    if (!dl || !dl.content) {
      throw new Error(
        'mail introuvable à cet emplacement — déplacé ou supprimé depuis la dernière synchronisation',
      );
    }
    const parsed = await simpleParser(dl.content);
    let text = parsed.text ?? '';
    if (!text && parsed.html) text = htmlToText(parsed.html);
    const truncated = text.length > config.limits.maxBodyChars;
    if (truncated) text = text.slice(0, config.limits.maxBodyChars);
    const toText = Array.isArray(parsed.to)
      ? parsed.to.map((a) => a.text).join(', ')
      : parsed.to?.text ?? '';
    return {
      uid,
      subject: parsed.subject ?? '',
      from: parsed.from?.text ?? '',
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
  }

  /**
   * Télécharge UNE pièce jointe d'un mail (L5.9). `index` = position dans la
   * liste `attachments` renvoyée par readEmail (même ordre). On ne télécharge
   * QUE la partie demandée via son identifiant MIME ; repli sur le mail complet
   * si la structure est atypique. Retourne null si l'index n'existe pas.
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
      const info = await client.fetchOne(String(uid), { uid: true, bodyStructure: true }, { uid: true });
      const parts = listAttachmentParts((info && info.bodyStructure ? info.bodyStructure : null) as BodyNode | null);
      const target = parts[index];
      if (target) {
        try {
          const dl = await client.download(String(uid), target.part, { uid: true });
          const content = await streamToBuffer(dl.content);
          return { filename: target.filename, contentType: target.contentType, content };
        } catch (err) {
          logger.warn('downloadAttachment: fetch partiel échoué, repli sur le mail complet', {
            message: (err as Error).message,
          });
        }
      } else if (parts.length > 0) {
        // La structure est lisible mais l'index dépasse : pièce inexistante.
        return null;
      }
      // Repli : mail complet + mailparser (même ordre que readEmailFull).
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

  /**
   * Télécharge TOUTES les pièces jointes d'un mail en une fois (pour un .zip).
   * Ici on assume tout le message (on veut toutes les parties de toute façon) —
   * une seule descente IMAP, puis mailparser pour découper proprement.
   */
  async downloadAllAttachments(
    rec: AccountRecord,
    folder: string,
    uid: number,
  ): Promise<{ filename: string; content: Buffer }[]> {
    const client = await this.getClient(rec);
    const lock = await client.getMailboxLock(folder);
    try {
      const dl = await client.download(String(uid), undefined, { uid: true });
      const parsed = await simpleParser(dl.content);
      return (parsed.attachments ?? []).map((a, i) => ({
        filename: a.filename ?? `piece-jointe-${i + 1}`,
        content: a.content,
      }));
    } finally {
      lock.release();
    }
  }

  /**
   * En-têtes de désinscription d'un mail (P2.2). Deux lignes d'en-tête, aucun
   * corps : c'est l'opération la plus légère possible côté IMAP.
   */
  async fetchUnsubscribeHeaders(
    rec: AccountRecord,
    folder: string,
    uid: number,
  ): Promise<{ listUnsubscribe?: string; listUnsubscribePost?: string } | null> {
    const client = await this.getClient(rec);
    const lock = await client.getMailboxLock(folder);
    try {
      const msg = await client.fetchOne(
        String(uid),
        { uid: true, headers: ['list-unsubscribe', 'list-unsubscribe-post'] },
        { uid: true },
      );
      if (!msg || !msg.headers) return null;
      const raw = msg.headers.toString('utf8');
      const pick = (name: string): string | undefined => {
        // En-tête éventuellement replié sur plusieurs lignes (RFC 5322).
        const re = new RegExp(`^${name}\\s*:([\\s\\S]*?)(?=\\r?\\n[^\\s]|$)`, 'im');
        return re.exec(raw)?.[1]?.replace(/\r?\n\s+/g, ' ').trim();
      };
      return {
        listUnsubscribe: pick('list-unsubscribe'),
        listUnsubscribePost: pick('list-unsubscribe-post'),
      };
    } finally {
      lock.release();
    }
  }

  /**
   * Texte brut d'un LOT de mails d'un dossier (C1 — pré-requis de l'analyse
   * de contenu). Un seul verrouillage de boîte, une plage `a:b` pour la
   * structure (jamais de longue liste d'UIDs : limite de commande Outlook),
   * puis, mail par mail, le téléchargement de LA SEULE partie texte.
   *
   * Les pièces jointes ne sont JAMAIS téléchargées : contrairement à
   * `readEmail`, il n'y a pas de repli sur le mail complet — sur un rattrapage
   * de plusieurs milliers de mails, ce repli aspirerait toute la boîte. Un mail
   * dont la structure n'expose pas de partie texte est simplement absent de la
   * Map ; l'appelant le marquera comme traité pour ne pas le reproposer.
   *
   * Retourne uid → texte brut décodé (HTML aplati), borné à 4000 caractères ;
   * le nettoyage fin (texte cité, espaces) appartient à services/snippets.ts.
   */
  async fetchSnippets(
    rec: AccountRecord,
    folder: string,
    uids: number[],
  ): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    if (uids.length === 0) return out;
    const RAW_MAX_CHARS = 4000;
    const wanted = new Set(uids);
    const sorted = [...uids].sort((a, b) => a - b);

    const client = await this.getClient(rec);
    const lock = await client.getMailboxLock(folder);
    try {
      // 1. Structures seules : rapide, et on ne descend que ce qui a du texte.
      const targets: { uid: number; part: string; charset?: string; isHtml: boolean }[] = [];
      for await (const msg of client.fetch(
        `${sorted[0]}:${sorted[sorted.length - 1]}`,
        { uid: true, bodyStructure: true },
        { uid: true },
      )) {
        if (!wanted.has(msg.uid)) continue; // la plage peut couvrir des mails non demandés
        const node = findTextNode((msg.bodyStructure ?? null) as BodyNode | null);
        if (!node?.part) continue;
        targets.push({
          uid: msg.uid,
          part: node.part,
          charset: node.parameters?.charset,
          isHtml: (node.type ?? '').toLowerCase() === 'text/html',
        });
      }

      // 2. Une descente par mail, sur la partie texte uniquement. Un échec
      //    isolé (mail supprimé entre-temps, partie illisible) n'arrête pas
      //    le lot : le rattrapage doit pouvoir avancer sur des milliers de mails.
      for (const t of targets) {
        try {
          const dl = await client.download(String(t.uid), t.part, { uid: true });
          // imapflow renvoie un objet SANS `content` quand la partie n'existe
          // plus (mail supprimé entre le fetch et le download). Sans ce garde,
          // streamToBuffer(undefined) lançait « Cannot read properties of
          // undefined (Symbol.asyncIterator) » en boucle — constaté en réel.
          if (!dl?.content) continue;
          const raw = await streamToBuffer(dl.content);
          let text = decodeText(raw, t.charset);
          if (t.isHtml) text = htmlToText(text);
          if (text.length > RAW_MAX_CHARS) text = text.slice(0, RAW_MAX_CHARS);
          out.set(t.uid, text);
        } catch (err) {
          logger.warn('extrait : téléchargement de la partie texte en échec', {
            account: rec.account,
            folder,
            uid: t.uid,
            message: (err as Error).message,
          });
        }
      }
    } finally {
      lock.release();
    }
    return out;
  }

  /**
   * Quota de stockage de la boîte (RFC 2087 — supporté par Outlook.com).
   * Retourne null si le serveur ne l'expose pas.
   *
   * ⚠️ Champ `usage` vs `used` : le .d.ts d'imapflow declare `storage.used`,
   * mais l'implementation JS (1.4.6, lib/commands/quota.js) ecrit
   * `storage.usage`. Lire `used` seul — masque par le cast — donnait 0 octet
   * utilise avec une limite correcte : la jauge aurait affiche 0 % sur une
   * boite pleine. On lit les DEUX pour survivre a une future correction de
   * la lib dans un sens ou l'autre.
   */
  async fetchQuota(
    rec: AccountRecord,
  ): Promise<{ usedBytes: number; limitBytes: number } | null> {
    return (await this.fetchQuotaDiagnostic(rec)).quota;
  }

  /**
   * Comme fetchQuota, mais dit POURQUOI quand la capacité reste inconnue —
   * la note est stockée sur le compte et affichée dans l'interface, sinon
   * « quota inconnu » est indiagnosticable pour l'utilisateur.
   */
  async fetchQuotaDiagnostic(
    rec: AccountRecord,
  ): Promise<{ quota: { usedBytes: number; limitBytes: number } | null; note: string | null }> {
    const client = await this.getClient(rec);
    const caps = (client as unknown as { capabilities?: Map<string, unknown> }).capabilities;
    if (caps && !caps.has('QUOTA')) {
      return { quota: null, note: "le serveur n'annonce pas la capacité QUOTA en IMAP" };
    }
    const quota = (await client.getQuota()) as
      | { storage?: { usage?: number; used?: number; limit?: number } }
      | false
      | undefined;
    if (!quota) return { quota: null, note: 'réponse QUOTA vide (commande refusée ou dossier introuvable)' };
    if (!quota.storage) return { quota: null, note: 'réponse QUOTA sans volet stockage' };
    if (!quota.storage.limit) {
      return { quota: null, note: 'le serveur ne fournit pas la limite de stockage' };
    }
    return {
      quota: {
        usedBytes: quota.storage.usage ?? quota.storage.used ?? 0,
        limitBytes: quota.storage.limit,
      },
      note: null,
    };
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

// --- Analyse de la structure MIME (lecture/téléchargement partiels) ---------
// Un mail Outlook multipart pèse souvent plusieurs Mo (pièces jointes) ; pour
// afficher le TEXTE ou récupérer UNE pièce, on ne télécharge QUE la partie
// concernée via son identifiant (`part`), au lieu du message entier.

type BodyNode = {
  part?: string;
  type?: string; // 'text/plain', 'application/pdf'…
  size?: number;
  disposition?: string;
  dispositionParameters?: { filename?: string };
  parameters?: { name?: string; charset?: string };
  childNodes?: BodyNode[];
};

interface AttachmentPart {
  part: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
}

/** Une partie feuille est une pièce jointe si disposition=attachment OU nom de fichier. */
function isAttachmentLeaf(n: BodyNode): boolean {
  const filename = n.dispositionParameters?.filename ?? n.parameters?.name;
  return n.disposition?.toLowerCase() === 'attachment' || !!filename;
}

/** Liste ORDONNÉE des parties « pièce jointe » (même règle que countAttachments). */
function listAttachmentParts(node: BodyNode | null | undefined): AttachmentPart[] {
  const out: AttachmentPart[] = [];
  const walk = (n: BodyNode) => {
    if (n.childNodes?.length) {
      n.childNodes.forEach(walk);
      return;
    }
    if (isAttachmentLeaf(n) && n.part) {
      const filename = n.dispositionParameters?.filename ?? n.parameters?.name ?? '(sans nom)';
      out.push({
        part: n.part,
        filename,
        contentType: (n.type ?? 'application/octet-stream').toLowerCase(),
        sizeBytes: n.size ?? 0,
      });
    }
  };
  if (node) walk(node);
  return out;
}

/** Meilleure partie texte à AFFICHER (text/plain de préférence, sinon text/html). */
function findTextNode(node: BodyNode | null | undefined): BodyNode | null {
  let plain: BodyNode | null = null;
  let html: BodyNode | null = null;
  const walk = (n: BodyNode) => {
    if (n.childNodes?.length) {
      n.childNodes.forEach(walk);
      return;
    }
    if (isAttachmentLeaf(n) || !n.part) return;
    const t = (n.type ?? '').toLowerCase();
    if (t === 'text/plain' && !plain) plain = n;
    else if (t === 'text/html' && !html) html = n;
  };
  if (node) walk(node);
  return plain ?? html;
}

/**
 * Décode un buffer selon le charset MIME (Node 20 = ICU complet), en réparant
 * les charsets MAL DÉCLARÉS — courant sur les vieux mails (2004-2010), et très
 * visible dans les extraits : « voilÃ », « Ã© », « � ».
 *
 * Deux erreurs symétriques, détectables :
 *  - de l'UTF-8 étiqueté latin-1 → on lit « Ã© » là où il y a « é » ;
 *  - du latin-1 étiqueté UTF-8 → on obtient le caractère de remplacement « � ».
 * Dans les deux cas on tente l'autre lecture et on la garde si elle est propre.
 */
/** Le texte porte-t-il la signature « UTF-8 lu comme du latin-1 » ? */
function looksLikeMojibake(text: string): boolean {
  for (let i = 0; i < text.length - 1; i++) {
    const c = text.charCodeAt(i);
    const next = text.charCodeAt(i + 1);
    if ((c === 0xc2 || c === 0xc3) && next >= 0x80 && next <= 0xbf) return true;
  }
  return false;
}

function decodeText(buf: Buffer, charset: string | undefined): string {
  const attempt = (cs: string): string | null => {
    try {
      return new TextDecoder(cs).decode(buf);
    } catch {
      return null;
    }
  };
  const declared = attempt(charset || 'utf-8') ?? buf.toString('utf8');

  // De l'UTF-8 étiqueté latin-1 : on lit « Ã© » là où il y a « é ».
  if (looksLikeMojibake(declared)) {
    const asUtf8 = attempt('utf-8');
    if (asUtf8 && !asUtf8.includes('\uFFFD')) return asUtf8;
  }
  // U+FFFD : le charset annoncé était faux dans l'autre sens (latin-1 lu
  // comme de l'UTF-8). On retente en windows-1252.
  if (declared.includes('\uFFFD')) {
    const asLatin = attempt('windows-1252');
    if (asLatin && !asLatin.includes('\uFFFD')) return asLatin;
  }
  return declared;
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    if (Buffer.isBuffer(chunk)) chunks.push(chunk);
    else if (typeof chunk === 'string') chunks.push(Buffer.from(chunk));
    else chunks.push(Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

/** Adresse formatée « Nom <email> » depuis une entrée d'envelope IMAP. */
function formatEnvelopeAddr(a: { name?: string | null; address?: string | null } | undefined): string {
  if (!a) return '';
  const addr = a.address ?? '';
  return a.name ? `${a.name} <${addr}>` : addr;
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
