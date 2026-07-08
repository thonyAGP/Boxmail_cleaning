/**
 * Génération de fichiers d'export d'expéditeurs :
 *  - vCard 3.0 (.vcf) — importable dans Outlook.com Contacts
 *  - CSV format Outlook — colonnes attendues par l'import Outlook.com
 *
 * Les Contacts ne sont PAS accessibles via IMAP : l'import reste manuel.
 * Les fichiers sont retournés en texte pour que Cowork les livre en
 * téléchargement (SPEC §5 Export).
 */

export interface SenderContact {
  address: string;
  name?: string;
}

function escapeVCard(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

export function toVCard(contacts: SenderContact[]): string {
  const cards = contacts.map((c) => {
    const display = c.name?.trim() || c.address;
    // FN = nom affiché ; N = structuré (on met tout dans le "family name" faute de mieux).
    return [
      'BEGIN:VCARD',
      'VERSION:3.0',
      `FN:${escapeVCard(display)}`,
      `N:${escapeVCard(display)};;;;`,
      `EMAIL;TYPE=INTERNET:${escapeVCard(c.address)}`,
      'END:VCARD',
    ].join('\r\n');
  });
  return cards.join('\r\n') + '\r\n';
}

function escapeCsv(value: string): string {
  if (/[",\n]/.test(value)) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}

/** CSV compatible import Outlook.com (en-têtes minimaux reconnus). */
export function toOutlookCsv(contacts: SenderContact[]): string {
  const header = ['First Name', 'Last Name', 'Display Name', 'E-mail Address'];
  const rows = contacts.map((c) => {
    const display = c.name?.trim() || c.address;
    return [
      escapeCsv(''),
      escapeCsv(display),
      escapeCsv(display),
      escapeCsv(c.address),
    ].join(',');
  });
  return [header.join(','), ...rows].join('\r\n') + '\r\n';
}
