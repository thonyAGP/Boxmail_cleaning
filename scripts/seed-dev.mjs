// SEED DE DÉVELOPPEMENT — des mails SYNTHÉTIQUES, jamais réels.
//
// Pourquoi (03/09/2026) : sans données, les écrans se rendent tous en « vide ».
// Un scénario de l'usine passait alors au vert sans avoir exercé une seule
// ligne de liste, et `decision-compteur-coherent` échouait faute de mail à
// décider — un rouge illisible, qui ne disait rien du produit.
//
// Ce que ça écrit : deux boîtes, un INBOX chacune, une douzaine de mails aux
// états variés (lu/non lu, décidé/non décidé, avec et sans pièce jointe).
// Rien qui ressemble à du courrier réel : ni adresse existante, ni montant.
//
//   node scripts/seed-dev.mjs           # ajoute ce qui manque
//   node scripts/seed-dev.mjs --reset   # efface d'abord les boîtes de test
//
// N'agit QUE sur les deux slugs ci-dessous : une base de production croisée
// par erreur ne perdrait rien.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const RESET = process.argv.includes('--reset');

const BOITES = [
  { slug: 'demo_perso', emailAddress: 'demo-perso@exemple.invalid', displayName: 'Démo perso' },
  { slug: 'demo_pro', emailAddress: 'demo-pro@exemple.invalid', displayName: 'Démo pro' },
];

const SUJETS = [
  ['Devis pour la toiture', 'Charpente Exemple', 'contact@charpente.invalid', 2, 'devis-toiture.pdf'],
  ['Re: rendez-vous de jeudi', 'Marie Exemple', 'marie@exemple.invalid', 0, null],
  ['Votre facture de janvier', 'Fournisseur Exemple', 'facturation@fournisseur.invalid', 1, 'facture-01.pdf'],
  ['Newsletter — les nouveautés du mois', 'Lettre Exemple', 'news@lettre.invalid', 0, null],
  ['Relevé de compte', 'Banque Exemple', 'releves@banque.invalid', 1, 'releve.pdf'],
  ['Confirmation de commande', 'Boutique Exemple', 'commandes@boutique.invalid', 0, null],
];

async function main() {
  if (RESET) {
    for (const b of BOITES) {
      await prisma.message.deleteMany({ where: { accountSlug: b.slug } });
      await prisma.folder.deleteMany({ where: { accountSlug: b.slug } });
      await prisma.account.deleteMany({ where: { slug: b.slug } });
    }
    console.log('boîtes de démonstration effacées');
  }

  let nbMails = 0;
  for (const [iBoite, b] of BOITES.entries()) {
    await prisma.account.upsert({ where: { slug: b.slug }, update: {}, create: { ...b, sortOrder: iBoite } });
    const dossier = await prisma.folder.upsert({
      where: { accountSlug_path: { accountSlug: b.slug, path: 'INBOX' } },
      update: {},
      create: { accountSlug: b.slug, path: 'INBOX', name: 'Boîte de réception', role: 'inbox' },
    });

    for (const [i, [subject, fromName, fromEmail, nbPj, pj]] of SUJETS.entries()) {
      const uid = 1000 + iBoite * 100 + i;
      const dejaLa = await prisma.message.findFirst({ where: { accountSlug: b.slug, uid } });
      if (dejaLa) continue;
      await prisma.message.create({
        data: {
          accountSlug: b.slug,
          folderId: dossier.id,
          uid,
          subject,
          normalizedSubject: subject.toLowerCase(),
          fromName,
          fromEmail,
          toEmails: JSON.stringify([b.emailAddress]),
          date: new Date(Date.now() - (i + 1) * 36e5),
          isSeen: i % 3 === 0,
          // Un mail sur deux reste SANS décision : c'est ce vivier que la file
          // de dépouillement consomme, et sans lui l'écran n'a rien à montrer.
          reviewedAt: i % 2 === 0 ? new Date() : null,
          reviewDecision: i % 2 === 0 ? 'keep' : null,
          sizeBytes: 4096 + i * 512,
          hasAttachments: nbPj > 0,
          attachmentCount: nbPj,
          attachmentNames: pj,
        },
      });
      nbMails += 1;
    }
  }
  console.log(`seed : ${BOITES.length} boîtes, ${nbMails} mail(s) ajouté(s).`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
