import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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
    id: 'read-documents-v1',
    label: 'Je lis le contenu de tes documents',
    link: '#/search',
    run: async () => {
      // Le gros manque de « retrouver » : mesuré le 11/08, le texte des
      // pièces n'avait été extrait que sur 27 mails sur 7 019. Contrairement
      // aux NOMS (une simple lecture de structure), il faut ici télécharger
      // chaque document — d'où le plafond de volume et la reprise
      // automatique. Rien n'est conservé : seul le texte extrait est indexé.
      const { readAttachmentsForAccount } = await import('./attachments.js');
      let lus = 0;
      let scans = 0;
      let restants = 0;
      const names = await listAccountNames();
      for (const name of names) {
        try {
          const rec = await getAccountRecord(name);
          if (!rec) continue;
          for (let tour = 0; tour < 4; tour++) {
            const r = await readAttachmentsForAccount(rec, {
              limit: 120,
              maxBytes: 100 * 1024 * 1024,
            });
            lus += r.read;
            scans += r.scans;
            restants = r.remaining;
            if (r.scanned === 0 || r.remaining === 0) break;
          }
        } catch (err) {
          logger.warn('lecture des documents : compte ignoré', {
            account: name,
            error: (err as Error).message,
          });
        }
      }
      return (
        `${lus} document(s) lus et indexés (factures, devis, quittances…), ` +
        `${scans} scan(s) repéré(s)` +
        `${restants ? ` — ${restants} restants, je continue au fil des synchronisations.` : '.'}`
      );
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
  // Les rattrapages « deadline-ai-veto-v1 » et « deadline-veto-visible-v1 »
  // (10-11/08) ont été RETIRÉS au lot 4c (12/08) : ils rejouaient après coup
  // le veto codé à la main sur `aiAction`/`analysisConfidence` — la rustine
  // que la bascule sur le socle supprime. Leur travail est repris en continu
  // par `revoirEcheancesProposees()` (deadlines.ts), qui arbitre désormais
  // chaque proposition via le socle sémantique à chaque synchronisation.
  // Leurs marqueurs restent inertes dans data/whatsnew.json — sans danger, et
  // ces identifiants ne doivent jamais être réutilisés (entrées immuables).
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
