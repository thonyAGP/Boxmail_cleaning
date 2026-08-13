-- OCR des pièces scannées (13/08). ~900 mails kind='scan' dont montants et
-- fournisseurs sont inconnus : tesseract repasse derrière l'extraction maison.
-- attachmentTextSource : 'ocr' = texte lu par tesseract, null = couche texte
-- native (la provenance compte : un montant OCRisé est moins fiable).
-- ocrAt/ocrVersion : idempotence durable du job — posés après chaque tentative
-- aboutie (même charabia), jamais sur erreur technique ; incrémenter
-- OCR_PIPELINE_VERSION (services/ocr.ts) rend les scans à nouveau éligibles.
ALTER TABLE "Message" ADD COLUMN "attachmentTextSource" TEXT;
ALTER TABLE "Message" ADD COLUMN "ocrAt" DATETIME;
ALTER TABLE "Message" ADD COLUMN "ocrVersion" INTEGER;
