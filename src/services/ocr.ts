/**
 * OCR local des pièces scannées (13/08).
 *
 * POURQUOI : ~900 mails portent un PDF sans couche texte ou une photo de
 * document — leurs montants et fournisseurs sont inconnus, ce qui bloque la
 * vue documentaire et le fiscal. Trois analyses indépendantes ont buté dessus
 * le même jour. Un PDF scanné était un cul-de-sac TOTAL : ni extractible par
 * attachment-text.ts, ni montrable à Claude (la vision n'accepte que des
 * images).
 *
 * CHOIX (contre-revue ChatGPT du 13/08, .consult/2026-08-13-ocr-scans/) :
 * tesseract + poppler (pdftoppm), binaires système LOCAUX et GRATUITS
 * installés via apt sur le VPS — la doctrine « pas de clé API serveur » tient
 * toujours, seul le « pas d'OCR » d'origine évolue. Ce module est PUR : aucun
 * accès Prisma, aucune écriture en base (c'est services/attachments.ts qui
 * écrit). Sur un poste sans les binaires (le PC de dev Windows, le VPS avant
 * l'apt install), tout se dégrade proprement : `ocrDisponible()` répond non,
 * personne ne plante.
 *
 * MÉNAGEMENT DU VPS (1 seul vCPU ARM) : tout est SÉQUENTIEL, chaque processus
 * enfant est lancé avec `nice -n 15` (Linux) et OMP_THREAD_LIMIT=1 (sinon
 * OpenMP lance plusieurs threads qui se battent pour l'unique cœur), timeouts
 * SIGKILL par étape et budget global par pièce. L'event loop de Node ne
 * bloque jamais : le CPU est dans les processus enfants, attendus un par un.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { logger } from '../logger.js';
import { assainirPourBase, documentHints } from './attachment-text.js';

const execFileP = promisify(execFile);

/**
 * Version LOGIQUE du pipeline. À incrémenter dès qu'un réglage change le
 * résultat (langues, PSM, résolution, seuils de lisibilité) : les mails déjà
 * tentés (`ocrVersion < OCR_PIPELINE_VERSION`) redeviennent éligibles
 * d'eux-mêmes, sans rejouer quoi que ce soit à la main.
 */
export const OCR_PIPELINE_VERSION = 1;

const OCR_LANGS = 'fra+eng';
// Segmentation automatique de page : le bon défaut pour factures et courriers.
const OCR_PSM = '3';
/**
 * Rendu borné en PIXELS (grand côté), pas en DPI : à 200 dpi, une page
 * physiquement aberrante (plan A0, scan mal déclaré) exploserait la RAM.
 * 2400 px ≈ 200 dpi pour de l'A4 — même précision, plafond garanti.
 */
const OCR_SCALE_TO = 2400;
// Factures et justificatifs tiennent en 1-3 pages ; 6 laisse de la marge aux
// relevés sans laisser un rapport de 150 pages monopoliser la machine.
const OCR_MAX_PAGES = 6;
const TIMEOUT_PDFTOPPM_MS = 45_000;
const TIMEOUT_TESSERACT_MS = 60_000;
// Coupe-circuit exceptionnel, pas une durée normale : l'early-abort sur pages
// vides (ci-dessous) arrête bien avant dans les cas courants.
const BUDGET_PIECE_MS = 4 * 60_000;
// Aligné sur MAX_FETCH_BYTES de services/attachments.ts.
export const OCR_MAX_INPUT_BYTES = 8 * 1024 * 1024;
// Deux pages consécutives quasi vides ou illisibles → on abandonne la pièce
// (inutile de brûler six minutes-pages pour découvrir qu'elles le sont toutes).
const PAGES_RATEES_MAX = 2;
// Confiances tesseract (0-100 par mot). En dessous de CONF_BRUIT, une page ne
// dit rien ; au-dessus de CONF_FIABLE, on fait confiance à la machine.
const CONF_BRUIT = 35;
const CONF_FIABLE = 55;

// Rendu « vision » : une page en JPEG (contrôle RÉEL de la taille produite,
// contrairement au PNG dont la dimension ne garantit rien sur une photo).
const VISION_SCALE_TO = 1600;
const VISION_SCALE_TO_SECOURS = 1100;
const VISION_JPEG_QUALITE = 80;
const VISION_JPEG_QUALITE_SECOURS = 60;
// base64 ajoute ~33 % : 1,5 Mo de JPEG ≈ 2 Mo transmis, marge franche.
const VISION_MAX_JPEG_BYTES = 1_500_000;

/** État des binaires OCR sur cette machine. */
export interface OcrDispo {
  /** tesseract présent AVEC le français, et pdftoppm présent. */
  ok: boolean;
  /** Version de tesseract (ex. « 5.3.4 »), null si absent. */
  tesseract: string | null;
  /** Version de poppler/pdftoppm (ex. « 24.02.0 »), null si absent. */
  pdftoppm: string | null;
  /** Langues tesseract installées (ex. ['eng','fra','osd']). */
  langs: string[];
  /** Explication affichable telle quelle (installation à faire, ou RAS). */
  note: string;
}

let dispoPromise: Promise<OcrDispo> | null = null;

/**
 * Détection mémoïsée des binaires. Un `apt install` en cours de vie du
 * process ne se voit qu'au redémarrage (pm2 restart) — c'est voulu, la
 * détection ne coûte alors jamais rien en régime établi.
 */
export function ocrDisponible(): Promise<OcrDispo> {
  if (!dispoPromise) dispoPromise = detecter();
  return dispoPromise;
}

async function detecter(): Promise<OcrDispo> {
  const r: OcrDispo = { ok: false, tesseract: null, pdftoppm: null, langs: [], note: '' };
  try {
    const { stdout } = await execFileP('tesseract', ['--version'], { timeout: 10_000 });
    r.tesseract = /tesseract\s+v?([\d.]+)/i.exec(stdout)?.[1] ?? 'inconnue';
  } catch {
    /* absent */
  }
  if (r.tesseract) {
    try {
      // Binaire présent ≠ langue présente : fra.traineddata est un paquet à
      // part (tesseract-ocr-fra). On vérifie la liste réelle.
      const { stdout, stderr } = await execFileP('tesseract', ['--list-langs'], { timeout: 10_000 });
      r.langs = `${stdout}\n${stderr}`
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => /^[a-z_]{3,}$/.test(l));
    } catch {
      /* liste illisible : langs reste vide */
    }
  }
  try {
    // ⚠️ pdftoppm écrit sa version sur STDERR.
    const { stdout, stderr } = await execFileP('pdftoppm', ['-v'], { timeout: 10_000 });
    r.pdftoppm = /pdftoppm version ([\d.]+)/i.exec(`${stdout}\n${stderr}`)?.[1] ?? 'inconnue';
  } catch {
    /* absent */
  }

  const manque: string[] = [];
  if (!r.tesseract) manque.push('tesseract-ocr');
  else if (!r.langs.includes('fra')) manque.push('tesseract-ocr-fra');
  if (!r.pdftoppm) manque.push('poppler-utils');
  if (manque.length) {
    r.note = `OCR non installé sur ce serveur — à faire une fois : sudo apt-get install -y ${manque.join(' ')}`;
  } else {
    r.ok = true;
    r.note = `OCR prêt (tesseract ${r.tesseract}, poppler ${r.pdftoppm}).`;
  }
  return r;
}

/** Réinitialise la détection (tests uniquement). */
export function reinitialiserDispo(): void {
  dispoPromise = null;
}

/**
 * Lance un binaire en le maintenant poli : `nice -n 15` (Linux), un seul
 * thread OpenMP, timeout SIGKILL. Jamais de shell — les noms de fichiers
 * viennent d'Internet et ne passent JAMAIS dans une ligne de commande
 * interprétée.
 */
async function lancer(
  bin: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  const env = { ...process.env, OMP_THREAD_LIMIT: '1' };
  const viaNice = process.platform === 'linux';
  return execFileP(viaNice ? 'nice' : bin, viaNice ? ['-n', '15', bin, ...args] : args, {
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    env,
    maxBuffer: 32 * 1024 * 1024,
  });
}

/** Résultat de l'OCR d'une pièce. */
export interface OcrPieceResult {
  /** text = lisible (texte rempli) ; scan = charabia ou échec, la pièce reste à regarder par l'IA. */
  kind: 'text' | 'scan';
  text: string;
  note: string;
  /** Pages effectivement OCRisées. */
  pages: number;
  /** Médiane des confiances tesseract (0-100), null si aucun mot. */
  confMediane: number | null;
}

/**
 * Signal SECONDAIRE de lisibilité (le signal principal est la confiance
 * tesseract) : le texte ressemble-t-il à de la langue ? Volontairement
 * indulgent avec les documents pleins de montants, références et IBAN.
 */
export function estTexteLisible(text: string): boolean {
  const nonBlancs = text.replace(/\s+/g, '');
  if (nonBlancs.length < 80) return false;
  const alpha = (nonBlancs.match(/[a-zà-ÿA-ZÀ-Ÿ]/g) ?? []).length;
  if (alpha / nonBlancs.length < 0.55) return false;
  const tokens = text.split(/\s+/).filter((t) => t.length >= 2);
  if (tokens.length < 12) return false;
  const plausibles = tokens.filter(
    (t) => /^[a-zà-ÿA-ZÀ-Ÿ0-9'’.\-€%,:]{2,24}$/.test(t) && /[aeiouyàâéèêëîïôùûü]/i.test(t),
  ).length;
  return plausibles / tokens.length >= 0.5;
}

/** Une page OCRisée : texte reconstruit + confiances des mots. */
interface PageOcr {
  text: string;
  confs: number[];
}

/**
 * OCR d'un fichier image via la sortie TSV : UNE passe donne le texte ET la
 * confiance de chaque mot — c'est le signal principal de qualité (une
 * heuristique linguistique seule se trompe sur des documents remplis de
 * montants, IBAN et références).
 */
async function tesseractSurFichier(path: string): Promise<PageOcr> {
  const { stdout } = await lancer(
    'tesseract',
    [path, 'stdout', '-l', OCR_LANGS, '--psm', OCR_PSM, 'tsv'],
    TIMEOUT_TESSERACT_MS,
  );
  const confs: number[] = [];
  const lignes = new Map<string, string[]>();
  for (const ligne of stdout.split('\n')) {
    const c = ligne.split('\t');
    // Colonnes TSV : level page block par line word left top width height conf text.
    if (c.length < 12 || c[0] !== '5') continue;
    const conf = Number(c[10]);
    const mot = c[11].trim();
    if (!mot || !Number.isFinite(conf) || conf < 0) continue;
    confs.push(conf);
    const cle = `${c[1]}/${c[2]}/${c[3]}/${c[4]}`; // page/bloc/paragraphe/ligne
    const mots = lignes.get(cle) ?? [];
    mots.push(mot);
    lignes.set(cle, mots);
  }
  const text = [...lignes.values()].map((mots) => mots.join(' ')).join('\n');
  return { text, confs };
}

function mediane(valeurs: number[]): number | null {
  if (valeurs.length === 0) return null;
  const tri = [...valeurs].sort((a, b) => a - b);
  return tri[Math.floor(tri.length / 2)];
}

/**
 * Rend UNE page d'un PDF en image, dans `dir`. Renvoie le chemin du fichier
 * produit, ou null si la page n'existe pas — pdftoppm SORT EN ERREUR au-delà
 * de la dernière page (« Wrong page range given », constaté en production le
 * 13/08 : la première version supposait qu'il ne produisait juste rien, et la
 * pièce entière était jetée avec les pages déjà lues). Cette erreur-là est
 * donc la fin normale du document ; les autres remontent.
 */
async function rendrePage(
  pdfPath: string,
  dir: string,
  page: number,
  opts: { jpeg?: boolean; scaleTo: number; qualite?: number },
): Promise<string | null> {
  const racine = join(dir, `p${page}`);
  const args = [
    opts.jpeg ? '-jpeg' : '-png',
    ...(opts.jpeg ? ['-jpegopt', `quality=${opts.qualite ?? VISION_JPEG_QUALITE}`] : []),
    '-scale-to',
    String(opts.scaleTo),
    '-f',
    String(page),
    '-l',
    String(page),
    pdfPath,
    racine,
  ];
  try {
    await lancer('pdftoppm', args, TIMEOUT_PDFTOPPM_MS);
  } catch (err) {
    if (/wrong page range/i.test(err instanceof Error ? err.message : String(err))) return null;
    throw err;
  }
  const prefixe = `p${page}-`;
  const fichiers = (await readdir(dir)).filter((f) => f.startsWith(prefixe));
  return fichiers.length ? join(dir, fichiers[0]) : null;
}

/**
 * OCR d'une pièce jointe (image ou PDF scanné).
 *
 * Le PDF est rendu PAGE PAR PAGE, chaque image étant supprimée sitôt lue :
 * six pages rasterisées d'un coup pèseraient des dizaines de Mo pour un PDF
 * de 2 Mo. Early-abort après PAGES_RATEES_MAX pages consécutives vides ou
 * illisibles, et budget global BUDGET_PIECE_MS (les pages déjà lues sont
 * gardées, la note le dit).
 */
export async function ocrPiece(
  filename: string,
  contentType: string,
  buf: Buffer,
): Promise<OcrPieceResult> {
  const dispo = await ocrDisponible();
  if (!dispo.ok) return { kind: 'scan', text: '', note: dispo.note, pages: 0, confMediane: null };
  if (buf.length > OCR_MAX_INPUT_BYTES) {
    return {
      kind: 'scan',
      text: '',
      note: `Pièce trop volumineuse pour l'OCR (${Math.round(buf.length / 1024 / 1024)} Mo).`,
      pages: 0,
      confMediane: null,
    };
  }

  const ct = contentType.toLowerCase();
  const estPdf = /pdf/.test(ct) || /\.pdf$/i.test(filename);
  const debut = Date.now();
  const dir = await mkdtemp(join(tmpdir(), 'boxmail-ocr-'));
  try {
    const pages: PageOcr[] = [];
    let tronque = false;

    if (estPdf) {
      const pdfPath = join(dir, 'in.pdf');
      await writeFile(pdfPath, buf);
      let ratees = 0;
      for (let p = 1; p <= OCR_MAX_PAGES; p++) {
        if (Date.now() - debut > BUDGET_PIECE_MS) {
          tronque = true;
          break;
        }
        const img = await rendrePage(pdfPath, dir, p, { scaleTo: OCR_SCALE_TO });
        if (!img) break; // fin du document
        try {
          const page = await tesseractSurFichier(img);
          pages.push(page);
          const med = mediane(page.confs);
          const ratee = page.confs.length < 3 || (med !== null && med < CONF_BRUIT);
          ratees = ratee ? ratees + 1 : 0;
          if (ratees >= PAGES_RATEES_MAX) break;
        } finally {
          await rm(img, { force: true });
        }
      }
    } else {
      // Image : tesseract la lit telle quelle (jpeg/png/tiff/bmp…). Les
      // formats exotiques (heic, webp selon compilation) échouent proprement.
      const ext = /\.(jpe?g|png|tiff?|bmp|gif|webp)$/i.exec(filename)?.[0] ?? '.img';
      const imgPath = join(dir, `in${ext}`);
      await writeFile(imgPath, buf);
      pages.push(await tesseractSurFichier(imgPath));
    }

    const confs = pages.flatMap((p) => p.confs);
    const confMediane = mediane(confs);
    const texte = nettoyer(pages.map((p) => p.text).join('\n\n'));
    const lisible = jugerLisible(texte, confs.length, confMediane);
    const duree = Math.round((Date.now() - debut) / 1000);

    if (!lisible) {
      return {
        kind: 'scan',
        text: '',
        note: `OCR tenté (${pages.length} page(s), ${duree} s) mais le résultat est illisible — la pièce reste à regarder en image.`,
        pages: pages.length,
        confMediane,
      };
    }
    return {
      kind: 'text',
      text: assainirPourBase(texte),
      note:
        `Texte lu par OCR (${pages.length} page(s), confiance ${confMediane ?? '?'} %${tronque ? ', document tronqué au budget de temps' : ''}).`,
      pages: pages.length,
      confMediane,
    };
  } catch (err) {
    logger.warn('OCR en échec sur une pièce', {
      filename,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      kind: 'scan',
      text: '',
      note: `OCR en échec (${err instanceof Error ? err.message.slice(0, 120) : 'erreur'}).`,
      pages: 0,
      confMediane: null,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Arbitre « lisible ou charabia ». Signal principal : volume de mots et
 * médiane des confiances tesseract. Signal secondaire : l'heuristique
 * linguistique. Assouplissement : un document bruité dont on lit quand même
 * un montant ou un n° de facture vaut de l'or — on le garde.
 */
function jugerLisible(texte: string, nbMots: number, confMediane: number | null): boolean {
  if (nbMots < 12 || confMediane === null || confMediane < CONF_BRUIT) return false;
  if (confMediane >= CONF_FIABLE && estTexteLisible(texte)) return true;
  const hints = documentHints(texte);
  if (
    texte.replace(/\s+/g, '').length >= 80 &&
    (hints.amountTtc !== null || hints.invoiceNumber !== null || hints.isInvoice)
  ) {
    return true;
  }
  // Zone grise sans indice documentaire : on exige les deux signaux.
  return confMediane >= CONF_FIABLE ? estTexteLisible(texte) : false;
}

/** Nettoyage léger du texte OCR : espaces en rafale, lignes vides en série. */
function nettoyer(raw: string): string {
  return raw
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Rend UNE page d'un PDF en JPEG pour la VISION (read_attachment) : c'est le
 * repli quand l'OCR a rendu du charabia — Claude regarde alors le document.
 * JPEG et non PNG : seule la compression JPEG donne un contrôle réel de la
 * taille produite (un PNG de photo peut être énorme quelle que soit sa
 * dimension). Renvoie null si les binaires manquent, si la page n'existe pas
 * ou si même le rendu de secours reste trop lourd.
 */
export async function pdfPageEnJpeg(buf: Buffer, page = 1): Promise<Buffer | null> {
  const dispo = await ocrDisponible();
  if (!dispo.ok) return null;
  if (buf.length > OCR_MAX_INPUT_BYTES) return null;
  const dir = await mkdtemp(join(tmpdir(), 'boxmail-ocr-'));
  try {
    const pdfPath = join(dir, 'in.pdf');
    await writeFile(pdfPath, buf);
    for (const essai of [
      { scaleTo: VISION_SCALE_TO, qualite: VISION_JPEG_QUALITE },
      { scaleTo: VISION_SCALE_TO_SECOURS, qualite: VISION_JPEG_QUALITE_SECOURS },
    ]) {
      const img = await rendrePage(pdfPath, dir, page, { jpeg: true, ...essai });
      if (!img) return null; // page inexistante
      const jpeg = await readFile(img);
      await rm(img, { force: true });
      if (jpeg.length <= VISION_MAX_JPEG_BYTES) return jpeg;
    }
    return null;
  } catch (err) {
    logger.warn('rendu vision PDF en échec', {
      page,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Balaie les dossiers temporaires `boxmail-ocr-*` orphelins (crash, kill -9)
 * de plus d'un jour : ils peuvent contenir des pages de FACTURES ou de pièces
 * d'identité — on ne laisse pas traîner ça dans /tmp. Appelé au démarrage du
 * worker OCR.
 */
export async function nettoyerTempOrphelins(): Promise<number> {
  let purges = 0;
  try {
    const base = tmpdir();
    for (const nom of await readdir(base)) {
      if (!nom.startsWith('boxmail-ocr-')) continue;
      const chemin = join(base, nom);
      try {
        const s = await stat(chemin);
        if (Date.now() - s.mtimeMs > 24 * 60 * 60 * 1000) {
          await rm(chemin, { recursive: true, force: true });
          purges++;
        }
      } catch {
        /* disparu entre-temps */
      }
    }
  } catch {
    /* tmpdir illisible : tant pis */
  }
  if (purges) logger.info('dossiers temporaires OCR orphelins purgés', { purges });
  return purges;
}
