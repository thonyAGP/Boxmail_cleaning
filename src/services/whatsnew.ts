import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { db } from '../db/client.js';
import { logger } from '../logger.js';
import { recordOperation } from './oplog.js';
import { listAccountNames, getAccountRecord } from './accounts.js';
import { detectDeadlines } from './deadlines.js';

/**
 * « Quoi de neuf » — le rattrapage automatique des nouvelles capacités
 * (spécification actée avec ChatGPT le 03/08, règle : « l'utilisateur ne doit
 * jamais connaître les capacités internes du logiciel »).
 *
 * Quand une mise à jour apporte une capacité (ex : lecture des alertes
 * Rentila), l'application NE demande PAS à l'utilisateur de « relancer une
 * analyse » : au premier démarrage suivant, si le rattrapage est 100 %
 * interne, réversible et journalisé, elle l'exécute SEULE, puis raconte ce
 * qu'elle a fait dans une carte « Quoi de neuf » sur la Vue du jour — une
 * carte par capacité, qui disparaît une fois vue (le bilan reste dans data/
 * et au journal). Une capacité améliorée = une NOUVELLE entrée immuable
 * (rentila-parser-v2…), jamais une ré-exécution silencieuse de l'ancienne.
 */

interface Capability {
  /** Identifiant immuable et versionné (marqueur d'exécution). */
  id: string;
  /** Libellé humain court, en français. */
  label: string;
  /**
   * Où mène le bouton « Voir » de la carte. OBLIGATOIRE et propre à chaque
   * capacité : le bouton pointait en dur vers les échéances, si bien que
   * « voir les factures à transmettre à la comptabilité » ouvrait le
   * calendrier (retour utilisateur 10/08 : « c'est stupide et n'a aucun
   * sens »). null = aucun bouton, le texte explique où regarder.
   */
  link: string | null;
  /** Rattrapage — DOIT être interne/réversible/journalisé. Retourne le bilan. */
  run: () => Promise<string>;
}

const CAPABILITIES: Capability[] = [
  {
    id: 'rentila-parser-v1',
    label: 'Je sais lire les alertes Rentila',
    link: '#/deadlines',
    run: async () => {
      // Passe SUJETS uniquement (index local, aucun IMAP) sur toutes les
      // boîtes : les notifications Rentila déjà reçues deviennent des
      // échéances PROPOSÉES (statut validable, rien d'irréversible).
      let created = 0;
      let scanned = 0;
      for (const name of await listAccountNames()) {
        try {
          const rec = await getAccountRecord(name);
          if (!rec) continue;
          const report = await detectDeadlines(rec, { sinceDays: 120 });
          created += report.created;
          scanned += report.scanned;
        } catch (err) {
          logger.warn('rattrapage échéances : compte ignoré', { account: name, error: (err as Error).message });
        }
      }
      return `${scanned} mails relus, ${created} échéance(s) proposée(s) — à confirmer dans ton Calendrier.`;
    },
  },
  {
    id: 'find-by-filename-v1',
    label: 'Je retrouve tes documents par le nom du fichier',
    link: '#/search',
    run: async () => {
      // « Retrouver sans classer » (11/08). Le nom des pièces jointes était
      // lu par la sync puis jeté : c'est pourtant lui qui dit ce qu'un mail
      // contient quand le sujet se contente de « Votre document est
      // disponible ». Aucune pièce n'est téléchargée ici — on ne lit que la
      // table des matières du mail (bodyStructure).
      const { backfillAttachmentNames } = await import('./attachment-names.js');
      let documentes = 0;
      let repares = 0;
      let restants = 0;
      const names = await listAccountNames();
      for (const name of names) {
        try {
          const rec = await getAccountRecord(name);
          if (!rec) continue;
          // Quelques lots par boîte : le reste se fait tout seul aux syncs
          // suivantes, sans que l'utilisateur ait à recliquer.
          for (let tour = 0; tour < 6; tour++) {
            const r = await backfillAttachmentNames(rec, { limit: 400 });
            documentes += r.named;
            repares += r.repaired;
            restants = r.remaining;
            if (r.remaining === 0 || r.scanned === 0) break;
          }
        } catch (err) {
          logger.warn('noms des pièces : compte ignoré', {
            account: name,
            error: (err as Error).message,
          });
        }
      }
      return (
        `${documentes} mail(s) retrouvables par le nom de leurs pièces` +
        `${repares ? `, ${repares} corrigé(s)` : ''}` +
        `${restants ? ` — le reste se fait au fil des synchronisations.` : '.'}`
      );
    },
  },
  {
    id: 'accounting-candidates-v1',
    label: 'Je repère les factures à transmettre à la comptabilité',
    // Ces pièces vivent dans Fiscal-Manager (écran « Pièces reçues ») : aucun
    // écran de Boxmail ne les montre, donc pas de bouton qui mènerait ailleurs.
    link: null,
    run: async () => {
      // Rattrapage du stock : les mails « facture » avec pièce jointe des
      // 12 derniers mois deviennent des candidats pour l'écran « Pièces
      // reçues » de Fiscal-Manager. Une lecture de structure IMAP par mail
      // candidat, aucun téléchargement, rien d'irréversible.
      const { detectAccountingCandidates } = await import('./accounting.js');
      let created = 0;
      let scanned = 0;
      let failures = 0;
      const names = await listAccountNames();
      for (const name of names) {
        try {
          const rec = await getAccountRecord(name);
          if (!rec) continue;
          const r = await detectAccountingCandidates(rec, { sinceDays: 365, limit: 500 });
          created += r.created;
          scanned += r.scanned;
        } catch (err) {
          failures++;
          logger.warn('rattrapage pièces comptables : compte ignoré', {
            account: name,
            error: (err as Error).message,
          });
        }
      }
      // Toutes les boîtes en échec (serveur IMAP injoignable…) : pas de
      // marqueur, on retentera au prochain démarrage.
      if (names.length > 0 && failures === names.length) {
        throw new Error('aucune boîte accessible pour le rattrapage');
      }
      return `${scanned} mails « facture » examinés sur 12 mois, ${created} pièce(s) comptable(s) prête(s) pour Fiscal-Manager.`;
    },
  },
  {
    id: 'attachment-reading-v1',
    label: 'Je lis maintenant le contenu des pièces jointes',
    link: '#/attachments',
    run: async () => {
      // Rattrapage du flux récent : les pièces des 90 derniers jours sont
      // lues (texte extrait localement, rien n'est conservé). C'est ce qui
      // évite de reclasser « payer maman » un scan de facture Sosh. Plafonné
      // par boîte : chaque lecture est un téléchargement IMAP.
      const { readAttachmentsForAccount } = await import('./attachments.js');
      let read = 0;
      let scans = 0;
      let scanned = 0;
      let failures = 0;
      const names = await listAccountNames();
      for (const name of names) {
        try {
          const rec = await getAccountRecord(name);
          if (!rec) continue;
          const r = await readAttachmentsForAccount(rec, { limit: 250, sinceDays: 90 });
          read += r.read;
          scans += r.scans;
          scanned += r.scanned;
        } catch (err) {
          failures++;
          logger.warn('rattrapage pièces jointes : compte ignoré', {
            account: name,
            error: (err as Error).message,
          });
        }
      }
      if (names.length > 0 && failures === names.length) {
        throw new Error('aucune boîte accessible pour le rattrapage');
      }
      return `${scanned} mail(s) à pièce jointe examinés sur 90 jours : ${read} document(s) lu(s)` +
        `${scans ? `, ${scans} scan(s) repéré(s) (à faire lire par l'IA)` : ''}. ` +
        'Une facture transmise par un proche est désormais reconnue au nom du VRAI fournisseur.';
    },
  },
  {
    id: 'deadline-ai-veto-v1',
    label: 'Je ne transforme plus une information en échéance',
    link: '#/deadlines',
    run: async () => {
      // Ménage du stock (10/08). Une pure information — « les paiements par
      // carte seront indisponibles le 12 mai » — était devenue une échéance
      // de PAIEMENT au 12 mai. Mesure : 11 échéances sur 15 portaient sur un
      // mail que l'analyse avait pourtant classé « à lire » ou « à archiver »
      // en confiance haute. On retire ces propositions ; les échéances
      // CONFIRMÉES par l'utilisateur ne sont jamais touchées.
      const proposed = await db.deadline.findMany({
        where: { status: 'proposed' },
        select: { id: true, messageId: true, title: true },
      });
      if (proposed.length === 0) return 'Aucune date proposée à revoir.';
      const msgs = new Map(
        (
          await db.message.findMany({
            where: { id: { in: proposed.map((d) => d.messageId) } },
            select: { id: true, aiAction: true, analysisConfidence: true },
          })
        ).map((m) => [m.id, m]),
      );
      let removed = 0;
      for (const d of proposed) {
        const m = msgs.get(d.messageId);
        if (!m?.aiAction) continue;
        if (!['read', 'archive', 'none'].includes(m.aiAction)) continue;
        if (m.analysisConfidence !== 'high') continue;
        // « dismissed » plutôt que supprimé : réversible, et visible dans
        // l'onglet « Ignorées » si l'utilisateur veut vérifier.
        await db.deadline.update({ where: { id: d.id }, data: { status: 'dismissed' } });
        removed++;
      }
      if (removed > 0) {
        await recordOperation({
          account: '*',
          tool: 'deadline_ai_veto',
          params: { removed, examined: proposed.length },
          result: `${removed} fausse(s) date(s) écartée(s) : l'analyse disait « rien à faire »`,
        });
      }
      return `${proposed.length} date(s) proposée(s) relues : ${removed} écartée(s) parce que ` +
        'l\'analyse du mail disait « rien à faire » (elles restent visibles dans l\'onglet Ignorées).';
    },
  },
  {
    id: 'deadline-veto-visible-v1',
    label: 'Je te montre les dates que j\'ai écartées, et pourquoi',
    link: '#/deadlines',
    run: async () => {
      // Les dates écartées par la passe précédente avaient été marquées
      // « ignorées » — indistinguables d'un choix de l'utilisateur, et donc
      // invisibles en tant que travail fait. On leur donne leur vrai statut
      // (« écartée par l'analyse ») pour pouvoir les montrer et les expliquer.
      const rows = await db.deadline.findMany({
        where: { status: 'dismissed', vetoReason: null },
        select: { id: true, messageId: true, reason: true },
      });
      if (rows.length === 0) return 'Aucune date à requalifier.';
      const msgs = new Map(
        (
          await db.message.findMany({
            where: { id: { in: rows.map((r) => r.messageId) } },
            select: { id: true, aiAction: true, analysisConfidence: true, aiSummary: true },
          })
        ).map((m) => [m.id, m]),
      );
      let moved = 0;
      for (const r of rows) {
        const m = msgs.get(r.messageId);
        if (!m?.aiAction || !['read', 'archive', 'none'].includes(m.aiAction)) continue;
        if (m.analysisConfidence !== 'high') continue;
        await db.deadline.update({
          where: { id: r.id },
          data: {
            status: 'vetoed',
            vetoReason: 'ai_no_action',
            reason:
              `date trouvée dans le mail, mais l'analyse conclut « ${m.aiSummary ?? 'rien à faire'} »` +
              ' — la date décrit un fait, pas une action de ta part',
          },
        });
        moved++;
      }
      return `${moved} date(s) écartée(s) sont désormais consultables dans l'onglet ` +
        '« Écartées par l\'analyse » — avec le motif, et un bouton pour les rétablir si je me suis trompé.';
    },
  },
];

const STATE_FILE = (): string => resolve(process.cwd(), 'data', 'whatsnew.json');

export interface WhatsNewEntry {
  id: string;
  label: string;
  summary: string;
  ranAt: string;
  seen: boolean;
  /** Destination du bouton « Voir » (null = pas de bouton). */
  link?: string | null;
}

function readState(): WhatsNewEntry[] {
  try {
    if (existsSync(STATE_FILE())) {
      const raw = JSON.parse(readFileSync(STATE_FILE(), 'utf8')) as WhatsNewEntry[];
      if (Array.isArray(raw)) return raw;
    }
  } catch {
    /* fichier illisible : on repart de zéro (les marqueurs empêchent les doublons) */
  }
  return [];
}

function writeState(entries: WhatsNewEntry[]): void {
  mkdirSync(dirname(STATE_FILE()), { recursive: true });
  writeFileSync(STATE_FILE(), JSON.stringify(entries, null, 2), 'utf8');
}

/**
 * À appeler au démarrage (après les migrations) : exécute une fois chaque
 * capacité pas encore rattrapée, en arrière-plan — le serveur sert déjà.
 */
export function runCapabilityBackfills(): void {
  void (async () => {
    const state = readState();
    for (const cap of CAPABILITIES) {
      if (state.some((e) => e.id === cap.id)) continue;
      try {
        const summary = await cap.run();
        state.push({
          id: cap.id, label: cap.label, summary, link: cap.link,
          ranAt: new Date().toISOString(), seen: false,
        });
        writeState(state);
        await recordOperation({
          account: '*',
          tool: 'capability_backfill',
          params: { id: cap.id },
          result: `nouveauté « ${cap.label} » : ${summary}`,
        });
        logger.info('rattrapage de capacité exécuté', { id: cap.id, summary });
      } catch (err) {
        // Pas de marqueur : on retentera au prochain démarrage.
        logger.warn('rattrapage de capacité en échec (retenté au prochain démarrage)', {
          id: cap.id,
          error: (err as Error).message,
        });
      }
    }
  })();
}

/** Les cartes non encore vues (Vue du jour). */
export function whatsNewUnseen(): WhatsNewEntry[] {
  return readState().filter((e) => !e.seen);
}

/** L'utilisateur a vu la carte : elle disparaît (le bilan reste ici + journal). */
export function whatsNewMarkSeen(id: string): void {
  const state = readState();
  const entry = state.find((e) => e.id === id);
  if (!entry) throw new Error(`Nouveauté « ${id} » inconnue.`);
  entry.seen = true;
  writeState(state);
}
