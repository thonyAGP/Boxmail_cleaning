/**
 * Banc d'essai OCR — `npm run ocr:banc -- <fichier.pdf|.jpg|.png>`
 *
 * POURQUOI : recette de la chaîne tesseract + poppler AVANT de lâcher le
 * worker sur les ~900 scans. Sur le VPS : donner un vrai scan et lire le
 * texte, les confiances et le verdict de lisibilité. Sur le PC de dev
 * (Windows, sans binaires) : vérifier que le mode dégradé répond proprement
 * « OCR non installé » sans planter.
 *
 * Sans argument, le banc vérifie aussi `estTexteLisible` sur des chaînes en
 * dur (charabia vs texte réel) — aucune fixture binaire à committer.
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import {
  estTexteLisible,
  ocrDisponible,
  ocrPiece,
  pdfPageEnJpeg,
  OCR_PIPELINE_VERSION,
} from '../services/ocr.js';
import { documentHints } from '../services/attachment-text.js';

function typeDepuisNom(nom: string): string {
  if (/\.pdf$/i.test(nom)) return 'application/pdf';
  if (/\.png$/i.test(nom)) return 'image/png';
  if (/\.jpe?g$/i.test(nom)) return 'image/jpeg';
  if (/\.tiff?$/i.test(nom)) return 'image/tiff';
  return 'application/octet-stream';
}

/** Auto-contrôle de l'heuristique linguistique, sans binaire ni fixture. */
function testerHeuristique(): boolean {
  const lisible =
    'Facture n° F2026-0182 du 12 août 2026. Abonnement internet fibre, ' +
    'période du 1er au 31 juillet. Montant total TTC : 39,99 €. ' +
    'Merci de régler avant le 30 août par prélèvement automatique. ' +
    'Sosh, une marque du groupe Orange, service client joignable en ligne.';
  const charabia =
    'xj qwrt zzkp 003 |||| mmn vv 9# ;;;; kfjd qq wxc 88 ~~ ppl ' +
    'zrtk 44 &&& nbv ..,, ::: ghjk 77 ??! œ§ µµ ##### zz kk 99 tt ' +
    'qsd 55 xx ww cc 33 vv bb nn 11 22 fjor sldk qpwo 66 ||| zz';
  const okLisible = estTexteLisible(lisible);
  const okCharabia = !estTexteLisible(charabia);
  console.log(`  texte réel   → ${okLisible ? 'lisible ✔' : 'ILLISIBLE ✘ (attendu : lisible)'}`);
  console.log(`  charabia     → ${okCharabia ? 'charabia ✔' : 'LISIBLE ✘ (attendu : charabia)'}`);
  return okLisible && okCharabia;
}

async function main(): Promise<void> {
  console.log(`Banc OCR — pipeline v${OCR_PIPELINE_VERSION}\n`);

  const dispo = await ocrDisponible();
  console.log(`Binaires : ${dispo.note}`);
  if (dispo.ok) console.log(`Langues tesseract : ${dispo.langs.join(', ')}`);

  console.log('\nHeuristique estTexteLisible :');
  const heuristiqueOk = testerHeuristique();

  const fichier = process.argv[2];
  if (!fichier) {
    console.log('\nAucun fichier fourni — usage : npm run ocr:banc -- chemin/vers/scan.pdf');
    process.exit(heuristiqueOk ? 0 : 1);
  }
  if (!dispo.ok) {
    console.log('\nImpossible de traiter le fichier sans les binaires (mode dégradé vérifié).');
    process.exit(1);
  }

  const buf = readFileSync(fichier);
  const nom = basename(fichier);
  const ct = typeDepuisNom(nom);
  console.log(`\nFichier : ${nom} (${Math.round(buf.length / 1024)} Ko, ${ct})`);

  const debut = Date.now();
  const r = await ocrPiece(nom, ct, buf);
  const duree = ((Date.now() - debut) / 1000).toFixed(1);

  console.log(`\nVerdict : ${r.kind === 'text' ? 'LISIBLE' : 'charabia / échec'}`);
  console.log(`Note    : ${r.note}`);
  console.log(`Pages   : ${r.pages} · confiance médiane : ${r.confMediane ?? '—'} · durée : ${duree} s`);

  if (r.kind === 'text') {
    const hints = documentHints(r.text);
    console.log(
      `Indices : fournisseur=${hints.supplier ?? '—'} · montant TTC=${hints.amountTtc ?? '—'} · n° facture=${hints.invoiceNumber ?? '—'}`,
    );
    console.log(`\n--- Texte (${r.text.length} caractères, extrait de 1 500) ---`);
    console.log(r.text.slice(0, 1500));
  }

  if (/\.pdf$/i.test(nom)) {
    const jpeg = await pdfPageEnJpeg(buf, 1);
    console.log(
      `\nRendu vision page 1 : ${jpeg ? `JPEG de ${Math.round(jpeg.length / 1024)} Ko` : 'échec / page absente'}`,
    );
  }
}

main().catch((err) => {
  console.error('Banc OCR en échec :', err instanceof Error ? err.message : err);
  process.exit(1);
});
