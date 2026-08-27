/**
 * Nommer un fichier dans un en-tête HTTP sans faire tomber la réponse (28/08).
 *
 * INCIDENT PAYÉ CHER. Le connecteur Fiscal-Manager n'avançait plus depuis le
 * 27/08 : ses trois derniers passages repartaient de `cursor=0`, tiraient la
 * liste (200), puis rendaient 500 sur TOUJOURS la même pièce et s'arrêtaient
 * là. 167 justificatifs restaient derrière, dont tous les billets d'avion.
 *
 * La pièce en cause : `Facture mars 2026 république.pdf` (Brimmo, seq 22). Son
 * nom ne porte pas un « é » précomposé (U+00E9) mais un « e » suivi de l'accent
 * COMBINANT U+0301 — la forme décomposée que produisent macOS et certains
 * webmails. Node accepte dans un en-tête les octets Latin-1 (jusqu'à U+00FF),
 * donc « é » passait ; U+0301 est au-dessus, et `setHeader` lève
 * « Invalid character in header content ["Content-Disposition"] ».
 *
 * Autrement dit : un accent invisible à l'œil, dans le nom d'un fichier qu'on
 * ne fait que RECOPIER, bloquait toute la chaîne comptable. Le filtre d'alors
 * (`/["\\\r\n]/`) ne visait que l'injection d'en-tête, pas l'encodage.
 *
 * LA RÈGLE : un nom venu d'un mail est une donnée étrangère, jamais un en-tête.
 * On sert donc les deux formes de la RFC 6266/5987 — un repli strictement ASCII
 * entre guillemets pour les clients anciens, et `filename*=UTF-8''…` porteur du
 * vrai nom, accents compris.
 */

/**
 * Repli ASCII d'un nom de fichier : accents dépliés (« é » → « e », que
 * l'accent soit collé au caractère ou combinant), tout le reste hors ASCII
 * imprimable remplacé, guillemets et antislashs neutralisés.
 */
export function nomAsciiSur(filename: string): string {
  const deplie = filename
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/["\\]/g, '_')
    .replace(/[^\x20-\x7e]/g, '_')
    .trim();
  return deplie || 'piece';
}

/**
 * La valeur complète de `Content-Disposition`. `disposition` vaut `attachment`
 * (téléchargement) ou `inline` (affichage dans le navigateur).
 */
export function enteteFichier(filename: string, disposition: 'attachment' | 'inline'): string {
  return (
    `${disposition}; filename="${nomAsciiSur(filename)}"; ` +
    `filename*=UTF-8''${encodeURIComponent(filename)}`
  );
}
