import { deflateRawSync } from 'node:zlib';

/**
 * Générateur ZIP minimal, sans dépendance externe.
 *
 * Suffisant pour offrir « tout télécharger » (pièces jointes d'un mail) : on
 * DÉFLATE chaque entrée (méthode 8), on écrit un en-tête local par fichier
 * puis le répertoire central et l'enregistrement de fin (EOCD). Format ZIP
 * classique, lisible par l'Explorateur Windows, macOS et `unzip`.
 *
 * Limites assumées : pas de ZIP64 (adapté à des pièces jointes de mail, très
 * en deçà de 4 Go), noms encodés en UTF-8 (bit 11 du drapeau positionné).
 */

interface ZipEntry {
  name: string;
  data: Buffer;
}

// Table CRC-32 (polynôme 0xEDB88320), calculée une fois.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Assemble un `.zip` en mémoire à partir d'entrées {nom, données}.
 * Les noms sont dédupliqués (a.pdf, a (2).pdf…) pour éviter les collisions.
 */
export function buildZip(entries: ZipEntry[]): Buffer {
  const seen = new Map<string, number>();
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = dedupeName(entry.name || 'fichier', seen);
    const nameBuf = Buffer.from(name, 'utf8');
    const compressed = deflateRawSync(entry.data);
    const crc = crc32(entry.data);
    const flags = 0x0800; // bit 11 : nom en UTF-8

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // signature en-tête local
    localHeader.writeUInt16LE(20, 4); // version nécessaire
    localHeader.writeUInt16LE(flags, 6);
    localHeader.writeUInt16LE(8, 8); // méthode : deflate
    localHeader.writeUInt16LE(0, 10); // heure (0 = non renseignée)
    localHeader.writeUInt16LE(0x21, 12); // date (0x0021 = 1/1/1980, valide)
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(entry.data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // longueur du champ « extra »
    local.push(localHeader, nameBuf, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); // signature répertoire central
    centralHeader.writeUInt16LE(20, 4); // version qui a créé
    centralHeader.writeUInt16LE(20, 6); // version nécessaire
    centralHeader.writeUInt16LE(flags, 8);
    centralHeader.writeUInt16LE(8, 10); // méthode : deflate
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0x21, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(entry.data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra
    centralHeader.writeUInt16LE(0, 32); // commentaire
    centralHeader.writeUInt16LE(0, 34); // n° de disque
    centralHeader.writeUInt16LE(0, 36); // attributs internes
    centralHeader.writeUInt32LE(0, 38); // attributs externes
    centralHeader.writeUInt32LE(offset, 42); // décalage de l'en-tête local
    central.push(centralHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + compressed.length;
  }

  const centralBuf = Buffer.concat(central);
  const localBuf = Buffer.concat(local);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // signature EOCD
  eocd.writeUInt16LE(0, 4); // n° de ce disque
  eocd.writeUInt16LE(0, 6); // disque du début du répertoire central
  eocd.writeUInt16LE(entries.length, 8); // entrées sur ce disque
  eocd.writeUInt16LE(entries.length, 10); // entrées au total
  eocd.writeUInt32LE(centralBuf.length, 12); // taille du répertoire central
  eocd.writeUInt32LE(localBuf.length, 16); // décalage du répertoire central
  eocd.writeUInt16LE(0, 20); // longueur du commentaire

  return Buffer.concat([localBuf, centralBuf, eocd]);
}

function dedupeName(name: string, seen: Map<string, number>): string {
  const n = seen.get(name) ?? 0;
  seen.set(name, n + 1);
  if (n === 0) return name;
  const dot = name.lastIndexOf('.');
  if (dot > 0) return `${name.slice(0, dot)} (${n + 1})${name.slice(dot)}`;
  return `${name} (${n + 1})`;
}
