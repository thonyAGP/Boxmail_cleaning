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
    id: 'lier-au-bien-v1',
    label: 'Je relie tes factures au bon logement',
    link: '#/search',
    run: async () => {
      // 24/08. Sa facture d'électricité la bellenergie ne contient nulle part
      // le mot « Miron », alors qu'elle concerne le 33 rue François Miron :
      // « facture électricité miron » ne pouvait rien donner de juste.
      //
      // Or EDF, lui, ÉCRIT l'adresse du logement dans le corps du mail — et
      // elle dort dans la base depuis toujours, à 712 caractères du début.
      // Cette passe la lit enfin, et retient au passage le numéro de client
      // qui l'accompagne : les factures suivantes du même contrat rejoindront
      // le logement toutes seules, même quand elles ne nomment plus l'adresse.
      //
      // Rien n'est téléchargé, rien ne sort de la machine : on relit du texte
      // déjà stocké. Les nouveaux mails, eux, passent par le job des extraits
      // qui fait la même chose au fil de l'eau (snippets.ts).
      const { rattacherTexteConnu } = await import('./liaisons.js');
      const { db } = await import('../db/client.js');
      let relies = 0;
      let vus = 0;
      const orphelins = new Set<string>();
      // Les mails porteurs d'un texte, du plus récent au plus ancien : ce sont
      // les factures d'aujourd'hui qu'il cherche, pas celles de 2008.
      const lots = 12;
      for (let tour = 0; tour < lots; tour++) {
        // Le TEXTE vient avec le lot : relire chaque mail un par un ferait
        // 6 000 requêtes au démarrage, pour un travail qui n'accroche que sur
        // une minorité d'entre eux.
        const mails = await db.message.findMany({
          where: { isDeleted: false, analysisInput: { not: null } },
          select: { id: true, subject: true, analysisInput: true },
          orderBy: { date: 'desc' },
          take: 500,
          skip: tour * 500,
        });
        if (!mails.length) break;
        for (const m of mails) {
          vus++;
          try {
            const r = await rattacherTexteConnu(
              m.id,
              [m.subject, m.analysisInput].filter(Boolean).join('\n'),
            );
            relies += r.parAdresse + r.parIdentifiant;
            for (const o of r.identifiantsOrphelins) orphelins.add(o);
          } catch (err) {
            logger.warn('liaison au bien impossible', { id: m.id, error: (err as Error).message });
          }
        }
      }
      return (
        `${vus} mails relus, ${relies} rattachement(s) à un logement déduits de leur texte` +
        `${orphelins.size ? ` — ${orphelins.size} référence(s) client vues sans logement connu, elles se rattacheront dès qu'un mail donnera l'adresse.` : '.'}`
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
    id: 'accounting-body-doc-v1',
    label: 'Je retrouve les billets d’avion, qui n’ont jamais de pièce jointe',
    link: null,
    run: async () => {
      /**
       * LE RATTRAGE DES JUSTIFICATIFS PORTÉS PAR LE CORPS (27/08).
       *
       * `accounting-candidates-v1` a déjà tourné et est marqué fait : il ne
       * repassera jamais. Or il ne pouvait PAS voir ces mails-là — il exigeait
       * une pièce jointe. Sans cette seconde entrée, la nouvelle détection ne
       * s'appliquerait qu'aux mails à venir, et les vols déjà payés resteraient
       * invisibles. D'où un identifiant distinct : c'est un autre rattrapage,
       * sur un autre vivier.
       *
       * Idempotent : un mail déjà candidat est reconnu et sauté.
       */
      const { detectAccountingCandidates } = await import('./accounting.js');
      let created = 0;
      let lus = 0;
      let failures = 0;
      const names = await listAccountNames();
      for (const name of names) {
        try {
          const rec = await getAccountRecord(name);
          if (!rec) continue;
          const r = await detectAccountingCandidates(rec, { sinceDays: 365, limit: 500 });
          created += r.viaCorps;
          lus += r.corpsLusEnImap;
        } catch (err) {
          failures++;
          logger.warn('rattrapage justificatifs portés par le corps : compte ignoré', {
            account: name,
            error: (err as Error).message,
          });
        }
      }
      if (names.length > 0 && failures === names.length) {
        throw new Error('aucune boîte accessible pour le rattrapage');
      }
      return created > 0
        ? `${created} justificatif(s) sans pièce jointe retrouvé(s) sur 12 mois — billets d'avion, réservations — et transmis à la comptabilité (${lus} corps relus).`
        : `Aucun justificatif porté par le corps trouvé sur les 12 derniers mois (${lus} corps relus).`;
    },
  },
  {
    id: 'attachment-size-decoded-v1',
    label: 'Je relis les documents que je croyais trop gros',
    link: null,
    run: async () => {
      /**
       * LE RATTRAPAGE DES DOCUMENTS ÉCARTÉS PAR UNE ERREUR D'UNITÉ (28/08).
       *
       * Le plafond de lecture (8 Mo) était comparé à la taille TRANSMISE, ~37 %
       * au-dessus du fichier (base64). Des documents de 6 ou 7 Mo étaient donc
       * refusés en croyant qu'ils en faisaient 9 ou 10 — simulé à blanc sur la
       * production : **46 mails déjà marqués comme lus**, dont 35 sans aucun
       * texte. Les plans « SARL BRIMMO APD01 » du 46 rue de la République, les
       * catalogues de ventes aux enchères de Colocar, des annonces de maisons
       * (Location_Brest), le guide de l'appartement Au-marais.
       *
       * ⚠️ SANS CETTE ENTRÉE, LA CORRECTION NE SERT À RIEN sur l'existant : la
       * passe de lecture ne retient que les mails jamais visités
       * (`attachmentTextAt: null`). Un mail refusé a été marqué visité, donc il
       * ne serait plus JAMAIS relu — la correction ne vaudrait que pour les
       * mails à venir.
       *
       * Ce rattrapage ne lit rien lui-même : il RETIRE la marque « déjà vu »
       * des seuls mails concernés, et la passe ordinaire fait le reste à son
       * rythme. Réversible (la marque se repose toute seule), journalisé, et
       * borné aux pièces dont le fichier tient réellement sous le plafond.
       */
      const { db } = await import('../db/client.js');
      const { tailleReelle } = await import('./taille-piece.js');
      const MAX_FETCH_BYTES = 8 * 1024 * 1024;
      const rows = await db.message.findMany({
        where: { attachmentMeta: { not: null }, attachmentTextAt: { not: null } },
        select: { id: true, attachmentMeta: true },
      });
      const aRelire: number[] = [];
      for (const m of rows) {
        let meta: { n?: string; s?: number }[] = [];
        try {
          meta = JSON.parse(m.attachmentMeta as string);
        } catch {
          continue;
        }
        const concerne = meta.some((x) => {
          const transmis = x.s ?? 0;
          if (transmis <= MAX_FETCH_BYTES) return false; // n'a jamais été refusée
          // Le type n'est pas dans la fiche : on se fie au nom. La passe de
          // lecture refiltrera de toute façon sur le type réel.
          const reel = tailleReelle(transmis, 'application/octet-stream', null).bytes;
          return reel <= MAX_FETCH_BYTES;
        });
        if (concerne) aRelire.push(m.id);
      }
      for (let i = 0; i < aRelire.length; i += 200) {
        await db.message.updateMany({
          where: { id: { in: aRelire.slice(i, i + 200) } },
          data: { attachmentTextAt: null },
        });
      }
      logger.info('rattrapage taille des pièces : mails remis en lecture', {
        examines: rows.length,
        remisEnLecture: aRelire.length,
      });
      return aRelire.length > 0
        ? `${aRelire.length} mail(s) portant un document que je refusais à tort ` +
            `(taille encodée prise pour la taille du fichier) sont remis dans la file de lecture — ` +
            `leur contenu deviendra cherchable au fil des prochaines passes.`
        : 'Aucun document n’avait été refusé pour cette raison.';
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
  {
    id: 'ocr-scans-v1',
    label: 'Je lis maintenant tes documents scannés',
    link: '#/search',
    run: async () => {
      // ANNONCE seulement — le travail lui-même est fait par le worker de
      // fond (services/autoocr.ts), un document à la fois : ~900 scans font
      // des heures d'OCR, pas leur place dans un rattrapage de boot
      // (contre-revue du 13/08). Si les binaires manquent, on THROW : pas de
      // marqueur, la carte retentera à chaque démarrage jusqu'à ce que
      // l'apt install soit passé — c'est le comportement voulu.
      const { ocrDisponible, OCR_PIPELINE_VERSION } = await import('./ocr.js');
      const dispo = await ocrDisponible();
      if (!dispo.ok) throw new Error(dispo.note);
      const { db } = await import('../db/client.js');
      const restants = await db.message.count({
        where: {
          attachmentKind: 'scan',
          isDeleted: false,
          OR: [{ ocrVersion: null }, { ocrVersion: { lt: OCR_PIPELINE_VERSION } }],
        },
      });
      return (
        `${restants} document(s) scanné(s) (PDF sans texte, photos) vont être lus en ` +
        `tâche de fond — montants et fournisseurs deviendront cherchables. ` +
        `Ça avance tout seul ; le bouton « Lire les scans maintenant » (Paramètres → ` +
        `Compréhension des mails) accélère si besoin.`
      );
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
