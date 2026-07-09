// pm2 — configuration de process pour boxmail-mcp
//
//   pm2 start deploy/ecosystem.config.js
//   pm2 save            # persiste la liste des process
//   pm2 startup         # génère le service systemd de démarrage auto
//   pm2 logs boxmail-mcp
//
// Prérequis : `npm run build` a été lancé (le serveur tourne sur dist/).
// Les variables secrètes sont lues depuis .env par l'app elle-même (dotenv) ;
// on ne les met PAS ici pour ne rien committer.

module.exports = {
  apps: [
    {
      name: 'boxmail-mcp',
      script: 'dist/index.js',
      cwd: __dirname + '/..',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        // pm2 relance automatiquement le process : la mise à jour depuis
        // l'interface peut redémarrer le serveur en toute sécurité.
        BOXMAIL_SUPERVISED: '1',
      },
      // Les logs applicatifs (JSON) partent sur stderr ; pm2 les capture.
      error_file: 'logs/pm2-error.log',
      out_file: 'logs/pm2-out.log',
      time: true,
    },
  ],
};
