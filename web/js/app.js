import { api, fmtSize, fmtDate, fmtDateTime, fmtNum, esc } from './api.js';

/**
 * Mail Assistant — SPA sans framework.
 * Routage par hash : #/dashboard, #/account/<slug>, #/operations
 * Pass 1 : login, tableau de bord, stats expéditeurs, sync avec progression.
 */

const $ = (sel, root = document) => root.querySelector(sel);
let overviewCache = null;
let serverVersion = null;

// ---------------------------------------------------------------- Couleurs par boîte
// Une couleur STABLE par compte (L5.6) : attribution par position dans la
// liste des comptes (distinctes jusqu'à 10 boîtes), repli sur un hash sinon.
const ACCOUNT_PALETTE = [
  '#2563eb', '#0d9488', '#ea8a0c', '#dc2626', '#7c3aed',
  '#0891b2', '#be185d', '#65a30d', '#b45309', '#475569',
];
let accountColorMap = new Map();

function rebuildAccountColors() {
  // La couleur choisie dans Paramètres (L5.8) prime sur la palette automatique.
  accountColorMap = new Map(
    (overviewCache?.enrolled ?? []).map((e, i) => [
      e.account,
      e.color || ACCOUNT_PALETTE[i % ACCOUNT_PALETTE.length],
    ]),
  );
}

function accountColor(slug) {
  const known = accountColorMap.get(slug);
  if (known) return known;
  let h = 0;
  for (let i = 0; i < (slug ?? '').length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0;
  return ACCOUNT_PALETTE[h % ACCOUNT_PALETTE.length];
}

/** Pastille de compte colorée, utilisée sur tous les écrans. */
// `onDark` : pastille posée sur un fond coloré (bouton d'action) — le fond
// translucide habituel y devient illisible, on passe en pastille opaque.
function accountChip(slug, { onDark = false } = {}) {
  if (!slug) return '';
  const c = accountColor(slug);
  if (onDark) {
    return `<span class="badge acct-chip" style="background:#fff; color:${c}; border:1px solid #fff">${esc(slug)}</span>`;
  }
  return `<span class="badge acct-chip" style="background:${c}1f; color:${c}; border:1px solid ${c}55">${esc(slug)}</span>`;
}
let smtpEnabled = false; // renseigné par /api/me au chargement

// Badge « 🗂️ Règles » : suggestions en attente de validation (L7).
function refreshRulesBadge() {
  const accounts = (overviewCache?.enrolled ?? []).map((e) => e.account);
  Promise.all(accounts.map((slug) => api.rules(slug).catch(() => ({ rules: [] }))))
    .then((all) => {
      const n = all.reduce((s, { rules }) => s + rules.filter((r) => r.status === 'suggested').length, 0);
      const b = $('#rules-badge');
      if (!b) return;
      b.textContent = fmtNum(n);
      b.classList.toggle('hidden', n === 0);
    });
}

/**
 * ⚠️ BADGE SUPPRIMÉ (27/08) — il ne compte plus rien, exprès.
 *
 * Il affichait en permanence le nombre de règles en attente de validation :
 * 114, dont zéro n'a jamais été activée. Autrement dit une pastille rouge
 * permanente rappelant une dette qu'il ne paiera pas — et qu'il a raison de ne
 * pas payer, puisque trier 114 lignes de oui/non n'est pas de l'assistance.
 *
 * La fonction est conservée vide plutôt que supprimée : elle est appelée
 * depuis plusieurs endroits du démarrage, et un badge qui ne s'affiche plus
 * vaut mieux qu'une pile d'appels à débusquer.
 */
function refreshSuggestionsBadge() {
  document.querySelector('#suggestions-badge')?.classList.add('hidden');
}

// Badge « ⭐ Mails suivis » de la sidebar (L5.13).
function refreshFlaggedBadge() {
  api.messagesUnified({ role: 'flagged', limit: 1 }).then((d) => {
    const b = $('#flagged-badge');
    if (!b) return;
    b.textContent = fmtNum(d.total);
    b.classList.toggle('hidden', d.total === 0);
  }).catch(() => {});
}

// ---------------------------------------------------------------- UX globale (L5.10)
let globalUxInstalled = false;
function installGlobalUx() {
  if (globalUxInstalled) return;
  globalUxInstalled = true;

  // Ouvrir un mail listé dans le journal d'activité (panneau « Activité
  // récente » du tableau de bord ET écran 📜 Journal). Délégué : les lignes
  // sont réécrites à chaque rafraîchissement, un écouteur par ligne serait
  // reperdu à chaque fois.
  document.addEventListener('click', (e) => {
    const a = e.target.closest?.('[data-op-open]');
    if (!a) return;
    e.preventDefault();
    openReaderFor(
      {
        account: a.dataset.acc,
        folder: a.dataset.folder,
        uid: Number(a.dataset.uid),
        subject: a.dataset.subject,
        date: a.dataset.date || null,
      },
      { onRemoved: () => route() },
    );
  });

  // Échap ferme le panneau de lecture, puis les modales — partout. Si un
  // brouillon est en cours dans la modale d'envoi, on demande confirmation.
  //
  // 19/08 : Échap retire UN niveau d'engagement à la fois. Sur une lecture
  // agrandie, il réduit d'abord ; c'est seulement au deuxième appui qu'on
  // quitte le mail. Sortir du grand format ET perdre le mail d'un seul geste
  // serait brutal — d'autant qu'en grand il n'y a plus de voile où cliquer.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const lecteur = document.querySelector('.reader');
    if (lecteur) {
      if (lecteur.classList.contains('is-expanded')) {
        basculerAgrandissement(lecteur, false);
        return;
      }
      _pileLecture = [];
      _lectureAgrandie = false;
      closeReader();
      return;
    }
    const overlay = document.querySelector('.modal-overlay');
    if (!overlay) return;
    const draft = overlay.querySelector('#c-text');
    if (draft && draft.value.trim() && !confirm('Fermer sans envoyer ? Le brouillon sera perdu.')) return;
    closeModal();
  });

  // Bouton ⬆ retour en haut sur les longues listes.
  const topBtn = document.createElement('button');
  topBtn.id = 'scroll-top';
  topBtn.className = 'scroll-top hidden';
  topBtn.title = 'Revenir en haut de la page';
  topBtn.textContent = '⬆';
  topBtn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
  document.body.appendChild(topBtn);
  window.addEventListener('scroll', () => {
    topBtn.classList.toggle('hidden', window.scrollY < 600);
  }, { passive: true });

}

// Barre de chargement globale (haut de l'écran) : allumée dès qu'une requête
// réseau est en cours (api-activity émis par api.js). Installée AU DÉMARRAGE
// du module, avant toute requête, pour couvrir même le tout premier
// chargement (login, overview…). Anti-clignotement : n'apparaît que si le
// chargement dure plus de 120 ms.
function installTopLoader() {
  if (document.getElementById('top-loader')) return;
  const loader = document.createElement('div');
  loader.id = 'top-loader';
  loader.className = 'top-loader';
  loader.setAttribute('role', 'progressbar');
  loader.setAttribute('aria-label', 'Chargement en cours');
  document.body.appendChild(loader);
  let showTimer = null;
  window.addEventListener('api-activity', (e) => {
    if (e.detail.active) {
      if (!showTimer) showTimer = setTimeout(() => loader.classList.add('is-loading'), 120);
    } else {
      clearTimeout(showTimer);
      showTimer = null;
      loader.classList.remove('is-loading');
    }
  });
}

// ---------------------------------------------------------------- Auth & boot
async function boot() {
  try {
    const me = await api.me();
    if (me.authenticated) return showApp();
  } catch (err) {
    if (err.status === 503) {
      showLogin(err.message);
      $('#login-form').classList.add('hidden');
      return;
    }
  }
  showLogin();
}

function showLogin(message) {
  $('#login-view').classList.remove('hidden');
  $('#app-view').classList.add('hidden');
  if (message) {
    const el = $('#login-error');
    el.textContent = message;
    el.classList.remove('hidden');
  }
}

async function showApp() {
  $('#login-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  api.me().then((me) => { smtpEnabled = Boolean(me.smtpEnabled); }).catch(() => {});
  api.version().then((v) => {
    serverVersion = v;
    $('#version-line').textContent =
      `version ${v.commit} · ${v.date}` + (v.supervised ? '' : ' · ⚠️ non supervisé');
  }).catch(() => {});
  await refreshOverview();
  installGlobalUx();
  installSideToggles();
  route();
  startJobWatcher();
  // Depuis la Phase 2, la sidebar ne porte plus qu'un badge par entrée :
  // Aujourd'hui / À traiter (posés par renderToday) et Mails suivis.
  refreshFlaggedBadge();
}

// Badge tâches : nombre à faire (rouge si au moins une en retard).
async function refreshTasksBadge(data) {
  try {
    const d = data ?? (await api.tasks());
    const el = $('#tasks-badge');
    if (!el) return;
    el.textContent = fmtNum(d.counts.todo);
    el.classList.toggle('hidden', d.counts.todo === 0);
    el.classList.toggle('red', d.counts.overdue > 0);
    el.classList.toggle('orange', d.counts.overdue === 0);
  } catch {
    /* pas de badge */
  }
}

// Badge « importance haute » (score ≥ 70) sur le lien ⭐ À ne pas manquer.
async function refreshImportantBadge(data) {
  try {
    const d = data ?? (await api.important());
    const el = $('#important-badge');
    if (!el) return;
    el.textContent = fmtNum(d.counts.high);
    el.classList.toggle('hidden', d.counts.high === 0);
  } catch {
    /* index pas prêt : pas de badge */
  }
}

// Badge échéances : propositions à valider + confirmées sous 7 jours.
async function refreshDeadlinesBadge(data) {
  try {
    const d = data ?? (await api.deadlines());
    const el = $('#deadlines-badge');
    if (!el) return;
    const soon = d.items.filter(
      (x) => (x.status === 'proposed' || x.status === 'confirmed') && x.inDays >= -1 && x.inDays <= 7,
    ).length;
    const n = d.counts.proposed + soon > 0 ? Math.max(d.counts.proposed, soon) : 0;
    el.textContent = fmtNum(n);
    el.classList.toggle('hidden', n === 0);
  } catch {
    /* index pas prêt */
  }
}

// Badge « en retard » sur le lien À relancer de la sidebar.
async function refreshFollowupsBadge(data) {
  try {
    const d = data ?? (await api.followups());
    const el = $('#followups-badge');
    if (!el) return;
    el.textContent = fmtNum(d.counts.overdue);
    el.classList.toggle('hidden', d.counts.overdue === 0);
  } catch {
    /* index pas prêt : pas de badge */
  }
}

// Badge « en retard » sur le lien À répondre de la sidebar.
async function refreshRepliesBadge(data) {
  try {
    const d = data ?? (await api.replies());
    const el = $('#replies-badge');
    if (!el) return;
    el.textContent = fmtNum(d.counts.overdue);
    el.classList.toggle('hidden', d.counts.overdue === 0);
  } catch {
    /* index pas prêt : pas de badge */
  }
}

// ---------------------------------------------------------------- Suivi global
// Les tâches (syncs, nettoyages…) tournent côté serveur : changer de page ne
// les interrompt pas. Ce watcher les rend visibles partout et rafraîchit les
// vues quand elles se terminent.
const watchedRunning = new Set();
let jobWatcherTimer = null;

function startJobWatcher() {
  if (jobWatcherTimer) return;
  jobWatcherTimer = setInterval(pollJobs, 2500);
  pollJobs();
}

function jobLabel(kind) {
  if (kind.startsWith('sync:')) return `🔄 Sync ${kind.slice(5)}`;
  if (kind.startsWith('cleanup:')) return `🧹 Nettoyage ${kind.slice(8)}`;
  if (kind.startsWith('enroll:')) return `＋ Ajout ${kind.slice(7)}`;
  if (kind.startsWith('deadlines:')) return `📅 Détection échéances ${kind.slice(10)}`;
  if (kind === 'sync-all') return '🔄 Sync de toutes les boîtes';
  if (kind === 'update') return '⬆️ Mise à jour';
  if (kind === 'ocr') return '🔍 Lecture des scans (OCR)';
  return `⚙️ ${kind}`;
}

async function pollJobs() {
  if ($('#app-view').classList.contains('hidden')) return;
  let jobs;
  try {
    ({ jobs } = await api.jobs());
  } catch {
    return;
  }
  const running = jobs.filter((j) => j.status === 'running');

  // Une tâche vient de se terminer → rafraîchir sidebar (+ dashboard si affiché).
  let finished = false;
  for (const id of [...watchedRunning]) {
    if (!running.some((j) => j.id === id)) {
      watchedRunning.delete(id);
      finished = true;
    }
  }
  for (const j of running) watchedRunning.add(j.id);
  if (finished) {
    refreshOverview()
      .then(() => {
        if (!(location.hash || '#/dashboard').startsWith('#/account/')) route();
      })
      .catch(() => {});
    refreshRepliesBadge();
    refreshFollowupsBadge();
    refreshImportantBadge();
  }

  // Chip d'activité en bas à droite (toutes pages).
  const chip = $('#activity-chip');
  if (running.length === 0) {
    chip.classList.add('hidden');
  } else {
    chip.classList.remove('hidden');
    chip.innerHTML = running
      .map(
        (j) => `<div class="chip-line" data-kind="${esc(j.kind)}">
        <span class="spinner"></span><strong>${jobLabel(j.kind)}</strong>
        <span style="opacity:.7; font-size:11px">${esc((j.lastProgress ?? '').slice(0, 44))}</span></div>`,
      )
      .join('');
    chip.querySelectorAll('.chip-line').forEach((el) => {
      el.addEventListener('click', () => {
        const kind = el.dataset.kind;
        if (kind.startsWith('sync:') || kind.startsWith('cleanup:')) {
          location.hash = `#/account/${encodeURIComponent(kind.split(':')[1])}`;
        }
      });
    });
  }

  // Badge ⏳ sur les comptes occupés dans la sidebar.
  document.querySelectorAll('#accounts-nav [data-account]').forEach((a) => {
    const slug = a.dataset.account;
    const busy = running.some(
      (j) =>
        j.kind === `sync:${slug}` ||
        j.kind === `cleanup:${slug}` ||
        (j.kind === 'sync-all' && (j.lastProgress ?? '').startsWith(`[${slug}]`)),
    );
    a.querySelector('.sync-badge')?.remove();
    if (busy) {
      const s = document.createElement('span');
      s.className = 'badge orange sync-badge';
      s.textContent = '⏳';
      a.appendChild(s);
    }
  });
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = $('#login-error');
  errEl.classList.add('hidden');
  try {
    await api.login($('#login-password').value);
    $('#login-password').value = '';
    await showApp();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
});

$('#logout-btn').addEventListener('click', async () => {
  await api.logout().catch(() => {});
  location.hash = '#/today';
  showLogin();
});

$('#add-account-btn').addEventListener('click', openEnrollModal);

// Compte dont la sync doit démarrer automatiquement à l'ouverture de sa vue
// (après un enrôlement réussi).
let pendingAutoSync = null;

// ---------------------------------------------------------------- Sidebar
// Arborescence des boîtes (L5.17) : chaque compte se déplie (+/−) pour montrer
// ses dossiers — clic sur un dossier → lecture directe de ce dossier. L'état
// déplié est mémorisé ; les dossiers viennent de l'index (instantané).
let sideOpen = new Set(JSON.parse(localStorage.getItem('bm.sideOpen') ?? '[]'));
const sideFoldersCache = new Map(); // slug -> folders[] (invalidé à chaque refreshOverview)

const SIDE_ROLE_ORDER = { inbox: 0, sent: 1, drafts: 2, archive: 3, custom: 4, trash: 8, spam: 9 };

function sideFolderList(slug) {
  const folders = sideFoldersCache.get(slug);
  if (!folders) return '<div class="side-folder muted">chargement…</div>';
  const usable = folders
    .filter((f) => f.messageCount > 0 || ['inbox', 'sent', 'drafts', 'trash'].includes(f.role))
    .sort((a, b) =>
      (SIDE_ROLE_ORDER[a.role] ?? 5) - (SIDE_ROLE_ORDER[b.role] ?? 5) || a.path.localeCompare(b.path));
  if (usable.length === 0) {
    return '<div class="side-folder muted">aucun dossier synchronisé — synchronise la boîte</div>';
  }
  return usable
    .map(
      (f) => `<a class="side-folder" data-goto-folder="${esc(f.path)}" data-goto-account="${esc(slug)}"
        title="${esc(f.path)} (${fmtNum(f.messageCount)} mails)">
        <span class="side-folder-name">${FOLDER_ROLE_EMOJI[f.role] ?? '📂'} ${esc(f.name || f.path)}</span>
        ${f.unseenCount ? `<span class="badge blue">${fmtNum(f.unseenCount)}</span>` : ''}
      </a>`,
    )
    .join('');
}

function renderAccountsNav() {
  const nav = $('#accounts-nav');
  if (!nav || !overviewCache) return;
  const bySlug = new Map(overviewCache.accounts.map((a) => [a.account, a]));
  const items = overviewCache.enrolled.map((e) => {
    const ov = bySlug.get(e.account);
    const unseen = ov?.inbox?.unseen;
    const open = sideOpen.has(e.account);
    return `<div class="side-acct">
      <div class="side-link" data-account="${esc(e.account)}">
        <button class="side-caret" data-toggle="${esc(e.account)}"
          title="${open ? 'Replier' : 'Déplier'} les dossiers de ${esc(e.account)}">${open ? '▾' : '▸'}</button>
        <a href="#/account/${esc(e.account)}" class="side-acct-link" title="${esc(e.username)}">
          <span class="acct-dot" style="background:${accountColor(e.account)}"></span>
          <span class="account-email">${esc(e.account)}</span></a>
        ${unseen == null ? '<span class="badge gray">à synchroniser</span>' : unseen > 0 ? `<span class="badge blue">${fmtNum(unseen)}</span>` : ''}
      </div>
      ${open ? `<div class="side-folders">${sideFolderList(e.account)}</div>` : ''}
    </div>`;
  });
  nav.innerHTML =
    items.join('') ||
    '<div class="side-link disabled">Aucune boîte connectée</div>';

  nav.querySelectorAll('[data-toggle]').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const slug = btn.dataset.toggle;
      if (sideOpen.has(slug)) sideOpen.delete(slug);
      else sideOpen.add(slug);
      localStorage.setItem('bm.sideOpen', JSON.stringify([...sideOpen]));
      renderAccountsNav();
      loadSideFolders();
    });
  });
  nav.querySelectorAll('[data-goto-folder]').forEach((el) => {
    el.addEventListener('click', () => {
      const slug = el.dataset.gotoAccount;
      inboxState.account = slug;
      localStorage.setItem('bm.inboxAccount', slug);
      inboxState.role = 'inbox';
      inboxState.folder = el.dataset.gotoFolder;
      inboxState.offset = 0;
      inboxState.selected.clear();
      const target = `#/inbox/${encodeURIComponent(slug)}`;
      if (location.hash === target) route();
      else location.hash = target;
    });
  });
  highlightNav();
}

// Charge (une fois par rafraîchissement) les dossiers des comptes dépliés.
function loadSideFolders() {
  for (const slug of sideOpen) {
    if (sideFoldersCache.has(slug)) continue;
    if (!(overviewCache?.enrolled ?? []).some((e) => e.account === slug)) continue;
    api.folders(slug)
      .then(({ folders }) => {
        sideFoldersCache.set(slug, folders);
        renderAccountsNav();
      })
      .catch(() => {
        sideFoldersCache.set(slug, []);
        renderAccountsNav();
      });
  }
}

async function refreshOverview() {
  overviewCache = await api.overview();
  rebuildAccountColors();
  sideFoldersCache.clear(); // compteurs à jour au prochain dépliage
  renderAccountsNav();
  loadSideFolders();
  updateSideStatus();
}

/** Pied de sidebar : l'état système en trois lignes, toujours visible. */
function updateSideStatus() {
  const el = $('#side-status');
  const ov = overviewCache;
  if (!el || !ov) return;
  const total = ov.enrolled.length;
  const synced = ov.accounts.filter((a) => a.lastSyncAt).length;
  const lastSync = ov.accounts.reduce((m, a) => {
    const t = a.lastSyncAt ? new Date(a.lastSyncAt).getTime() : 0;
    return t > m ? t : m;
  }, 0);
  const dot = total === 0 ? '' : synced === total ? 'ok' : synced === 0 ? 'err' : 'warn';
  el.innerHTML = `
    <div><span class="status-dot ${dot}"></span>${fmtNum(synced)}/${fmtNum(total)} compte(s) synchronisé(s)</div>
    ${lastSync ? `<div>Dernière synchro : ${new Date(lastSync).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</div>` : ''}
    <div><a href="#/dashboard">Voir le détail système</a></div>`;
}

// Route → entrée de navigation. Depuis la Phase 2 de la revue UX, plusieurs
// écrans partagent la même entrée (hub) : leurs onglets vivent dans la page.
const NAV_BY_ROUTE = {
  inbox: 'inbox',
  replies: 'todo', followups: 'todo', important: 'todo', deadlines: 'todo', tasks: 'todo',
  cleanup: 'clean', unsubscribe: 'unsubscribe', bigclean: 'clean',
  rules: 'organize', suggestions: 'organize', verify: 'organize',
  calendar: 'calendar', search: 'search',
  dashboard: 'dashboard', attachments: 'attachments', operations: 'operations',
  settings: 'settings', help: 'help',
};

function highlightNav() {
  const hash = location.hash || '#/today';
  document.querySelectorAll('.side-link').forEach((el) => el.classList.remove('active'));
  if (hash.startsWith('#/account/')) {
    const slug = decodeURIComponent(hash.split('/')[2] ?? '');
    document.querySelector(`[data-account="${CSS.escape(slug)}"]`)?.classList.add('active');
    return;
  }
  if (hash.startsWith('#/inbox')) {
    document.querySelectorAll('.side-folder.active').forEach((el) => el.classList.remove('active'));
    if (inboxState.account) {
      // Boîte précise : on allume le compte ET son dossier dans l'arborescence.
      document.querySelector(`[data-account="${CSS.escape(inboxState.account)}"]`)?.classList.add('active');
      document
        .querySelector(
          `.side-folder[data-goto-account="${CSS.escape(inboxState.account)}"][data-goto-folder="${CSS.escape(inboxState.folder || 'INBOX')}"]`,
        )
        ?.classList.add('active');
    } else if (inboxState.role === 'inbox') {
      document.querySelector('[data-nav="inbox"]')?.classList.add('active');
    } else {
      // Suivis / envoyés / brouillons / corbeille : sous « Plus ».
      openSideGroup('more');
      document.querySelector(`a[href="#/inbox/@${CSS.escape(inboxState.role)}"]`)?.classList.add('active');
    }
    return;
  }
  const seg = hash.slice(2).split('/')[0].split('?')[0];
  const nav = NAV_BY_ROUTE[seg] ?? 'today';
  const lien = document.querySelector(`[data-nav="${nav}"]`);
  lien?.classList.add('active');
  // Si l'écran courant vit sous « Plus », le groupe s'ouvre : on ne doit
  // jamais se retrouver sur une page sans voir d'où elle vient.
  if (lien?.closest('#more-nav')) openSideGroup('more');
}

/** Ouvre (sans refermer) un groupe repliable de la sidebar. */
function openSideGroup(key) {
  const nav = $(`#${key}-nav`);
  const caret = $(`#${key}-caret`);
  if (nav?.classList.contains('hidden')) {
    nav.classList.remove('hidden');
    if (caret) caret.textContent = '▾';
    try { localStorage.setItem(`side-${key}-open`, '1'); } catch { /* privé */ }
  }
}

/** Bascule des groupes repliables de la barre (état mémorisé localement). */
function installSideToggles() {
  // « more » remplace « folders » depuis la refonte du 10/08 : la barre ne
  // porte plus que trois entrées, tout le reste vit derrière « Plus ».
  for (const key of ['more']) {
    const toggle = $(`#${key}-toggle`);
    const nav = $(`#${key}-nav`);
    const caret = $(`#${key}-caret`);
    if (!toggle || !nav) continue;
    let open = false;
    try { open = localStorage.getItem(`side-${key}-open`) === '1'; } catch { /* privé */ }
    nav.classList.toggle('hidden', !open);
    if (caret) caret.textContent = open ? '▾' : '▸';
    toggle.addEventListener('click', () => {
      const nowOpen = nav.classList.toggle('hidden') === false;
      if (caret) caret.textContent = nowOpen ? '▾' : '▸';
      try { localStorage.setItem(`side-${key}-open`, nowOpen ? '1' : '0'); } catch { /* privé */ }
    });
  }
}

// --------------------------------------------------- Onglets des hubs (Phase 2)
// Trois intentions, trois hubs : les anciennes routes restent valides et
// portent simplement une barre d'onglets commune en tête d'écran.
const HUBS = {
  todo: [
    ['replies', '#/replies', '↩️ À répondre'],
    ['followups', '#/followups', '⏰ À relancer'],
    ['important', '#/important', '⭐ À ne pas manquer'],
    ['deadlines', '#/deadlines', '📅 Dates'],
    ['affaires', '#/affaires', '🧭 Affaires en cours'],
    ['tasks', '#/tasks', '☑️ Mes tâches'],
  ],
  clean: [
    ['cleanup', '#/cleanup', '🧹 Nettoyage rapide'],
    ['unsubscribe', '#/unsubscribe', '🚫 Désinscriptions'],
    ['bigclean', '#/bigclean', '🧺 Libérer de l\'espace'],
  ],
  // ⚠️ LE HUB « organize » A ÉTÉ RETIRÉ (27/08), avec ses quatre écrans :
  // 📁 Mes dossiers · 🗂️ Classement automatique · 💡 Règles proposées ·
  // 🔬 Corriger l'assistant.
  //
  // Usage MESURÉ : 114 règles suggérées et 0 activée ; 0 fusion, 0 renommage,
  // 0 masquage en un mois ; aucune trace de notation des moteurs. Son verdict
  // du 26/08 explique pourquoi, et ce n'était pas un manque de discipline :
  // « c'est une suite de 114 lignes à dire oui ou non, alors que tu devrais
  // déjà être capable de m'orienter afin que je valide une décision que tu
  // auras DÉJÀ PRISE ». Le plan du 10/08 l'avait d'ailleurs prescrit —
  // « faire disparaître les règles de l'interface » — sans que ce soit fait.
  //
  // LES CAPACITÉS RESTENT : les routes répondent toujours (récupération
  // possible par URL), les services ne bougent pas. Ce qui disparaît, c'est la
  // console permanente de maintenance. Une correction se fera désormais AU
  // MOMENT où l'erreur est visible — « j'ai regroupé ces deux conversations,
  // Annuler » — et non dans un écran d'administration.
};

function hubTabs(activeKey) {
  const hub = Object.values(HUBS).find((tabs) => tabs.some(([key]) => key === activeKey));
  if (!hub) return '';
  return `<div class="tabs hub-tabs">${hub
    .map(([key, href, label]) => `<a class="tab ${key === activeKey ? 'active' : ''}" href="${href}">${label}</a>`)
    .join('')}</div>`;
}

// ---------------------------------------------------------------- Router
window.addEventListener('hashchange', route);

function route() {
  highlightNav();
  const hash = location.hash || '#/today';
  if (hash.startsWith('#/account/')) {
    renderAccount(decodeURIComponent(hash.split('/')[2] ?? ''));
  } else if (hash.startsWith('#/operations')) {
    renderOperations();
  } else if (hash.startsWith('#/inbox')) {
    renderInbox(decodeURIComponent(hash.split('/')[2] ?? ''));
  } else if (hash.startsWith('#/search')) {
    // ⚠️ Le `?q=` de l'URL était IGNORÉ (mesuré le 26/08) : tout lien profond
    // vers la recherche — « Voir l'histoire » d'une attente, le « 🔍 Voir »
    // d'un dossier — ouvrait un écran vide en invitant à retaper la question.
    const q = new URLSearchParams(hash.split('?')[1] || '').get('q');
    if (q !== null) searchState.q = q;
    renderSearch(q !== null && q !== '');
  } else if (hash.startsWith('#/replies')) {
    renderReplies();
  } else if (hash.startsWith('#/followups')) {
    renderFollowups();
  } else if (hash.startsWith('#/deadlines')) {
    renderDeadlines();
  } else if (hash.startsWith('#/calendar')) {
    renderCalendar();
  } else if (hash.startsWith('#/settings')) {
    renderSettings();
  } else if (hash.startsWith('#/help')) {
    renderHelp();
  } else if (hash.startsWith('#/attachments')) {
    renderAttachments();
  } else if (hash.startsWith('#/unsubscribe')) {
    renderUnsubscribe();
  } else if (hash.startsWith('#/cleanup')) {
    renderCleanupGlobal();
  } else if (hash.startsWith('#/bigclean')) {
    renderBigClean();
  } else if (hash.startsWith('#/rules')) {
    renderRules();
  } else if (hash.startsWith('#/affaires')) {
    renderAffaires();
  } else if (hash.startsWith('#/suivi')) {
    renderSuivi();
  } else if (hash.startsWith('#/argent')) {
    renderArgent();
  } else if (hash.startsWith('#/dossiers')) {
    renderDossiers();
  } else if (hash.startsWith('#/suggestions')) {
    renderSuggestions();
  } else if (hash.startsWith('#/verify')) {
    renderVerify();
  } else if (hash.startsWith('#/important')) {
    renderImportant();
  } else if (hash.startsWith('#/depouillement')) {
    renderReviewPage();
  } else if (hash.startsWith('#/tasks')) {
    renderTasks();
  } else if (hash.startsWith('#/dashboard')) {
    renderDashboard();
  } else {
    renderToday();
  }
  // Barre d'onglets du hub (Phase 2) : injectée en tête d'écran. Les renderers
  // posent leur page-head de façon SYNCHRONE avant leur premier await — on
  // peut donc préposer juste après l'appel.
  const seg = hash.slice(2).split('/')[0].split('?')[0];
  const tabs = hubTabs(seg);
  if (tabs) $('#main').insertAdjacentHTML('afterbegin', tabs);
}

// Barre de remplissage d'une boîte (L5.18) : orange ≥ 90 %, rouge ≥ 95 %.
function quotaColor(pct) {
  if (pct >= 95) return 'var(--red)';
  if (pct >= 90) return 'var(--orange)';
  return 'var(--accent)';
}

// `note` : pourquoi le quota est inconnu (diagnostic stocké côté serveur) —
// affiché en clair, sinon l'utilisateur ne peut rien en conclure.
function quotaCell(q, note) {
  if (!q) {
    return `<span class="muted" style="font-size:12px" title="${esc(note || '')}">inconnu — ${esc(note || 'lance une synchronisation (ou 📏 Quota dans Paramètres)')}</span>`;
  }
  const color = quotaColor(q.pct);
  return `<div class="quota-cell" title="${fmtSize(q.usedBytes)} utilisés sur ${fmtSize(q.limitBytes)}">
    <div class="bar-track"><div class="bar-fill" style="width:${q.pct}%; background:${color}"></div></div>
    <span style="white-space:nowrap; font-size:12px; ${q.pct >= 90 ? `color:${color}; font-weight:600` : ''}">
      ${fmtSize(q.usedBytes)} / ${fmtSize(q.limitBytes)} · ${q.pct}%${q.pct >= 90 ? ` ⚠️ libre : ${fmtSize(q.freeBytes)}` : ''}</span>
  </div>`;
}

// « +N depuis hier » pour la carte Nouveaux mails (L5.16).
function newMailsDelta(nm) {
  if (!nm) return '&nbsp;';
  const diff = nm.today - nm.yesterday;
  if (diff > 0) return `+${fmtNum(diff)} par rapport à hier`;
  if (diff < 0) return `${fmtNum(diff)} par rapport à hier`;
  return 'comme hier';
}

// ------------------------------------------------- Aujourd'hui (A2 — Cap V3)
// L'accueil orienté ACTIONS : on ne montre pas des mails, on dit quoi faire.
const NOISE_LABELS = {
  newsletter: ['📰', 'Newsletters'],
  notification: ['🤖', 'Notifications'],
  social: ['💬', 'Réseaux sociaux'],
  promo: ['📢', 'Publicités & promos'],
};

function daysAgo(hours) {
  const d = Math.round(hours / 24);
  return d <= 0 ? "aujourd'hui" : d === 1 ? 'depuis 1 jour' : `depuis ${d} jours`;
}

// Une ligne d'action : phrase + chip de la boîte + 📖 si un mail est lisible.
// Les items lisibles sont gardés en mémoire (pas dans le HTML : les sujets
// contiennent des apostrophes/guillemets qui casseraient les attributs).
let todayReaderRefs = [];

function todayRow(html, readerItem, badge = '') {
  const readable = readerItem && readerItem.folder && readerItem.uid;
  let idx = -1;
  let readBtn = '';
  if (readable) {
    todayReaderRefs.push(readerItem);
    idx = todayReaderRefs.length - 1;
    readBtn = `<button class="btn btn-sm today-read" data-idx="${idx}">📖 Lire</button>`;
  }
  // DATE DE RÉCEPTION. Aucune des quatre listes de l'accueil n'en affichait :
  // un mail de 2020 se présentait exactement comme un mail de ce mois-ci, alors
  // que c'est le premier critère pour décider quoi traiter. Pour une échéance,
  // l'appelant passe déjà `date: d.msgDate` — c'est donc bien la date du MAIL,
  // pas celle de l'échéance (elle reste affichée dans la phrase).
  const recu = readerItem?.date
    ? `<span class="muted" style="font-size:11.5px; white-space:nowrap">${fmtDate(readerItem.date)}</span>`
    : '';
  // Le sujet devient cliquable comme partout ailleurs : sur cet écran, seul le
  // bouton « 📖 Lire » ouvrait le mail — incohérence d'affordance sur la page
  // la plus consultée. Le bouton reste, pour rester découvrable.
  const corps = readable
    ? `<span class="openable" data-today-open="${idx}">${html}</span>`
    : html;
  return `<div class="today-row" style="display:flex; align-items:center; gap:8px; padding:7px 0; border-bottom:1px solid var(--border)">
    <div style="flex:1; min-width:0">${corps}</div>
    ${recu}
    ${badge}
    ${readerItem?.account ? accountChip(readerItem.account) : ''}
    ${readBtn}
  </div>`;
}

function bindTodayRows(root) {
  const ouvrir = (idx) => {
    const item = todayReaderRefs[Number(idx)];
    if (item) openReaderFor(item, { onRemoved: () => renderToday() });
  };
  root.querySelectorAll('.today-read').forEach((btn) => {
    btn.addEventListener('click', () => ouvrir(btn.dataset.idx));
  });
  root.querySelectorAll('[data-today-open]').forEach((el) => {
    el.addEventListener('click', () => ouvrir(el.dataset.todayOpen));
  });
}

/**
 * Jeton de rendu de la Vue du jour (20/08). Deux rendus lancés coup sur coup
 * (retour arrière du navigateur, double clic sur « Aujourd'hui », rendu initial
 * suivi d'un hashchange) se terminaient tous les deux : le premier posait ses
 * écouteurs sur le DOM du second, si bien qu'un clic « Voir le mail » ouvrait
 * DEUX lecteurs — et l'écran retombait fermé une fois sur deux.
 * Le dernier rendu demandé gagne ; les précédents abandonnent après leur await.
 */
let _renduToday = 0;

async function renderToday() {
  const monRendu = ++_renduToday;
  const main = $('#main');
  const todayDate = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  main.innerHTML = `<div class="page-head"><div><h1>Vue du jour</h1>
    <div class="sub" style="text-transform:capitalize">${esc(todayDate)}</div></div>
    <div class="head-actions">
      <a class="btn" href="#/search">Rechercher</a>
      <button class="btn" id="syncall-btn" title="Synchronise chaque boîte l'une après l'autre, en arrière-plan">Synchroniser</button>
      <button class="btn" id="refresh-btn" title="Recharger la vue">Actualiser</button>
    </div></div>
    <div id="today-body"><div class="empty"><span class="spinner"></span>Analyse de tes boîtes…</div></div>`;
  $('#refresh-btn').addEventListener('click', () => renderToday());
  $('#syncall-btn').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await api.syncAll('recent');
      pollJobs();
    } catch (err) {
      e.target.disabled = false;
      alert(err.message);
    }
  });

  let t;
  try {
    t = await api.today();
  } catch (err) {
    $('#today-body').innerHTML = `<div class="notice warn">${esc(err.message)}</div>`;
    return;
  }
  if (location.hash && !(location.hash === '#/today' || location.hash === '' || location.hash === '#/')) return;
  // Un rendu plus récent a été demandé pendant qu'on attendait : celui-ci n'a
  // plus lieu d'être, et surtout il ne doit pas recâbler l'écran de l'autre.
  if (monRendu !== _renduToday) return;
  todayReaderRefs = [];

  // Badges sidebar : nombre d'actions à faire (Vue du jour + hub À traiter).
  for (const badge of [$('#today-badge'), $('#todo-badge')]) {
    if (!badge) continue;
    badge.textContent = fmtNum(t.todo.total);
    badge.classList.toggle('hidden', t.todo.total === 0);
  }

  // Bandeau de mise à jour : la Vue du jour est LA page d'accueil — c'est ici
  // qu'il vit (l'État des comptes n'est plus dans la navigation principale).
  checkForUpdates($('#today-body'));

  // ---- Bandeau synthétique : une seule surface, des séparateurs ----
  const ov = overviewCache;
  const syncedCount = ov ? ov.accounts.filter((a) => a.lastSyncAt).length : 0;
  const totalAccounts = ov ? ov.enrolled.length : 0;
  const dueToday = t.todo.deadlines.filter((d) => d.inDays <= 0).length;
  const strip = `<div class="summary-strip">
    <a class="summary-cell" href="#/inbox/@inbox">
      <span class="val">${fmtNum(ov?.newMails?.today ?? 0)}</span>
      <span class="lbl">nouveaux mails aujourd'hui</span></a>
    <a class="summary-cell ${t.todo.total ? 'warn' : 'ok'}" href="#/replies">
      <span class="val">${fmtNum(t.todo.total)}</span>
      <span class="lbl">à traiter</span></a>
    <a class="summary-cell ${dueToday ? 'danger' : ''}" href="#/deadlines">
      <span class="val">${fmtNum(dueToday)}</span>
      <span class="lbl">échéance(s) aujourd'hui</span></a>
    <a class="summary-cell" href="#/cleanup">
      <span class="val">${fmtNum(t.noise.total)}</span>
      <span class="lbl">mails à nettoyer · ${fmtSize(t.noise.sizeBytes)}</span></a>
    <a class="summary-cell ${totalAccounts && syncedCount === totalAccounts ? 'ok' : 'warn'}" href="#/dashboard">
      <span class="val">${fmtNum(syncedCount)}/${fmtNum(totalAccounts)}</span>
      <span class="lbl">comptes synchronisés</span></a>
  </div>`;

  // ---- Colonne principale : tableau « À traiter aujourd'hui » ----
  // Une ligne par action, colonnes Priorité / Action / Compte / Raison /
  // Attente. Les lignes s'ouvrent dans le panneau de lecture ; le parcours
  // guidé (« Commencer », 5/15 min) reste le geste principal.
  const prio = (cls, label) => `<span class="prio ${cls}">${label}</span>`;
  const todoRows = [];
  const pushRow = (readerItem, cells) => {
    const idx = readerItem ? todayReaderRefs.push(readerItem) - 1 : -1;
    todoRows.push(`<tr class="row-click" ${idx >= 0 ? `data-today-open="${idx}"` : ''}>
      ${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`);
  };
  for (const r of t.todo.replies) {
    pushRow(r, [
      r.overdue ? prio('high', 'Haute') : prio('medium', 'Normale'),
      `<strong>Répondre à ${esc(r.fromName || r.fromEmail)}</strong>
        <div class="row-snippet">${esc(r.subject)}</div>`,
      accountChip(r.account),
      `<span class="muted clamp2" style="font-size:12.5px" title="${esc(r.reason ?? '')}">${esc(r.reason ?? 'réponse attendue')}</span>`,
      `<span class="muted" style="white-space:nowrap">${daysAgo(r.waitingHours)}</span>`,
    ]);
  }
  for (const i of t.todo.invoices) {
    pushRow(i, [
      prio('medium', 'Normale'),
      `<strong>Facture à traiter</strong>
        <div class="row-snippet">${esc(i.subject)} — ${esc(i.fromName || i.fromEmail)}</div>`,
      accountChip(i.account),
      `<span class="muted clamp2" style="font-size:12.5px" title="${esc(i.reason ?? '')}">${esc(i.reason ?? 'facture détectée')}</span>`,
      '',
    ]);
  }
  for (const d of t.todo.deadlines) {
    const readerItem = d.folder && d.uid
      ? { account: d.account, folder: d.folder, uid: d.uid, subject: d.subject, fromName: d.fromName, fromEmail: d.fromEmail, date: d.msgDate, isSeen: d.isSeen }
      : { account: d.account };
    pushRow(readerItem, [
      d.inDays <= 0 ? prio('high', 'Haute') : prio('medium', 'Normale'),
      `<strong>Échéance : ${esc(d.title)}</strong>
        ${d.status === 'proposed' ? '<div class="row-snippet">détectée — à confirmer</div>' : ''}`,
      accountChip(d.account),
      `<span class="muted clamp2" style="font-size:12.5px" title="${esc(d.reason ?? '')}">${esc(d.reason ?? '')}</span>`,
      d.inDays < 0 ? `<span class="badge red">dépassée de ${fmtNum(-d.inDays)} j</span>`
        : d.inDays === 0 ? '<span class="badge red">aujourd’hui</span>'
        : `<span class="muted" style="white-space:nowrap">${fmtDate(d.date)}</span>`,
    ]);
  }
  for (const f of t.todo.followups) {
    pushRow(
      { account: f.account, folder: f.folder, uid: f.uid, subject: f.subject, fromName: 'Toi (mail envoyé)', fromEmail: '', date: f.date, isSeen: true },
      [
        f.stage === 'urgent' || f.overdue ? prio('high', 'Haute') : prio('low', 'Basse'),
        `<strong>Relancer ${esc(f.counterpartyName || f.counterpartyEmail)}</strong>
          <div class="row-snippet">${esc(f.subject)}</div>`,
        accountChip(f.account),
        `<span class="muted clamp2" style="font-size:12.5px" title="${esc(f.suggestion ?? '')}">${f.stage === 'stale' ? 'abandonné ? à clôturer' : esc(f.suggestion ?? 'sans réponse')}</span>`,
        `<span class="muted" style="white-space:nowrap">${daysAgo(f.waitingHours)}</span>`,
      ],
    );
  }

  const noiseLines = t.noise.buckets.filter((b) => b.count > 0).map((b) => {
    const label = (NOISE_LABELS[b.bucket] ?? ['', b.bucket])[1];
    return `<div class="set-line"><span>${esc(label)}
        <span class="muted" style="font-size:12px">· ${fmtNum(b.count)} mails · ${fmtSize(b.sizeBytes)}</span></span>
      <button class="btn btn-sm noise-btn" data-bucket="${b.bucket}">Examiner</button></div>`;
  }).join('');

  $('#today-body').innerHTML = `
    ${t.skippedAccounts.length ? `<div class="notice warn"><strong>Boîte(s) ignorée(s)</strong> : ${t.skippedAccounts.map((s) => esc(s.account)).join(', ')} — lance une synchronisation.</div>` : ''}
    ${!t.categorized ? `<div class="notice warn">Les catégories n'ont pas encore été calculées : la partie « nettoyage » sera vide.
      Va dans <a href="#/settings">Paramètres</a> → « Réexaminer les expéditeurs » (une fois, quelques secondes).</div>` : ''}
    <!-- Le mail s'ouvre À CÔTÉ des cartes, pas par-dessus (20/08) : « il se met
         devant et je ne peux donc pas passer d'un mail à l'autre sans fermer
         puis rouvrir ». La colonne existait déjà sur « À traiter » et la Boîte
         de réception ; elle manquait ici, sur l'écran d'accueil. -->
    <div class="inbox-layout" id="today-layout">
      <div id="today-brief"></div>
      <div class="inbox-dock hidden" id="today-dock"></div>
    </div>
    <div id="today-whatsnew"></div>
    <div id="today-review"></div>
    <div id="today-rentila"></div>
    <details class="today-more"><summary>Le détail : listes, compteurs et nettoyage</summary>
    ${strip}
    <div class="today-grid">
      <div>
        <div class="panel">
          <div class="panel-head"><h2>À traiter aujourd'hui</h2>
            <span style="display:flex; gap:8px; align-items:center">
              ${t.todo.total ? `<span class="muted" style="font-size:12px">${todoEstimateLabel(t)} · arrête-toi quand tu veux</span>
              <button class="btn btn-primary btn-sm" id="todo-assist"
                title="Une action à la fois, la plus urgente d'abord, avec les bons boutons : répondre, reporter, confirmer, classer — tu t'arrêtes quand tu veux, rien n'est perdu">Commencer</button>` : ''}
            </span></div>
          <div class="panel-body tight">
            ${todoRows.length ? `<table>
              <thead><tr><th style="width:86px">Priorité</th><th>Action</th><th style="width:80px">Compte</th>
                <th style="width:200px">Raison</th><th style="width:120px">Attente</th></tr></thead>
              <tbody>${todoRows.join('')}</tbody></table>`
              : '<div class="empty">Rien d’urgent : aucune réponse attendue, facture ou échéance du jour.</div>'}
            <div class="muted" style="font-size:12.5px; padding:8px 16px">
              ${t.important.length ? `<a href="#/important">${fmtNum(t.important.length)} mail(s) à ne pas manquer</a> · ` : ''}
              ${t.canWait.unseen > 0 ? `${fmtNum(t.canWait.unseen)} non lu(s) peuvent attendre · ` : ''}
              Tout voir : <a href="#/replies">Réponses</a> · <a href="#/followups">Relances</a> ·
              <a href="#/deadlines">Dates</a> · <a href="#/tasks">Tâches</a></div>
          </div>
        </div>
        <div class="panel">
          <div class="panel-head"><h2>Échéances à venir</h2>
            <a class="btn btn-sm" href="#/deadlines">Gérer</a></div>
          <div class="panel-body tight" id="today-deadlines"><div class="empty"><span class="spinner"></span>Chargement…</div></div>
        </div>
      </div>
      <div>
        <div class="panel">
          <div class="panel-head"><h2>État du système</h2></div>
          <div class="panel-body" id="today-health"><div class="empty"><span class="spinner"></span></div></div>
        </div>
        <div class="panel">
          <div class="panel-head"><h2>Nettoyage proposé</h2></div>
          <div class="panel-body">
            ${t.noise.total ? `
              <div style="font-size:14px; margin-bottom:2px"><strong>${fmtNum(t.noise.total)} mails</strong> peuvent être nettoyés</div>
              <div class="muted" style="font-size:12.5px; margin-bottom:8px">Gain estimé : ${fmtSize(t.noise.sizeBytes)} —
                uniquement du bruit de plus de 7 jours, liste exacte avant toute action, corbeille récupérable ~30 j.</div>
              ${noiseLines}
              <div style="display:flex; gap:8px; margin-top:10px">
                <button class="btn btn-sm" id="noise-tour"
                  title="Passe les familles de bruit une par une : à chaque étape tu vois la liste exacte, tu vérifies, tu décides">Nettoyage guidé</button>
                <a class="btn btn-sm" href="#/cleanup">Examiner le lot</a>
              </div>`
              : '<div class="empty">Rien à nettoyer pour l’instant.</div>'}
          </div>
        </div>
        <div class="panel">
          <div class="panel-head"><h2>Activité récente</h2>
            <a class="btn btn-sm" href="#/operations">Historique</a></div>
          <div class="panel-body compact-ops" id="today-ops"><div class="empty"><span class="spinner"></span></div></div>
        </div>
      </div>
    </div>
    </details>`;

  // Le briefing d'abord : c'est LUI la page d'accueil. Les listes existent
  // toujours, mais repliées — on ne les ouvre que si on veut fouiller.
  renderBriefing(t, $('#today-brief'));
  bindTodayRows($('#today-body'));
  $('#today-body').querySelectorAll('.noise-btn').forEach((btn) => {
    btn.addEventListener('click', () => openNoiseModal(btn.dataset.bucket));
  });
  // Décision actée (confrontation ChatGPT 03/08) : le temps est une
  // INFORMATION, jamais une décision — plus de choix 5/15 min, la file est
  // triée par urgence et l'arrêt/reprise est libre.
  $('#todo-assist')?.addEventListener('click', () => startTodoAssistant(t));
  $('#noise-tour')?.addEventListener('click', () => startNoiseTour(t.noise.buckets));

  // ---- Compléments asynchrones (échéances à venir, santé, activité) ----
  todayFillWhatsNew();
  todayFillReview();
  todayFillRentila();
  todayFillDeadlines();
  todayFillHealth(syncedCount, totalAccounts);
  todayFillActivity();
}

// Carte « N nouveaux mails attendent une décision » (dépouillement, Lot 1).
async function todayFillReview() {
  const el = $('#today-review');
  if (!el) return;
  try {
    const s = await api.reviewSummary();
    if (!el.isConnected) return;
    if (s.total === 0) {
      el.innerHTML = `<div class="muted" style="font-size:13px; margin:0 0 14px">
        ✅ Ton courrier est dépouillé — aucun nouveau mail n'attend une décision.${s.laterCount ? ` ${fmtNum(s.laterCount)} gardé(s) « à lire plus tard ».` : ''}</div>`;
      return;
    }
    el.innerHTML = `<div class="ta-hero" style="margin-bottom:14px">
      <div><strong>📬 ${fmtNum(s.total)} nouveau(x) mail(s) attendent une décision</strong>
        <div class="muted" style="font-size:12.5px; margin-top:2px">
          ${s.important ? `${fmtNum(s.important)} demandent probablement une action · ` : ''}${s.read ? `${fmtNum(s.read)} méritent une lecture · ` : ''}${s.range ? `${fmtNum(s.range)} probablement rangeables d'un geste` : ''}</div></div>
      <button class="btn btn-primary" id="review-start"
        title="L'assistant te présente le courrier préparé : les importants un par un, le reste par lots homogènes — rien ne part sans ta décision">Dépouiller</button>
    </div>`;
    $('#review-start')?.addEventListener('click', () => startReviewFlow());
  } catch {
    if (el.isConnected) el.innerHTML = '';
  }
}

// Zone « 🆕 Quoi de neuf » (Vue du jour) : ce que l'app a APPRIS et déjà
// rattrapé toute seule (interne, réversible, journalisé). Une carte par
// nouveauté ; « OK » la fait disparaître définitivement — pas de centre de
// notifications qui s'empile.
async function todayFillWhatsNew() {
  const el = $('#today-whatsnew');
  if (!el) return;
  try {
    const { items } = await api.whatsNew();
    if (!el.isConnected || !items.length) { if (el.isConnected) el.innerHTML = ''; return; }
    // UNE nouveauté à la fois (10/08). Quatre bandeaux empilés au-dessus du
    // briefing, c'est exactement le bruit qu'on cherche à lui épargner : les
    // suivantes attendront qu'il ait vu celle-ci.
    const it = items[0];
    const reste = items.length - 1;
    el.innerHTML = `<div class="notice" style="margin-bottom:14px; display:flex; gap:12px; align-items:center; flex-wrap:wrap">
      <span>🆕 <strong>${esc(it.label)}.</strong> ${esc(it.summary)}
        ${reste > 0 ? `<span class="muted" style="font-size:12px">(+${fmtNum(reste)} autre${reste > 1 ? 's' : ''} nouveauté${reste > 1 ? 's' : ''})</span>` : ''}</span>
      <span style="margin-left:auto; display:flex; gap:8px">
        ${it.link ? `<a class="btn btn-sm" href="${esc(it.link)}">Voir</a>` : ''}
        <button class="btn btn-sm" data-wn-ok="${esc(it.id)}">OK</button>
      </span></div>`;
    el.querySelectorAll('[data-wn-ok]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        await api.whatsNewSeen(b.dataset.wnOk);
        b.closest('.notice')?.remove();
      } catch (err) { b.disabled = false; alert(err.message); }
    }));
  } catch {
    if (el.isConnected) el.innerHTML = '';
  }
}

// Connecteur Rentila phase 2 : préparer une COMMANDE depuis un mail. Le
// formulaire EST l'aperçu-confirmation ; l'exécution chez Rentila se fait par
// Claude (« exécute mes commandes Rentila ») qui rapporte le résultat ici.
function openRentilaCommandModal(item, bodyText = '') {
  closeModal();
  const amountMatch = `${item.subject ?? ''} ${bodyText ?? ''}`.match(/(\d{1,6}(?:[.,]\d{1,2})?)\s*(?:€|euros?\b|eur\b)/i);
  const amount = amountMatch ? amountMatch[1].replace(',', '.') : '';
  const today = new Date().toISOString().slice(0, 10);
  // Mail d'assurance Rentila : le bien est dans le sujet, et le bon geste est
  // un MESSAGE au locataire (via la messagerie Rentila) lui demandant de
  // téléverser son attestation en cours — onglet pré-sélectionné et rédigé.
  const insMatch = (item.subject ?? '').match(/^Assurance locataire expir(?:ée pour|e dans \d+ jours)\s*:?\s*(.+)$/i);
  const insProperty = insMatch ? insMatch[1].replace(/\s*\*\s*$/, '').trim() : '';
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal" style="width:580px">
    <div class="modal-head"><h2>🏠 Commande Rentila</h2><button class="modal-close" title="Fermer">✕</button></div>
    <div class="modal-body">
      <div class="muted" style="font-size:12.5px; margin-bottom:10px">Tu prépares et valides ici — rien ne part
        au-delà de ce que montre ce formulaire. L'exécution chez Rentila se fait ensuite en disant à Claude :
        « exécute mes commandes Rentila » ; le résultat s'affichera sur la Vue du jour et au 📜 Journal.</div>
      <div class="tabs" style="margin-bottom:10px">
        <button class="tab" data-rc-kind="mark_rent_paid">💶 Pointer un loyer payé</button>
        <button class="tab" data-rc-kind="send_tenant_message">✉️ Message au locataire</button>
        <button class="tab" data-rc-kind="create_task">☑️ Tâche Rentila</button>
      </div>
      <div id="rc-fields"></div>
      <div id="rc-error"></div>
    </div>
    <div class="modal-foot">
      <button class="btn" id="rc-cancel">Annuler</button>
      <button class="btn btn-primary" id="rc-save">✅ Valider la commande</button>
    </div></div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('.modal-close').addEventListener('click', closeModal);
  $('#rc-cancel').addEventListener('click', closeModal);

  let kind = insProperty ? 'send_tenant_message' : 'mark_rent_paid';
  const renderFields = () => {
    if (kind === 'mark_rent_paid') {
      $('#rc-fields').innerHTML = `<div class="compose-grid">
          <label>Locataire</label><input type="text" id="rc-tenant" value="${esc(item.fromName || '')}" placeholder="Nom tel que dans Rentila">
          <label>Montant (€)</label><input type="text" id="rc-amount" value="${esc(amount)}" placeholder="vide = le loyer complet">
          <label>Payé le</label><input type="date" id="rc-date" value="${today}">
          <label>Quittance</label><label style="display:flex; gap:6px; align-items:center; font-size:13px">
            <input type="checkbox" id="rc-receipt" checked> envoyer la quittance au locataire après pointage</label>
          <label>Note</label><input type="text" id="rc-note" placeholder="optionnel — contexte utile (période, précision…)">
        </div>`;
    } else if (kind === 'send_tenant_message') {
      const defaultBody = insProperty
        ? `Bonjour,\n\nVotre attestation d'assurance habitation pour le logement ${insProperty} est expirée (ou arrive à expiration).\n\nMerci de téléverser votre attestation en cours de validité dans votre espace locataire Rentila, rubrique « Documents ».\n\nCordialement`
        : 'Bonjour,\n\n\n\nCordialement';
      $('#rc-fields').innerHTML = `<div class="compose-grid">
          <label>Bien</label><input type="text" id="rc-property" value="${esc(insProperty)}"
            placeholder="ex : 101 1er droite T3 — le message ira aux locataires de son bail actif">
          <label>Ou locataire</label><input type="text" id="rc-tenant" value=""
            placeholder="si pas de bien : nom du locataire tel que dans Rentila">
          <label>Sujet</label><input type="text" id="rc-subject" value="${esc(insProperty ? 'Attestation d\'assurance habitation à mettre à jour' : (item.subject ?? ''))}">
          <label>Message</label><textarea id="rc-body" rows="8" style="resize:vertical">${esc(defaultBody)}</textarea>
        </div>
        <div class="muted" style="font-size:12px; margin-top:6px">Envoyé via la MESSAGERIE Rentila (le locataire est notifié par
          Rentila). Exactement ce texte — rien d'autre. En cas de doute sur le destinataire, rien ne part et tu es prévenu.</div>`;
    } else {
      $('#rc-fields').innerHTML = `<div class="compose-grid">
          <label>Titre</label><input type="text" id="rc-title" value="${esc(item.subject ?? '')}">
          <label>Échéance</label><input type="date" id="rc-due" value="">
          <label>Note</label><input type="text" id="rc-note" placeholder="optionnel">
        </div>`;
    }
  };
  overlay.querySelectorAll('[data-rc-kind]').forEach((x) => x.classList.toggle('active', x.dataset.rcKind === kind));
  overlay.querySelectorAll('[data-rc-kind]').forEach((b) => b.addEventListener('click', () => {
    kind = b.dataset.rcKind;
    overlay.querySelectorAll('[data-rc-kind]').forEach((x) => x.classList.toggle('active', x === b));
    renderFields();
  }));
  renderFields();

  $('#rc-save').addEventListener('click', async () => {
    const err = $('#rc-error');
    err.innerHTML = '';
    let payload;
    if (kind === 'mark_rent_paid') {
      const tenant = $('#rc-tenant').value.trim();
      if (!tenant) { err.innerHTML = '<div class="notice warn">Le nom du locataire est requis.</div>'; return; }
      const amt = $('#rc-amount').value.trim().replace(',', '.');
      payload = {
        kind,
        account: item.account,
        approved: true,
        label: `Pointer le loyer payé — ${tenant}${amt ? ` (${amt} €)` : ''}${$('#rc-receipt').checked ? ' + quittance' : ''}`,
        params: {
          tenantName: tenant,
          tenantEmail: item.fromEmail ?? null,
          amount: amt || null,
          paidDate: $('#rc-date').value || today,
          sendReceipt: $('#rc-receipt').checked,
          note: $('#rc-note').value.trim() || null,
          mailSubject: item.subject ?? null,
        },
      };
    } else if (kind === 'send_tenant_message') {
      const property = $('#rc-property').value.trim();
      const tenant = $('#rc-tenant').value.trim();
      const subject = $('#rc-subject').value.trim();
      const body = $('#rc-body').value.trim();
      if (!property && !tenant) { err.innerHTML = '<div class="notice warn">Indique le bien OU le locataire.</div>'; return; }
      if (!subject || !body) { err.innerHTML = '<div class="notice warn">Sujet et message sont requis.</div>'; return; }
      payload = {
        kind,
        account: item.account,
        approved: true,
        label: `Message Rentila — ${property || tenant} : ${subject}`,
        params: {
          property: property || null,
          tenantName: tenant || null,
          tenantEmail: null,
          subject,
          body,
          mailSubject: item.subject ?? null,
        },
      };
    } else {
      const title = $('#rc-title').value.trim();
      if (!title) { err.innerHTML = '<div class="notice warn">Le titre est requis.</div>'; return; }
      payload = {
        kind,
        account: item.account,
        approved: true,
        label: `Tâche Rentila — ${title}`,
        params: {
          title,
          dueDate: $('#rc-due').value || null,
          note: $('#rc-note').value.trim() || null,
          mailSubject: item.subject ?? null,
        },
      };
    }
    const btn = $('#rc-save');
    btn.disabled = true;
    try {
      await api.rentilaCommandCreate(payload);
      overlay.querySelector('.modal-body').innerHTML = `<div class="notice">✅ Commande validée :
        <strong>${esc(payload.label)}</strong>.<br>
        Pour l'exécuter maintenant : ouvre Claude et dis <strong>« exécute mes commandes Rentila »</strong>.
        Le résultat s'affichera sur la Vue du jour (Gestion locative) et dans le 📜 Journal.</div>`;
      overlay.querySelector('.modal-foot').innerHTML = '<button class="btn btn-primary" id="rc-done">Fermer</button>';
      overlay.querySelector('#rc-done').addEventListener('click', closeModal);
    } catch (e2) {
      btn.disabled = false;
      err.innerHTML = `<div class="notice warn">⚠️ ${esc(e2.message)}</div>`;
    }
  });
}

// Carte « 🏠 Gestion locative » (connecteur Rentila, phase 1) : ce que Rentila
// attend de toi — invisible si aucune activité Rentila récente (les autres
// boîtes ne voient rien changer).
let rentilaMsgRefs = [];
async function todayFillRentila() {
  const el = $('#today-rentila');
  if (!el) return;
  try {
    const [o, cmds] = await Promise.all([
      api.rentilaOverview(),
      api.rentilaCommands().catch(() => ({ items: [], counts: { proposed: 0, approved: 0, failed: 0 } })),
    ]);
    if (!el.isConnected) return;
    const bits = [];
    const expired = o.insurance.filter((i) => i.expired);
    const expiring = o.insurance.filter((i) => !i.expired);
    if (expired.length) {
      bits.push(`<span title="${esc(expired.map((i) => i.property).join(', '))}">🛡️ <strong>${fmtNum(expired.length)}</strong> assurance(s) locataire <span style="color:var(--red)">expirée(s)</span></span>`);
    }
    if (expiring.length) {
      bits.push(`<span title="${esc(expiring.map((i) => i.property).join(', '))}">🛡️ ${fmtNum(expiring.length)} assurance(s) à renouveler bientôt</span>`);
    }
    if (o.rentLateAt) bits.push(`<span>💶 loyers en retard signalés le ${fmtDate(o.rentLateAt)}</span>`);
    if (o.tenantMessages.length) bits.push(`<span>💬 <strong>${fmtNum(o.tenantMessages.length)}</strong> message(s) locataire à traiter</span>`);
    // Commandes Rentila (phase 2) : validées en attente d'exécution par Claude.
    if (cmds.counts.approved) {
      bits.push(`<span title="Ouvre Claude et dis : « exécute mes commandes Rentila »">⚙️ <strong>${fmtNum(cmds.counts.approved)}</strong> commande(s) validée(s) — à faire exécuter par Claude</span>`);
    }
    if (cmds.counts.failed) {
      bits.push(`<span style="color:var(--red)" title="Détail dans le 📜 Journal d'activité">⚠️ ${fmtNum(cmds.counts.failed)} commande(s) en échec</span>`);
    }
    if (!bits.length && !o.deadlines.length) { el.innerHTML = ''; return; }

    rentilaMsgRefs = o.tenantMessages;
    el.innerHTML = `<div class="panel" style="margin-bottom:14px"><div class="panel-body" style="padding:10px 14px">
      <div style="display:flex; align-items:center; gap:14px; flex-wrap:wrap; font-size:13px">
        <strong>🏠 Gestion locative</strong>
        ${bits.join('<span class="muted">·</span>')}
        <a class="btn btn-sm" href="#/deadlines" style="margin-left:auto">📅 Voir les échéances</a>
      </div>
      ${o.tenantMessages.length ? `<div style="margin-top:6px; font-size:12.5px" class="muted">
        ${o.tenantMessages.map((m, k) => `<span class="openable" data-rentila-msg="${k}">« ${esc(m.subject)} »</span>`).join(' · ')}
      </div>` : ''}
    </div></div>`;
    el.querySelectorAll('[data-rentila-msg]').forEach((sp) => sp.addEventListener('click', () => {
      const m = rentilaMsgRefs[Number(sp.dataset.rentilaMsg)];
      if (m) openReaderFor(m, {});
    }));
  } catch {
    if (el.isConnected) el.innerHTML = '';
  }
}

/** Références des échéances « à venir » (ouvrir le mail d'origine au clic). */
let todayDlRefs = [];

async function todayFillDeadlines() {
  const el = $('#today-deadlines');
  if (!el) return;
  try {
    const d = await api.deadlines();
    if (!el.isConnected) return;
    todayDlRefs = [];
    const upcoming = d.items
      .filter((x) => (x.status === 'proposed' || x.status === 'confirmed') && x.inDays > 0 && x.inDays <= 30)
      .sort((a, b) => new Date(a.date) - new Date(b.date))
      .slice(0, 8);
    if (!upcoming.length) {
      el.innerHTML = '<div class="empty">Rien dans les 30 prochains jours.</div>';
      return;
    }
    el.innerHTML = `<table>
      <thead><tr><th style="width:110px">Date</th><th>Objet</th><th style="width:80px">Compte</th><th style="width:110px">Statut</th></tr></thead>
      <tbody>${upcoming.map((x) => {
        const canOpen = x.folder && x.uid != null;
        const idx = canOpen
          ? todayDlRefs.push({ account: x.account, folder: x.folder, uid: x.uid, subject: x.subject ?? x.title, fromName: x.fromName, fromEmail: x.fromEmail, date: x.msgDate ?? x.date, isSeen: x.isSeen ?? true }) - 1
          : -1;
        return `<tr class="${canOpen ? 'row-click' : ''}" ${idx >= 0 ? `data-dl-open="${idx}"` : ''}>
          <td style="white-space:nowrap">${fmtDate(x.date)}</td>
          <td>${esc(x.title)}</td>
          <td>${accountChip(x.account)}</td>
          <td>${x.status === 'proposed' ? '<span class="badge orange">à confirmer</span>' : '<span class="badge blue">confirmée</span>'}</td>
        </tr>`;
      }).join('')}</tbody></table>`;
    el.querySelectorAll('[data-dl-open]').forEach((row) => {
      row.addEventListener('click', () => {
        const item = todayDlRefs[Number(row.dataset.dlOpen)];
        if (item) openReaderFor(item, {});
      });
    });
  } catch {
    if (el.isConnected) el.innerHTML = '<div class="empty">Échéances indisponibles.</div>';
  }
}

async function todayFillHealth(syncedCount, totalAccounts) {
  const el = $('#today-health');
  if (!el) return;
  const line = (label, value) => `<div class="set-line"><span class="muted">${label}</span><span>${value}</span></div>`;
  try {
    const h = await api.health();
    if (!el.isConnected) return;
    const ov = overviewCache;
    const lastSync = ov ? ov.accounts.reduce((m, a) => {
      const ts = a.lastSyncAt ? new Date(a.lastSyncAt).getTime() : 0;
      return ts > m ? ts : m;
    }, 0) : 0;
    const issues = h.accounts?.filter((a) => a.level !== 'ok') ?? [];
    const auto = serverVersion?.autoSync;
    const status = h.level === 'ok'
      ? '<span><span class="status-dot ok"></span>Opérationnelle</span>'
      : h.level === 'error'
        ? '<span style="color:var(--danger)"><span class="status-dot err"></span>Erreur</span>'
        : '<span style="color:var(--warning)"><span class="status-dot warn"></span>Attention</span>';
    el.innerHTML = `
      ${line('Synchronisation', status)}
      ${line('Comptes synchronisés', `${fmtNum(syncedCount)}/${fmtNum(totalAccounts)}`)}
      ${lastSync ? line('Dernier passage', new Date(lastSync).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })) : ''}
      ${line('Problèmes détectés', issues.length ? `<span style="color:var(--danger)">${fmtNum(issues.length)}</span>` : '0')}
      ${auto?.intervalMinutes ? line('Prochain passage', auto.nextRunAt ? new Date(auto.nextRunAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : `toutes les ${fmtNum(auto.intervalMinutes)} min`) : line('Passage automatique', 'à la demande')}
      ${issues.length ? `<div class="muted" style="font-size:12px; margin-top:6px">${issues.map((a) => `<strong>${esc(a.account)}</strong> : ${esc(a.message)}`).join('<br>')}</div>` : ''}
      <div style="margin-top:8px"><a class="btn btn-sm" href="#/dashboard">Voir le détail</a></div>`;
  } catch {
    if (el.isConnected) el.innerHTML = '<div class="empty">État indisponible.</div>';
  }
}

async function todayFillActivity() {
  const el = $('#today-ops');
  if (!el) return;
  try {
    const { operations } = await api.operations(5);
    if (!el.isConnected) return;
    // Les libellés du journal portent encore des emojis (héritage) : on les
    // neutralise sur la Vue du jour, sobre par design.
    el.innerHTML = operations.length
      ? groupOps(operations).map(opLine).join('').replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
      : '<div class="empty">Aucune opération pour l’instant.</div>';
  } catch {
    if (el.isConnected) el.innerHTML = '<div class="empty">Journal indisponible.</div>';
  }
}


// ---------------------------------------------------------------- Mode « Traiter »
// Demande utilisateur 02/08 : passer de « je t'affiche plein de choses » à
// « je t'assiste ». L'assistant présente chaque action UNE PAR UNE avec les
// bons boutons selon sa nature — répondre / reporter / confirmer / classer —
// au lieu de laisser l'utilisateur naviguer dans des listes.
// ---------------------------------------------------------------- Briefing
// « Je me suis occupé de tes mails, j'ai besoin de toi sur trois choses. »
//
// Retour utilisateur 10/08 : « je me retrouve avec des listes et des boutons,
// un truc de 1990 avec un opérateur de saisie ». Le défaut n'était pas le
// style : c'était le MODÈLE. Un tableau de N lignes × 5 boutons transforme
// chaque détection en tâche de vérification — un gestionnaire de workflow,
// pas un assistant. Ici : au plus 3 décisions visibles, UNE action
// recommandée par carte, la raison écrite en français à côté de la décision,
// et tout le reste résumé en une ligne.

/** Phrase qui explique POURQUOI ce mail est devant lui. Aucune IA appelée : on
 *  réutilise ce qui est déjà en base (résumé, montant, échéance, ancienneté). */
/**
 * Quand ce mail est-il arrivé ? (25/08) — « la date du mail et son heure dans
 * "Aujourd'hui" serait bien aussi, car au moins sans cliquer dessus je pourrais
 * savoir s'il est récent ou pas ».
 *
 * On donne les deux : la fraîcheur d'un coup d'œil (« il y a 2 h ») et la date
 * exacte à côté, parce qu'« il y a 3 jours » ne dit pas si c'était un vendredi
 * soir ou un lundi matin. Une affaire n'a pas de mail : elle n'a pas de date
 * d'arrivée à montrer.
 */
function dateDeLaCarte(c) {
  if (c.kind === 'engagement') return '';
  const iso = c.x.msgDate ?? c.x.date ?? null;
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const h = (Date.now() - t) / 3600000;
  const frais =
    h < 1 ? "à l'instant"
    : h < 24 ? `il y a ${Math.round(h)} h`
    : h < 48 ? 'hier'
    : h < 24 * 7 ? `il y a ${Math.round(h / 24)} jours`
    : null;
  return `<span class="brief-when" title="${esc(fmtDateTime(iso))}">${
    frais ? `<strong>${esc(frais)}</strong> · ` : ''}${esc(fmtDateTime(iso))}</span>`;
}

function briefWhy({ kind, x }) {
  if (kind === 'engagement') {
    const paye = x.amountPaid != null ? `, ${fmtNum(x.amountPaid)} € déjà réglés` : '';
    return `Engagée il y a ${fmtNum(x.joursOuvert)} jours${paye}, et rien ne prouve que ce soit fait.`;
  }
  if (kind === 'invoice') {
    const somme = x.amount ? `${fmtNum(x.amount)} €` : 'un montant';
    return x.dueDate
      ? `La facture indique ${somme} à régler avant le ${fmtDate(x.dueDate)}, et je n'ai trouvé aucun paiement.`
      : 'Ce mail porte une facture, et je n\'ai trouvé aucun paiement correspondant.';
  }
  if (kind === 'reply') {
    const qui = x.fromName || x.fromEmail || 'Ton correspondant';
    return `${esc(qui)} t'a écrit ${daysAgo(x.waitingHours)} et aucune réponse de ta part n'apparaît depuis.`;
  }
  if (kind === 'followup') {
    const qui = x.counterpartyName || x.counterpartyEmail || 'ton correspondant';
    return `Tu as écrit à ${esc(qui)} ${daysAgo(x.waitingHours)} et personne n'a répondu.`;
  }
  // Échéance : la date et ce qu'elle engage — en français, pas en jargon.
  // La « raison » stockée est de la plomberie (« le sujet mentionne … suivi
  // d'une date · extrait : … ») : elle n'a rien à faire devant lui.
  // Tournures choisies pour éviter tout accord bancal (« un renouvellement
  // était attendue ») : le sujet des phrases reste neutre.
  const quoi = {
    payment: 'Un paiement est attendu',
    document: 'Un document est à fournir',
    appointment: 'Un rendez-vous est prévu',
    renewal: 'Un renouvellement est à faire',
  }[x.type] ?? 'Quelque chose est attendu';
  const quand = x.inDays < 0
    ? `pour le ${fmtDate(x.date)} — ${fmtNum(-x.inDays)} jour${x.inDays < -1 ? 's' : ''} de retard`
    : x.inDays === 0 ? 'pour aujourd\'hui'
    : x.inDays === 1 ? 'pour demain'
    : `pour le ${fmtDate(x.date)}, dans ${fmtNum(x.inDays)} jours`;
  return `${quoi} ${quand}. D'après un mail de ${esc(x.fromName || x.fromEmail || 'cet expéditeur')}.`;
}

/**
 * RANG D'UN CANDIDAT — clé de tri lexicographique, du plus prioritaire au
 * moins. Remplace le score additif du 17/08 et avant (colère utilisateur du
 * 17/08 : trois publicités présentées comme « les 3 choses qui méritent ton
 * attention », pendant qu'une mise en demeure URSSAF de 418 € reçue 4 jours
 * plus tôt n'apparaissait pas).
 *
 * POURQUOI PAS UN SCORE. L'ancien calcul faisait 50 (réponse attendue) + 50
 * (seuil dépassé) + jusqu'à 10 (ancienneté). MESURÉ sur la production :
 * 8 candidats sur 8 obtenaient exactement 110 — le tri ne discriminait donc
 * plus rien et l'ordre final était l'ordre d'insertion. Pire, les paiements
 * valaient une constante (60) et perdaient TOUJOURS. Des dimensions
 * incomparables ne s'additionnent pas : une classe inférieure ne doit jamais
 * pouvoir rattraper une classe supérieure en vieillissant.
 *
 * L'ANCIENNETÉ EST PIÉGEUSE et arrive donc en dernier, par tranches : elle
 * mesure le temps écoulé, pas le besoin d'agir. Plus une présomption est
 * vieille, plus il est probable qu'elle soit fausse (sujet clos ailleurs,
 * offre périmée, message jamais destiné à recevoir une réponse).
 */
function rangCandidat({ kind, x }) {
  const JOUR = 86_400_000;
  const jours = (d) => (d ? (new Date(d).getTime() - Date.now()) / JOUR : null);

  // Échéance applicable : la date qui OBLIGE à agir.
  const dueJours = kind === 'deadline' ? jours(x.date) : kind === 'invoice' ? jours(x.dueAt) : null;
  const enRetard = kind === 'invoice' ? !!x.enRetard : dueJours !== null && dueJours < 0;
  const dateProche = dueJours !== null && dueJours <= 14;
  // Corroboration : un fait supplémentaire qui CONFIRME l'obligation. Elle
  // promeut ; son absence n'efface jamais une obligation explicite.
  const corrobore = kind === 'invoice' ? x.montant != null || x.dueAt != null : dueJours !== null;

  let classe;
  if ((kind === 'invoice' || kind === 'deadline') && (enRetard || dateProche)) {
    classe = 0; // obligation datée, dépassée ou imminente — le risque concret
  } else if (kind === 'invoice' && !corrobore) {
    classe = 1; // obligation réelle dont la date n'a pas été extraite : « date
                // inconnue » ne veut pas dire « pas urgent »
  } else if (kind === 'engagement') {
    // AFFAIRE EN SOUFFRANCE (18/08). Engagement PROUVÉ (il l'a saisi, ou un
    // fait analysé l'a ouvert) dont la date de vérification est passée sans
    // preuve d'aboutissement. Au niveau des demandes explicites : c'est établi,
    // mais ce n'est pas une obligation datée. Ne peut donc pas évincer une
    // échéance dépassée, et ne dépend d'aucun mail récent — c'est tout l'objet.
    classe = 2;
  } else if (kind === 'reply' && x.preuve === 'verdict') {
    classe = 2; // une réponse EXPLICITEMENT demandée, établie par l'analyse
  } else if (kind === 'followup') {
    classe = 3; // il attend quelqu'un
  } else if (kind === 'invoice' || kind === 'deadline') {
    classe = 4; // obligation datée lointaine : elle existe, pas pour aujourd'hui
  } else {
    classe = 5; // PRÉSOMPTION de structure (dernier entrant sans réponse) :
                // ne prend une carte que s'il ne reste aucun fait établi
  }

  // Départages, dans l'ordre : échéance la plus contraignante, puis
  // corroboration, puis ancienneté en TRANCHES (jamais linéaire).
  const bucketEcheance =
    dueJours === null ? 5 : dueJours < 0 ? 0 : dueJours <= 3 ? 1 : dueJours <= 7 ? 2 : dueJours <= 14 ? 3 : 4;
  // Pour une affaire, « l'attente » est l'ancienneté de l'engagement : une
  // formalité confiée il y a un an doit passer devant une engagée la semaine
  // dernière, dans la même classe.
  if (kind === 'engagement') {
    const j = x.joursOuvert ?? 0;
    return [classe, bucketEcheance, corrobore ? 0 : 1, j > 180 ? 0 : j > 60 ? 1 : j > 14 ? 2 : 3];
  }
  const jAttente = (x.waitingHours ?? 0) / 24;
  const trancheAge = jAttente > 30 ? 0 : jAttente > 7 ? 1 : jAttente > 2 ? 2 : 3;
  return [classe, bucketEcheance, corrobore ? 0 : 1, trancheAge];
}

/** Compare deux rangs lexicographiquement (le plus petit passe devant). */
function comparerRangs(a, b) {
  const ra = rangCandidat(a);
  const rb = rangCandidat(b);
  for (let i = 0; i < ra.length; i += 1) {
    if (ra[i] !== rb[i]) return ra[i] - rb[i];
  }
  return 0;
}

/**
 * DÉDOUBLONNAGE des candidats — à appliquer APRÈS le tri, pour garder de
 * chaque groupe le représentant le mieux classé. Deux lignes en base qui
 * désignent la même chose pour lui (deux relances du même impayé, deux fois
 * la même échéance) ne font qu'UNE décision à prendre ; les montrer deux fois
 * donne l'impression d'un système qui radote (constaté 10/08, étendu aux
 * paiements le 18/08).
 */
function dedoublonnerCandidats(liste) {
  const vus = new Set();
  return liste.filter((c) => {
    const cle = c.kind === 'deadline'
      ? `d|${c.x.title}|${String(c.x.date).slice(0, 10)}`
      : c.kind === 'engagement'
        // Une affaire est identifiée par son id. Sans ce cas, elles tombaient
        // toutes sur la même clé de paiement (`i|undefined|undefined|…`) et se
        // seraient dédoublonnées les unes les autres jusqu'à n'en laisser qu'une.
        ? `e|${c.x.id}`
        : c.kind === 'reply' || c.kind === 'followup'
          ? `${c.kind}|${c.x.threadId ?? c.x.uid}`
          : `i|${c.x.account}|${c.x.fromEmail ?? ''}|${c.x.subject ?? ''}`;
    if (vus.has(cle)) return false;
    vus.add(cle);
    return true;
  });
}

/**
 * Construit et affiche le briefing. `t` = la réponse de /today.
 * Règle de conception (test à s'appliquer à chaque ajout) : est-ce que ceci
 * demande à Anthony de GÉRER ses mails, ou est-ce que ça lui ÉVITE de les
 * gérer ? Si c'est le premier, ça ne va pas sur cet écran.
 */
function renderBriefing(t, el) {
  if (!el) return;
  const brut = [
    ...t.todo.replies.map((x) => ({ kind: 'reply', x })),
    ...t.todo.invoices.map((x) => ({ kind: 'invoice', x })),
    ...t.todo.deadlines.map((x) => ({ kind: 'deadline', x })),
    ...t.todo.followups.map((x) => ({ kind: 'followup', x })),
    // Les affaires en souffrance : elles n'ont ni mail récent ni échéance,
    // c'est exactement pour cela qu'elles doivent pouvoir prendre une carte.
    ...(t.todo.engagements ?? []).map((x) => ({ kind: 'engagement', x })),
  ].sort(comparerRangs);

  const queue = dedoublonnerCandidats(brut);

  // TROIS décisions visibles, pas dix-sept. Le reste existe, mais plus tard.
  const MAX = 3;
  const cartes = queue.slice(0, MAX);
  // Gardées pour la navigation Précédent/Suivant du lecteur : la série est
  // celle des cartes AFFICHÉES, dans leur ordre à l'écran.
  _cartesDuJour = cartes;
  const reste = queue.length - cartes.length;
  const heure = new Date().getHours();
  const salut = heure < 18 ? 'Bonjour' : 'Bonsoir';

  // « Je me suis occupé du reste » : ce qui n'a PAS demandé son attention.
  const traites = (t.canWait?.count ?? 0) + (t.noise?.total ?? 0);
  const v = t.veille ?? null;

  const carteHtml = (c, i) => {
    const a = briefAction(c);
    const more = briefMore(c);
    return `<div class="brief-card" data-card="${i}">
      <div class="brief-head">
        <div class="brief-title">${briefTitle(c)}</div>
        ${dateDeLaCarte(c)}
        ${accountChip(c.x.account ?? c.x.accountSlug)}
      </div>
      <div class="brief-why">${briefWhy(c)}</div>
      <div class="brief-foot">
        ${c.kind === 'engagement'
          ? `<a class="brief-open" href="#/affaires">Voir l'affaire</a>`
          : peutOuvrirLeMail(c)
            ? `<span class="brief-open" data-open="${i}">Voir le mail</span>`
            : ''}
        <span style="margin-left:auto; display:flex; gap:6px; align-items:center">
          ${more.length ? `<button class="btn btn-sm brief-more" data-more="${i}" title="Autres possibilités">⋯</button>` : ''}
          <button class="btn btn-primary btn-sm brief-do" data-do="${i}">${a.label}</button>
        </span>
      </div>
      ${more.length ? `<div class="brief-menu hidden" data-menu="${i}">
        ${more.map(([label], k) => `<button class="btn btn-sm" data-more-do="${i}:${k}">${esc(label)}</button>`).join('')}
      </div>` : ''}
    </div>`;
  };

  el.innerHTML = `
    <div class="brief">
      <div class="brief-hello">${salut} Anthony.</div>
      <!--
        ⚠️ « N CHOSES MÉRITENT TON ATTENTION » A ÉTÉ RETIRÉ (27/08).
        C'était mot pour mot la phrase de la capture du 18/08 : elle coiffait
        une offre d'anniversaire de location de voiture, une promo de
        téléphone et une notification Airbnb — pendant qu'une mise en demeure
        URSSAF de 418 €, correctement analysée, était absente de l'écran.
        Son mot : « qu'est-ce que c'est que ton analyse de merde ? ». Le tri
        en dessous a été refait dès le lendemain ; la PROMESSE affichée, elle,
        était restée intacte.
        Une phrase qui promet de trier ne vaut que ce que vaut le tri. On
        annonce donc ce qu'on a fait, pas ce qu'on prétend valoir.
      -->
      <div class="brief-lead">${cartes.length === 0
        ? 'Rien ne réclame ton attention aujourd\'hui.'
        : `Voici ce dont je m'occuperais <strong>aujourd'hui</strong>.`}</div>
      ${cartes.map(carteHtml).join('')}
      ${traites > 0 ? `<div class="brief-done">✓ Je me suis occupé de <strong>${fmtNum(traites)}</strong> autres mails sans avoir besoin de toi
        <a href="#/operations" class="muted">voir ce que j'ai fait</a></div>` : ''}
      <!--
        LE SILENCE DOIT ÊTRE AUDITABLE. C'est la contrepartie d'un écran qui
        décide seul : « un système bavard et mauvais énerve, un système
        silencieux et mauvais cache des problèmes ». Un écran à trois cartes
        peut sembler spectaculairement meilleur alors qu'il a seulement enterré
        davantage de choses.
        Ces quatre nombres sont donc permanents, et le détail consultable en un
        clic — sa demande du 26/08 : une ligne, le détail sur demande.
      -->
      ${v ? `<div class="brief-veille">
        <span>${fmtNum(v.mailsSuivis)} mails suivis</span>
        <span>${fmtNum(v.dossiersOuverts)} dossier${v.dossiersOuverts > 1 ? 's' : ''} ouvert${v.dossiersOuverts > 1 ? 's' : ''}</span>
        <span>${fmtNum(Math.max(0, v.dossiersOuverts - cartes.length))} peuvent attendre</span>
        <span class="brief-veille-fort">${fmtNum(cartes.length)} aujourd'hui</span>
        <a href="#/suivi">voir</a>
      </div>` : ''}
      ${reste > 0 ? `<div class="brief-rest"><button class="btn btn-sm" id="brief-more-all">Voir les ${fmtNum(reste)} autres</button></div>` : ''}
    </div>`;

  const refresh = () => renderToday();
  // Une action = la carte disparaît, un bandeau « Fait · Annuler » apparaît.
  // Pas de confirmation : tout est réversible et journalisé (c'est justement
  // ce qui permet de supprimer les questions).
  /**
   * ⚠️ LE BANDEAU N'AVAIT PAS DE BOUTON. Le commentaire ci-dessus promettait
   * « Fait · Annuler » depuis des semaines, et l'appel passait `null` comme
   * `onUndo` — donc aucun bouton. Le mécanisme existait (`showUndoToast`, 10 s
   * de décompte), il n'était simplement pas câblé. C'est pourtant lui qui rend
   * le renversement acceptable : on peut décider à sa place PARCE QU'il peut
   * défaire en un geste.
   */
  const agir = async (c, label, fn, node, undo) => {
    node.style.opacity = '0.4';
    try {
      const resultat = await fn();
      node.remove();
      showUndoToast(
        `${label}.`,
        undo ? async () => { await undo(resultat); renderToday(); } : null,
      );
      const restants = el.querySelectorAll('.brief-card').length;
      const lead = el.querySelector('.brief-lead');
      if (lead) {
        lead.innerHTML = restants === 0
          ? 'Plus rien ne demande ton attention. ✅'
          : `<strong>${fmtNum(restants)} chose${restants > 1 ? 's méritent' : ' mérite'} encore ton attention.</strong>`;
      }
    } catch (err) {
      node.style.opacity = '1';
      alert(err.message);
    }
  };

  el.querySelectorAll('[data-do]').forEach((btn) => btn.addEventListener('click', () => {
    const c = cartes[Number(btn.dataset.do)];
    const a = briefAction(c);
    const node = btn.closest('.brief-card');
    if (a.open) { openBriefReader(c); return; }
    // Une affaire n'a pas de mail à ouvrir : son geste est le brouillon de
    // relance. La carte reste en place — rédiger n'est pas avoir traité.
    if (a.affaire) {
      api.brouillonRelance(a.affaire)
        .then((br) => modaleBrouillon(br, c.x))
        .catch((err) => alert(err.message));
      return;
    }
    agir(c, a.annonce ?? a.label.replace(/^[^\s]+\s/, ''), a.run, node, a.undo);
  }));
  el.querySelectorAll('[data-open]').forEach((s) => s.addEventListener('click', () => {
    openBriefReader(cartes[Number(s.dataset.open)]);
  }));
  el.querySelectorAll('[data-more]').forEach((b) => b.addEventListener('click', () => {
    el.querySelector(`[data-menu="${b.dataset.more}"]`)?.classList.toggle('hidden');
  }));
  el.querySelectorAll('[data-more-do]').forEach((b) => b.addEventListener('click', () => {
    const [i, k] = b.dataset.moreDo.split(':').map(Number);
    const c = cartes[i];
    const [label, fn] = briefMore(c)[k];
    agir(c, label, fn, b.closest('.brief-card'));
  }));
  $('#brief-more-all')?.addEventListener('click', () => startTodoAssistant(t));
  void refresh;
}

/** Ouvre le mail d'une carte dans le lecteur (le geste « Voir le mail »). */
/**
 * Y a-t-il un mail à ouvrir derrière cette carte ? (18/08)
 *
 * Une échéance survit à son mail : Anthony avait mis « Votre facture Freebox »
 * à la corbeille, l'échéance est restée, et le lien « Voir le mail » ouvrait
 * une alerte « Le mail d'origine n'est plus dans l'index ». Un lien qui ne
 * peut QUE échouer ne doit pas être affiché — on ne propose pas un geste pour
 * s'excuser ensuite de ne pas pouvoir le rendre.
 */
function peutOuvrirLeMail(c) {
  const x = c.x;
  if (c.kind === 'engagement') return false;
  return !!(x.account && x.folder && x.uid);
}

/** La référence lisible derrière une carte (le mail, pas la décision). */
function refDeLaCarte(c) {
  const x = c.x;
  if (!peutOuvrirLeMail(c)) return null;
  return c.kind === 'deadline'
    ? { account: x.account, folder: x.folder, uid: x.uid, subject: x.subject ?? x.title, fromName: x.fromName, fromEmail: x.fromEmail, date: x.msgDate, isSeen: true }
    : { account: x.account, folder: x.folder, uid: x.uid, subject: x.subject, fromName: x.fromName ?? null, fromEmail: x.fromEmail ?? '', date: x.date, isSeen: x.isSeen ?? true };
}

/** Les cartes ACTUELLEMENT à l'écran qui ont un mail — la série de la Vue du jour. */
let _cartesDuJour = [];

function openBriefReader(c) {
  const ref = refDeLaCarte(c);
  if (!ref) return;
  // Ancré à droite quand l'écran le permet : les cartes restent visibles et
  // cliquables, il enchaîne d'un mail à l'autre sans fermer.
  const dock = $('#today-dock');
  const refs = _cartesDuJour.map(refDeLaCarte).filter(Boolean);
  const i = refs.findIndex((r) => r.account === ref.account && r.folder === ref.folder && r.uid === ref.uid);
  openReaderFor(ref, {
    dock: dock && dock.isConnected && window.innerWidth > 1100 ? dock : null,
    serie: { refs, index: Math.max(0, i) },
    onRemoved: () => renderToday(),
    onReplied: () => renderToday(),
  });
}

/** Le titre de la carte : qui, et ce qu'on attend de lui — pas un objet de mail. */
function briefTitle({ kind, x }) {
  if (kind === 'engagement') return `${esc(x.label)} — toujours pas abouti`;
  if (kind === 'invoice') return `${esc(x.fromName || x.fromEmail || 'Facture')} — à régler`;
  if (kind === 'reply') return `${esc(x.fromName || x.fromEmail || '?')} attend ta réponse`;
  if (kind === 'followup') return `${esc(x.counterpartyName || x.counterpartyEmail || '?')} ne t'a pas répondu`;
  return esc(x.title ?? 'Échéance');
}

/** L'UNIQUE action recommandée. Le reste passe derrière le menu « ⋯ ». */
/**
 * L'ACTION UNIQUE D'UNE CARTE — et son annulation.
 *
 * ⚠️ CE QUI A CHANGÉ, ET POURQUOI. Ces libellés étaient des QUESTIONS :
 * « C'est réglé ? », « C'est noté ? », « C'est fait ? », « Plus besoin ? ».
 * Quatre boutons « Valider » déguisés, alors que le plan du 10/08 prescrivait
 * l'inverse : « voilà ce que j'ai fait — interviens seulement si c'est faux ».
 * Son retour du 26/08 : « je veux valider ou non UNE DÉCISION QUE TU AURAS
 * DÉJÀ PRISE ».
 *
 * Chaque action porte donc son `undo`, la closure inverse passée au bandeau.
 * Les routes existaient déjà (`followupRestore`, `deadlineAction('restore')`)
 * et n'étaient appelées de nulle part ici.
 *
 * ⚠️ « JE L'AI PAYÉE » N'EST PAS UN LIBELLÉ, C'EST UN FAIT. L'ancien bouton
 * exécutait `messageAction('seen')` : il marquait le mail LU en laissant croire
 * qu'un paiement était enregistré. Il écrit désormais une `Declaration` — un
 * état du monde, déclaré par lui, réversible si un mail le contredit.
 */
function briefAction({ kind, x }) {
  // L'affaire n'a pas de mail à ouvrir : son geste utile est le brouillon.
  if (kind === 'engagement') return { label: '✉️ Relancer', affaire: x.id };
  if (kind === 'invoice') {
    return {
      label: '✓ Je l\'ai payée',
      annonce: 'Noté comme payée',
      run: () => api.declarer({ messageId: x.messageId, kind: 'pay' }),
      undo: (r) => api.declarationAnnuler(r?.id),
    };
  }
  if (kind === 'reply') return { label: '↩️ Répondre', open: true };
  if (kind === 'followup') {
    return {
      label: 'Je ne te le remontre plus',
      annonce: 'Je ne te le remontre plus',
      run: () => api.followupDismiss(x.account, x.threadId),
      undo: () => api.followupRestore(x.account, x.threadId),
    };
  }
  if (x.status === 'proposed') {
    return {
      label: 'J\'ai noté l\'échéance',
      annonce: 'Échéance notée',
      run: () => api.deadlineAction(x.account, x.id, 'confirm'),
      undo: () => api.deadlineAction(x.account, x.id, 'restore'),
    };
  }
  return {
    label: 'Je la marque faite',
    annonce: 'Marquée faite',
    run: () => api.deadlineAction(x.account, x.id, 'done'),
    undo: () => api.deadlineAction(x.account, x.id, 'restore'),
  };
}


/** Les autres gestes possibles, discrets — 90 % du temps jamais ouverts. */
function briefMore({ kind, x }) {
  const m = [];
  if (kind === 'reply') {
    m.push(['Pas de réponse à faire', () => api.replyDismiss(x.account, x.threadId)]);
    m.push(['Me le rappeler dans 3 jours', () => api.replySnooze(x.account, x.threadId, 3)]);
  } else if (kind === 'followup') {
    m.push(['Me le rappeler dans 3 jours', () => api.followupSnooze(x.account, x.threadId, 3)]);
  } else if (kind === 'deadline' && x.status === 'proposed') {
    m.push(['Ce n\'est pas une échéance', () => api.deadlineAction(x.account, x.id, 'dismiss')]);
  } else if (kind === 'engagement') {
    m.push(['C’est fait', () => api.engagementClore(x.id)]);
    m.push(['Revoir dans 30 jours', () => api.engagementReporter(x.id, 30)]);
  } else if (kind === 'invoice') {
    m.push(['En faire une tâche', () => api.taskCreate({ title: `Payer : ${x.subject}`, account: x.account, messageRef: { folder: x.folder, uid: x.uid } })]);
  }
  return m;
}

// Coût estimé d'une action, en minutes — MÊME barème partout (accueil et
// parcours), pour ne jamais afficher deux durées contradictoires. Répondre
// coûte plus qu'écarter une échéance : le barème le dit.
function todoMinutes({ kind }) {
  if (kind === 'reply') return 2;
  if (kind === 'followup') return 1.5;
  if (kind === 'invoice') return 1.5;
  return 1; // deadline : confirmer ou écarter
}

/**
 * Estimation affichée sur la Vue du jour. Elle porte sur ce que « Commencer »
 * traitera VRAIMENT : les listes sont plafonnées par famille, donc annoncer le
 * temps du total (52) alors que le parcours n'en prend que 35 était faux — et
 * c'est exactement ce qu'a relevé l'utilisateur le 10/08.
 */
function todoEstimateLabel(t) {
  const queue = [
    ...t.todo.replies.map((x) => ({ kind: 'reply', x })),
    ...t.todo.invoices.map((x) => ({ kind: 'invoice', x })),
    ...t.todo.deadlines.map((x) => ({ kind: 'deadline', x })),
    ...t.todo.followups.map((x) => ({ kind: 'followup', x })),
  ];
  const mins = Math.max(1, Math.round(queue.reduce((n, q) => n + todoMinutes(q), 0)));
  const rest = t.todo.total - queue.length;
  return rest > 0
    ? `≈ ${fmtNum(mins)} min pour les ${fmtNum(queue.length)} plus urgentes (${fmtNum(rest)} de plus dans la liste)`
    : `≈ ${fmtNum(mins)} min`;
}

function startTodoAssistant(t, { limit } = {}) {
  // File de missions UNIFIÉE (Phase 3) : toutes catégories mélangées, triées
  // par le MÊME rang que l'accueil (`rangCandidat`) — une seule définition de
  // l'urgence pour tout le produit. Il y avait ici une COPIE du score additif,
  // qui pouvait diverger de celle du briefing sans que rien ne le signale.
  let queue = [
    ...t.todo.replies.map((x) => ({ kind: 'reply', x })),
    ...t.todo.invoices.map((x) => ({ kind: 'invoice', x })),
    ...t.todo.deadlines.map((x) => ({ kind: 'deadline', x })),
    ...t.todo.followups.map((x) => ({ kind: 'followup', x })),
  ].sort(comparerRangs);
  queue = dedoublonnerCandidats(queue);
  const totalActions = queue.length;
  if (limit) queue = queue.slice(0, limit);
  if (queue.length === 0) return;
  let idx = 0;
  let treated = 0;
  let passed = 0;

  // PAGE, pas une modale au milieu de l'écran (retour utilisateur 10/08 :
  // « doit être traité de la même façon que le dépouillement, à savoir
  // affichage des mails à droite »). Même ossature que le dépouillement :
  // colonne de gauche = la décision, colonne de droite = le mail lui-même.
  closeModal();
  closeReader();
  const main = $('#main');
  main.innerHTML = `<div class="page-head"><div><h1>▶️ On traite ensemble</h1>
    <div class="sub">Une action à la fois, la plus urgente d'abord — le mail s'affiche à droite.
      Tu t'arrêtes quand tu veux, rien n'est perdu.</div></div>
    <div class="head-actions"><a class="btn" href="#/today">← Vue du jour</a></div></div>
    <div class="inbox-layout" id="ta-wrap">
      <div id="ta-screen"><div class="panel">
        <div class="panel-head"><h2 id="ta-title" style="white-space:nowrap">▶️ On traite ensemble</h2>
          <span class="muted" style="font-size:12px; margin-left:auto; margin-right:10px" id="ta-est"></span>
          <button class="btn btn-sm" id="ta-stop" title="Arrêter — rien n'est perdu : les actions restantes restent listées">⏸ Arrêter</button></div>
        <div class="panel-body" id="ta-body"></div>
        <div class="rv-foot" id="ta-foot"></div>
      </div></div>
      <div class="inbox-dock hidden" id="ta-dock"></div>
    </div>`;
  const dockEl = $('#ta-dock');
  $('#ta-stop').addEventListener('click', () => { closeReader(); location.hash = '#/today'; });

  const finish = () => {
    const leftOut = totalActions - queue.length;
    closeReader();
    $('#ta-title').textContent = 'C\'est bon pour aujourd\'hui 🎉';
    $('#ta-est').textContent = '';
    $('#ta-body').innerHTML = `<div class="empty" style="font-size:15px">
      ${treated ? `Tu as traité <strong>${fmtNum(treated)}</strong> action(s)` : 'Rien de traité cette fois'}
      ${passed ? ` · ${fmtNum(passed)} remise(s) à plus tard — elles restent dans « À faire »` : ''}.
      ${leftOut > 0 ? `<br>${fmtNum(leftOut)} action(s) moins urgente(s) attendent dans la liste — rien n'est perdu.` : ''}<br>
      <span class="muted" style="font-size:12.5px">Tout est journalisé dans le
      <a href="#/operations">📒 Journal d'activité</a>.</span></div>`;
    $('#ta-foot').innerHTML = '<button class="btn btn-primary" id="ta-close">← Retour à la Vue du jour</button>';
    $('#ta-close').addEventListener('click', () => { location.hash = '#/today'; });
  };

  const next = (wasTreated) => {
    if (wasTreated === true) treated += 1;
    if (wasTreated === false) passed += 1;
    idx += 1;
    if (idx >= queue.length) finish();
    else step();
  };

  // Une action réseau sur le bouton cliqué : désactive, exécute, avance.
  const act = async (btn, fn) => {
    btn.disabled = true;
    try {
      await fn();
      next(true);
    } catch (err) {
      btn.disabled = false;
      alert(err.message);
    }
  };

  const KIND_LABELS = {
    reply: ['↩️', 'Réponse attendue'],
    invoice: ['💶', 'Facture à traiter'],
    deadline: ['📅', 'Échéance'],
    followup: ['⏰', 'Relance à faire'],
  };

  function step() {
    if (!document.getElementById('ta-title')) return; // l'utilisateur a quitté
    const { kind, x } = queue[idx];
    const [emoji, kindLabel] = KIND_LABELS[kind];
    // Un SEUL barème de temps pour toute l'application (todoMinutes) : l'écran
    // d'accueil et ce parcours ne peuvent plus annoncer deux durées
    // différentes pour le même travail (incohérence signalée le 10/08).
    const minLeft = Math.max(1, Math.round(queue.slice(idx).reduce((n, q) => n + todoMinutes(q), 0)));
    $('#ta-title').textContent = `Action ${idx + 1} sur ${queue.length}`;
    $('#ta-est').textContent = `~${minLeft} min restantes${
      totalActions > queue.length ? ` · ${fmtNum(totalActions - queue.length)} de plus dans la liste` : ''
    }`;

    const who = kind === 'followup'
      ? (x.counterpartyName || x.counterpartyEmail || '')
      : (x.fromName || x.fromEmail || '');
    const title = kind === 'deadline' ? x.title : (x.subject ?? '(sans sujet)');
    const explain =
      kind === 'reply' ? `Ce fil se termine par un mail reçu — ${esc(x.reason ?? '')}`
      : kind === 'invoice' ? esc(x.reason ?? 'facture détectée')
      : kind === 'deadline' ? `${x.status === 'proposed' ? 'Échéance DÉTECTÉE (à confirmer ou écarter)' : 'Échéance confirmée'} — ${esc(x.reason ?? '')} · date : ${fmtDate(x.date)}`
      : `Tu as écrit en dernier, sans réponse ${daysAgo(x.waitingHours)}${x.suggestion ? ` · ${esc(x.suggestion)}` : ''}`;

    // Item « lecture » pour ouvrir le mail au-dessus de la modale.
    const readerItem = kind === 'deadline'
      ? (x.folder && x.uid ? { account: x.account, folder: x.folder, uid: x.uid, subject: x.subject, fromName: x.fromName, fromEmail: x.fromEmail, date: x.msgDate, isSeen: x.isSeen ?? true } : null)
      : { account: x.account, folder: x.folder, uid: x.uid, subject: x.subject, fromName: x.fromName ?? null, fromEmail: x.fromEmail ?? '', date: x.date, isSeen: x.isSeen ?? true };

    // Le mail s'affiche D'OFFICE à droite (même règle que le dépouillement) —
    // sauf écran étroit, où le lien d'ouverture en panneau reste.
    const canDock = dockEl && dockEl.isConnected && window.innerWidth > 1100;
    $('#ta-body').innerHTML = `
      <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px">
        <span class="badge ${kind === 'reply' || kind === 'followup' ? 'orange' : kind === 'invoice' ? 'blue' : 'gray'}">${emoji} ${kindLabel}</span>
        ${accountChip(x.account)}
        ${x.overdue ? '<span class="badge red">en retard</span>' : ''}
      </div>
      <div style="font-size:15px; margin-bottom:4px"><strong>${esc(who)}</strong>${who ? ' — ' : ''}« ${esc(title)} »</div>
      <div class="muted" style="font-size:12.5px; margin-bottom:12px">${explain}</div>
      ${readerItem ? `<div style="margin-bottom:6px"><span class="openable" id="ta-read" style="font-size:13px">${canDock ? '📖 Rouvrir le mail' : '📖 Lire le mail avant de décider'}</span></div>` : ''}
    `;
    // Le lecteur est un GESTE du parcours (même règle qu'au dépouillement) :
    // supprimer, déplacer ou répondre depuis le panneau vaut décision et fait
    // passer à l'action suivante.
    const readerOpts = {
      dock: canDock ? dockEl : null,
      onRemoved: () => next(true),
      onReplied: () => next(true),
    };
    $('#ta-read')?.addEventListener('click', () => openReaderFor(readerItem, readerOpts));
    if (readerItem && canDock) openReaderFor(readerItem, readerOpts);
    else if (!readerItem) closeReader();

    const buttons = [];
    if (kind === 'reply') {
      if (smtpEnabled && readerItem) buttons.push(['↩️ Répondre', 'btn-primary', null, () => { openReaderFor(readerItem, readerOpts); }]);
      buttons.push(['🚫 Pas de réponse à faire', '', () => api.replyDismiss(x.account, x.threadId)]);
      buttons.push(['💤 Me le reproposer dans 3 j', '', () => api.replySnooze(x.account, x.threadId, 3)]);
    } else if (kind === 'invoice') {
      buttons.push(['✓ C\'est réglé', 'btn-primary', () => api.messageAction(x.account, { folder: x.folder, uid: x.uid, action: 'seen' })]);
      buttons.push(['☑️ En faire une tâche', '', () => api.taskCreate({
        title: `Payer : ${x.subject}`,
        account: x.account,
        messageRef: { folder: x.folder, uid: x.uid },
      })]);
    } else if (kind === 'deadline') {
      if (x.status === 'proposed') {
        buttons.push(['✓ Confirmer cette échéance', 'btn-primary', () => api.deadlineAction(x.account, x.id, 'confirm')]);
        buttons.push(['🚫 Fausse détection, écarter', '', () => api.deadlineAction(x.account, x.id, 'dismiss')]);
      } else {
        buttons.push(['✓ C\'est fait', 'btn-primary', () => api.deadlineAction(x.account, x.id, 'done')]);
      }
    } else if (kind === 'followup') {
      buttons.push(['✓ Relance faite / plus besoin', 'btn-primary', () => api.followupDismiss(x.account, x.threadId)]);
      buttons.push(['💤 Me le reproposer dans 3 j', '', () => api.followupSnooze(x.account, x.threadId, 3)]);
    }

    $('#ta-foot').innerHTML = `
      <span class="muted" style="font-size:12px; margin-right:auto">Toutes ces actions sont journalisées et réversibles.</span>
      ${buttons.map(([label, cls], k) => `<button class="btn btn-sm ${cls}" data-ta="${k}">${label}</button>`).join('')}
      <button class="btn btn-sm" id="ta-skip" title="Décision remise à plus tard — l'action reste dans la liste">⏭️ Passer</button>`;
    $('#ta-foot').querySelectorAll('[data-ta]').forEach((btn) => {
      const [, , fn, direct] = buttons[Number(btn.dataset.ta)];
      btn.addEventListener('click', () => {
        if (direct) { direct(); return; } // ouvre le mail (répondre) : la file attend
        act(btn, fn);
      });
    });
    $('#ta-skip').addEventListener('click', () => next(false));
  }

  step();
}

// ---------------------------------------------------------------- Dépouillement
// Parcours « Dépouiller mes nouveaux mails » (Lot 1 du plan validé 02/08) :
// l'assistant PRÉPARE le courrier — les importants un par un, le bruit par
// LOTS homogènes (même boîte + même expéditeur + même intention) — et chaque
// étape propose une décision par défaut. Rien ne part sans décision explicite ;
// la corbeille est toujours confirmée ; tout est journalisé.
const REVIEW_CLASS_LABELS = {
  important: ['🔥 À décider', 'red'],
  read: ['📖 À lire', 'blue'],
  range: ['🧹 Rangeable', 'gray'],
};

// Bandeau d'annulation (10 s) : une action automatique vient d'être faite au
// nom de l'utilisateur — il peut la rappeler d'un clic si c'était une erreur.
function showUndoToast(message, onUndo, ms = 10000) {
  document.querySelector('.undo-toast')?.remove();
  const t = document.createElement('div');
  t.className = 'undo-toast';
  // Sans annulation possible, le bandeau reste une confirmation de ce qui
  // vient d'être fait — il ne montre pas un bouton qui ne tiendrait pas.
  t.innerHTML = `<span>${esc(message)}</span>
    ${onUndo ? '<button class="btn btn-sm" id="undo-btn">↩️ Annuler</button>' : ''}
    <span class="undo-count" id="undo-count">${Math.round(ms / 1000)}</span>`;
  document.body.appendChild(t);
  let left = Math.round(ms / 1000);
  const iv = setInterval(() => {
    left -= 1;
    const c = t.querySelector('#undo-count');
    if (c) c.textContent = String(left);
    if (left <= 0) { clearInterval(iv); t.remove(); }
  }, 1000);
  t.querySelector('#undo-btn')?.addEventListener('click', async (e) => {
    clearInterval(iv);
    e.target.disabled = true;
    e.target.textContent = '⏳ Restauration…';
    try {
      await onUndo();
      t.remove();
    } catch (err) {
      t.remove();
      alert(err.message);
    }
  });
}

// Suppression : UN SEUL CLIC, puis 10 s pour se rattraper (retour utilisateur
// 10/08 : « j'en ai marre de cliquer 2 fois pour supprimer »). Le mail part en
// corbeille — jamais effacé — et ce bandeau le RAMÈNE vraiment à sa place.
// `undo` vient du serveur (les UIDs pris dans la corbeille) ; s'il manque, on
// ne promet rien : simple confirmation que c'est récupérable dans Outlook.
function offerUndoDelete(account, undo, count = 1, onRestored) {
  const n = count > 1 ? `${fmtNum(count)} mails mis` : 'Mail mis';
  if (!undo?.trashUids?.length) {
    showUndoToast(`${n} à la corbeille — récupérable ~30 j dans Outlook.`, null);
    return;
  }
  showUndoToast(`${n} à la corbeille.`, async () => {
    await api.messageRestore(account, undo);
    await onRestored?.();
  });
}

// Chantier 2 : la carte de proposition (régime A — pré-remplie, éditable) ou
// l'honnêteté du régime B (aucune pré-sélection quand les signaux manquent).
function reviewProposalHtml(it) {
  const p = it.proposal;
  if (p) {
    const isDl = p.objectType === 'deadline';
    if (p.mode === 'exists') {
      return `<div class="prop-card">
        <div class="prop-head">✔ Échéance déjà en place</div>
        <div style="font-size:13.5px; margin:2px 0"><strong>${esc(p.title)}</strong>${p.date ? ` — ${fmtDate(p.date)}` : ''}</div>
        <div class="muted" style="font-size:12px">${esc(p.why)} <a href="#/deadlines">Voir les échéances</a></div>
      </div>`;
    }
    if (p.objectType === 'rentila_message') {
      return `<div class="prop-card">
        <div class="prop-head">💡 Proposition : ✉️ message au locataire via Rentila — ${esc(p.property ?? '')}</div>
        <div class="prop-fields" style="flex-direction:column; align-items:stretch">
          <label>Sujet <input type="text" id="rv-p-title" value="${esc(p.title)}"></label>
          <label>Message <textarea id="rv-p-body" rows="6" style="resize:vertical">${esc(p.body ?? '')}</textarea></label>
          ${p.deadlineId ? `<label style="flex-direction:row; gap:6px; align-items:center">
            <input type="checkbox" id="rv-p-confdl" checked>
            confirmer aussi l'échéance « ${esc(p.deadlineTitle ?? '')} »${p.date ? ` (${fmtDate(p.date)})` : ''}</label>` : ''}
        </div>
        <div class="muted" style="font-size:12px">Pourquoi : ${esc(p.why)}
          Valider prépare le message (envoyé par la messagerie Rentila quand tu diras à Claude
          « exécute mes commandes Rentila » — destinataires : les locataires du bail actif de ce bien).</div>
      </div>`;
    }
    const head = p.mode === 'confirm'
      ? '💡 Proposition : confirmer l\'échéance'
      : isDl ? '💡 Proposition : créer l\'échéance' : '💡 Proposition : créer la tâche';
    return `<div class="prop-card">
      <div class="prop-head">${head}</div>
      <div class="prop-fields">
        <label>Titre <input type="text" id="rv-p-title" value="${esc(p.title)}"></label>
        <label>${isDl ? 'Date' : 'Date (optionnelle)'} <input type="date" id="rv-p-date" value="${isDl && p.date ? p.date.slice(0, 10) : ''}"></label>
      </div>
      <div class="muted" style="font-size:12px">Pourquoi : ${esc(p.why)} Modifie ce qu'il faut, puis Valider.</div>
    </div>`;
  }
  if (it.regime === 'B') {
    return '<div class="prop-uncertain">🤔 Je ne suis pas assez sûr pour proposer une action — lis le mail et décide.</div>';
  }
  return '';
}

function reviewReason(item) {
  const bits = [];
  // Connecteur Rentila : la lecture structurée passe devant tout le reste
  // (« Assurance locataire expirée — 101 1er droite T3 »).
  if (item.rentilaLabel) bits.push(`🏠 ${item.rentilaLabel}`);
  // Lot 4f : LA raison résolue par le serveur (elle avoue sa provenance), puis
  // les mentions secondaires — une seule carte, jamais de cartes concurrentes.
  if (item.primaryReason) {
    bits.push(item.primaryReason, ...(item.secondaryReasons ?? []));
    return bits.join(' · ');
  }
  if (item.senderCategory) bits.push(SENDER_CATEGORY_LABELS[item.senderCategory] ?? item.senderCategory);
  if (item.intent) bits.push(INTENT_LABELS[item.intent] ?? item.intent);
  if (item.aiSummary) bits.push(`IA : ${item.aiSummary}`);
  return bits.join(' · ');
}

// ---------------------------------------------------------------- Dépouillement
// Lot 2 : le parcours vit sur sa page #/depouillement (plein écran, lien
// direct). La reprise de session est naturelle : seules les DÉCISIONS font
// avancer la file — s'arrêter ne perd rien. Les boutons « Dépouiller » de la
// Vue du jour et de la Boîte mènent ici.
function startReviewFlow() {
  if ((location.hash || '').startsWith('#/depouillement')) renderReviewPage();
  else location.hash = '#/depouillement';
}

// Coût estimé d'une étape (en minutes) — le temps est une INFORMATION
// affichée à l'accueil, jamais une décision (choix 5/15 min supprimé après
// confrontation ChatGPT du 03/08 : la reprise rend le budget inutile).
function reviewGroupMinutes(g) {
  if (g.kind === 'lot') return 0.4;
  if (g.item.class === 'important') return 1.5;
  if (g.item.class === 'read') return 0.7;
  return 0.3;
}

async function renderReviewPage() {
  const main = $('#main');
  main.innerHTML = `<div class="page-head"><div><h1>📬 Dépouillement</h1>
    <div class="sub">Ton nouveau courrier, préparé : les mails importants un par un, le reste par lots homogènes.
      Rien ne part sans ta décision, tout est journalisé.</div></div>
    <div class="head-actions"><a class="btn" href="#/today">← Vue du jour</a></div></div>
    <div class="inbox-layout" id="rv-wrap">
      <div id="rv-screen"><div class="empty"><span class="spinner"></span>Préparation du courrier…</div></div>
      <div class="inbox-dock hidden" id="rv-dock"></div>
    </div>`;
  reviewStart();
}

// Démarrage DIRECT (retour utilisateur 03/08) : cliquer « Dépouiller » ne doit
// jamais mener à un écran qui redemande de cliquer « Dépouiller ». La page
// lance le parcours d'elle-même ; s'il n'y a rien à faire, elle le dit et
// montre ce que l'assistant a remarqué.
async function reviewStart() {
  const el = $('#rv-screen');
  if (!el) return;
  let s; let q;
  try {
    [s, q] = await Promise.all([api.reviewSummary(), api.reviewQueue()]);
  } catch (err) {
    el.innerHTML = `<div class="notice warn">⚠️ ${esc(err.message)}</div>`;
    return;
  }
  if (!el.isConnected) return;
  if (!q.groups.length) {
    el.innerHTML = `<div class="panel"><div class="panel-body">
      <div class="empty" style="font-size:15px">✅ Ton courrier est dépouillé — aucun nouveau mail n'attend une décision.
        ${s.reviewedToday ? `<div class="muted" style="font-size:12.5px; margin-top:6px">${fmtNum(s.reviewedToday)} décision(s) prise(s) aujourd'hui${s.laterCount ? ` · ${fmtNum(s.laterCount)} gardé(s) « à lire plus tard »` : ''}.</div>` : ''}
      </div></div></div>
      <div id="rv-learn"></div>`;
    api.reviewLearning()
      .then((learn) => fillReviewLearning($('#rv-learn'), learn, () => reviewStart()))
      .catch(() => {});
    return;
  }
  reviewRun(q.groups, s);
}

function reviewRun(groups, s = null) {
  const el = $('#rv-screen');
  if (!el || !groups.length) return;
  const estAll = Math.max(1, Math.round(groups.reduce((n, g) => n + reviewGroupMinutes(g), 0)));
  el.innerHTML = `<div class="panel">
    <div class="panel-head"><h2 id="rv-title" style="white-space:nowrap">📬 Dépouillement</h2>
      <span class="muted" style="font-size:12px; margin-left:auto; margin-right:10px; text-align:right">≈ ${estAll} min${s?.reviewedToday ? ` · déjà ${fmtNum(s.reviewedToday)} aujourd'hui` : ''}</span>
      <button class="btn btn-sm" id="rv-stop" title="Arrêter — rien n'est perdu : le reste sera reproposé">⏸ Arrêter</button></div>
    <div class="panel-body" id="rv-body"></div>
    <div class="rv-foot" id="rv-foot"></div>
  </div>`;
  runReviewEngine(groups, {
    stopEl: $('#rv-stop'),
    dockEl: $('#rv-dock'),
    onDone: (counts) => { closeReader(); reviewFinish(counts); },
  });
}

// Fin de session : le bilan, la suite (« il en reste N »), et ce que
// l'assistant a remarqué (Lot 3).
async function reviewFinish(counts) {
  const el = $('#rv-screen');
  if (!el) return;
  const decided = counts.seen + counts.later + counts.keep + counts.action + counts.trash
    + (counts.replied ?? 0) + (counts.moved ?? 0) + (counts.validated ?? 0);
  el.innerHTML = `<div class="panel"><div class="panel-body">
    <h2 id="rv-fin-title" style="font-size:16px; margin-bottom:8px">${decided ? '✅ Session terminée' : 'Dépouillement interrompu'}</h2>
    <div style="font-size:14px">
      ${counts.validated ? `<div>💡 ${fmtNum(counts.validated)} proposition(s) validée(s) — échéances et tâches créées</div>` : ''}
      ${counts.replied ? `<div>↩️ ${fmtNum(counts.replied)} répondu(s)</div>` : ''}
      ${counts.seen ? `<div>👁️ ${fmtNum(counts.seen)} marqué(s) vu(s)</div>` : ''}
      ${counts.action ? `<div>☑️ ${fmtNum(counts.action)} ajouté(s) à tes actions</div>` : ''}
      ${counts.later ? `<div>📖 ${fmtNum(counts.later)} gardé(s) à lire plus tard</div>` : ''}
      ${counts.keep ? `<div>📥 ${fmtNum(counts.keep)} gardé(s) dans la boîte</div>` : ''}
      ${counts.moved ? `<div>📦 ${fmtNum(counts.moved)} rangé(s) dans un dossier</div>` : ''}
      ${counts.trash ? `<div>🗑️ ${fmtNum(counts.trash)} mis à la corbeille (récupérables ~30 j)</div>` : ''}
      ${counts.skipped ? `<div class="muted">⏭️ ${fmtNum(counts.skipped)} passé(s) — reproposés plus tard</div>` : ''}
    </div>
    <div class="muted" style="font-size:12.5px; margin-top:10px">Tout est journalisé dans le <a href="#/operations">📜 Journal d'activité</a>.</div>
    <div id="rv-fin-next" style="display:flex; gap:8px; align-items:center; margin-top:14px; flex-wrap:wrap"></div>
  </div></div>
  <div id="rv-learn"></div>`;

  let s = null;
  let learn = { notes: [], proposals: [] };
  try {
    [s, learn] = await Promise.all([api.reviewSummary(), api.reviewLearning()]);
  } catch { /* le bilan reste affichable sans le résumé */ }
  if (!el.isConnected) return;
  const nextEl = $('#rv-fin-next');
  if (s && s.total > 0) {
    nextEl.innerHTML = `<span style="font-size:13px">Il reste <strong>${fmtNum(s.total)}</strong> mail(s) à dépouiller.</span>
      <button class="btn btn-primary" id="rv-continue">▶️ Continuer</button>
      <a class="btn" href="#/today">🏠 Plus tard</a>`;
    $('#rv-continue')?.addEventListener('click', () => reviewStart());
  } else {
    if (decided) $('#rv-fin-title').textContent = '✅ Ton courrier est dépouillé';
    nextEl.innerHTML = '<a class="btn btn-primary" href="#/today">🏠 Retour à la Vue du jour</a>';
  }
  fillReviewLearning($('#rv-learn'), learn, () => reviewFinish(counts));
}

// ---------------------------------------------------------------- Apprentissage (Lot 3)
const LEARN_DECISION_LABELS = {
  seen: ['👁️', 'Vu'],
  trash: ['🗑️', 'Corbeille'],
  keep: ['📥', 'Garder'],
};

// « Ce que j'ai remarqué » : après 2 gestes identiques, une simple remarque ;
// après 3 gestes cohérents, une proposition avec la liste EXACTE des mails en
// attente concernés. Rien n'est jamais automatique : appliquer = un clic ici,
// et la corbeille reste confirmée.
function fillReviewLearning(el, learn, onChanged) {
  if (!el) return;
  const notes = learn?.notes ?? [];
  const proposals = learn?.proposals ?? [];
  if (!notes.length && !proposals.length) { el.innerHTML = ''; return; }
  const intentTxt = (p) => (p.intent ? ` (${(INTENT_LABELS[p.intent] ?? p.intent).toLowerCase()})` : '');
  el.innerHTML = `<div class="panel" style="margin-top:12px">
    <div class="panel-head"><h2>💡 Ce que j'ai remarqué</h2></div>
    <div class="panel-body">
      ${proposals.map((p, k) => {
        const [emo, lbl] = LEARN_DECISION_LABELS[p.decision] ?? ['❓', p.decision];
        const who = p.fromName || p.fromEmail;
        return `<div class="learn-card" data-lp="${k}">
          <div style="font-size:13.5px">Tu as choisi <strong>${fmtNum(p.count)}× « ${emo} ${lbl} »</strong> pour les mails de
            <strong>${esc(who)}</strong>${esc(intentTxt(p))} — <strong>${fmtNum(p.pendingIds.length)}</strong> mail(s) en attente correspondent.</div>
          <div class="subject-list hidden" data-lp-list="${k}">${p.pendingSamples.map((sm) =>
            `<div><span class="mail-date">${fmtDate(sm.date)}</span> ${esc(sm.subject)}</div>`).join('')}
            ${p.pendingIds.length > p.pendingSamples.length ? `<div class="muted">… et ${fmtNum(p.pendingIds.length - p.pendingSamples.length)} autre(s)</div>` : ''}</div>
          <div style="display:flex; gap:8px; margin-top:8px; flex-wrap:wrap">
            <button class="btn btn-sm" data-lp-show="${k}">Voir les ${fmtNum(p.pendingIds.length)} mails</button>
            <button class="btn btn-sm btn-primary" data-lp-apply="${k}">${emo} Appliquer aux ${fmtNum(p.pendingIds.length)}</button>
            <button class="btn btn-sm" data-lp-dismiss="${k}" title="Définitif — je ne proposerai plus ce motif">Ne plus proposer</button>
          </div></div>`;
      }).join('')}
      ${notes.map((p) => {
        const [emo, lbl] = LEARN_DECISION_LABELS[p.decision] ?? ['❓', p.decision];
        return `<div class="muted" style="font-size:12.5px; margin:2px 0">💡 2× « ${emo} ${lbl} » pour les mails de
          ${esc(p.fromName || p.fromEmail)}${esc(intentTxt(p))} — encore un geste identique et je te proposerai de l'appliquer en lot.</div>`;
      }).join('')}
    </div></div>`;
  el.querySelectorAll('[data-lp-show]').forEach((b) => b.addEventListener('click', () => {
    el.querySelector(`[data-lp-list="${b.dataset.lpShow}"]`)?.classList.toggle('hidden');
  }));
  // Un clic applique : la liste exacte est déjà sous les yeux (« Voir les N
  // mails ») et le bouton porte le geste. Pour la corbeille, le rattrapage
  // est le bandeau de 10 s — plus de question posée (retour 10/08).
  el.querySelectorAll('[data-lp-apply]').forEach((b) => b.addEventListener('click', async () => {
    const p = proposals[Number(b.dataset.lpApply)];
    b.disabled = true;
    try {
      const r = await api.reviewDecide(p.pendingIds, p.decision);
      if (p.decision === 'trash') {
        const label = `${fmtNum(p.pendingIds.length)} mail(s) mis à la corbeille`;
        showUndoToast(
          r.undo?.length ? `${label}.` : `${label} — récupérable ~30 j dans Outlook.`,
          r.undo?.length ? async () => { await api.reviewRestore(r.undo); onChanged?.(); } : null,
        );
      }
      onChanged?.();
    } catch (err) { b.disabled = false; alert(err.message); }
  }));
  el.querySelectorAll('[data-lp-dismiss]').forEach((b) => b.addEventListener('click', async () => {
    const p = proposals[Number(b.dataset.lpDismiss)];
    b.disabled = true;
    try {
      await api.reviewLearningDismiss(p.key);
      el.querySelector(`[data-lp="${b.dataset.lpDismiss}"]`)?.remove();
    } catch (err) { b.disabled = false; alert(err.message); }
  }));
}

// ---------------------------------------------------------------- Moteur d'étapes
// Une étape par groupe (mail important seul, ou lot homogène). Écrit dans
// #rv-title / #rv-body / #rv-foot, quel que soit l'écran qui les héberge.
function runReviewEngine(initialQueue, { stopEl, dockEl, onDone } = {}) {
  const queue = [...initialQueue];
  const counts = { seen: 0, later: 0, keep: 0, action: 0, trash: 0, skipped: 0, replied: 0, moved: 0, validated: 0 };
  let idx = 0;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    document.removeEventListener('keydown', keyHandler);
    onDone?.(counts);
  };
  stopEl?.addEventListener('click', finish);

  // Clavier = accélérateur (spéc. 03/08) — la souris reste le mode principal.
  // Entrée valide la proposition ; DANS un champ, Entrée sort du champ (la
  // 2e Entrée valide) ; P passe ; V ouvre/rouvre le mail.
  const keyHandler = (e) => {
    if (done || !document.getElementById('rv-title')) {
      document.removeEventListener('keydown', keyHandler);
      return;
    }
    const el = document.activeElement;
    const tag = el?.tagName?.toLowerCase();
    const editing = tag === 'input' || tag === 'textarea' || tag === 'select' || el?.isContentEditable;
    if (editing) {
      if (e.key === 'Enter' && tag === 'input') {
        e.preventDefault();
        el.blur();
      }
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      document.getElementById('rv-validate')?.click();
    } else if (e.key === 'p' || e.key === 'P') {
      document.getElementById('rv-skip')?.click();
    } else if (e.key === 'v' || e.key === 'V') {
      document.getElementById('rv-read')?.click();
    }
  };
  document.addEventListener('keydown', keyHandler);

  const next = () => {
    idx += 1;
    if (idx >= queue.length) finish();
    else step();
  };

  // Préchauffe le contenu des 2 prochains mails individuels : au passage à
  // l'étape suivante, le mail s'affiche sans attendre (retour 03/08).
  const preloadNext = () => {
    let warmed = 0;
    for (let k = idx + 1; k < queue.length && warmed < 2; k++) {
      const g2 = queue[k];
      if (g2.kind === 'single') {
        readMessageCached(g2.item.account, g2.item.folder, g2.item.uid).catch(() => {});
        warmed++;
      }
    }
  };

  // Une décision réseau : désactive, exécute, compte, avance.
  // Corbeille : elle part AU PREMIER CLIC (retour utilisateur 10/08), et le
  // bandeau de 10 s permet de la rappeler — le mail revient alors à sa place
  // ET reprend sa position dans le parcours, comme s'il n'avait rien subi.
  const decide = async (ids, decision, nMails) => {
    $('#rv-foot').querySelectorAll('button').forEach((b) => { b.disabled = true; });
    const g0 = queue[idx];
    try {
      const r = await api.reviewDecide(ids, decision);
      counts[decision] += nMails;
      if (r.errors?.length) alert(`Décision enregistrée, mais un effet a échoué :\n${r.errors.join('\n')}`);
      next();
      if (decision === 'trash') {
        const label = nMails > 1 ? `${fmtNum(nMails)} mails mis` : 'Mail mis';
        showUndoToast(
          r.undo?.length ? `${label} à la corbeille.` : `${label} à la corbeille — récupérable ~30 j dans Outlook.`,
          r.undo?.length
            ? async () => {
                await api.reviewRestore(r.undo);
                counts.trash -= nMails;
                if (g0) { queue.splice(idx, 0, g0); step(); }
              }
            : null,
        );
      }
    } catch (err) {
      alert(err.message);
      step();
    }
  };

  function step() {
    const g = queue[idx];
    $('#rv-title').textContent = `📬 Courrier ${idx + 1} sur ${queue.length}`;

    if (g.kind === 'lot') {
      // Pas de mail unique à afficher : la colonne de lecture se replie.
      closeReader();
      const who = g.fromName || g.fromEmail;
      const intentLabel = g.familleLabel ?? (g.intent ? (INTENT_LABELS[g.intent] ?? g.intent) : 'même nature');
      const catLabel = g.senderCategory ? (SENDER_CATEGORY_LABELS[g.senderCategory] ?? g.senderCategory) : '';
      $('#rv-body').innerHTML = `
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px">
          <span class="badge ${g.rentila ? 'blue' : 'gray'}">${g.rentila ? '🏠 Rentila — copies & technique' : '🧹 Lot rangeable'}</span>${accountChip(g.account)}
          ${catLabel ? `<span class="muted" style="font-size:12px">${esc(catLabel)}</span>` : ''}</div>
        <div style="font-size:15px; margin-bottom:2px"><strong>${fmtNum(g.count)} ${g.rentila ? 'notifications techniques Rentila' : `mails de ${esc(who)}`}</strong>
          ${g.rentila ? '' : `<span class="muted">— ${esc(intentLabel)}</span>`}</div>
        <div class="muted" style="font-size:12.5px; margin-bottom:8px">${g.rentila
          ? 'Uniquement les copies de tes propres envois (avis, quittances), les alertes de connexion et le technique — rien à faire, un geste suffit. Les vraies alertes (assurances, loyers, messages) passent une par une.'
          : 'Proposition : les marquer comme vus. La corbeille reste un choix séparé — un seul clic, avec 10 s pour se raviser.'}</div>
        <div class="subject-list">${g.samples.map((s) =>
          `<div><span class="mail-date">${fmtDate(s.date)}</span> ${esc(s.subject)}</div>`).join('')}
          ${g.count > g.samples.length ? `<div class="muted">… et ${fmtNum(g.count - g.samples.length)} autre(s) du même expéditeur</div>` : ''}</div>`;
      const buttons = [`<button class="btn btn-sm btn-primary" id="rv-seen">👁️ Vu pour les ${fmtNum(g.count)}</button>`,
        `<button class="btn btn-sm" id="rv-trash" style="color:var(--red)" title="Part tout de suite — 10 s pour annuler">🗑️ Corbeille</button>`,
        `<button class="btn btn-sm" id="rv-keep">📥 Garder tels quels</button>`];
      if (g.count <= g.samples.length) {
        buttons.push('<button class="btn btn-sm" id="rv-split">Décider un par un</button>');
      }
      $('#rv-foot').innerHTML = `
        <span class="muted" style="font-size:12px; margin-right:auto">Journalisé · réversible (sauf lecture)</span>
        ${buttons.join('')}
        <button class="btn btn-sm" id="rv-skip" title="Reproposé au prochain dépouillement">⏭️ Passer</button>`;
      $('#rv-seen').addEventListener('click', () => decide(g.ids, 'seen', g.count));
      $('#rv-trash').addEventListener('click', () => decide(g.ids, 'trash', g.count));
      $('#rv-keep').addEventListener('click', () => decide(g.ids, 'keep', g.count));
      $('#rv-split')?.addEventListener('click', () => {
        // Le lot éclate en décisions individuelles insérées à la suite.
        const singles = g.samples.map((s) => ({
          kind: 'single',
          item: { id: s.id, account: g.account, folder: s.folder, uid: s.uid, subject: s.subject,
            snippet: '', fromEmail: g.fromEmail, fromName: g.fromName, date: s.date, isSeen: true,
            intent: g.intent, aiSummary: null, senderCategory: g.senderCategory, class: 'range' },
        }));
        queue.splice(idx, 1, ...singles);
        step();
      });
      $('#rv-skip').addEventListener('click', () => { counts.skipped += g.count; next(); });
      return;
    }

    // Décision individuelle.
    const it = g.item;
    const [clsLabel, clsColor] = REVIEW_CLASS_LABELS[it.class] ?? REVIEW_CLASS_LABELS.read;
    const reason = reviewReason(it);
    // Le lecteur est un GESTE du parcours (retour utilisateur 02/08 : « je
    // supprime depuis le lecteur et rien n'avance ») : corbeille, déplacement
    // ou réponse envoyée depuis le panneau comptent comme la décision de
    // cette étape et font passer au courrier suivant.
    const readerOpts = {
      onRemoved: (_item, action) => {
        if (action === 'move') counts.moved += 1;
        else counts.trash += 1;
        next();
      },
      onReplied: async () => {
        // La réponse est partie : on enregistre la décision (le mail sort de
        // la file) sans bloquer si l'index est en retard.
        try { await api.reviewDecide([it.id], 'seen'); } catch { /* répondu quand même */ }
        counts.replied += 1;
        next();
      },
      // Reclasser vers une intention NON actionnable (information, promo,
      // confirmation…) vaut décision : le mail est traité et on passe au
      // suivant — avec un bandeau « Annuler » de 10 s si c'était une erreur
      // (retour utilisateur 03/08).
      onReclassified: (_item, newIntent, oldIntent) => {
        const nonAction = ['info', 'promo', 'confirmation', 'shipping', 'otp'];
        if (newIntent && !nonAction.includes(newIntent)) {
          // Intention ACTIONNABLE (facture, action à faire, réponse…) : la
          // proposition doit refléter la correction tout de suite — on
          // redemande l'étape enrichie au serveur et on re-rend sur place.
          (async () => {
            try {
              const q2 = await api.reviewQueue();
              const fresh = q2.groups.find((x) => x.kind === 'single' && x.item.id === it.id);
              if (fresh && queue[idx] === g) {
                queue.splice(idx, 1, fresh);
                step();
              }
            } catch { /* l'étape actuelle reste utilisable telle quelle */ }
          })();
          return;
        }
        if (!newIntent) return;
        (async () => {
          try {
            await api.reviewDecide([it.id], 'seen');
            counts.seen += 1;
            const g0 = g;
            showUndoToast(
              `Reclassé en ${INTENT_LABELS[newIntent] ?? newIntent} — mail traité, on passe au suivant.`,
              async () => {
                await api.reviewUndo(it.id);
                await api.setMessageIntent(it.account, { folder: it.folder, uid: it.uid, intent: oldIntent });
                counts.seen -= 1;
                queue.splice(idx, 0, g0);
                step();
              },
            );
            next();
          } catch (err) { alert(err.message); }
        })();
      },
    };
    // Le mail s'affiche D'OFFICE dans la colonne de droite (retour 03/08 :
    // « autant charger la vue du mail par défaut ») — sauf écran étroit, où
    // le lien d'ouverture en panneau reste.
    const canDock = dockEl && dockEl.isConnected && window.innerWidth > 1100;
    $('#rv-body').innerHTML = `
      <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px">
        <span class="badge ${clsColor}">${clsLabel}</span>${accountChip(it.account)}
        ${it.isSeen ? '' : '<span class="badge orange">non lu</span>'}</div>
      <div style="font-size:15px; margin-bottom:2px"><strong>${esc(it.fromName || it.fromEmail || '?')}</strong>
        — « ${esc(it.subject)} »</div>
      ${it.snippet ? `<div class="muted" style="font-size:12.5px; margin-bottom:6px">${esc(it.snippet)}</div>` : ''}
      ${reason ? `<div class="muted" style="font-size:12px; margin-bottom:8px">Pourquoi : ${esc(reason)}</div>` : ''}
      ${reviewProposalHtml(it)}
      <div style="margin-bottom:4px"><span class="openable" id="rv-read" style="font-size:13px">${canDock ? '📖 Rouvrir le mail' : '📖 Lire le mail avant de décider'}</span></div>`;
    // Le lien reste disponible même quand le mail est affiché d'office : si
    // l'utilisateur ferme la colonne (✕), il peut la rouvrir sans avancer.
    $('#rv-read')?.addEventListener('click', () =>
      openReaderFor(it, canDock ? { ...readerOpts, dock: dockEl } : readerOpts));
    if (canDock) openReaderFor(it, { ...readerOpts, dock: dockEl });
    preloadNext();

    // Validation d'une proposition : l'objet est créé/confirmé ET le mail est
    // traité, d'un seul geste (transaction serveur, une ligne de journal).
    const p = it.proposal;
    const doValidate = async () => {
      $('#rv-foot')?.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      const vb = $('#rv-validate');
      if (vb) vb.disabled = true;
      try {
        if (p.mode === 'exists') {
          await api.reviewDecide([it.id], 'seen');
          counts.seen += 1;
        } else if (p.objectType === 'rentila_message') {
          const r = await api.reviewValidate({
            messageId: it.id,
            objectType: 'rentila_message',
            title: $('#rv-p-title')?.value?.trim() || p.title,
            body: $('#rv-p-body')?.value?.trim() || p.body,
            property: p.property,
            deadlineId: p.deadlineId ?? undefined,
            confirmDeadline: $('#rv-p-confdl')?.checked ?? false,
          });
          counts.validated += 1;
          if (r.errors?.length) alert(`Validé, mais un effet a échoué :\n${r.errors.join('\n')}`);
        } else {
          const dateVal = $('#rv-p-date')?.value;
          const doneInput = $('#rv-p-done');
          const r = await api.reviewValidate({
            messageId: it.id,
            objectType: p.objectType,
            title: $('#rv-p-title')?.value?.trim() || p.title,
            date: dateVal
              ? new Date(`${dateVal}T09:00:00`).toISOString()
              : (p.objectType === 'deadline' ? p.date : null),
            deadlineType: p.deadlineType,
            deadlineId: p.deadlineId ?? undefined,
            // « Déjà fait » : on consigne l'action comme réalisée (l'historique
            // garde le fait) au lieu de la mettre au programme.
            markDone: !!doneInput,
            doneAt: doneInput?.value ? new Date(doneInput.value).toISOString() : null,
          });
          counts.validated += 1;
          if (r.errors?.length) alert(`Validé, mais un effet a échoué :\n${r.errors.join('\n')}`);
        }
        next();
      } catch (err) {
        alert(err.message);
        step();
      }
    };

    // La corbeille est disponible sur TOUTES les cartes (demande utilisateur
    // 05/08 : pouvoir supprimer sans ouvrir le lecteur). Depuis le 10/08 elle
    // part au premier clic : le rattrapage est le bandeau de 10 s, pas une
    // question posée à chaque mail. Soft delete, journalisée.
    const toTrash = () => decide([it.id], 'trash', 1);
    const B = [];
    if (it.class === 'important') {
      // Le libellé suit le geste attendu : répondre si une réponse est attendue.
      const readLabel = (it.veutRepondre || it.intent === 'reply_expected')
        ? '↩️ Lire et répondre' : '📖 Lire et traiter';
      B.push([readLabel, 'btn-primary', () => openReaderFor(it, readerOpts)]);
      B.push(['☑️ Ajouter à mes actions', '', () => decide([it.id], 'action', 1)]);
      B.push(['👁️ Vu', '', () => decide([it.id], 'seen', 1)]);
    } else if (it.class === 'read') {
      B.push(['📖 Lire maintenant', 'btn-primary', () => openReaderFor(it, readerOpts)]);
      B.push(['👁️ Vu', '', () => decide([it.id], 'seen', 1)]);
      B.push(['🕐 Plus tard', '', () => decide([it.id], 'later', 1)]);
    } else {
      B.push(['👁️ Vu', 'btn-primary', () => decide([it.id], 'seen', 1)]);
      B.push(['🗑️ Corbeille', '', toTrash]);
      B.push(['📥 Garder', '', () => decide([it.id], 'keep', 1)]);
    }
    if (it.class === 'important') B.push(['🕐 Plus tard', '', () => decide([it.id], 'later', 1)]);
    if (it.class !== 'range') B.push(['🗑️ Corbeille', '', toTrash]);
    // Avec une proposition, VALIDER devient le geste principal ; les autres
    // gestes restent disponibles en boutons secondaires, à égalité.
    const validateBtn = p
      ? `<button class="btn btn-sm btn-primary" id="rv-validate" title="${esc(p.why)} (touche Entrée)">${p.mode === 'exists' ? '✅ Continuer (mail traité)' : '✅ Valider'}</button>`
        + (p.mode !== 'exists' && p.objectType !== 'rentila_message'
          ? '<button class="btn btn-sm" id="rv-done" title="L\'action a déjà eu lieu : on la consigne dans l\'historique (date et heure modifiables) au lieu de la mettre au programme">✔ Déjà fait</button>'
          : '')
      : '';
    $('#rv-foot').innerHTML = `
      <span class="muted" style="font-size:12px; margin-right:auto">Journalisé · réversible (sauf lecture)</span>
      ${validateBtn}
      ${B.map(([label, cls], k) => `<button class="btn btn-sm ${p ? '' : cls}" data-rv="${k}">${label}</button>`).join('')}
      <button class="btn btn-sm" id="rv-skip" title="Reproposé au prochain dépouillement (touche P)">⏭️ Passer</button>`;
    $('#rv-validate')?.addEventListener('click', doValidate);
    // « Déjà fait » : la carte bascule en mode consignation — date/heure de
    // réalisation pré-remplies à maintenant, modifiables, puis Valider.
    $('#rv-done')?.addEventListener('click', () => {
      const card = document.querySelector('.prop-card');
      if (!card || card.querySelector('#rv-p-done')) return;
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const local = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
      const head = card.querySelector('.prop-head');
      if (head) head.textContent = '✔ Action déjà faite — consignée dans l\'historique';
      card.querySelector('.prop-fields')?.insertAdjacentHTML('beforeend',
        `<label>Fait le <input type="datetime-local" id="rv-p-done" value="${local}"></label>`);
      const vb = $('#rv-validate');
      if (vb) vb.textContent = '✔ Consigner comme fait';
      $('#rv-done')?.remove();
      $('#rv-p-done')?.focus();
    });
    $('#rv-foot').querySelectorAll('[data-rv]').forEach((btn) => {
      btn.addEventListener('click', () => { B[Number(btn.dataset.rv)][2](); });
    });
    $('#rv-skip').addEventListener('click', () => { counts.skipped += 1; next(); });
  }

  step();
}

// ---------------------------------------------------------------- Nettoyage guidé
// Enchaîne les familles de bruit une par une (les plus grosses d'abord) :
// à chaque étape, la liste EXACTE, la lecture possible, et la décision —
// corbeille ou passer. Réutilise la modale « bruit » existante.
function startNoiseTour(buckets) {
  const steps = buckets.filter((b) => b.count > 0).sort((a, b) => b.count - a.count);
  if (steps.length === 0) return;
  let i = 0;
  let totalDeleted = 0;
  const advance = (deleted) => {
    totalDeleted += deleted ?? 0;
    i += 1;
    if (i < steps.length) {
      openNoiseModal(steps[i].bucket, { tour: { index: i + 1, total: steps.length, onNext: advance } });
    } else {
      closeModal();
      alert(`🧹 Nettoyage guidé terminé${totalDeleted ? ` : ${fmtNum(totalDeleted)} mail(s) à la corbeille (récupérables ~30 j)` : ' — rien n\'a été supprimé'}. Tout est dans le 📒 Journal d'activité.`);
      renderToday();
    }
  };
  openNoiseModal(steps[0].bucket, { tour: { index: 1, total: steps.length, onNext: advance } });
}

// Modale « bruit » : liste exacte (cap 500) → corbeille par lots via les
// endpoints bulk existants (journalisés), groupés par boîte + dossier.
async function openNoiseModal(bucket, { tour } = {}) {
  closeModal();
  const [emoji, label] = NOISE_LABELS[bucket] ?? ['⚪', bucket];
  const overlay = document.createElement('div');
  // under-reader : le panneau de lecture s'ouvre AU-DESSUS de cette modale
  // (on vérifie un mail avant de valider le nettoyage).
  overlay.className = 'modal-overlay under-reader';
  overlay.innerHTML = `<div class="modal modal-wide">
    <div class="modal-head"><h2>${emoji} ${esc(label)}
      ${tour ? `<span class="badge blue" style="margin-left:8px">nettoyage guidé — famille ${tour.index}/${tour.total}</span>` : ''}</h2>
      <button class="modal-close" title="${tour ? 'Arrêter le ménage guidé' : 'Fermer'}">✕</button></div>
    <div class="modal-body" id="modal-body"><div class="empty"><span class="spinner"></span>Chargement de la liste…</div></div>
    <div class="modal-foot" id="modal-foot"></div>
  </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('.modal-close').addEventListener('click', closeModal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });

  let data;
  try {
    data = await api.todayNoise(bucket);
  } catch (err) {
    $('#modal-body').innerHTML = `<div class="notice warn">⚠️ ${esc(err.message)}</div>`;
    return;
  }

  $('#modal-body').innerHTML = `
    <p><strong>${fmtNum(data.total)}</strong> mail(s) classé(s) « ${esc(label)} » reçus il y a <strong>plus de 7 jours</strong>
    (les mails récents ne sont jamais proposés), <strong>du plus ancien au plus récent</strong>.
    ${data.truncated ? `<br><span class="muted">Par prudence, on traite <strong>${fmtNum(data.items.length)}</strong> mails à la fois (les plus anciens d'abord) — relance l'opération pour continuer.</span>` : ''}
    <span class="muted" style="font-size:12px">Clique un sujet pour lire le mail avant de décider.</span></p>
    <div style="max-height:55vh; overflow:auto; border:1px solid var(--border); border-radius:8px">
      <table class="table-compact"><thead><tr>
        <th style="width:96px">Boîte</th><th style="width:104px">Reçu le</th>
        <th>Sujet</th><th style="width:210px">Expéditeur</th>
      </tr></thead>
      <tbody>${data.items.map((m, i) => `<tr>
        <td style="white-space:nowrap">${accountChip(m.account)}</td>
        <td class="muted" style="font-size:12px; white-space:nowrap">${fmtDate(m.date)}</td>
        <td style="max-width:520px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">
          <span class="openable" data-noise-open="${i}" title="${esc(m.subject)}">${esc(m.subject)}</span>
          ${m.snippet ? `<span class="mail-snip" title="${esc(m.snippet)}"> — ${esc(m.snippet)}</span>` : ''}</td>
        <td class="muted" style="font-size:12px; max-width:210px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap"
          title="${esc(m.fromEmail ?? '')}">${esc(m.fromName || m.fromEmail)}</td>
      </tr>`).join('')}</tbody></table>
    </div>`;
  // Lecture avant décision : le panneau s'ouvre au-dessus de la modale ;
  // un mail supprimé depuis le panneau recharge la liste.
  $('#modal-body').querySelectorAll('[data-noise-open]').forEach((el) => {
    el.addEventListener('click', () => {
      const m = data.items[Number(el.dataset.noiseOpen)];
      if (m) openReaderFor(m, { onRemoved: () => openNoiseModal(bucket) });
    });
  });
  $('#modal-foot').innerHTML = `
    <span class="muted" style="font-size:12px; margin-right:auto">Corbeille = récupérable ~30 jours, rien n'est effacé définitivement.</span>
    ${tour
      ? '<button class="btn" id="noise-cancel" title="Cette famille ne bouge pas — on passe à la suivante">⏭️ Passer cette famille</button>'
      : '<button class="btn" id="noise-cancel">Annuler</button>'}
    <button class="btn btn-primary" id="noise-delete" ${data.items.length ? '' : 'disabled'}>🗑️ Mettre ${fmtNum(data.items.length)} mail(s) à la corbeille</button>`;
  $('#noise-cancel').addEventListener('click', () => {
    if (tour) tour.onNext(0);
    else closeModal();
  });
  $('#noise-delete').addEventListener('click', async () => {
    if (!confirm(`Mettre ${data.items.length} mail(s) « ${label} » à la corbeille ?\n\nIls restent récupérables ~30 jours dans la corbeille de chaque boîte, et l'opération est journalisée.`)) return;
    const btn = $('#noise-delete');
    btn.disabled = true;
    // Groupe par boîte + dossier → endpoints bulk existants (lots de 200 côté serveur).
    const groups = new Map();
    for (const m of data.items) {
      const key = `${m.account}|${m.folder}`;
      if (!groups.has(key)) groups.set(key, { account: m.account, folder: m.folder, uids: [] });
      groups.get(key).uids.push(m.uid);
    }
    let done = 0;
    let failed = 0;
    let i = 0;
    for (const g of groups.values()) {
      i += 1;
      btn.textContent = `Suppression… (boîte ${i}/${groups.size})`;
      try {
        const r = await api.bulkAction(g.account, { folder: g.folder, uids: g.uids, action: 'delete' });
        done += r.moved ?? r.affected ?? g.uids.length;
      } catch {
        failed += g.uids.length;
      }
    }
    if (tour) {
      if (failed) alert(`⚠️ ${failed} mail(s) en échec (boîte injoignable ?) — on continue le ménage.`);
      tour.onNext(done);
      return;
    }
    closeModal();
    alert(`🗑️ ${done} mail(s) mis à la corbeille${failed ? ` — ⚠️ ${failed} en échec (boîte injoignable ?)` : ''}.`);
    renderToday();
  });
}

// ---------------------------------------------------------------- Dashboard
async function renderDashboard() {
  const main = $('#main');
  const today = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  main.innerHTML = `<div class="page-head"><div><h1>Bonjour Anthony 👋</h1>
    <div class="sub">Voici ce qui se passe dans tes boîtes aujourd'hui.</div></div>
    <div class="head-actions">
      <span class="btn" style="cursor:default; text-transform:capitalize">🗓️ ${esc(today)}</span>
      <button class="btn btn-primary" id="syncall-btn" title="Synchronise chaque boîte l'une après l'autre, en arrière-plan">Tout synchroniser</button>
      <button class="btn" id="refresh-btn">↻ Actualiser</button>
    </div></div>
    <div id="dash-body"><div class="empty"><span class="spinner"></span>Chargement…</div></div>`;
  $('#refresh-btn').addEventListener('click', async () => {
    await refreshOverview();
    renderDashboard();
  });
  $('#syncall-btn').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await api.syncAll('recent');
      pollJobs();
    } catch (err) {
      e.target.disabled = false;
      alert(err.message);
    }
  });

  const ov = overviewCache ?? (await api.overview());
  const body = $('#dash-body');

  if (ov.enrolled.length === 0) {
    body.innerHTML = `<div class="notice warn">Aucune boîte connectée. Lancer
      <code>npm run enroll -- --account &lt;nom&gt;</code> sur le serveur.</div>`;
    return;
  }

  // Nettoyage rapide (tous comptes synchronisés, en parallèle).
  const cleanups = await Promise.all(
    ov.accounts.map((a) =>
      api.cleanup(a.account).then(
        (c) => ({ account: a.account, ...c }),
        () => ({ account: a.account, candidates: [], totalDeletableEstimate: 0 }),
      ),
    ),
  );
  const deletable = cleanups.reduce((s, c) => s + c.totalDeletableEstimate, 0);
  const allCandidates = cleanups
    .flatMap((c) => c.candidates.map((x) => ({ ...x, account: c.account })))
    .sort((a, b) => b.messageCount - a.messageCount);

  body.innerHTML = `
    ${'' /* Les problèmes qui faussent tout le reste s'affichent EN PREMIER
          (revue UX) : boîtes jamais synchronisées, santé du système. */}
    ${ov.neverSynced.length ? `<div class="notice warn">⚠️ <strong>Boîte(s) jamais synchronisée(s)</strong> :
      ${ov.neverSynced.map((n) => `<strong>${esc(n)}</strong>`).join(', ')} —
      les chiffres ci-dessous peuvent être incomplets.
      <button class="btn btn-sm" id="never-sync-all" style="margin-left:8px">Tout synchroniser</button></div>` : ''}
    <div id="health-banner"></div>

    <div class="panel" id="brief-panel">
      <div class="panel-head">
        <h2 id="brief-toggle" style="cursor:pointer" title="Replier / déplier le brief">
          <span id="brief-caret">▾</span> ☀️ Brief du jour
          <span class="muted brief-when" id="brief-when"></span></h2>
        <div class="head-actions">
          <select id="brief-type" title="Brief du jour (24 h) ou revue de la semaine (7 jours)">
            <option value="daily">Jour (24 h)</option>
            <option value="weekly">Semaine (7 j)</option>
          </select>
          <button class="btn btn-sm" id="brief-generate">Régénérer</button>
        </div>
      </div>
      <div class="panel-body" id="brief-body"><div class="empty"><span class="spinner"></span>Chargement…</div></div>
    </div>

    <div class="cards">
      <div class="kpi accent"><div class="kpi-label">✉️ Nouveaux mails aujourd'hui</div>
        <div class="kpi-value">${fmtNum(ov.newMails?.today ?? 0)}</div>
        <div class="kpi-sub">${newMailsDelta(ov.newMails)}</div></div>
      <div class="kpi"><div class="kpi-label">⭐ À ne pas manquer</div>
        <div class="kpi-value" id="kpi-important">…</div>
        <div class="kpi-sub">à traiter</div></div>
      <div class="kpi"><div class="kpi-label">↩️ À répondre</div>
        <div class="kpi-value" id="kpi-replies">…</div>
        <div class="kpi-sub" id="kpi-replies-sub">&nbsp;</div></div>
      <div class="kpi orange"><div class="kpi-label">⏰ À relancer</div>
        <div class="kpi-value" id="kpi-followups">…</div>
        <div class="kpi-sub" id="kpi-followups-sub">&nbsp;</div></div>
      <div class="kpi"><div class="kpi-label">📅 Dates détectées</div>
        <div class="kpi-value" id="kpi-deadlines">…</div>
        <div class="kpi-sub" id="kpi-deadlines-sub">&nbsp;</div></div>
      <div class="kpi green"><div class="kpi-label">🧹 Supprimables sans risque</div>
        <div class="kpi-value">${fmtNum(deletable)}</div>
        <div class="kpi-sub"><a href="#/cleanup">voir et nettoyer</a></div></div>
    </div>

    ${(() => {
      const full = ov.accounts.filter((a) => a.quota && a.quota.pct >= 90);
      return full.length
        ? `<div class="notice warn">🚨 Boîte(s) presque pleine(s) :
          ${full.map((a) => `<strong>${esc(a.account)}</strong> (${a.quota.pct}% — reste ${fmtSize(a.quota.freeBytes)})`).join(', ')}
          — pense au <a href="#/cleanup">🧹 nettoyage</a>.</div>`
        : '';
    })()}
    <div class="grid-2">
      <div class="panel">
        <div class="panel-head"><h2>Aperçu par compte</h2>
          <span class="muted" style="font-size:12px">espace : ⚠️ orange ≥ 90 % · rouge ≥ 95 %</span></div>
        <div class="panel-body tight"><table>
          <thead><tr><th>Compte</th><th class="num">INBOX</th><th class="num">Non lus</th><th>Espace utilisé</th><th></th></tr></thead>
          <tbody>${ov.accounts
            .map(
              (a) => `<tr>
                <td><strong>${esc(a.account)}</strong><br><span class="muted" style="font-size:12px">${esc(a.emailAddress)}</span></td>
                <td class="num">${fmtNum(a.inbox?.messages ?? 0)}</td>
                <td class="num">${fmtNum(a.inbox?.unseen ?? 0)}</td>
                <td>${quotaCell(a.quota, a.quotaNote)}</td>
                <td><a class="btn btn-sm" href="#/account/${esc(a.account)}">Ouvrir</a></td>
              </tr>`,
            )
            .join('')}</tbody>
        </table></div>
      </div>

      <div class="panel">
        <div class="panel-head"><h2>🧹 Nettoyage rapide</h2>
          <span><span class="badge green">${fmtNum(deletable)} mails « sûrs »</span>
          <a class="btn btn-sm" href="#/cleanup" style="margin-left:8px">Voir et nettoyer</a></span></div>
        <div class="panel-body tight">
          ${allCandidates.length === 0 ? '<div class="empty">Aucun candidat détecté (ou boîtes pas encore synchronisées).</div>' : `
          <table><thead><tr><th>Expéditeur</th><th class="num">Mails</th><th class="num">Taille</th><th>Risque</th><th></th></tr></thead>
          <tbody>${allCandidates.slice(0, 8).map((c) => `<tr>
            <td>${esc(c.senderName || c.sender)} ${accountChip(c.account)}<br>
              <span class="muted" style="font-size:12px">${esc(c.sender)}</span></td>
            <td class="num">${fmtNum(c.messageCount)}${c.keepCount ? `<br><span class="badge green" style="font-weight:600" title="Pièce jointe, facture, ticket : jamais proposés">📄 ${fmtNum(c.keepCount)} gardés</span>` : ''}</td>
            <td class="num">${fmtSize(c.totalSizeBytes)}</td>
            <td><span class="badge ${c.riskLevel === 'safe' ? 'green' : 'orange'}">${c.riskLevel === 'safe' ? 'Sûr' : 'Moyen'}</span></td>
            <td><button class="btn btn-sm cleanup-btn" data-account="${esc(c.account)}"
              data-sender="${esc(c.sender)}" data-name="${esc(c.senderName || c.sender)}"
              title="Ouvre l'aperçu détaillé des mails de cet expéditeur — rien n'est supprimé sans ta confirmation (corbeille, récupérable ~30 j)">🧹 Nettoyer</button></td>
          </tr>`).join('')}</tbody></table>
          <div class="panel-body muted" style="font-size:12.5px">« Nettoyer » = aperçu détaillé puis, après TA
          confirmation, déplacement vers la corbeille (récupérable ~30 jours). Rien n'est supprimé définitivement.</div>`}
        </div>
      </div>
    </div>

    <div class="grid-2">
      <div class="panel">
        <div class="panel-head"><h2>⭐ À ne pas manquer</h2>
          <a class="btn btn-sm" href="#/important">Voir tout</a></div>
        <div class="panel-body" id="dash-important"><span class="spinner"></span></div>
        <div class="panel-head"><h2>↩️ À répondre</h2>
          <a class="btn btn-sm" href="#/replies">Voir tout</a></div>
        <div class="panel-body" id="dash-replies"><span class="spinner"></span></div>
        <div class="panel-head"><h2>⏰ À relancer</h2>
          <a class="btn btn-sm" href="#/followups">Voir tout</a></div>
        <div class="panel-body" id="dash-followups"><span class="spinner"></span></div>
        <div class="panel-head"><h2>📅 Dates à venir</h2>
          <a class="btn btn-sm" href="#/deadlines">Voir tout</a></div>
        <div class="panel-body" id="dash-deadlines"><span class="spinner"></span></div>
        <div class="panel-head"><h2>☑️ Mes tâches</h2>
          <a class="btn btn-sm" href="#/tasks">Voir tout</a></div>
        <div class="panel-body" id="dash-tasks"><span class="spinner"></span></div>
      </div>
      <div class="panel">
        <div class="panel-head"><h2>Activité récente</h2>
          <a class="btn btn-sm" href="#/operations">Voir tout</a></div>
        <div class="panel-body" id="dash-ops"><span class="spinner"></span></div>
      </div>
    </div>`;

  // Le bouton de la bannière « jamais synchronisée » fait la même chose que
  // « Tout synchroniser » de l'en-tête (les Actions rapides qui doublonnaient
  // la navigation ont été retirées — revue UX).
  $('#never-sync-all')?.addEventListener('click', (e) => {
    e.target.disabled = true;
    $('#syncall-btn')?.click();
  });

  initBriefPanel();

  // Santé du système (P0.4) : on n'affiche RIEN quand tout va bien — un
  // bandeau permanent finirait par ne plus être lu. Le silence n'est fiable
  // que parce que cette vérification tourne à chaque affichage.
  api.health().then((h) => {
    const el = $('#health-banner');
    if (!el || h.level === 'ok') return;
    const lignes = h.accounts
      .filter((a) => a.level !== 'ok')
      .map((a) => `<strong>${esc(a.account)}</strong> : ${esc(a.message)}`)
      .join(' · ');
    el.innerHTML = `<div class="notice warn">
      ${h.level === 'error' ? '🚨' : '⚠️'} <strong>L'assistant ne travaille pas normalement</strong> —
      ${lignes}. <a href="#/settings">Voir l'état du système</a>
      <button class="btn btn-sm" id="health-sync" style="margin-left:8px">Tout synchroniser</button></div>`;
    $('#health-sync')?.addEventListener('click', (e) => {
      e.target.disabled = true;
      $('#syncall-btn')?.click();
    });
  }).catch(() => { /* la santé ne doit jamais casser le tableau de bord */ });

  api.operations(6).then(({ operations }) => {
    const el = $('#dash-ops');
    if (!el) return;
    el.innerHTML = operations.length
      ? operations.map(opLine).join('')
      : '<div class="empty">Aucune opération pour l\'instant.</div>';
  });

  // À ne pas manquer (top 5, score le plus haut d'abord).
  api.important().then((d) => {
    refreshImportantBadge(d);
    const kpi = $('#kpi-important');
    if (kpi) kpi.textContent = fmtNum(d.items.length);
    const el = $('#dash-important');
    if (!el) return;
    const top = d.items.slice(0, 5);
    el.innerHTML = top.length
      ? top.map((i, k) => `<div class="op-line">
          ${scoreBadge(i.score)}
          <span style="flex:1"><strong>${esc(i.fromName || i.fromEmail)}</strong> —
            <span class="openable" data-open="${k}" title="Lire le mail">${esc(i.subject)}</span>
            <span class="muted" style="font-size:12px">· ${esc(i.account)}</span></span>
          <span class="op-time">${fmtDate(i.date)}</span>
        </div>`).join('') +
        (d.items.length > 5
          ? `<div class="muted" style="font-size:12px; padding-top:8px">…et ${fmtNum(d.items.length - 5)} autre(s) — <a href="#/important">voir tout</a>.</div>`
          : '')
      : '<div class="empty">Rien d\'important détecté parmi les non-lus des 30 derniers jours.</div>';
    bindOpenables(el, top);
  }).catch(() => {
    const el = $('#dash-important');
    if (el) el.innerHTML = '<div class="empty">Index pas encore prêt.</div>';
  });

  // À répondre (top 5, les plus en retard d'abord).
  api.replies().then((d) => {
    refreshRepliesBadge(d);
    const kpi = $('#kpi-replies');
    if (kpi) {
      kpi.textContent = fmtNum(d.counts.active);
      const oldest = Math.max(0, ...d.items.filter((i) => i.state === 'active').map((i) => i.waitingHours ?? 0));
      if (oldest >= 24) $('#kpi-replies-sub').textContent = `plus ancienne : ${fmtNum(Math.round(oldest / 24))} j`;
    }
    const el = $('#dash-replies');
    if (!el) return;
    const top = d.items.filter((i) => i.state === 'active').slice(0, 5);
    el.innerHTML = top.length
      ? top.map((i, k) => `<div class="op-line">
          <span class="op-time">${fmtDate(i.date)}</span>
          <span style="flex:1"><strong>${esc(i.fromName || i.fromEmail)}</strong> —
            <span class="openable" data-open="${k}" title="Lire le mail">${esc(i.subject)}</span>
            <span class="muted" style="font-size:12px">· ${esc(i.account)}</span></span>
          ${i.overdue ? `<span class="badge red">en retard</span>` : `<span class="badge gray">${waitLabel(i.waitingHours)}</span>`}
        </div>`).join('') +
        (d.counts.active > 5
          ? `<div class="muted" style="font-size:12px; padding-top:8px">…et ${fmtNum(d.counts.active - 5)} autre(s) — <a href="#/replies">voir tout</a>.</div>`
          : '')
      : '<div class="empty">🎉 Rien en attente de réponse sur les 60 derniers jours.</div>';
    bindOpenables(el, top);
  }).catch(() => {
    const el = $('#dash-replies');
    if (el) el.innerHTML = '<div class="empty">Index pas encore prêt — lance une synchronisation.</div>';
  });

  // À relancer (top 3, les plus en retard d'abord).
  api.followups().then((d) => {
    refreshFollowupsBadge(d);
    const kpi = $('#kpi-followups');
    if (kpi) {
      kpi.textContent = fmtNum(d.counts.active);
      const oldest = Math.max(0, ...d.items.filter((i) => i.state === 'active').map((i) => i.waitingHours ?? 0));
      if (oldest >= 24) $('#kpi-followups-sub').textContent = `plus ancien : ${fmtNum(Math.round(oldest / 24))} j`;
    }
    const el = $('#dash-followups');
    if (!el) return;
    const top = d.items.filter((i) => i.state === 'active').slice(0, 3);
    el.innerHTML = top.length
      ? top.map((i, k) => `<div class="op-line">
          <span class="op-time">${fmtDate(i.date)}</span>
          <span style="flex:1"><strong>${esc(i.counterpartyName || i.counterpartyEmail)}</strong> —
            <span class="openable" data-open="${k}" title="Relire ton mail envoyé">${esc(i.subject)}</span>
            <span class="muted" style="font-size:12px">· ${esc(i.account)}</span></span>
          ${i.overdue ? `<span class="badge red">à relancer</span>` : `<span class="badge gray">${waitLabel(i.waitingHours)}</span>`}
        </div>`).join('') +
        (d.counts.active > 3
          ? `<div class="muted" style="font-size:12px; padding-top:8px">…et ${fmtNum(d.counts.active - 3)} autre(s) — <a href="#/followups">voir tout</a>.</div>`
          : '')
      : '<div class="empty">👍 Personne à relancer sur les 60 derniers jours.</div>';
    bindOpenables(el, top, (i) => ({ ...i, fromName: 'Toi (mail envoyé)', fromEmail: '', isSeen: true }));
  }).catch(() => {
    const el = $('#dash-followups');
    if (el) el.innerHTML = '<div class="empty">Index pas encore prêt.</div>';
  });

  // Dates à venir (top 5 futures, proposées + confirmées).
  api.deadlines().then((d) => {
    refreshDeadlinesBadge(d);
    const kpi = $('#kpi-deadlines');
    if (kpi) {
      const upcoming = d.items
        .filter((x) => (x.status === 'proposed' || x.status === 'confirmed') && x.inDays >= -1)
        .sort((a, b) => a.inDays - b.inDays);
      kpi.textContent = fmtNum(upcoming.length);
      if (upcoming[0]) $('#kpi-deadlines-sub').textContent = `prochaine : ${fmtDate(upcoming[0].date)}`;
    }
    const el = $('#dash-deadlines');
    if (!el) return;
    const top = d.items
      .filter((x) => (x.status === 'proposed' || x.status === 'confirmed') && x.inDays >= -1)
      .slice(0, 5);
    el.innerHTML = top.length
      ? top.map((x, k) => `<div class="op-line">
          <span class="op-time">${fmtDate(x.date)}</span>
          <span style="flex:1"><span class="${x.uid != null && x.folder ? 'openable' : ''}"
            ${x.uid != null && x.folder ? `data-open="${k}" title="Lire le mail d'origine"` : ''}>${esc(x.title)}</span>
            <span class="muted" style="font-size:12px">· ${esc(x.account)}</span>
            ${x.status === 'proposed' ? '<span class="badge orange">à valider</span>' : ''}</span>
          <span class="badge ${x.inDays <= 3 ? 'red' : 'gray'}">${deadlineCountdown(x.inDays)}</span>
        </div>`).join('')
      : `<div class="empty">Aucune échéance à venir — lance une
         <a href="#/deadlines">détection</a>.</div>`;
    bindOpenables(el, top, (x) => ({ ...x, subject: x.subject ?? x.title, date: x.msgDate ?? x.date }));
  }).catch(() => {
    const el = $('#dash-deadlines');
    if (el) el.innerHTML = '<div class="empty">Index pas encore prêt.</div>';
  });

  // Mes tâches (top 5, échéances proches en tête).
  api.tasks().then((d) => {
    refreshTasksBadge(d);
    const el = $('#dash-tasks');
    if (!el) return;
    const top = d.items.filter((i) => i.status === 'todo').slice(0, 5);
    el.innerHTML = top.length
      ? top.map((t) => `<div class="op-line">
          <span style="flex:1">${esc(t.title)}
            ${t.account ? `<span class="muted" style="font-size:12px">· ${esc(t.account)}</span>` : ''}</span>
          ${t.dueDate ? `<span class="badge ${t.overdue ? 'red' : t.inDays <= 3 ? 'orange' : 'gray'}">${deadlineCountdown(t.inDays)}</span>` : ''}
        </div>`).join('') +
        (d.counts.todo > 5
          ? `<div class="muted" style="font-size:12px; padding-top:8px">…et ${fmtNum(d.counts.todo - 5)} autre(s) — <a href="#/tasks">voir tout</a>.</div>`
          : '')
      : '<div class="empty">Aucune tâche — ajoute-les depuis un mail ouvert ou une échéance.</div>';
  }).catch(() => {
    const el = $('#dash-tasks');
    if (el) el.innerHTML = '<div class="empty">Tâches indisponibles.</div>';
  });

  bindCleanupButtons(body);

  // Vérification des mises à jour en arrière-plan (une fois par affichage).
  checkForUpdates(body);
}

/**
 * Bandeau de mise à jour, préposé dans `container` quand une version est
 * disponible. C'est le canal de livraison de l'utilisateur : le bandeau vit
 * sur Aujourd'hui (la page d'accueil) ET sur État des boîtes.
 */
function checkForUpdates(container) {
  if (!container) return;
  api.updateCheck().then(({ behind, commits }) => {
    if (!behind || !container.isConnected) return;
    const el = document.createElement('div');
    el.className = 'notice';
    el.innerHTML = `⬆️ <strong>Mise à jour disponible</strong> (${fmtNum(behind)} nouveauté${behind > 1 ? 's' : ''}) :
      <span class="muted">${commits.slice(0, 3).map(esc).join(' · ')}</span>
      <button class="btn btn-primary btn-sm update-btn" style="margin-left:10px">Mettre à jour maintenant</button>`;
    container.prepend(el);
    el.querySelector('.update-btn').addEventListener('click', () => applyUpdateFlow(el));
  }).catch((err) => {
    // Ne PAS rester muet : sans ça, une vérification en échec est
    // indiscernable d'un « tu es à jour » — et on reste sur une vieille
    // version sans jamais le savoir.
    if (!container.isConnected) return;
    const el = document.createElement('div');
    el.className = 'notice warn';
    el.innerHTML = `⚠️ <strong>Impossible de vérifier les mises à jour</strong> —
      ${esc(err.message)}.<br><span class="muted" style="font-size:12.5px">Ferme Mail Assistant
    et relance <strong>MailAssistant.bat</strong> : il récupère le code au démarrage.</span>`;
    container.prepend(el);
  });
}

// Relie tous les [data-open] d'un conteneur au panneau de lecture. `mapFn`
// adapte l'élément (ex. relance → mail envoyé) avant ouverture.
function bindOpenables(root, items, mapFn) {
  root.querySelectorAll('[data-open]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      const raw = items[Number(el.dataset.open)];
      if (!raw) return;
      // On marque la LIGNE d'où part la lecture : c'est le seul moyen fiable
      // de retirer ensuite son badge « non lu ». Chaque écran a sa propre
      // structure (.reply-row, .mail-row, un <tr>…), donc pas de sélecteur
      // universel — mais tous passent par ici.
      openReaderFor(mapFn ? mapFn(raw) : raw, { onRemoved: () => route() });
    });
  });
}

// ---------------------------------------------------------------- Brief (L5)
// Panneau « ☀️ Brief du jour » en tête de dashboard : affiche le dernier brief
// archivé (aucun calcul au chargement), bouton pour en générer un frais.
const briefState = { type: 'daily' };

function initBriefPanel() {
  const typeSel = $('#brief-type');
  typeSel.value = briefState.type;
  typeSel.addEventListener('change', () => {
    briefState.type = typeSel.value === 'weekly' ? 'weekly' : 'daily';
    $('#brief-toggle').innerHTML = `<span id="brief-caret">▾</span> ${
      briefState.type === 'weekly' ? '📆 Revue de la semaine' : '☀️ Brief du jour'
    } <span class="muted brief-when" id="brief-when"></span>`;
    applyBriefCollapsed();
    loadBrief();
  });
  $('#brief-generate').addEventListener('click', generateBriefNow);
  $('#brief-toggle').addEventListener('click', () => {
    const collapsed = localStorage.getItem('bm.briefCollapsed') === '1';
    localStorage.setItem('bm.briefCollapsed', collapsed ? '0' : '1');
    applyBriefCollapsed();
  });
  applyBriefCollapsed();
  loadBrief();
}

function applyBriefCollapsed() {
  const collapsed = localStorage.getItem('bm.briefCollapsed') === '1';
  $('#brief-body')?.classList.toggle('hidden', collapsed);
  const caret = $('#brief-caret');
  if (caret) caret.textContent = collapsed ? '▸' : '▾';
}

async function loadBrief() {
  const body = $('#brief-body');
  if (!body) return;
  body.innerHTML = '<div class="empty"><span class="spinner"></span>Chargement…</div>';
  try {
    const { brief } = await api.brief(briefState.type);
    renderBrief(brief);
  } catch (err) {
    body.innerHTML = `<div class="empty">⚠️ ${esc(err.message)}</div>`;
  }
}

async function generateBriefNow() {
  const btn = $('#brief-generate');
  const body = $('#brief-body');
  if (!btn || !body) return;
  // Un brief replié qu'on régénère, c'est pour le lire : on le déplie.
  localStorage.setItem('bm.briefCollapsed', '0');
  applyBriefCollapsed();
  btn.disabled = true;
  body.innerHTML = '<div class="empty"><span class="spinner"></span>Analyse de tes boîtes…</div>';
  try {
    const { brief } = await api.briefGenerate(briefState.type);
    renderBrief(brief);
  } catch (err) {
    body.innerHTML = `<div class="empty">⚠️ ${esc(err.message)}</div>`;
  } finally {
    btn.disabled = false;
  }
}

function renderBrief(b) {
  const body = $('#brief-body');
  if (!body) return;
  const when = $('#brief-when');
  if (when) when.textContent = b ? `généré le ${fmtDateTime(b.generatedAt)}` : '';
  if (!b) {
    body.innerHTML = `<div class="empty">Aucun brief pour l'instant — clique sur
      <strong>☀️ Régénérer</strong> pour faire le point sur tes boîtes (instantané,
      calculé depuis les mails synchronisés).</div>`;
    return;
  }

  const chip = (icon, n, label, href, cls = '') =>
    `<a class="brief-chip ${cls}" ${href ? `href="${href}"` : ''}>
      ${icon} <strong>${fmtNum(n)}</strong> ${label}</a>`;

  const chips = [
    chip('📥', b.totals.newMessages, `nouveaux (${esc(b.periodLabel)})`, ''),
    chip('🔵', b.totals.unseenInbox, 'non lus au total', ''),
    chip('⭐', b.important.high, 'prioritaires', '#/important', b.important.high ? 'hot' : ''),
    chip('↩️', b.replies.overdue, 'réponses en retard', '#/replies', b.replies.overdue ? 'hot' : ''),
    chip('⏰', b.followups.overdue, 'relances à faire', '#/followups', b.followups.overdue ? 'hot' : ''),
    chip('📅', b.deadlines.upcoming, 'échéances < 14 j', '#/deadlines', b.deadlines.toValidate ? 'hot' : ''),
    ...(b.tasks ? [chip('☑️', b.tasks.todo, 'tâches à faire', '#/tasks', b.tasks.overdue ? 'hot' : '')] : []),
    chip('🧹', b.cleanup.deletableEstimate, 'mails supprimables', ''),
  ].join('');

  const section = (title, rows) =>
    rows.length
      ? `<div class="brief-section"><h3>${title}</h3>${rows.join('')}</div>`
      : '';

  // Sujets cliquables si le brief archivé porte la localisation du mail
  // (les briefs générés avant cette version ne l'ont pas — pas grave).
  const openable = (it, kind, k, text) =>
    it.uid != null && it.folder
      ? `<span class="openable" data-open-kind="${kind}" data-open="${k}" title="Lire le mail">${text}</span>`
      : text;

  const briefImportant = b.important.top.slice(0, 3);
  const importantRows = briefImportant.map(
    (i, k) => `<div class="op-line">${scoreBadge(i.score)}
      <span style="flex:1"><strong>${esc(i.fromName || i.fromEmail)}</strong> — ${openable(i, 'imp', k, esc(i.subject))}
        <span class="muted" style="font-size:12px">· ${esc(i.account)}</span></span>
      <span class="op-time">${fmtDate(i.date)}</span></div>`,
  );
  const briefDeadlines = b.deadlines.items.slice(0, 3);
  const deadlineRows = briefDeadlines.map(
    (d, k) => `<div class="op-line"><span class="op-time">${fmtDate(d.date)}</span>
      <span style="flex:1">${openable(d, 'dl', k, esc(d.title))}
        <span class="muted" style="font-size:12px">· ${esc(d.account)}</span>
        ${d.status === 'proposed' ? '<span class="badge orange">à valider</span>' : ''}</span>
      <span class="badge ${d.inDays <= 3 ? 'red' : 'gray'}">${deadlineCountdown(d.inDays)}</span></div>`,
  );
  const briefReplies = b.replies.top.slice(0, 3);
  const replyRows = briefReplies.map(
    (r, k) => `<div class="op-line"><span class="op-time">${fmtDate(r.date)}</span>
      <span style="flex:1"><strong>${esc(r.fromName || r.fromEmail)}</strong> — ${openable(r, 'rep', k, esc(r.subject))}
        <span class="muted" style="font-size:12px">· ${esc(r.account)}</span></span>
      <span class="badge red">attend depuis ${waitLabel(r.waitingHours)}</span></div>`,
  );
  const briefFollowups = b.followups.top.slice(0, 3);
  const followupRows = briefFollowups.map(
    (f, k) => `<div class="op-line"><span class="op-time">${fmtDate(f.date)}</span>
      <span style="flex:1"><strong>${esc(f.counterpartyName || f.counterpartyEmail)}</strong> — ${openable(f, 'fu', k, esc(f.subject))}
        <span class="muted" style="font-size:12px">· ${esc(f.account)}</span></span>
      <span class="badge red">sans réponse depuis ${waitLabel(f.waitingHours)}</span></div>`,
  );

  const accountsLine = b.accounts
    .map(
      (a) => `<span class="brief-account"><strong>${esc(a.account)}</strong> :
        ${fmtNum(a.newMessages)} nouveau(x) · ${fmtNum(a.inbox.unseen)} non lu(s)</span>`,
    )
    .join(' <span class="muted">|</span> ');

  body.innerHTML = `
    <div class="brief-chips">${chips}</div>
    ${b.previousBrief ? `<div class="muted" style="font-size:12px; margin-bottom:10px">
      Depuis le brief précédent (${fmtDateTime(b.previousBrief.at)}) :
      ${fmtNum(b.previousBrief.newMessagesSince)} nouveau(x) mail(s) synchronisé(s).</div>` : ''}
    <div class="grid-2">
      <div>
        ${section('⭐ À regarder en premier', importantRows)}
        ${section('📅 Dates proches', deadlineRows)}
      </div>
      <div>
        ${section('↩️ Réponses en retard', replyRows)}
        ${section('⏰ À relancer', followupRows)}
      </div>
    </div>
    ${!importantRows.length && !deadlineRows.length && !replyRows.length && !followupRows.length
      ? '<div class="empty">🎉 Rien d\'urgent : pas de mail important non lu, pas de retard, pas d\'échéance proche.</div>'
      : ''}
    ${b.skippedAccounts.length ? `<div class="notice warn" style="margin-top:10px; margin-bottom:6px">
      ⚠️ Compte(s) non couvert(s) : ${b.skippedAccounts
        .map((s) => `<strong>${esc(s.account)}</strong> (${esc(s.error)})`)
        .join(', ')}</div>` : ''}
    <div class="muted" style="font-size:12px; margin-top:8px">${accountsLine}</div>`;

  const kinds = {
    imp: { items: briefImportant },
    dl: { items: briefDeadlines, map: (x) => ({ ...x, subject: x.subject ?? x.title, date: x.msgDate ?? x.date }) },
    rep: { items: briefReplies },
    fu: { items: briefFollowups, map: (f) => ({ ...f, fromName: 'Toi (mail envoyé)', fromEmail: '', isSeen: true }) },
  };
  body.querySelectorAll('[data-open-kind]').forEach((el) => {
    el.addEventListener('click', () => {
      const spec = kinds[el.dataset.openKind];
      const raw = spec?.items[Number(el.dataset.open)];
      if (!raw) return;
      openReaderFor(spec.map ? spec.map(raw) : raw, { onRemoved: () => renderDashboard() });
    });
  });
}

async function applyUpdateFlow(container, confirmed = false) {
  // Sans superviseur (MailAssistant.bat / pm2), le serveur ne PEUT PAS se
  // relancer tout seul apres l'arret : on previent avant, pas apres.
  if (serverVersion && !serverVersion.supervised && !confirmed) {
    container.innerHTML = `<div class="notice warn">\u26a0\ufe0f Ton serveur n'a pas \u00e9t\u00e9 lanc\u00e9 via
      <strong>MailAssistant.bat</strong> : apr\u00e8s la mise \u00e0 jour il s'arr\u00eatera et
      <strong>ne red\u00e9marrera pas tout seul</strong>. Le mieux : ferme le serveur, relance-le en
      double-cliquant <strong>MailAssistant.bat</strong> (il se mettra \u00e0 jour au passage), et
      utilise ce bouton les prochaines fois.<br><br>
      <button class="btn" id="update-anyway">Mettre \u00e0 jour quand m\u00eame (je relancerai \u00e0 la main)</button></div>`;
    $('#update-anyway').addEventListener('click', () => applyUpdateFlow(container, true));
    return;
  }

  container.innerHTML = `<span class="spinner"></span><strong>Mise \u00e0 jour en cours\u2026</strong>
    le serveur va red\u00e9marrer, la page reviendra automatiquement.
    <div class="sync-log" id="update-log"></div>`;
  let jobId;
  try {
    ({ jobId } = await api.updateApply());
  } catch (err) {
    container.innerHTML = `\u26a0\ufe0f ${esc(err.message)}`;
    return;
  }
  const log = $('#update-log');
  const supervised = !serverVersion || serverVersion.supervised;
  let waiting = false;
  const poll = setInterval(async () => {
    try {
      const j = await api.job(jobId);
      log.textContent = j.progress.slice(-25).join('\n');
      log.scrollTop = log.scrollHeight;
      if (j.status === 'error') {
        clearInterval(poll);
        container.innerHTML = `<div class="notice warn">\u274c \u00c9chec de la mise \u00e0 jour : ${esc(j.error ?? '')}</div>`;
      }
      // status 'done' n'arrive jamais : le serveur red\u00e9marre avant.
    } catch {
      // Le serveur vient de s'arr\u00eater.
      if (waiting) return;
      waiting = true;
      clearInterval(poll);
      if (!supervised) {
        container.innerHTML = `<div class="notice warn">\ud83d\udca4 Le serveur s'est arr\u00eat\u00e9 pour appliquer
          la mise \u00e0 jour. <strong>Relance MailAssistant.bat</strong> (ou <code>npm start</code>),
          puis recharge cette page.</div>`;
        return;
      }
      log.textContent += '\nRed\u00e9marrage du serveur\u2026 (rapide si rien \u00e0 recompiler, quelques minutes sinon)';
      const startedWait = Date.now();
      // Sur quelle machine tourne le serveur ? Le message d'aide n'est pas le
      // m\u00eame : \u00ab fen\u00eatre MailAssistant.bat \u00bb n'a aucun sens sur le serveur
      // en ligne (constat\u00e9 le 01/08 : bandeau Windows affich\u00e9 sur boxmail.lb2i.com).
      const onWindows = !serverVersion?.platform || serverVersion.platform === 'win32';
      let patienceShown = false;
      const waitUp = setInterval(async () => {
        try {
          if (await api.health()) {
            clearInterval(waitUp);
            location.reload();
            return;
          }
        } catch { /* pas encore pr\u00eat */ }
        const elapsed = Date.now() - startedWait;
        log.textContent = log.textContent.replace(/\n\u23f3.*$/, '') +
          `\n\u23f3 ${Math.round(elapsed / 1000)} s\u2026`;
        log.scrollTop = log.scrollHeight;
        // Point d'\u00e9tape \u00e0 3 min : c'est LONG mais NORMAL quand les d\u00e9pendances
        // ou le code serveur ont chang\u00e9 \u2014 on rassure au lieu d'alarmer.
        if (!patienceShown && elapsed > 180_000) {
          patienceShown = true;
          log.textContent += '\nToujours en cours \u2014 une mise \u00e0 jour avec d\u00e9pendances ou compilation peut prendre plusieurs minutes. Cette page continue de v\u00e9rifier.';
        }
        if (elapsed > 600_000) {
          clearInterval(waitUp);
          container.innerHTML = onWindows
            ? `<div class="notice warn">\u23f1\ufe0f Le serveur n'est pas revenu apr\u00e8s 10 minutes.
              V\u00e9rifie la fen\u00eatre noire <strong>MailAssistant.bat</strong> (elle affiche peut-\u00eatre une
              erreur), relance-la si besoin, puis recharge cette page.</div>`
            : `<div class="notice warn">\u23f1\ufe0f Le serveur n'est pas revenu apr\u00e8s 10 minutes.
              Recharge cette page dans quelques minutes ; si \u00e7a persiste, le r\u00e9sultat de la
              mise \u00e0 jour est visible dans \u2699\ufe0f Param\u00e8tres \u2192 \u00ab Mise \u00e0 jour \u00bb une fois le
              serveur revenu.</div>`;
        }
      }, 2000);
    }
  }, 1200);
}

function bindCleanupButtons(root) {
  root.querySelectorAll('.cleanup-btn').forEach((btn) => {
    btn.addEventListener('click', () =>
      openCleanupModal(btn.dataset.account, btn.dataset.sender, btn.dataset.name),
    );
  });
}

function opLine(op) {
  const p = op.params ?? {};
  const n = p.count ?? op.affectedUids?.length ?? 0;
  const senderLabel = p.senderName && p.senderName !== p.sender
    ? `${esc(p.senderName)} (${esc(p.sender ?? '')})`
    : esc(p.sender ?? '');

  let title;
  switch (op.tool) {
    case 'ui_cleanup_sender':
      title = `🗑️ <strong>${fmtNum(n)} mails</strong> de <strong>${senderLabel}</strong> → corbeille` +
        (p.batch ? ` <span class="muted">(lot ${esc(p.batch)})</span>` : '') +
        (p.batches > 1 ? ` <span class="muted">(en ${fmtNum(p.batches)} lots de 200)</span>` : '');
      break;
    case 'snooze_reply':
      title = `⏰ Réponse reportée de <strong>${fmtNum(p.days ?? '?')} jour(s)</strong>`;
      break;
    case 'dismiss_reply':
      title = `🔕 Fil ignoré <span class="muted">(pas de réponse nécessaire)</span>`;
      break;
    case 'restore_reply':
      title = `↩️ Fil remis dans « À répondre »`;
      break;
    case 'snooze_followup':
      title = `⏰ Relance reportée de <strong>${fmtNum(p.days ?? '?')} jour(s)</strong>`;
      break;
    case 'mark_followup_done':
      title = `✓ Relance marquée traitée`;
      break;
    case 'restore_followup':
      title = `↩️ Fil remis dans « À relancer »`;
      break;
    case 'detect_deadlines':
      title = `📅 <strong>${fmtNum(p.created ?? 0)} échéance(s)</strong> détectée(s) et proposée(s)`;
      break;
    case 'confirm_deadline':
      title = `📅 Échéance confirmée`;
      break;
    case 'dismiss_deadline':
      title = `📅 Échéance ignorée`;
      break;
    case 'complete_deadline':
      title = `📅 Échéance marquée faite`;
      break;
    case 'restore_deadline':
      title = `📅 Échéance rétablie`;
      break;
    case 'bulk_delete_by_sender':
      title = `🗑️ <strong>${fmtNum(n)} mails</strong> de <strong>${senderLabel}</strong> → corbeille <span class="muted">(via Claude)</span>`;
      break;
    case 'delete_emails':
      title = `🗑️ <strong>${fmtNum(n)} mails</strong> → corbeille <span class="muted">(via Claude)</span>`;
      break;
    case 'ui_delete_message':
      title = `🗑️ <strong>1 mail</strong> → corbeille <span class="muted">(depuis la recherche)</span>`;
      break;
    case 'ui_move_message':
      title = `📦 <strong>1 mail</strong> déplacé vers <strong>${esc(p.destination ?? '?')}</strong> <span class="muted">(depuis la recherche)</span>`;
      break;
    case 'ui_restore_message':
      title = `↩️ <strong>${fmtNum(n)} mail(s)</strong> ramené(s) de la corbeille <span class="muted">(annulation)</span>`;
      break;
    case 'ui_accounting_send':
      title = `🧾 <strong>1 facture</strong> transmise à Fiscal Manager <span class="muted">(depuis un mail)</span>`;
      break;
    case 'accounting_detect':
      title = `🧾 <strong>${fmtNum(n)} pièce(s) comptable(s)</strong> repérée(s) <span class="muted">(détection automatique)</span>`;
      break;
    case 'accounting_attachment_download':
      title = `🧾 Pièce <strong>${esc(p.filename ?? '')}</strong> servie à Fiscal Manager`;
      break;
    case 'ui_mark_message':
      title = `🏷️ <strong>1 mail</strong> marqué « ${p.flag === 'seen' ? 'lu' : 'non lu'} »`;
      break;
    case 'ui_bulk_delete':
      title = `🗑️ <strong>${fmtNum(n)} mails</strong> → corbeille <span class="muted">(sélection boîte de réception)</span>`;
      break;
    case 'ui_bulk_move':
      title = `📦 <strong>${fmtNum(n)} mails</strong> déplacés vers <strong>${esc(p.destination ?? '?')}</strong> <span class="muted">(sélection)</span>`;
      break;
    case 'ui_bulk_mark':
      title = `🏷️ <strong>${fmtNum(n)} mails</strong> marqués « ${p.action === 'seen' ? 'lus' : 'non lus'} »`;
      break;
    case 'ui_send_mail':
      title = `✉️ Mail envoyé — <strong>${esc(p.subject ?? '')}</strong> à ${esc(((p.to ?? [])).join(', '))}` +
        (p.mode === 'reply' ? ' <span class="muted">(réponse)</span>' : p.mode === 'forward' ? ' <span class="muted">(transfert)</span>' : '');
      break;
    case 'propose_deadline':
      title = `📅 Échéance proposée depuis un mail ouvert`;
      break;
    case 'create_task':
      title = `☑️ Tâche créée`;
      break;
    case 'task_from_deadline':
      title = `☑️ Tâche créée depuis une échéance`;
      break;
    case 'complete_task':
      title = `☑️ Tâche terminée`;
      break;
    case 'dismiss_task':
      title = `☑️ Tâche ignorée`;
      break;
    case 'reopen_task':
      title = `☑️ Tâche remise à faire`;
      break;
    case 'move_emails':
      title = `📦 <strong>${fmtNum(n)} mails</strong> déplacés vers <strong>${esc(p.destination ?? '?')}</strong>`;
      break;
    case 'mark_emails':
      title = `🏷️ <strong>${fmtNum(n)} mails</strong> marqués « ${esc(p.flag ?? '')} »`;
      break;
    case 'create_folder':
      title = `📁 Dossier <strong>${esc(p.path ?? '')}</strong> créé`;
      break;
    case 'ai_analysis':
      title = op._group && op._group.batches > 1
        ? `🤖 <strong>${fmtNum(op._group.count)} mails</strong> analysés par l'IA <span class="muted">(${fmtNum(op._group.batches)} lots)</span>`
        : `🤖 <strong>${fmtNum(p.verdicts ?? op.items?.length ?? 0)} mails</strong> analysés par l'IA`;
      break;
    case 'grand_menage':
      title = `🧺 <strong>${fmtNum(n)} mails</strong> → corbeille <span class="muted">(Libérer de l'espace${p.label ? ` — ${esc(p.label)}` : ''})</span>`;
      break;
    case 'retention_auto_apply':
      title = `🧹 <strong>${fmtNum(n)} mails</strong> → corbeille <span class="muted">(nettoyage automatique${p.label ? ` — ${esc(p.label)}` : ''})</span>`;
      break;
    case 'apply_mail_rule':
    case 'rule_auto_apply':
      title = `🗂️ <strong>${fmtNum(n)} mails</strong> rangés${p.targetFolder ? ` vers <strong>${esc(p.targetFolder)}</strong>` : ''}` +
        (op.tool === 'rule_auto_apply' ? ' <span class="muted">(règle automatique)</span>' : ' <span class="muted">(règle de classement)</span>');
      break;
    case 'ui_message_intent':
      title = `🏷️ Classement d'un mail corrigé${op.result ? ` <span class="muted">— ${esc(op.result)}</span>` : ''}`;
      break;
    case 'ui_sender_category':
    case 'set_sender_category':
      title = `👤 Catégorie d'un expéditeur corrigée${p.email ? ` <span class="muted">— ${esc(p.email)}</span>` : ''}`;
      break;
    case 'ui_sender_priority':
    case 'set_sender_priority':
      title = `⭐ Priorité d'un expéditeur modifiée${p.email ? ` <span class="muted">— ${esc(p.email)}</span>` : ''}`;
      break;
    case 'ui_analysis_feedback':
      title = `🎯 ${esc(op.result ?? 'Analyse vérifiée')}`;
      break;
    case 'ui_suggestion_dismiss':
      title = `💡 Règle proposée ignorée`;
      break;
    case 'ui_accounts_order':
      title = `⚙️ Ordre des boîtes modifié`;
      break;
    case 'ui_account_color':
      title = `🎨 Couleur d'une boîte modifiée`;
      break;
    case 'ui_account_rename':
      title = `✏️ Boîte renommée${p.to ? ` <span class="muted">— ${esc(p.to)}</span>` : ''}`;
      break;
    case 'ui_account_remove':
      title = `🗑️ Boîte retirée de Mail Assistant <span class="muted">(les mails chez Microsoft ne bougent pas)</span>`;
      break;
    case 'ui_accounts_export':
      title = `📦 Accès des boîtes exportés`;
      break;
    case 'ui_accounts_import':
      title = `📦 Accès de boîtes importés`;
      break;
    case 'ui_backup_create':
      title = `💾 Sauvegarde créée`;
      break;
    case 'ui_unsubscribe':
      title = `🚫 Désinscription demandée${p.email ? ` <span class="muted">— ${esc(p.email)}</span>` : ''}`;
      break;
    case 'ui_unsubscribe_manual':
      title = `🚫 Désinscription marquée faite${p.email ? ` <span class="muted">— ${esc(p.email)}</span>` : ''}`;
      break;
    default:
      // Le journal serveur porte souvent une phrase de résultat en français :
      // on la préfère toujours au nom technique de l'opération.
      title = op.result
        ? `${esc(op.result)} <span class="muted" style="font-size:11px" title="opération : ${esc(op.tool ?? '')}"></span>`
        : `⚙️ ${esc(op.tool ?? 'opération')}`;
  }

  const meta = [op.account, op.folder].filter(Boolean).map(esc).join(' · ');
  // Chaque mail listé est OUVRABLE quand le journal a gardé son dossier et son
  // UID (c'est le cas quand l'opération ne l'a pas déplacé). Sinon on affiche
  // le sujet en texte simple plutôt qu'un lien qui échouerait.
  const opItem = (i) => {
    const date = `<span class="mail-date">${fmtDate(i.date)}</span>`;
    if (!i.folder || !i.uid) return `<div>${date} ${esc(i.subject)}</div>`;
    return `<div>${date} <a href="#" class="op-open" title="Ouvrir ce mail"
      data-op-open="1" data-acc="${esc(op.account ?? '')}" data-folder="${esc(i.folder)}"
      data-uid="${Number(i.uid)}" data-subject="${esc(i.subject)}"
      data-date="${esc(i.date ?? '')}">${esc(i.subject)}</a></div>`;
  };
  const items = Array.isArray(op.items) && op.items.length
    ? `<details class="op-details"><summary>Voir les ${fmtNum(op.items.length)} mails concernés</summary>
       <div class="op-items">${op.items.map(opItem).join('')}</div></details>`
    : '';

  return `<div class="op-line"><span class="op-time">${fmtDateTime(op.ts)}</span>
    <span style="flex:1">${title}
    ${op.dryRun ? '<span class="badge gray">simulation — rien touché</span>' : ''}
    <span class="muted" style="font-size:12px">— ${meta}</span>${items}</span></div>`;
}

// ---------------------------------------------------------------- Vue compte
const statsState = { sortKey: 'count', sortDir: -1, data: null, selected: new Map() };

// Catégories d'expéditeur (A1 — mêmes valeurs que le serveur, libellés FR).
const SENDER_CATEGORY_LABELS = {
  person: '👤 Personne',
  company: '🏢 Entreprise',
  bank: '🏦 Banque / argent',
  insurance: '🛡️ Assurance',
  admin: '🏛️ Administration',
  marketplace: '🛒 Boutique en ligne',
  social: '💬 Réseau social',
  newsletter: '📰 Newsletter',
  notification: '🤖 Notification',
  ad: '📢 Publicité',
};

const FOLDER_ROLE_EMOJI = {
  inbox: '📥', sent: '📤', drafts: '📝', trash: '🗑️', archive: '📦', spam: '⚠️', custom: '📂',
};

async function renderAccount(slug) {
  const main = $('#main');
  const enrolled = overviewCache?.enrolled.find((e) => e.account === slug);
  main.innerHTML = `<div class="page-head">
      <div><h1>📧 ${esc(slug)}</h1><div class="sub">${esc(enrolled?.username ?? '')}</div></div>
      <div class="head-actions">
        <a class="btn" href="#/inbox/${esc(slug)}">Parcourir les mails</a>
        <button class="btn btn-primary" id="sync-recent">Sync rapide</button>
        <button class="btn" id="sync-full">Sync complète</button>
      </div></div>
    <div id="sync-zone"></div>
    <div id="account-body"><div class="empty"><span class="spinner"></span>Chargement…</div></div>`;

  $('#sync-recent').addEventListener('click', () => runSync(slug, 'recent'));
  $('#sync-full').addEventListener('click', () => runSync(slug, 'full'));

  // Sync automatique juste après un enrôlement réussi.
  if (pendingAutoSync === slug) {
    pendingAutoSync = null;
    runSync(slug, 'full');
  } else {
    // Résultat de la dernière sync de cette boîte, s'il vient de tomber.
    if (lastSyncResult?.slug === slug) {
      $('#sync-zone').innerHTML = lastSyncResult.html;
      lastSyncResult = null;
    }
    // Une sync tourne déjà pour cette boîte ? On raccroche l'affichage.
    api.jobs().then(({ jobs }) => {
      const j = jobs.find((x) => x.status === 'running' && x.kind === `sync:${slug}`);
      if (j) attachSyncJob(slug, j.id);
    }).catch(() => {});
  }

  const body = $('#account-body');
  let ov = null;
  try {
    ov = await api.accountOverview(slug);
  } catch (err) {
    body.innerHTML = `<div class="notice warn">⚠️ ${esc(err.message)}<br>
      Lance une <strong>Sync complète</strong> (bouton en haut à droite) pour indexer cette boîte.</div>`;
    return;
  }

  body.innerHTML = `
    <div class="cards">
      <div class="kpi"><div class="kpi-label">📥 INBOX</div>
        <div class="kpi-value">${fmtNum(ov.inbox?.messages ?? 0)}</div></div>
      <div class="kpi accent"><div class="kpi-label">🔵 Non lus</div>
        <div class="kpi-value">${fmtNum(ov.inbox?.unseen ?? 0)}</div></div>
      <div class="kpi orange"><div class="kpi-label">📰 Newsletters</div>
        <div class="kpi-value">${fmtNum(ov.inbox?.newsletters ?? 0)}</div></div>
      <div class="kpi"><div class="kpi-label">💾 Espace boîte</div>
        <div class="kpi-value" style="font-size:20px; ${ov.quota && ov.quota.pct >= 90 ? `color:${quotaColor(ov.quota.pct)}` : ''}">
          ${ov.quota ? `${ov.quota.pct}%` : fmtSize(ov.inbox?.totalSizeBytes)}</div>
        <div class="kpi-sub" ${ov.quota ? '' : `title="${esc(ov.quotaNote || '')}"`}>${ov.quota
          ? `${fmtSize(ov.quota.usedBytes)} / ${fmtSize(ov.quota.limitBytes)} · libre : ${fmtSize(ov.quota.freeBytes)}`
          : `quota inconnu — ${esc(ov.quotaNote || 'synchronise la boîte (ou 📏 Quota dans Paramètres)')}`}</div></div>
      <div class="kpi"><div class="kpi-label">👥 Expéditeurs</div>
        <div class="kpi-value">${fmtNum(ov.senderCount)}</div>
        <div class="kpi-sub">dernière sync : ${fmtDateTime(ov.lastSyncAt)}</div></div>
    </div>

    <div class="panel">
      <div class="panel-head"><h2>📂 Dossiers</h2>
        <span class="muted" style="font-size:12.5px">clique un dossier pour lire ses mails</span></div>
      <div class="panel-body tight">
        <table><thead><tr><th>Dossier</th><th class="num">Mails</th><th class="num">Non lus</th><th></th></tr></thead>
        <tbody>${ov.folders
          .filter((f) => f.messageCount > 0 || ['inbox', 'sent', 'trash', 'drafts'].includes(f.role))
          .map((f) => `<tr>
            <td><span class="openable" data-folder="${esc(f.path)}" title="Lire les mails de ce dossier">
              ${FOLDER_ROLE_EMOJI[f.role] ?? '📂'} ${esc(f.path)}</span></td>
            <td class="num">${fmtNum(f.messageCount)}</td>
            <td class="num">${f.unseenCount ? `<span class="badge orange">${fmtNum(f.unseenCount)}</span>` : '—'}</td>
            <td style="text-align:right"><button class="btn btn-sm" data-folder="${esc(f.path)}">📖 Lire</button></td>
          </tr>`).join('')}</tbody></table>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head"><h2>Statistiques par expéditeur</h2>
        <div class="filters">
          <select id="f-folder">${ov.folders
            .filter((f) => f.messageCount > 0 || f.role === 'inbox')
            .map((f) => `<option value="${esc(f.path)}" ${f.role === 'inbox' ? 'selected' : ''}>${esc(f.path)} (${fmtNum(f.messageCount)})</option>`)
            .join('')}</select>
          <input type="date" id="f-since" title="Depuis le…">
          <select id="f-limit"><option>25</option><option selected>50</option><option>100</option><option>200</option></select>
          <button class="btn btn-sm" id="f-apply">Filtrer</button>
        </div></div>
      <div class="panel-body tight" id="stats-table"><div class="empty"><span class="spinner"></span></div></div>
    </div>
    <div id="account-cleanup"></div>`;

  body.querySelectorAll('[data-folder]').forEach((el) => {
    el.addEventListener('click', () => {
      inboxState.account = slug;
      localStorage.setItem('bm.inboxAccount', slug);
      inboxState.role = 'inbox';
      inboxState.folder = el.dataset.folder;
      inboxState.offset = 0;
      inboxState.selected.clear();
      location.hash = `#/inbox/${encodeURIComponent(slug)}`;
    });
  });

  $('#f-apply').addEventListener('click', () => loadStats(slug));
  await loadStats(slug);
  loadAccountCleanup(slug);
}

async function loadAccountCleanup(slug) {
  const el = $('#account-cleanup');
  if (!el) return;
  let data;
  try {
    data = await api.cleanup(slug);
  } catch {
    return;
  }
  if (!data.candidates.length) return;
  el.innerHTML = `<div class="panel">
    <div class="panel-head"><h2>🧹 Nettoyage rapide</h2>
      <span class="badge green">${fmtNum(data.totalDeletableEstimate)} mails « sûrs »</span></div>
    <div class="panel-body tight">
      <table><thead><tr><th>Expéditeur</th><th class="num">Mails</th><th class="num">Non lus</th>
        <th class="num">Taille</th><th>Risque</th><th>Pourquoi</th><th></th></tr></thead>
      <tbody>${data.candidates.map((c) => `<tr>
        <td>${esc(c.senderName || c.sender)}<br><span class="muted" style="font-size:12px">${esc(c.sender)}</span></td>
        <td class="num">${fmtNum(c.messageCount)}${c.keepCount ? `<br><span class="badge green" style="font-weight:600" title="Pièce jointe, facture, ticket : jamais proposés">📄 ${fmtNum(c.keepCount)} gardés</span>` : ''}</td>
        <td class="num">${fmtNum(c.unseenCount)}</td>
        <td class="num">${fmtSize(c.totalSizeBytes)}</td>
        <td><span class="badge ${c.riskLevel === 'safe' ? 'green' : 'orange'}">${c.riskLevel === 'safe' ? 'Sûr' : 'Moyen'}</span></td>
        <td class="muted" style="font-size:12px; max-width:260px">${esc(c.reason)}</td>
        <td><button class="btn btn-sm cleanup-btn" data-account="${esc(slug)}"
          data-sender="${esc(c.sender)}" data-name="${esc(c.senderName || c.sender)}">🧹 Nettoyer</button></td>
      </tr>`).join('')}</tbody></table>
    </div></div>`;
  bindCleanupButtons(el);
}

async function loadStats(slug) {
  const el = $('#stats-table');
  el.innerHTML = '<div class="empty"><span class="spinner"></span>Analyse…</div>';
  try {
    const data = await api.stats(slug, {
      folder: $('#f-folder').value,
      since: $('#f-since').value,
      limit: Number($('#f-limit').value),
    });
    statsState.data = data;
    statsState.selected.clear();
    renderStatsTable();
  } catch (err) {
    el.innerHTML = `<div class="empty">⚠️ ${esc(err.message)}</div>`;
  }
}

function renderStatsTable() {
  const el = $('#stats-table');
  const { data, sortKey, sortDir } = statsState;
  if (!data) return;
  const senders = [...data.senders].sort((a, b) => {
    const va = a[sortKey] ?? 0;
    const vb = b[sortKey] ?? 0;
    return (va < vb ? -1 : va > vb ? 1 : 0) * sortDir;
  });
  const th = (key, label, num = true) =>
    `<th class="${num ? 'num' : ''} ${sortKey === key ? 'sorted' : ''}" data-sort="${key}">${label}
     ${sortKey === key ? (sortDir < 0 ? '↓' : '↑') : ''}</th>`;

  const sel = statsState.selected;
  el.innerHTML = `
    <div id="export-bar" class="export-bar ${sel.size ? '' : 'hidden'}"></div>
    <table><thead><tr>
      <th style="width:30px"><input type="checkbox" id="stats-check-all" title="Tout cocher / décocher"></th>
      <th data-sort="address">Expéditeur</th>
      <th ${sortKey === 'category' ? 'class="sorted"' : ''} data-sort="category">Catégorie ${sortKey === 'category' ? (sortDir < 0 ? '↓' : '↑') : ''}</th>
      ${th('count', 'Mails')}${th('totalSizeBytes', 'Taille')}${th('unsubscribePct', 'Newsletter')}${th('latestDate', 'Dernier mail')}
    </tr></thead>
    <tbody>${senders
      .map(
        (s) => `<tr>
        <td><input type="checkbox" class="stats-check" data-address="${esc(s.address)}"
          data-name="${esc(s.name || '')}" ${sel.has(s.address) ? 'checked' : ''}></td>
        <td>${esc(s.name || s.address)}<br><span class="muted" style="font-size:12px">${esc(s.address)}</span></td>
        <td style="white-space:nowrap">
          <select class="stats-cat" data-address="${esc(s.address)}"
            title="${esc(s.categoryReason || 'Catégorie non calculée — lance « Réexaminer les expéditeurs » dans ⚙️ Paramètres')}">
            <option value="" ${s.category ? '' : 'selected'}>${s.category ? '↺ automatique' : '—'}</option>
            ${Object.entries(SENDER_CATEGORY_LABELS)
              .map(([v, l]) => `<option value="${v}" ${s.category === v ? 'selected' : ''}>${l}</option>`)
              .join('')}
          </select>${s.categorySource === 'manual' ? ` <span title="${esc(s.categoryReason || 'Catégorie verrouillée')} — la sync ne l’écrase pas">✍️</span>` : ''}
          <select class="stats-prio" data-address="${esc(s.address)}"
            title="Priorité par relation : ⭐ booste l'importance de tous ses mails, 🔕 la plafonne">
            <option value="normal" ${s.priority === 'normal' || !s.priority ? 'selected' : ''}>Priorité normale</option>
            <option value="always_important" ${s.priority === 'always_important' ? 'selected' : ''}>⭐ Toujours important</option>
            <option value="never_urgent" ${s.priority === 'never_urgent' ? 'selected' : ''}>🔕 Jamais urgent</option>
          </select></td>
        <td class="num"><strong>${fmtNum(s.count)}</strong></td>
        <td class="num">${fmtSize(s.totalSizeBytes)}</td>
        <td class="num">${s.unsubscribePct > 0 ? `<span class="badge ${s.unsubscribePct >= 80 ? 'orange' : 'gray'}">${s.unsubscribePct}%</span>` : '—'}</td>
        <td class="num">${fmtDate(s.latestDate)}</td>
      </tr>`,
      )
      .join('')}</tbody></table>
    <div class="panel-body muted" style="font-size:12.5px">
      ${fmtNum(data.totalMessages)} messages analysés (instantané).
      Coche des expéditeurs pour les exporter en contacts (.vcf/.csv). La catégorie sert à
      l'assistant (accueil, nettoyage) : corrige-la si elle est fausse — ton choix est conservé.</div>`;

  el.querySelectorAll('th[data-sort]').forEach((thEl) => {
    thEl.addEventListener('click', () => {
      const key = thEl.dataset.sort;
      if (statsState.sortKey === key) statsState.sortDir *= -1;
      else {
        statsState.sortKey = key;
        statsState.sortDir = -1;
      }
      renderStatsTable();
    });
  });

  renderExportBar();
  const checkAll = $('#stats-check-all');
  checkAll.checked = senders.length > 0 && senders.every((s) => sel.has(s.address));
  checkAll.addEventListener('change', () => {
    for (const s of senders) {
      if (checkAll.checked) sel.set(s.address, s.name || '');
      else sel.delete(s.address);
    }
    renderStatsTable();
  });
  el.querySelectorAll('.stats-check').forEach((box) => {
    box.addEventListener('change', () => {
      if (box.checked) sel.set(box.dataset.address, box.dataset.name);
      else sel.delete(box.dataset.address);
      renderExportBar();
    });
  });

  // Priorité par relation (A5) : ⭐ toujours important / 🔕 jamais urgent.
  el.querySelectorAll('.stats-prio').forEach((select) => {
    select.addEventListener('change', async () => {
      const slug = decodeURIComponent(location.hash.split('/')[2] ?? '');
      select.disabled = true;
      try {
        const r = await api.senderSetPriority(slug, select.dataset.address, select.value);
        const row = statsState.data.senders.find((s) => s.address === select.dataset.address);
        if (row) row.priority = r.priority;
        renderStatsTable();
      } catch (err) {
        alert(err.message);
        select.disabled = false;
      }
    });
  });

  // Correction manuelle de la catégorie (A1) — « ↺ automatique » = recalcul.
  el.querySelectorAll('.stats-cat').forEach((select) => {
    select.addEventListener('change', async () => {
      const slug = decodeURIComponent(location.hash.split('/')[2] ?? '');
      select.disabled = true;
      try {
        const r = await api.senderSetCategory(slug, select.dataset.address, select.value || null);
        const row = statsState.data.senders.find((s) => s.address === select.dataset.address);
        if (row) {
          row.category = r.category;
          row.categorySource = r.source;
          row.categoryReason = r.reason;
        }
        renderStatsTable();
      } catch (err) {
        alert(err.message);
        select.disabled = false;
      }
    });
  });
}

// Barre d'action au-dessus du tableau : export de la sélection en contacts.
function renderExportBar() {
  const bar = $('#export-bar');
  if (!bar) return;
  const sel = statsState.selected;
  bar.classList.toggle('hidden', sel.size === 0);
  if (sel.size === 0) return;
  bar.innerHTML = `📇 <strong>${fmtNum(sel.size)}</strong> contact(s) sélectionné(s)
    <button class="btn btn-sm btn-primary" id="export-vcf">⬇ Exporter .vcf</button>
    <button class="btn btn-sm" id="export-csv">⬇ Exporter .csv</button>
    <button class="btn btn-sm" id="export-clear">Tout décocher</button>
    <span class="muted" style="font-size:12px">puis importe le fichier dans Outlook.com → Contacts → Gérer → Importer</span>`;
  $('#export-vcf').addEventListener('click', () => downloadContacts('vcard'));
  $('#export-csv').addEventListener('click', () => downloadContacts('csv'));
  $('#export-clear').addEventListener('click', () => {
    sel.clear();
    renderStatsTable();
  });
}

async function downloadContacts(format) {
  const slug = decodeURIComponent((location.hash.split('/')[2] ?? ''));
  const senders = [...statsState.selected.entries()].map(([address, name]) => ({ address, name }));
  try {
    const res = await fetch(`/api/accounts/${encodeURIComponent(slug)}/export-contacts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ senders, format }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error(data?.error || `Erreur ${res.status}`);
    }
    const disposition = res.headers.get('Content-Disposition') ?? '';
    const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ??
      `contacts.${format === 'csv' ? 'csv' : 'vcf'}`;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (err) {
    alert(err.message);
  }
}

// ---------------------------------------------------------------- Sync + jobs
// Résultat de la dernière sync, affiché au prochain rendu de la vue du compte.
let lastSyncResult = null; // { slug, html }

async function runSync(slug, mode) {
  let jobId;
  try {
    ({ jobId } = await api.startSync(slug, mode));
  } catch (err) {
    const zone = $('#sync-zone');
    if (zone) zone.innerHTML = `<div class="notice warn">⚠️ ${esc(err.message)}</div>`;
    return;
  }
  attachSyncJob(slug, jobId);
  pollJobs();
}

/**
 * Affiche/raccroche la progression d'une sync. La tâche vit côté serveur :
 * changer de page ne l'interrompt pas, et revenir sur la boîte raccroche
 * automatiquement l'affichage (via renderAccount).
 */
function attachSyncJob(slug, jobId) {
  const zone = $('#sync-zone');
  if (zone) {
    zone.innerHTML = `<div class="notice"><span class="spinner"></span>
      Synchronisation de <strong>${esc(slug)}</strong> en cours — tu peux changer de page,
      elle continue en arrière-plan (voir l'indicateur en bas à droite).
      <div class="sync-log" id="sync-log"></div></div>`;
  }
  const timer = setInterval(async () => {
    let j;
    try {
      j = await api.job(jobId);
    } catch {
      clearInterval(timer);
      return;
    }
    const log = $('#sync-log');
    if (log) {
      log.textContent = j.progress.slice(-30).join('\n');
      log.scrollTop = log.scrollHeight;
    }
    if (j.status !== 'running') {
      clearInterval(timer);
      const r = j.result ?? {};
      lastSyncResult = {
        slug,
        html:
          j.status === 'done'
            ? `<div class="notice">✅ Sync terminée en ${((r.durationMs ?? 0) / 1000).toFixed(1)}s —
               ${fmtNum(r.newMessages ?? 0)} nouveaux, ${fmtNum(r.deletedMessages ?? 0)} disparus,
               ${fmtNum(r.foldersSynced?.length ?? 0)} dossiers.${
                 r.errors?.length ? ` ⚠️ ${r.errors.length} dossier(s) en échec.` : ''
               }</div>`
            : `<div class="notice warn">❌ Échec de la sync : ${esc(j.error ?? '')}</div>`,
      };
      await refreshOverview();
      // Ne re-rend la vue que si l'utilisateur regarde encore cette boîte.
      if (location.hash === `#/account/${encodeURIComponent(slug)}`) renderAccount(slug);
    }
  }, 1200);
}

// ---------------------------------------------------------------- Modale nettoyage
function closeModal() {
  document.querySelector('.modal-overlay')?.remove();
}

async function openCleanupModal(account, sender, senderName) {
  closeModal();
  const overlay = document.createElement('div');
  // under-reader : le panneau de lecture s'ouvre AU-DESSUS de cette modale.
  // Sans cette classe, rendre un sujet cliquable ne servirait à rien — le
  // lecteur (z 96) passerait derrière l'overlay (z 100).
  overlay.className = 'modal-overlay under-reader';
  overlay.innerHTML = `<div class="modal modal-wide">
    <div class="modal-head"><h2>🧹 Nettoyer « ${esc(senderName)} » ${accountChip(account)}</h2>
      <button class="modal-close" title="Fermer">✕</button></div>
    <div class="modal-body" id="modal-body"><div class="empty"><span class="spinner"></span>Analyse…</div></div>
    <div class="modal-foot" id="modal-foot"></div>
  </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('.modal-close').addEventListener('click', closeModal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });

  // Étape 1 : aperçu + liste complète classée (index local, ne touche à rien).
  let preview, list;
  try {
    [preview, list] = await Promise.all([
      api.cleanupPreview(account, sender),
      api.cleanupMessages(account, sender),
    ]);
  } catch (err) {
    $('#modal-body').innerHTML = `<div class="notice warn">⚠️ ${esc(err.message)}</div>`;
    $('#modal-foot').innerHTML = `<button class="btn" onclick="document.querySelector('.modal-overlay').remove()">Fermer</button>`;
    return;
  }

  const autos = list.messages.filter((m) => m.kind === 'auto');
  const persos = list.messages.filter((m) => m.kind === 'personal');
  // 📄 Mails porteurs d'une pièce : jamais cochés, même venant d'un robot
  // publicitaire — c'est le même expéditeur qui envoie les soldes et tes
  // tickets de caisse.
  const docs = list.messages.filter((m) => m.kind === 'document');
  // Sélection par défaut : uniquement les mails clairement automatiques.
  const selected = new Set(autos.map((m) => m.uid));

  $('#modal-body').innerHTML = `
    <p>Mails de <strong>${esc(sender)}</strong> dans la boîte ${accountChip(account)}
      (dossier ${esc(preview.folder)}) :</p>
    <div class="preview-grid">
      <div class="preview-item"><div class="lbl">Mails au total</div><div class="val">${fmtNum(preview.count)}</div></div>
      <div class="preview-item"><div class="lbl">Taille totale</div><div class="val">${fmtSize(preview.totalSizeBytes)}</div></div>
      <div class="preview-item"><div class="lbl">Plus ancien</div><div class="val" style="font-size:13px">${fmtDate(preview.oldestMessageAt)}</div></div>
      <div class="preview-item"><div class="lbl">Plus récent</div><div class="val" style="font-size:13px">${fmtDate(preview.newestMessageAt)}</div></div>
    </div>

    <div class="cat-toggle">
      <label><input type="checkbox" id="cat-auto" checked>
        🤖 <strong>Automatiques</strong> (${fmtNum(autos.length)}) — lien de désinscription ou expéditeur noreply</label>
      <label><input type="checkbox" id="cat-doc">
        📄 <strong>À conserver</strong> (${fmtNum(docs.length)}) — pièce jointe, facture, ticket, attestation.
        Un magasin envoie ses pubs ET tes tickets depuis la même adresse :
        ceux-là sont mis de côté. <strong>Décochés par défaut.</strong></label>
      <label><input type="checkbox" id="cat-perso">
        👤 <strong>Possiblement personnels</strong> (${fmtNum(persos.length)}) — répondu, suivi, conversation,
        ou sans marqueur automatique. <strong>Décochés par défaut.</strong></label>
    </div>

    <button class="btn btn-sm" id="toggle-list">📋 Voir la liste complète (${fmtNum(list.messages.length)})</button>
    ${list.truncated ? `<span class="muted" style="font-size:12px"> (${fmtNum(list.total)} au total, affichage limité à ${fmtNum(list.messages.length)})</span>` : ''}
    <div class="mail-list hidden" id="mail-list">
      ${list.messages.map((m, i) => `
        <div class="mail-row ${m.kind}">
          <label class="mail-pick"><input type="checkbox" data-uid="${m.uid}" data-kind="${m.kind}" ${m.kind === 'auto' ? 'checked' : ''}></label>
          <span class="mail-date">${fmtDate(m.date)}</span>
          <span class="mail-subject openable" data-clean-open="${i}" title="${esc(m.subject)}">${esc(m.subject)}${
            m.snippet ? `<span class="mail-snip" title="${esc(m.snippet)}"> — ${esc(m.snippet)}</span>` : ''
          }</span>
          <span class="badge ${m.kind === 'auto' ? 'gray' : m.kind === 'document' ? 'green' : 'blue'}"
            title="${esc(m.signals.join(' · '))}">${
              m.kind === 'auto' ? '🤖 auto' : m.kind === 'document' ? '📄 à conserver' : '👤 perso'
            }</span>
          ${m.isSeen ? '' : '<span class="badge orange">non lu</span>'}
        </div>`).join('')}
    </div>
    <div class="trash-note">🛟 Soft delete uniquement : les mails cochés vont dans la corbeille Outlook et restent
      récupérables ~30 jours. Lots de 200, chaque lot journalisé avec la liste exacte des mails.</div>`;

  $('#modal-foot').innerHTML = `
    <button class="btn" id="modal-cancel">Annuler</button>
    <button class="btn btn-green" id="modal-confirm"></button>`;
  $('#modal-cancel').addEventListener('click', closeModal);

  const confirmBtn = $('#modal-confirm');
  const updateConfirm = () => {
    // La boîte visée est rappelée jusque SUR le bouton d'action : c'est le
    // dernier instant avant de toucher aux mails.
    confirmBtn.innerHTML = `Déplacer ${fmtNum(selected.size)} mails vers la corbeille de
      ${accountChip(account, { onDark: true })}`;
    confirmBtn.disabled = selected.size === 0;
  };
  updateConfirm();

  $('#toggle-list').addEventListener('click', () => $('#mail-list').classList.toggle('hidden'));

  // Lire un mail avant de le supprimer. La ligne était un <label> englobant :
  // cliquer le sujet COCHAIT la case au lieu d'ouvrir. Elle est devenue un
  // <div>, et seule la case reste dans un <label>. Écouteur délégué parce que
  // la liste est écrite d'un bloc dans innerHTML.
  $('#mail-list').addEventListener('click', (e) => {
    const el = e.target.closest('[data-clean-open]');
    if (!el) return;
    e.preventDefault();
    const m = list.messages[Number(el.dataset.cleanOpen)];
    if (!m) return;
    openReaderFor(m, {
      // Le mail vient d'être lu : on rafraîchit le badge « non lu » sans
      // recharger toute la modale (la sélection en cours serait perdue).
      onSeen: () => el.closest('.mail-row')?.querySelector('.badge.orange')?.remove(),
    });
  });

  const rowBoxes = [...overlay.querySelectorAll('.mail-row input[type=checkbox]')];
  const syncCategoryBox = (kind) => {
    const boxes = rowBoxes.filter((b) => b.dataset.kind === kind);
    const box =
      kind === 'auto' ? $('#cat-auto') : kind === 'document' ? $('#cat-doc') : $('#cat-perso');
    const checkedCount = boxes.filter((b) => b.checked).length;
    box.checked = checkedCount === boxes.length && boxes.length > 0;
    box.indeterminate = checkedCount > 0 && checkedCount < boxes.length;
  };
  const bindCategory = (boxId, kind) => {
    $(boxId).addEventListener('change', (e) => {
      for (const b of rowBoxes.filter((x) => x.dataset.kind === kind)) {
        b.checked = e.target.checked;
        const uid = Number(b.dataset.uid);
        if (e.target.checked) selected.add(uid);
        else selected.delete(uid);
      }
      updateConfirm();
    });
  };
  bindCategory('#cat-auto', 'auto');
  bindCategory('#cat-doc', 'document');
  bindCategory('#cat-perso', 'personal');
  for (const b of rowBoxes) {
    b.addEventListener('change', () => {
      const uid = Number(b.dataset.uid);
      if (b.checked) selected.add(uid);
      else selected.delete(uid);
      syncCategoryBox(b.dataset.kind);
      updateConfirm();
    });
  }

  // Étape 2 : confirmation → exécution avec progression.
  $('#modal-confirm').addEventListener('click', async () => {
    $('#modal-foot').innerHTML = '';
    $('#modal-body').innerHTML = `<p><span class="spinner"></span>Nettoyage en cours — ne pas fermer cette fenêtre.</p>
      <div class="sync-log" id="cleanup-log"></div>`;
    let jobId;
    try {
      ({ jobId } = await api.cleanupExecute(account, sender, [...selected]));
    } catch (err) {
      $('#modal-body').innerHTML = `<div class="notice warn">⚠️ ${esc(err.message)}</div>`;
      $('#modal-foot').innerHTML = `<button class="btn" id="modal-cancel2">Fermer</button>`;
      $('#modal-cancel2').addEventListener('click', closeModal);
      return;
    }
    const log = $('#cleanup-log');
    const timer = setInterval(async () => {
      try {
        const j = await api.job(jobId);
        log.textContent = j.progress.join('\n');
        log.scrollTop = log.scrollHeight;
        if (j.status !== 'running') {
          clearInterval(timer);
          const r = j.result ?? {};
          if (j.status === 'done') {
            // Met à jour la page derrière la modale sans attendre le clic.
            refreshOverview().then(() => route()).catch(() => {});
          }
          $('#modal-body').innerHTML =
            j.status === 'done'
              ? `<div class="notice">✅ <strong>${fmtNum(r.deleted ?? 0)}</strong> mails déplacés vers
                 <strong>${esc(r.destination || 'la corbeille')}</strong> en ${fmtNum(r.batches ?? 0)} lot(s).
                 Récupérables ~30 jours dans Outlook.</div>`
              : `<div class="notice warn">❌ Échec : ${esc(j.error ?? '')}</div>`;
          $('#modal-foot').innerHTML = `<button class="btn btn-primary" id="modal-done">Fermer</button>`;
          $('#modal-done').addEventListener('click', closeModal);
        }
      } catch {
        clearInterval(timer);
      }
    }, 1000);
  });
}

// ---------------------------------------------------------------- Modale enrôlement
function openEnrollModal() {
  closeModal();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal">
    <div class="modal-head"><h2>＋ Ajouter une boîte mail</h2>
      <button class="modal-close" title="Fermer">✕</button></div>
    <div class="modal-body" id="modal-body">
      <p>Donne un <strong>nom court</strong> à cette boîte (ex. <code>brimmo</code>,
      <code>colocar</code>, <code>econom</code>) :</p>
      <form id="enroll-form" style="display:flex; gap:10px; margin-top:12px">
        <input type="text" id="enroll-name" placeholder="nom-de-la-boite" pattern="[A-Za-z0-9_-]{1,40}"
          style="flex:1; border:1px solid var(--border); border-radius:8px; padding:9px 12px" required>
        <button type="submit" class="btn btn-primary">Choisir le compte Microsoft</button>
      </form>
      <p class="muted" style="margin-top:10px; font-size:12.5px">
        Une fenêtre Microsoft s'ouvre avec le <strong>choix du compte</strong>
        (« Utiliser un autre compte » pour une boîte non connectée). Le mot de
        passe ne passe jamais par cette page.
        <a href="#" id="enroll-code-method">Méthode alternative par code</a></p>
      <p class="muted" style="margin-top:6px; font-size:12.5px">
        📮 Boîte hébergée ailleurs que chez Microsoft (OVH, autre fournisseur) ?
        <a href="#" id="enroll-imap-method">Ajouter un compte IMAP</a></p>
      <div id="enroll-zone"></div>
    </div>
    <div class="modal-foot"><button class="btn" id="enroll-cancel">Fermer</button></div>
  </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('.modal-close').addEventListener('click', closeModal);
  $('#enroll-cancel').addEventListener('click', closeModal);

  let method = 'popup';
  $('#enroll-code-method').addEventListener('click', (e) => {
    e.preventDefault();
    method = 'code';
    $('#enroll-form').querySelector('button').textContent = 'Obtenir le code';
    e.target.remove();
  });
  $('#enroll-imap-method').addEventListener('click', (e) => {
    e.preventDefault();
    showImapEnrollForm();
  });

  // Succès commun aux deux méthodes (popup et code).
  const showEnrollSuccess = (r, name) => {
    // Rafraîchit tout de suite la page derrière la modale (sidebar + vue) :
    // quelle que soit la façon de fermer ensuite, tout est déjà à jour.
    refreshOverview().then(() => route()).catch(() => {});

    const zone = $('#enroll-zone');
    zone.innerHTML = `<div class="notice">✅ <strong>${esc(r.username ?? '')}</strong> ajouté sous le nom
      <strong>${esc(r.account ?? name)}</strong>.<br>
      <span class="muted" style="font-size:12.5px">Vérifie que l'adresse ci-dessus est bien
      celle attendue.</span></div>
      ${r.duplicateOf ? `<div class="notice warn">⚠️ Cette adresse est <strong>déjà connectée</strong>
        sous le nom « ${esc(r.duplicateOf)} » ! Tu as probablement choisi le mauvais compte.
        Refais « Ajouter un compte » avec le même nom <strong>${esc(r.account ?? name)}</strong>
        et choisis « Utiliser un autre compte » dans la fenêtre Microsoft.</div>` : ''}
      <p class="muted" style="margin-top:10px; font-size:12.5px">💡 La synchronisation peut aussi se
      lancer plus tard depuis la page de la boîte — tu peux enchaîner l'ajout de tes autres comptes.</p>`;
    $('.modal-foot').innerHTML = `
      <button class="btn" id="enroll-another">＋ Ajouter une autre boîte</button>
      <button class="btn" id="enroll-close">Fermer</button>
      <button class="btn btn-primary" id="enroll-sync">Synchroniser maintenant</button>`;
    $('#enroll-another').addEventListener('click', () => {
      openEnrollModal(); // repart sur une modale propre (ferme l'actuelle)
    });
    $('#enroll-close').addEventListener('click', closeModal);
    $('#enroll-sync').addEventListener('click', () => {
      closeModal();
      pendingAutoSync = r.account ?? name;
      const target = `#/account/${encodeURIComponent(r.account ?? name)}`;
      if (location.hash === target) route();
      else location.hash = target; // hashchange déclenche route()
    });
  };

  // Formulaire compte IMAP classique (OVH…) — mot de passe envoyé UNE fois en
  // HTTPS au serveur, qui teste réception ET envoi avant de l'enregistrer
  // (chiffré). Rien n'est stocké si le test échoue.
  function showImapEnrollForm() {
    const inp =
      'border:1px solid var(--border); border-radius:8px; padding:9px 12px; width:100%; box-sizing:border-box';
    $('#modal-body').innerHTML = `
      <p>Boîte <strong>OVH</strong> ou d'un autre fournisseur classique (connexion IMAP
      par mot de passe) :</p>
      <form id="imap-form" style="display:flex; flex-direction:column; gap:10px; margin-top:12px">
        <input type="text" id="imap-name" placeholder="nom court (ex. lb2i)" pattern="[A-Za-z0-9_-]{1,40}" style="${inp}" required>
        <input type="email" id="imap-email" placeholder="adresse email complète (ex. contact@lb2i.com)" style="${inp}" required>
        <input type="password" id="imap-password" placeholder="mot de passe de la boîte" style="${inp}" autocomplete="new-password" required>
        <details id="imap-advanced">
          <summary class="muted" style="cursor:pointer; font-size:12.5px">Paramètres serveur (préréglés pour OVH)</summary>
          <div style="display:grid; grid-template-columns: 1fr 110px; gap:8px; margin-top:8px">
            <input type="text" id="imap-host" value="ssl0.ovh.net" placeholder="serveur IMAP (réception)" style="${inp}">
            <select id="imap-port" style="${inp}"><option value="993" selected>993 (SSL)</option><option value="143">143 (STARTTLS)</option></select>
            <input type="text" id="smtp-host" value="ssl0.ovh.net" placeholder="serveur SMTP (envoi)" style="${inp}">
            <select id="smtp-port" style="${inp}"><option value="465" selected>465 (SSL)</option><option value="587">587 (STARTTLS)</option></select>
            <input type="text" id="imap-user" placeholder="identifiant si différent de l'adresse (rare)" style="${inp}; grid-column:1 / -1">
          </div>
        </details>
        <button type="submit" class="btn btn-primary">Tester et ajouter la boîte</button>
      </form>
      <p class="muted" style="margin-top:10px; font-size:12.5px">
        La connexion (réception <em>et</em> envoi) est testée avant tout enregistrement ;
        le mot de passe est chiffré sur le serveur, comme les autres comptes.</p>
      <div id="enroll-zone"></div>`;
    $('#imap-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const zone = $('#enroll-zone');
      const name = $('#imap-name').value.trim();
      const btn = $('#imap-form').querySelector('button[type=submit]');
      btn.disabled = true;
      zone.innerHTML = `<div class="empty"><span class="spinner"></span>Test de la connexion
        (réception puis envoi)… jusqu'à 30 secondes.</div>`;
      try {
        const r = await api.enrollImap({
          account: name,
          email: $('#imap-email').value.trim(),
          password: $('#imap-password').value,
          imapHost: $('#imap-host').value.trim(),
          imapPort: Number($('#imap-port').value),
          smtpHost: $('#smtp-host').value.trim(),
          smtpPort: Number($('#smtp-port').value),
          imapUser: $('#imap-user').value.trim(),
        });
        showEnrollSuccess(r, name);
      } catch (err) {
        btn.disabled = false;
        zone.innerHTML = `<div class="notice warn">❌ ${esc(err.message)}</div>
          <p class="muted" style="font-size:12px">Rien n'a été enregistré — corrige et réessaie.
          Chez OVH, l'identifiant est l'adresse email complète et le mot de passe celui de la
          boîte (pas celui du compte OVH).</p>`;
      }
    });
  }

  $('#enroll-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#enroll-name').value.trim();
    const zone = $('#enroll-zone');

    if (method === 'popup') {
      let start;
      try {
        start = await api.enrollStart(name);
      } catch (err) {
        zone.innerHTML = `<div class="notice warn">⚠️ ${esc(err.message)}</div>`;
        return;
      }
      const popup = window.open(start.authUrl, 'boxmail-enroll', 'width=540,height=720');
      if (!popup) {
        zone.innerHTML = `<div class="notice warn">⚠️ Popup bloquée par le navigateur — autorise les
          popups pour ce site, ou utilise la méthode par code.</div>`;
        return;
      }
      zone.innerHTML = `
        ${start.replacing ? `<div class="notice warn">Ce nom existait déjà (${esc(start.replacing)}) — il sera remplacé.</div>` : ''}
        <div class="empty"><span class="spinner"></span>Choisis le compte dans la fenêtre Microsoft…
        <br><span class="muted" style="font-size:12px">Astuce : « Utiliser un autre compte » si la boîte
        voulue n'est pas dans la liste.</span></div>`;
      const onMessage = (ev) => {
        if (ev.origin !== location.origin || ev.data?.source !== 'boxmail-enroll') return;
        window.removeEventListener('message', onMessage);
        if (ev.data.ok) showEnrollSuccess(ev.data, name);
        else {
          zone.innerHTML = `<div class="notice warn">❌ Échec de la connexion : ${esc(ev.data.error ?? '')}<br>
            <span class="muted" style="font-size:12px">Si l'erreur mentionne « redirect URI »
            (AADSTS50011), il faut déclarer l'URL de retour dans Entra — voir le README §4bis —
            ou utiliser la méthode par code.</span></div>`;
        }
      };
      window.addEventListener('message', onMessage);
      return;
    }

    // Méthode par code (device flow) — secours.
    zone.innerHTML = `<div class="empty"><span class="spinner"></span>Demande du code à Microsoft…</div>`;
    let jobId, replacing;
    try {
      ({ jobId, replacing } = await api.enroll(name));
    } catch (err) {
      zone.innerHTML = `<div class="notice warn">⚠️ ${esc(err.message)}</div>`;
      return;
    }
    $('#enroll-form').classList.add('hidden');

    let codeShown = false;
    const timer = setInterval(async () => {
      let j;
      try {
        j = await api.job(jobId);
      } catch {
        clearInterval(timer);
        return;
      }
      if (!codeShown && j.meta?.userCode) {
        codeShown = true;
        zone.innerHTML = `
          ${replacing ? `<div class="notice warn">Ce nom existait déjà (${esc(replacing)}) — il sera remplacé.</div>` : ''}
          <div class="device-box">
            <div class="lbl">1. Ouvre une fenêtre de <strong>navigation privée</strong> (Ctrl+Maj+N) et va sur :</div>
            <a class="device-link" href="${esc(j.meta.verificationUri)}" target="_blank" rel="noopener">${esc(j.meta.verificationUri)}</a>
            <div class="lbl" style="margin-top:14px">2. Saisis ce code :</div>
            <div class="device-code">${esc(j.meta.userCode)}</div>
            <div class="lbl" style="margin-top:14px">3. Connecte-toi avec la boîte <strong>à ajouter</strong> et accepte.</div>
          </div>
          <div class="empty" style="padding:14px"><span class="spinner"></span>En attente de ta validation chez Microsoft…</div>`;
      }
      if (j.status !== 'running') {
        clearInterval(timer);
        if (j.status === 'done') {
          showEnrollSuccess(j.result ?? {}, name);
        } else {
          zone.innerHTML = `<div class="notice warn">❌ Échec de la connexion : ${esc(j.error ?? '')}<br>
            <span class="muted" style="font-size:12px">Causes fréquentes : code expiré (15 min),
            connexion refusée, ou mauvaise boîte utilisée. Tu peux réessayer.</span></div>`;
          $('#enroll-form').classList.remove('hidden');
        }
      }
    }, 1500);
  });
}

// ---------------------------------------------------------------- À répondre
const repliesState = { tab: 'active', sinceDays: 60, data: null };

function waitLabel(hours) {
  if (hours < 1) return "moins d'1 h";
  if (hours < 48) return `${Math.round(hours)} h`;
  return `${Math.round(hours / 24)} j`;
}

function replyCategoryBadge(i) {
  if (i.category === 'urgent') return '<span class="badge red">🔥 Urgent · seuil 24 h</span>';
  if (i.category === 'important') return '<span class="badge orange">🏛️ Banque / admin · seuil 48 h</span>';
  return '<span class="badge gray">Normal · seuil 7 j</span>';
}

async function renderReplies() {
  const main = $('#main');
  main.innerHTML = `<div class="page-head">
    <div><h1>↩️ À répondre</h1>
      <div class="sub">Mails reçus qui attendent une réponse de ta part — détectés depuis les mails synchronisés
      (newsletters, notifications et no-reply exclus). Synchronise tes boîtes pour des résultats à jour.</div></div>
    <div class="head-actions">
      <select id="replies-window" title="Fenêtre d'analyse">
        ${[30, 60, 90, 180].map((d) => `<option value="${d}" ${d === repliesState.sinceDays ? 'selected' : ''}>Analyser ${d} jours</option>`).join('')}
      </select>
      <button class="btn" id="replies-refresh">↻ Actualiser</button>
    </div></div>
    <div id="replies-body"><div class="empty"><span class="spinner"></span>Analyse des fils de discussion…</div></div>`;
  $('#replies-window').addEventListener('change', (e) => {
    repliesState.sinceDays = Number(e.target.value);
    loadReplies();
  });
  $('#replies-refresh').addEventListener('click', loadReplies);
  await loadReplies();
}

async function loadReplies() {
  const body = $('#replies-body');
  if (!body) return;
  body.innerHTML = '<div class="empty"><span class="spinner"></span>Analyse des fils de discussion…</div>';
  try {
    repliesState.data = await api.replies(repliesState.sinceDays);
  } catch (err) {
    body.innerHTML = `<div class="notice warn">⚠️ ${esc(err.message)}<br>
      Si les boîtes ne sont pas encore synchronisées, lance d'abord une synchronisation.</div>`;
    return;
  }
  refreshRepliesBadge(repliesState.data);
  renderRepliesBody();
}

function renderRepliesBody() {
  const body = $('#replies-body');
  const d = repliesState.data;
  if (!body || !d) return;
  const tabs = [
    { key: 'active', label: 'À traiter', n: d.counts.active },
    { key: 'overdue', label: 'En retard', n: d.counts.overdue },
    { key: 'snoozed', label: 'Reportés', n: d.counts.snoozed },
    { key: 'dismissed', label: 'Ignorés', n: d.counts.dismissed },
  ];
  const items = d.items.filter((i) =>
    repliesState.tab === 'active' ? i.state === 'active'
    : repliesState.tab === 'overdue' ? i.state === 'active' && i.overdue
    : i.state === repliesState.tab,
  );
  const emptyMessages = {
    active: '🎉 Rien à traiter : aucun mail en attente de réponse sur cette période.',
    overdue: '👍 Aucun seuil dépassé : tu es à jour dans tes réponses.',
    snoozed: 'Aucun fil reporté. « Reporter » cache un fil quelques jours, puis il revient tout seul.',
    dismissed: 'Aucun fil ignoré. « Ignorer » retire un fil de la liste (il revient si un nouveau mail arrive).',
  };

  body.innerHTML = `
    <div class="tabs">${tabs
      .map(
        (t) => `<button class="tab ${repliesState.tab === t.key ? 'active' : ''}" data-tab="${t.key}">
        ${t.label}${t.n > 0 ? ` <span class="badge ${t.key === 'overdue' ? 'red' : 'gray'}">${fmtNum(t.n)}</span>` : ''}</button>`,
      )
      .join('')}</div>
    <div class="panel"><div class="panel-body tight">
      ${items.length === 0
        ? `<div class="empty">${emptyMessages[repliesState.tab]}</div>`
        : items.map(replyRow).join('')}
    </div></div>
    <div class="panel-body muted" style="font-size:12.5px; padding:0 4px">
      📖 Clique un sujet pour lire le mail ici. 🛟 « Reporter » et « Ignorer » ne touchent pas
      aux mails : simple marque-page local, journalisé, annulable depuis les onglets
      Reportés / Ignorés. Un fil ignoré réapparaît si un nouveau mail y arrive.</div>`;

  body.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      repliesState.tab = btn.dataset.tab;
      renderRepliesBody();
    });
  });

  body.querySelectorAll('[data-open]').forEach((el) => {
    el.addEventListener('click', () => {
      const i = items[Number(el.dataset.open)];
      openReaderFor(i, {
        onSeen: (_, seen) => { i.isSeen = seen; renderRepliesBody(); },
        onRemoved: () => loadReplies(),
      });
    });
  });

  const act = async (btn, fn) => {
    btn.disabled = true;
    try {
      await fn();
      await loadReplies();
    } catch (err) {
      alert(err.message);
      btn.disabled = false;
    }
  };
  body.querySelectorAll('.reply-snooze').forEach((sel) => {
    sel.addEventListener('change', () => {
      const days = Number(sel.value);
      if (!days) return;
      act(sel, () => api.replySnooze(sel.dataset.account, Number(sel.dataset.thread), days));
    });
  });
  body.querySelectorAll('.reply-dismiss').forEach((btn) => {
    btn.addEventListener('click', () =>
      act(btn, () => api.replyDismiss(btn.dataset.account, Number(btn.dataset.thread))),
    );
  });
  body.querySelectorAll('.reply-restore').forEach((btn) => {
    btn.addEventListener('click', () =>
      act(btn, () => api.replyRestore(btn.dataset.account, Number(btn.dataset.thread))),
    );
  });
}

function replyRow(i, idx) {
  const ident = `data-account="${esc(i.account)}" data-thread="${i.threadId}"`;
  const actions =
    (i.state === 'active'
      ? `<select class="reply-snooze" ${ident} title="Cacher ce fil quelques jours, puis il revient">
           <option value="">⏰ Reporter…</option>
           <option value="1">1 jour</option><option value="3">3 jours</option>
           <option value="7">7 jours</option><option value="30">30 jours</option>
         </select>
         <button class="btn btn-sm reply-dismiss" ${ident} title="Pas de réponse nécessaire">🔕 Ignorer</button>`
      : `<button class="btn btn-sm reply-restore" ${ident}>↩︎ Remettre en liste</button>`) +
    `<button class="btn btn-sm openable-btn" data-open="${idx}">📖 Lire</button>`;
  const stateInfo =
    i.state === 'snoozed'
      ? `<span class="badge blue">reporté jusqu'au ${fmtDate(i.snoozedUntil)}</span>`
      : i.state === 'dismissed'
        ? '<span class="badge gray">ignoré</span>'
        : i.overdue
          ? `<span class="badge red">⏰ en retard — attend depuis ${waitLabel(i.waitingHours)}</span>`
          : `<span class="badge gray">attend depuis ${waitLabel(i.waitingHours)}</span>`;
  return `<div class="reply-row">
    <div class="reply-main">
      <div class="reply-top">
        <strong>${esc(i.fromName || i.fromEmail)}</strong>
        <span class="muted" style="font-size:12px">${esc(i.fromEmail)}</span>
        ${accountChip(i.account)}
        ${i.isSeen ? '' : '<span class="badge orange">non lu</span>'}
        ${i.requestKind === 'action' ? '<span class="badge orange">🗣️ action demandée</span>'
          : i.requestKind === 'reply_expected' ? '<span class="badge orange">🗣️ réponse attendue</span>'
          : i.requestKind === 'question' ? '<span class="badge blue">❓ question</span>' : ''}
        ${i.inCopy ? '<span class="badge gray" title="Tu n\'es pas dans les destinataires principaux">cc — en copie</span>' : ''}
      </div>
      <div class="reply-subject openable" data-open="${idx}" title="Lire le mail">${esc(i.subject)}
        ${i.threadMessageCount > 1 ? `<span class="muted" style="font-size:12px">· fil de ${fmtNum(i.threadMessageCount)} messages</span>` : ''}</div>
      <div class="reply-reason muted">${esc(i.reason)}</div>
    </div>
    <div class="reply-side">
      <div class="reply-date">${fmtDate(i.date)}</div>
      ${replyCategoryBadge(i)}
      ${stateInfo}
      <div class="reply-actions">${actions}</div>
    </div>
  </div>`;
}

// ---------------------------------------------------------------- Relances
const followupsState = { tab: 'active', sinceDays: 60, data: null };

function followupCategoryBadge(i) {
  if (i.category === 'urgent') return '<span class="badge red">🔥 Sujet pressant · délai 3 j</span>';
  if (i.category === 'important') return '<span class="badge orange">🏛️ Banque / admin · délai 5 j</span>';
  return '<span class="badge gray">Normal · délai 7 j</span>';
}

async function renderFollowups() {
  const main = $('#main');
  main.innerHTML = `<div class="page-head">
    <div><h1>⏰ À relancer</h1>
      <div class="sub">Mails que TU as envoyés, restés sans réponse : le correspondant à relancer est
      indiqué. Détecté depuis les mails synchronisés (destinataires no-reply exclus) — synchronise tes boîtes
      pour des résultats à jour.</div></div>
    <div class="head-actions">
      <select id="followups-window" title="Fenêtre d'analyse">
        ${[30, 60, 90, 180].map((d) => `<option value="${d}" ${d === followupsState.sinceDays ? 'selected' : ''}>Analyser ${d} jours</option>`).join('')}
      </select>
      <button class="btn" id="followups-refresh">↻ Actualiser</button>
    </div></div>
    <div id="followups-body"><div class="empty"><span class="spinner"></span>Analyse des fils de discussion…</div></div>`;
  $('#followups-window').addEventListener('change', (e) => {
    followupsState.sinceDays = Number(e.target.value);
    loadFollowups();
  });
  $('#followups-refresh').addEventListener('click', loadFollowups);
  await loadFollowups();
}

async function loadFollowups() {
  const body = $('#followups-body');
  if (!body) return;
  body.innerHTML = '<div class="empty"><span class="spinner"></span>Analyse des fils de discussion…</div>';
  try {
    followupsState.data = await api.followups(followupsState.sinceDays);
  } catch (err) {
    body.innerHTML = `<div class="notice warn">⚠️ ${esc(err.message)}<br>
      Si les boîtes ne sont pas encore synchronisées, lance d'abord une synchronisation.</div>`;
    return;
  }
  refreshFollowupsBadge(followupsState.data);
  renderFollowupsBody();
}

function renderFollowupsBody() {
  const body = $('#followups-body');
  const d = followupsState.data;
  if (!body || !d) return;
  const tabs = [
    { key: 'active', label: 'À relancer', n: d.counts.active },
    { key: 'overdue', label: 'En retard', n: d.counts.overdue },
    { key: 'snoozed', label: 'Reportées', n: d.counts.snoozed },
    { key: 'dismissed', label: 'Traitées', n: d.counts.dismissed },
  ];
  const items = d.items.filter((i) =>
    followupsState.tab === 'active' ? i.state === 'active'
    : followupsState.tab === 'overdue' ? i.state === 'active' && i.overdue
    : i.state === followupsState.tab,
  );
  const emptyMessages = {
    active: '👍 Personne à relancer : tous tes mails envoyés ont eu leur réponse sur cette période.',
    overdue: '🎉 Aucun délai de relance dépassé.',
    snoozed: 'Aucune relance reportée. « Reporter » cache un fil quelques jours, puis il revient.',
    dismissed: 'Aucune relance marquée traitée. « Traité » retire le fil (il revient si un nouveau message arrive).',
  };

  body.innerHTML = `
    <div class="tabs">${tabs
      .map(
        (t) => `<button class="tab ${followupsState.tab === t.key ? 'active' : ''}" data-tab="${t.key}">
        ${t.label}${t.n > 0 ? ` <span class="badge ${t.key === 'overdue' ? 'red' : 'gray'}">${fmtNum(t.n)}</span>` : ''}</button>`,
      )
      .join('')}</div>
    <div class="panel"><div class="panel-body tight">
      ${items.length === 0
        ? `<div class="empty">${emptyMessages[followupsState.tab]}</div>`
        : items.map(followupRow).join('')}
    </div></div>
    <div class="panel-body muted" style="font-size:12.5px; padding:0 4px">
      📖 Clique un sujet pour relire le mail que tu avais envoyé. 🛟 « Reporter » et « Traité »
      ne touchent pas aux mails : simple marque-page local, journalisé, annulable depuis les
      onglets Reportées / Traitées. Un fil marqué traité réapparaît si un nouveau message y arrive.</div>`;

  body.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      followupsState.tab = btn.dataset.tab;
      renderFollowupsBody();
    });
  });

  body.querySelectorAll('[data-open]').forEach((el) => {
    el.addEventListener('click', () => {
      const i = items[Number(el.dataset.open)];
      const selfEmail = overviewCache?.enrolled.find((e) => e.account === i.account)?.username ?? '';
      openReaderFor(
        { ...i, fromName: 'Toi (mail envoyé)', fromEmail: selfEmail, isSeen: true },
        { onRemoved: () => loadFollowups() },
      );
    });
  });

  const act = async (btn, fn) => {
    btn.disabled = true;
    try {
      await fn();
      await loadFollowups();
    } catch (err) {
      alert(err.message);
      btn.disabled = false;
    }
  };
  // ✍️ Relancer (A5) : brouillon pré-rempli — rien ne part sans ton clic.
  body.querySelectorAll('.followup-draft').forEach((btn) => {
    btn.addEventListener('click', () => {
      const i = items[Number(btn.dataset.draft)];
      if (!smtpEnabled) {
        alert("Envoi désactivé sur ce serveur (ENABLE_SMTP_SEND=false dans le .env).");
        return;
      }
      const days = Math.max(1, Math.round(i.waitingHours / 24));
      openComposeModal({
        account: i.account,
        to: i.counterpartyEmail,
        subject: /^re\s*:/i.test(i.subject) ? i.subject : `Re: ${i.subject}`,
        text: `Bonjour,\n\nSauf erreur de ma part, je n'ai pas eu de retour sur mon message du ${fmtDate(i.date)}`
          + ` (« ${i.subject} »), envoyé il y a ${days} jour${days > 1 ? 's' : ''}.\n`
          + `As-tu eu l'occasion d'y jeter un œil ?\n\nMerci d'avance,\nAnthony`,
        replyRef: { folder: i.folder, uid: i.uid, mode: 'reply' },
      });
    });
  });
  body.querySelectorAll('.followup-snooze').forEach((sel) => {
    sel.addEventListener('change', () => {
      const days = Number(sel.value);
      if (!days) return;
      act(sel, () => api.followupSnooze(sel.dataset.account, Number(sel.dataset.thread), days));
    });
  });
  body.querySelectorAll('.followup-dismiss').forEach((btn) => {
    btn.addEventListener('click', () =>
      act(btn, () => api.followupDismiss(btn.dataset.account, Number(btn.dataset.thread))),
    );
  });
  body.querySelectorAll('.followup-restore').forEach((btn) => {
    btn.addEventListener('click', () =>
      act(btn, () => api.followupRestore(btn.dataset.account, Number(btn.dataset.thread))),
    );
  });
}

function followupRow(i, idx) {
  const ident = `data-account="${esc(i.account)}" data-thread="${i.threadId}"`;
  const actions =
    (i.state === 'active'
      ? `${i.stage !== 'waiting' ? `<button class="btn btn-sm btn-primary followup-draft" data-draft="${idx}"
           title="Prépare un mail de relance : tu relis, tu ajustes, tu envoies">✍️ Relancer</button>` : ''}
         <select class="followup-snooze" ${ident} title="Cacher ce fil quelques jours, puis il revient">
           <option value="">⏰ Reporter…</option>
           <option value="1">1 jour</option><option value="3">3 jours</option>
           <option value="7">7 jours</option><option value="30">30 jours</option>
         </select>
         <button class="btn btn-sm followup-dismiss" ${ident} title="${i.stage === 'stale' ? 'Clôturer : plus rien à attendre de ce fil' : 'Relance envoyée ou plus nécessaire'}">${i.stage === 'stale' ? '🗄️ Clôturer' : '✓ Traité'}</button>`
      : `<button class="btn btn-sm followup-restore" ${ident}>↩︎ Remettre en liste</button>`) +
    `<button class="btn btn-sm openable-btn" data-open="${idx}">📖 Lire</button>`;
  // Escalade pilotée (A5) : l'outil dit où en est la relance et quoi faire.
  const stageBadge = {
    waiting: `<span class="badge gray">sans réponse depuis ${waitLabel(i.waitingHours)}</span>`,
    due: `<span class="badge red">⏰ à relancer — sans réponse depuis ${waitLabel(i.waitingHours)}</span>`,
    urgent: `<span class="badge red">🚨 urgent — ${waitLabel(i.waitingHours)} sans réponse</span>`,
    stale: `<span class="badge orange">💤 probablement abandonné (${waitLabel(i.waitingHours)}) — clôturer ?</span>`,
  };
  const stateInfo =
    i.state === 'snoozed'
      ? `<span class="badge blue">reportée jusqu'au ${fmtDate(i.snoozedUntil)}</span>`
      : i.state === 'dismissed'
        ? '<span class="badge gray">traitée</span>'
        : stageBadge[i.stage] ?? stageBadge.waiting;
  return `<div class="reply-row">
    <div class="reply-main">
      <div class="reply-top">
        <span class="muted" style="font-size:12px">À relancer :</span>
        <strong>${esc(i.counterpartyName || i.counterpartyEmail)}</strong>
        <span class="muted" style="font-size:12px">${esc(i.counterpartyEmail)}</span>
        ${accountChip(i.account)}
        ${i.hasInbound ? '' : '<span class="badge gray">premier contact</span>'}
      </div>
      <div class="reply-subject openable" data-open="${idx}" title="Relire ton mail envoyé">${esc(i.subject)}
        ${i.threadMessageCount > 1 ? `<span class="muted" style="font-size:12px">· fil de ${fmtNum(i.threadMessageCount)} messages</span>` : ''}</div>
      <div class="reply-reason muted">${esc(i.reason)}</div>
    </div>
    <div class="reply-side">
      <div class="reply-date">envoyé le ${fmtDate(i.date)}</div>
      ${followupCategoryBadge(i)}
      ${stateInfo}
      <div class="reply-actions">${actions}</div>
    </div>
  </div>`;
}

// ---------------------------------------------------------------- À ne pas manquer
// B3 : lus INCLUS par défaut — les « non traités » sont souvent déjà lus.
const importantState = { sinceDays: 30, minScore: 40, includeRead: true, data: null, expanded: {} };

// Pastille de score colorée : rouge ≥ 70, orange 40-69, gris < 40.
function scoreBadge(score) {
  const cls = score >= 70 ? 'high' : score >= 40 ? 'medium' : 'low';
  return `<span class="score-pill ${cls}" title="Score d'importance sur 100">${score}</span>`;
}

async function renderImportant() {
  const main = $('#main');
  main.innerHTML = `<div class="page-head">
    <div><h1>⭐ À ne pas manquer</h1>
      <div class="sub">Chaque mail reçu est noté sur 100 par des règles simples (banque/administration,
      urgence, vraie personne, question, montant…) — les raisons sont affichées sous chaque mail.
      Détecté depuis les mails synchronisés : synchronise tes boîtes pour des résultats à jour.</div></div>
    <div class="head-actions">
      <select id="important-minscore" title="Score minimal affiché">
        ${[[40, 'Score ≥ 40'], [50, 'Score ≥ 50'], [70, 'Score ≥ 70 (prioritaire)']]
          .map(([v, l]) => `<option value="${v}" ${v === importantState.minScore ? 'selected' : ''}>${l}</option>`)
          .join('')}
      </select>
      <select id="important-window" title="Fenêtre d'analyse">
        ${[7, 30, 60, 90].map((d) => `<option value="${d}" ${d === importantState.sinceDays ? 'selected' : ''}>Analyser ${d} jours</option>`).join('')}
      </select>
      <select id="important-read" title="Inclure ou non les mails déjà lus">
        <option value="" ${importantState.includeRead ? '' : 'selected'}>Non lus seulement</option>
        <option value="1" ${importantState.includeRead ? 'selected' : ''}>Lus inclus</option>
      </select>
      <button class="btn" id="important-refresh">↻ Actualiser</button>
    </div></div>
    <div id="important-body"><div class="empty"><span class="spinner"></span>Calcul des scores…</div></div>`;
  $('#important-minscore').addEventListener('change', (e) => {
    importantState.minScore = Number(e.target.value);
    loadImportant();
  });
  $('#important-window').addEventListener('change', (e) => {
    importantState.sinceDays = Number(e.target.value);
    loadImportant();
  });
  $('#important-read').addEventListener('change', (e) => {
    importantState.includeRead = e.target.value === '1';
    loadImportant();
  });
  $('#important-refresh').addEventListener('click', loadImportant);
  await loadImportant();
}

async function loadImportant() {
  const body = $('#important-body');
  if (!body) return;
  body.innerHTML = '<div class="empty"><span class="spinner"></span>Calcul des scores…</div>';
  try {
    importantState.data = await api.important(
      importantState.sinceDays,
      importantState.minScore,
      importantState.includeRead,
    );
  } catch (err) {
    body.innerHTML = `<div class="notice warn">⚠️ ${esc(err.message)}<br>
      Si les boîtes ne sont pas encore synchronisées, lance d'abord une synchronisation.</div>`;
    return;
  }
  importantState.expanded = {};
  refreshImportantBadge(importantState.data);
  renderImportantBody();
}

// B3 : trois groupes remplacent la liste unique — nouveaux / non traités /
// probablement traités. Cap d'affichage par groupe + « +N autres ».
const IMPORTANT_GROUPS = [
  { key: 'new', icon: '🆕', label: 'Nouveaux (7 derniers jours)', hint: 'reçus récemment — à regarder' },
  { key: 'untreated', icon: '⏳', label: 'Non traités', hint: 'plus anciens, AUCUNE réponse ni tâche — même si tu les as lus' },
  { key: 'treated', icon: '✅', label: 'Probablement traités', hint: 'réponse envoyée ou tâche liée — pour vérification' },
];
const IMPORTANT_GROUP_CAP = 10;

function renderImportantBody() {
  const body = $('#important-body');
  const d = importantState.data;
  if (!body || !d) return;

  const groupPanel = (g) => {
    const items = d.items.filter((i) => (i.treatState ?? 'new') === g.key);
    if (items.length === 0) return '';
    const expanded = importantState.expanded[g.key];
    const shown = expanded ? items : items.slice(0, IMPORTANT_GROUP_CAP);
    const hidden = items.length - shown.length;
    return `<div class="panel">
      <div class="panel-head"><h2>${g.icon} ${g.label} <span class="badge ${g.key === 'untreated' ? 'red' : 'gray'}">${fmtNum(items.length)}</span></h2>
        <span class="muted" style="font-size:12px">${g.hint}</span></div>
      <div class="panel-body tight">
        ${shown.map((i) => importantRow(i, d.items.indexOf(i))).join('')}
        ${hidden > 0 ? `<div style="padding:8px 4px"><button class="btn btn-sm important-more" data-group="${g.key}">＋ ${fmtNum(hidden)} autres</button></div>` : ''}
      </div></div>`;
  };

  body.innerHTML = `
    <div class="cards">
      <div class="kpi"><div class="kpi-label">🔴 Prioritaires (score ≥ 70)</div>
        <div class="kpi-value">${fmtNum(d.counts.high)}</div></div>
      <div class="kpi orange"><div class="kpi-label">🟠 À regarder (score 40-69)</div>
        <div class="kpi-value">${fmtNum(d.counts.medium)}</div></div>
      <div class="kpi"><div class="kpi-label">⚪ Faible (&lt; 40)</div>
        <div class="kpi-value">${fmtNum(d.counts.low)}</div>
        <div class="kpi-sub">masqués par le filtre de score</div></div>
    </div>
    ${d.items.length === 0
      ? `<div class="panel"><div class="panel-body"><div class="empty">Aucun mail à score ≥ ${d.minScore} sur cette période${d.includeRead ? '' : ' (parmi les non-lus)'}. 👍</div></div></div>`
      : IMPORTANT_GROUPS.map(groupPanel).join('')}
    <div class="panel-body muted" style="font-size:12.5px; padding:0 4px">
      📖 Clique un sujet pour lire le mail ici (et agir : corbeille, déplacer, lu/non lu).
      « Non traités » = importants restés sans réponse ni tâche : c'est là que se cachent les oublis.</div>`;

  body.querySelectorAll('.important-more').forEach((btn) => {
    btn.addEventListener('click', () => {
      importantState.expanded[btn.dataset.group] = true;
      renderImportantBody();
    });
  });
  body.querySelectorAll('[data-open]').forEach((el) => {
    el.addEventListener('click', () => {
      const i = d.items[Number(el.dataset.open)];
      openReaderFor(i, {
        onSeen: (_, seen) => { i.isSeen = seen; renderImportantBody(); },
        onRemoved: () => loadImportant(),
      });
    });
  });
}

function importantRow(i, idx) {
  return `<div class="reply-row">
    ${scoreBadge(i.score)}
    <div class="reply-main">
      <div class="reply-top">
        <strong>${esc(i.fromName || i.fromEmail)}</strong>
        <span class="muted" style="font-size:12px">${esc(i.fromEmail)}</span>
        ${accountChip(i.account)}
        ${i.isSeen ? '' : '<span class="badge orange">non lu</span>'}
        ${i.senderKind === 'person' ? '<span class="badge green">👤 personne</span>' : ''}
      </div>
      <div class="reply-subject openable" data-open="${idx}" title="Lire le mail">${esc(i.subject)}</div>
      <div class="reply-reason muted">${i.reasons.map(esc).join(' · ')}</div>
    </div>
    <div class="reply-side">
      <div class="reply-date">${fmtDate(i.date)}</div>
      ${i.level === 'high'
        ? '<span class="badge red">prioritaire</span>'
        : i.level === 'medium'
          ? '<span class="badge orange">à regarder</span>'
          : '<span class="badge gray">peut attendre</span>'}
      ${i.treatState === 'untreated' ? `<span class="badge orange">⏳ ${fmtNum(i.daysSinceReceived)} j sans traitement</span>` : ''}
      <div class="reply-actions"><button class="btn btn-sm openable-btn" data-open="${idx}">📖 Lire</button></div>
    </div>
  </div>`;
}

// ---------------------------------------------------------------- Échéances
const deadlinesState = { tab: 'proposed', data: null };

function deadlineCountdown(inDays) {
  if (inDays > 1) return `dans ${fmtNum(inDays)} j`;
  if (inDays === 1) return 'demain';
  if (inDays === 0) return "aujourd'hui";
  if (inDays === -1) return 'hier';
  return `il y a ${fmtNum(-inDays)} j`;
}

const DEADLINE_TYPES = {
  payment: { label: '💶 Paiement', badge: 'red' },
  document: { label: '📄 Document', badge: 'blue' },
  appointment: { label: '📅 Rendez-vous', badge: 'green' },
  renewal: { label: '🔁 Renouvellement', badge: 'orange' },
  other: { label: '📌 Autre', badge: 'gray' },
};

async function renderDeadlines() {
  const main = $('#main');
  main.innerHTML = `<div class="page-head">
    <div><h1>📅 Dates à confirmer</h1>
      <div class="sub">Dates limites détectées dans tes mails (paiements, documents à fournir,
      rendez-vous…). Chaque échéance est PROPOSÉE : à toi de la confirmer ou de l'ignorer —
      rien n'est ajouté à un calendrier automatiquement.</div></div>
    <div class="head-actions">
      <label style="display:flex; align-items:center; gap:6px; font-size:12.5px" class="muted"
        title="Lit aussi le CONTENU des mails au sujet évocateur (max 50 par boîte) — plus lent">
        <input type="checkbox" id="deadlines-deep"> lire aussi le contenu des mails (plus lent)</label>
      <button class="btn btn-primary" id="deadlines-detect">Analyser mes mails</button>
      <button class="btn" id="deadlines-refresh">↻ Actualiser</button>
    </div></div>
    <div id="deadlines-detect-zone"></div>
    <div id="deadlines-body"><div class="empty"><span class="spinner"></span>Chargement…</div></div>`;
  $('#deadlines-refresh').addEventListener('click', loadDeadlines);
  $('#deadlines-detect').addEventListener('click', runDeadlineDetect);
  await loadDeadlines();
}

// Lance la détection sur toutes les boîtes. Réutilisable depuis n'importe quel
// écran (Dates à confirmer, Calendrier…) via opts { btn, zone, deep, onDone }.
async function runDeadlineDetect(opts = {}) {
  const btn = opts.btn ?? $('#deadlines-detect');
  const zone = opts.zone ?? $('#deadlines-detect-zone');
  const deep = opts.deep ?? ($('#deadlines-deep')?.checked ?? false);
  const onDone = opts.onDone ?? loadDeadlines;
  if (!btn || !zone) return;
  btn.disabled = true;
  zone.innerHTML = `<div class="notice"><span class="spinner"></span>
    Détection en cours sur toutes les boîtes${deep ? ' (lecture des contenus — plus lent)' : ''}…
    <span class="muted" id="detect-status"></span></div>`;
  const accounts = (overviewCache?.enrolled ?? []).map((e) => e.account);
  const jobIds = [];
  for (const slug of accounts) {
    try {
      const { jobId } = await api.deadlinesDetect(slug, deep);
      jobIds.push(jobId);
    } catch {
      /* détection déjà en cours pour ce compte : on suit quand même */
    }
  }
  if (jobIds.length === 0) {
    zone.innerHTML = '<div class="notice warn">Aucune boîte à analyser (ou détection déjà en cours).</div>';
    btn.disabled = false;
    return;
  }
  const timer = setInterval(async () => {
    // L'utilisateur a changé d'écran : on arrête de suivre (les jobs finissent
    // seuls côté serveur, rien n'est perdu).
    if (!zone.isConnected) {
      clearInterval(timer);
      return;
    }
    let done = 0;
    let created = 0;
    let lastMsg = '';
    for (const id of jobIds) {
      try {
        const j = await api.job(id);
        if (j.status !== 'running') {
          done++;
          created += j.result?.created ?? 0;
        } else if (j.progress.length) {
          lastMsg = j.progress[j.progress.length - 1];
        }
      } catch {
        done++;
      }
    }
    const st = $('#detect-status');
    if (st) st.textContent = lastMsg ? ` ${lastMsg}` : '';
    if (done === jobIds.length) {
      clearInterval(timer);
      const summary = `<div class="notice">✅ Détection terminée :
        <strong>${fmtNum(created)}</strong> nouvelle(s) échéance(s) proposée(s).</div>`;
      zone.innerHTML = summary;
      btn.disabled = false;
      // onDone reçoit le bilan : un écran qui se re-rend entièrement (le
      // Calendrier) peut le ré-afficher après coup.
      await onDone(summary);
    }
  }, 1200);
}

async function loadDeadlines() {
  const body = $('#deadlines-body');
  if (!body) return;
  body.innerHTML = '<div class="empty"><span class="spinner"></span>Chargement…</div>';
  try {
    deadlinesState.data = await api.deadlines();
  } catch (err) {
    body.innerHTML = `<div class="notice warn">⚠️ ${esc(err.message)}</div>`;
    return;
  }
  refreshDeadlinesBadge(deadlinesState.data);
  renderDeadlinesBody();
}

function renderDeadlinesBody() {
  const body = $('#deadlines-body');
  const d = deadlinesState.data;
  if (!body || !d) return;
  const now = Date.now();
  const isFuture = (x) => new Date(x.date).getTime() >= now - 86_400_000;
  // Une proposition ÉCARTÉE n'est jamais une échéance : elle a son onglet et
  // ne pollue aucune autre liste.
  const inTab = (x, tab) =>
    tab === 'vetoed' ? x.status === 'vetoed'
    : x.status === 'vetoed' ? false
    : tab === 'proposed' ? x.status === 'proposed' && isFuture(x)
    : tab === 'confirmed' ? x.status === 'confirmed' && isFuture(x)
    : tab === 'past' ? (!isFuture(x) && x.status !== 'dismissed') || x.status === 'done'
    : x.status === 'dismissed';
  const tabs = [
    { key: 'proposed', label: 'Proposées', n: d.counts.proposed },
    { key: 'confirmed', label: 'Confirmées', n: d.counts.confirmed },
    { key: 'past', label: 'Passées / faites', n: d.counts.past },
    { key: 'dismissed', label: 'Ignorées', n: d.counts.dismissed },
    { key: 'vetoed', label: 'Écartées par l\'analyse', n: d.counts.vetoed ?? 0 },
  ];
  const items = d.items.filter((x) => inTab(x, deadlinesState.tab));
  const emptyMessages = {
    proposed: 'Aucune échéance à valider. Clique « Analyser mes mails » pour lancer une détection.',
    confirmed: 'Aucune échéance confirmée à venir.',
    past: 'Aucune échéance passée.',
    dismissed: 'Aucune échéance ignorée.',
    vetoed: 'Aucune proposition écartée.',
  };

  // Compteur de confiance (retour 10/08 : « montre-moi ton raisonnement »).
  // Il dit ce que l'assistant a FAIT du travail de détection — sans jamais
  // qualifier de « fausses » des dates que l'utilisateur n'a pas jugées.
  const w = d.work;
  const workLine = w && w.detected > 0
    ? `<div class="notice" style="margin-bottom:10px; font-size:13px">
        🔎 <strong>${fmtNum(w.detected)} date(s) trouvée(s)</strong> dans tes mails :
        <strong>${fmtNum(w.kept)}</strong> retenue(s) comme échéance possible${w.vetoed
          ? ` · <strong>${fmtNum(w.vetoed)} écartée(s)</strong> parce que l'analyse du mail
             concluait qu'aucune action n'était attendue de toi
             <a href="#" id="dl-see-vetoed">voir lesquelles</a>`
          : ''}.
        <div class="muted" style="font-size:12px; margin-top:3px">Une date écartée n'est pas
          effacée : tu peux la rétablir si je me suis trompé.</div></div>`
    : '';

  body.innerHTML = `
    ${workLine}
    <div class="tabs">${tabs
      .map(
        (t) => `<button class="tab ${deadlinesState.tab === t.key ? 'active' : ''}" data-tab="${t.key}">
        ${t.label}${t.n > 0 ? ` <span class="badge ${t.key === 'proposed' ? 'red' : 'gray'}">${fmtNum(t.n)}</span>` : ''}</button>`,
      )
      .join('')}</div>
    ${deadlinesState.tab === 'vetoed' ? `<div class="notice" style="margin:8px 0; font-size:12.5px">
      Ces dates ont bien été trouvées dans tes mails, mais l'analyse du message concluait
      qu'aucune action n'était attendue de toi — typiquement une information
      (« le service sera indisponible le 12 mai ») ou un prélèvement automatique.
      <strong>Rien n'est perdu</strong> : « Rétablir » la remet dans les propositions.</div>` : ''}
    <div class="panel"><div class="panel-body tight">
      ${items.length === 0
        ? `<div class="empty">${emptyMessages[deadlinesState.tab]}</div>`
        : items.map(deadlineRow).join('')}
    </div></div>
    <div class="panel-body muted" style="font-size:12.5px; padding:0 4px">
      📖 Clique le sujet pour lire le mail d'origine et vérifier la date avant de confirmer.
      🛟 Aucun événement calendrier n'est créé automatiquement. Tout est journalisé et réversible.</div>`;

  body.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      deadlinesState.tab = btn.dataset.tab;
      renderDeadlinesBody();
    });
  });
  $('#dl-see-vetoed')?.addEventListener('click', (e) => {
    e.preventDefault();
    deadlinesState.tab = 'vetoed';
    renderDeadlinesBody();
  });

  body.querySelectorAll('[data-open]').forEach((el) => {
    el.addEventListener('click', () => {
      const x = items[Number(el.dataset.open)];
      openReaderFor(
        { ...x, subject: x.subject ?? x.title, date: x.msgDate ?? x.date },
        { onRemoved: () => loadDeadlines() },
      );
    });
  });

  const act = async (btn, fn) => {
    btn.disabled = true;
    try {
      await fn();
      await loadDeadlines();
    } catch (err) {
      alert(err.message);
      btn.disabled = false;
    }
  };
  body.querySelectorAll('[data-dl-action]').forEach((btn) => {
    btn.addEventListener('click', () =>
      act(btn, async () => {
        await api.deadlineAction(btn.dataset.account, Number(btn.dataset.id), btn.dataset.dlAction);
        if (btn.dataset.dlAction === 'task') refreshTasksBadge();
      }),
    );
  });
}

function deadlineRow(x, idx) {
  const type = DEADLINE_TYPES[x.type] ?? DEADLINE_TYPES.other;
  const canOpen = x.uid != null && x.folder;
  const ident = `data-account="${esc(x.account)}" data-id="${x.id}"`;
  let actions = '';
  if (x.status === 'proposed') {
    actions = `<button class="btn btn-sm btn-green" ${ident} data-dl-action="confirm">✓ Confirmer</button>
      <button class="btn btn-sm" ${ident} data-dl-action="done" title="Déjà réglé/fait">Fait</button>
      <button class="btn btn-sm" ${ident} data-dl-action="dismiss" title="Fausse détection ou sans importance">✕ Ignorer</button>`;
  } else if (x.status === 'confirmed') {
    actions = `<button class="btn btn-sm btn-green" ${ident} data-dl-action="done">✓ Fait</button>
      <button class="btn btn-sm" ${ident} data-dl-action="task" title="Ajouter à ta liste de tâches">☑️ → tâche</button>
      <button class="btn btn-sm" ${ident} data-dl-action="dismiss">✕ Ignorer</button>`;
  } else {
    actions = `<button class="btn btn-sm" ${ident} data-dl-action="restore">↩︎ Rétablir</button>`;
  }
  const statusBadge =
    x.status === 'done' ? '<span class="badge green">✓ fait</span>'
    : x.status === 'dismissed' ? '<span class="badge gray">ignorée</span>'
    : x.status === 'confirmed' ? '<span class="badge blue">confirmée</span>'
    : x.status === 'vetoed' ? '<span class="badge gray" title="Date trouvée, mais l\'analyse du mail disait qu\'aucune action n\'était attendue">écartée par l\'analyse</span>'
    : '<span class="badge orange">à valider</span>';
  return `<div class="reply-row">
    <div class="reply-main">
      <div class="reply-top">
        <strong>${fmtDate(x.date)}</strong>
        <span class="badge ${x.inDays <= 3 && x.inDays >= -1 ? 'red' : 'gray'}">${deadlineCountdown(x.inDays)}</span>
        <span class="badge ${type.badge}">${type.label}</span>
        ${statusBadge}
        ${accountChip(x.account)}
        ${x.confidence < 0.9 ? '<span class="badge gray" title="Date trouvée sans tournure explicite">à vérifier</span>' : ''}
      </div>
      <div class="reply-subject ${canOpen ? 'openable' : ''}" ${canOpen ? `data-open="${idx}" title="Lire le mail d'origine"` : ''}>${esc(x.title)}</div>
      <div class="reply-reason muted">${esc(x.fromName || x.fromEmail || '')} · ${esc(x.reason)}</div>
    </div>
    <div class="reply-side">
      <div class="reply-actions">${canOpen ? `<button class="btn btn-sm openable-btn" data-open="${idx}">📖 Lire</button>` : ''}${actions}</div>
    </div>
  </div>`;
}

// ------------------------------------------------- Classement automatique (L7)
// Suggestion → aperçu → application VALIDÉE. Jamais de déplacement sans ton
// accord ; l'« auto » ne concerne que les règles que tu as activées.
const RULE_TYPE_LABELS = {
  sender: 'expéditeur',
  domain: 'domaine',
  subject: 'le sujet contient',
};

async function renderRules() {
  const main = $('#main');
  main.innerHTML = `<div class="page-head">
    <div><h1>🗂️ Classement automatique</h1>
      <div class="sub">« Si expéditeur X → déplacer vers le dossier Y ». Mail Assistant te PROPOSE
      des règles (rangements que tu fais déjà à la main, grosses newsletters) — rien n'est déplacé
      sans ta validation. Une règle validée peut ensuite s'appliquer automatiquement à chaque
      synchronisation si tu coches « auto ».</div></div>
    <div class="head-actions">
      <button class="btn" id="rules-suggest">Suggérer des règles</button>
      <button class="btn btn-primary" id="rules-new">＋ Créer une règle</button>
    </div></div>
    <div id="rules-notice"></div>
    <div id="rules-body"><div class="empty"><span class="spinner"></span>Chargement…</div></div>`;
  $('#rules-suggest').addEventListener('click', runRulesSuggest);
  $('#rules-new').addEventListener('click', openRuleModal);
  await loadRules();
}

const rulesState = { byAccount: [] };

async function loadRules() {
  const body = $('#rules-body');
  if (!body) return;
  const accounts = (overviewCache?.enrolled ?? []).map((e) => e.account);
  const byAccount = [];
  for (const slug of accounts) {
    try {
      const { rules } = await api.rules(slug);
      if (rules.length) byAccount.push({ slug, rules });
    } catch {
      /* boîte pas synchronisée */
    }
  }
  rulesState.byAccount = byAccount;
  renderRulesBody();
}

async function runRulesSuggest() {
  const btn = $('#rules-suggest');
  const notice = $('#rules-notice');
  btn.disabled = true;
  notice.innerHTML = '<div class="notice"><span class="spinner"></span>Analyse de tes boîtes (rangements manuels, newsletters)…</div>';
  const accounts = (overviewCache?.enrolled ?? []).map((e) => e.account);
  let created = 0;
  for (const slug of accounts) {
    try {
      const r = await api.rulesSuggest(slug);
      created += r.created;
    } catch {
      /* boîte pas synchronisée */
    }
  }
  btn.disabled = false;
  notice.innerHTML = created
    ? `<div class="notice">💡 <strong>${fmtNum(created)}</strong> nouvelle(s) règle(s) suggérée(s) — regarde l'aperçu de chacune avant de valider.</div>`
    : '<div class="notice">Aucune nouvelle suggestion : rien de récurrent à automatiser pour l\'instant.</div>';
  await loadRules();
}

function ruleSentence(r) {
  return `Si <strong>${esc(RULE_TYPE_LABELS[r.matchType] ?? r.matchType)}</strong> = « ${esc(r.matchValue)} »
    → déplacer vers <strong>📂 ${esc(r.targetFolder)}</strong>`;
}

function renderRulesBody() {
  const body = $('#rules-body');
  if (!body) return;
  if (rulesState.byAccount.length === 0) {
    body.innerHTML = `<div class="empty">Aucune règle pour l'instant. Clique
      <strong>💡 Suggérer des règles</strong> pour que Mail Assistant analyse tes boîtes, ou
      <strong>＋ Nouvelle règle</strong> pour en créer une toi-même.</div>`;
    return;
  }
  const statusBadge = (r) =>
    r.status === 'suggested' ? '<span class="badge orange">à valider</span>'
    : r.status === 'active' ? '<span class="badge green">active</span>'
    : '<span class="badge gray">en pause</span>';

  body.innerHTML = rulesState.byAccount
    .map(
      ({ slug, rules }) => `<div class="panel">
      <div class="panel-head"><h2>${accountChip(slug)}</h2>
        <span class="muted" style="font-size:12px">${fmtNum(rules.length)} règle(s)</span></div>
      <div class="panel-body tight">
        ${rules
          .map(
            (r) => `<div class="reply-row">
          <div class="reply-main">
            <div class="reply-top">${statusBadge(r)}
              ${r.autoApply ? '<span class="badge blue" title="Appliquée automatiquement à chaque synchronisation">🤖 auto</span>' : ''}
              ${r.pendingCount ? `<span class="badge orange">${fmtNum(r.pendingCount)} mail(s) à ranger</span>` : '<span class="badge gray">rien en attente</span>'}
            </div>
            <div class="reply-subject">${ruleSentence(r)}</div>
            <div class="reply-reason muted">${esc(r.reason)}${r.appliedCount ? ` · déjà ${fmtNum(r.appliedCount)} mails rangés` : ''}</div>
          </div>
          <div class="reply-side"><div class="reply-actions">
            <button class="btn btn-sm" data-rule-preview data-account="${esc(slug)}" data-id="${r.id}">👁️ Aperçu</button>
            ${r.status === 'suggested'
              ? `<button class="btn btn-sm btn-green" data-rule-validate data-account="${esc(slug)}" data-id="${r.id}">✓ Valider</button>
                 <button class="btn btn-sm" data-rule-delete data-account="${esc(slug)}" data-id="${r.id}">✕ Ignorer</button>`
              : r.status === 'active'
              ? `${r.pendingCount ? `<button class="btn btn-sm btn-primary" data-rule-apply data-account="${esc(slug)}" data-id="${r.id}" data-count="${r.pendingCount}" data-folder="${esc(r.targetFolder)}">▶️ Ranger ${fmtNum(r.pendingCount)}</button>` : ''}
                 <label class="muted" style="display:flex; align-items:center; gap:4px; font-size:12px" title="Appliquer automatiquement à chaque synchronisation">
                   <input type="checkbox" data-rule-auto data-account="${esc(slug)}" data-id="${r.id}" ${r.autoApply ? 'checked' : ''}> auto</label>
                 <button class="btn btn-sm" data-rule-pause data-account="${esc(slug)}" data-id="${r.id}">⏸ Pause</button>
                 <button class="btn btn-sm" data-rule-delete data-account="${esc(slug)}" data-id="${r.id}" style="color:var(--red)">🗑️</button>`
              : `<button class="btn btn-sm btn-green" data-rule-validate data-account="${esc(slug)}" data-id="${r.id}">▶ Réactiver</button>
                 <button class="btn btn-sm" data-rule-delete data-account="${esc(slug)}" data-id="${r.id}" style="color:var(--red)">🗑️</button>`}
          </div></div>
        </div>`,
          )
          .join('')}
      </div>
    </div>`,
    )
    .join('') +
    `<div class="panel-body muted" style="font-size:12.5px; padding:0 4px">
      🛟 Une règle DÉPLACE des mails (jamais de suppression), par lots de 200, dossier créé au
      besoin, chaque application journalisée avec la liste exacte des mails.</div>`;

  const notice = (html) => { $('#rules-notice').innerHTML = html; };
  const act = async (btn, fn) => {
    btn.disabled = true;
    try {
      await fn();
      await loadRules();
    } catch (err) {
      btn.disabled = false;
      notice(`<div class="notice warn">⚠️ ${esc(err.message)}</div>`);
    }
  };

  body.querySelectorAll('[data-rule-validate]').forEach((btn) => {
    btn.addEventListener('click', () =>
      act(btn, () => api.ruleUpdate(btn.dataset.account, Number(btn.dataset.id), { status: 'active' })));
  });
  body.querySelectorAll('[data-rule-pause]').forEach((btn) => {
    btn.addEventListener('click', () =>
      act(btn, () => api.ruleUpdate(btn.dataset.account, Number(btn.dataset.id), { status: 'paused', autoApply: false })));
  });
  body.querySelectorAll('[data-rule-delete]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!confirm('Supprimer cette règle ? (Les mails déjà rangés ne bougent pas.)')) return;
      act(btn, () => api.ruleDelete(btn.dataset.account, Number(btn.dataset.id)));
    });
  });
  body.querySelectorAll('[data-rule-auto]').forEach((box) => {
    box.addEventListener('change', () =>
      act(box, async () => {
        await api.ruleUpdate(box.dataset.account, Number(box.dataset.id), { autoApply: box.checked });
        notice(box.checked
          ? '<div class="notice">🤖 Règle automatique : elle s\'appliquera aux nouveaux mails à chaque synchronisation.</div>'
          : '<div class="notice">Règle repassée en manuel.</div>');
      }));
  });
  body.querySelectorAll('[data-rule-apply]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!confirm(`Déplacer ${btn.dataset.count} mail(s) vers « ${btn.dataset.folder} » ?\n(Déplacement uniquement — récupérable en re-déplaçant ; tout est journalisé.)`)) return;
      act(btn, async () => {
        const r = await api.ruleApply(btn.dataset.account, Number(btn.dataset.id));
        notice(`<div class="notice">✅ ${fmtNum(r.moved)} mail(s) rangés dans « ${esc(r.targetFolder)} ».</div>`);
      });
    });
  });
  body.querySelectorAll('[data-rule-preview]').forEach((btn) => {
    btn.addEventListener('click', () => openRulePreview(btn.dataset.account, Number(btn.dataset.id)));
  });
}

// Aperçu : la liste EXACTE des mails que la règle déplacerait.
async function openRulePreview(slug, id) {
  closeModal();
  const overlay = document.createElement('div');
  // under-reader : on doit pouvoir ouvrir un mail sans fermer l'aperçu, avant
  // de valider un déplacement de masse.
  overlay.className = 'modal-overlay under-reader';
  overlay.innerHTML = `<div class="modal modal-wide">
    <div class="modal-head"><h2>👁️ Aperçu de la règle</h2>
      <button class="modal-close" title="Fermer">✕</button></div>
    <div class="modal-body" id="modal-body"><div class="empty"><span class="spinner"></span>Analyse…</div></div>
    <div class="modal-foot" id="modal-foot"></div>
  </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('.modal-close').addEventListener('click', closeModal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
  try {
    const p = await api.rulePreview(slug, id);
    $('#modal-body').innerHTML = `
      <div class="notice" style="margin-bottom:10px">${ruleSentence(p.rule)}<br>
        <span class="muted">${esc(p.rule.reason)}</span></div>
      ${p.total === 0
        ? '<div class="empty">Rien à ranger en ce moment — la règle attendra les prochains mails.</div>'
        : `<div class="muted" style="font-size:12.5px; margin-bottom:6px"><strong>${fmtNum(p.total)}</strong> mail(s) seraient déplacés${p.total > p.items.length ? ` (les ${fmtNum(p.items.length)} plus récents affichés)` : ''} —
          <span class="muted">clique un sujet pour lire le mail avant de valider.</span></div>
      <div style="max-height:52vh; overflow-y:auto">
        ${p.items.map((m, i) => `<div class="op-line"><span class="op-time">${fmtDate(m.date)}</span>
          <span class="openable" style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap"
            data-rule-open="${i}" title="${esc(m.subject)}">${esc(m.subject)}</span>
          <span class="muted" style="font-size:12px; max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap"
            title="${esc(m.fromEmail)}">${esc(m.fromEmail)}</span></div>`).join('')}
      </div>`}`;
    // Écouteur délégué : le corps de la modale est réécrit d'un bloc ci-dessus.
    $('#modal-body').addEventListener('click', (e) => {
      const el = e.target.closest('[data-rule-open]');
      if (!el) return;
      const m = p.items[Number(el.dataset.ruleOpen)];
      if (m) openReaderFor(m);
    });
    $('#modal-foot').innerHTML = `
      <button class="btn" id="rule-preview-close">Fermer</button>
      ${p.total > 0 ? `<button class="btn btn-primary" id="rule-preview-apply">▶️ Déplacer ${fmtNum(p.total)} mail(s) vers 📂 ${esc(p.rule.targetFolder)}</button>` : ''}`;
    $('#rule-preview-close').addEventListener('click', closeModal);
    $('#rule-preview-apply')?.addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        const r = await api.ruleApply(slug, id);
        closeModal();
        $('#rules-notice').innerHTML = `<div class="notice">✅ ${fmtNum(r.moved)} mail(s) rangés dans « ${esc(r.targetFolder)} ». La règle est validée.</div>`;
        await loadRules();
      } catch (err) {
        e.target.disabled = false;
        alert(err.message);
      }
    });
  } catch (err) {
    $('#modal-body').innerHTML = `<div class="notice warn">⚠️ ${esc(err.message)}</div>`;
  }
}

// Création manuelle d'une règle.
function openRuleModal() {
  closeModal();
  const accounts = (overviewCache?.enrolled ?? []).map((e) => e.account);
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal" style="width:520px">
    <div class="modal-head"><h2>＋ Nouvelle règle</h2>
      <button class="modal-close" title="Fermer">✕</button></div>
    <div class="modal-body">
      <div class="compose-grid">
        <label>Boîte</label><select id="nr-account">${accounts.map((a) => `<option>${esc(a)}</option>`).join('')}</select>
        <label>Critère</label><select id="nr-type">
          <option value="sender">expéditeur exact (adresse)</option>
          <option value="domain">domaine (tout @exemple.fr)</option>
          <option value="subject">le sujet contient…</option>
        </select>
        <label>Valeur</label><input type="text" id="nr-value" placeholder="ex. news@airbnb.fr, airbnb.fr, ou Facture">
        <label>Dossier</label><input type="text" id="nr-folder" list="nr-folders" placeholder="ex. Locations/Airbnb (créé au besoin)">
      </div>
      <datalist id="nr-folders"></datalist>
      <div id="nr-error"></div>
      <div class="trash-note" style="margin-top:10px">🛟 La règle est créée ACTIVE mais ne déplace
        rien tant que tu ne cliques pas « Ranger » (ou ne coches pas « auto »).</div>
    </div>
    <div class="modal-foot">
      <button class="btn" id="nr-cancel">Annuler</button>
      <button class="btn btn-primary" id="nr-create">Créer la règle</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('.modal-close').addEventListener('click', closeModal);
  $('#nr-cancel').addEventListener('click', closeModal);

  const fillFolders = () => {
    api.folders($('#nr-account').value).then(({ folders }) => {
      $('#nr-folders').innerHTML = folders
        .filter((f) => !['trash', 'spam', 'sent', 'drafts'].includes(f.role))
        .map((f) => `<option value="${esc(f.path)}">`).join('');
    }).catch(() => {});
  };
  $('#nr-account').addEventListener('change', fillFolders);
  fillFolders();
  $('#nr-value').focus();

  $('#nr-create').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await api.ruleCreate($('#nr-account').value, {
        matchType: $('#nr-type').value,
        matchValue: $('#nr-value').value,
        targetFolder: $('#nr-folder').value,
      });
      closeModal();
      $('#rules-notice').innerHTML = '<div class="notice">✅ Règle créée (active). Utilise 👁️ Aperçu puis ▶️ Ranger pour l\'appliquer.</div>';
      await loadRules();
    } catch (err) {
      e.target.disabled = false;
      $('#nr-error').innerHTML = `<div class="notice warn" style="margin-top:8px">⚠️ ${esc(err.message)}</div>`;
    }
  });
}

// ------------------------------------------------- Nettoyage rapide global (L5.15)
// Tous les candidats de toutes les boîtes, groupés par boîte. « Nettoyer »
// ouvre l'aperçu détaillé existant (liste cochable) — les garde-fous ne
// changent pas : corbeille uniquement, confirmation, journal.
async function renderCleanupGlobal() {
  const main = $('#main');
  main.innerHTML = `<div class="page-head">
    <div><h1>🧹 Nettoyage rapide</h1>
      <div class="sub">Les expéditeurs qui encombrent tes boîtes (newsletters, notifications…),
      toutes boîtes confondues. « Nettoyer » montre d'abord la liste exacte des mails — rien ne
      part sans ta confirmation, et tout va dans la corbeille (récupérable ~30 jours).</div></div>
    <div class="head-actions"><button class="btn" id="cleanup-refresh">↻ Actualiser</button></div></div>
    <div id="retention-body"></div>
    <div id="cleanup-global-body"><div class="empty"><span class="spinner"></span>Analyse des boîtes…</div></div>`;
  $('#cleanup-refresh').addEventListener('click', () => {
    loadRetention();
    loadCleanupGlobal();
  });
  loadRetention();
  await loadCleanupGlobal();
}

// ------------------------------------------------ Désinscriptions (P2.2)
// Tarir le flux à la source : plutôt que de supprimer les mêmes newsletters
// éternellement, on demande à l'expéditeur d'arrêter.
const UNSUB_METHOD = {
  'one-click': ['⚡', 'en un clic', 'Cet expéditeur accepte une désinscription immédiate, sans page à ouvrir.'],
  mail: ['✉️', 'par mail', 'On envoie une demande de désinscription depuis ta boîte.'],
  lien: ['🔗', 'page web', 'Aucune désinscription automatique : sa page s’ouvrira dans un onglet.'],
};

async function renderUnsubscribe() {
  const main = $('#main');
  main.innerHTML = `<div class="page-head"><div><h1>🚫 Désinscriptions</h1>
    <div class="sub">Arrêter les listes à la source — c'est ce qui empêche tes boîtes de se remplir à nouveau.</div></div>
    <div class="head-actions">
      <button class="btn" id="unsub-refresh" title="Va lire les en-têtes de désinscription des expéditeurs de type liste">🔍 Chercher les liens</button>
      <label class="muted" style="font-size:12.5px; display:flex; align-items:center; gap:4px">
        <input type="checkbox" id="unsub-done"> voir les désinscrits</label>
    </div></div>
    <div id="unsub-body"><div class="empty"><span class="spinner"></span>Chargement…</div></div>`;

  $('#unsub-refresh').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await api.unsubscribeRefresh();
      pollJobs();
      $('#unsub-body').innerHTML = `<div class="notice">🔍 Recherche des liens de désinscription lancée —
        suis l'avancement via la pastille d'activité, puis reviens sur cet écran.</div>`;
    } catch (err) {
      alert(err.message);
      e.target.disabled = false;
    }
  });
  $('#unsub-done').addEventListener('change', loadUnsubscribe);
  loadUnsubscribe();
}

async function loadUnsubscribe() {
  const el = $('#unsub-body');
  if (!el) return;
  el.innerHTML = '<div class="empty"><span class="spinner"></span>Chargement…</div>';
  let data;
  try {
    data = await api.unsubscribeList({ done: $('#unsub-done')?.checked });
  } catch (err) {
    el.innerHTML = `<div class="notice warn">⚠️ ${esc(err.message)}</div>`;
    return;
  }
  if (!data.senders.length) {
    el.innerHTML = `<div class="empty">Aucun expéditeur avec un lien de désinscription connu.
      Clique « 🔍 Chercher les liens » : l'assistant lit l'en-tête de désinscription du dernier mail
      de chaque newsletter (aucun contenu n'est téléchargé).</div>`;
    return;
  }
  const totalMails = data.senders.reduce((s, x) => s + x.messageCount, 0);
  el.innerHTML = `<div class="panel">
    <div class="panel-head"><h2>Listes dont tu peux te désinscrire</h2>
      <span class="badge orange">${fmtNum(data.senders.length)} expéditeur(s) · ${fmtNum(totalMails)} mails</span></div>
    <div class="panel-body">
      <div class="tablewrap"><table class="table-compact"><thead><tr>
        <th>Boîte</th><th>Expéditeur</th><th class="num">Mails</th><th class="num">Poids</th>
        <th>Méthode</th><th></th></tr></thead><tbody>
      ${data.senders.map((s, i) => {
        const [emoji, label, why] = UNSUB_METHOD[s.method] ?? ['🔗', s.method, ''];
        return `<tr>
          <td style="white-space:nowrap">${accountChip(s.account)}</td>
          <td style="max-width:340px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap"
            title="${esc(s.email)}">${esc(s.displayName || s.email)}
            <span class="muted" style="font-size:11.5px">${esc(s.email)}</span></td>
          <td class="num">${fmtNum(s.messageCount)}</td>
          <td class="num">${fmtSize(s.totalSizeBytes)}</td>
          <td style="white-space:nowrap" title="${esc(why)}">${emoji} ${esc(label)}</td>
          <td style="white-space:nowrap; text-align:right">
            ${s.unsubscribedAt
              ? `<span class="badge green" title="${esc(s.note || '')}">✅ désinscrit</span>`
              : `<button class="btn btn-sm" data-unsub="${i}">🚫 Me désinscrire</button>`}</td>
        </tr>`;
      }).join('')}
      </tbody></table></div>
      <div class="muted" style="font-size:12.5px; padding-top:10px">
        ⚡ <strong>En un clic</strong> = l'expéditeur respecte le standard de désinscription : c'est immédiat et sûr.
        ✉️ <strong>Par mail</strong> = une demande part depuis ta boîte.
        🔗 <strong>Page web</strong> = rien n'est cliqué automatiquement, sa page s'ouvre et tu décides —
        chez un expéditeur douteux, cliquer confirmerait surtout que ton adresse est active.
        <br>Se désinscrire n'efface aucun mail : passe ensuite par <a href="#/cleanup">🧹 Nettoyage rapide</a> pour le stock déjà reçu.</div>
    </div></div>`;

  el.querySelectorAll('[data-unsub]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const s = data.senders[Number(btn.dataset.unsub)];
      if (!confirm(`Se désinscrire de « ${s.displayName || s.email} » ?\n\n${UNSUB_METHOD[s.method]?.[2] ?? ''}`)) return;
      btn.disabled = true;
      btn.textContent = '⏳ En cours…';
      try {
        const r = await api.unsubscribeSender(s.account, s.email);
        if (r.openUrl) {
          // On n'ouvre jamais la page sans toi : c'est ton clic qui l'ouvre.
          if (confirm(`${r.message}\n\nOuvrir la page de désinscription maintenant ?`)) {
            window.open(r.openUrl, '_blank', 'noopener');
            if (confirm('Une fois la démarche faite sur leur site, marquer cet expéditeur comme désinscrit ?')) {
              await api.unsubscribeMark(s.account, s.email);
            }
          }
        } else {
          alert(r.message);
        }
      } catch (err) {
        alert(err.message);
      }
      loadUnsubscribe();
    });
  });
}

// Badge : nombre de listes dont on peut se désinscrire.
async function refreshUnsubBadge() {
  try {
    const { senders } = await api.unsubscribeList({});
    const el = $('#unsub-badge');
    if (!el) return;
    el.textContent = fmtNum(senders.length);
    el.classList.toggle('hidden', senders.length === 0);
  } catch {
    /* pas de badge */
  }
}

// ------------------------------------------ Stratégies de rétention (A3 — Cap V3)
// Règles de bon sens par type de mail × âge (« OTP > 7 j », « newsletters
// jamais ouvertes > 90 j »…), livrées DÉSACTIVÉES. Simulation permanente,
// aperçu exact avant application, corbeille uniquement.

// Niveau de risque d'une stratégie — aussi visible que le gain (revue UI §10).
const RISK_LABELS = {
  very_low: ['très faible', 'green'],
  low: ['faible', 'blue'],
  medium: ['modéré', 'orange'],
};
function riskBadge(risk) {
  const [label, color] = RISK_LABELS[risk] ?? RISK_LABELS.low;
  return `<span class="badge ${color}" title="Niveau de risque : ce que la stratégie peut viser au pire — les protections (étoilés, tâches, échéances, personnes, échanges récents) s'appliquent toujours">risque ${label}</span>`;
}
async function loadRetention() {
  const el = $('#retention-body');
  if (!el) return;
  el.innerHTML = '<div class="panel"><div class="panel-body"><div class="empty"><span class="spinner"></span>Simulation des stratégies…</div></div></div>';
  let data;
  try {
    data = await api.retention();
  } catch (err) {
    el.innerHTML = `<div class="notice warn">⚠️ ${esc(err.message)}</div>`;
    return;
  }
  if (!el.isConnected) return;

  const target = (p) => {
    const parts = [];
    if (p.matchIntent) parts.push(`intention « ${p.matchIntent} »`);
    if (p.matchCategory) parts.push(`expéditeurs « ${p.matchCategory} »`);
    if (p.unseenOnly) parts.push('jamais ouverts');
    return parts.join(' · ');
  };

  el.innerHTML = `<div class="panel">
    <div class="panel-head"><h2>🗂️ Stratégies de rétention</h2>
      <span class="badge gray">${fmtNum(data.policies.filter((p) => p.enabled).length)} activée(s) / ${fmtNum(data.policies.length)}</span></div>
    <div class="panel-body">
      ${data.policies.map((p) => `
        <div class="today-row" style="display:flex; align-items:center; gap:10px; padding:8px 0; border-bottom:1px solid var(--border)">
          <label style="display:flex; align-items:center; gap:6px; cursor:pointer" title="Activer / désactiver cette stratégie">
            <input type="checkbox" class="ret-enable" data-id="${p.id}" ${p.enabled ? 'checked' : ''}></label>
          <div style="flex:1; min-width:0; ${p.enabled ? '' : 'opacity:.55'}">
            <strong>${esc(p.label)}</strong>
            <span class="muted" style="font-size:12px">· ${esc(target(p))} · plus de ${fmtNum(p.ageDays)} j
            ${p.appliedCount ? ` · déjà nettoyé : ${fmtNum(p.appliedCount)}` : ''}</span></div>
          ${riskBadge(p.risk)}
          <span class="badge ${p.matchCount ? 'orange' : 'gray'}" title="Ce que la stratégie viserait aujourd'hui (simulation, rien n'est touché)">
            ${fmtNum(p.matchCount)} mails · ${fmtSize(p.matchSizeBytes)}</span>
          ${p.protectedCount ? `<span class="badge green" title="Mails écartés par la protection : mails étoilés, tâches/échéances liées, expéditeurs ⭐ toujours importants (toujours protégés), et conversations récentes (échanges de moins de 2 ans)">🛡️ ${fmtNum(p.protectedCount)} protégés</span>` : ''}
          <label class="muted" style="font-size:12px; display:flex; align-items:center; gap:4px; ${p.enabled ? '' : 'visibility:hidden'}"
            title="Appliquer automatiquement après chaque synchronisation (uniquement une stratégie déjà activée)">
            <input type="checkbox" class="ret-auto" data-id="${p.id}" ${p.autoApply ? 'checked' : ''}> auto</label>
          <button class="btn btn-sm ret-preview" data-id="${p.id}" ${p.matchCount ? '' : 'disabled'}>👀 Aperçu</button>
          <button class="btn btn-sm btn-primary ret-apply" data-id="${p.id}" data-count="${p.matchCount}"
            data-label="${esc(p.label)}" ${p.enabled && p.matchCount ? '' : 'disabled'}>🧹 Mettre à la corbeille</button>
        </div>`).join('')}
      <div class="muted" style="font-size:12.5px; padding-top:8px">
        Simulation en continu : rien n'est touché tant que tu n'appliques pas. Tout part à la
        corbeille (récupérable ~30 jours) et chaque passage est journalisé. « auto » = la stratégie
        s'applique seule après chaque synchronisation — à activer quand tu lui fais confiance.
        Les compteurs s'appuient sur les catégories : lance « 🏷️ Réexaminer les expéditeurs » dans ⚙️ Paramètres si tout est à zéro.
        <br>🛡️ <strong>Ce qui est protégé :</strong> pour toujours, tes mails étoilés, ceux liés à une tâche
        ou une échéance en cours, et les expéditeurs marqués ⭐ ; et pendant <strong>2 ans</strong>, tout ce
        avec quoi tu as interagi (mail répondu, conversation où tu as écrit). Passé ce délai, un vieil échange
        isolé ne bloque plus le nettoyage.</div>
    </div></div>`;

  el.querySelectorAll('.ret-enable').forEach((box) => {
    box.addEventListener('change', async () => {
      try {
        await api.retentionUpdate(Number(box.dataset.id), { enabled: box.checked });
      } catch (err) {
        alert(err.message);
      }
      loadRetention();
    });
  });
  el.querySelectorAll('.ret-auto').forEach((box) => {
    box.addEventListener('change', async () => {
      if (box.checked && !confirm(
        'Passer cette stratégie en AUTOMATIQUE ?\n\nElle s\'appliquera seule après chaque synchronisation (corbeille, journalisée). Tu peux revenir en arrière à tout moment.',
      )) {
        box.checked = false;
        return;
      }
      try {
        await api.retentionUpdate(Number(box.dataset.id), { autoApply: box.checked });
      } catch (err) {
        alert(err.message);
      }
      loadRetention();
    });
  });
  el.querySelectorAll('.ret-preview').forEach((btn) => {
    btn.addEventListener('click', () => openRetentionPreview(Number(btn.dataset.id)));
  });
  el.querySelectorAll('.ret-apply').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm(
        `Lancer « ${btn.dataset.label} » ?\n\n≈ ${btn.dataset.count} mails partiront à la corbeille (récupérables ~30 jours). L'opération tourne en arrière-plan et est journalisée.`,
      )) return;
      btn.disabled = true;
      try {
        await api.retentionApply(Number(btn.dataset.id));
        pollJobs();
        alert('🧹 Application lancée — suis l\'avancement via la pastille d\'activité, puis actualise.');
      } catch (err) {
        btn.disabled = false;
        alert(err.message);
      }
    });
  });
}

// -------------------------------- Suggestions (A6 — Cap V3) : #/suggestions
// L'assistant apprend de tes décisions et PROPOSE — il n'agit jamais seul.
// ------------------------------------------------- Mes dossiers : #/dossiers
//
// Un dossier = un sujet de vie qui traverse les interlocuteurs. « 46 rue de la
// République » apparaît chez 45 correspondants différents et dans 4 boîtes :
// regrouper par expéditeur l'éclate, regrouper par sujet le reconstitue.
//
// CE QUE FAIT CET ÉCRAN, et rien d'autre : corriger ce que l'assistant a
// compris. Renommer, fusionner deux dossiers qui n'en font qu'un, masquer ce
// qui n'en est pas un. AUCUN mail n'est déplacé, AUCUN dossier n'est créé dans
// la boîte — il n'a jamais rangé en dix ans et ne rangera pas.
//
// Sa correction n'est jamais écrasée par une réanalyse : c'est la seule chose
// qui compte. 114 règles de classement ont été suggérées, aucune activée — une
// correction qu'on efface est une correction qu'on ne refait pas.
let _dossiers = [];
let _fusionSource = null;

/**
 * Ouvre une modale simple (titre + corps + pied). Reprend l'ossature maison
 * `.modal-overlay > .modal > .modal-head/.modal-body/.modal-foot` — ces classes
 * ne doivent JAMAIS servir hors d'une modale, plusieurs écrans les ciblent par
 * sélecteur global. On n'utilise pas non plus l'id `modal-body`, déjà pris par
 * la modale de nettoyage.
 */
function ouvrirModale(titre, corpsHtml, piedHtml = '') {
  closeModal();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay under-reader';
  overlay.innerHTML = `<div class="modal">
    <div class="modal-head"><h2>${titre}</h2>
      <button class="modal-close" title="Fermer">✕</button></div>
    <div class="modal-body">${corpsHtml}</div>
    ${piedHtml ? `<div class="modal-foot">${piedHtml}</div>` : ''}
  </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('.modal-close').addEventListener('click', closeModal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
  return overlay;
}

// ════════════════════════════ AFFAIRES EN COURS (18/08) ════════════════════
// Les engagements pris qui n'ont pas abouti. À NE PAS CONFONDRE avec
// « 📁 Mes dossiers », qui regroupe des mails par sujet : ici, le déclencheur
// est un SILENCE. Un mandat confié il y a un an et jamais inscrit au greffe
// n'a ni échéance, ni montant dû, ni mail entrant — rien ne le rappellerait.
let _affaires = [];

async function renderAffaires() {
  const main = $('#main');
  // Pas de hubTabs() ici : le routeur les injecte lui-même en tête de #main
  // après l'appel du renderer (cf. `insertAdjacentHTML('afterbegin', tabs)`).
  // Les poser aussi ici les afficherait EN DOUBLE — constaté à la capture.
  main.innerHTML = `<div class="page-head">
    <div><h1>🧭 Affaires en cours</h1>
      <div class="sub">Ce que tu as engagé et qui n'est pas terminé : une formalité confiée à un
      cabinet, une procédure payée à moitié, un dossier au greffe. Quand la date de vérification
      arrive sans preuve que c'est fait, l'affaire passe en <strong>à relancer</strong>.
      Aucun mail n'est jamais envoyé sans que tu cliques.</div></div>
    <div class="head-actions">
      <button class="btn btn-primary" id="aff-new">➕ Nouvelle affaire</button>
      <button class="btn" id="aff-refresh">↻ Actualiser</button></div></div>
    <div id="aff-body"><div class="empty"><span class="spinner"></span>Chargement des affaires…</div></div>`;
  $('#aff-refresh').addEventListener('click', loadAffaires);
  $('#aff-new').addEventListener('click', () => formulaireAffaire());
  await loadAffaires();
}

async function loadAffaires() {
  const body = $('#aff-body');
  if (!body) return;
  body.innerHTML = '<div class="empty"><span class="spinner"></span>Chargement des affaires…</div>';
  let d;
  try {
    d = await api.engagements();
  } catch (err) {
    body.innerHTML = `<div class="notice warn">⚠️ ${esc(err.message)}</div>`;
    return;
  }
  if (!body.isConnected) return;
  _affaires = d.items ?? [];

  if (!_affaires.length) {
    body.innerHTML = `<div class="empty">
      <p>🧭 Aucune affaire en cours pour l'instant.</p>
      <p class="muted">Une affaire, c'est quelque chose que tu as lancé et qui doit aboutir :
      une cession de parts confiée à un cabinet, un changement de gérant, un dossier au greffe.
      L'assistant ne peut pas les deviner tout seul — mais une fois notée, il te rappellera
      de vérifier si rien ne bouge.</p>
      <button class="btn btn-primary" id="aff-empty-new">➕ Noter ma première affaire</button></div>`;
    $('#aff-empty-new')?.addEventListener('click', () => formulaireAffaire());
    return;
  }

  const c = d.compteurs ?? {};
  const alerte = c.aRelancer > 0
    ? `<div class="notice warn">⚠️ <strong>${fmtNum(c.aRelancer)} affaire${c.aRelancer > 1 ? 's' : ''}</strong>
       ${c.aRelancer > 1 ? 'dorment' : 'dort'} sans preuve d'aboutissement — à relancer.</div>`
    : `<div class="notice">✅ Aucune affaire en souffrance : toutes ont une vérification à venir.</div>`;

  body.innerHTML = alerte + _affaires.map(carteAffaire).join('');
  brancherAffaires();
}

function carteAffaire(a) {
  const badge = a.aRelancer
    ? '<span class="badge red">⚠️ à relancer</span>'
    : a.status === 'propose'
      ? '<span class="badge orange">💡 proposée</span>'
      : '<span class="badge green">🕐 en cours</span>';
  const qui = a.contactName || a.contactEmail || null;
  // Le montant est DÉJÀ dans `pourquoi` (construit côté serveur) : l'ajouter
  // ici l'affichait deux fois sur la même ligne — constaté à la capture.
  const preuves = (a.preuves ?? []).length
    ? `<details class="aff-preuves"><summary>${a.preuves.length} mail${a.preuves.length > 1 ? 's' : ''}
         qui le prouvent</summary><ul>${a.preuves.map((p) => `<li>
         ${p.isOutbound ? '→' : '←'} ${esc(fmtDate(p.date))} —
         ${esc((p.subject || '(sans objet)').slice(0, 70))}</li>`).join('')}</ul></details>`
    : '';
  return `<div class="card aff-card" data-id="${a.id}">
    <div class="aff-head">
      <div class="aff-title">${badge} <strong>${esc(a.label)}</strong></div>
      ${a.dossierLabel ? `<span class="muted">📁 ${esc(a.dossierLabel)}</span>` : ''}
    </div>
    <div class="aff-why">${esc(a.pourquoi)}</div>
    ${a.expected ? `<div class="aff-attendu">Attendu : ${esc(a.expected)}</div>` : ''}
    ${qui ? `<div class="muted">Interlocuteur : ${esc(qui)}</div>` : ''}
    <div class="aff-actions">
      <button class="btn btn-primary btn-sm" data-act="relance" data-id="${a.id}">✉️ Préparer la relance</button>
      <button class="btn btn-sm" data-act="clore" data-id="${a.id}">✅ C'est fait</button>
      <button class="btn btn-sm" data-act="reporter" data-id="${a.id}">⏰ Revoir plus tard</button>
      <button class="btn btn-sm" data-act="editer" data-id="${a.id}">✏️ Modifier</button>
    </div>
    ${preuves}</div>`;
}

function brancherAffaires() {
  document.querySelectorAll('#aff-body [data-act]').forEach((b) => {
    b.addEventListener('click', async () => {
      const id = Number(b.dataset.id);
      const a = _affaires.find((x) => x.id === id);
      try {
        if (b.dataset.act === 'relance') {
          const br = await api.brouillonRelance(id);
          modaleBrouillon(br, a);
        } else if (b.dataset.act === 'clore') {
          if (!confirm(`Marquer « ${a?.label ?? ''} » comme terminée ?\n\nElle sortira de cet écran et de la vue du jour, mais restera consultable.`)) return;
          await api.engagementClore(id);
          await loadAffaires();
        } else if (b.dataset.act === 'reporter') {
          const j = prompt('Revoir cette affaire dans combien de jours ?', '30');
          if (!j) return;
          await api.engagementReporter(id, Number(j) || 30);
          await loadAffaires();
        } else if (b.dataset.act === 'editer') {
          formulaireAffaire(a);
        }
      } catch (err) {
        alert(err.message);
      }
    });
  });
}

/** Formulaire de création / modification. Cinq champs, pas trente. */
function formulaireAffaire(a = null) {
  const v = (x) => esc(x ?? '');
  const dateVal = (d) => (d ? String(d).slice(0, 10) : '');
  ouvrirModale(a ? '✏️ Modifier l\'affaire' : '➕ Nouvelle affaire', `
    <div class="form-vert">
      <p class="muted">Note ce que tu as engagé et quand tu veux qu'on vérifie que ça a abouti.
      Tu peux le faire même s'il n'y a aucun mail : c'est justement le cas des choses qu'on oublie.</p>
      <label>Intitulé
        <input id="aff-label" type="text" value="${v(a?.label)}"
          placeholder="ex. Remontée de mes parts dans la holding"></label>
      <label>Ce que j'attends concrètement
        <input id="aff-expected" type="text" value="${v(a?.expected)}"
          placeholder="ex. les parts inscrites au greffe"></label>
      <label>Engagée le
        <input id="aff-opened" type="date" value="${dateVal(a?.openedAt) || new Date().toISOString().slice(0, 10)}"></label>
      <label>Vérifier le <span class="muted">(si rien n'a bougé d'ici là, l'affaire passera « à relancer »)</span>
        <input id="aff-review" type="date" value="${dateVal(a?.reviewAt)}"></label>
      <label>Montant déjà réglé <span class="muted">(facultatif — sert d'argument dans la relance)</span>
        <input id="aff-amount" type="number" step="0.01" value="${a?.amountPaid ?? ''}"></label>
      <label>Interlocuteur à relancer <span class="muted">(email)</span>
        <input id="aff-contact" type="email" value="${v(a?.contactEmail)}" placeholder="ex. contact@cabinet.fr"></label>
      <label>Notes
        <textarea id="aff-notes" rows="3" placeholder="ce que tu veux te rappeler">${v(a?.notes)}</textarea></label>
    </div>`,
    `${a ? '<button class="btn btn-danger" id="aff-del">🗑️ Supprimer</button>' : ''}
      <button class="btn" id="aff-cancel">Annuler</button>
      <button class="btn btn-primary" id="aff-save">${a ? 'Enregistrer' : 'Créer l\'affaire'}</button>`);

  $('#aff-cancel').addEventListener('click', closeModal);
  $('#aff-del')?.addEventListener('click', async () => {
    if (!confirm('Supprimer cette affaire ?\n\nAucun mail ne sera touché.')) return;
    await api.engagementSupprimer(a.id);
    closeModal();
    await loadAffaires();
  });
  $('#aff-save').addEventListener('click', async () => {
    const data = {
      label: $('#aff-label').value.trim(),
      expected: $('#aff-expected').value.trim() || null,
      openedAt: $('#aff-opened').value || null,
      reviewAt: $('#aff-review').value || null,
      amountPaid: $('#aff-amount').value ? Number($('#aff-amount').value) : null,
      contactEmail: $('#aff-contact').value.trim() || null,
      notes: $('#aff-notes').value.trim() || null,
    };
    if (!data.label) { alert('Il faut au moins un intitulé.'); return; }
    try {
      if (a) await api.engagementModifier(a.id, data);
      else await api.engagementCreer(data);
      closeModal();
      await loadAffaires();
    } catch (err) {
      alert(err.message);
    }
  });
}

/**
 * Le brouillon. Il s'ouvre PRÉ-REMPLI de ce qui est prouvé (date d'engagement,
 * montant réglé, dernier message reçu) et se copie en un clic. Il n'est JAMAIS
 * envoyé d'ici : c'est lui qui envoie, depuis sa messagerie.
 */
/**
 * @param {object} br      le brouillon rendu par le serveur
 * @param {object|null} a  l'affaire, quand le brouillon en vient (report auto)
 * @param {object} opts    { titre, apresEnvoi } — pour les attentes (26/08),
 *                         qui ne sont pas des affaires et n'ont pas de report.
 */
function modaleBrouillon(br, a, opts = {}) {
  ouvrirModale(opts.titre || '✉️ Brouillon de relance', `
    <div class="form-vert">
      <p class="muted">Rien ne part tant que tu n'as pas envoyé toi-même. Relis, corrige, copie.</p>
      <label>À<input id="br-to" type="text" value="${esc(br.to)}" placeholder="choisis ci-dessous ou saisis une adresse"></label>
      ${(br.candidats ?? []).length ? `<div class="br-candidats">
        <span class="muted">${br.to ? 'Autres destinataires possibles' : 'À qui écrire ?'} —</span>
        ${br.candidats.map((c) => `<button type="button" class="find-chip br-cand" data-email="${esc(c.email)}"
          title="${esc(c.email)}${c.messages ? ` · ${c.messages} message(s)` : ''}${c.dernier ? ` · dernier le ${esc(c.dernier)}` : ''}">
          ${c.dejaEchange ? '↩︎ ' : ''}${esc(c.nom || c.email)}
          <span class="muted">${c.origine === 'fil' ? 'dans ce fil' : (c.messages ? `${c.messages} msg` : '')}</span>
        </button>`).join('')}
      </div>` : ''}
      <label>Objet<input id="br-subject" type="text" value="${esc(br.subject)}"></label>
      <label>Message<textarea id="br-body" rows="14">${esc(br.body)}</textarea></label>
      ${(br.appuis ?? []).length ? `<details><summary>Sur quoi ce brouillon s'appuie</summary>
        <ul>${br.appuis.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></details>` : ''}
    </div>`,
    `<span class="muted" id="br-etat"></span>
      <button class="btn" id="br-close">Fermer</button>
      <button class="btn" id="br-copy">📋 Copier</button>
      <button class="btn btn-primary" id="br-send">✉️ Envoyer</button>`);
  $('#br-close').addEventListener('click', closeModal);

  // À QUI ÉCRIRE. Son retour du 26/08, écran en main : « à quoi bon sans avoir
  // le destinataire ». Le champ arrivait vide dès que l'attente n'était
  // rattachée à aucun fil. On ne devine pas une adresse — on présente les
  // candidats, et c'est lui qui tranche en un clic.
  document.querySelectorAll('.br-cand').forEach((b) => {
    b.addEventListener('click', () => {
      const champ = $('#br-to');
      champ.value = b.dataset.email;
      champ.focus();
      document.querySelectorAll('.br-cand').forEach((x) => x.classList.remove('actif'));
      b.classList.add('actif');
    });
  });

  // ENVOYER (18/08). L'invariant du chantier était « rien ne part sans son
  // clic » ; je l'avais appliqué en « rien ne part du tout », ce qui rendait
  // le brouillon inutile — il fallait copier-coller dans sa messagerie. Son
  // retour : « super le brouillon, je ne peux même pas l'envoyer… ». Le clic
  // sur ce bouton EST le consentement explicite : l'invariant est tenu, et
  // c'est bien lui qui décide, après avoir relu et corrigé.
  $('#br-send').addEventListener('click', async () => {
    const bouton = $('#br-send');
    const etat = $('#br-etat');
    const to = $('#br-to').value.trim();
    const subject = $('#br-subject').value.trim();
    const text = $('#br-body').value;
    const compte = br.accountSlug;
    if (!compte) { alert('Aucune boîte d\'envoi connue pour cette affaire — ouvre « ✏️ Modifier » et renseigne-la.'); return; }
    if (!to) { alert('Il manque le destinataire.'); return; }
    if (!subject) { alert('Il manque l\'objet.'); return; }
    if (!confirm(`Envoyer ce message à ${to}, depuis la boîte ${compte} ?`)) return;
    bouton.disabled = true;
    etat.textContent = 'envoi en cours…';
    try {
      await api.sendMail(compte, { to, subject, text });
      closeModal();
      showUndoToast(`✉️ Relance envoyée à ${to}.`, null);
      // Une relance envoyée repousse la vérification : inutile de le relancer
      // demain sur une affaire qu'il vient de relancer aujourd'hui.
      if (a?.id) {
        try { await api.engagementReporter(a.id, 15); } catch { /* pas bloquant */ }
        await loadAffaires();
      }
      if (opts.apresEnvoi) await opts.apresEnvoi();
    } catch (err) {
      bouton.disabled = false;
      etat.textContent = '';
      alert(`L'envoi a échoué : ${err.message}`);
    }
  });
  $('#br-copy').addEventListener('click', async () => {
    const txt = $('#br-body').value;
    try {
      await navigator.clipboard.writeText(txt);
      $('#br-copy').textContent = '✅ Copié';
    } catch {
      $('#br-body').select();
      $('#br-copy').textContent = 'Sélectionné — Ctrl+C';
    }
  });
}

/* ==========================================================================
   🔭 SUIVI — ce qui est attendu, de moi ou d'eux.

   Ni une boîte de réception, ni une todo-list. « Une todo-list dit : 37 tâches
   restantes. Ce produit doit dire : voici ce qui mérite ton attention
   maintenant. »

   Deux règles portent tout l'écran :
   · l'URGENT n'est jamais plafonné — un plafond protège l'attention, jamais
     l'utilisateur contre une information critique ;
   · chaque carte propose une ACTION, pas seulement un constat. Sans passage
     immédiat de la détection à l'action, on fabrique un très bon tableau de
     culpabilité que l'utilisateur referme.
   ========================================================================== */

const ATT_URGENCE = {
  critique: { pastille: '🔴', mot: 'Urgent' },
  haute: { pastille: '🟠', mot: 'Bientôt' },
  moyenne: { pastille: '🟡', mot: '' },
  faible: { pastille: '', mot: '' },
};

function attDelai(a) {
  if (a.dansJours === null) return '';
  if (a.dansJours < -400) return `il y a ${Math.round(-a.dansJours / 365)} an(s)`;
  if (a.dansJours < -60) return `il y a ${Math.round(-a.dansJours / 30)} mois`;
  if (a.dansJours < 0) return `il y a ${-a.dansJours} jour${a.dansJours < -1 ? 's' : ''}`;
  if (a.dansJours === 0) return "aujourd'hui";
  if (a.dansJours <= 31) return `dans ${a.dansJours} jour${a.dansJours > 1 ? 's' : ''}`;
  return `dans ${Math.round(a.dansJours / 30)} mois`;
}

function carteAttente(a) {
  const u = ATT_URGENCE[a.urgence] ?? ATT_URGENCE.faible;
  const delai = attDelai(a);
  const montant = a.montant
    ? `<span class="att-montant">${a.montant.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${esc(a.devise === 'EUR' ? '€' : a.devise || '')}</span>`
    : '';
  const principale = a.actions.find((x) => x.principale);
  const autres = a.actions.filter((x) => !x.principale && x.code === 'voir');
  const discrets = a.actions.filter((x) => x.code === 'regle' || x.code === 'ecarter');

  return `<article class="att-carte ${a.urgence === 'critique' ? 'att-critique' : ''}" data-att="${a.id}">
    <header class="att-tete">
      <div class="att-qui">${u.pastille} ${esc(a.qui)}</div>
      ${delai ? `<div class="att-delai">${esc(delai)}</div>` : ''}
    </header>
    <div class="att-quoi">${esc(a.quoi)} ${montant}</div>
    ${a.risque ? `<div class="att-risque">⚖️ ${esc(a.risque)}</div>` : ''}
    <p class="att-pourquoi">${esc(a.pourquoi)}</p>
    <footer class="att-actions">
      ${principale ? `<button class="btn btn-primary btn-sm" data-act="${principale.code}">${esc(principale.libelle)}</button>` : ''}
      ${autres.map((x) => `<button class="btn btn-sm" data-act="${x.code}">${esc(x.libelle)}</button>`).join('')}
      <span class="att-discret">${discrets
        .map((x) => `<button class="att-lien" data-act="${x.code}">${esc(x.libelle)}</button>`)
        .join('')}</span>
    </footer>
  </article>`;
}

function sectionAttentes(titre, sous, liste, vide) {
  if (!liste.length) return vide ? `<div class="att-section"><h2>${titre}</h2><div class="empty">${vide}</div></div>` : '';
  return `<div class="att-section">
    <h2>${titre} <span class="badge">${liste.length}</span></h2>
    ${sous ? `<div class="att-sous">${sous}</div>` : ''}
    <div class="att-grille">${liste.map(carteAttente).join('')}</div>
  </div>`;
}

async function renderSuivi() {
  const main = $('#main');
  main.innerHTML = `<div class="page-head">
    <div><h1>🔭 Ce qui est attendu</h1>
      <div class="sub">Ce que tu dois à quelqu'un, et ce que quelqu'un te doit. Rien n'est rangé,
      rien n'est supprimé : c'est un suivi, pas une boîte de réception.</div></div>
    <div class="head-actions"><button class="btn" id="att-refresh">↻ Actualiser</button></div></div>
    <div id="att-body"><div class="empty"><span class="spinner"></span>Lecture du suivi…</div></div>`;
  $('#att-refresh').addEventListener('click', chargerSuivi);
  await chargerSuivi();
}

/** Les attentes actuellement à l'écran — les actions ont besoin du détail. */
let _attentes = [];

async function chargerSuivi() {
  const body = $('#att-body');
  if (!body) return;
  let d;
  try {
    d = await api.attentes();
  } catch (err) {
    body.innerHTML = `<div class="notice warn">⚠️ ${esc(err.message)}</div>`;
    return;
  }
  if (!body.isConnected) return;
  _attentes = [...d.urgences, ...d.aToi, ...d.tuAttends, ...d.retrouve];

  if (!d.compteurs.total) {
    body.innerHTML = `<div class="empty">Rien en attente. 🎉 Les attentes apparaissent quand
      l'assistant repère qu'une transition prévue n'a pas eu lieu — une réponse promise, un
      document annoncé, une signature qui manque.</div>`;
    return;
  }

  const urg = d.urgences.length;
  const bandeau = urg
    ? `<div class="notice warn att-bandeau">⚖️ <strong>${urg} sujet${urg > 1 ? 's' : ''}</strong>
       ${urg > 1 ? 'présentent' : 'présente'} un risque juridique ou réglementaire identifié.
       ${d.urgences.filter((a) => (a.dansJours ?? 99) <= 30 && (a.dansJours ?? 99) >= -5).length
         ? "Dont au moins un avec une échéance proche."
         : ''}</div>`
    : '';

  body.innerHTML = `
    ${bandeau}
    ${sectionAttentes('À surveiller', 'Ces sujets ne sont pas plafonnés : attendre peut coûter un droit ou une pénalité.', d.urgences)}
    ${sectionAttentes('Ce qui attend ton action', '', d.aToi)}
    ${sectionAttentes('Les réponses que tu attends', '', d.tuAttends)}
    ${d.retrouve.length
      ? `<details class="att-stock"><summary>J'ai aussi retrouvé ${d.retrouve.length} sujet(s) plus anciens qui semblent restés en plan</summary>
         <div class="att-grille">${d.retrouve.map(carteAttente).join('')}</div></details>`
      : ''}
    ${d.enReserve
      ? `<div class="att-reserve">${d.enReserve} autre(s) sujet(s) attendent leur tour — ils remonteront
         au fil des jours plutôt que de tout afficher d'un coup.</div>`
      : ''}`;

  body.querySelectorAll('[data-att]').forEach((carte) => {
    const id = Number(carte.dataset.att);
    carte.querySelectorAll('[data-act]').forEach((b) =>
      b.addEventListener('click', () => gesteAttente(id, b.dataset.act, carte)),
    );
  });
}

/**
 * « C'est réglé » — avec la possibilité de dire POURQUOI.
 *
 * Sa demande du 26/08 : « lorsque l'on dit "c'est réglé", il faudrait pouvoir
 * saisir le pourquoi au besoin ». C'est la seule information qu'aucun mail ne
 * portera jamais : payé par téléphone, signé sur place, sans objet parce que
 * le chantier est annulé.
 *
 * ⚠️ FACULTATIF, ET ÇA SE VOIT. « Sans détail » est proposé au même rang que
 * « Enregistrer », et Entrée valide directement : le geste ne doit pas devenir
 * un formulaire. Le corollaire de conception tient — rien ne doit dépendre
 * d'un entretien manuel régulier.
 */
function demanderPourquoi(code, quoi) {
  return new Promise((resolve) => {
    const regle = code === 'regle';
    ouvrirModale(
      regle ? '✓ C’est réglé' : '✕ Sans suite',
      `<div class="form-vert">
        <p class="muted">${esc(quoi.slice(0, 140))}</p>
        <label>${regle ? 'Comment ça s’est réglé ?' : 'Pourquoi sans suite ?'}
          <input id="att-note" type="text" maxlength="400" autocomplete="off"
            placeholder="${regle ? 'ex. payé par téléphone le 12, reçu classé' : 'ex. chantier annulé'}">
        </label>
        <p class="muted">Facultatif — c’est pour toi, dans six mois, quand tu ne t’en
        souviendras plus. Rien n’est envoyé à personne.</p>
      </div>`,
      `<button class="btn" id="att-annule">Annuler</button>
       <button class="btn" id="att-sans">Sans détail</button>
       <button class="btn btn-primary" id="att-ok">Enregistrer</button>`,
    );
    const champ = $('#att-note');
    champ?.focus();
    const finir = (v) => { closeModal(); resolve(v); };
    $('#att-annule').addEventListener('click', () => finir(null));
    $('#att-sans').addEventListener('click', () => finir(''));
    $('#att-ok').addEventListener('click', () => finir(champ.value.trim()));
    champ?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finir(champ.value.trim()); }
    });
  });
}

async function gesteAttente(id, code, carte) {
  if (code === 'regle' || code === 'ecarter') {
    const a = _attentes?.find((x) => x.id === id);
    const note = await demanderPourquoi(code, a?.quoi ?? '');
    if (note === null) return; // annulé : on ne referme rien
    try {
      await api.attenteGeste(id, code, note);
      carte.classList.add('att-partie');
      setTimeout(chargerSuivi, 400);
    } catch (err) {
      alert(err.message);
    }
    return;
  }
  // « Voir l'histoire » : la recherche sur le correspondant, qui rassemble ce
  // qui le concerne toutes boîtes confondues. Un dossier traverse en moyenne
  // 3 à 4 boîtes chez lui — chercher dans une seule n'aurait aucun sens.
  if (code === 'voir') {
    const a = _attentes?.find((x) => x.id === id);
    if (!a) return;
    /**
     * ⚠️ LE MOT LE PLUS LONG N'EST PAS LE PLUS DISTINCTIF (corrigé le 27/08).
     *
     * Mesuré à l'écran sur le dossier « Comptabilité Client SIDER » — un
     * remboursement de 1 000 € : le mot le plus long est « Comptabilite »
     * (12 lettres), et la recherche rendait 153 mails chez 42 interlocuteurs,
     * dont aucun ne concernait l'affaire. Son verdict : « c'est n'importe quoi,
     * tu donnes l'impression d'avoir créé un truc solide mais c'est du vent ».
     *
     * Le mot qui désigne quelqu'un ici est « SIDER » — 5 lettres. On écarte
     * donc d'abord tout le vocabulaire de service (client, compta, relation,
     * litiges…), puis on prend le PREMIER mot restant : dans un libellé, le
     * nom propre vient en général après la fonction.
     */
    const CREUX = /^(client|clients|clientele|compta|comptable|comptabilite|service|services|relation|relations|contact|contacts|facturation|facture|factures|litige|litiges|encours|commercial|commerciale|support|assistance|accueil|info|infos|admin|administratif|direction|secretariat|gestion|recouvrement|reclamation|juridique|agence|cabinet|bureau|siege|groupe|equipe|maitre|madame|monsieur|sarl|sasu|eurl|selarl|societe|entreprise|pour|avec|dans|chez|suite|dossier|demande)$/i;
    const mots = (a.qui || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .split(/[^A-Za-zÀ-ÿ0-9]+/)
      .filter((m) => m.length >= 4 && !CREUX.test(m));
    // Si tout est générique, la recherche par nom ne trouverait que du bruit :
    // on ouvre alors la conversation elle-même quand on la connaît.
    if (!mots.length && a.threadId) { location.hash = `#/search?q=${encodeURIComponent(a.qui)}`; return; }
    const terme = a.quiEmail || mots[0] || a.qui;
    location.hash = `#/search?q=${encodeURIComponent(terme)}`;
    return;
  }

  // Toutes les autres actions rédigent un brouillon. Le serveur choisit la
  // forme selon le côté : une relance quand ils doivent, une prise de contact
  // quand c'est à moi de bouger.
  const btn = carte.querySelector(`[data-act="${code}"]`);
  if (btn) { btn.disabled = true; btn.textContent = 'préparation…'; }
  try {
    const br = await api.brouillonAttente(id);
    const a = _attentes?.find((x) => x.id === id);
    modaleBrouillon(br, null, {
      titre: a?.cote === 'eux' ? '✉️ Brouillon de relance' : '✉️ Brouillon de réponse',
      apresEnvoi: chargerSuivi,
    });
  } catch (err) {
    alert(err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      const a = _attentes?.find((x) => x.id === id);
      const act = a?.actions.find((x) => x.code === code);
      btn.textContent = act?.libelle ?? 'Préparer';
    }
  }
}

/* ==========================================================================
   💶 ARGENT — « qu'ai-je versé à X ? »
   Volontairement PAR TIERS et pièce par pièce. Un total de portefeuille
   mélangerait des annonces immobilières (un château à 2 680 000 €), des
   budgets de copropriété et des pesos chiliens : mesuré le 26/08 sur les
   vraies données. Restreint à un tiers, le même matériau est exact — il rend
   les 1 131,26 € du dossier Legalfree au centime près.
   ========================================================================== */

const LIB_PIECE = {
  receipt: { t: '✅ Reçu', c: 'ok' },
  invoice: { t: '🧾 Facture', c: 'warn' },
  quote: { t: '📄 Devis', c: '' },
  tax_notice: { t: '🏛️ Avis', c: 'warn' },
  statement: { t: '📊 Relevé', c: '' },
  contract: { t: '📜 Contrat', c: '' },
  legal_notice: { t: '⚖️ Acte', c: '' },
};

const fmtEur = (n, d) =>
  `${n.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${d === 'EUR' ? '€' : esc(d)}`;

async function renderArgent() {
  const main = $('#main');
  main.innerHTML = `<div class="page-head">
    <div><h1>💶 Où est passé mon argent</h1>
      <div class="sub">Cherche un fournisseur, un prestataire, une société : tu vois ce que tu lui as
      <strong>versé</strong>, ce qu'il t'a <strong>facturé</strong> et ce qu'il t'a <strong>proposé</strong>,
      pièce par pièce. Volontairement pas de total général : additionner une annonce immobilière,
      un budget de copropriété et un reçu n'aurait aucun sens.</div></div></div>
    <div class="panel">
      <div class="panel-body">
        <div class="arg-row">
          <input type="search" id="arg-q" class="input" placeholder="Legalfree, EDF, Leroy Merlin…"
                 autocomplete="off" style="flex:1;min-width:220px">
          <button class="btn btn-primary" id="arg-go">🔎 Chercher</button>
        </div>
        <div id="arg-tiers" class="arg-tiers"></div>
      </div>
    </div>
    <div id="arg-body"></div>`;

  const lancer = () => chercherArgent($('#arg-q').value.trim());
  $('#arg-go').addEventListener('click', lancer);
  $('#arg-q').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') lancer();
  });

  try {
    const d = await api.argentTiers(28);
    const z = $('#arg-tiers');
    if (!z || !z.isConnected) return;
    z.innerHTML =
      `<div class="arg-hint">Les tiers les plus présents dans tes pièces :</div>` +
      (d.tiers ?? [])
        .map(
          (t) =>
            `<button class="arg-chip" data-tiers="${esc(t.libelle)}">${esc(t.libelle)}
             <span class="arg-chip-n">${fmtNum(t.nbPieces)}</span></button>`,
        )
        .join('');
    z.querySelectorAll('[data-tiers]').forEach((b) =>
      b.addEventListener('click', () => {
        $('#arg-q').value = b.dataset.tiers;
        chercherArgent(b.dataset.tiers);
      }),
    );
  } catch (err) {
    const z = $('#arg-tiers');
    if (z) z.innerHTML = `<div class="notice warn">⚠️ ${esc(err.message)}</div>`;
  }
}

async function chercherArgent(q) {
  const body = $('#arg-body');
  if (!body) return;
  if (!q || q.length < 2) {
    body.innerHTML = `<div class="empty">Saisis au moins deux caractères.</div>`;
    return;
  }
  body.innerHTML = `<div class="empty"><span class="spinner"></span>Lecture des pièces…</div>`;
  let d;
  try {
    d = await api.argentSuivi(q);
  } catch (err) {
    body.innerHTML = `<div class="notice warn">⚠️ ${esc(err.message)}</div>`;
    return;
  }
  if (!body.isConnected) return;

  if (!d.pieces?.length) {
    body.innerHTML = `<div class="empty">Aucune pièce chiffrée pour « ${esc(q)} ».
      ${(d.avertissements ?? []).map((a) => `<div class="notice warn" style="margin-top:12px">⚠️ ${esc(a)}</div>`).join('')}</div>`;
    return;
  }

  const totaux = d.totaux
    .map(
      (t) => `<div class="arg-total">
        <div class="arg-total-head">${esc(t.devise)} · ${fmtNum(t.nbPieces)} pièce(s)</div>
        <div class="arg-total-ligne"><span>✅ Versé</span><strong>${fmtEur(t.verse, t.devise)}</strong></div>
        <div class="arg-total-ligne"><span>🧾 Facturé</span><strong>${fmtEur(t.facture, t.devise)}</strong></div>
        <div class="arg-total-ligne"><span>📄 Proposé</span><strong>${fmtEur(t.propose, t.devise)}</strong></div>
        ${t.autre ? `<div class="arg-total-ligne"><span>Autres pièces</span><strong>${fmtEur(t.autre, t.devise)}</strong></div>` : ''}
      </div>`,
    )
    .join('');

  body.innerHTML = `
    ${(d.avertissements ?? []).map((a) => `<div class="notice warn">⚠️ ${esc(a)}</div>`).join('')}
    <div class="arg-totaux">${totaux}</div>
    <div class="panel">
      <div class="panel-head"><h2>Les pièces</h2><span class="badge">${fmtNum(d.pieces.length)}</span></div>
      <div class="panel-body">
        <div class="arg-hint">Dans l'ordre chronologique. Clique une ligne pour ouvrir le mail d'origine.</div>
        <div class="arg-liste">
          ${d.pieces
            .map((p, i) => {
              const lib = LIB_PIECE[p.kind] ?? { t: `📎 ${esc(p.kind)}`, c: '' };
              const j = new Date(p.date);
              return `<button class="arg-piece" data-i="${i}">
                <span class="arg-date">${j.toLocaleDateString('fr-FR')}</span>
                <span class="arg-montant">${fmtEur(p.amount, p.currency)}</span>
                <span class="arg-kind ${lib.c}">${lib.t}</span>
                <span class="arg-sujet">${esc(p.subject ?? '(sans sujet)')}
                  ${p.reference ? `<span class="arg-ref">réf. ${esc(p.reference)}</span>` : ''}</span>
                <span class="arg-boite">${esc(p.accountSlug)}</span>
              </button>`;
            })
            .join('')}
        </div>
      </div>
    </div>`;

  body.querySelectorAll('.arg-piece').forEach((b) =>
    b.addEventListener('click', () => {
      const p = d.pieces[Number(b.dataset.i)];
      openReaderFor(
        {
          account: p.accountSlug,
          folder: p.folder,
          uid: p.uid,
          subject: p.subject,
          fromName: p.fromName,
          fromEmail: p.fromEmail,
          date: p.date,
        },
        { dock: true },
      );
    }),
  );
}

async function renderDossiers() {
  const main = $('#main');
  main.innerHTML = `<div class="page-head">
    <div><h1>📁 Mes dossiers</h1>
      <div class="sub">Les sujets qui traversent tes interlocuteurs — un bien, une société, un véhicule,
      une affaire. C'est l'analyse qui les propose en lisant tes mails ; ici tu corriges.
      Rien n'est déplacé dans ta boîte.</div></div>
    <div class="head-actions">
      <button class="btn" id="dos-spread">🔗 Retrouver les mails qui en parlent</button>
      <button class="btn" id="dos-refresh">↻ Actualiser</button></div></div>
    <div id="dos-body"><div class="empty"><span class="spinner"></span>Chargement des dossiers…</div></div>`;
  $('#dos-refresh').addEventListener('click', loadDossiers);
  $('#dos-spread').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await api.dossiersPropager();
      pollJobs();
      $('#dos-body').innerHTML = `<div class="notice">🔗 Recherche lancée — l'assistant rattache aux
        dossiers connus les mails qui les citent. Suis l'avancement via la pastille d'activité, puis
        actualise cet écran.</div>`;
    } catch (err) {
      alert(err.message);
      e.target.disabled = false;
    }
  });
  await loadDossiers();
}

function dossierKindLabel(k) {
  return { bien: '🏠 Bien', societe: '🏢 Société', vehicule: '🚗 Véhicule',
    personne: '👤 Personne', affaire: '⚖️ Affaire', reference: '🔢 Référence' }[k] ?? '📁 Autre';
}

async function loadDossiers() {
  const body = $('#dos-body');
  if (!body) return;
  body.innerHTML = '<div class="empty"><span class="spinner"></span>Chargement des dossiers…</div>';
  let d;
  try {
    d = await api.dossiers(60);
  } catch (err) {
    body.innerHTML = `<div class="notice warn">⚠️ ${esc(err.message)}</div>`;
    return;
  }
  if (!body.isConnected) return;
  _dossiers = d.dossiers ?? [];

  if (_dossiers.length === 0) {
    body.innerHTML = `<div class="empty">Aucun dossier pour l'instant. 📁 Ils apparaissent au fil de
      l'analyse de tes mails : dès qu'un bien, une société ou une affaire revient, il devient un dossier.</div>`;
    return;
  }

  body.innerHTML = `
    ${_fusionSource ? `<div class="notice">🔗 Fusion en cours : <strong>${esc(_fusionSource.label)}</strong>
      va rejoindre le dossier que tu choisis ci-dessous.
      <button class="btn btn-sm" id="dos-fusion-annuler">Annuler</button></div>` : ''}
    <div class="panel">
      <div class="panel-head"><h2>📁 Dossiers</h2><span class="badge">${fmtNum(d.total)}</span></div>
      <div class="panel-body">
        ${_dossiers.map((x, i) => `
          <div class="today-row" style="display:flex; align-items:flex-start; gap:10px; padding:10px 0; border-bottom:1px solid var(--border)">
            <div style="flex:1; min-width:0">
              <div><strong>${esc(x.label)}</strong>
                ${x.labelSource === 'manual' ? '<span class="muted" style="font-size:11px">✍️ nommé par toi</span>' : ''}
                <span class="muted" style="font-size:12px">· ${dossierKindLabel(x.kind)}</span></div>
              <div class="muted" style="font-size:12px">
                ${fmtNum(x.messageCount)} mail(s) · ${fmtNum(x.correspondents)} interlocuteur(s)
                ${x.accounts.length ? ` · ${x.accounts.map((a) => accountChip(a)).join(' ')}` : ''}
                ${x.withAttachments ? ` · ${fmtNum(x.withAttachments)} avec pièce jointe` : ''}
              </div>
              ${x.identifiers.length ? `<div class="muted" style="font-size:11.5px">🔢 ${x.identifiers.map(esc).join(' · ')}</div>` : ''}
              ${x.aliases.length ? `<div class="muted" style="font-size:11.5px">aussi écrit : ${x.aliases.slice(0, 4).map(esc).join(' · ')}</div>` : ''}
            </div>
            <div style="display:flex; gap:4px; flex-wrap:wrap; justify-content:flex-end">
              <a class="btn btn-sm" href="#/search?q=${encodeURIComponent(x.label)}">🔍 Voir</a>
              <button class="btn btn-sm dos-ren" data-i="${i}">✏️ Renommer</button>
              ${_fusionSource
                ? (_fusionSource.id === x.id
                    ? '<span class="muted" style="font-size:12px; align-self:center">à fusionner…</span>'
                    : `<button class="btn btn-sm btn-primary dos-cible" data-i="${i}">⤵️ Fusionner ici</button>`)
                : `<button class="btn btn-sm dos-fus" data-i="${i}">🔗 Fusionner</button>`}
              <button class="btn btn-sm dos-hide" data-i="${i}">🙈 Masquer</button>
            </div>
          </div>`).join('')}
      </div>
      <div class="panel-body muted" style="font-size:12.5px; border-top:1px solid var(--border)">
        Fusionner sert quand le même sujet a été écrit de deux façons. Le dossier absorbé garde un
        renvoi vers l'autre : un mail qui arrive demain avec l'ancienne orthographe atterrit au bon
        endroit, sans que tu aies à refaire la fusion.
      </div>
    </div>`;

  $('#dos-fusion-annuler')?.addEventListener('click', () => { _fusionSource = null; loadDossiers(); });

  body.querySelectorAll('.dos-ren').forEach((b) => b.addEventListener('click', async () => {
    const x = _dossiers[Number(b.dataset.i)];
    const nom = prompt('Nouveau nom du dossier :', x.label);
    if (nom === null || nom.trim() === x.label) return;
    try {
      await api.dossierRenommer(x.id, nom.trim());
      await loadDossiers();
    } catch (err) { alert(err.message); }
  }));

  body.querySelectorAll('.dos-fus').forEach((b) => b.addEventListener('click', () => {
    _fusionSource = _dossiers[Number(b.dataset.i)];
    loadDossiers();
  }));

  body.querySelectorAll('.dos-cible').forEach((b) => b.addEventListener('click', async () => {
    const cible = _dossiers[Number(b.dataset.i)];
    if (!_fusionSource) return;
    if (!confirm(`Fusionner « ${_fusionSource.label} » dans « ${cible.label} » ?\n\n`
      + `Les ${_fusionSource.messageCount} mail(s) rejoignent « ${cible.label} ». Aucun mail n'est supprimé ni déplacé dans ta boîte.`)) return;
    try {
      const r = await api.dossierFusionner(_fusionSource.id, cible.id);
      _fusionSource = null;
      await loadDossiers();
      alert(`✅ Fusionné — ${fmtNum(r.mailsDeplaces)} mail(s) rattachés à « ${cible.label} ».`);
    } catch (err) { alert(err.message); }
  }));

  body.querySelectorAll('.dos-hide').forEach((b) => b.addEventListener('click', async () => {
    const x = _dossiers[Number(b.dataset.i)];
    if (!confirm(`Masquer « ${x.label} » ?\n\nIl disparaît de cette liste. Aucun mail n'est touché.`)) return;
    try {
      await api.dossierMasquer(x.id, true);
      await loadDossiers();
    } catch (err) { alert(err.message); }
  }));
}

async function renderSuggestions() {
  const main = $('#main');
  main.innerHTML = `<div class="page-head">
    <div><h1>💡 Règles proposées</h1>
      <div class="sub">Ce que l'assistant a appris en t'observant : chaque suggestion vient avec sa preuve.
      Valider = la règle existe. Ignorer = on ne t'en reparle plus. Rien ne s'applique sans toi.</div></div>
    <div class="head-actions"><button class="btn" id="sugg-refresh">↻ Actualiser</button></div></div>
    <div id="sugg-body"><div class="empty"><span class="spinner"></span>Analyse de tes habitudes…</div></div>`;
  $('#sugg-refresh').addEventListener('click', loadSuggestions);
  await loadSuggestions();
}

async function loadSuggestions() {
  const body = $('#sugg-body');
  if (!body) return;
  body.innerHTML = '<div class="empty"><span class="spinner"></span>Analyse de tes habitudes…</div>';
  let s;
  try {
    s = await api.suggestions();
  } catch (err) {
    body.innerHTML = `<div class="notice warn">⚠️ ${esc(err.message)}</div>`;
    return;
  }
  if (!body.isConnected) return;
  refreshSuggestionsBadge();

  if (s.total === 0) {
    body.innerHTML = `<div class="empty">Rien à suggérer pour l'instant. 💡 L'assistant apprend au fil de
      tes rangements, nettoyages et lectures — reviens dans quelques jours.</div>`;
    return;
  }

  const row = (content, actions) => `<div class="today-row" style="display:flex; align-items:center; gap:10px; padding:8px 0; border-bottom:1px solid var(--border)">
    <div style="flex:1; min-width:0">${content}</div>${actions}</div>`;

  body.innerHTML = `
    ${s.rules.length ? `<div class="panel">
      <div class="panel-head"><h2>🗂️ Règles proposées</h2><span class="badge orange">${fmtNum(s.rules.length)}</span></div>
      <div class="panel-body">
        ${s.rules.map((r, i) => row(
          `Si <strong>${r.rule.matchType === 'domain' ? 'domaine' : r.rule.matchType === 'subject' ? 'sujet' : 'expéditeur'} = ${esc(r.rule.matchValue)}</strong>
           → déplacer vers 📂 <strong>${esc(r.rule.targetFolder)}</strong> ${accountChip(r.account)}
           <br><span class="muted" style="font-size:12px">Preuve : ${esc(r.rule.reason)}${r.rule.pendingCount ? ` · ${fmtNum(r.rule.pendingCount)} mails à ranger dès maintenant` : ''}</span>`,
          `<button class="btn btn-sm btn-primary sugg-rule-ok" data-i="${i}">✓ Valider</button>
           <button class="btn btn-sm sugg-rule-no" data-i="${i}">✕ Refuser</button>`,
        )).join('')}
        <div class="muted" style="font-size:12.5px; padding-top:8px">Valider active la règle (rangement via
        le bouton « Ranger » de l'écran <a href="#/rules">🗂️ Règles</a>, ou coche « auto » là-bas quand tu lui fais confiance).</div>
      </div></div>` : ''}

    ${s.retentionAuto.length ? `<div class="panel">
      <div class="panel-head"><h2>🧹 Nettoyages à automatiser</h2><span class="badge orange">${fmtNum(s.retentionAuto.length)}</span></div>
      <div class="panel-body">
        ${s.retentionAuto.map((r, i) => row(
          `<strong>${esc(r.label)}</strong><br><span class="muted" style="font-size:12px">Preuve : ${esc(r.evidence)}</span>`,
          `<button class="btn btn-sm btn-primary sugg-ret-ok" data-i="${i}">✓ Passer en auto</button>
           <button class="btn btn-sm sugg-ret-no" data-i="${i}">✕ Ignorer</button>`,
        )).join('')}
      </div></div>` : ''}

    ${s.priorities.length ? `<div class="panel">
      <div class="panel-head"><h2>⭐ Priorités par relation</h2><span class="badge orange">${fmtNum(s.priorities.length)}</span></div>
      <div class="panel-body">
        ${s.priorities.map((p, i) => row(
          `${p.priority === 'always_important' ? '⭐' : '🔕'} <strong>${esc(p.name)}</strong>
           <span class="muted" style="font-size:12px">${esc(p.email)}</span> ${accountChip(p.account)}
           <br><span class="muted" style="font-size:12px">Preuve : ${esc(p.evidence)}</span>`,
          `<button class="btn btn-sm btn-primary sugg-prio-ok" data-i="${i}">✓ ${p.priority === 'always_important' ? 'Toujours important' : 'Jamais urgent'}</button>
           <button class="btn btn-sm sugg-prio-no" data-i="${i}">✕ Ignorer</button>`,
        )).join('')}
      </div></div>` : ''}`;

  const act = async (btn, fn) => {
    btn.disabled = true;
    try {
      await fn();
      await loadSuggestions();
    } catch (err) {
      alert(err.message);
      btn.disabled = false;
    }
  };
  body.querySelectorAll('.sugg-rule-ok').forEach((btn) => btn.addEventListener('click', () => {
    const r = s.rules[Number(btn.dataset.i)];
    act(btn, () => api.ruleUpdate(r.account, r.rule.id, { status: 'active' }));
  }));
  body.querySelectorAll('.sugg-rule-no').forEach((btn) => btn.addEventListener('click', () => {
    const r = s.rules[Number(btn.dataset.i)];
    if (!confirm('Refuser cette règle ? Elle sera supprimée (elle pourra être re-suggérée plus tard si l\'habitude continue).')) return;
    act(btn, () => api.ruleDelete(r.account, r.rule.id));
  }));
  body.querySelectorAll('.sugg-ret-ok').forEach((btn) => btn.addEventListener('click', () => {
    const r = s.retentionAuto[Number(btn.dataset.i)];
    if (!confirm(`Passer « ${r.label} » en AUTOMATIQUE après chaque synchronisation ?\n\nCorbeille uniquement, journalisé, désactivable dans 🧹 Nettoyage rapide.`)) return;
    act(btn, () => api.retentionUpdate(r.policyId, { autoApply: true }));
  }));
  body.querySelectorAll('.sugg-ret-no').forEach((btn) => btn.addEventListener('click', () => {
    const r = s.retentionAuto[Number(btn.dataset.i)];
    act(btn, () => api.suggestionDismiss('retention_auto', `retention:${r.key}`));
  }));
  body.querySelectorAll('.sugg-prio-ok').forEach((btn) => btn.addEventListener('click', () => {
    const p = s.priorities[Number(btn.dataset.i)];
    act(btn, () => api.senderSetPriority(p.account, p.email, p.priority));
  }));
  body.querySelectorAll('.sugg-prio-no').forEach((btn) => btn.addEventListener('click', () => {
    const p = s.priorities[Number(btn.dataset.i)];
    act(btn, () => api.suggestionDismiss('priority', `priority:${p.account}|${p.email}|${p.priority}`));
  }));
}

// ---------------------- Corriger l'assistant (B2 — Série B) : #/verify
// Contrôle qualité : échantillon réel de chaque moteur, jugé par l'utilisateur.
// Correct / Incorrect / Ne sais pas — les corrections passent par les
// mécanismes EXISTANTS (catégorie manuelle, priorité, dismiss), le verdict
// est mémorisé et restitué en % de précision par moteur.
let verifySample = null;

// Raisons proposées quand c'est « Incorrect » — certaines déclenchent une
// CORRECTION réelle (toujours confirmée avant).
const VERIFY_REASONS = {
  reply: [
    { label: 'Pas de réponse attendue', action: 'dismissReply', confirm: 'Retirer ce fil de « À répondre » ?' },
    { label: "C'est un robot / une notification", action: 'catNotification', confirm: 'Classer cet expéditeur en « Notification / robot » (choix mémorisé) ?' },
    { label: 'Autre raison' },
  ],
  important: [
    { label: 'Pas important du tout' },
    { label: 'Expéditeur jamais urgent', action: 'prioNever', confirm: 'Marquer cet expéditeur 🔕 jamais urgent (score plafonné) ?' },
    { label: "C'est une newsletter / une pub", action: 'catNewsletter', confirm: 'Classer cet expéditeur en « Newsletter » (choix mémorisé) ?' },
    { label: 'Autre raison' },
  ],
  newsletter: [
    { label: "C'est une personne", action: 'catPerson', confirm: 'Classer cet expéditeur en « Personne » ? Il sera protégé de tous les nettoyages.' },
    { label: "C'est une notification", action: 'catNotification', confirm: 'Classer cet expéditeur en « Notification / robot » ?' },
    { label: 'Autre catégorie' },
  ],
  notification: [
    { label: "C'est une personne", action: 'catPerson', confirm: 'Classer cet expéditeur en « Personne » ? Il sera protégé de tous les nettoyages.' },
    { label: "C'est une newsletter", action: 'catNewsletter', confirm: 'Classer cet expéditeur en « Newsletter » ?' },
    { label: 'Autre catégorie' },
  ],
  cleanup: [
    { label: 'Ne JAMAIS supprimer cet expéditeur', action: 'prioAlways', confirm: 'Marquer cet expéditeur ⭐ toujours important ? Ses mails ne seront plus jamais visés par un nettoyage.' },
    { label: "C'est une personne", action: 'catPerson', confirm: 'Classer cet expéditeur en « Personne » ? Il sera protégé de tous les nettoyages.' },
    { label: 'Autre raison' },
  ],
};

function applyVerifyCorrection(item, action) {
  if (action === 'dismissReply') return api.replyDismiss(item.account, item.threadId);
  if (action === 'catPerson') return api.senderSetCategory(item.account, item.fromEmail, 'person');
  if (action === 'catNotification') return api.senderSetCategory(item.account, item.fromEmail, 'notification');
  if (action === 'catNewsletter') return api.senderSetCategory(item.account, item.fromEmail, 'newsletter');
  if (action === 'prioNever') return api.senderSetPriority(item.account, item.fromEmail, 'never_urgent');
  if (action === 'prioAlways') return api.senderSetPriority(item.account, item.fromEmail, 'always_important');
  return Promise.resolve();
}

const VERIFY_VERDICT_BADGES = {
  correct: '<span class="badge green">✓ Correct</span>',
  incorrect: '<span class="badge red">✗ Incorrect</span>',
  unsure: '<span class="badge">? Ne sais pas</span>',
};

// Mode de vérification (Phase 3) : « une à la fois » par défaut — l'écran
// liste ressemblait à une tâche d'annotation de données. Mémorisé localement.
function verifyMode() {
  try { return localStorage.getItem('verify-mode') === 'list' ? 'list' : 'guided'; } catch { return 'guided'; }
}
function setVerifyMode(mode) {
  try { localStorage.setItem('verify-mode', mode); } catch { /* privé */ }
  updateVerifyModeButton();
  renderVerifyBody();
}
function updateVerifyModeButton() {
  const btn = $('#verify-mode-toggle');
  if (btn) btn.textContent = verifyMode() === 'guided' ? 'Voir toute la liste' : 'Mode guidé (une à la fois)';
}

async function renderVerify() {
  const main = $('#main');
  main.innerHTML = `<div class="page-head">
    <div><h1>🔬 Corriger l'assistant</h1>
      <div class="sub">Contrôle qualité : quelques mails tirés AU HASARD dans chaque moteur d'analyse.
      Dis si l'assistant a bon — tes corrections améliorent les catégories, les priorités et les listes.
      Rien n'est supprimé ici.</div></div>
    <div class="head-actions">
      <button class="btn" id="verify-mode-toggle"></button>
      <button class="btn" id="verify-refresh">🎲 Nouvel échantillon</button>
    </div></div>
    <div id="verify-stats"></div>
    <div id="verify-body"><div class="empty"><span class="spinner"></span>Tirage d'un échantillon…</div></div>`;
  $('#verify-refresh').addEventListener('click', loadVerify);
  updateVerifyModeButton();
  $('#verify-mode-toggle').addEventListener('click', () =>
    setVerifyMode(verifyMode() === 'guided' ? 'list' : 'guided'));
  await loadVerify();
}

function renderVerifyStats(stats) {
  const el = $('#verify-stats');
  if (!el) return;
  const rated = stats.filter((s) => s.total > 0);
  if (!rated.length) {
    el.innerHTML = '';
    return;
  }
  const chip = (s) => {
    const pct = s.precisionPct;
    const color = pct === null ? 'var(--muted)' : pct >= 90 ? 'var(--green, #16a34a)' : pct >= 70 ? 'var(--orange)' : 'var(--red)';
    return `<div class="kpi" style="min-width:150px">
      <div class="kpi-label">${esc(s.label)}</div>
      <div class="kpi-value" style="color:${color}">${pct === null ? '—' : pct + ' %'}</div>
      <div class="kpi-sub">${fmtNum(s.correct)} ✓ · ${fmtNum(s.incorrect)} ✗ · ${fmtNum(s.unsure)} ? (${fmtNum(s.total)} avis)</div>
    </div>`;
  };
  el.innerHTML = `<div class="panel"><div class="panel-head"><h2>🎯 Précision mesurée</h2>
    <span class="muted" style="font-size:12px">% = corrects / (corrects + incorrects), sur tous tes avis</span></div>
    <div class="panel-body" style="display:flex; gap:10px; flex-wrap:wrap">${rated.map(chip).join('')}</div></div>`;
}

const VERIFY_HINTS = {
  reply: 'Mails où l\'assistant pense que quelqu\'un attend TA réponse.',
  important: 'Mails jugés importants (score ≥ 40) — lus ou non.',
  newsletter: 'Expéditeurs classés « newsletter » par la machine.',
  notification: 'Expéditeurs classés « notification / robot » par la machine.',
  cleanup: 'Mails que les stratégies de nettoyage viseraient aujourd\'hui.',
};
const VERIFY_ICONS = { reply: '↩️', important: '⭐', newsletter: '📰', notification: '🤖', cleanup: '🧹' };

async function loadVerify() {
  const body = $('#verify-body');
  if (!body) return;
  body.innerHTML = '<div class="empty"><span class="spinner"></span>Tirage d\'un échantillon…</div>';
  try {
    verifySample = await api.reviewSample(10);
  } catch (err) {
    body.innerHTML = `<div class="notice warn">⚠️ ${esc(err.message)}</div>`;
    return;
  }
  if (!body.isConnected) return;
  renderVerifyStats(verifySample.stats);
  renderVerifyBody();
}

function renderVerifyBody() {
  if (!verifySample || !$('#verify-body')) return;
  if (verifyMode() === 'guided') renderVerifyGuided();
  else renderVerifyList();
}

/** Enregistre un verdict (partagé entre la liste et le mode guidé). */
async function verifyRecord(item, verdict, reason) {
  const r = await api.reviewFeedback({
    engine: item.engine,
    account: item.account,
    messageId: item.messageId,
    verdict,
    reason: reason ?? null,
    claim: item.claim,
  });
  item.verdict = verdict;
  item.verdictReason = reason ?? null;
  if (r?.stats) renderVerifyStats(r.stats);
}

// Mode guidé (Phase 3) : UNE décision à la fois — correct ou pas.
function renderVerifyGuided() {
  const body = $('#verify-body');
  const queue = [];
  for (const e of verifySample.engines) {
    for (const it of e.items) if (!it.verdict) queue.push({ it, label: e.label });
  }
  let idx = 0;
  const counts = { correct: 0, incorrect: 0, unsure: 0, skipped: 0 };

  const finish = () => {
    const total = counts.correct + counts.incorrect + counts.unsure;
    body.innerHTML = `<div class="panel"><div class="panel-body empty" style="font-size:15px">
      ${total ? `🎯 C'est vérifié : <strong>${fmtNum(counts.correct)}</strong> juste(s),
        <strong>${fmtNum(counts.incorrect)}</strong> à corriger, ${fmtNum(counts.unsure)} incertaine(s)${counts.skipped ? `, ${fmtNum(counts.skipped)} passée(s)` : ''}.
        Chaque avis affine la précision mesurée ci-dessus.`
        : 'Rien à vérifier dans cet échantillon — tout a déjà reçu ton avis.'}
      <br><button class="btn btn-primary btn-sm" id="vg-again" style="margin-top:10px">🎲 Nouvel échantillon</button></div></div>`;
    $('#vg-again')?.addEventListener('click', loadVerify);
  };

  const step = () => {
    if (idx >= queue.length) { finish(); return; }
    const { it, label } = queue[idx];
    body.innerHTML = `<div class="panel">
      <div class="panel-head"><h2>Vérification ${idx + 1} sur ${queue.length}</h2>
        <span class="muted" style="font-size:12px">${VERIFY_ICONS[it.engine] ?? ''} ${esc(label)} — ${esc(VERIFY_HINTS[it.engine] ?? '')}</span></div>
      <div class="panel-body">
        <div style="font-size:15px; margin-bottom:10px"><strong>L'assistant pense que :</strong> ${esc(it.claim)}</div>
        <div><strong>${esc(it.subject)}</strong> ${it.isSeen ? '' : '<span class="badge blue">non lu</span>'}</div>
        <div class="muted" style="font-size:12.5px">${esc(it.fromName || it.fromEmail)} · ${fmtDate(it.date)} ${accountChip(it.account)}</div>
        <div style="margin:10px 0"><span class="openable" id="vg-read" style="font-size:13px">📖 Lire le mail avant de décider</span></div>
        <div id="vg-actions" style="display:flex; gap:8px; flex-wrap:wrap; align-items:center"></div>
      </div></div>`;
    $('#vg-read')?.addEventListener('click', () => openReaderFor(it, {}));

    const zone = $('#vg-actions');
    const guard = (fn) => async () => {
      zone.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      try { await fn(); } catch (err) { alert(err.message); actions(); }
    };
    const actions = () => {
      zone.innerHTML = `<button class="btn btn-sm btn-primary" id="vg-ok">✓ Oui, c'est juste</button>
        <button class="btn btn-sm" id="vg-ko">✗ Non, corriger</button>
        <button class="btn btn-sm" id="vg-idk" title="Impossible à dire sans plus de contexte">? Je ne sais pas</button>
        <button class="btn btn-sm" id="vg-skip" style="margin-left:auto" title="Décision remise à plus tard">⏭️ Passer</button>`;
      $('#vg-ok').addEventListener('click', guard(async () => { await verifyRecord(it, 'correct'); counts.correct++; idx++; step(); }));
      $('#vg-idk').addEventListener('click', guard(async () => { await verifyRecord(it, 'unsure'); counts.unsure++; idx++; step(); }));
      $('#vg-skip').addEventListener('click', () => { counts.skipped++; idx++; step(); });
      $('#vg-ko').addEventListener('click', () => {
        const reasons = VERIFY_REASONS[it.engine] ?? [{ label: 'Autre raison' }];
        zone.innerHTML = `<span class="muted" style="font-size:12px">Qu'est-ce qui cloche ?</span>
          ${reasons.map((r, ri) => `<button class="btn btn-sm vg-reason" data-ri="${ri}">${esc(r.label)}</button>`).join('')}
          <button class="btn btn-sm" id="vg-cancel" title="Annuler">↩</button>`;
        $('#vg-cancel').addEventListener('click', actions);
        zone.querySelectorAll('.vg-reason').forEach((btn) => btn.addEventListener('click', guard(async () => {
          const r = reasons[Number(btn.dataset.ri)];
          const doAction = r.action && (!r.confirm || confirm(r.confirm)) &&
            !(r.action === 'dismissReply' && !it.threadId);
          await verifyRecord(it, 'incorrect', r.label);
          if (doAction) {
            try {
              await applyVerifyCorrection(it, r.action);
            } catch (err) {
              alert(`Verdict enregistré, mais la correction a échoué : ${err.message}`);
            }
          }
          counts.incorrect++;
          idx++;
          step();
        })));
      });
    };
    actions();
  };
  step();
}

function renderVerifyList() {
  const body = $('#verify-body');
  body.innerHTML = verifySample.engines.map((e, ei) => `<div class="panel">
    <div class="panel-head"><h2>${VERIFY_ICONS[e.engine] ?? ''} ${esc(e.label)}</h2>
      <span class="muted" style="font-size:12px">${esc(VERIFY_HINTS[e.engine] ?? '')}</span></div>
    <div class="panel-body">
      ${e.items.length === 0 ? '<div class="empty">Rien à vérifier — ce moteur ne détecte rien en ce moment.</div>' : ''}
      ${e.items.map((it, i) => `<div class="today-row" style="display:flex; align-items:flex-start; gap:10px; padding:9px 0; border-bottom:1px solid var(--border)">
        <div style="flex:1; min-width:0">
          <div><strong>${esc(it.subject)}</strong> ${it.isSeen ? '' : '<span class="badge blue">non lu</span>'}</div>
          <div class="muted" style="font-size:12px">${esc(it.fromName || it.fromEmail)} · ${fmtDate(it.date)} ${accountChip(it.account)}</div>
          <div class="muted" style="font-size:12px; font-style:italic">🤖 ${esc(it.claim)}</div>
        </div>
        <button class="btn btn-sm verify-read" data-e="${ei}" data-i="${i}">📖</button>
        <div class="verify-zone" id="v-zone-${ei}-${i}" style="display:flex; gap:6px; align-items:center; flex-wrap:wrap; justify-content:flex-end; max-width:340px"></div>
      </div>`).join('')}
    </div></div>`).join('');

  verifySample.engines.forEach((e, ei) => e.items.forEach((it, i) => renderVerifyZone(ei, i)));
  body.querySelectorAll('.verify-read').forEach((btn) => btn.addEventListener('click', () => {
    const it = verifySample.engines[Number(btn.dataset.e)]?.items[Number(btn.dataset.i)];
    if (it) openReaderFor(it, {});
  }));
}

// Zone de verdict d'une ligne : boutons → verdict enregistré → badge + Modifier.
function renderVerifyZone(ei, i) {
  const zone = $(`#v-zone-${ei}-${i}`);
  const item = verifySample?.engines[ei]?.items[i];
  if (!zone || !item) return;

  if (item.verdict) {
    zone.innerHTML = `${VERIFY_VERDICT_BADGES[item.verdict] ?? esc(item.verdict)}
      ${item.verdictReason ? `<span class="muted" style="font-size:11.5px">${esc(item.verdictReason)}</span>` : ''}
      <button class="btn btn-sm v-change">Modifier</button>`;
    zone.querySelector('.v-change').addEventListener('click', () => {
      item.verdict = null;
      item.verdictReason = null;
      renderVerifyZone(ei, i);
    });
    return;
  }

  zone.innerHTML = `<button class="btn btn-sm v-ok" title="L'analyse est juste">✓ Correct</button>
    <button class="btn btn-sm v-ko" title="L'analyse est fausse">✗ Incorrect</button>
    <button class="btn btn-sm v-idk" title="Impossible à dire">?</button>`;

  const record = async (verdict, reason) => {
    await verifyRecord(item, verdict, reason);
    renderVerifyZone(ei, i);
  };
  const guard = (fn) => async () => {
    zone.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    try {
      await fn();
    } catch (err) {
      alert(err.message);
      renderVerifyZone(ei, i);
    }
  };
  zone.querySelector('.v-ok').addEventListener('click', guard(() => record('correct')));
  zone.querySelector('.v-idk').addEventListener('click', guard(() => record('unsure')));
  zone.querySelector('.v-ko').addEventListener('click', () => {
    const reasons = VERIFY_REASONS[item.engine] ?? [{ label: 'Autre raison' }];
    zone.innerHTML = `<span class="muted" style="font-size:12px">Pourquoi ?</span>
      ${reasons.map((r, ri) => `<button class="btn btn-sm v-reason" data-ri="${ri}">${esc(r.label)}</button>`).join('')}
      <button class="btn btn-sm v-cancel" title="Annuler">↩</button>`;
    zone.querySelector('.v-cancel').addEventListener('click', () => renderVerifyZone(ei, i));
    zone.querySelectorAll('.v-reason').forEach((btn) => btn.addEventListener('click', guard(async () => {
      const r = reasons[Number(btn.dataset.ri)];
      // La correction réelle (catégorie / priorité / retirer de la liste)
      // n'est appliquée que si l'utilisateur confirme — le verdict, lui,
      // est enregistré dans tous les cas.
      const doAction = r.action && (!r.confirm || confirm(r.confirm)) &&
        !(r.action === 'dismissReply' && !item.threadId);
      await record('incorrect', r.label);
      if (doAction) {
        try {
          await applyVerifyCorrection(item, r.action);
        } catch (err) {
          alert(`Verdict enregistré, mais la correction a échoué : ${err.message}`);
        }
      }
    })));
  });
}

// -------------------------------- Libérer de l'espace (A4 — Cap V3) : #/bigclean
// « Pourquoi ma boîte est pleine ? » : rapport index-only instantané +
// lancement groupé des stratégies de rétention cochées (cocher = valider).
function pctBar(pct, color) {
  return `<div class="bar-track" style="flex:1"><div class="bar-fill" style="width:${Math.max(1, pct)}%; background:${color || 'var(--accent)'}"></div></div>`;
}

async function renderBigClean() {
  const main = $('#main');
  main.innerHTML = `<div class="page-head">
    <div><h1>🧺 Libérer de l'espace</h1>
      <div class="sub">Pourquoi ta boîte est pleine, et ce qu'on peut récupérer SANS RISQUE.
      L'analyse ne touche à rien : tu regardes, tu coches, tu valides.</div>
      <div class="notice" style="margin-top:8px">🛑 <strong>Le nettoyage automatique ne propose plus rien</strong>
      — c'est voulu. Tes stratégies actives visent zéro mail : tout ce qu'elles attrapent est protégé
      par ailleurs, et depuis le 12/08 un mail auquel tu as répondu l'est pour toujours
      (5 225 mails, soit 29 % de ta boîte de réception). Le cap est « retrouver sans classer »,
      pas faire de la place. Les chiffres ci-dessous restent justes et consultables.</div></div>
    <div class="head-actions"><button class="btn" id="bigclean-refresh">🔍 Ré-analyser</button></div></div>
    <div id="bigclean-body"><div class="empty"><span class="spinner"></span>Analyse complète de tes boîtes…</div></div>`;
  $('#bigclean-refresh').addEventListener('click', loadBigClean);
  await loadBigClean();
}

async function loadBigClean() {
  const body = $('#bigclean-body');
  if (!body) return;
  body.innerHTML = '<div class="empty"><span class="spinner"></span>Analyse complète de tes boîtes…</div>';
  let r;
  try {
    r = await api.report();
  } catch (err) {
    body.innerHTML = `<div class="notice warn">⚠️ ${esc(err.message)}</div>`;
    return;
  }
  if (!body.isConnected) return;

  const uncategorized = r.byCategory.find((c) => c.category === 'unknown');
  const needCategories = (uncategorized?.pct ?? 0) >= 50;
  const maxCat = Math.max(1, ...r.byCategory.map((c) => c.count));
  const maxAge = Math.max(1, ...r.byAge.map((a) => a.count));
  const usable = r.deletable.policies.filter((p) => p.matchCount > 0);

  body.innerHTML = `
    ${needCategories ? `<div class="notice warn">🏷️ La plupart des mails ne sont pas encore catégorisés :
      lance « Réexaminer les expéditeurs » dans <a href="#/settings">⚙️ Paramètres</a> puis reviens — le rapport sera bien plus précis.</div>` : ''}

    <div class="cards">
      <div class="kpi"><div class="kpi-label">✉️ Mails analysés</div>
        <div class="kpi-value">${fmtNum(r.totals.messages)}</div>
        <div class="kpi-sub">${fmtNum(r.totals.accounts)} boîte(s), hors corbeille/spam</div></div>
      <div class="kpi"><div class="kpi-label">💾 Espace occupé</div>
        <div class="kpi-value">${fmtSize(r.totals.sizeBytes)}</div>
        <div class="kpi-sub">taille des mails synchronisés</div></div>
      <div class="kpi accent"><div class="kpi-label">🧺 Récupérable sans risque</div>
        <div class="kpi-value">${fmtNum(r.deletable.count)}</div>
        <div class="kpi-sub">mails · ${fmtSize(r.deletable.sizeBytes)} — aucun mail portant un signal de valeur humaine</div></div>
    </div>

    <div class="panel">
      <div class="panel-head"><h2>📊 Pourquoi ma boîte est pleine ?</h2></div>
      <div class="panel-body">
        ${r.byCategory.map((c) => `
          <div style="display:flex; align-items:center; gap:10px; padding:5px 0">
            <div style="width:210px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis">${esc(c.label)}</div>
            ${pctBar((c.count / maxCat) * 100, c.category === 'person' || c.category === 'outbound' ? 'var(--green, #3a9d5d)' : undefined)}
            <div style="width:190px; text-align:right" class="muted">${fmtNum(c.count)} mails · ${c.pct}% · ${fmtSize(c.sizeBytes)}</div>
          </div>`).join('')}
        <div class="muted" style="font-size:12.5px; padding-top:8px">Répartition par type d'expéditeur (catégories de l'assistant).
        Corrige un expéditeur mal classé depuis la vue de sa boîte (tableau des expéditeurs).</div>
      </div>
    </div>

    <div class="cards" style="grid-template-columns: 1fr 1fr; align-items:start">
      <div class="panel" style="margin:0">
        <div class="panel-head"><h2>⏳ Ancienneté</h2></div>
        <div class="panel-body">
          ${r.byAge.map((a) => `
            <div style="display:flex; align-items:center; gap:10px; padding:5px 0">
              <div style="width:110px">${esc(a.label)}</div>
              ${pctBar((a.count / maxAge) * 100)}
              <div style="width:150px; text-align:right" class="muted">${fmtNum(a.count)} · ${fmtSize(a.sizeBytes)}</div>
            </div>`).join('')}
        </div>
      </div>
      <div class="panel" style="margin:0">
        <div class="panel-head"><h2>🏋️ Top expéditeurs (poids)</h2></div>
        <div class="panel-body tight">
          <table><thead><tr><th>Expéditeur</th><th class="num">Mails</th><th class="num">Taille</th></tr></thead>
          <tbody>${r.topSendersBySize.slice(0, 8).map((s) => `<tr>
            <td>${esc(s.name || s.email)} ${accountChip(s.account)}<br>
              <span class="muted" style="font-size:11.5px">${esc(s.email)}</span></td>
            <td class="num">${fmtNum(s.messageCount)}</td>
            <td class="num">${fmtSize(s.sizeBytes)}</td>
          </tr>`).join('')}</tbody></table>
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head"><h2>Lancer le nettoyage</h2>
        <span class="badge green">≈ ${fmtNum(r.deletable.count)} mails · ${fmtSize(r.deletable.sizeBytes)} récupérables</span></div>
      <div class="panel-body">
        ${usable.length === 0
          ? `<div class="empty">Rien à récupérer pour l'instant via les stratégies. ${needCategories ? 'Lance d\'abord le calcul des catégories (bandeau ci-dessus).' : '🎉'}</div>`
          : `${usable.map((p) => `
            <div style="display:flex; align-items:center; gap:10px; padding:7px 0; border-bottom:1px solid var(--border)">
              <label style="display:flex; align-items:center; gap:8px; flex:1; cursor:pointer">
                <input type="checkbox" class="gm-check" data-id="${p.id}" data-count="${p.matchCount}" checked>
                <span><strong>${esc(p.label)}</strong></span></label>
              ${riskBadge(p.risk)}
              <span class="badge orange">${fmtNum(p.matchCount)} mails · ${fmtSize(p.matchSizeBytes)}</span>
              <button class="btn btn-sm gm-preview" data-id="${p.id}">👀 Aperçu</button>
            </div>`).join('')}
          <div style="display:flex; align-items:center; gap:10px; padding-top:12px">
            <span class="muted" style="font-size:12.5px; flex:1">Tout part à la CORBEILLE (récupérable ~30 jours),
            par lots de 200, opération par opération dans le <a href="#/operations">journal</a>.
            Les mails de personnes ne sont jamais touchés.</span>
            <button class="btn btn-primary" id="gm-launch">Lancer le nettoyage</button>
          </div>`}
      </div>
    </div>`;

  body.querySelectorAll('.gm-preview').forEach((btn) => {
    btn.addEventListener('click', () => openRetentionPreview(Number(btn.dataset.id)));
  });
  $('#gm-launch')?.addEventListener('click', async () => {
    const checked = [...body.querySelectorAll('.gm-check:checked')];
    if (checked.length === 0) {
      alert('Coche au moins une stratégie.');
      return;
    }
    const total = checked.reduce((s, c) => s + Number(c.dataset.count), 0);
    if (!confirm(`Libérer de l'espace : ≈ ${fmtNum(total)} mails partiront à la corbeille (${checked.length} stratégie(s)).\n\nIls restent récupérables ~30 jours. Les stratégies cochées seront ACTIVÉES (tu peux les désactiver ensuite dans 🧹 Nettoyage rapide). On y va ?`)) return;
    const btn = $('#gm-launch');
    btn.disabled = true;
    btn.textContent = 'Nettoyage lancé…';
    try {
      await api.grandMenage(checked.map((c) => Number(c.dataset.id)));
      pollJobs();
      alert('🧺 Nettoyage lancé en arrière-plan — suis l\'avancement via la pastille d\'activité, puis « 🔍 Ré-analyser » pour voir le résultat.');
    } catch (err) {
      btn.disabled = false;
      btn.textContent = '🧺 Lancer le nettoyage';
      alert(err.message);
    }
  });
}

async function openRetentionPreview(id) {
  closeModal();
  const overlay = document.createElement('div');
  // under-reader : le panneau de lecture s'ouvre AU-DESSUS de cette modale, pour
  // qu'on puisse vérifier un mail douteux sans fermer l'aperçu.
  overlay.className = 'modal-overlay under-reader';
  overlay.innerHTML = `<div class="modal modal-wide">
    <div class="modal-head"><h2>👀 Aperçu de la stratégie</h2>
      <button class="modal-close" title="Fermer">✕</button></div>
    <div class="modal-body" id="modal-body"><div class="empty"><span class="spinner"></span>Chargement…</div></div>
    <div class="modal-foot" id="modal-foot"><button class="btn" onclick="document.querySelector('.modal-overlay').remove()">Fermer</button></div>
  </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('.modal-close').addEventListener('click', closeModal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
  let data;
  try {
    data = await api.retentionPreview(id);
  } catch (err) {
    $('#modal-body').innerHTML = `<div class="notice warn">⚠️ ${esc(err.message)}</div>`;
    return;
  }
  // La date est la colonne qui décide : un mail de 2020 et un de ce mois-ci ne
  // se traitent pas pareil. Elle passe donc en 2e position, jamais en bout de
  // ligne où le débordement horizontal la coupait (retour utilisateur 29/07).
  $('#modal-body').innerHTML = `
    <p><strong>${esc(data.policy)}</strong> — ${fmtNum(data.total)} mail(s) visé(s) aujourd'hui.
    ${data.truncated ? `<br><span class="muted">Aperçu limité aux ${fmtNum(data.items.length)} plus anciens.</span>` : ''}
    <br><span class="muted">Clique un sujet pour lire le mail avant de décider.</span></p>
    <div style="max-height:52vh; overflow:auto; border:1px solid var(--border); border-radius:8px">
      <table class="table-compact"><thead><tr>
        <th style="width:96px">Boîte</th><th style="width:104px">Reçu le</th>
        <th>Sujet</th><th style="width:210px">Expéditeur</th>
      </tr></thead>
      <tbody>${data.items.map((m, i) => `<tr>
        <td>${accountChip(m.account)}</td>
        <td class="muted" style="font-size:12px; white-space:nowrap">${fmtDate(m.date)}</td>
        <td style="max-width:420px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">
          ${m.folder && m.uid
            ? `<span class="openable" data-prev-open="${i}">${esc(m.subject || '(sans sujet)')}</span>`
            : esc(m.subject || '(sans sujet)')}</td>
        <td class="muted" style="font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${esc(m.fromName || m.fromEmail)}</td>
      </tr>`).join('')}</tbody></table>
    </div>
    <p class="muted" style="font-size:12.5px">Rien n'est touché depuis cet aperçu — l'application se
    fait depuis l'écran, avec confirmation.</p>`;

  // Écouteur délégué : le corps de la modale est réécrit d'un bloc ci-dessus,
  // des écouteurs posés ligne par ligne seraient perdus.
  $('#modal-body').addEventListener('click', (e) => {
    const a = e.target.closest('[data-prev-open]');
    if (!a) return;
    e.preventDefault();
    openReaderFor(data.items[Number(a.dataset.prevOpen)]);
  });
}

async function loadCleanupGlobal() {
  const body = $('#cleanup-global-body');
  if (!body) return;
  body.innerHTML = '<div class="empty"><span class="spinner"></span>Analyse des boîtes…</div>';
  const accounts = (overviewCache?.enrolled ?? []).map((e) => e.account);
  const perAccount = [];
  let totalDeletable = 0;
  let totalCandidates = 0;
  for (const slug of accounts) {
    try {
      const d = await api.cleanup(slug);
      if (d.candidates.length) {
        perAccount.push({ slug, ...d });
        totalDeletable += d.totalDeletableEstimate ?? 0;
        totalCandidates += d.candidates.length;
      }
    } catch {
      /* boîte pas encore synchronisée : ignorée */
    }
  }
  if (!body.isConnected) return;
  if (perAccount.length === 0) {
    body.innerHTML = '<div class="empty">Rien à nettoyer pour l\'instant. 🎉 (Ou boîtes pas encore synchronisées.)</div>';
    return;
  }
  body.innerHTML = `
    <div class="notice">✨ <strong>${fmtNum(totalDeletable)}</strong> mails « sûrs » peuvent partir à la
      corbeille, répartis sur <strong>${fmtNum(totalCandidates)}</strong> expéditeurs et
      ${fmtNum(perAccount.length)} boîte(s).</div>
    ${perAccount.map(({ slug, candidates, totalDeletableEstimate }) => `
      <div class="panel">
        <div class="panel-head"><h2>${accountChip(slug)}</h2>
          <span class="badge green">${fmtNum(totalDeletableEstimate)} mails « sûrs »</span></div>
        <div class="panel-body tight">
          <table><thead><tr><th>Expéditeur</th><th class="num">Mails</th><th class="num">Non lus</th>
            <th class="num">Taille</th><th>Risque</th><th>Pourquoi</th><th></th></tr></thead>
          <tbody>${candidates.map((c) => `<tr>
            <td>${esc(c.senderName || c.sender)}<br><span class="muted" style="font-size:12px">${esc(c.sender)}</span></td>
            <td class="num">${fmtNum(c.messageCount)}${c.keepCount ? `<br><span class="badge green" style="font-weight:600" title="Pièce jointe, facture, ticket : jamais proposés">📄 ${fmtNum(c.keepCount)} gardés</span>` : ''}</td>
            <td class="num">${fmtNum(c.unseenCount)}</td>
            <td class="num">${fmtSize(c.totalSizeBytes)}</td>
            <td><span class="badge ${c.riskLevel === 'safe' ? 'green' : 'orange'}">${c.riskLevel === 'safe' ? 'Sûr' : 'Moyen'}</span></td>
            <td class="muted" style="font-size:12px; max-width:240px">${esc(c.reason)}</td>
            <td><button class="btn btn-sm cleanup-btn" data-account="${esc(slug)}"
              data-sender="${esc(c.sender)}" data-name="${esc(c.senderName || c.sender)}">🧹 Nettoyer</button></td>
          </tr>`).join('')}</tbody></table>
        </div>
      </div>`).join('')}
    <div class="panel-body muted" style="font-size:12.5px; padding:0 4px">
      🛟 Aperçu détaillé avant chaque nettoyage (liste cochable mail par mail, tri
      automatique/personnel), corbeille uniquement, lots de 200, tout est journalisé.</div>`;
  bindCleanupButtons(body);
}

// ------------------------------------------------- Pièces jointes (L5.14)
// Retrouver un document : recherche multi-boîtes limitée aux mails AVEC
// pièces jointes (index local — la détection 📎 est posée à la sync).
const attachState = { q: '', account: '', since: '', data: null, searched: false };

async function renderAttachments() {
  const main = $('#main');
  const accounts = (overviewCache?.enrolled ?? []).map((e) => e.account);
  main.innerHTML = `<div class="page-head">
    <div><h1>📎 Pièces jointes</h1>
      <div class="sub">Retrouve un document reçu ou envoyé : mails avec pièces jointes, toutes boîtes
      confondues. Ouvre le mail puis clique ⬇️ pour télécharger. NB : seuls les mails synchronisés depuis
      la version « pièces jointes » portent l'info — une synchro complète la pose sur l'historique.</div></div></div>
    <form class="search-bar" id="attach-form">
      <input type="search" id="a-q" placeholder="Expéditeur, sujet… (ex. facture, notaire, EDF)"
        value="${esc(attachState.q)}" autocomplete="off">
      <select id="a-account">
        <option value="">🌐 toutes les boîtes</option>
        ${accounts.map((a) => `<option value="${esc(a)}" ${a === attachState.account ? 'selected' : ''}>${esc(a)}</option>`).join('')}
      </select>
      <label class="muted" style="display:flex; align-items:center; gap:6px; font-size:12.5px">
        depuis <input type="date" id="a-since" value="${esc(attachState.since)}"></label>
      <button type="submit" class="btn btn-primary">Chercher</button>
    </form>
    <div class="dup-block" id="dup-block">
      <button class="dup-toggle" id="dup-toggle">📑 Voir les fichiers que tu as en plusieurs exemplaires</button>
      <div id="dup-body" class="hidden"></div>
    </div>
    <div id="attach-results"></div>`;

  $('#dup-toggle').addEventListener('click', () => {
    const b = $('#dup-body');
    const ouvert = !b.classList.contains('hidden');
    b.classList.toggle('hidden', ouvert);
    $('#dup-toggle').textContent = ouvert
      ? '📑 Voir les fichiers que tu as en plusieurs exemplaires'
      : '📑 Masquer les exemplaires multiples';
    if (!ouvert && !b.dataset.charge) chargerDoublons();
  });

  $('#attach-form').addEventListener('submit', (e) => {
    e.preventDefault();
    attachState.q = $('#a-q').value.trim();
    attachState.account = $('#a-account').value;
    attachState.since = $('#a-since').value;
    runAttachSearch();
  });
  $('#a-q').focus();

  // Premier affichage : les plus récents, sans critère.
  if (attachState.data) renderAttachResults();
  else runAttachSearch();
}

// Fichiers présents en plusieurs exemplaires (11/08) — demande d'Anthony.
// On ne supprime RIEN : le but est d'abord de VOIR « 1 document, 4 fois »
// au lieu de croiser quatre fois le même fichier sans s'en rendre compte.
async function chargerDoublons() {
  const el = $('#dup-body');
  if (!el) return;
  el.dataset.charge = '1';
  el.innerHTML = '<div class="empty"><span class="spinner"></span>Comparaison des pièces…</div>';
  let d;
  try {
    d = await api.duplicates({ account: attachState.account, limit: 30 });
  } catch (err) {
    el.innerHTML = `<div class="notice warn">⚠️ ${esc(err.message)}</div>`;
    return;
  }
  if (!d.groups.length) {
    el.innerHTML = `<div class="empty">Aucun fichier en double repéré pour l'instant.
      ${d.pending ? `<br><span class="muted">${fmtNum(d.pending)} mail(s) restent à examiner.</span>` : ''}</div>`;
    return;
  }
  const certain = d.totals.confirmedGroups
    ? `Dont <strong>${fmtNum(d.totals.confirmedGroups)}</strong> vérifiés au fichier près.`
    : `Je n'ai pas encore vérifié les fichiers un à un : ce sont des ressemblances fortes, pas des certitudes.`;
  el.innerHTML = `
    <div class="dup-lead">Tu as <strong>${fmtNum(d.totals.extraCopies)}</strong> exemplaires en trop,
      qui occupent <strong>${fmtSize(d.totals.wastedBytes)}</strong>. ${certain}
      ${d.pending ? `<br><span class="muted">J'ai examiné ${fmtNum(d.examined)} mails ; ${fmtNum(d.pending)} restent à voir, le total va donc monter.</span>` : ''}
      <br><span class="muted">Je ne supprime rien : c'est un constat, pas une proposition.</span></div>
    ${d.groups.map((g, i) => `
      <div class="dup-row">
        <div class="dup-head">
          <span class="dup-name" title="${esc(g.fileName)}">${attIcon(g.fileName)} ${esc(g.fileName)}</span>
          <span class="badge ${g.certitude === 'confirme' ? 'green' : 'gray'}"
            title="${g.certitude === 'confirme' ? 'Fichiers identiques, vérifiés' : 'Même nom et même taille — très probablement le même fichier'}">
            ${g.certitude === 'confirme' ? 'identiques' : 'probable'}</span>
        </div>
        <div class="dup-meta">${fmtNum(g.count)} exemplaires de ${fmtSize(g.sizeBytes)} ·
          <strong>${fmtSize(g.wastedBytes)}</strong> occupés en trop ·
          ${g.accounts.map((a) => accountChip(a)).join(' ')}
          <button class="dup-open" data-i="${i}">voir les ${fmtNum(g.count)} mails</button></div>
        <div class="dup-occ hidden" data-occ="${i}">
          ${g.occurrences.map((o, j) => `
            <div class="result-row" data-g="${i}" data-o="${j}">
              <span class="mail-date">${fmtDate(o.date)}</span>
              <span class="result-from">${esc(o.fromName)}</span>
              <span class="result-subject">${esc(o.subject)}</span>
              ${accountChip(o.account)}
            </div>`).join('')}
        </div>
      </div>`).join('')}`;

  el.querySelectorAll('.dup-open').forEach((b) => {
    b.addEventListener('click', () => {
      const occ = el.querySelector(`[data-occ="${b.dataset.i}"]`);
      occ.classList.toggle('hidden');
    });
  });
  el.querySelectorAll('.dup-occ .result-row').forEach((row) => {
    row.addEventListener('click', () => {
      const o = d.groups[Number(row.dataset.g)].occurrences[Number(row.dataset.o)];
      // Le lecteur attend la forme d'un résultat de recherche.
      openReader({
        account: o.account, folder: o.folder, folderRole: 'inbox', uid: o.uid,
        messageId: o.messageId, subject: o.subject, fromName: o.fromName,
        fromEmail: '', date: o.date, isSeen: true, isFlagged: false, isOutbound: false,
        hasAttachments: true, attachmentCount: 1, attachmentNames: [], summary: null,
        matchedIn: [], snippet: null, intent: null, sizeBytes: 0, hasListUnsubscribe: false,
        threadId: null,
      }, row);
    });
  });
}

async function runAttachSearch() {
  const el = $('#attach-results');
  if (!el) return;
  el.innerHTML = '<div class="empty"><span class="spinner"></span>Recherche…</div>';
  attachState.searched = true;
  try {
    attachState.data = await api.search({
      q: attachState.q,
      account: attachState.account,
      since: attachState.since,
      attachments: 1,
      limit: 200,
    });
  } catch (err) {
    el.innerHTML = `<div class="notice warn">⚠️ ${esc(err.message)}</div>`;
    return;
  }
  renderAttachResults();
}

function renderAttachResults() {
  const el = $('#attach-results');
  const d = attachState.data;
  if (!el || !d) return;
  if (d.items.length === 0) {
    el.innerHTML = `<div class="empty">Aucun mail avec pièce jointe trouvé.
      Si tu cherches un mail ancien, lance d'abord une <strong>Sync complète</strong> sur la boîte
      concernée (l'info 📎 est posée à l'indexation).</div>`;
    return;
  }
  el.innerHTML = `
    <div class="panel-body muted" style="font-size:12.5px; padding:0 4px 8px">
      <strong>${fmtNum(d.total)}</strong> mail(s) avec pièces jointes${d.truncated ? ` — les ${fmtNum(d.items.length)} plus récents affichés (affine ta recherche)` : ''}.
      Clique un mail pour voir et télécharger ses fichiers.
    </div>
    <div class="panel"><div class="panel-body tight">
      ${d.items.map((i, idx) => `
        <div class="result-row ${i.isSeen ? '' : 'unread'}" data-idx="${idx}">
          <span class="mail-date">${fmtDate(i.date)}</span>
          ${accountChip(i.account)}
          <span class="result-from" title="${esc(i.fromEmail)}">${esc(i.fromName || i.fromEmail)}</span>
          <span class="result-subject">${esc(i.subject)}</span>
          ${folderBadge(i)}
          <span class="badge gray" title="${i.attachmentCount} pièce(s) jointe(s)">📎${i.attachmentCount > 1 ? i.attachmentCount : ''}</span>
        </div>`).join('')}
    </div></div>`;

  el.querySelectorAll('.result-row').forEach((row) => {
    row.addEventListener('click', () => {
      const item = attachState.data.items[Number(row.dataset.idx)];
      if (item) openReader(item, row, { onSeen: () => renderAttachResults(), onRemoved: () => runAttachSearch() });
    });
  });
}

// ---------------------------------------------------------------- Aide (L5.10)
function renderHelp() {
  const main = $('#main');
  const section = (title, rows) => `<div class="panel">
    <div class="panel-head"><h2>${title}</h2></div>
    <div class="panel-body help-body">${rows}</div>
  </div>`;
  const qa = (q, a) => `<details class="help-qa"><summary>${q}</summary><div>${a}</div></details>`;

  main.innerHTML = `<div class="page-head">
    <div><h1>❓ Aide</h1>
      <div class="sub">Les réponses aux questions courantes. Tout se fait depuis l'interface —
      jamais besoin de ligne de commande.</div></div></div>

  ${section('🚀 Démarrage & mises à jour', `
    ${qa('Comment lancer Mail Assistant ?',
      `Double-clique sur <strong>MailAssistant.bat</strong> (sur ton Bureau ou dans le dossier
      Boxmail). Il met à jour, prépare la base, démarre le serveur et le relance tout seul en cas
      de pépin. Laisse sa fenêtre noire ouverte — c'est le moteur.`)}
    ${qa('Comment mettre à jour ?',
      `Quand une mise à jour existe, un <strong>bandeau bleu</strong> apparaît en haut du tableau
      de bord : clique dessus, le serveur télécharge la mise à jour et redémarre (quelques dizaines
      de secondes). Si l'interface indique « ⚠️ non supervisé » en bas de la barre latérale, le
      redémarrage automatique n'est pas possible : ferme tout et relance MailAssistant.bat.`)}
    ${qa('L\'interface ne répond plus ?',
      `Ferme la fenêtre noire de MailAssistant.bat puis relance-la. Tes données (index, comptes,
      journal) sont conservées sur ton PC.`)}`)}

  ${section('📧 Boîtes & connexion', `
    ${qa('Ajouter une boîte',
      `Barre latérale → <strong>＋ Ajouter un compte</strong>. Une fenêtre Microsoft s'ouvre et te
      demande QUEL compte connecter : choisis le bon (ou « Utiliser un autre compte »). Répète pour
      chaque boîte.`)}
    ${qa('Microsoft connecte le mauvais compte tout seul',
      `Le sélecteur de compte est normalement forcé. Si Microsoft passe outre, ouvre l'interface
      dans une <strong>fenêtre de navigation privée</strong> (Ctrl+Maj+N) et recommence l'ajout :
      aucune session mémorisée ne peut alors interférer.`)}
    ${qa('Erreur AADSTS50011 pendant l\'ajout',
      `L'adresse de retour n'est pas (encore) déclarée côté Microsoft Entra. Vérifie que
      <code>http://localhost:8787/api/enroll/callback</code> figure dans l'app « boxmail-mcp »
      (plateforme « Applications de bureau et mobiles ») et patiente 2 à 10 minutes : Microsoft
      met un peu de temps à propager.`)}
    ${qa('Renommer ou retirer une boîte',
      `Écran <a href="#/settings">⚙️ Paramètres</a>. Renommer garde l'accès (il faut juste relancer
      une synchronisation) ; retirer efface l'accès local et la copie des mails — <strong>tes mails chez
      Microsoft ne bougent jamais</strong>.`)}`)}

  ${section('🔄 Synchronisation', `
    ${qa('À quoi sert la synchronisation ?',
      `Elle copie les MÉTADONNÉES de tes mails (expéditeur, sujet, date… jamais le contenu) dans une copie locale ultra-rapide. Recherche, statistiques, importants, relances, échéances : tout lit cette copie. Synchronise régulièrement pour des résultats à jour.`)}
    ${qa('Rapide ou complète ?',
      `<strong>Rapide</strong> : boîte de réception + envoyés, nouveaux mails seulement — quelques
      secondes, à privilégier au quotidien. <strong>Complète</strong> : tous les dossiers + statuts
      lu/non-lu + détection des pièces jointes — plus long, utile après un renommage ou de temps
      en temps.`)}
    ${qa('Je change de page pendant une synchro, c\'est grave ?',
      `Non. Les synchros continuent sur le serveur : la pastille d'activité en bas à gauche suit
      l'avancement, et tu peux revenir sur la boîte à tout moment.`)}`)}

  ${section('🧹 Nettoyage & corbeille', `
    ${qa('Le nettoyage peut-il perdre des mails ?',
      `Non. Tout passe par la <strong>corbeille</strong> (« Éléments supprimés ») : récupérable
      pendant ~30 jours dans Outlook. Mail Assistant ne supprime JAMAIS définitivement, et rien ne
      part sans aperçu + confirmation. Chaque opération est notée dans le
      <a href="#/operations">journal</a> avec la liste exacte des mails.`)}
    ${qa('Mails « automatiques » et « personnels » ?',
      `Dans l'aperçu de nettoyage, chaque mail est classé : les newsletters/notifications sont
      cochées d'office, les mails auxquels tu as répondu (ou conversations engagées) sont
      décochés. Tu peux ajuster mail par mail avant de valider.`)}`)}

  ${section('🔎 Retrouver un mail', `
    ${qa('Comment je cherche ?',
      `Écran <a href="#/search">🔎 Recherche</a>, un mot suffit. Je cherche dans <strong>toutes tes
      boîtes à la fois</strong> : le sujet, l'expéditeur, le texte du mail, le résumé, le nom des
      pièces jointes et jusqu'au <strong>contenu</strong> des PDF (y compris les scans lus par
      l'OCR). Tu n'as jamais rien à ranger pour retrouver.`)}
    ${qa('Pourquoi les résultats sont groupés par personne ?',
      `Parce qu'une liste de 500 lignes ne se lit pas. Chaque carte est un
      <strong>interlocuteur</strong>, avec ses mails dessous — clique « voir les autres » pour
      déplier. Sous chaque ligne, je dis <strong>pourquoi</strong> le mail ressort (« trouvé dans
      le nom de la pièce jointe », « dans ce dont parle le mail »…).`)}
    ${qa('Changer l\'ordre des résultats',
      `Le menu <strong>« Trier par »</strong>, à droite des filtres : les plus récents (par
      défaut), les plus anciens, interlocuteur de A à Z ou de Z à A, ou les plus pertinents.
      Le tri porte sur <strong>tous</strong> les mails trouvés, pas seulement sur ceux affichés —
      « les plus anciens » te donne donc vraiment les plus anciens.`)}
    ${qa('↗ et ↘ devant les mails ?',
      `↘ tu l'as reçu, ↗ tu l'as écrit. Les deux sens d'un échange sont réunis dans la même carte :
      quand tu cherches quelqu'un, tu vois la conversation entière.`)}
    ${qa('Pourquoi deux cartes portent parfois le même nom ?',
      `Parce que ce sont vraiment deux expéditeurs différents. Exemple : « Airbnb » depuis
      <em>airbnb.com</em>, et « Airbnb » depuis le prestataire qui envoie leurs questionnaires —
      lequel écrit aussi pour d'autres marques. Je les réunis quand c'est sûr (Volotea depuis son
      site et depuis son support, c'est la même carte), et sinon j'affiche
      <strong>« via … »</strong> pour te dire d'où vient chacune.`)}`)}

  ${section('📖 Lecture, envoi, pièces jointes', `
    ${qa('Lire un mail en grand',
      `Bouton <strong>↗️ Agrandir</strong>, en haut à droite du mail. Il prend tout l'écran et les
      bandeaux se resserrent pour rendre la place au contenu. Rien ne disparaît : tes boutons,
      l'analyse et les pièces jointes restent au même endroit. Pour revenir : <strong>↙️ Réduire</strong>,
      ou <strong>Échap</strong> (le premier Échap réduit, le second ferme le mail).`)}
    ${qa('Élargir le panneau sans passer en grand',
      `<strong>Attrape le bord gauche du panneau et glisse</strong> : tu gardes ta liste à gauche et
      tu donnes plus de place au mail. La largeur choisie est retenue pour les fois suivantes.
      C'est utile quand tu veux comparer la liste et le mail ; « Agrandir », lui, sert quand tu veux
      te consacrer à un seul mail.`)}
    ${qa('Pourquoi les images ne s\'affichent pas ?',
      `Je les bloque par défaut : les charger prévient l'expéditeur que tu as ouvert son mail —
      c'est comme ça que les publicitaires savent qui lit. Clique <strong>« Afficher les images »</strong>
      pour ce mail-là, ou <strong>« Toujours les afficher »</strong> une bonne fois (réversible dans
      <a href="#/settings">⚙️ Paramètres</a> → Compréhension des mails).`)}
    ${qa('C\'est quoi « 🛡️ mouchards retirés » ?',
      `Certains mails contiennent une image d'un seul pixel, invisible, qui ne sert qu'à signaler
      ton ouverture. Je la retire <strong>toujours</strong>, même quand tu as choisi d'afficher les
      images : le mail s'affiche entier, sans le mouchard.
      <br>À savoir quand même : environ <strong>une image sur six</strong> porte un identifiant qui
      t'identifie dans son adresse. Afficher les images reste donc un signal, en partie — retirer
      le mouchard enlève le mouchard, pas tout le pistage.`)}
    ${qa('D\'où vient le contenu quand j\'ouvre un mail ?',
      `Il est téléchargé en direct depuis ta boîte au moment du clic (rien n'est stocké). Si la
      boîte est injoignable, un message l'explique — réessaie ou ouvre le mail dans Outlook.`)}
    ${qa('Télécharger une pièce jointe',
      `Ouvre le mail : les pièces jointes sont listées en bas du panneau, clique sur ⬇️ pour
      télécharger. Limite : mails de plus de 25 Mo à ouvrir depuis Outlook. Le badge 📎 dans la
      boîte de réception n'apparaît que sur les mails synchronisés récemment — une synchronisation
      complète le pose sur les nouveaux arrivages.`)}
    ${qa('Envoyer / répondre en sécurité',
      `L'envoi demande toujours une confirmation, est journalisé (destinataires + objet), et une
      copie est déposée dans « Éléments envoyés ». Le mail d'origine est marqué répondu.`)}`)}

  ${section('⌨️ Raccourcis & astuces', `
    <ul class="help-list">
      <li><strong>Échap</strong> ferme le panneau de lecture et les fenêtres (une confirmation
        protège les brouillons en cours). Sur un mail agrandi, le premier Échap
        <strong>réduit</strong> — il faut un second pour fermer, histoire de ne pas perdre le mail
        d'un seul geste.</li>
      <li>Dans la boîte de réception, clique les en-têtes <strong>Date / Expéditeur / Sujet</strong>
        pour trier ; re-clique pour inverser l'ordre.</li>
      <li>« 🌐 Toutes les boîtes » mélange toutes tes INBOX par date — chaque boîte a sa couleur
        (personnalisable dans <a href="#/settings">⚙️ Paramètres</a>).</li>
      <li>Coche plusieurs mails pour agir en masse (corbeille, lu/non-lu, déplacer) — même dans la
        vue toutes-boîtes.</li>
      <li>Le bouton <strong>⬆</strong> en bas à droite remonte en haut des longues listes.</li>
    </ul>`)}

  ${section('🆘 En cas de pépin', `
    <ul class="help-list">
      <li>Consulte le <a href="#/operations">📜 Journal d'activité</a> : chaque action y est notée
        avec la liste exacte des mails concernés.</li>
      <li>Redémarre via <strong>MailAssistant.bat</strong> — l'index se reconstruit tout seul à la
        synchronisation, rien n'est perdu.</li>
      <li>Vérifie la version en bas de la barre latérale et l'état du serveur dans
        <a href="#/settings">⚙️ Paramètres</a>.</li>
      <li>Tes identifiants restent chiffrés sur TON PC (accounts.json) : ils ne transitent jamais
        par le navigateur ni par un service externe.</li>
    </ul>`)}`;
}

// Libellé de la mise à jour automatique du serveur (le PC, lui, se met à
// jour à chaque lancement de MailAssistant.bat).
function autoUpdateLabel(a) {
  if (!a || !a.enabled) {
    return '<span class="muted">✕ désactivée — ici, la mise à jour se fait au lancement</span>';
  }
  const quand = a.external
    ? 'gérée par le minuteur du serveur (hors application)'
    : `chaque nuit à ${String(a.hour).padStart(2, '0')} h`;
  if (!a.lastResult) return `✅ ${quand} · <span class="muted">aucun passage encore</span>`;
  const emoji = a.lastResult === 'échec' ? '⚠️' : '✅';
  const detail = a.lastRunAt ? ` le ${fmtDateTime(a.lastRunAt)}` : '';
  const head = `${emoji} ${quand}<div class="muted" style="font-size:11.5px">dernier passage${detail} : ${esc(a.lastResult)}</div>`;
  if (!a.lastMessage) return head;
  // Message COMPLET (retour utilisateur 29/07 : « le message est coupé, donc
  // on n'a pas la fin »). Un diagnostic tronqué au milieu d'une erreur de
  // compilation ne sert à rien. Replié quand il est long, jamais amputé.
  const msg = a.lastMessage;
  if (msg.length <= 90) return `${head}<div class="update-msg">${esc(msg)}</div>`;
  return `${head}<details class="op-details"><summary>Voir le détail complet</summary>
    <div class="update-msg">${esc(msg)}</div></details>`;
}

// Libellé de l'auto-sync (L5.11) pour le panneau Serveur des Paramètres.
function autoSyncLabel(a) {
  if (!a || !a.intervalMinutes) {
    return '<span title="Réglage serveur : SYNC_INTERVAL_MINUTES">✕ désactivée — synchronise à la demande</span>';
  }
  const mins = a.nextRunAt
    ? Math.max(0, Math.round((new Date(a.nextRunAt).getTime() - Date.now()) / 60000))
    : null;
  return `✅ toutes les ${fmtNum(a.intervalMinutes)} min${mins !== null ? ` · prochaine dans ~${fmtNum(mins)} min` : ''}`;
}

// ---------------------------------------------------------------- Paramètres (L5.8)
// Minuteur du rafraîchissement automatique du panneau « Compréhension des
// mails » pendant une lecture. Au niveau module : il doit survivre aux
// re-rendus du corps de l'écran, et être annulable quand on quitte.
let snipTimer = null;

async function renderSettings() {
  const main = $('#main');
  main.innerHTML = `<div class="page-head">
    <div><h1>⚙️ Paramètres</h1>
      <div class="sub">Gère tes boîtes (nom, couleur, retrait) et consulte l'état du serveur.
      Supprimer une boîte ici ne touche JAMAIS tes mails chez Microsoft : seul l'accès de
      Mail Assistant est retiré.</div></div></div>
    <div id="settings-notice"></div>
    <div id="settings-body"><div class="empty"><span class="spinner"></span>Chargement…</div></div>`;
  await refreshOverview().catch(() => {});
  await api.version().then((v) => { serverVersion = v; }).catch(() => {});
  renderSettingsBody();
}

function renderSettingsBody() {
  const body = $('#settings-body');
  if (!body) return;
  const enrolled = overviewCache?.enrolled ?? [];
  const byAccount = new Map((overviewCache?.accounts ?? []).map((a) => [a.account, a]));

  const rows = enrolled.map((e, idx) => {
    const ov = byAccount.get(e.account);
    const quotaInfo = ov?.quota
      ? `<span title="${esc(fmtSize(ov.quota.usedBytes))} utilisés sur ${esc(fmtSize(ov.quota.limitBytes))} — relu ${esc(fmtDateTime(ov.quotaCheckedAt))}">${ov.quota.pct} % · libre ${esc(fmtSize(ov.quota.freeBytes))}</span>`
      : `<span title="${esc(ov?.quotaNote || 'jamais lu — lance une synchronisation ou clique 📏')}">quota inconnu ⓘ</span>`;
    return `<tr>
      <td style="white-space:nowrap">
        <button class="btn btn-sm set-order-up" data-index="${idx}" ${idx === 0 ? 'disabled' : ''}
          title="Monter cette boîte dans l'ordre d'affichage (barre latérale, tableaux, listes)">↑</button>
        <button class="btn btn-sm set-order-down" data-index="${idx}" ${idx === enrolled.length - 1 ? 'disabled' : ''}
          title="Descendre cette boîte dans l'ordre d'affichage">↓</button></td>
      <td><input type="color" class="set-color" data-account="${esc(e.account)}"
        value="${esc(accountColor(e.account))}" title="Choisir la couleur de cette boîte">
        ${e.color ? `<button class="btn btn-sm set-color-reset" data-account="${esc(e.account)}" title="Revenir à la couleur automatique">auto</button>` : ''}</td>
      <td><strong>${esc(e.account)}</strong></td>
      <td class="muted">${esc(e.username)}</td>
      <td class="muted" style="white-space:nowrap">${ov ? `${fmtNum(ov.indexedMessages)} mails · sync ${fmtDateTime(ov.lastSyncAt)}` : 'jamais synchronisée'}<br>${quotaInfo}</td>
      <td style="white-space:nowrap">
        <button class="btn btn-sm set-quota" data-account="${esc(e.account)}"
          title="Relire tout de suite la capacité de la boîte (utilisé / maximum) auprès du serveur Microsoft">📏 Quota</button>
        <button class="btn btn-sm set-rename" data-account="${esc(e.account)}" title="Change uniquement le nom affiché ici — l'accès à la boîte est conservé">✏️ Renommer</button>
        <button class="btn btn-sm set-remove" data-account="${esc(e.account)}" style="color:var(--red)" title="Retire la boîte de Mail Assistant — tes mails chez Microsoft ne bougent pas">🗑️ Supprimer</button>
      </td>
    </tr>`;
  }).join('');

  const v = serverVersion;
  body.innerHTML = `
    <div class="panel">
      <div class="panel-head"><h2>📧 Boîtes connectées</h2></div>
      <div class="panel-body tight">
        ${enrolled.length === 0
          ? '<div class="empty">Aucune boîte connectée.</div>'
          : `<table><thead><tr><th style="width:76px" title="Ordre d'affichage des boîtes partout dans l'interface">Ordre</th><th style="width:90px">Couleur</th><th>Nom</th><th>Adresse</th><th>Mails · Espace</th><th></th></tr></thead>
             <tbody>${rows}</tbody></table>`}
      </div>
      <div class="panel-body muted" style="font-size:12.5px; padding-top:0">
        ✏️ Renommer change uniquement le nom affiché ici (l'accès est conservé) ; la copie locale des mails est reconstruite à la synchronisation suivante. 🗑️ Supprimer retire la boîte de Mail
        Assistant — tes mails chez Microsoft ne bougent pas.</div>
    </div>
    <div class="panel">
      <div class="panel-head"><h2>🖥️ Serveur</h2></div>
      <div class="panel-body">
        <div class="set-line"><span class="muted">Version</span><span>${v ? `${esc(v.commit)} · ${esc(v.date)}` : '—'}</span></div>
        <div class="set-line"><span class="muted">Mise à jour</span>
          <span id="set-update"><span class="spinner"></span>vérification…</span></div>
        <div class="set-line"><span class="muted">Mise à jour automatique</span>
          <span>${autoUpdateLabel(v?.autoUpdate)}</span></div>
        <div class="set-line"><span class="muted">Superviseur (relance auto)</span>
          <span>${v?.supervised ? '✅ actif' : '⚠️ non supervisé — lancer via MailAssistant.bat'}</span></div>
        <div class="set-line"><span class="muted">Envoi de mails (SMTP)</span>
          <span>${smtpEnabled ? '✅ activé' : '<span title="Réglage serveur : ENABLE_SMTP_SEND">✕ désactivé</span>'}</span></div>
        <div class="set-line"><span class="muted">Synchronisation automatique</span>
          <span>${autoSyncLabel(v?.autoSync)}</span></div>
        <div class="set-line"><span class="muted">Boîtes synchronisées</span>
          <span>${fmtNum(overviewCache?.totals?.accounts ?? 0)} boîte(s) · ${fmtNum(overviewCache?.totals?.indexedMessages ?? 0)} mails</span></div>
        <div class="set-line"><span class="muted">Catégories de l'assistant</span>
          <span><button class="btn btn-sm" id="set-categorize" title="Réexamine « qui écrit » et « pourquoi » pour tous les mails déjà synchronisés (rapide)">🏷️ Réexaminer les expéditeurs</button></span></div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head"><h2>🔎 Compréhension des mails</h2></div>
      <div class="panel-body">
        <div class="muted" style="font-size:12.5px; margin-bottom:12px">
          Jusqu'ici l'assistant ne lisait que le <strong>sujet</strong> et l'expéditeur — d'où
          beaucoup de mails classés « je ne sais pas », donc ni triés ni nettoyables.
          Il garde maintenant un <strong>extrait du texte</strong> de chaque mail
          (~500 caractères, réponses citées retirées).
          Les pièces jointes ne sont <strong>jamais</strong> téléchargées.</div>
        <div id="snip-coverage"><span class="spinner"></span>Chargement…</div>
        <div class="set-line" style="align-items:flex-start; flex-wrap:wrap; gap:8px">
          <span><strong>Lire le texte des mails</strong><br>
            <span class="muted" style="font-size:12px">Long : chaque mail est ouvert une fois.
            Tu peux fermer la page, ça continue côté serveur.</span></span>
          <span>
            <button class="btn btn-sm" id="snip-recent" title="Les mails des 3 derniers mois qui n'ont pas encore d'extrait">📖 3 derniers mois</button>
            <button class="btn btn-sm" id="snip-all" title="Toute la boîte — beaucoup plus long">📚 Toute la boîte</button>
          </span>
        </div>
        <div class="set-line" style="align-items:flex-start; flex-wrap:wrap; gap:8px">
          <span><strong>Lire les documents scannés (OCR)</strong><br>
            <span class="muted" style="font-size:12px" id="ocr-note"><span class="spinner"></span>Chargement…</span></span>
          <span><button class="btn btn-sm" id="ocr-start" disabled>🔍 Lire les scans maintenant</button></span>
        </div>
        <div class="set-line" style="align-items:flex-start; flex-wrap:wrap; gap:8px">
          <span><strong>🖼️ Images des mails</strong><br>
            <span class="muted" style="font-size:12px">Par défaut je les bloque : les charger prévient
            l'expéditeur que tu as ouvert son mail (c'est comme ça que les publicitaires savent qui lit).
            Coche si tu préfères voir tes mails tels qu'ils ont été conçus — c'est ton choix, et il se
            change ici quand tu veux.<br>
            🛡️ Dans les deux cas, les <strong>mouchards</strong> (ces images d'un pixel qui ne servent
            qu'à signaler ton ouverture) sont retirés. Mesuré sur tes mails : 37 retirés sur 286 images,
            sans en abîmer une seule. Sache quand même qu'environ une image sur six porte un identifiant
            qui t'identifie : les afficher reste un signal, en partie.</span></span>
          <span><label style="white-space:nowrap"><input type="checkbox" id="set-images-auto">
            Afficher les images automatiquement</label></span>
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head"><h2>📦 Transférer mes boîtes</h2></div>
      <div class="panel-body">
        <div class="muted" style="font-size:12.5px; margin-bottom:12px">
          Enrôle tes boîtes <strong>une seule fois</strong>, puis transfère-les vers ton autre
          installation (ton PC ↔ ce serveur) au lieu de tout ressaisir.
          Le fichier produit est protégé par une phrase secrète que tu choisis — il ne dépend
          d'aucune machine.</div>

        <div class="notice warn" style="font-size:12.5px">
          ⚠️ Ce fichier donne un <strong>accès complet à tes boîtes</strong> : traite-le comme un
          mot de passe (ne l'envoie pas par mail, supprime-le après usage).
          Et après le transfert, <strong>n'utilise qu'une seule installation</strong> : si les deux
          tournent en même temps, elles finissent par se déconnecter mutuellement.</div>

        <div class="set-line" style="align-items:flex-start; flex-wrap:wrap; gap:8px">
          <span><strong>Exporter</strong><br>
            <span class="muted" style="font-size:12px">depuis cette installation</span></span>
          <span style="display:flex; gap:6px; flex-wrap:wrap; align-items:center">
            <input type="password" id="exp-pass" placeholder="phrase secrète (12 car. min)"
              style="min-width:220px" autocomplete="new-password">
            <button class="btn btn-sm" id="exp-btn">📤 Exporter mes boîtes</button></span>
        </div>

        <div class="set-line" style="align-items:flex-start; flex-wrap:wrap; gap:8px">
          <span><strong>Importer</strong><br>
            <span class="muted" style="font-size:12px">depuis un fichier exporté</span></span>
          <span style="display:flex; gap:6px; flex-wrap:wrap; align-items:center">
            <input type="file" id="imp-file" accept=".json,application/json">
            <input type="password" id="imp-pass" placeholder="phrase secrète du fichier"
              style="min-width:200px" autocomplete="off">
            <button class="btn btn-sm" id="imp-btn">📥 Importer</button></span>
        </div>
        <div id="port-result"></div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head"><h2>🩺 État du système</h2>
        <button class="btn btn-sm" id="set-health-refresh" title="Revérifier maintenant">↻ Vérifier</button></div>
      <div class="panel-body">
        <div class="muted" style="font-size:12.5px; margin-bottom:10px">
          Si une boîte cesse d'être synchronisée (jeton expiré, connexion refusée, serveur arrêté),
          l'assistant se tait — et ce silence ressemble à « rien à signaler ».
          C'est ici que tu le vois.</div>
        <div id="health-body"><span class="spinner"></span>Vérification…</div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head"><h2>💾 Sauvegardes</h2>
        <button class="btn btn-sm" id="set-backup" title="Créer une sauvegarde maintenant">💾 Sauvegarder maintenant</button></div>
      <div class="panel-body">
        <div class="muted" style="font-size:12.5px; margin-bottom:10px">
          Tes mails restent chez Microsoft, mais <strong>ton travail d'organisation</strong> (tâches,
          échéances validées, règles, catégories et priorités corrigées à la main) n'existe qu'ici.
          Une sauvegarde est faite <strong>chaque jour</strong> et <strong>avant chaque mise à jour</strong> ;
          les 7 dernières sont conservées.</div>
        <div id="backups-list"><span class="spinner"></span>Chargement…</div>
      </div>
    </div>`;

  const notice = (html) => { $('#settings-notice').innerHTML = html; };

  // --- Mise à jour : visible LÀ où l'utilisateur regarde la version ----------
  api.updateCheck().then(({ behind, commits }) => {
    const el = $('#set-update');
    if (!el) return;
    el.innerHTML = behind
      ? `<span class="badge orange">⬆️ ${fmtNum(behind)} nouveauté${behind > 1 ? 's' : ''}</span>
         <button class="btn btn-sm btn-primary" id="set-update-btn">Mettre à jour</button>
         <div class="muted" style="font-size:11.5px; margin-top:4px">${commits.slice(0, 2).map(esc).join(' · ')}</div>`
      : '✅ à jour';
    $('#set-update-btn')?.addEventListener('click', () => applyUpdateFlow(el));
  }).catch((err) => {
    const el = $('#set-update');
    if (!el) return;
    el.innerHTML = `<span class="badge red">⚠️ vérification impossible</span>
      <div class="muted" style="font-size:11.5px; margin-top:4px">${esc(err.message)} —
      ferme Mail Assistant et relance <strong>MailAssistant.bat</strong>.</div>`;
  });

  // --- Transfert des boîtes --------------------------------------------------
  const portMsg = (html) => { $('#port-result').innerHTML = html; };

  $('#exp-btn')?.addEventListener('click', async () => {
    const pass = $('#exp-pass').value;
    const btn = $('#exp-btn');
    btn.disabled = true;
    try {
      const env = await api.accountsExport(pass);
      // Téléchargement local : le fichier n'est jamais laissé sur le serveur.
      const blob = new Blob([JSON.stringify(env, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `boxmail-boites-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      $('#exp-pass').value = '';
      portMsg(`<div class="notice">📤 ${fmtNum(env.accounts)} boîte(s) exportée(s) — le fichier
        est dans tes téléchargements. Garde bien la phrase secrète : sans elle, il est inutilisable.</div>`);
    } catch (err) {
      portMsg(`<div class="notice warn">⚠️ ${esc(err.message)}</div>`);
    }
    btn.disabled = false;
  });

  $('#imp-btn')?.addEventListener('click', async () => {
    const file = $('#imp-file').files?.[0];
    const pass = $('#imp-pass').value;
    if (!file) { portMsg('<div class="notice warn">⚠️ Choisis d’abord le fichier exporté.</div>'); return; }
    const btn = $('#imp-btn');
    btn.disabled = true;
    try {
      const envelope = JSON.parse(await file.text());
      let r = await api.accountsImport(envelope, pass, false);
      // Boîtes déjà présentes ici : on demande avant d'écraser des accès en usage.
      if (r.skipped.length && confirm(
        `${r.skipped.length} boîte(s) sont déjà connectées ici :\n` +
        r.skipped.map((s) => `· ${s.account}`).join('\n') +
        `\n\nRemplacer leurs accès par ceux du fichier ?`)) {
        r = await api.accountsImport(envelope, pass, true);
      }
      $('#imp-pass').value = '';
      await refreshOverview();
      portMsg(`<div class="notice">📥 ${fmtNum(r.imported.length)} boîte(s) importée(s)${
        r.imported.length ? ' : ' + r.imported.map(esc).join(', ') : ''}.
        ${r.skipped.length ? `<br><span class="muted">Ignorées (déjà présentes) : ${r.skipped.map((s) => esc(s.account)).join(', ')}</span>` : ''}
        <br>Lance maintenant une <strong>synchronisation</strong> pour indexer leurs mails.</div>`);
      renderSettingsBody();
    } catch (err) {
      portMsg(`<div class="notice warn">⚠️ ${esc(err.message)}</div>`);
    }
    btn.disabled = false;
  });

  // --- État du système (P0.4) -----------------------------------------------
  const HEALTH_DOT = { ok: '🟢', warn: '🟠', error: '🔴' };
  const loadHealth = async () => {
    const el = $('#health-body');
    if (!el) return;
    try {
      const h = await api.health();
      el.innerHTML = `
        <div class="set-line"><span class="muted">Couverture</span>
          <span>${HEALTH_DOT[h.level]} <strong>${h.totals.fresh}/${h.totals.accounts}</strong> boîte(s) à jour ·
          ${fmtNum(h.totals.indexedMessages)} mails synchronisés</span></div>
        <div class="set-line"><span class="muted">Synchronisation automatique</span>
          <span>${h.autoSync.enabled ? `toutes les ${h.autoSync.intervalMinutes} min` : '✕ désactivée (synchro à la demande)'}</span></div>
        ${h.totals.unanalyzed > 0 ? `<div class="set-line"><span class="muted">Mails pas encore analysés</span>
          <span>${fmtNum(h.totals.unanalyzed)}</span></div>` : ''}
        ${h.accounts.map((a) => `<div class="set-line">
          <span>${HEALTH_DOT[a.level]} ${esc(a.account)}</span>
          <span class="muted" style="font-size:12px">${esc(a.message)}${a.lastSyncAt ? ` · ${fmtDateTime(a.lastSyncAt)}` : ''}</span></div>`).join('')}
        ${h.recentErrors.length ? `<div class="notice warn" style="margin-top:10px">
          ⚠️ ${h.recentErrors.map(esc).join('<br>')}</div>` : ''}`;
    } catch (err) {
      el.innerHTML = `<div class="notice warn">⚠️ ${esc(err.message)}</div>`;
    }
  };
  loadHealth();
  $('#set-health-refresh')?.addEventListener('click', loadHealth);

  // --- Sauvegardes (P0.3) ---------------------------------------------------
  const loadBackups = async () => {
    const el = $('#backups-list');
    if (!el) return;
    try {
      const { backups } = await api.backups();
      el.innerHTML = backups.length
        ? backups.map((b) => `<div class="set-line">
            <span>${esc(b.file.replace(/^boxmail_/, '').replace(/\.db$/, ''))}
              <span class="muted" style="font-size:11.5px">· ${fmtSize(b.sizeBytes)}</span></span>
            <span><button class="btn btn-sm" data-backup-dl="${esc(b.file)}"
              title="Télécharger cette sauvegarde sur ton PC">⬇️ Télécharger</button></span></div>`).join('')
        : '<div class="muted">Aucune sauvegarde pour l’instant — la première sera faite automatiquement.</div>';
      el.querySelectorAll('[data-backup-dl]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const file = btn.dataset.backupDl;
          downloadWithFeedback(btn, api.backupDownloadUrl(file), file, '⬇️ Télécharger');
        });
      });
    } catch (err) {
      el.innerHTML = `<div class="notice warn">⚠️ ${esc(err.message)}</div>`;
    }
  };
  loadBackups();

  $('#set-backup')?.addEventListener('click', async () => {
    const btn = $('#set-backup');
    btn.disabled = true;
    btn.textContent = '⏳ Sauvegarde…';
    try {
      const b = await api.backupCreate();
      notice(`<div class="notice">💾 Sauvegarde créée (${esc(fmtSize(b.sizeBytes))}).</div>`);
      await loadBackups();
    } catch (err) {
      notice(`<div class="notice warn">⚠️ ${esc(err.message)}</div>`);
    }
    btn.disabled = false;
    btn.textContent = '💾 Sauvegarder maintenant';
  });

  // Rafraîchissement automatique tant qu'une lecture tourne : sans lui, les
  // compteurs restaient figés et rien n'indiquait qu'un travail était en cours
  // (retour utilisateur 29/07). Le minuteur s'arrête dès qu'on quitte l'écran.
  const loadCoverage = async () => {
    const el = $('#snip-coverage');
    if (!el) {
      if (snipTimer) { clearTimeout(snipTimer); snipTimer = null; }
      return;
    }
    try {
      const { accounts: covAccounts, totals: t, ai, aiAccounts, job } = await api.analysisCoverage();
      const running = Boolean(job && job.running);
      const scopeLabel = job && job.scope === 'all' ? 'toute la boîte' : '3 derniers mois';

      // Tableau PAR BOÎTE : réconcilie « il reste N mails » (annoncé par
      // Claude pendant le rattrapage = colonne Douteux) et « X % analysés »
      // (= verdicts / mails lisibles). Avant, ces deux chiffres coexistaient
      // sans explication (retour utilisateur 01/08).
      const aiBySlug = new Map((aiAccounts ?? []).map((a) => [a.account, a]));
      const perBox = (covAccounts ?? []).filter((c) => c.total > 0);
      const boxTable = perBox.length === 0 ? '' : `
        <table style="margin:10px 0">
          <thead><tr>
            <th>Boîte</th>
            <th class="num" title="Mails synchronisés (hors corbeille/spam/envoyés)">Mails</th>
            <th class="num" title="Part des mails dont le texte a été capturé — pré-requis de toute analyse">Texte connu</th>
            <th class="num" title="Verdict IA posé, en % des mails dont le texte est connu">Analysés IA</th>
            <th class="num" title="Cas douteux restants : c'est CE chiffre que Claude annonce pendant le rattrapage (« il reste N mails »)">Douteux restants</th>
            <th class="num" title="Tous les mails analysables (lecture tentée, extrait vide inclus) encore sans verdict IA">Sans verdict</th>
          </tr></thead>
          <tbody>${perBox.map((c) => {
            const a = aiBySlug.get(c.account);
            return `<tr>
              <td>${accountChip(c.account)}</td>
              <td class="num">${fmtNum(c.total)}</td>
              <td class="num">${c.snippetCoveragePct} %</td>
              <td class="num">${a ? `<strong>${a.pct} %</strong> <span class="muted" style="font-size:11px">(${fmtNum(a.analysed)})</span>` : '—'}</td>
              <td class="num">${a ? (a.remainingUncertain ? fmtNum(a.remainingUncertain) : '<span class="badge green">✓ 0</span>') : '—'}</td>
              <td class="num muted">${a ? fmtNum(a.remainingAll) : '—'}</td>
            </tr>`;
          }).join('')}</tbody>
        </table>
        <div class="muted" style="font-size:12px; margin-bottom:10px">
          💡 Deux compteurs différents, deux questions différentes :
          <strong>« Douteux restants »</strong> = les mails que le rattrapage (Claude/Cowork) traite en
          priorité — c'est le « il reste N mails » qu'il t'annonce.
          <strong>« Analysés IA »</strong> = la part des mails analysables qui ont déjà un verdict
          (un mail sans texte exploitable reste analysable : l'IA juge alors sur le sujet et l'expéditeur).
          Un mail sans texte connu n'est pas analysable : lis d'abord le texte (boutons ci-dessous).</div>`;

      el.innerHTML = `
        ${running ? `<div class="notice" style="margin-bottom:10px">
          <span class="spinner"></span><strong>Lecture en cours</strong> — ${scopeLabel}
          ${job.lastMessage ? `<div class="muted" style="font-size:12px; margin-top:4px">${esc(job.lastMessage)}</div>` : ''}
          <div class="muted" style="font-size:12px">Les compteurs ci-dessous se mettent à jour tout seuls.</div>
        </div>` : ''}
        ${!running && job && job.status === 'error' ? `<div class="notice warn" style="margin-bottom:10px">
          ⚠️ Dernière lecture interrompue : ${esc(job.error || 'raison inconnue')}. Tu peux la relancer.</div>` : ''}
        <div class="set-line"><span class="muted">Mails dont le texte est connu</span>
          <span><strong>${t.snippetCoveragePct} %</strong> de ${fmtNum(t.total)} mails</span></div>
        <div class="set-line"><span class="muted">Restant à lire — toute la boîte</span>
          <span${running && job.scope === 'all' ? ' style="font-weight:600"' : ''}>${fmtNum(t.withoutSnippet)} mails</span></div>
        <div class="set-line"><span class="muted">Restant à lire — 3 derniers mois</span>
          <span${running && job.scope !== 'all' ? ' style="font-weight:600"' : ''}>${fmtNum(t.recentWithoutSnippet)} sur ${fmtNum(t.recent)}</span></div>
        <div class="set-line"><span class="muted">Analyse jugée incertaine</span>
          <span>${fmtNum(t.lowConfidence)} mails — protégés de tout nettoyage</span></div>
        ${ai ? `<div class="set-line"><span class="muted">Analysés par l'IA (toutes boîtes)</span>
          <span><strong>${ai.pct} %</strong> · ${fmtNum(ai.analysed)} sur ${fmtNum(ai.withText)} analysables
          ${ai.remainingUncertain ? `<br><span class="muted" style="font-size:12px">${fmtNum(ai.remainingUncertain)} cas douteux à reprendre</span>` : ''}</span></div>` : ''}
        ${boxTable}`;

      const br = $('#snip-recent');
      const ba = $('#snip-all');
      if (br) {
        br.disabled = running || t.recentWithoutSnippet === 0;
        br.title = t.recentWithoutSnippet === 0
          ? 'Tous les mails des 3 derniers mois sont déjà lus'
          : 'Les mails des 3 derniers mois qui n’ont pas encore d’extrait';
      }
      if (ba) {
        ba.disabled = running || t.withoutSnippet === 0;
        ba.title = t.withoutSnippet === 0
          ? 'Toute la boîte est déjà lue'
          : `${fmtNum(t.withoutSnippet)} mails restants — beaucoup plus long`;
      }
      if (snipTimer) clearTimeout(snipTimer);
      snipTimer = running ? setTimeout(loadCoverage, 8000) : null;
    } catch (err) {
      el.innerHTML = `<div class="notice warn">⚠️ ${esc(err.message)}</div>`;
    }
  };
  loadCoverage();

  const startSnippets = async (scope, btn) => {
    btn.disabled = true;
    try {
      await api.snippetsBackfill(scope);
      notice(`<div class="notice">📖 Lecture du texte des mails lancée
        (${scope === 'all' ? 'toute la boîte' : 'les 3 derniers mois'}).
        L'avancement s'affiche juste au-dessus et se met à jour tout seul.</div>`);
      loadCoverage();
    } catch (err) {
      btn.disabled = false;
      notice(`<div class="notice warn">⚠️ ${esc(err.message)}</div>`);
    }
  };
  $('#snip-recent')?.addEventListener('click', (e) => startSnippets('recent', e.currentTarget));
  $('#snip-all')?.addEventListener('click', (e) => startSnippets('all', e.currentTarget));

  // OCR des scans (13/08) : état de la chaîne tesseract/poppler + accélérateur.
  // Le worker de fond avance tout seul ; ce bouton sert quand il veut le stock
  // tout de suite. Suivi via la pastille d'activité (jobLabel 'ocr').
  const loadOcr = async () => {
    const note = $('#ocr-note');
    const btn = $('#ocr-start');
    if (!note || !btn) return;
    try {
      const s = await api.ocrStatus();
      if (!s.installed) {
        note.textContent = s.note;
        btn.disabled = true;
        btn.title = "L'OCR n'est pas encore installé sur le serveur";
        return;
      }
      note.innerHTML =
        `${fmtNum(s.scansAOcr)} document(s) scanné(s) à lire · ` +
        `${fmtNum(s.ocrReussis)} déjà lus par OCR` +
        (s.scansIllisibles
          ? ` · ${fmtNum(s.scansIllisibles)} illisibles même à la machine (je les regarde en image)`
          : '');
      btn.disabled = s.scansAOcr === 0;
      btn.title =
        s.scansAOcr === 0
          ? 'Tous les documents scannés sont déjà passés à l’OCR'
          : 'La lecture avance toute seule en tâche de fond — ce bouton accélère';
    } catch (err) {
      note.textContent = `⚠️ ${err.message}`;
    }
  };
  loadOcr();
  $('#ocr-start')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await api.ocrBackfill();
      notice(`<div class="notice">🔍 Lecture des scans lancée — montants et fournisseurs
        deviendront cherchables. Suis l'avancement via la pastille d'activité en bas
        de la barre latérale.</div>`);
    } catch (err) {
      btn.disabled = false;
      notice(`<div class="notice warn">⚠️ ${esc(err.message)}</div>`);
    }
  });

  // Images des mails : réglage local (le serveur n'a pas à connaître ce choix,
  // c'est le navigateur qui charge — ou non — les images).
  const caseImages = $('#set-images-auto');
  if (caseImages) {
    caseImages.checked = imagesAuto();
    caseImages.addEventListener('change', () => {
      setImagesAuto(caseImages.checked);
      notice(caseImages.checked
        ? `<div class="notice">🖼️ Les images s'afficheront directement dans tes mails.</div>`
        : `<div class="notice">🖼️ Les images seront de nouveau bloquées, avec un bouton pour les afficher au cas par cas.</div>`);
    });
  }

  $('#set-categorize')?.addEventListener('click', async () => {
    const btn = $('#set-categorize');
    btn.disabled = true;
    try {
      await api.categorizeAll();
      notice(`<div class="notice">🏷️ Recalcul des catégories lancé sur toutes les boîtes —
        suis l'avancement via la pastille d'activité en bas de la barre latérale.
        Les catégories apparaissent dans le tableau des expéditeurs de chaque boîte.</div>`);
    } catch (err) {
      btn.disabled = false;
      notice(`<div class="notice warn">⚠️ ${esc(err.message)}</div>`);
    }
  });

  body.querySelectorAll('.set-color').forEach((input) => {
    input.addEventListener('change', async () => {
      try {
        await api.accountSetColor(input.dataset.account, input.value);
        await refreshOverview();
        renderSettingsBody();
        notice(`<div class="notice">🎨 Couleur de <strong>${esc(input.dataset.account)}</strong> mise à jour.</div>`);
      } catch (err) {
        notice(`<div class="notice warn">⚠️ ${esc(err.message)}</div>`);
      }
    });
  });
  body.querySelectorAll('.set-color-reset').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await api.accountSetColor(btn.dataset.account, null);
        await refreshOverview();
        renderSettingsBody();
        notice(`<div class="notice">🎨 <strong>${esc(btn.dataset.account)}</strong> repasse en couleur automatique.</div>`);
      } catch (err) {
        notice(`<div class="notice warn">⚠️ ${esc(err.message)}</div>`);
      }
    });
  });

  // Ordre d'affichage : ↑/↓ échangent deux positions puis envoient la liste
  // complète — le serveur mémorise, tous les écrans suivent.
  const reorder = async (idx, delta) => {
    const order = enrolled.map((e) => e.account);
    const j = idx + delta;
    if (j < 0 || j >= order.length) return;
    [order[idx], order[j]] = [order[j], order[idx]];
    try {
      await api.accountsReorder(order);
      await refreshOverview();
      renderSettingsBody();
      notice(`<div class="notice">↕️ Ordre des boîtes mis à jour : ${order.map(esc).join(' → ')}.</div>`);
    } catch (err) {
      notice(`<div class="notice warn">⚠️ ${esc(err.message)}</div>`);
    }
  };
  body.querySelectorAll('.set-order-up').forEach((btn) => {
    btn.addEventListener('click', () => reorder(Number(btn.dataset.index), -1));
  });
  body.querySelectorAll('.set-order-down').forEach((btn) => {
    btn.addEventListener('click', () => reorder(Number(btn.dataset.index), +1));
  });

  // Relecture du quota à la demande : montre le résultat OU la raison de
  // l'échec (avant, « quota inconnu » restait muet).
  body.querySelectorAll('.set-quota').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const slug = btn.dataset.account;
      btn.disabled = true;
      btn.textContent = '⏳';
      try {
        const r = await api.accountQuotaRefresh(slug);
        await refreshOverview();
        renderSettingsBody();
        notice(r.ok
          ? `<div class="notice">📏 Quota de <strong>${esc(slug)}</strong> : ${esc(fmtSize(r.quota.usedBytes))} utilisés sur ${esc(fmtSize(r.quota.limitBytes))}.</div>`
          : `<div class="notice warn">📏 Quota de <strong>${esc(slug)}</strong> toujours inconnu — ${esc(r.note || 'raison inconnue')}.</div>`);
      } catch (err) {
        btn.disabled = false;
        btn.textContent = '📏 Quota';
        notice(`<div class="notice warn">⚠️ ${esc(err.message)}</div>`);
      }
    });
  });

  body.querySelectorAll('.set-rename').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const slug = btn.dataset.account;
      const to = prompt(
        `Nouveau nom pour « ${slug} » ?\n(2 à 30 caractères : lettres, chiffres, tirets, underscores)`,
        slug,
      );
      if (!to || to.trim() === slug) return;
      if (!confirm(
        `Renommer « ${slug} » en « ${to.trim()} » ?\n\nL'accès à la boîte est conservé, mais la copie locale des mails sera vidée : il faudra relancer une synchronisation (bouton sur la vue de la boîte).`,
      )) return;
      btn.disabled = true;
      try {
        const r = await api.accountRename(slug, to.trim());
        await refreshOverview();
        renderSettingsBody();
        notice(`<div class="notice">✏️ Boîte renommée en <strong>${esc(r.account)}</strong>.
          Pense à relancer une synchronisation : <a href="#/account/${encodeURIComponent(r.account)}">ouvrir la boîte</a>.</div>`);
      } catch (err) {
        btn.disabled = false;
        notice(`<div class="notice warn">⚠️ ${esc(err.message)}</div>`);
      }
    });
  });

  body.querySelectorAll('.set-remove').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const slug = btn.dataset.account;
      if (!confirm(
        `Retirer la boîte « ${slug} » de Mail Assistant ?\n\nTes mails chez Microsoft ne sont PAS touchés. Seuls l'accès et la copie locale des mails sont effacés. Tu pourras la reconnecter plus tard.`,
      )) return;
      const typed = prompt(`Confirmation : tape exactement le nom de la boîte à retirer (« ${slug} »)`);
      if (typed !== slug) {
        if (typed !== null) notice('<div class="notice warn">Nom saisi différent — suppression annulée.</div>');
        return;
      }
      btn.disabled = true;
      try {
        await api.accountRemove(slug);
        await refreshOverview();
        renderSettingsBody();
        notice(`<div class="notice">🗑️ Boîte <strong>${esc(slug)}</strong> retirée de Mail Assistant (mails intacts chez Microsoft).</div>`);
      } catch (err) {
        btn.disabled = false;
        notice(`<div class="notice warn">⚠️ ${esc(err.message)}</div>`);
      }
    });
  });
}

// ------------------------------------------------- Calendrier des échéances (L5.7)
// Vue mois posée sur les données EXISTANTES (/api/attention/deadlines +
// /api/tasks) : aucun nouveau backend, rien n'est écrit depuis cet écran.
const calState = {
  year: null, month: null, selected: null, deadlines: [], tasks: [],
  // Vue par défaut (Phase 3) : « À venir » — la grille d'un mois creux, c'est
  // surtout du vide ; une liste chronologique dit tout de suite ce qui arrive.
  view: (() => { try { return localStorage.getItem('cal-view') === 'month' ? 'month' : 'upcoming'; } catch { return 'upcoming'; } })(),
};

const CAL_TYPE_EMOJI = { payment: '💶', document: '📄', appointment: '📅', renewal: '🔁', other: '📌' };

function calDateKey(d) {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

async function renderCalendar() {
  const main = $('#main');
  const now = new Date();
  if (calState.year === null) {
    calState.year = now.getFullYear();
    calState.month = now.getMonth();
    calState.selected = calDateKey(now);
  }
  main.innerHTML = `<div class="page-head">
    <div><h1>🗓️ Calendrier</h1>
      <div class="sub">Tes échéances (confirmées ET proposées) et tes tâches à date, posées sur le mois.
      Clique un jour pour le détail, puis une échéance pour lire le mail d'origine.</div></div>
    <div class="head-actions">
      <button class="btn btn-primary" id="cal-detect"
        title="Cherche de nouvelles dates limites dans tes mails (toutes les boîtes) — les trouvailles sont PROPOSÉES, rien n'est ajouté sans toi">🔎 Analyser mes mails</button>
      <a class="btn" href="#/deadlines">📅 Gérer les échéances</a>
      <a class="btn" href="#/tasks">☑️ Gérer les tâches</a>
    </div></div>
    <div id="cal-detect-zone"></div>
    <div id="cal-body"><div class="empty"><span class="spinner"></span>Chargement…</div></div>`;
  $('#cal-detect').addEventListener('click', () => runDeadlineDetect({
    btn: $('#cal-detect'),
    zone: $('#cal-detect-zone'),
    deep: false,
    onDone: async (summary) => {
      await renderCalendar(); // recharge échéances + tâches
      const z = $('#cal-detect-zone');
      if (z && summary) z.innerHTML = summary;
    },
  }));
  try {
    const [dl, tk] = await Promise.all([api.deadlines(), api.tasks()]);
    calState.deadlines = dl.items.filter((x) => x.status !== 'dismissed');
    calState.tasks = tk.items.filter((t) => t.status === 'todo' && t.dueDate);
  } catch (err) {
    $('#cal-body').innerHTML = `<div class="notice warn">⚠️ ${esc(err.message)}</div>`;
    return;
  }
  renderCalendarBody();
}

function calEventsByDay() {
  const map = new Map();
  const add = (key, ev) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(ev);
  };
  for (const x of calState.deadlines) add(calDateKey(x.date), { kind: 'deadline', item: x });
  for (const t of calState.tasks) add(calDateKey(t.dueDate), { kind: 'task', item: t });
  return map;
}

function calViewTabs() {
  return `<div class="tabs" style="margin-bottom:10px">
    <button class="tab ${calState.view === 'upcoming' ? 'active' : ''}" data-cal-view="upcoming">À venir</button>
    <button class="tab ${calState.view === 'month' ? 'active' : ''}" data-cal-view="month">Mois</button>
  </div>`;
}

function bindCalViewTabs(root) {
  root.querySelectorAll('[data-cal-view]').forEach((b) => b.addEventListener('click', () => {
    calState.view = b.dataset.calView;
    try { localStorage.setItem('cal-view', calState.view); } catch { /* privé */ }
    renderCalendarBody();
  }));
}

// Vue « À venir » : les 30 prochains jours en liste chronologique (+ ce qui
// est déjà en retard), groupés par jour. Lecture seule, comme la grille.
function renderCalendarUpcoming(body) {
  const now0 = new Date();
  now0.setHours(0, 0, 0, 0);
  const horizon = now0.getTime() + 30 * 86_400_000;
  const todayKey = calDateKey(new Date());
  const tomorrowKey = calDateKey(new Date(now0.getTime() + 86_400_000));

  const entries = [
    ...calState.deadlines
      .filter((x) => x.status === 'proposed' || x.status === 'confirmed')
      .map((x) => ({ kind: 'deadline', date: new Date(x.date), item: x })),
    ...calState.tasks.map((t) => ({ kind: 'task', date: new Date(t.dueDate), item: t })),
  ]
    .filter((e) => e.date.getTime() <= horizon)
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  const byDay = new Map();
  for (const e of entries) {
    const key = calDateKey(e.date);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(e);
  }

  const flat = []; // pour retrouver l'entrée cliquée
  const row = (e) => {
    const i = e.item;
    const idx = flat.push(e) - 1;
    if (e.kind === 'task') {
      return `<div class="cal-up-row">
        <span class="badge gray">☑️ tâche</span>
        <span>${esc(i.title)}</span>
        ${i.account ? accountChip(i.account) : ''}
      </div>`;
    }
    const type = DEADLINE_TYPES[i.type] ?? DEADLINE_TYPES.other;
    const canOpen = i.uid != null && i.folder;
    return `<div class="cal-up-row">
      <span class="badge ${type.badge}">${type.label}</span>
      <span class="${canOpen ? 'openable' : ''}" ${canOpen ? `data-cal-up="${idx}" title="Lire le mail d'origine"` : ''}>${esc(i.title)}</span>
      ${i.status === 'proposed' ? '<a class="badge orange" href="#/deadlines" title="Confirme ou écarte cette date depuis l\'écran Dates à confirmer" style="text-decoration:none">à confirmer</a>' : '<span class="badge blue">confirmée</span>'}
      ${accountChip(i.account)}
    </div>`;
  };

  const dayBlock = (key, evs) => {
    const d = new Date(`${key}T12:00:00`);
    const overdue = key < todayKey;
    const label = key === todayKey ? 'Aujourd\'hui'
      : key === tomorrowKey ? 'Demain'
      : d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
    return `<div class="cal-up-day">
      <div class="cal-up-date ${overdue ? 'overdue' : ''}" style="text-transform:capitalize">${esc(label)}
        ${overdue ? '<span class="badge red">en retard</span>' : ''}</div>
      ${evs.map(row).join('')}
    </div>`;
  };

  body.innerHTML = `${calViewTabs()}
    <div class="panel"><div class="panel-body">
      ${byDay.size === 0
        ? '<div class="empty">Rien dans les 30 prochains jours. 🎉 Les dates détectées dans tes mails apparaîtront ici.</div>'
        : [...byDay.entries()].map(([key, evs]) => dayBlock(key, evs)).join('')}
    </div></div>
    <div class="muted" style="font-size:12.5px">🛟 Lecture seule : confirme ou écarte les dates
      depuis <a href="#/deadlines">📅 Dates à confirmer</a>.</div>`;

  bindCalViewTabs(body);
  body.querySelectorAll('[data-cal-up]').forEach((el) => {
    el.addEventListener('click', () => {
      const x = flat[Number(el.dataset.calUp)]?.item;
      if (!x) return;
      openReaderFor(
        { ...x, subject: x.subject ?? x.title, date: x.msgDate ?? x.date },
        { onRemoved: () => renderCalendar() },
      );
    });
  });
}

function renderCalendarBody() {
  const body = $('#cal-body');
  if (!body) return;
  if (calState.view === 'upcoming') {
    renderCalendarUpcoming(body);
    return;
  }
  const { year, month } = calState;
  const events = calEventsByDay();
  const todayKey = calDateKey(new Date());
  const monthLabel = new Date(year, month, 1).toLocaleDateString('fr-FR', {
    month: 'long',
    year: 'numeric',
  });

  // Grille lun→dim : 6 semaines fixes, jours des mois voisins grisés.
  const firstDay = new Date(year, month, 1);
  const offset = (firstDay.getDay() + 6) % 7; // lundi = 0
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(year, month, 1 + i - offset);
    const key = calDateKey(d);
    const evs = events.get(key) ?? [];
    const classes = [
      'cal-cell',
      d.getMonth() !== month ? 'out' : '',
      d.getDay() === 0 || d.getDay() === 6 ? 'weekend' : '',
      key === todayKey ? 'today' : '',
      key === calState.selected ? 'selected' : '',
    ].filter(Boolean).join(' ');
    const chips = evs.slice(0, 3).map((ev) => {
      const i = ev.item;
      const color = accountColor(i.account ?? '');
      const label = ev.kind === 'task' ? `☑️ ${i.title}` : `${CAL_TYPE_EMOJI[i.type] ?? '📌'} ${i.title}`;
      return `<span class="cal-ev ${ev.kind === 'deadline' && i.status === 'proposed' ? 'proposed' : ''}"
        style="border-left-color:${color}" title="${esc(label)}${i.account ? ` · ${esc(i.account)}` : ''}">${esc(label)}</span>`;
    }).join('');
    cells.push(`<div class="${classes}" data-day="${key}">
      <span class="cal-daynum">${d.getDate()}</span>${chips}
      ${evs.length > 3 ? `<span class="cal-more muted">+${evs.length - 3} autre(s)</span>` : ''}
    </div>`);
  }

  const dows = ['lun', 'mar', 'mer', 'jeu', 'ven', 'sam', 'dim'];
  body.innerHTML = `${calViewTabs()}
    <div class="cal-layout">
      <div>
        <div class="cal-head">
          <button class="btn btn-sm" id="cal-prev" title="Mois précédent">‹</button>
          <span class="cal-title">${esc(monthLabel)}</span>
          <button class="btn btn-sm" id="cal-next" title="Mois suivant">›</button>
          <button class="btn btn-sm" id="cal-today">Aujourd'hui</button>
          <span class="muted" style="font-size:12px; margin-left:auto">
            ${fmtNum(calState.deadlines.length)} échéance(s) · ${fmtNum(calState.tasks.length)} tâche(s) à date</span>
        </div>
        <div class="cal-grid">
          ${dows.map((d) => `<div class="cal-dow">${d}</div>`).join('')}
          ${cells.join('')}
        </div>
        <div class="panel-body muted" style="font-size:12.5px; padding:8px 4px 0">
          🛟 Lecture seule : rien n'est créé ni modifié depuis le calendrier. Les échéances en
          pointillé sont encore <em>proposées</em> — confirme-les depuis l'écran Dates à confirmer.</div>
      </div>
      <div class="cal-side" id="cal-side"></div>
    </div>`;

  $('#cal-prev').addEventListener('click', () => {
    calState.month--;
    if (calState.month < 0) { calState.month = 11; calState.year--; }
    renderCalendarBody();
  });
  $('#cal-next').addEventListener('click', () => {
    calState.month++;
    if (calState.month > 11) { calState.month = 0; calState.year++; }
    renderCalendarBody();
  });
  $('#cal-today').addEventListener('click', () => {
    const n = new Date();
    calState.year = n.getFullYear();
    calState.month = n.getMonth();
    calState.selected = todayKey;
    renderCalendarBody();
  });
  body.querySelectorAll('.cal-cell').forEach((cell) => {
    cell.addEventListener('click', () => {
      calState.selected = cell.dataset.day;
      renderCalendarBody();
    });
  });
  bindCalViewTabs(body);

  renderCalendarSide(events);
}

function renderCalendarSide(events) {
  const side = $('#cal-side');
  if (!side) return;
  const key = calState.selected;
  if (!key) {
    side.innerHTML = '<div class="panel"><div class="panel-body"><div class="empty">Clique un jour du calendrier pour voir son détail.</div></div></div>';
    return;
  }
  const evs = events.get(key) ?? [];
  const dayLabel = new Date(`${key}T12:00:00`).toLocaleDateString('fr-FR', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
  const deadlines = evs.filter((e) => e.kind === 'deadline');
  const tasks = evs.filter((e) => e.kind === 'task');

  const dlRow = (x, idx) => {
    const type = DEADLINE_TYPES[x.type] ?? DEADLINE_TYPES.other;
    const canOpen = x.uid != null && x.folder;
    return `<div class="cal-side-row">
      <div>
        <span class="badge ${type.badge}">${type.label}</span>
        ${x.status === 'proposed' ? '<span class="badge orange">à valider</span>'
          : x.status === 'done' ? '<span class="badge green">✓ fait</span>'
          : '<span class="badge blue">confirmée</span>'}
        ${accountChip(x.account)}
      </div>
      <div class="${canOpen ? 'openable' : ''}" ${canOpen ? `data-cal-open="${idx}" title="Lire le mail d'origine"` : ''}>${esc(x.title)}</div>
      ${x.fromName || x.fromEmail ? `<div class="muted" style="font-size:12px">${esc(x.fromName || x.fromEmail)}</div>` : ''}
    </div>`;
  };
  const taskRowSide = (t) => `<div class="cal-side-row">
    <div><span class="badge gray">☑️ tâche</span>${t.account ? ` ${accountChip(t.account)}` : ''}</div>
    <div>${esc(t.title)}</div>
    ${t.notes ? `<div class="muted" style="font-size:12px">${esc(t.notes)}</div>` : ''}
  </div>`;

  side.innerHTML = `<div class="panel">
    <div class="panel-head"><h2 style="text-transform:capitalize">${esc(dayLabel)}</h2></div>
    <div class="panel-body">
      ${evs.length === 0 ? '<div class="empty">Rien ce jour-là. 🎉</div>' : ''}
      ${deadlines.map((e, idx) => dlRow(e.item, idx)).join('')}
      ${tasks.map((e) => taskRowSide(e.item)).join('')}
    </div>
  </div>`;

  side.querySelectorAll('[data-cal-open]').forEach((el) => {
    el.addEventListener('click', () => {
      const x = deadlines[Number(el.dataset.calOpen)]?.item;
      if (!x) return;
      openReaderFor(
        { ...x, subject: x.subject ?? x.title, date: x.msgDate ?? x.date },
        { onRemoved: () => renderCalendar() },
      );
    });
  });
}

// ---------------------------------------------------------------- Tâches (L5.5)
const tasksState = { tab: 'todo', data: null };

async function renderTasks() {
  const main = $('#main');
  main.innerHTML = `<div class="page-head">
    <div><h1>☑️ Mes tâches</h1>
      <div class="sub">Ta liste à faire : ajoutée à la main, depuis un mail (panneau de lecture)
      ou depuis une échéance. Rien ici ne touche aux mails.</div></div>
    <div class="head-actions">
      <button class="btn" id="tasks-refresh">↻ Actualiser</button>
      <button class="btn btn-primary" id="tasks-new">＋ Nouvelle tâche</button>
    </div></div>
    <div id="tasks-body"><div class="empty"><span class="spinner"></span>Chargement…</div></div>`;
  $('#tasks-refresh').addEventListener('click', loadTasks);
  $('#tasks-new').addEventListener('click', () => openTaskModal({}));
  await loadTasks();
}

async function loadTasks() {
  const body = $('#tasks-body');
  if (!body) return;
  body.innerHTML = '<div class="empty"><span class="spinner"></span>Chargement…</div>';
  try {
    tasksState.data = await api.tasks();
  } catch (err) {
    body.innerHTML = `<div class="notice warn">⚠️ ${esc(err.message)}</div>`;
    return;
  }
  refreshTasksBadge(tasksState.data);
  renderTasksBody();
}

function renderTasksBody() {
  const body = $('#tasks-body');
  const d = tasksState.data;
  if (!body || !d) return;
  const tabs = [
    { key: 'todo', label: 'À faire', n: d.counts.todo },
    { key: 'done', label: 'Terminées', n: d.counts.done },
    { key: 'dismissed', label: 'Ignorées', n: d.counts.dismissed },
  ];
  const items = d.items.filter((i) => i.status === tasksState.tab);
  const emptyMessages = {
    todo: 'Rien à faire ! Ajoute une tâche avec « ＋ Nouvelle tâche », depuis un mail ouvert, ou depuis une échéance.',
    done: 'Aucune tâche terminée pour l\'instant.',
    dismissed: 'Aucune tâche ignorée.',
  };

  body.innerHTML = `
    <div class="tabs">${tabs
      .map(
        (t) => `<button class="tab ${tasksState.tab === t.key ? 'active' : ''}" data-tab="${t.key}">
        ${t.label}${t.n > 0 ? ` <span class="badge ${t.key === 'todo' && d.counts.overdue > 0 ? 'red' : 'gray'}">${fmtNum(t.n)}</span>` : ''}</button>`,
      )
      .join('')}</div>
    <div class="panel"><div class="panel-body tight">
      ${items.length === 0
        ? `<div class="empty">${emptyMessages[tasksState.tab]}</div>`
        : items.map(taskRow).join('')}
    </div></div>`;

  body.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      tasksState.tab = btn.dataset.tab;
      renderTasksBody();
    });
  });

  const act = async (btn, fn) => {
    btn.disabled = true;
    try {
      await fn();
      await loadTasks();
    } catch (err) {
      alert(err.message);
      btn.disabled = false;
    }
  };
  body.querySelectorAll('[data-task-action]').forEach((btn) => {
    btn.addEventListener('click', () =>
      act(btn, () => api.taskAction(Number(btn.dataset.id), btn.dataset.taskAction)),
    );
  });
  body.querySelectorAll('[data-open]').forEach((el) => {
    el.addEventListener('click', () => {
      const t = items[Number(el.dataset.open)];
      openReaderFor(
        { account: t.account, folder: t.folder, uid: t.uid, subject: t.subject ?? t.title,
          fromName: t.fromName, fromEmail: t.fromEmail ?? '', date: t.dueDate, isSeen: true },
        { onRemoved: () => loadTasks() },
      );
    });
  });
}

const TASK_SOURCE_LABELS = {
  manual: '',
  mail: '<span class="badge gray">✉️ depuis un mail</span>',
  deadline: '<span class="badge gray">📅 depuis une échéance</span>',
};

function taskRow(t, idx) {
  const canOpen = t.uid != null && t.folder && t.account;
  const due =
    t.dueDate === null
      ? ''
      : t.overdue
        ? `<span class="badge red">⏰ en retard — ${deadlineCountdown(t.inDays)}</span>`
        : `<span class="badge ${t.inDays <= 3 ? 'orange' : 'gray'}">${deadlineCountdown(t.inDays)}</span>`;
  const actions =
    t.status === 'todo'
      ? `<button class="btn btn-sm btn-green" data-task-action="done" data-id="${t.id}">✓ Fait</button>
         <button class="btn btn-sm" data-task-action="dismiss" data-id="${t.id}" title="Retirer sans marquer fait">✕ Ignorer</button>`
      : `<button class="btn btn-sm" data-task-action="reopen" data-id="${t.id}">↩︎ Remettre à faire</button>`;
  return `<div class="reply-row">
    <div class="reply-main">
      <div class="reply-top">
        <strong class="${canOpen ? 'openable' : ''}" ${canOpen ? `data-open="${idx}" title="Ouvrir le mail d'origine"` : ''}>${esc(t.title)}</strong>
        ${t.dueDate ? `<span class="muted" style="font-size:12px">pour le ${fmtDate(t.dueDate)}</span>` : ''}
        ${t.account ? accountChip(t.account) : ''}
        ${TASK_SOURCE_LABELS[t.source] ?? ''}
      </div>
      ${t.fromName || t.fromEmail ? `<div class="reply-reason muted">mail de ${esc(t.fromName || t.fromEmail)}</div>` : ''}
      ${t.notes ? `<div class="reply-reason muted">${esc(t.notes)}</div>` : ''}
    </div>
    <div class="reply-side">
      ${t.status === 'done' ? `<span class="badge green">✓ faite le ${fmtDate(t.doneAt)}</span>` : due}
      <div class="reply-actions">${actions}</div>
    </div>
  </div>`;
}

// Modale de création (utilisée par l'écran, le panneau de lecture et les échéances).
function openTaskModal({ title = '', dueDate = '', account = null, messageRef = null, notes = '' }) {
  closeModal();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal">
    <div class="modal-head"><h2>☑️ Nouvelle tâche</h2>
      <button class="modal-close" title="Fermer">✕</button></div>
    <div class="modal-body">
      <div class="compose-grid">
        <label>Titre</label><input type="text" id="t-title" maxlength="300" value="${esc(title)}" placeholder="Ce qu'il y a à faire">
        <label>Pour le</label><input type="date" id="t-due" value="${esc(dueDate)}">
        <label>Notes</label><input type="text" id="t-notes" maxlength="2000" value="${esc(notes)}" placeholder="optionnel">
      </div>
      ${messageRef ? '<p class="muted" style="margin-top:10px; font-size:12.5px">📎 La tâche gardera un lien vers le mail ouvert.</p>' : ''}
      <div id="t-error"></div>
    </div>
    <div class="modal-foot">
      <button class="btn" id="t-cancel">Annuler</button>
      <button class="btn btn-primary" id="t-save">Créer la tâche</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('.modal-close').addEventListener('click', closeModal);
  $('#t-cancel').addEventListener('click', closeModal);
  $('#t-title').focus();

  $('#t-save').addEventListener('click', async () => {
    const titleVal = $('#t-title').value.trim();
    if (!titleVal) {
      $('#t-error').innerHTML = '<div class="notice warn" style="margin-top:10px">Le titre est requis.</div>';
      return;
    }
    const btn = $('#t-save');
    btn.disabled = true;
    try {
      await api.taskCreate({
        title: titleVal,
        notes: $('#t-notes').value.trim() || undefined,
        dueDate: $('#t-due').value || undefined,
        account: account ?? undefined,
        messageRef: messageRef ?? undefined,
      });
      closeModal();
      refreshTasksBadge();
      if ((location.hash || '').startsWith('#/tasks')) loadTasks();
    } catch (err) {
      btn.disabled = false;
      $('#t-error').innerHTML = `<div class="notice warn" style="margin-top:10px">❌ ${esc(err.message)}</div>`;
    }
  });
}

// ------------------------------------------- Boîte de réception navigable (L5.2)
const inboxState = {
  // '' = 🌐 toutes les boîtes (défaut) ; mémorisé entre les visites.
  account: localStorage.getItem('bm.inboxAccount') ?? '',
  // Rôle de dossier en vue unifiée : inbox | sent | drafts | trash | archive | spam
  //
  // MÉMORISÉS entre les visites, comme le compte (12/08). Sans ça, revenir sur
  // une boîte ou faire F5 ramenait toujours à la réception : l'URL ne porte que
  // le compte, et le dossier ne vivait qu'en mémoire — donc perdu au premier
  // rafraîchissement. Signalé par Anthony : « en refaisant F5 pour rafraîchir,
  // on revient dans le bon dossier ».
  role: localStorage.getItem('bm.inboxRole') || 'inbox',
  folder: localStorage.getItem('bm.inboxFolder') || '',
  offset: 0,
  pageSize: 50,
  unseen: false,
  attachments: false,
  q: '',
  sort: 'date',
  dir: 'desc',
  data: null,
  folders: [],
  selected: new Set(), // clés `compte|dossier|uid` (page courante uniquement)
};

const isUnifiedInbox = () => inboxState.account === '';
const inboxKey = (i) => `${i.account}|${i.folder}|${i.uid}`;

const INBOX_ROLE_LABELS = {
  inbox: '📥 Boîte de réception',
  flagged: '⭐ Mails suivis',
  sent: '📤 Envoyés',
  drafts: '📝 Brouillons',
  trash: '🗑️ Corbeille',
  archive: '📦 Archive',
  spam: '⚠️ Spam',
};

// Titre explicite de l'écran : on sait toujours OÙ on est (L5.18).
function updateInboxTitle() {
  const h1 = $('#inbox-title');
  if (!h1) return;
  h1.textContent = isUnifiedInbox()
    ? `🌐 Toutes les boîtes — ${(INBOX_ROLE_LABELS[inboxState.role] ?? inboxState.role).replace(/^\S+ /, '')}`
    : `📥 ${inboxState.account} — ${inboxState.folder || 'INBOX'}`;
}

async function renderInbox(slugFromHash) {
  const main = $('#main');
  const accounts = (overviewCache?.enrolled ?? []).map((e) => e.account);
  if (accounts.length === 0) {
    main.innerHTML = `<div class="page-head"><div><h1>📥 Boîte de réception</h1></div></div>
      <div class="notice warn">Aucune boîte connectée.</div>`;
    return;
  }
  if (slugFromHash?.startsWith('@')) {
    // Lien direct « toutes les boîtes » sur un rôle : #/inbox/@sent, @drafts, @trash…
    inboxState.account = '';
    inboxState.role = slugFromHash.slice(1) || 'inbox';
    inboxState.offset = 0;
    inboxState.selected.clear();
  } else if (slugFromHash && accounts.includes(slugFromHash)) {
    inboxState.account = slugFromHash;
    if (!sideOpen.has(slugFromHash)) {
      sideOpen.add(slugFromHash);
      localStorage.setItem('bm.sideOpen', JSON.stringify([...sideOpen]));
      renderAccountsNav();
      loadSideFolders();
    }
  }
  if (inboxState.account && !accounts.includes(inboxState.account)) {
    inboxState.account = ''; // compte disparu → retour à la vue unifiée
  }

  main.innerHTML = `<div class="page-head">
    <div><h1 id="inbox-title">📥 Boîte de réception</h1>
      <div class="sub">Tous les mails du dossier, page par page (instantané).
      Clique un mail pour le lire ; coche pour agir en masse. Synchronise pour des résultats à jour.</div></div>
    <div class="head-actions">
      <input type="search" id="inbox-q" placeholder="🔎 Filtrer : sujet, expéditeur…"
        value="${esc(inboxState.q)}" title="Filtre la liste affichée (Entrée pour lancer, ✕ pour effacer)" style="width:210px">
      <select id="inbox-account" title="Boîte">
        <option value="" ${inboxState.account === '' ? 'selected' : ''}>🌐 Toutes les boîtes</option>
        ${accounts
          .map((a) => `<option value="${esc(a)}" ${a === inboxState.account ? 'selected' : ''}>${esc(a)}</option>`)
          .join('')}</select>
      <select id="inbox-folder" title="Dossier"></select>
      <label style="display:flex; align-items:center; gap:6px; font-size:12.5px" class="muted">
        <input type="checkbox" id="inbox-unseen" ${inboxState.unseen ? 'checked' : ''}> non lus</label>
      <label style="display:flex; align-items:center; gap:6px; font-size:12.5px" class="muted"
        title="Seuls les mails synchronisés depuis la version « pièces jointes » portent l'info 📎 — les plus anciens apparaîtront après une resynchronisation complète.">
        <input type="checkbox" id="inbox-attachments" ${inboxState.attachments ? 'checked' : ''}> 📎 avec PJ</label>
      <button class="btn" id="inbox-refresh" title="Recharge la liste depuis les mails synchronisés (pour interroger le serveur Microsoft, lance une synchronisation depuis la vue de la boîte)">↻ Actualiser</button>
      <button class="btn btn-primary" id="inbox-compose" title="Écrire un nouveau mail (envoyé depuis la boîte sélectionnée)">Nouveau mail</button>
    </div></div>
    <div id="inbox-notice"></div>
    <div class="tabs hidden" id="inbox-view-tabs" style="margin-bottom:10px">
      <button class="tab" data-iv="reco" title="Le courrier groupé par besoin de décision, avec une action proposée par mail">✨ Décisions recommandées</button>
      <button class="tab" data-iv="recent" title="La liste chronologique classique">🕐 Plus récents</button>
    </div>
    <div class="inbox-layout" id="inbox-layout">
      <div class="inbox-list" id="inbox-body"><div class="empty"><span class="spinner"></span>Chargement…</div></div>
      <div class="inbox-dock hidden" id="inbox-dock"></div>
    </div>`;

  $('#inbox-account').addEventListener('change', async (e) => {
    inboxState.account = e.target.value;
    localStorage.setItem('bm.inboxAccount', inboxState.account);
    // Changer de boîte remet au dossier par défaut : un chemin de dossier n'a
    // pas de sens d'une boîte à l'autre.
    inboxState.folder = '';
    if (!isUnifiedInbox()) inboxState.role = 'inbox';
    localStorage.setItem('bm.inboxRole', inboxState.role);
    localStorage.setItem('bm.inboxFolder', '');
    inboxState.offset = 0;
    inboxState.selected.clear();
    await loadInboxFolders();
    loadInbox();
  });
  $('#inbox-folder').addEventListener('change', (e) => {
    if (e.target.value.startsWith('@')) {
      inboxState.role = e.target.value.slice(1);
      inboxState.folder = '';
    } else {
      inboxState.folder = e.target.value;
    }
    // Mémorisé, comme le compte : c'est ce qui fait qu'un F5 te ramène ICI.
    localStorage.setItem('bm.inboxRole', inboxState.role);
    localStorage.setItem('bm.inboxFolder', inboxState.folder);
    inboxState.offset = 0;
    inboxState.selected.clear();
    loadInbox();
  });
  $('#inbox-unseen').addEventListener('change', (e) => {
    inboxState.unseen = e.target.checked;
    inboxState.offset = 0;
    inboxState.selected.clear();
    loadInbox();
  });
  $('#inbox-attachments').addEventListener('change', (e) => {
    inboxState.attachments = e.target.checked;
    inboxState.offset = 0;
    inboxState.selected.clear();
    loadInbox();
  });
  $('#inbox-q').addEventListener('search', (e) => {
    inboxState.q = e.target.value.trim();
    inboxState.offset = 0;
    inboxState.selected.clear();
    loadInbox();
  });
  $('#inbox-q').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      inboxState.q = e.target.value.trim();
      inboxState.offset = 0;
      inboxState.selected.clear();
      loadInbox();
    }
  });
  $('#inbox-refresh').addEventListener('click', loadInbox);
  $('#inbox-compose').addEventListener('click', () => {
    if (!smtpEnabled) {
      alert("Envoi désactivé sur ce serveur (ENABLE_SMTP_SEND=false dans le .env).");
      return;
    }
    openComposeModal({ account: inboxState.account || accounts[0] });
  });

  await loadInboxFolders();
  await loadInbox();
}

// Remplit le sélecteur de dossiers du compte courant (INBOX sélectionnée par défaut).
async function loadInboxFolders() {
  const sel = $('#inbox-folder');
  if (!sel) return;
  if (isUnifiedInbox()) {
    // Vue unifiée : le sélecteur choisit le TYPE de dossier, toutes boîtes.
    const roles = [
      ['inbox', '📥 Boîte de réception'],
      ['flagged', '⭐ Mails suivis'],
      ['sent', '📤 Envoyés'],
      ['drafts', '📝 Brouillons'],
      ['trash', '🗑️ Corbeille'],
      ['archive', '📦 Archive'],
      ['spam', '⚠️ Spam'],
    ];
    sel.innerHTML = roles
      .map(([r, label]) => `<option value="@${r}" ${inboxState.role === r ? 'selected' : ''}>${label} (toutes les boîtes)</option>`)
      .join('');
    sel.disabled = false;
    inboxState.folder = '';
    inboxState.folders = [];
    return;
  }
  inboxState.role = 'inbox';
  sel.disabled = false;
  sel.innerHTML = '<option>…</option>';
  try {
    const { folders } = await api.folders(inboxState.account);
    inboxState.folders = folders;
    const usable = folders.filter((f) => f.messageCount > 0 || f.role === 'inbox');
    if (!inboxState.folder || !usable.some((f) => f.path === inboxState.folder)) {
      inboxState.folder = usable.find((f) => f.role === 'inbox')?.path ?? usable[0]?.path ?? 'INBOX';
    }
    sel.innerHTML = usable
      .map(
        (f) => `<option value="${esc(f.path)}" ${f.path === inboxState.folder ? 'selected' : ''}>
          ${esc(f.path)} (${fmtNum(f.messageCount)})</option>`,
      )
      .join('');
  } catch {
    sel.innerHTML = `<option value="INBOX">INBOX</option>`;
    inboxState.folder = 'INBOX';
  }
}

// Vue « Décisions recommandées » : le courrier entrant groupé par besoin de
// décision (à décider / à lire / probablement rangeable), une action proposée
// par ligne — la liste chronologique classique reste à un clic.
async function loadInboxReco() {
  const body = $('#inbox-body');
  if (!body) return;
  body.innerHTML = '<div class="empty"><span class="spinner"></span>Préparation du courrier…</div>';
  let q;
  let s;
  try {
    [q, s] = await Promise.all([api.reviewQueue(), api.reviewSummary()]);
  } catch (err) {
    body.innerHTML = `<div class="notice warn">${esc(err.message)}</div>`;
    return;
  }
  if (!body.isConnected) return;

  const singles = q.groups.filter((g) => g.kind === 'single').map((g) => g.item);
  const lots = q.groups.filter((g) => g.kind === 'lot');
  const importants = singles.filter((i) => i.class === 'important');
  const reads = singles.filter((i) => i.class === 'read');
  const ranges = singles.filter((i) => i.class === 'range');
  reviewRefs = [...singles];

  const row = (it, mainBtn) => `<div class="reply-row" data-rv-row="${it.id}">
    <div class="reply-main">
      <div class="reply-top"><strong>${esc(it.fromName || it.fromEmail || '?')}</strong>
        ${accountChip(it.account)} ${it.isSeen ? '' : '<span class="badge orange">non lu</span>'}
        <span class="reply-date">${fmtDate(it.date)}</span></div>
      <div class="reply-subject"><span class="openable" data-rv-open="${it.id}">${esc(it.subject)}</span></div>
      ${reviewReason(it) ? `<div class="reply-reason muted">${esc(reviewReason(it))}</div>` : ''}
    </div>
    <div class="reply-side"><div class="reply-actions">
      ${mainBtn}
      <button class="btn btn-sm" data-rv-later="${it.id}" title="Décision prise : tu le liras plus tard">🕐 Plus tard</button>
    </div></div>
  </div>`;
  const lotRow = (lot, k) => `<div class="reply-row">
    <div class="reply-main">
      <div class="reply-top"><strong>${fmtNum(lot.count)} mails de ${esc(lot.fromName || lot.fromEmail)}</strong>
        ${accountChip(lot.account)}
        <span class="muted" style="font-size:12px">${esc(lot.familleLabel ?? (lot.intent ? (INTENT_LABELS[lot.intent] ?? lot.intent) : ''))}</span></div>
      <div class="reply-reason muted">${lot.samples.slice(0, 2).map((x) => esc(x.subject)).join(' · ')}${lot.count > 2 ? ' …' : ''}</div>
    </div>
    <div class="reply-side"><div class="reply-actions">
      <button class="btn btn-sm btn-primary" data-rv-lot-seen="${k}">👁️ Vu pour les ${fmtNum(lot.count)}</button>
    </div></div>
  </div>`;
  const section = (title, badge, inner) => inner
    ? `<div class="panel"><div class="panel-head"><h2>${title}</h2>${badge}</div>
       <div class="panel-body tight">${inner}</div></div>`
    : '';

  body.innerHTML = `
    ${s.total > 0 ? `<div class="ta-hero" style="margin-bottom:12px">
      <div><strong>${fmtNum(s.total)} nouveau(x) mail(s) attendent une décision</strong></div>
      <button class="btn btn-primary" id="rv-inbox-start">Tout dépouiller</button></div>` : ''}
    ${section('🔥 À décider maintenant', `<span class="badge red">${fmtNum(importants.length)}</span>`,
      importants.map((i) => row(i, `<button class="btn btn-sm btn-primary" data-rv-act="${i.id}">☑️ Ajouter à mes actions</button>`)).join(''))}
    ${section('📖 À lire quand tu as le temps', `<span class="badge blue">${fmtNum(reads.length)}</span>`,
      reads.map((i) => row(i, `<button class="btn btn-sm btn-primary" data-rv-seen="${i.id}">👁️ Vu</button>`)).join(''))}
    ${section('🧹 Peuvent probablement être rangés', `<span class="badge gray">${fmtNum(ranges.length + lots.reduce((n, l) => n + l.count, 0))}</span>`,
      lots.map((l, k) => lotRow(l, k)).join('') +
      ranges.map((i) => row(i, `<button class="btn btn-sm btn-primary" data-rv-seen="${i.id}">👁️ Vu</button>`)).join(''))}
    ${s.total === 0 ? '<div class="empty">✅ Ton courrier est dépouillé — aucun nouveau mail sans décision.</div>' : ''}
    <div class="muted" style="font-size:12.5px; margin-top:8px">
      ${s.reviewedToday ? `${fmtNum(s.reviewedToday)} décision(s) prise(s) aujourd'hui · ` : ''}
      ${s.laterCount ? `${fmtNum(s.laterCount)} « à lire plus tard » · ` : ''}
      « Plus récents » montre la liste chronologique complète.</div>`;

  const decideRow = async (btn, id, decision) => {
    btn.disabled = true;
    try {
      await api.reviewDecide([id], decision);
      body.querySelector(`[data-rv-row="${id}"]`)?.remove();
    } catch (err) {
      btn.disabled = false;
      alert(err.message);
    }
  };
  $('#rv-inbox-start')?.addEventListener('click', () => startReviewFlow());
  body.querySelectorAll('[data-rv-seen]').forEach((b) => b.addEventListener('click', () => decideRow(b, Number(b.dataset.rvSeen), 'seen')));
  body.querySelectorAll('[data-rv-later]').forEach((b) => b.addEventListener('click', () => decideRow(b, Number(b.dataset.rvLater), 'later')));
  body.querySelectorAll('[data-rv-act]').forEach((b) => b.addEventListener('click', () => decideRow(b, Number(b.dataset.rvAct), 'action')));
  body.querySelectorAll('[data-rv-lot-seen]').forEach((b) => b.addEventListener('click', async () => {
    const lot = lots[Number(b.dataset.rvLotSeen)];
    b.disabled = true;
    try {
      await api.reviewDecide(lot.ids, 'seen');
      loadInbox();
    } catch (err) {
      b.disabled = false;
      alert(err.message);
    }
  }));
  body.querySelectorAll('[data-rv-open]').forEach((el) => el.addEventListener('click', () => {
    const it = reviewRefs.find((r) => r.id === Number(el.dataset.rvOpen));
    if (it) openReaderFor(it, { dock: $('#inbox-dock') });
  }));
}
let reviewRefs = [];

// Mode d'affichage de la boîte unifiée : « Décisions recommandées » (défaut,
// le courrier groupé par besoin de décision) ou « Plus récents » (chronologie).
function inboxView() {
  try { return localStorage.getItem('inbox-view') === 'recent' ? 'recent' : 'reco'; } catch { return 'reco'; }
}

async function loadInbox() {
  const body = $('#inbox-body');
  if (!body) return;
  // Point de passage OBLIGÉ de tout changement de dossier — y compris les clics
  // dans la barre latérale, qui ne passent par aucun des sélecteurs. C'est donc
  // ici qu'on retient où tu es, pour t'y ramener au rafraîchissement.
  try {
    localStorage.setItem('bm.inboxRole', inboxState.role || 'inbox');
    localStorage.setItem('bm.inboxFolder', inboxState.folder || '');
  } catch {
    /* navigation privée : tant pis pour la mémorisation */
  }
  // La bascule n'existe que sur la boîte de réception unifiée — pas sur les
  // dossiers (envoyés, corbeille…) ni sur une boîte précise.
  const tabs = $('#inbox-view-tabs');
  const recoAvailable = isUnifiedInbox() && inboxState.role === 'inbox';
  if (tabs) {
    tabs.classList.toggle('hidden', !recoAvailable);
    if (recoAvailable) {
      tabs.querySelectorAll('[data-iv]').forEach((b) => {
        b.classList.toggle('active', b.dataset.iv === inboxView());
        b.onclick = () => {
          try { localStorage.setItem('inbox-view', b.dataset.iv); } catch { /* privé */ }
          loadInbox();
        };
      });
    }
  }
  if (recoAvailable && inboxView() === 'reco') {
    await loadInboxReco();
    return;
  }
  body.innerHTML = '<div class="empty"><span class="spinner"></span>Chargement…</div>';
  try {
    inboxState.data = isUnifiedInbox()
      ? await api.messagesUnified({
          offset: inboxState.offset,
          limit: inboxState.pageSize,
          unseen: inboxState.unseen,
          attachments: inboxState.attachments,
          sort: inboxState.sort,
          dir: inboxState.dir,
          role: inboxState.role,
          q: inboxState.q,
        })
      : await api.listMessages(inboxState.account, {
          folder: inboxState.folder,
          offset: inboxState.offset,
          limit: inboxState.pageSize,
          unseen: inboxState.unseen,
          attachments: inboxState.attachments,
          sort: inboxState.sort,
          dir: inboxState.dir,
          q: inboxState.q,
        });
  } catch (err) {
    body.innerHTML = `<div class="notice warn">⚠️ ${esc(err.message)}${
      err.data?.needsSync
        ? ` <a href="#/account/${esc(inboxState.account)}">Ouvrir la boîte pour la synchroniser</a>.`
        : ''
    }</div>`;
    return;
  }
  inboxState.selected.clear();
  updateInboxTitle();
  highlightNav();
  renderInboxBody();
}

function renderInboxBody() {
  const body = $('#inbox-body');
  const d = inboxState.data;
  if (!body || !d) return;
  const sel = inboxState.selected;
  const pageEnd = Math.min(d.offset + d.items.length, d.total);

  // Légende de provenance (vue unifiée uniquement) : chaque boîte avec sa
  // couleur, cliquable pour filtrer — on identifie d'un coup d'œil d'où vient
  // chaque mail (retour utilisateur 01/08).
  const legend = isUnifiedInbox() && (overviewCache?.enrolled?.length ?? 0) > 1
    ? `<div class="muted" style="font-size:12px; margin:0 0 8px; display:flex; align-items:center; gap:6px; flex-wrap:wrap">
        <span>Provenance :</span>
        ${overviewCache.enrolled.map((e) =>
          `<span class="openable" data-legend-account="${esc(e.account)}"
            title="Ne montrer que les mails de ${esc(e.account)}">${accountChip(e.account)}</span>`).join('')}
        <span>— clique une boîte pour la voir seule</span></div>`
    : '';

  body.innerHTML = `
    ${legend}
    <div id="inbox-bulkbar" class="export-bar ${sel.size ? '' : 'hidden'}"></div>
    <div class="panel"><div class="panel-body tight">
      ${d.items.length === 0
        ? `<div class="empty">${
            inboxState.q
              ? `Aucun mail ne contient « ${esc(inboxState.q)} » ici. Efface le filtre (✕) ou essaie l'écran 🔎 Recherche pour chercher partout.`
              : inboxState.attachments
              ? 'Aucun mail avec pièce jointe ici. NB : seuls les mails synchronisés depuis la version « pièces jointes » portent cette info — une resynchronisation complète la pose sur les nouveaux arrivages.'
              : inboxState.unseen ? 'Aucun mail non lu dans ce dossier. 🎉' : 'Dossier vide (ou pas encore synchronisé).'
          }</div>`
        : `<table><thead><tr>
            <th style="width:30px"><input type="checkbox" id="inbox-check-all" title="Cocher la page"></th>
            <th style="width:100px" class="sortable ${inboxState.sort === 'date' ? 'sorted' : ''}" data-sort="date"
              title="Trier par date">Date ${sortArrow('date')}</th>
            ${isUnifiedInbox() ? '<th style="width:110px">Boîte</th>' : ''}
            <th style="width:220px" class="sortable ${inboxState.sort === 'from' ? 'sorted' : ''}" data-sort="from"
              title="Trier par expéditeur">Expéditeur ${sortArrow('from')}</th>
            <th class="sortable ${inboxState.sort === 'subject' ? 'sorted' : ''}" data-sort="subject"
              title="Trier par sujet">Sujet ${sortArrow('subject')}</th><th></th>
          </tr></thead>
          <tbody>${d.items
            .map(
              (i, k) => `<tr class="${i.isSeen ? '' : 'unread-row'}">
              <td style="box-shadow: inset 3px 0 ${accountColor(i.account)}"><input type="checkbox" class="inbox-check" data-key="${esc(inboxKey(i))}" ${sel.has(inboxKey(i)) ? 'checked' : ''}></td>
              <td class="muted" style="white-space:nowrap; font-size:12px">${fmtDate(i.date)}</td>
              ${isUnifiedInbox() ? `<td>${accountChip(i.account)}</td>` : ''}
              <td style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:220px"
                title="${esc(i.fromEmail)}">${i.isOutbound ? '<span class="badge gray">envoyé</span> ' : ''}${esc(i.fromName || i.fromEmail)}</td>
              <td><span class="openable ${i.isSeen ? '' : 'unread-subject'}" data-open="${k}" title="Lire le mail">${esc(i.subject)}</span>
                ${i.snippet ? `<div class="row-snippet" title="${esc(i.snippet)}">${esc(i.snippet)}</div>` : ''}</td>
              <td style="white-space:nowrap"><span class="star" data-star="${k}"
                  title="${i.isFlagged ? 'Ne plus suivre ce mail' : 'Suivre ce mail (⭐)'}">${i.isFlagged ? '⭐' : '☆'}</span>
                ${isUnifiedInbox() && inboxState.role === 'flagged' ? folderBadge(i) : ''}
                ${i.hasAttachments ? `<span class="badge gray" title="${i.attachmentCount} pièce(s) jointe(s)">📎${i.attachmentCount > 1 ? i.attachmentCount : ''}</span>` : ''}
                ${i.hasListUnsubscribe ? '<span class="badge gray">📰</span>' : ''}
                ${i.isSeen ? '' : '<span class="badge orange">non lu</span>'}</td>
            </tr>`,
            )
            .join('')}</tbody></table>`}
    </div></div>
    <div class="inbox-pager">
      <span class="muted">${d.total === 0 ? '0 mail' : `${fmtNum(d.offset + 1)}–${fmtNum(pageEnd)} sur ${fmtNum(d.total)}`}</span>
      <button class="btn btn-sm" id="inbox-prev" ${d.offset === 0 ? 'disabled' : ''}>← Précédents</button>
      <button class="btn btn-sm" id="inbox-next" ${pageEnd >= d.total ? 'disabled' : ''}>Suivants →</button>
    </div>
    <div class="panel-body muted" style="font-size:12.5px; padding:0 4px">
      🛟 Les actions en masse passent par la corbeille (soft delete, récupérable ~30 j), par lots
      de 200, et sont journalisées avec la liste exacte des mails.</div>`;

  body.querySelectorAll('[data-legend-account]').forEach((el) => {
    el.addEventListener('click', async () => {
      inboxState.account = el.dataset.legendAccount;
      localStorage.setItem('bm.inboxAccount', inboxState.account);
      inboxState.folder = '';
      inboxState.role = 'inbox';
      inboxState.offset = 0;
      inboxState.selected.clear();
      const sel2 = $('#inbox-account');
      if (sel2) sel2.value = inboxState.account;
      await loadInboxFolders();
      loadInbox();
    });
  });

  body.querySelectorAll('[data-open]').forEach((el) => {
    el.addEventListener('click', () => {
      const i = d.items[Number(el.dataset.open)];
      openReaderFor(i, {
        onSeen: (_, seen) => { i.isSeen = seen; renderInboxBody(); },
        onRemoved: () => loadInbox(),
        dock: $('#inbox-dock'),
      });
    });
  });

  $('#inbox-prev')?.addEventListener('click', () => {
    inboxState.offset = Math.max(0, inboxState.offset - inboxState.pageSize);
    loadInbox();
  });
  $('#inbox-next')?.addEventListener('click', () => {
    inboxState.offset += inboxState.pageSize;
    loadInbox();
  });

  const checkAll = $('#inbox-check-all');
  if (checkAll) {
    checkAll.checked = d.items.length > 0 && d.items.every((i) => sel.has(inboxKey(i)));
    checkAll.addEventListener('change', () => {
      for (const i of d.items) {
        if (checkAll.checked) sel.add(inboxKey(i));
        else sel.delete(inboxKey(i));
      }
      renderInboxBody();
    });
  }
  body.querySelectorAll('[data-star]').forEach((el) => {
    el.addEventListener('click', async () => {
      const i = d.items[Number(el.dataset.star)];
      if (!i) return;
      const action = i.isFlagged ? 'unflag' : 'flag';
      el.style.opacity = '0.4';
      try {
        await api.messageAction(i.account, { folder: i.folder, uid: i.uid, action });
        i.isFlagged = !i.isFlagged;
        renderInboxBody();
        refreshFlaggedBadge();
      } catch (err) {
        el.style.opacity = '';
        alert(err.message);
      }
    });
  });
  body.querySelectorAll('th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (inboxState.sort === key) {
        inboxState.dir = inboxState.dir === 'desc' ? 'asc' : 'desc';
      } else {
        inboxState.sort = key;
        inboxState.dir = key === 'date' ? 'desc' : 'asc';
      }
      inboxState.offset = 0;
      loadInbox();
    });
  });
  body.querySelectorAll('.inbox-check').forEach((box) => {
    box.addEventListener('change', () => {
      if (box.checked) sel.add(box.dataset.key);
      else sel.delete(box.dataset.key);
      renderInboxBulkbar();
    });
  });
  renderInboxBulkbar();
}

function sortArrow(key) {
  if (inboxState.sort !== key) return '';
  return inboxState.dir === 'desc' ? '▼' : '▲';
}

// Barre d'actions en masse (affichée dès qu'au moins un mail est coché).
function renderInboxBulkbar() {
  const bar = $('#inbox-bulkbar');
  if (!bar) return;
  const sel = inboxState.selected;
  bar.classList.toggle('hidden', sel.size === 0);
  if (sel.size === 0) return;
  const others = isUnifiedInbox()
    ? []
    : inboxState.folders.filter(
        (f) => f.path !== inboxState.folder && (f.messageCount > 0 || ['inbox', 'archive', 'trash'].includes(f.role)),
      );
  bar.innerHTML = `✅ <strong>${fmtNum(sel.size)}</strong> mail(s) sélectionné(s)
    <button class="btn btn-sm" id="bulk-delete" style="color:var(--red)" title="Met les mails cochés à la corbeille — 10 s pour annuler, récupérables ~30 jours dans Outlook">🗑️ Corbeille</button>
    ${isUnifiedInbox() ? '' : `<select id="bulk-move"><option value="">📦 Déplacer vers…</option>
      ${others.map((f) => `<option value="${esc(f.path)}">${esc(f.path)}</option>`).join('')}</select>`}
    <button class="btn btn-sm" id="bulk-seen" title="Marque les mails cochés comme lus (aussi côté Microsoft)">Marquer lus</button>
    <button class="btn btn-sm" id="bulk-unseen" title="Marque les mails cochés comme non lus (aussi côté Microsoft)">Marquer non lus</button>
    <button class="btn btn-sm" id="bulk-clear" title="Vide la sélection — aucune action sur les mails">Tout décocher</button>
    ${isUnifiedInbox() ? '<span class="muted" style="font-size:12px">(déplacement : choisir une boîte précise — les dossiers diffèrent selon les comptes)</span>' : ''}`;

  const run = async (action, destination) => {
    const n = inboxState.selected.size;
    // Cocher des mails PUIS cliquer Corbeille est déjà un geste en deux temps :
    // une question de plus n'apporte rien (retour 10/08). Le rattrapage est le
    // bandeau de 10 s ci-dessous. Le déplacement, lui, reste confirmé : il
    // demande une destination et n'a pas d'annulation d'un clic.
    if (action === 'move' && !confirm(`Déplacer ${n} mail(s) vers « ${destination} » ?`)) return;
    const notice = $('#inbox-notice');
    notice.innerHTML = `<div class="notice"><span class="spinner"></span>Action en cours sur ${fmtNum(n)} mail(s)…</div>`;
    try {
      // Les clés sélectionnées peuvent couvrir plusieurs boîtes (vue unifiée) :
      // on groupe par compte+dossier et on appelle l'API existante par groupe.
      const groups = new Map(); // 'compte|dossier' -> uids[]
      for (const key of inboxState.selected) {
        const [acct, folder, uid] = key.split('|');
        const gk = `${acct}|${folder}`;
        if (!groups.has(gk)) groups.set(gk, []);
        groups.get(gk).push(Number(uid));
      }
      let moved = 0;
      let count = 0;
      let skipped = 0;
      // De quoi ramener chaque groupe de sa corbeille (bandeau « Annuler »).
      const undos = [];
      for (const [gk, uids] of groups) {
        const [acct, folder] = gk.split('|');
        const r = await api.bulkAction(acct, { folder, uids, action, destination });
        moved += r.moved ?? 0;
        count += r.count ?? 0;
        skipped += r.skipped ?? 0;
        if (action === 'delete' && r.undo?.trashUids?.length) undos.push({ account: acct, ...r.undo });
      }
      notice.innerHTML = `<div class="notice">✅ ${
        action === 'delete' ? `${fmtNum(moved)} mail(s) → corbeille (récupérables ~30 j)`
        : action === 'move' ? `${fmtNum(moved)} mail(s) déplacés vers ${esc(destination)}`
        : `${fmtNum(count)} mail(s) marqués ${action === 'seen' ? 'lus' : 'non lus'}`
      }${skipped ? ` — ${fmtNum(skipped)} ignoré(s) (plus dans l'index)` : ''}${
        groups.size > 1 ? ` <span class="muted">(${groups.size} boîtes)</span>` : ''
      }.</div>`;
      inboxState.selected.clear();
      await loadInbox();
      refreshOverview().catch(() => {});
      if (action === 'delete') {
        const label = `${fmtNum(moved)} mail(s) mis à la corbeille`;
        showUndoToast(
          undos.length === groups.size ? `${label}.` : `${label} — récupérable ~30 j dans Outlook.`,
          undos.length === groups.size
            ? async () => {
                for (const u of undos) {
                  await api.messageRestore(u.account, { folder: u.folder, uids: u.uids, trashUids: u.trashUids });
                }
                await loadInbox();
                refreshOverview().catch(() => {});
              }
            : null,
        );
      }
    } catch (err) {
      notice.innerHTML = `<div class="notice warn">⚠️ ${esc(err.message)}</div>`;
    }
  };
  $('#bulk-delete').addEventListener('click', () => run('delete'));
  $('#bulk-move')?.addEventListener('change', (e) => {
    if (e.target.value) run('move', e.target.value);
    e.target.value = '';
  });
  $('#bulk-seen').addEventListener('click', () => run('seen'));
  $('#bulk-unseen').addEventListener('click', () => run('unseen'));
  $('#bulk-clear').addEventListener('click', () => {
    inboxState.selected.clear();
    renderInboxBody();
  });
}

// ---------------------------------------------------------------- Recherche (L3)
// ============================================================ Retrouver (11/08)
// « Retrouver sans classer ». Décision du 11/08, après mesures : ses boîtes ne
// sont pas sales, ce sont 25 000 mails d'archives non structurées. Lui demander
// de ranger serait le même reproche sous un autre nom — le produit doit donc
// répondre à « où est ce document ? », pas lister des mails.
//
// Concrètement, l'ancienne liste à plat de 200 lignes triées par date est
// remplacée par quelques INTERLOCUTEURS, chacun avec ce qu'il a envoyé, et
// chaque résultat dit POURQUOI il ressort.
const searchState = {
  q: '',
  account: '',
  attachments: false,
  /** Ordre demandé — voir TRIS_LABELS. Défaut : les échanges les plus récents. */
  sort: 'recent',
  /**
   * A-t-il CHOISI cet ordre lui-même ? (24/08)
   *
   * Tant que non, l'ordre s'adapte à ce qu'il tape : un seul mot, c'est
   * « montre-moi tout » et les plus récents en haut ; plusieurs mots, c'est
   * « trouve-moi précisément ça » et les plus pertinents en haut. Sans cela,
   * chercher « facture électricité miron » rangeait 54 résultats par date et
   * les procès-verbaux d'AG arrivaient devant — retour du 24/08.
   *
   * Le sélecteur AFFICHE toujours l'ordre réellement appliqué : basculer en
   * douce en laissant « les plus récents » à l'écran serait un mensonge, et il
   * n'aurait aucun moyen de comprendre son classement. Dès qu'il touche au
   * sélecteur, son choix prime et ne bouge plus.
   */
  sortChoisi: false,
  data: null,
  searched: false,
  /** Groupes dépliés (clé d'entité) — l'utilisateur en ouvre un à la fois. */
  open: new Set(),
};

/**
 * Un SEUL réglage d'ordre (19/08) — retour d'Anthony : « le tri est fait
 * n'importe comment ». Il l'était : les cartes sortaient par score de
 * pertinence, sans que rien ne le dise ni ne permette d'en changer.
 *
 * On dit « interlocuteur » et pas « destinataire » : dans une recherche, l'autre
 * partie est tantôt l'un tantôt l'autre — ce qu'il cherche, c'est la personne
 * avec qui il a échangé.
 *
 * Chaque changement REFAIT la recherche côté serveur : retrier ici les seules
 * lignes déjà chargées afficherait « les plus anciennes » de la page en cours
 * en les faisant passer pour les plus anciennes tout court.
 */
const TRIS_LABELS = [
  ['recent', '🕑 les plus récents'],
  ['ancien', '🕰️ les plus anciens'],
  ['az', '🔤 interlocuteur de A à Z'],
  ['za', '🔤 interlocuteur de Z à A'],
  ['pertinence', '🎯 les plus pertinents'],
];

// Exemples tirés de SES boîtes : quittance, bail, avis d'imposition… Un
// exemple concret vaut mieux qu'une explication de syntaxe.
const EXEMPLES = [
  ['une quittance de loyer', 'quittance'],
  ['un avis d’imposition', 'imposition'],
  ['un bail', 'bail'],
  ['un remboursement mutuelle', 'remboursement'],
  ['une facture', 'facture'],
  ['une réservation', 'réservation'],
];

const FOLDER_LABELS = { inbox: '📥', sent: '📤 envoyés', trash: '🗑️ corbeille', spam: '⚠️ spam', archive: '📦 archive', drafts: '📝 brouillons' };

function folderBadge(i) {
  if (i.folderRole === 'inbox') return '';
  const label = FOLDER_LABELS[i.folderRole] ?? esc(i.folder);
  return `<span class="badge gray">${label}</span>`;
}

/** « trouvé dans le nom de la pièce jointe » — jamais un résultat sans raison. */
function pourquoiLigne(item) {
  if (!item.matchedIn?.length) return '';
  const dit = {
    'pièce jointe': 'le nom de la pièce jointe',
    sujet: 'le sujet',
    expéditeur: "l'expéditeur",
    'contenu de la pièce': 'le contenu de la pièce jointe',
    résumé: 'le résumé',
    'texte du mail': 'le texte du mail',
    // Ce que l'analyse a NOMMÉ dans le mail : c'est ce qui retrouve « 46 rue de
    // la République » quand ni le sujet ni le texte ne le disent.
    'entité citée': 'ce dont parle le mail',
    'dossier cité': 'le dossier rattaché',
  };
  const l = item.matchedIn.map((m) => dit[m] ?? m);
  const txt = l.length === 1 ? l[0] : `${l.slice(0, -1).join(', ')} et ${l[l.length - 1]}`;
  return `<div class="find-why">trouvé dans ${esc(txt)}</div>`;
}

function ficheFichier(nom) {
  return `<span class="find-file" title="${esc(nom)}">${attIcon(nom)} ${esc(nom)}</span>`;
}

async function renderSearch(lancerToutDeSuite = false) {
  const main = $('#main');
  const accounts = (overviewCache?.enrolled ?? []).map((e) => e.account);
  main.innerHTML = `<div class="page-head">
    <div><h1>🔎 Que cherches-tu ?</h1>
      <div class="sub">Une facture, un document, un échange avec quelqu'un.
      Je cherche dans toutes tes boîtes à la fois — dans le sujet, dans le texte,
      dans le résumé, et jusque dans le <strong>nom des pièces jointes</strong>.
      Tu n'as rien à ranger.</div></div></div>
    <form class="find-bar" id="find-form">
      <input type="search" id="s-q" placeholder="ex. quittance, taxe foncière, Nathalie, bail…"
        value="${esc(searchState.q)}" autocomplete="off">
      <button type="submit" class="btn btn-primary">Chercher</button>
    </form>
    <div class="find-examples" id="find-examples">
      ${EXEMPLES.map(([label, q]) => `<button class="find-chip" data-q="${esc(q)}">${esc(label)}</button>`).join('')}
    </div>
    <div class="find-filters">
      <label>Dans <select id="s-account">
        <option value="">toutes mes boîtes</option>
        ${accounts.map((a) => `<option value="${esc(a)}" ${a === searchState.account ? 'selected' : ''}>${esc(a)}</option>`).join('')}
      </select></label>
      <label><input type="checkbox" id="s-attachments" ${searchState.attachments ? 'checked' : ''}>
        📎 seulement ce qui porte un document</label>
      <label>Trier par <select id="s-sort">
        ${TRIS_LABELS.map(([v, l]) => `<option value="${v}" ${v === searchState.sort ? 'selected' : ''}>${esc(l)}</option>`).join('')}
      </select></label>
    </div>
    <!-- Même règle qu'ailleurs : le mail s'ouvre À CÔTÉ de la liste, pour
         passer d'un résultat au suivant sans fermer. -->
    <div class="inbox-layout" id="search-layout">
      <div id="search-results">${searchState.searched ? '' : `<div class="empty">Tape un mot, ou clique un exemple ci-dessus.</div>`}</div>
      <div class="inbox-dock hidden" id="search-dock"></div>
    </div>`;

  const lireFiltres = () => {
    searchState.account = $('#s-account').value;
    searchState.attachments = $('#s-attachments').checked;
    // Un ordre différent de celui appliqué = il l'a changé lui-même.
    if ($('#s-sort').value !== searchState.sort) searchState.sortChoisi = true;
    searchState.sort = $('#s-sort').value;
  };

  /**
   * L'ordre qui convient à ce qu'il vient de taper (24/08) — voir
   * `searchState.sortChoisi`. Le sélecteur est remis à jour pour montrer
   * l'ordre RÉELLEMENT appliqué.
   */
  const ordreAdapte = () => {
    if (searchState.sortChoisi) return;
    const plusieursMots = searchState.q.replace(/["«»]/g, '').trim().split(/\s+/).length > 1;
    searchState.sort = plusieursMots ? 'pertinence' : 'recent';
    const sel = $('#s-sort');
    if (sel) sel.value = searchState.sort;
  };
  $('#find-form').addEventListener('submit', (e) => {
    e.preventDefault();
    searchState.q = $('#s-q').value.trim();
    lireFiltres();
    ordreAdapte();
    runSearch();
  });
  main.querySelectorAll('.find-chip').forEach((b) => {
    b.addEventListener('click', () => {
      searchState.q = b.dataset.q;
      $('#s-q').value = searchState.q;
      lireFiltres();
      ordreAdapte();
      runSearch();
    });
  });
  // Changer l'ordre relance la recherche : pas besoin de recliquer « Chercher ».
  $('#s-sort').addEventListener('change', () => {
    lireFiltres();
    if (searchState.searched && searchState.q) runSearch();
  });
  $('#s-q').focus();
  if (searchState.data) renderSearchResults();
  // Arrivée par un lien profond (« Voir l'histoire », « 🔍 Voir ») : la
  // question est déjà posée, on n'attend pas qu'il reclique « Chercher ».
  if (lancerToutDeSuite && searchState.q) {
    lireFiltres();
    ordreAdapte();
    runSearch();
  }
}

async function runSearch() {
  const el = $('#search-results');
  if (!searchState.q) {
    el.innerHTML = '<div class="empty">Dis-moi ce que tu cherches — un mot suffit.</div>';
    return;
  }
  el.innerHTML = '<div class="empty"><span class="spinner"></span>Je cherche…</div>';
  searchState.searched = true;
  searchState.open = new Set();
  try {
    searchState.data = await api.find({
      q: searchState.q,
      account: searchState.account,
      attachments: searchState.attachments,
      sort: searchState.sort,
      groups: 8,
      per: 25,
    });
  } catch (err) {
    el.innerHTML = `<div class="notice warn">⚠️ ${esc(err.message)}<br>
      Si une boîte n'est pas encore synchronisée, lance d'abord une synchronisation.</div>`;
    return;
  }
  renderSearchResults();
}

/**
 * Ce que la recherche a COMPRIS de la phrase tapée (23/08).
 *
 * La recherche découpe maintenant en mots — « facture électricité miron » fait
 * trois exigences, et non plus une chaîne de 25 caractères cherchée telle
 * quelle, qui ne rendait rien. Mais découper en SILENCE serait pire que de ne
 * pas découper : il ne pourrait pas voir qu'un mot a été écarté, ni pourquoi
 * un résultat inattendu remonte. On montre donc les mots retenus, et surtout
 * ce qu'il a fallu relâcher quand la demande exacte ne donnait rien.
 */
function ligneCompris(r) {
  if (!r || r.litteral || !r.mots?.length) return '';
  const puces = r.mots.map((m) => `<strong>${esc(m)}</strong>`).join(' · ');
  let note = '';
  if (r.repli === 'mots-absents' && r.motsAbsents?.length) {
    note = ` — aucun mail ne contient ${r.motsAbsents
      .map((m) => `« ${esc(m)} »`)
      .join(' ni ')}, j'ai cherché sans.`;
  } else if (r.repli === 'moins-de-mots') {
    note = ` — tes mots ne se trouvent jamais tous ensemble : voici les mails qui en portent au moins ${r.minMots}.`;
  } else if (r.ecartes?.length) {
    note = ` <span class="muted">(mots trop courants ignorés : ${r.ecartes.map(esc).join(', ')})</span>`;
  }
  // Un seul mot et rien à signaler : le dire serait du bruit.
  if (r.mots.length < 2 && !note) return '';
  return `<div class="find-compris">🔍 Je cherche : ${puces}${note}</div>`;
}

function renderSearchResults() {
  const el = $('#search-results');
  const d = searchState.data;
  if (!el || !d) return;
  if (!d.groups.length) {
    // Un écran vide doit DIRE pourquoi. Quand un mot n'existe dans aucun mail,
    // c'est presque toujours lui le coupable — le nommer vaut mieux que
    // « essaie un mot plus court », qu'Anthony ne peut pas appliquer sans
    // deviner lequel.
    const absents = d.recherche?.motsAbsents ?? [];
    const cause = absents.length
      ? `<br><span class="muted">Aucun mail ne contient ${absents
          .map((m) => `« <strong>${esc(m)}</strong> »`)
          .join(' ni ')}. Essaie sans ${absents.length > 1 ? 'ces mots' : 'ce mot'}.</span>`
      : `<br><span class="muted">Essaie un mot plus court, ou le nom de la personne ou de l'entreprise.</span>`;
    el.innerHTML = `<div class="empty">Je n'ai rien trouvé pour « ${esc(d.query)} ».${cause}</div>`;
    return;
  }

  // La recherche voit maintenant TOUT le corpus : le total est exact, et le
  // nombre d'interlocuteurs dit franchement combien de cartes restent derrière.
  const nbDocs = d.facets.withAttachments;
  const nbGroupes = d.totalGroups ?? d.groups.length;
  const reste = nbGroupes - d.groups.length;
  const entete = `<strong>${fmtNum(d.total)}</strong> mail${d.total > 1 ? 's' : ''} trouvé${d.total > 1 ? 's' : ''}
    chez <strong>${fmtNum(nbGroupes)}</strong> interlocuteur${nbGroupes > 1 ? 's' : ''}${
      reste > 0 ? ` — je te montre les ${d.groups.length} premiers` : ''
    }.`;

  el.innerHTML = `
    <div class="find-lead">${entete}
      ${nbDocs ? ` <span class="muted">· ${fmtNum(nbDocs)} portent un document.</span>` : ''}</div>
    ${ligneCompris(d.recherche)}
    ${(() => {
      // Deux cartes peuvent porter le même nom sans être le même expéditeur
      // (« Airbnb » depuis airbnb.com, et « Airbnb » depuis le prestataire qui
      // envoie ses questionnaires). On ne les réunit pas — ce serait faux —
      // mais on dit alors d'où vient chacune, plutôt que de laisser deux
      // cartes jumelles sans explication.
      const vus = new Map();
      for (const g of d.groups) vus.set(g.label, (vus.get(g.label) ?? 0) + 1);
      return d.groups.map((g) => carteGroupe(g, vus.get(g.label) > 1)).join('');
    })()}
    <div class="panel-body muted" style="font-size:12.5px; padding:4px">
      🛟 Rien n'est déplacé ni rangé : je retrouve tes mails là où ils sont.
      Clique une ligne pour lire le mail ici.</div>`;

  el.querySelectorAll('.find-more').forEach((b) => {
    b.addEventListener('click', () => {
      const k = b.dataset.key;
      if (searchState.open.has(k)) searchState.open.delete(k);
      else searchState.open.add(k);
      renderSearchResults();
    });
  });
  el.querySelectorAll('.result-row').forEach((row) => {
    row.addEventListener('click', () => {
      const g = searchState.data.groups.find((x) => x.key === row.dataset.key);
      const item = g?.items[Number(row.dataset.idx)];
      const dock = $('#search-dock');
      if (item) {
        // La série = les résultats DANS L'ORDRE OÙ ILS SONT AFFICHÉS, groupes
        // compris. C'est ce qu'il voit, donc ce que « suivant » doit suivre.
        const refs = [];
        for (const g of searchState.data.groups) {
          const ouvert = searchState.open.has(g.key);
          for (const it of (ouvert ? g.items : g.items.slice(0, 3))) refs.push(it);
        }
        openReader(item, row, {
          dock: dock && dock.isConnected && window.innerWidth > 1100 ? dock : null,
          serie: { refs, index: Math.max(0, refs.indexOf(item)) },
        });
      }
    });
  });
}

function carteGroupe(g, montrerOrigine = false) {
  const ouvert = searchState.open.has(g.key);
  const montres = ouvert ? g.items : g.items.slice(0, 3);
  const reste = g.count - montres.length;
  // Une phrase, pas un tableau de colonnes.
  const bits = [`${fmtNum(g.count)} mail${g.count > 1 ? 's' : ''}`];
  if (g.withAttachments) bits.push(`${fmtNum(g.withAttachments)} avec document`);
  if (g.lastAt) bits.push(`dernier échange le ${fmtDate(g.lastAt)}`);
  return `<div class="panel find-group">
    <div class="find-group-head">
      <div class="find-group-name">${esc(g.label)}${
        montrerOrigine && g.via
          ? ` <span class="find-group-via" title="Deux interlocuteurs portent ce nom : celui-ci écrit depuis ${esc(g.via)}">via ${esc(g.via)}</span>`
          : ''
      }</div>
      <div class="find-group-meta">${bits.join(' · ')}
        ${g.accounts.map((a) => accountChip(a)).join(' ')}</div>
    </div>
    ${g.fileNames.length ? `<div class="find-files">${g.fileNames.map(ficheFichier).join('')}</div>` : ''}
    <div class="panel-body tight">
      ${montres.map((i, idx) => `
        <div class="result-row ${i.isSeen ? '' : 'unread'}" data-key="${esc(g.key)}" data-idx="${idx}">
          <span class="mail-date">${fmtDate(i.date)}</span>
          <span class="sens-mail" title="${i.isOutbound ? 'Tu as écrit ce mail' : 'Tu as reçu ce mail'}">${i.isOutbound ? '↗' : '↘'}</span>
          <span class="result-subject">${esc(i.subject)}</span>
          ${i.hasAttachments ? `<span class="badge gray" title="${i.attachmentCount} pièce(s) jointe(s)">📎</span>` : ''}
          ${folderBadge(i)}
          ${pourquoiLigne(i)}
        </div>`).join('')}
      ${reste > 0 || ouvert
        ? `<button class="find-more" data-key="${esc(g.key)}">${ouvert ? '▴ replier' : `▾ voir les ${fmtNum(reste)} autres`}</button>`
        : ''}
    </div>
  </div>`;
}

// ------------------------------------------------ Pièces jointes (lecture)
// Trois gestes : 👁️ Voir (ouvre PDF/image dans un onglet, sans télécharger),
// ⬇️ télécharger une pièce (avec retour visuel), ⬇️ Tout en .zip.
const VIEWABLE_RE = /\.(pdf|png|jpe?g|gif|webp|svg|bmp|txt|csv)$/i;

// Icône selon le type de fichier (indice visuel rapide, façon Outlook).
function attIcon(name) {
  if (/\.pdf$/i.test(name)) return '📕';
  if (/\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(name)) return '🖼️';
  if (/\.(docx?|odt|rtf)$/i.test(name)) return '📘';
  if (/\.(xlsx?|ods|csv)$/i.test(name)) return '📗';
  if (/\.(zip|rar|7z|tar|gz)$/i.test(name)) return '🗜️';
  return '📄';
}

function renderReaderAttachments(az, item, attachments) {
  const many = attachments.length > 1;
  const totalBytes = attachments.reduce((s, a) => s + (a.sizeBytes || 0), 0);
  // Puces horizontales compactes (façon Outlook), repliables quand il y en a
  // plusieurs — pour ne pas repousser le corps du mail vers le bas.
  az.innerHTML = `<div class="att-head">
      ${many ? `<button class="att-toggle" data-att-toggle title="Réduire / afficher la liste" aria-expanded="true">▾</button>` : '<span class="att-toggle-spacer"></span>'}
      <strong>📎 ${fmtNum(attachments.length)} pièce(s) jointe(s)</strong>
      <span class="muted att-total">· ${fmtSize(totalBytes)}</span>
      ${many ? `<button class="btn btn-sm att-zip-btn" data-att-zip title="Télécharger toutes les pièces dans un .zip">⬇️ Tout (.zip)</button>` : ''}
    </div>
    <div class="att-chips" id="att-chips">
    ${attachments.map((a, ai) => {
      const name = a.filename || `piece-jointe-${ai + 1}`;
      const canView = VIEWABLE_RE.test(name);
      return `<div class="att-chip" title="${esc(name)} · ${fmtSize(a.sizeBytes)}">
        <span class="att-ico">${attIcon(name)}</span>
        <span class="att-name">${esc(name)}</span>
        <span class="att-size">${fmtSize(a.sizeBytes)}</span>
        ${canView ? `<button class="att-act att-view" data-att-view="${ai}" title="Voir (ouvrir dans un onglet)">👁️</button>` : ''}
        <button class="att-act att-dl" data-att-dl="${ai}" data-att-name="${esc(name)}" title="Télécharger ${esc(name)}">⬇️</button>
      </div>`;
    }).join('')}
    </div>`;

  // Réduire / déplier la liste des puces.
  const toggle = az.querySelector('[data-att-toggle]');
  if (toggle) {
    toggle.addEventListener('click', () => {
      const chips = az.querySelector('#att-chips');
      const collapsed = chips.classList.toggle('collapsed');
      toggle.textContent = collapsed ? '▸' : '▾';
      toggle.setAttribute('aria-expanded', String(!collapsed));
    });
  }

  // 👁️ Voir : ouvre l'URL inline dans un nouvel onglet (le navigateur affiche
  // et met en cache). L'onglet est ouvert AVANT (évite le blocage popup).
  az.querySelectorAll('[data-att-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const ai = Number(btn.dataset.attView);
      window.open(api.attachmentInlineUrl(item.account, item.folder, item.uid, ai), '_blank', 'noopener');
    });
  });
  // ⬇️ Télécharger une pièce, avec retour visuel.
  az.querySelectorAll('[data-att-dl]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const ai = Number(btn.dataset.attDl);
      downloadWithFeedback(
        btn,
        api.attachmentUrl(item.account, item.folder, item.uid, ai),
        btn.dataset.attName,
      );
    });
  });
  // ⬇️ Tout en .zip.
  const zipBtn = az.querySelector('[data-att-zip]');
  if (zipBtn) {
    zipBtn.addEventListener('click', () => {
      downloadWithFeedback(
        zipBtn,
        api.attachmentsZipUrl(item.account, item.folder, item.uid),
        `pieces-jointes-${item.account}-${item.uid}.zip`,
        '⬇️ Tout (.zip)',
      );
    });
  }
}

// Télécharge via fetch (blob) avec un état visible sur le bouton : le
// navigateur ne montre rien pendant que le serveur prépare le fichier (le
// mail peut mettre plusieurs secondes) — ici, l'utilisateur voit « en cours »
// puis le succès, ou un message d'erreur clair.
async function downloadWithFeedback(btn, url, filename, restoreLabel) {
  const original = restoreLabel ?? btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳ Préparation…';
  api.activity.begin(); // allume aussi la barre de chargement globale
  try {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) {
      let msg = `Erreur ${res.status}`;
      try { msg = (await res.json()).error || msg; } catch (_) { /* pas de JSON */ }
      throw new Error(msg);
    }
    const blob = await res.blob();
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objUrl;
    a.download = filename || 'piece-jointe';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objUrl), 4000);
    btn.textContent = '✅ Téléchargé';
    setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 2500);
  } catch (err) {
    btn.textContent = '⚠️ Réessayer';
    btn.disabled = false;
    alert(`Téléchargement impossible : ${err.message}`);
    setTimeout(() => { btn.textContent = original; }, 3000);
  } finally {
    api.activity.end();
  }
}

// --------------------------------------------------- Panneau de lecture (L3)
// Réutilisé par TOUS les écrans (recherche, importants, réponses, relances,
// échéances, dashboard, brief) : il suffit d'un item {account, folder, uid,
// subject, fromName, fromEmail, date, isSeen} et de deux callbacks optionnels.
// ---------------------------------------------------- Corps HTML (iframe sûre)
// Le HTML du mail est affiché dans une iframe SANDBOX : aucun script ne peut
// s'exécuter (pas de token allow-scripts, et les <script>/on*/javascript: sont
// retirés par précaution). Les images DISTANTES sont bloquées par défaut — un
// pixel invisible suffit à signaler la lecture à l'expéditeur — et un clic
// suffit à les afficher pour ce mail.
/**
 * Ce qui trahit un MOUCHARD sans avoir à le télécharger (20/08) — « on peut
 * bloquer le pixel espion, non ? juste celui-là ? ». Oui : un mouchard se
 * déclare. Il est en 1×1, ou masqué, ou son adresse dit ce qu'elle fait
 * (`/open`, `blank.gif`, `/s/eo/` chez les routeurs — « eo » pour email open).
 *
 * Motifs volontairement ÉTROITS : on ne devine pas, on ne retient que
 * l'aveu. Vérifié sur 286 images distantes de ses mails : 37 retirées, 249
 * gardées, et aucune vraie image dans le lot retiré.
 *
 * Le critère « hébergé chez un routeur d'emailing » a été essayé puis JETÉ :
 * il attrapait 120 images, dont les icônes Facebook/Instagram/TikTok servies
 * par `library.iterable.com`. Un CDN d'emailing héberge aussi les vraies
 * images — l'hébergeur ne dit rien de l'intention.
 */
const URL_MOUCHARD =
  /(^|[/?&=._-])(open|opened|track|tracking|trk|pixel|beacon|o\.gif|t\.gif|spacer\.gif|blank\.gif|clear\.gif|1x1)([/?&=._-]|$)/i;

/** Cette balise <img> ne sert-elle QU'à savoir que le mail a été ouvert ? */
function estMouchard(tag, src) {
  const style = (tag.match(/\sstyle\s*=\s*["']([^"']*)/i) || [])[1] || '';
  const nb = (re, dans) => {
    const v = Number((dans.match(re) || [])[1]);
    return Number.isFinite(v) ? v : NaN;
  };
  // Une image d'un ou deux pixels n'est là pour personne.
  const dims = [
    nb(/\swidth\s*=\s*["']?(\d+)/i, tag),
    nb(/\sheight\s*=\s*["']?(\d+)/i, tag),
    nb(/(?:^|;)\s*width\s*:\s*(\d+)px/i, style),
    nb(/(?:^|;)\s*height\s*:\s*(\d+)px/i, style),
  ];
  if (dims.some((v) => Number.isFinite(v) && v <= 3)) return true;
  if (/display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(\D|$)/i.test(style)) return true;
  return URL_MOUCHARD.test(src);
}

function sanitizeMailHtml(html, withImages, cidMap) {
  let blocked = 0;
  let mouchards = 0;
  let out = html
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script[^>]*>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, '')
    .replace(/((?:href|action)\s*=\s*["']?)\s*javascript:/gi, '$1blocked:');
  if (withImages) {
    // Images INTÉGRÉES au mail (cid:) : résolues vers l'endpoint de pièces
    // jointes (inline, servi avec cache navigateur) — récupérées à la demande,
    // jamais téléchargées sur le disque.
    out = out.replace(/(\ssrc\s*=\s*["'])cid:([^"']+)(["'])/gi, (_m, pre, cid, post) =>
      `${pre}${cidMap?.get(cid.trim()) ?? 'blocked:cid-introuvable'}${post}`);
    // Même quand il a choisi de voir les images, les MOUCHARDS restent
    // dehors : ils n'apportent rien à l'affichage, ils ne servent qu'à dire
    // à l'expéditeur qu'il a ouvert. Le reste du mail s'affiche entier.
    out = out.replace(/<img\b[^>]*>/gi, (tag) => {
      const src = (tag.match(/\ssrc\s*=\s*["']([^"']+)/i) || [])[1] || '';
      if (!/^https?:/i.test(src) || !estMouchard(tag, src)) return tag;
      mouchards++;
      // Sortie du jeu ET du flux : un mouchard qui déclare 30×30 laisserait
      // sinon une image cassée au milieu du mail (vu à la capture).
      return `${tag.replace(/\ssrc\s*=/i, ' data-mouchard-src=')
        .replace(/\sstyle\s*=\s*(["'])/i, ' style=$1display:none;')}`
        .replace(/<img\b(?![^>]*\sstyle=)/i, '<img style="display:none" ');
    });
    // Chargement paresseux : le navigateur ne charge que ce qui est visible.
    out = out.replace(/<img\b/gi, '<img loading="lazy" decoding="async" ');
  } else {
    out = out
      .replace(/\s(src|srcset)\s*=\s*(["'])(?!\s*data:)/gi, (_m, attr, q) => {
        blocked++;
        return ` data-x-${attr}=${q}`;
      })
      .replace(/url\(\s*(["']?)\s*https?:/gi, 'url($1blocked:');
  }
  const head = `<base target="_blank"><style>
    body { margin: 12px 16px; font-family: Inter, system-ui, "Segoe UI", sans-serif;
           font-size: 14px; color: #17212B; word-break: break-word; }
    img { max-width: 100%; height: auto; }
    table { max-width: 100%; }
  </style>`;
  return { html: head + out, blocked, mouchards };
}

/**
 * Afficher les images sans redemander (20/08) — « ce serait pas mal de charger
 * les images aussi si moins de 300 k, c'est rapide ».
 *
 * Le seuil de poids ne peut PAS servir de filtre : on ne connaît la taille
 * d'une image qu'après l'avoir téléchargée, et c'est justement ce
 * téléchargement qui signale la lecture à l'expéditeur. Pire, le pixel espion
 * pèse moins d'un kilo-octet : « charger en dessous de 300 Ko » chargerait
 * donc TOUS les traceurs et n'écarterait que les grandes photos — l'inverse de
 * ce qu'il veut voir.
 *
 * Mesuré sur 18 de ses mails HTML : 17 portent des images distantes (jusqu'à
 * 56 dans un seul), aucun n'a d'image embarquée. Le vrai besoin est donc :
 * « arrête de me faire cliquer ». C'est son choix à faire une fois, pas une
 * heuristique à deviner mail par mail.
 */
function imagesAuto() {
  try { return localStorage.getItem('reader-images-auto') === '1'; } catch { return false; }
}
function setImagesAuto(on) {
  try { localStorage.setItem('reader-images-auto', on ? '1' : '0'); } catch { /* navigation privée */ }
}

function renderReaderHtml(el, body, relocatedNote, item) {
  // Table Content-ID → URL inline (les pièces jointes du mail, même ordre que
  // l'endpoint /attachments/:index).
  const cidMap = new Map();
  (body.attachments ?? []).forEach((a, i) => {
    if (a.contentId) cidMap.set(a.contentId, api.attachmentInlineUrl(item.account, item.folder, item.uid, i));
  });
  const draw = (withImages) => {
    const { html, blocked, mouchards } = sanitizeMailHtml(body.html, withImages, cidMap);
    el.classList.add('html-mode');
    el.innerHTML = `
      ${relocatedNote ? `<div class="notice" style="margin:10px 14px 0">${esc(relocatedNote)}</div>` : ''}
      ${blocked ? `<div class="html-imgbar">🖼️ ${fmtNum(blocked)} image(s) bloquée(s) — les afficher peut signaler ta lecture à l'expéditeur.
        <button class="btn btn-sm" id="reader-show-images">Afficher les images</button>
        <button class="btn btn-sm" id="reader-always-images"
          title="Les images s'afficheront directement dans tous tes mails, sauf les mouchards. Réversible dans Réglages › Images des mails.">Toujours les afficher</button></div>` : ''}
      ${mouchards ? `<div class="html-shieldbar" title="Ces images d'un pixel ne servent qu'à prévenir l'expéditeur que tu as ouvert son mail. Le reste du mail s'affiche entier.">🛡️ ${fmtNum(mouchards)} mouchard${mouchards > 1 ? 's' : ''} retiré${mouchards > 1 ? 's' : ''}</div>` : ''}
      ${body.htmlTruncated ? '<div class="notice warn" style="margin:8px 14px">✂️ Mail très lourd : seul le début est affiché.</div>' : ''}
      ${'' /* allow-popups-to-escape-sandbox : sans lui, un lien du mail ouvre
            un onglet SANDBOXÉ (page blanche) — les liens semblaient perdus. */}
      <iframe class="reader-frame" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" title="Contenu du mail"></iframe>`;
    el.querySelector('.reader-frame').setAttribute('srcdoc', html);
    $('#reader-show-images')?.addEventListener('click', () => draw(true));
    $('#reader-always-images')?.addEventListener('click', () => {
      setImagesAuto(true);
      draw(true);
    });
  };
  // Son réglage d'abord : s'il a dit « toujours », on ne le redemande plus.
  draw(imagesAuto());
}

// ------------------------------------------- Redimensionnement du lecteur
// Poignée sur le bord gauche du panneau : glisser pour élargir/réduire, la
// taille est MÉMORISÉE (localStorage) — en pixels pour le panneau superposé,
// en % de la zone pour la colonne ancrée de la Boîte de réception.
function applyStoredReaderSize(panel, layout) {
  try {
    if (layout) {
      const pct = Number(localStorage.getItem('reader-col-pct'));
      if (pct >= 25 && pct <= 75) {
        layout.style.gridTemplateColumns = `minmax(0, 1fr) minmax(420px, ${pct}%)`;
      }
    } else {
      const px = Number(localStorage.getItem('reader-width-px'));
      if (px >= 480) panel.style.width = `${Math.min(px, Math.round(window.innerWidth * 0.95))}px`;
    }
  } catch { /* navigation privée */ }
}

function installReaderResize(panel, dock) {
  const layout = dock ? dock.closest('.inbox-layout') : null;
  applyStoredReaderSize(panel, layout);
  const handle = document.createElement('div');
  handle.className = 'reader-resize';
  handle.title = 'Glisser pour élargir ou réduire la lecture';
  panel.appendChild(handle);
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    // L'iframe avalerait les mouvements de souris pendant le glisser.
    const frame = panel.querySelector('.reader-frame');
    if (frame) frame.style.pointerEvents = 'none';
    const move = (ev) => {
      if (layout) {
        const r = layout.getBoundingClientRect();
        const pct = Math.min(75, Math.max(25, ((r.right - ev.clientX) / r.width) * 100));
        layout.style.gridTemplateColumns = `minmax(0, 1fr) minmax(420px, ${pct}%)`;
        layout.dataset.readerPct = String(Math.round(pct));
      } else {
        const w = Math.min(Math.round(window.innerWidth * 0.95), Math.max(480, Math.round(window.innerWidth - ev.clientX)));
        panel.style.width = `${w}px`;
      }
    };
    const up = () => {
      if (frame) frame.style.pointerEvents = '';
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      try {
        if (layout && layout.dataset.readerPct) localStorage.setItem('reader-col-pct', layout.dataset.readerPct);
        else if (!layout) localStorage.setItem('reader-width-px', String(Number.parseInt(panel.style.width, 10) || 0));
      } catch { /* navigation privée */ }
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
}

// Cache CLIENT des corps lus (LRU 20) : rouvrir un mail est instantané — le
// serveur a le même cache, mais éviter l'aller-retour réseau compte aussi.
const readBodyCache = new Map();
/**
 * PILE DE LECTURE (18/08). `openReader` commence par `closeReader()` : le mail
 * en cours était donc DÉTRUIT dès qu'on en ouvrait un autre depuis son
 * contexte, sans aucun retour possible (« plus de possibilité de revenir en
 * arrière sur le mail principal »).
 *
 * Cette pile n'est alimentée QUE par le geste explicite « Ouvrir ce mail ↗ » :
 * dans le parcours normal, l'historique se déplie sur place et il n'y a rien
 * dont il faille revenir. Le bouton de retour NOMME sa destination — « ← URSSAF »
 * et non « ← Retour » — pour qu'il sache toujours vers quoi il remonte.
 */
let _pileLecture = [];

/**
 * Lecture agrandie (19/08) — état de SÉANCE, jamais mémorisé sur le disque.
 *
 * La largeur réglée à la poignée est une préférence durable ; « agrandir » est
 * une façon de lire ce mail-ci, maintenant. Elle suit donc la séance de lecture
 * (mail suivant, mail empilé, retour au précédent) mais retombe dès qu'il ferme
 * vraiment — sinon il rouvrirait un jour la Recherche en se demandant pourquoi
 * sa liste a disparu.
 */
let _lectureAgrandie = false;

/**
 * PRÉCÉDENT / SUIVANT (25/08) — « ajoute précédent/suivant dans la liste ».
 *
 * Deux règles qui font toute la différence :
 *
 *  1. « Suivant » n'est JAMAIS le mail chronologiquement suivant de la base :
 *     c'est le voisin dans la série d'où l'on a ouvert le lecteur — les cartes
 *     de la Vue du jour, les résultats de la Recherche, les lignes d'un
 *     dossier. La série est FIGÉE à l'ouverture et ne se recalcule jamais :
 *     marquer un mail réglé ne doit pas le faire disparaître sous les doigts
 *     ni renuméroter le « 2 / 3 ».
 *
 *  2. Elle est suspendue dans une branche de contexte (quand on a ouvert un
 *     mail lié depuis « Contexte ») : il y a alors déjà un « ← retour », et
 *     deux notions concurrentes de « précédent » seraient illisibles.
 */
function barreSerie(serie, dansUneBranche) {
  if (dansUneBranche || !serie || !Array.isArray(serie.refs) || serie.refs.length < 2) return '';
  const i = serie.index ?? 0;
  return `<div class="reader-serie">
    <button class="btn btn-sm" id="reader-prev" ${i <= 0 ? 'disabled' : ''}
      title="Mail précédent de la liste d'où tu viens">‹ Précédent</button>
    <span class="muted">${fmtNum(i + 1)} / ${fmtNum(serie.refs.length)}</span>
    <button class="btn btn-sm" id="reader-next" ${i >= serie.refs.length - 1 ? 'disabled' : ''}
      title="Mail suivant de la liste d'où tu viens">Suivant ›</button>
  </div>`;
}

/** Passe le lecteur en grand (ou l'en fait revenir) sans RIEN reconstruire. */
function basculerAgrandissement(panel, force) {
  const grand = force ?? !panel.classList.contains('is-expanded');
  _lectureAgrandie = grand;
  // Une simple classe : recréer le corps ou l'iframe renverrait Anthony en haut
  // du mail alors qu'il en lisait le milieu.
  panel.classList.toggle('is-expanded', grand);
  const btn = panel.querySelector('#reader-expand');
  if (btn) {
    // Pictogrammes VÉRIFIÉS au rendu : ⛶ (U+26F6), le symbole habituel du
    // plein écran, s'affiche en carré vide à la taille d'un petit bouton sur
    // Windows. La paire ↗️/↙️ rend en couleur et se distingue d'un coup d'œil.
    btn.textContent = grand ? '↙️ Réduire' : '↗️ Agrandir';
    const t = grand ? 'Réduire la lecture' : 'Agrandir la lecture';
    btn.title = t;
    btn.setAttribute('aria-label', t);
  }
  // Le voile n'a plus lieu d'être quand le lecteur couvre tout l'écran.
  document.querySelector('.reader-overlay')?.classList.toggle('hidden', grand);
}

/**
 * OUVRIR UN MAIL LE MARQUE COMME LU — immédiatement, sans attendre une sync.
 *
 * Son retour du 26/08, capture à l'appui : un mail qu'il venait de lire
 * portait encore « non lu ». L'index ne l'apprenait qu'à la synchronisation
 * suivante. Sa réponse : « le statut des mails est super important, je ne peux
 * pas attendre une synchro pour avoir une info qui est fausse ».
 *
 * ⚠️ CE N'EST PAS DANS `readMessageCached` À DESSEIN. Cette fonction sert
 * aussi au PRÉCHARGEMENT du message suivant (Précédent/Suivant) : y mettre le
 * marquage ferait passer « lu » des mails qu'il n'a jamais ouverts. Le
 * marquage vit donc aux points d'ouverture RÉELLE, et nulle part ailleurs.
 *
 * Rien n'est marqué localement tant que le serveur n'a pas confirmé : un échec
 * IMAP silencieux qui laisserait l'écran dire « lu » serait exactement le
 * mensonge qu'on corrige ici.
 */
/**
 * QUELLE LIGNE VIENT D'ÊTRE OUVERTE — repéré en un seul point, pour tous les
 * écrans. Chacun câble ses ouvertures à sa façon (`bindOpenables`, un
 * gestionnaire local, `data-clean-open`…), et pister la ligne dans chacun
 * d'eux serait à refaire à chaque nouvel écran. Un écouteur en CAPTURE sur le
 * document voit tous les clics avant eux, sans rien intercepter.
 */
document.addEventListener(
  'click',
  (e) => {
    const cible = e.target instanceof Element
      ? e.target.closest('.openable, [data-open], [data-clean-open]')
      : null;
    if (!cible) return;
    document.querySelectorAll('.vient-d-ouvrir').forEach((x) => x.classList.remove('vient-d-ouvrir'));
    (cible.closest('.reply-row, .mail-row, .todo-row, .find-msg, tr, li') || cible.parentElement)
      ?.classList.add('vient-d-ouvrir');
  },
  true,
);

const _marquageEnCours = new Set();
async function marquerLu(account, folder, uid, item) {
  if (!account || !folder || !uid) return;
  if (item && item.isSeen) return;
  const cle = `${account}|${folder}|${uid}`;
  if (_marquageEnCours.has(cle)) return;
  _marquageEnCours.add(cle);
  try {
    await api.messageAction(account, { folder, uid, action: 'seen' });
    // L'objet en mémoire suit : sans ça, le prochain rendu de la liste
    // réafficherait « non lu » à partir des données déjà chargées.
    if (item) item.isSeen = true;
    // ⚠️ PAS DE SÉLECTEUR PAR data-uid : chaque écran a sa convention
    // (`data-open` sur les réponses attendues, `data-clean-open` ailleurs,
    // une case à cocher dans la modale de nettoyage). Un sélecteur unique
    // visait un attribut qui n'existe nulle part et ne retirait aucun badge.
    // On nettoie donc ce qu'on sait situer : le lecteur ouvert, et la ligne
    // marquée courante par la liste elle-même.
    document
      .querySelectorAll('.reader .badge, .inbox-dock .badge, .vient-d-ouvrir .badge')
      .forEach((b) => {
        if (b.textContent.trim() === 'non lu') b.remove();
      });
  } catch {
    // Silencieux : l'écran garde « non lu », ce qui reste vrai côté serveur.
  } finally {
    _marquageEnCours.delete(cle);
  }
}

async function readMessageCached(account, folder, uid) {
  const key = `${account}|${folder}|${uid}`;
  const hit = readBodyCache.get(key);
  if (hit) {
    readBodyCache.delete(key);
    readBodyCache.set(key, hit);
    return hit;
  }
  const body = await api.readMessage(account, folder, uid);
  readBodyCache.set(key, body);
  if (readBodyCache.size > 20) readBodyCache.delete(readBodyCache.keys().next().value);
  return body;
}

function closeReader() {
  document.querySelector('.reader-overlay')?.remove();
  document.querySelector('.reader')?.remove();
  // Lecture ancrée (Boîte de réception) : on referme aussi la colonne.
  document.querySelectorAll('.inbox-dock').forEach((d) => { d.classList.add('hidden'); d.replaceChildren(); });
  // TOUTES les colonnes, pas seulement la première : depuis le 20/08 la Vue du
  // jour et la Recherche en ont une elles aussi, et une page pourrait en
  // porter plusieurs — n'en refermer qu'une laisserait un écran de travers.
  document.querySelectorAll('.inbox-layout').forEach((layout) => {
    layout.classList.remove('with-reader');
    layout.style.gridTemplateColumns = ''; // la largeur choisie revit à la prochaine ouverture
  });
  document.querySelector('.result-row.selected')?.classList.remove('selected');
}

async function openReader(item, row, opts = {}) {
  // Par défaut : comportement de l'écran Recherche (rafraîchit ses résultats).
  const onSeen = opts.onSeen ?? (() => renderSearchResults());
  const onRemoved = opts.onRemoved ?? (() => removeItemFromResults(item));
  closeReader();
  row?.classList.add('selected');

  // Lecture ANCRÉE (revue UI §9) : sur la Boîte de réception, le mail s'ouvre
  // dans une colonne à droite de la liste au lieu de la recouvrir. Sur petit
  // écran (ou hors inbox), on garde le panneau superposé.
  const dock = opts.dock && opts.dock.isConnected && window.innerWidth > 1100 ? opts.dock : null;
  const overlay = document.createElement('div');
  overlay.className = 'reader-overlay';
  overlay.addEventListener('click', () => {
    _lectureAgrandie = false;
    closeReader();
  });
  const panel = document.createElement('div');
  panel.className = dock ? 'reader docked' : 'reader';
  panel.innerHTML = `
    <div class="reader-head">
      ${_pileLecture.length ? `<button class="btn btn-sm reader-back"
        title="Revenir au mail que tu étais en train de traiter">←&nbsp;${esc(
          (_pileLecture[_pileLecture.length - 1].label || 'mail précédent').slice(0, 34))}</button>` : ''}
      <h2>${esc(item.subject)}</h2>
      ${barreSerie(opts.serie, _pileLecture.length > 0)}
      <div class="reader-head-actions">
        <button class="btn btn-sm" id="reader-expand"
          title="Agrandir la lecture" aria-label="Agrandir la lecture">↗️ Agrandir</button>
        <button class="modal-close" title="Fermer">✕</button>
      </div>
    </div>
    <!-- L'EN-TÊTE TIENT SUR UNE LIGNE (25/08) : qui écrit, quand, dans quelle
         boîte. Le reste — l'adresse complète, le dossier, les destinataires —
         part derrière « Détails ». Le dossier d'un mail n'a aucune raison de
         prendre de la hauteur à chaque lecture. -->
    <div class="reader-meta">
      <div class="reader-meta-line">
        <strong>${esc(item.fromName || item.fromEmail)}</strong>
        <span class="muted">${fmtDateTime(item.date)} · ${esc(item.account)}</span>
        ${item.isSeen ? '' : '<span class="badge orange">non lu</span>'}
        <button class="btn btn-sm reader-details-btn" id="reader-details-btn"
          aria-expanded="false" title="Adresse complète, destinataires, dossier">Détails</button>
      </div>
      <div class="reader-details hidden" id="reader-details">
        <div><span class="muted">De :</span> ${esc(item.fromEmail)}</div>
        <div id="reader-to"></div>
        <div><span class="muted">Boîte :</span> ${esc(item.account)} · <span class="muted">dossier</span> ${esc(item.folder)}</div>
        <div><span class="muted">Reçu le</span> ${fmtDateTime(item.date)}</div>
      </div>
    </div>
    <div class="reader-body" id="reader-body"><div class="empty"><span class="spinner"></span>
      Téléchargement du mail depuis la boîte…</div></div>
    <div class="reader-attachments hidden" id="reader-attachments"></div>
    <div class="reader-analysis hidden" id="reader-analysis"></div>
    <!-- CE QU'ON ATTEND DE LUI, en tête (20/08) — « la liste des boutons
         devrait être dynamique en fonction de son contenu ». Rempli par
         l'analyse (renderReaderActions) ; vide tant qu'elle n'a rien dit. -->
    <div class="reader-todo hidden" id="reader-todo"></div>
    <div class="reader-actions" id="reader-actions">
      <span class="reader-actions-lead" id="reader-lead"></span>
      <button class="btn btn-sm" id="reader-all-actions" aria-expanded="false"
        title="Toutes les commandes disponibles sur ce mail">Toutes les actions ▾</button>
      <div class="reader-actions-menu hidden" id="reader-menu">
      ${smtpEnabled ? `<button class="btn btn-sm btn-primary" id="reader-reply" title="Répondre à l'expéditeur">↩️ Répondre</button>
      <button class="btn btn-sm" id="reader-forward" title="Transférer ce mail à quelqu'un d'autre">➡️ Transférer</button>` : ''}
      <button class="btn btn-sm" id="reader-task" title="Créer une tâche liée à ce mail">☑️ Tâche</button>
      <button class="btn btn-sm" id="reader-accounting" title="Transmet la facture de ce mail à Fiscal Manager (écran « Pièces reçues ») — sans attendre la détection automatique">🧾 Comptabilité</button>
      <button class="btn btn-sm" id="reader-rentila" title="Préparer une commande Rentila depuis ce mail (pointer un loyer payé, créer une tâche côté Rentila) — tu valides, Claude l'exécute">🏠 Rentila…</button>
      <button class="btn btn-sm" id="reader-flag" title="Les mails suivis se retrouvent dans « ⭐ Mails suivis »">${item.isFlagged ? '⭐ Suivi' : '☆ Suivre'}</button>
      <button class="btn btn-sm" id="reader-toggle-seen" title="Change l'état lu/non lu de ce mail (aussi côté Microsoft)">${item.isSeen ? 'Marquer non lu' : 'Marquer lu'}</button>
      <select id="reader-move" title="Déplace ce mail vers un autre dossier de la même boîte"><option value="">📦 Déplacer vers…</option></select>
      <button class="btn btn-sm" id="reader-delete" style="color:var(--red)" title="Met ce mail à la corbeille — récupérable ~30 jours, rien n'est effacé définitivement">🗑️ Corbeille</button>
      <span class="muted" style="font-size:11.5px; margin-left:auto">soft delete — récupérable ~30 j</span>
      </div>
    </div>`;
  if (dock) {
    dock.replaceChildren(panel);
    dock.classList.remove('hidden');
    dock.closest('.inbox-layout')?.classList.add('with-reader');
    // La colonne se cale en haut de l'écran (20/08). Mesuré sur la Recherche :
    // sans ça, elle démarre sous l'en-tête de l'écran, sa hauteur d'une pleine
    // fenêtre la fait déborder, et la barre d'actions tombe 222 px SOUS le bord
    // — invisible sans défiler. Le dock est déjà « sticky » : il suffit de
    // l'amener à sa position collée.
    const zone = dock.closest('.inbox-layout') ?? dock;
    const y = window.scrollY + zone.getBoundingClientRect().top - 12;
    if (y > 1) window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
  } else {
    document.body.appendChild(overlay);
    document.body.appendChild(panel);
  }
  installReaderResize(panel, dock);
  // La lecture reprend dans l'état où il l'avait mise : rouvrir chaque mail en
  // petit après avoir demandé du grand serait un réglage à refaire sans cesse.
  if (_lectureAgrandie) basculerAgrandissement(panel, true);
  panel.querySelector('#reader-expand').addEventListener('click', () => basculerAgrandissement(panel));
  // « Toutes les actions » : tout ce qui existait reste là, à un endroit STABLE.
  // La barre du dessus change avec le mail, ce menu jamais — c'est lui qui fait
  // qu'on ne perd pas une commande parce que l'analyse ne l'a pas proposée.
  // Naviguer dans la série : on rouvre le voisin en gardant la MÊME série,
  // seul l'index bouge. La position dans la liste ne se recalcule jamais.
  const allerA = (n) => {
    const s = opts.serie;
    if (!s?.refs?.[n]) return;
    openReader(s.refs[n], null, { ...opts, serie: { refs: s.refs, index: n } });
  };
  panel.querySelector('#reader-prev')?.addEventListener('click', () => allerA((opts.serie?.index ?? 0) - 1));
  panel.querySelector('#reader-next')?.addEventListener('click', () => allerA((opts.serie?.index ?? 0) + 1));

  panel.querySelector('#reader-details-btn')?.addEventListener('click', (e) => {
    const d = panel.querySelector('#reader-details');
    const ferme = d.classList.toggle('hidden');
    e.currentTarget.setAttribute('aria-expanded', String(!ferme));
  });
  panel.querySelector('#reader-all-actions')?.addEventListener('click', (e) => {
    const m = panel.querySelector('#reader-menu');
    const ouvert = m.classList.toggle('hidden');
    e.currentTarget.setAttribute('aria-expanded', String(!ouvert));
    e.currentTarget.textContent = ouvert ? 'Toutes les actions ▾' : 'Toutes les actions ▴';
  });
  // Fermer VIDE la pile : on quitte la lecture, il n'y a plus de « retour ».
  panel.querySelector('.modal-close').addEventListener('click', () => {
    _pileLecture = [];
    _lectureAgrandie = false;
    closeReader();
  });
  // Retour au mail d'où l'on vient, avec son propre contexte de rappel.
  panel.querySelector('.reader-back')?.addEventListener('click', () => {
    const precedent = _pileLecture.pop();
    if (!precedent) { closeReader(); return; }
    openReader(precedent.item, null, precedent.opts ?? {});
  });
  $('#reader-flag')?.addEventListener('click', async () => {
    const btn = $('#reader-flag');
    btn.disabled = true;
    try {
      await api.messageAction(item.account, {
        folder: item.folder,
        uid: item.uid,
        action: item.isFlagged ? 'unflag' : 'flag',
      });
      item.isFlagged = !item.isFlagged;
      btn.textContent = item.isFlagged ? '⭐ Suivi' : '☆ Suivre';
      refreshFlaggedBadge();
    } catch (err) {
      alert(err.message);
    }
    btn.disabled = false;
  });
  // (La touche Échap est traitée par l'unique gestionnaire global posé au
  // démarrage : celui qui vivait ici faisait doublon — et comme il n'était
  // retiré que s'il gérait lui-même l'appui, il s'en accumulait un par mail
  // ouvert. Le gestionnaire global s'exécutait de toute façon en premier,
  // ayant été enregistré avant : il gagnait toujours.)

  // Analyse heuristique du mail (L5.4) : importance, état du fil, échéances
  // trouvées dans le texte affiché. Local, sans IMAP supplémentaire, sans LLM.
  const loadAnalysis = (text) => {
    api.analyzeMessage(item.account, { folder: item.folder, uid: item.uid, text })
      .then((a) => {
        renderReaderAnalysis(a, item, opts);
        renderReaderActions(a.actions, item, opts);
      })
      .catch(() => {});
  };

  // Corps du mail : lecture IMAP live. En cas d'échec (boîte injoignable),
  // on l'explique proprement — les actions restent disponibles.
  let loadedText = ''; // corps téléchargé, pour la citation dans une réponse
  // Il l'ouvre : il l'a lu. Sans attendre la sync (cf. marquerLu).
  marquerLu(item.account, item.folder, item.uid, item);
  readMessageCached(item.account, item.folder, item.uid).then((body) => {
    const el = $('#reader-body');
    if (!el) return;
    // Auto-réparation serveur : le mail avait bougé, il a été retrouvé par son
    // identifiant dans un autre dossier — on suit, pour que les actions
    // (déplacer, corbeille, pièces jointes) visent le BON emplacement.
    let relocatedNote = '';
    if (body.relocated && body.folder) {
      item.folder = body.folder;
      item.uid = body.uid;
      relocatedNote = `📦 Ce mail avait changé de place — retrouvé dans « ${body.folder} ». L'index est recalé.`;
    }
    loadedText = body.text || '';
    if (body.html) {
      // Rendu FIDÈLE (mise en page + images) — retour utilisateur 02/08 : le
      // texte extrait d'une newsletter laissait des trous partout.
      renderReaderHtml(el, body, relocatedNote, item);
    } else {
      el.classList.remove('html-mode');
      el.replaceChildren();
      if (relocatedNote) {
        const note = document.createElement('div');
        note.className = 'notice';
        note.style.marginBottom = '10px';
        note.textContent = relocatedNote;
        el.appendChild(note);
      }
      // Les mails texte gardent leur rendu brut (lignes vides compactées),
      // mais leurs URLs deviennent de VRAIS liens — comme dans la boîte mail.
      const brut = (body.text || '(mail sans contenu texte)').replace(/\n{3,}/g, '\n\n');
      const zone = document.createElement('div');
      // Nommée pour que la lecture agrandie puisse la centrer et lui garder
      // une largeur de lecture confortable (voir .reader.is-expanded).
      zone.className = 'mail-text';
      zone.innerHTML = esc(brut).replace(
        /(https?:\/\/[^\s<>"«»]+?)([.,;:!?)\]]*)(?=\s|$)/g,
        '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>$2',
      );
      el.appendChild(zone);
      if (body.truncated) {
        const note = document.createElement('div');
        note.className = 'notice warn';
        note.style.marginTop = '14px';
        note.textContent = '✂️ Mail très long : seul le début est affiché ici. L\'original complet reste dans ta boîte.';
        el.appendChild(note);
      }
    }
    if (body.to) {
      const to = $('#reader-to');
      if (to) to.innerHTML = `<span class="muted">À :</span> ${esc(body.to)}`;
    }
    if (body.attachments?.length) {
      const az = $('#reader-attachments');
      if (az) {
        az.classList.remove('hidden');
        renderReaderAttachments(az, item, body.attachments);
      }
    }
    // Ouvrir un mail non lu le marque lu côté serveur (comportement IMAP
    // standard du download) : on met l'affichage en cohérence.
    if (!item.isSeen) setSeen(true);
    loadAnalysis(loadedText);
  }).catch((err) => {
    const el = $('#reader-body');
    if (!el) return;
    el.innerHTML = `<div class="notice warn">⚠️ ${esc(err.message)}</div>
      <div class="muted" style="font-size:12.5px">Le contenu n'a pas pu être téléchargé (boîte
      injoignable ou mail déplacé). Les infos ci-dessus viennent des mails synchronisés.
      Si le mail existe toujours dans Outlook, une <a href="#/account/${esc(item.account)}">synchronisation
      de la boîte</a> remettra tout d'aplomb.</div>`;
    loadAnalysis(''); // l'analyse marche quand même (index + sujet)
  });

  // Liste des dossiers du compte pour l'action « Déplacer ».
  api.folders(item.account).then(({ folders }) => {
    const sel = $('#reader-move');
    if (!sel) return;
    for (const f of folders) {
      if (f.path === item.folder) continue;
      const opt = document.createElement('option');
      opt.value = f.path;
      opt.textContent = f.path;
      sel.appendChild(opt);
    }
  }).catch(() => {});

  // Répercute lu/non-lu sur l'item partagé + le bouton + l'écran appelant.
  const setSeen = (seen) => {
    item.isSeen = seen;
    const btn = $('#reader-toggle-seen');
    if (btn) btn.textContent = seen ? 'Marquer non lu' : 'Marquer lu';
    onSeen(item, seen);
  };

  // Renvoie la réponse du serveur (elle porte de quoi annuler une corbeille),
  // ou null en cas d'échec. doAction garde la forme booléenne historique.
  const doActionResult = async (btn, action, destination) => {
    btn.disabled = true;
    try {
      return await api.messageAction(item.account, { folder: item.folder, uid: item.uid, action, destination });
    } catch (err) {
      alert(err.message);
      btn.disabled = false;
      return null;
    }
  };
  const doAction = async (btn, action, destination) => !!(await doActionResult(btn, action, destination));

  $('#reader-toggle-seen').addEventListener('click', async (e) => {
    const toSeen = !item.isSeen;
    if (await doAction(e.target, toSeen ? 'seen' : 'unseen')) {
      setSeen(toSeen);
      e.target.disabled = false;
    }
  });

  $('#reader-move').addEventListener('change', async (e) => {
    const destination = e.target.value;
    if (!destination) return;
    if (!confirm(`Déplacer ce mail vers « ${destination} » ?`)) {
      e.target.value = '';
      return;
    }
    if (await doAction(e.target, 'move', destination)) {
      // Refermer AVANT de prévenir l'écran appelant : dans le dépouillement,
      // onRemoved avance au mail suivant et ouvre SON aperçu — le refermer
      // après coup laissait la carte suivante sans lecture (bug 06/08).
      closeReader();
      onRemoved(item, 'move');
    }
  });

  // Suppression AU PREMIER CLIC (retour utilisateur 10/08 : « j'en ai marre
  // de cliquer 2 fois pour supprimer »). Le garde-fou n'est plus une question
  // posée avant, mais un bandeau « Annuler » de 10 s après : le mail est
  // seulement déplacé en corbeille, et le bandeau le ramène vraiment.
  $('#reader-delete').addEventListener('click', async (e) => {
    const res = await doActionResult(e.target, 'delete');
    if (!res) return;
    closeReader(); // même ordre que « Déplacer » : refermer puis avancer
    onRemoved(item, 'delete');
    offerUndoDelete(item.account, res.undo, 1);
  });

  // Répondre / transférer (L5.3) — pré-remplit la modale de composition.
  const quoted = () =>
    loadedText
      ? loadedText.split('\n').map((l) => `> ${l}`).join('\n')
      : '> (contenu non téléchargé)';
  $('#reader-reply')?.addEventListener('click', () => {
    openComposeModal({
      account: item.account,
      to: item.fromEmail,
      subject: /^re\s*:/i.test(item.subject) ? item.subject : `Re: ${item.subject}`,
      text: `\n\nLe ${fmtDateTime(item.date)}, ${item.fromName || item.fromEmail} a écrit :\n${quoted()}`,
      replyRef: { folder: item.folder, uid: item.uid, mode: 'reply' },
      onSent: opts.onReplied ?? null,
    });
  });
  $('#reader-task')?.addEventListener('click', () => {
    openTaskModal({
      title: item.subject,
      account: item.account,
      messageRef: { folder: item.folder, uid: item.uid },
    });
  });
  // « → Comptabilité » : la file dédiée reste le chemin normal, mais on doit
  // pouvoir envoyer une facture depuis le mail qu'on a sous les yeux
  // (demande 10/08). Idempotent : renvoyer deux fois ne double rien.
  $('#reader-accounting')?.addEventListener('click', async (e) => {
    const btn = e.target;
    btn.disabled = true;
    const before = btn.textContent;
    btn.textContent = '⏳ Envoi…';
    try {
      const r = await api.messageToAccounting(item.account, { folder: item.folder, uid: item.uid });
      btn.textContent = r.already ? '✅ Déjà transmis' : '✅ Transmis';
      showUndoToast(
        r.already
          ? 'Cette facture était déjà dans les pièces à traiter de Fiscal Manager.'
          : `Facture transmise (${r.attachments} fichier(s)) — elle arrivera dans « Pièces reçues » au prochain Actualiser.`,
        null,
      );
    } catch (err) {
      btn.textContent = before;
      btn.disabled = false;
      alert(err.message);
    }
  });
  $('#reader-rentila')?.addEventListener('click', () => openRentilaCommandModal(item, loadedText));
  $('#reader-forward')?.addEventListener('click', () => {
    openComposeModal({
      account: item.account,
      to: '',
      subject: /^(fwd?|tr)\s*:/i.test(item.subject) ? item.subject : `Fwd: ${item.subject}`,
      text: `\n\n---------- Mail transféré ----------\nDe : ${item.fromName || ''} <${item.fromEmail}>\nDate : ${fmtDateTime(item.date)}\nObjet : ${item.subject}\n\n${loadedText || '(contenu non téléchargé)'}`,
      replyRef: { folder: item.folder, uid: item.uid, mode: 'forward' },
    });
  });
}

// ------------------------------------------------ Composer un mail (L5.3)
// Pièces jointes + images en ligne (demande utilisateur 05/08) : le corps est
// une zone éditable (pre-wrap) — on peut y coller une capture (Ctrl+V) ou
// insérer une image au fil du texte ; les fichiers joints s'ajoutent en
// vignettes sous le texte. Limites alignées sur le serveur : 10 fichiers,
// 10 Mo par pièce, 15 Mo au total (images en ligne comprises).
function openComposeModal({ account, to = '', cc = '', subject = '', text = '', replyRef = null, onSent = null }) {
  closeModal();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal" style="width:640px">
    <div class="modal-head"><h2>✉️ ${replyRef?.mode === 'reply' ? 'Répondre' : replyRef?.mode === 'forward' ? 'Transférer' : 'Nouveau mail'}
      <span class="muted" style="font-size:12.5px; font-weight:400">depuis ${esc(account)}</span></h2>
      <button class="modal-close" title="Fermer">✕</button></div>
    <div class="modal-body">
      <div class="compose-grid">
        <label>À</label><input type="text" id="c-to" placeholder="adresse@exemple.fr (plusieurs : séparer par des virgules)" value="${esc(to)}">
        <label>Cc</label><input type="text" id="c-cc" placeholder="optionnel" value="${esc(cc)}">
        <label>Objet</label><input type="text" id="c-subject" value="${esc(subject)}">
      </div>
      <div id="c-text" class="compose-editor" contenteditable="true"></div>
      <div class="compose-tools">
        <button class="btn btn-sm" id="c-attach" title="Le fichier part en pièce jointe du mail">📎 Joindre des fichiers</button>
        <button class="btn btn-sm" id="c-image" title="L'image s'insère dans le texte, à l'endroit du curseur">🖼️ Insérer une image</button>
        <span class="muted" style="font-size:12px">ou colle une capture dans le texte (Ctrl+V)</span>
        <input type="file" id="c-attach-input" multiple hidden>
        <input type="file" id="c-image-input" accept="image/*" multiple hidden>
      </div>
      <div class="compose-atts" id="c-atts"></div>
      <div id="c-error"></div>
      <div class="trash-note" style="margin-top:10px">🛟 Rien ne part sans ton clic : l'envoi demande une
        confirmation, est journalisé (destinataires + objet), et une copie est déposée dans
        « Éléments envoyés ».</div>
    </div>
    <div class="modal-foot">
      <button class="btn" id="c-cancel">Annuler</button>
      <button class="btn btn-primary" id="c-send">✉️ Envoyer</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('.modal-close').addEventListener('click', closeModal);
  $('#c-cancel').addEventListener('click', closeModal);
  const editor = $('#c-text');
  editor.textContent = text; // pre-wrap : les retours à la ligne s'affichent tels quels
  // Réponse : curseur en haut, au-dessus de la citation.
  editor.focus();
  const initRange = document.createRange();
  initRange.setStart(editor.firstChild ?? editor, 0);
  initRange.collapse(true);
  const initSel = window.getSelection();
  initSel.removeAllRanges();
  initSel.addRange(initRange);

  // --- Pièces jointes (fichiers) --------------------------------------------
  const MAX_FILES = 10;
  const MAX_FILE_BYTES = 10 * 1024 * 1024;
  const MAX_TOTAL_BYTES = 15 * 1024 * 1024;
  const atts = []; // { name, type, size, dataBase64 }
  const fmtSize = (b) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} Mo` : `${Math.max(1, Math.round(b / 1024))} Ko`);
  const showErr = (msg) => {
    $('#c-error').innerHTML = `<div class="notice warn" style="margin-top:10px">${esc(msg)}</div>`;
  };
  // Poids déjà engagé : fichiers joints + images en ligne (base64 ≈ ×4/3).
  const inlineBytes = () =>
    [...editor.querySelectorAll('img')].reduce((sum, img) => {
      const m = /^data:[^;]*;base64,(.*)$/.exec(img.getAttribute('src') || '');
      return sum + (m ? Math.floor(m[1].length * 0.75) : 0);
    }, 0);
  const totalBytes = () => atts.reduce((s, a) => s + a.size, 0) + inlineBytes();
  const renderAtts = () => {
    $('#c-atts').innerHTML = atts.map((a, i) =>
      `<span class="att-chip">📎 ${esc(a.name)} <span class="muted">${fmtSize(a.size)}</span>
        <button data-rm="${i}" title="Retirer cette pièce jointe">✕</button></span>`).join('');
    $('#c-atts').querySelectorAll('[data-rm]').forEach((b) =>
      b.addEventListener('click', () => { atts.splice(Number(b.dataset.rm), 1); renderAtts(); }));
  };
  const readAsDataUrl = (file) => new Promise((resolveRead, rejectRead) => {
    const r = new FileReader();
    r.onload = () => resolveRead(r.result);
    r.onerror = () => rejectRead(new Error(`Lecture impossible : ${file.name}`));
    r.readAsDataURL(file);
  });
  const addFiles = async (files) => {
    $('#c-error').innerHTML = '';
    for (const f of files) {
      if (atts.length >= MAX_FILES) { showErr(`10 pièces jointes maximum — « ${f.name} » non ajoutée.`); break; }
      if (f.size > MAX_FILE_BYTES) { showErr(`« ${f.name} » dépasse 10 Mo — envoie-la plutôt via un lien de partage.`); continue; }
      if (totalBytes() + f.size > MAX_TOTAL_BYTES) { showErr(`15 Mo maximum au total — « ${f.name} » non ajoutée.`); break; }
      const dataUrl = await readAsDataUrl(f);
      atts.push({ name: f.name, type: f.type || 'application/octet-stream', size: f.size,
        dataBase64: String(dataUrl).split(',')[1] ?? '' });
    }
    renderAtts();
  };
  $('#c-attach').addEventListener('click', () => $('#c-attach-input').click());
  $('#c-attach-input').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });

  // --- Images en ligne (au fil du texte) ------------------------------------
  const insertInlineImage = async (file) => {
    if (file.size > MAX_FILE_BYTES) { showErr(`« ${file.name} » dépasse 10 Mo.`); return; }
    if (totalBytes() + file.size > MAX_TOTAL_BYTES) { showErr('15 Mo maximum au total (images comprises).'); return; }
    const dataUrl = await readAsDataUrl(file);
    const img = document.createElement('img');
    img.src = String(dataUrl);
    img.alt = file.name;
    editor.focus();
    const sel = window.getSelection();
    if (sel.rangeCount && editor.contains(sel.anchorNode)) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(img);
      range.setStartAfter(img);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    } else {
      editor.appendChild(img);
    }
  };
  $('#c-image').addEventListener('click', () => $('#c-image-input').click());
  $('#c-image-input').addEventListener('change', async (e) => {
    for (const f of [...e.target.files]) await insertInlineImage(f);
    e.target.value = '';
  });
  // Coller une capture (Ctrl+V) : l'image atterrit dans le texte, au curseur.
  editor.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (!files.length) return; // texte collé : comportement normal
    e.preventDefault();
    for (const f of files) {
      if (f.type.startsWith('image/')) insertInlineImage(f);
      else addFiles([f]); // un fichier non-image collé part en pièce jointe
    }
  });
  // Fichier déposé sur la fenêtre : image → dans le texte, sinon pièce jointe.
  overlay.addEventListener('dragover', (e) => e.preventDefault());
  overlay.addEventListener('drop', (e) => {
    e.preventDefault();
    for (const f of [...(e.dataTransfer?.files ?? [])]) {
      if (f.type.startsWith('image/')) insertInlineImage(f);
      else addFiles([f]);
    }
  });

  $('#c-send').addEventListener('click', async () => {
    const toVal = $('#c-to').value.trim();
    const ccVal = $('#c-cc').value.trim();
    const subjectVal = $('#c-subject').value.trim();
    const textVal = editor.innerText;
    const hasImages = !!editor.querySelector('img');
    const errEl = $('#c-error');
    errEl.innerHTML = '';
    if (!toVal || !subjectVal || (!textVal.trim() && !hasImages)) {
      errEl.innerHTML = '<div class="notice warn" style="margin-top:10px">Destinataire, objet et message sont requis.</div>';
      return;
    }
    if (totalBytes() > MAX_TOTAL_BYTES) {
      showErr('Pièces jointes et images trop lourdes : 15 Mo maximum au total.');
      return;
    }
    const nbDest = toVal.split(/[,;]/).filter((s) => s.trim()).length +
      ccVal.split(/[,;]/).filter((s) => s.trim()).length;
    const nbPieces = atts.length + editor.querySelectorAll('img[src^="data:"]').length;
    if (!confirm(`Envoyer ce mail à ${nbDest} destinataire(s) depuis ${account}` +
      `${nbPieces ? `, avec ${nbPieces} pièce(s) jointe(s) / image(s)` : ''} ?`)) return;

    // Les images en ligne deviennent des pièces jointes « cid: » référencées
    // par le HTML ; le texte brut reste la version de secours du mail.
    const clone = editor.cloneNode(true);
    const origImgs = [...editor.querySelectorAll('img')];
    const inlineAtts = [];
    clone.querySelectorAll('img').forEach((img, i) => {
      const src = img.getAttribute('src') || '';
      const m = /^data:([^;]+);base64,(.*)$/.exec(src);
      if (!m) {
        // Image externe (http…) : on la laisse telle quelle ; tout autre cas
        // (blob local non lisible) est retiré plutôt qu'envoyé cassé.
        if (!/^https?:/i.test(src)) img.remove();
        return;
      }
      const cid = `img${i + 1}.${Date.now()}@boxmail`;
      const ext = (m[1].split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '');
      inlineAtts.push({ name: img.alt || `image${i + 1}.${ext}`, type: m[1], dataBase64: m[2], cid });
      img.setAttribute('src', `cid:${cid}`);
      img.removeAttribute('style');
      // Largeur lue sur l'image AFFICHÉE (la copie n'a pas encore chargé la
      // sienne) : taille réelle si petite, plafonnée à 640 px sinon.
      const nw = origImgs[i]?.naturalWidth || 0;
      img.setAttribute('width', nw > 0 && nw < 640 ? String(nw) : '640');
    });
    const htmlVal = (hasImages || clone.innerHTML.includes('<'))
      ? `<div style="font-family:Arial, Helvetica, sans-serif; font-size:14px; white-space:pre-wrap">${clone.innerHTML}</div>`
      : undefined;

    const btn = $('#c-send');
    btn.disabled = true;
    btn.textContent = 'Envoi en cours…';
    try {
      const r = await api.sendMail(account, {
        to: toVal,
        cc: ccVal,
        subject: subjectVal,
        text: textVal,
        html: htmlVal,
        attachments: [...atts.map(({ name, type, dataBase64 }) => ({ name, type, dataBase64 })), ...inlineAtts],
        replyTo: replyRef ?? undefined,
      });
      $('.modal-body').innerHTML = `<div class="notice">✅ Mail envoyé à
        <strong>${r.sentTo.map(esc).join(', ')}</strong>.<br>
        ${r.copiedTo ? `Copie déposée dans « ${esc(r.copiedTo)} ».`
          : 'Ta copie est dans « Éléments envoyés » — c\'est ton fournisseur qui l\'y met.'}
        <br><span class="muted" style="font-size:12px">Le serveur a accepté le message. Une remise
        peut encore échouer plus tard (adresse inconnue, boîte pleine) : dans ce cas tu recevras un
        avis de non-remise.</span></div>`;
      $('.modal-foot').innerHTML = '<button class="btn btn-primary" id="c-done">Fermer</button>';
      $('#c-done').addEventListener('click', () => {
        closeModal();
        closeReader(); // le mail est traité : on referme aussi le panneau de lecture
        // L'écran appelant garde la main s'il l'a demandé (le dépouillement
        // avance d'une étape) ; sinon, rafraîchissement générique — SANS
        // re-rendre un parcours en cours.
        if (onSent) onSent();
        else route(); // rafraîchit l'écran (réponses en attente, etc.)
      });
    } catch (err) {
      btn.disabled = false;
      btn.textContent = '✉️ Envoyer';
      // 413 = corps refusé par le serveur/proxy avant l'app : message parlant.
      const msg = err.status === 413
        ? 'Message trop volumineux pour le serveur : allège les pièces jointes ou les images, puis réessaie.'
        : err.message;
      errEl.innerHTML = `<div class="notice warn" style="margin-top:10px">❌ ${esc(msg)}</div>`;
    }
  });
}

// Intentions de mail (A1) — mêmes valeurs que le serveur, libellés FR.
const INTENT_LABELS = {
  otp: '🔑 Code de connexion',
  invoice: '🧾 Facture / paiement',
  shipping: '📦 Livraison',
  appointment: '📅 Rendez-vous',
  reminder: '⏰ Rappel / relance',
  confirmation: '✅ Confirmation',
  document: '📄 Document',
  promo: '📢 Publicité / promo',
  reply_expected: '🗣️ Réponse attendue',
  action_required: '⚡ Action à faire',
  info: 'ℹ️ Information',
};

// Section « 🤖 Analyse » du panneau de lecture (L5.4) — heuristiques locales.
/**
 * CE QU'ON ATTEND DE LUI (20/08) — « le bouton "c'est réglé" n'apparaît pas
 * dans la lecture du mail ; la liste des boutons devrait être dynamique en
 * fonction de son contenu et de ce que l'on attend de moi ».
 *
 * Il avait mis le doigt sur une incohérence du produit : la Vue du jour dit
 * « ce mail attend un paiement » et propose « ✓ C'est réglé » ; on ouvre le
 * mail, et Boxmail oublie sa propre conclusion pour proposer neuf boutons
 * identiques à ceux d'une publicité.
 *
 * Ce n'est pas une nouvelle intelligence : l'analyse a déjà produit un verdict
 * sur 96 % de la boîte de réception, avec pour chaque mail ce qui est attendu
 * ET DE QUI. On se contente de mettre à l'écran ce que Boxmail sait déjà.
 *
 * Deux boutons contextuels au maximum : au-delà, la barre saute d'un mail à
 * l'autre et il ne retrouve plus rien. Le reste vit sous « Toutes les
 * actions », à un endroit qui, lui, ne bouge jamais.
 */
const LIBELLES_ACTION = {
  pay: '✓ Paiement fait',
  reply: '↩️ Répondre',
  provide_document: '✓ Document fourni',
  sign: '✓ Document signé',
  confirm: '✓ Confirmation faite',
  review: '✓ Vérifié',
  call: '✓ Appel passé',
  book: '✓ Réservation faite',
  declare: '✓ Déclaration faite',
  renew: '✓ Renouvellement fait',
  attend: '✓ C\'est noté',
  other: '✓ C\'est réglé',
};

/** « Payer 160,36 € · avant le 25 août » — la phrase, pas le code. */
function phraseAction(a) {
  const verbe = {
    pay: 'Payer', reply: 'Répondre', provide_document: 'Fournir un document',
    sign: 'Signer', confirm: 'Confirmer', review: 'Vérifier', call: 'Appeler',
    book: 'Réserver', declare: 'Déclarer', renew: 'Renouveler', attend: 'Y être',
  }[a.kind] ?? 'À traiter';
  const bits = [a.label?.trim() || verbe];
  if (a.amount) bits.push(`${fmtNum(Math.round(a.amount * 100) / 100)} ${esc(a.currency || '€')}`);
  if (a.dueAt) bits.push(`avant le ${fmtDate(a.dueAt)}`);
  return bits.join(' · ');
}

/**
 * Compose la barre du haut à partir des actions du verdict. Ne fait RIEN quand
 * l'analyse n'a rien conclu (4 % des mails, ou verdict muet) : mieux vaut la
 * barre habituelle qu'un « C'est réglé » inventé.
 */
function renderReaderActions(actions, item, opts = {}) {
  const zone = $('#reader-todo');
  const lead = $('#reader-lead');
  if (!zone || !lead) return;
  const utiles = (actions ?? []).filter((a) => LIBELLES_ACTION[a.kind]);
  if (!utiles.length) return;

  // Ce qu'il a à faire, écrit en français au-dessus des boutons.
  const doute = utiles.some((a) => a.certainty === 'weak_inference' || a.certainty === 'unknown');
  zone.classList.remove('hidden');
  zone.innerHTML = `<span class="reader-todo-tag">${doute ? 'À vérifier' : 'À faire'}</span>
    <span>${utiles.slice(0, 2).map((a) => esc(phraseAction(a))).join(' · ')}</span>
    ${utiles.length > 2 ? `<span class="muted">· et ${fmtNum(utiles.length - 2)} autre(s)</span>` : ''}
    ${utiles[0]?.evidence ? `<span class="reader-todo-why" title="${esc(utiles[0].evidence)}">pourquoi ?</span>` : ''}`;

  // Au plus DEUX boutons : le reste reste sous « Toutes les actions ».
  lead.innerHTML = utiles.slice(0, 2).map((a, i) => {
    const montant = a.kind === 'pay' && a.amount
      ? ` · ${fmtNum(Math.round(a.amount * 100) / 100)} ${esc(a.currency || '€')}` : '';
    return `<button class="btn btn-sm ${i === 0 ? 'btn-primary' : ''}" data-todo="${i}"
      title="${esc(a.evidence || phraseAction(a))}">${esc(LIBELLES_ACTION[a.kind])}${montant}</button>`;
  }).join('');

  lead.querySelectorAll('[data-todo]').forEach((b) => {
    b.addEventListener('click', async () => {
      const a = utiles[Number(b.dataset.todo)];
      // « Répondre » est la seule action que Boxmail sait vraiment EXÉCUTER.
      if (a.kind === 'reply') { $('#reader-reply')?.click(); return; }
      // Les autres disent seulement « c'est fait de mon côté » — comme le
      // « ✓ C'est réglé » des cartes. On ne prétend pas payer à sa place.
      b.disabled = true;
      try {
        await api.messageAction(item.account, { folder: item.folder, uid: item.uid, action: 'seen' });
        item.isSeen = true;
        b.textContent = '✓ noté';
        zone.classList.add('reader-todo-done');
        opts.onSeen?.();
      } catch (err) {
        b.disabled = false;
        alert(err.message);
      }
    });
  });
}

function renderReaderAnalysis(a, item, opts = {}) {
  const el = $('#reader-analysis');
  if (!el) return;
  el.classList.remove('hidden');

  const replyBadge =
    a.reply.kind === 'awaiting' ? 'orange'
    : a.reply.kind === 'you-last' ? 'blue'
    : a.reply.kind === 'answered' ? 'green'
    : 'gray';
  const impLine = a.importance
    ? `<div class="ra-line">${scoreBadge(a.importance.score)}
        <span>${a.importance.level === 'high' ? 'prioritaire' : a.importance.level === 'medium' ? 'à regarder' : 'peut attendre'}
        <span class="muted" style="font-size:11.5px" title="${esc(a.importance.reasons.join(' · '))}">
        — ${a.importance.reasons.slice(0, 2).map(esc).join(' · ')}${a.importance.reasons.length > 2 ? ' …' : ''}</span></span></div>`
    : '';
  const existing = a.deadlines.existing
    .map(
      (d) => `<span class="badge ${d.status === 'confirmed' ? 'blue' : d.status === 'proposed' ? 'orange' : 'gray'}"
        title="statut : ${esc(d.status)}">📅 ${fmtDate(d.date)}</span>`,
    )
    .join(' ');
  const detected = a.deadlines.detected
    .map(
      (d, k) => `<span class="ra-deadline">📅 ${fmtDate(d.date)}
        <span class="muted" style="font-size:11px" title="${esc(d.sourceText)}">(${esc(d.type)})</span>
        <button class="btn btn-sm ra-propose" data-k="${k}"
          title="Ajoute cette date à tes échéances — annulable">⏰ Me le rappeler</button></span>`,
    )
    .join(' ');

  // Type de demande (B3) : question / action / réponse attendue — détecté
  // aussi sans « ? » (le texte cité du mail est ignoré).
  const requestLine = a.request && a.request.kind !== 'information'
    ? `<div class="ra-line"><span class="badge ${a.request.kind === 'question' ? 'blue' : 'orange'}">🗣️</span>
        <span>${esc(a.request.label)} <span class="muted" style="font-size:11.5px">— ${esc(a.request.why)}</span></span></div>`
    : '';

  // Confiance de l'analyse (B4) : faible ⇒ le mail est protégé de toute
  // suppression automatique — la raison est dans l'infobulle.
  const confidenceLine = a.confidence
    ? `<div class="ra-line"><span class="badge ${a.confidence.level === 'high' ? 'green' : a.confidence.level === 'medium' ? 'orange' : 'gray'}">🎚️</span>
        <span title="${esc(a.confidence.reason)}">Confiance de l'analyse : <strong>${esc(a.confidence.label)}</strong>
        <span class="muted" style="font-size:11.5px">— ${esc(a.confidence.reason)}${a.confidence.level === 'low' ? ' · protégé des nettoyages automatiques' : ''}</span></span></div>`
    : '';

  // Classement courant + CORRECTION sur place (retour utilisateur 01/08 :
  // « comment je te signale qu'un mail est mal classé ? »). Corriger la
  // catégorie de l'expéditeur reclasse TOUS ses mails, tout de suite, et la
  // correction n'est jamais écrasée par les recalculs (manual > ai > auto).
  const c = a.classement;
  const classLine = c
    ? `<div class="ra-line" style="flex-wrap:wrap; gap:6px">
        <span class="badge gray">🏷️</span>
        <span>Classé :</span>
        <select id="ra-intent" title="Corriger l'intention de CE mail précis — ta correction n'est jamais écrasée, et elle lève le doute de l'analyse">
          <option value="">${c.intent ? '(revenir au calcul auto)' : 'pas encore classé'}</option>
          ${Object.entries(INTENT_LABELS)
            .map(([v, l]) => `<option value="${v}" ${v === c.intent ? 'selected' : ''}>${l}</option>`)
            .join('')}</select>
        <span>${c.intentReason ? `<span class="muted" style="font-size:11.5px" title="${esc(c.intentReason)}">— ${esc(c.intentReason)}</span>` : ''}
          ${c.intentSource === 'manual' ? '<span class="badge blue" title="Posé à la main — jamais écrasé">corrigé</span>'
            : c.intentSource === 'ai' ? '<span class="badge gray" title="Verdict de l’analyse IA">IA</span>' : ''}
          <span class="muted" id="ra-intent-note" style="font-size:11.5px"></span></span>
      </div>
      ${c.sender ? `<div class="ra-line" style="flex-wrap:wrap; gap:6px">
        <span class="badge gray">👤</span>
        <span>Expéditeur <span class="muted" style="font-size:11.5px">${esc(c.sender.email)}</span> :</span>
        <select id="ra-cat" title="Corriger « qui écrit » — s'applique à TOUS les mails de cet expéditeur, tout de suite, et n'est jamais écrasé par les recalculs">
          <option value="">${c.sender.category ? '(revenir au calcul auto)' : 'catégorie ?'}</option>
          ${Object.entries(SENDER_CATEGORY_LABELS)
            .map(([v, l]) => `<option value="${v}" ${v === c.sender.category ? 'selected' : ''}>${l}${v === c.sender.category && c.sender.categorySource !== 'manual' ? ' (auto)' : ''}</option>`)
            .join('')}</select>
        <select id="ra-prio" title="Priorité de cet expéditeur dans le score d'importance">
          <option value="normal" ${c.sender.priority === 'normal' ? 'selected' : ''}>priorité normale</option>
          <option value="always_important" ${c.sender.priority === 'always_important' ? 'selected' : ''}>⭐ toujours important</option>
          <option value="never_urgent" ${c.sender.priority === 'never_urgent' ? 'selected' : ''}>🔕 jamais urgent</option>
        </select>
        <span class="muted" id="ra-class-note" style="font-size:11.5px">une correction s'applique à tous ses mails</span>
        <button class="btn btn-sm" id="ra-echanges" data-email="${esc(c.sender.email)}"
          data-mid="${item.messageId ?? ''}" data-account="${esc(item.account ?? '')}"
          data-folder="${esc(item.folder ?? '')}" data-uid="${item.uid ?? ''}"
          data-sujet="${esc(item.subject ?? '')}"
          title="Voir les échanges liés à CE mail — pas tout l'historique">📚 Contexte</button>
      </div>
      <div id="ra-echanges-body" class="hidden"></div>` : ''}`
    : '';

  // MONTRER LE RAISONNEMENT (retour 10/08 : « je ne crois pas à ton système
  // d'analyse »). Quand une date a été trouvée mais que la proposition a été
  // ÉCARTÉE, on le DIT sur le mail lui-même, avec le motif — et on laisse
  // rétablir d'un clic. C'est ce qui permet de juger sur pièces au lieu de
  // croire sur parole ; c'est aussi l'aveu honnête que le système a pu se
  // tromper.
  const vetoedLine = (a.deadlines.vetoed ?? []).length
    ? `<div class="ra-line" style="flex-wrap:wrap; gap:6px; align-items:flex-start">
        <span class="badge gray">🛑</span>
        <span style="flex:1; min-width:220px">
          <strong>${a.deadlines.vetoed.length === 1 ? 'Une date a été trouvée, mais je n\'en ai pas fait une échéance' : `${fmtNum(a.deadlines.vetoed.length)} dates trouvées, écartées`}</strong>
          ${a.deadlines.vetoed.map((v) => `<div class="muted" style="font-size:11.5px; margin-top:2px">
            📅 ${fmtDate(v.date)} — ${esc(v.reason)}</div>`).join('')}
          <div class="muted" style="font-size:11.5px; margin-top:2px">Si je me trompe, rétablis-la : elle repassera dans les dates à confirmer.</div>
        </span>
        ${a.deadlines.vetoed.map((v) => `<button class="btn btn-sm ra-unveto" data-id="${v.id}">↩︎ Rétablir</button>`).join('')}
      </div>`
    : '';

  // Résumé en une ligne (verdict en mots + raison principale) ; le score
  // numérique et les signaux détaillés restent derrière « Voir le détail ».
  const levelWord = a.importance
    ? a.importance.level === 'high' ? 'Prioritaire' : a.importance.level === 'medium' ? 'À regarder' : 'Peut attendre'
    : 'Analyse';
  // Les raisons serveur commencent par leur poids (« +15 non lu… ») : le
  // chiffre reste dans le détail, pas dans le résumé.
  const mainReason = (a.reply.kind === 'awaiting'
    ? a.reply.label
    : (a.importance?.reasons?.[0] ?? a.reply.label)).replace(/^[+-]\d+\s*/, '');
  // LE RÉGLAGE N'EST PAS DU CONTENU (25/08) — « déplacer les deux menus de
  // correction dans "Pourquoi Boxmail me montre ça ?" : ce sont des outils de
  // réglage, pas du contenu de mail ». Les deux sélecteurs (classement du mail,
  // catégorie et priorité de l'expéditeur) mangeaient deux lignes à CHAQUE
  // lecture, alors qu'il ne les touche qu'en cas d'erreur. Ils partent donc
  // derrière le repli, avec le reste de l'explication.
  el.innerHTML = `
    <div class="ra-line">
      <span><strong>${esc(levelWord)}</strong>${a.confidence ? ` · confiance ${esc(a.confidence.label)}` : ''}
        <span class="muted" style="font-size:11.5px">— ${esc(mainReason)}</span></span>
      <button class="btn btn-sm" id="ra-toggle" style="margin-left:auto"
        title="Ce que j'ai compris de ce mail, et de quoi me corriger si je me trompe">Pourquoi ? ▾</button>
    </div>
    ${existing || detected
      ? `<div class="ra-line"><span>Dates :</span> ${existing} ${detected}</div>`
      : ''}
    <div id="ra-detail" class="hidden">
      ${impLine}
      <div class="ra-line"><span class="badge ${replyBadge}">↩️</span> <span>${esc(a.reply.label)}</span></div>
      ${requestLine}
      ${confidenceLine}
      ${vetoedLine}
      <div class="ra-line muted" style="font-size:11px">Règles locales — rien n'est envoyé à un service externe.</div>
      ${classLine ? `<div class="ra-corriger"><div class="ra-corriger-titre">Me corriger</div>${classLine}</div>` : ''}
    </div>`;
  $('#ra-toggle')?.addEventListener('click', () => {
    const d = $('#ra-detail');
    if (!d) return;
    d.classList.toggle('hidden');
    $('#ra-toggle').textContent = d.classList.contains('hidden') ? 'Pourquoi ? ▾' : 'Pourquoi ? ▴';
  });

  const note = (msg) => {
    const n = $('#ra-class-note');
    if (n) { n.textContent = msg; n.style.color = 'var(--green, #16a34a)'; }
  };
  $('#ra-intent')?.addEventListener('change', async (e) => {
    try {
      const oldIntent = c?.intent ?? null;
      const newIntent = e.target.value || null;
      const r = await api.setMessageIntent(item.account, {
        folder: item.folder,
        uid: item.uid,
        intent: newIntent,
      });
      const n = $('#ra-intent-note');
      if (n) {
        n.textContent = e.target.value
          ? (r.replyDismissed
            ? '✓ corrigé — le fil sort aussi de « À traiter » (plus de réponse attendue)'
            : '✓ corrigé pour ce mail — jamais écrasé')
          : '✓ repassé en calcul automatique';
        n.style.color = 'var(--green, #16a34a)';
      }
      // L'écran appelant peut réagir (le dépouillement : reclassé en simple
      // information = mail traité, avec bandeau d'annulation).
      opts.onReclassified?.(item, newIntent, oldIntent);
      // La liste derrière le lecteur doit refléter la correction tout de
      // suite : la Vue du jour se recharge quand le fil vient d'en sortir.
      if (r.replyDismissed && (location.hash === '#/today' || location.hash === '' || location.hash === '#/')) {
        renderToday();
      }
    } catch (err) { alert(err.message); }
  });
  // ═══════════════ CONTEXTE DU MAIL — refondu le 18/08 ═══════════════
  //
  // CE QUI N'ALLAIT PAS. Le panneau listait les 12 conversations les plus
  // RÉCENTES avec la personne (tri par date, `slice(0, 12)`, aucun critère de
  // pertinence) : ouvrir une mise en demeure URSSAF affichait « COUCOU » et
  // « 100 ans de la PLM ». Et cliquer un message appelait `openReader`, qui
  // DÉTRUISAIT le mail en cours — sans retour possible. Retours utilisateur :
  // « plus de possibilité de revenir en arrière sur le mail principal » et
  // « nos échanges ne se cantonne pas qu'au sujet traité ».
  //
  // LE PRINCIPE (contre-revue aveugle, .consult/2026-08-18-nos-echanges) :
  // l'historique est du CONTENU, pas une navigation. Un clic déplie le message
  // SUR PLACE ; le mail courant reste l'ancre et n'est jamais remplacé. Il n'y
  // a donc aucun bouton « retour » dans le parcours normal — il n'y a rien
  // dont il faille revenir. Changer réellement de document exige le geste
  // explicite « Ouvrir ce mail ↗ ».
  $('#ra-echanges')?.addEventListener('click', async (e) => {
    const zone = $('#ra-echanges-body');
    const bouton = e.currentTarget;
    if (!zone) return;
    if (!zone.classList.contains('hidden')) {
      zone.classList.add('hidden');
      bouton.textContent = '📚 Contexte';
      return;
    }
    zone.classList.remove('hidden');
    bouton.textContent = '📚 Masquer';
    // Repère : l'identifiant interne s'il est connu, sinon compte/dossier/UID
    // — que le lecteur possède toujours. Exiger `messageId` faisait répondre
    // « ce mail n'est pas encore indexé » depuis la Vue du jour, qui ne le
    // transporte pas (constaté en production le 18/08).
    const ref = {
      messageId: Number(bouton.dataset.mid) || undefined,
      account: bouton.dataset.account || undefined,
      folder: bouton.dataset.folder || undefined,
      uid: bouton.dataset.uid ? Number(bouton.dataset.uid) : undefined,
    };
    if (!ref.messageId && !(ref.account && ref.folder && ref.uid != null)) {
      zone.innerHTML = '<div class="empty">Ce mail n\'est pas encore indexé — synchronise la boîte.</div>';
      return;
    }
    await chargerContexte(zone, ref, 'lie', bouton.dataset.sujet || '');
  });

  /** Charge et rend une focale. Rappelable sans reconstruire le lecteur. */
  async function chargerContexte(zone, ref, focale, sujetCourant) {
    zone.innerHTML = '<div class="empty"><span class="spinner"></span>Je rassemble le contexte…</div>';
    let d;
    try {
      d = await api.contexteMail(ref, focale);
    } catch (err) {
      zone.innerHTML = `<div class="notice warn">⚠️ ${esc(err.message)}</div>`;
      return;
    }
    if (!zone.isConnected) return;

    // Les trois focales, du plus étroit au plus large. Les compteurs excluent
    // le mail courant : « 0 autre » est une information, pas un échec.
    const onglet = (cle, libelle, n) =>
      `<button class="ctx-focale ${d.focale === cle ? 'actif' : ''}" data-focale="${cle}"
        ${n === 0 && cle !== 'tout' ? 'data-vide="1"' : ''}>${libelle} · ${fmtNum(n)}</button>`;
    const barre = `<div class="ctx-barre">
      ${onglet('sujet', 'Ce sujet', d.compteurs.sujet)}
      ${onglet('lie', 'Lié à ce mail', d.compteurs.lie)}
      ${onglet('tout', `Tout avec ${esc((d.displayName || '').split(' ')[0] || 'lui')}`, d.compteurs.tout)}
    </div>`;

    if (d.focale === 'tout') {
      zone.innerHTML = barre + (d.sujets.length
        ? `<div class="ctx-lead">${fmtNum(d.compteurs.tout)} échanges, regroupés par conversation.</div>` +
          d.sujets.map((sj, i) => `
            <div class="ctx-conv">
              <button class="ctx-conv-head" data-conv="${i}">
                <span class="ctx-conv-titre">${esc(sj.subject)}</span>
                <span class="muted">${fmtNum(sj.count)} message(s) · ${esc(fmtDate(sj.lastAt))}</span>
              </button>
              <div class="ctx-conv-body hidden" data-convbody="${i}">
                ${sj.messages.map((m) => ligneContexte(m, d.messageIdCourant)).join('')}
              </div>
            </div>`).join('')
        : '<div class="empty">Aucun autre échange retrouvé.</div>');
      zone.querySelectorAll('[data-conv]').forEach((b) => b.addEventListener('click', () => {
        zone.querySelector(`[data-convbody="${b.dataset.conv}"]`)?.classList.toggle('hidden');
      }));
    } else if (!d.messages.filter((m) => !m.estCourant).length) {
      // CAS VIDE — fréquent (41 % des mails mesurés). On ne s'élargit JAMAIS
      // en douce : le même bouton signifierait tantôt « voici les liens »,
      // tantôt « je n'ai rien trouvé, voilà autre chose ».
      zone.innerHTML = barre + `<div class="ctx-vide">
        Aucun échange antérieur directement lié à ce mail.
        ${d.compteurs.tout > 0
          ? `<button class="btn btn-sm" data-focale="tout">Élargir aux ${fmtNum(d.compteurs.tout)} autres échanges →</button>`
          : ''}</div>`;
    } else {
      zone.innerHTML = barre +
        `<div class="ctx-fil">${d.messages.map((m) => ligneContexte(m, d.messageIdCourant)).join('')}</div>` +
        (d.tronque > 0
          ? `<div class="ctx-plus">${fmtNum(d.tronque)} autre(s) échange(s) lié(s) non affiché(s) —
             <button class="btn btn-sm" data-focale="tout">tout voir →</button></div>`
          : '');
    }

    // Changement de focale : on recharge la même zone, le mail reste intact.
    zone.querySelectorAll('[data-focale]').forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.focale === d.focale) return;
      chargerContexte(zone, ref, b.dataset.focale, sujetCourant);
    }));

    // UN CLIC DÉPLIE SUR PLACE. Le mail courant n'est jamais remplacé.
    zone.querySelectorAll('.ctx-msg-head').forEach((h) => h.addEventListener('click', async () => {
      const corps = h.parentElement.querySelector('.ctx-msg-body');
      if (!corps) return;
      if (!corps.classList.contains('hidden')) { corps.classList.add('hidden'); return; }
      // Un seul déplié à la fois : quinze corps ouverts seraient illisibles.
      zone.querySelectorAll('.ctx-msg-body').forEach((c) => c.classList.add('hidden'));
      corps.classList.remove('hidden');
      if (corps.dataset.charge) return;
      corps.innerHTML = '<div class="empty"><span class="spinner"></span>Lecture…</div>';
      try {
        const m = await readMessageCached(h.dataset.account, h.dataset.folder, Number(h.dataset.uid));
        corps.dataset.charge = '1';
        marquerLu(h.dataset.account, h.dataset.folder, Number(h.dataset.uid), null);
        const pj = (h.dataset.pj || '').split('|').filter(Boolean);
        const texte = m.text || m.plain || m.body || '';
        corps.innerHTML =
          `<div class="ctx-corps">${esc(texte.slice(0, 4000) || '(corps vide)').replace(/\n/g, '<br>')}</div>` +
          (pj.length ? `<div class="ctx-pj">📎 ${pj.map((n) => esc(n)).join(' · ')}</div>` : '') +
          `<div class="ctx-msg-actions">
             <button class="btn btn-sm ctx-ouvrir" data-account="${h.dataset.account}"
               data-folder="${h.dataset.folder}" data-uid="${h.dataset.uid}">Ouvrir ce mail ↗</button>
           </div>`;
        corps.querySelector('.ctx-ouvrir')?.addEventListener('click', () => {
          // SEUL endroit qui change réellement de document — et il empile le
          // mail courant pour que le retour soit possible et NOMMÉ.
          _pileLecture.push({ item, opts, label: sujetCourant || item.subject });
          openReaderFor(
            { account: h.dataset.account, folder: h.dataset.folder, uid: Number(h.dataset.uid) },
            opts,
          );
        });
      } catch (err) {
        corps.innerHTML = `<div class="notice warn">⚠️ ${esc(err.message)}</div>`;
      }
    }));
  }

  /** Une ligne du contexte : repliée par défaut, avec la raison du lien. */
  function ligneContexte(m, midCourant) {
    if (m.messageId === midCourant || m.estCourant) {
      return `<div class="ctx-ici">— vous êtes ici — ${esc(fmtDate(m.date))} · ${esc((m.subject || '').slice(0, 60))}</div>`;
    }
    const qui = m.isOutbound ? 'Toi' : 'Lui';
    return `<div class="ctx-msg">
      <button class="ctx-msg-head" data-account="${esc(m.account)}" data-folder="${esc(m.folder)}"
        data-uid="${m.uid}" data-pj="${esc((m.attachmentNames || []).join('|'))}">
        <span class="ctx-msg-date">${esc(fmtDate(m.date))}</span>
        <span class="ctx-msg-qui">${qui}</span>
        <span class="ctx-msg-sujet">${esc(m.subject || '(sans objet)')}</span>
        ${m.hasAttachments ? '<span class="badge gray">📎</span>' : ''}
        ${m.lienPar ? `<span class="ctx-lien" title="Pourquoi ce message est là">${esc(m.lienPar)}</span>` : ''}
      </button>
      <div class="ctx-msg-body hidden">${m.snippet ? `<div class="ctx-apercu">${esc(m.snippet)}</div>` : ''}</div>
    </div>`;
  }


  $('#ra-cat')?.addEventListener('change', async (e) => {
    try {
      await api.senderSetCategory(item.account, c.sender.email, e.target.value || null);
      note(e.target.value
        ? '✓ corrigé — tous les mails de cet expéditeur suivent'
        : '✓ repassé en calcul automatique');
    } catch (err) { alert(err.message); }
  });
  $('#ra-prio')?.addEventListener('change', async (e) => {
    try {
      await api.senderSetPriority(item.account, c.sender.email, e.target.value);
      note('✓ priorité enregistrée — jamais recalculée');
    } catch (err) { alert(err.message); }
  });

  /**
   * ⏰ ME LE RAPPELER — anciennement « ➕ Proposer ».
   *
   * ⚠️ TROIS DÉFAUTS CORRIGÉS LE 27/08, tous signalés par Anthony :
   * « je ne sais pas à quoi correspond le bouton "proposer" qui d'ailleurs
   *   une fois cliqué n'est pas annulable. »
   *
   * 1. LE LIBELLÉ NE DISAIT RIEN. « Proposer » décrit le geste de l'assistant,
   *    pas l'effet pour lui. Proposer à qui ? Pour quoi ? Le bouton dit
   *    maintenant ce qu'il obtient : un rappel à cette date.
   *
   * 2. SON CLIC LUI CRÉAIT DU TRAVAIL. La date partait en `proposed`, et le
   *    badge l'envoyait « valider dans 📅 Dates à confirmer » — un autre écran,
   *    un second clic, pour une date qu'il avait sous les yeux et qu'il venait
   *    d'approuver. C'est le « bouton Valider déguisé » que tout le chantier
   *    du 27/08 démonte : on ne transforme pas une conclusion en question.
   *    Elle part donc en `confirmed`.
   *
   * 3. AUCUN RETOUR EN ARRIÈRE. Le bouton disparaissait, remplacé par un badge
   *    figé. Un geste qui écrit en base sans porte de sortie oblige à réfléchir
   *    AVANT de cliquer — exactement la charge qu'on prétend lui retirer.
   *    Le bandeau « Fait · Annuler » rend le clic gratuit.
   */
  el.querySelectorAll('.ra-propose').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const d = a.deadlines.detected[Number(btn.dataset.k)];
      btn.disabled = true;
      try {
        const cree = await api.proposeDeadline(item.account, {
          folder: item.folder,
          uid: item.uid,
          date: d.date,
          type: d.type,
          sourceText: d.sourceText,
          status: 'confirmed', // son clic EST la validation
        });
        const marque = Object.assign(document.createElement('span'), {
          className: 'badge blue',
          textContent: '✓ dans tes échéances',
        });
        btn.replaceWith(marque);
        refreshDeadlinesBadge();
        showUndoToast(`⏰ Rappel noté pour le ${fmtDate(d.date)}.`, async () => {
          // EFFACER, pas « écarter » : un écarté resterait en base et le mail
          // ne reproposerait plus jamais cette date (mesuré au banc le 27/08).
          await api.deadlineAction(item.account, cree.id, 'delete');
          marque.replaceWith(btn);
          btn.disabled = false;
          refreshDeadlinesBadge();
        });
      } catch (err) {
        alert(err.message);
        btn.disabled = false;
      }
    });
  });

  // « Rétablir » une proposition que l'arbitrage avait écartée : elle
  // repasse dans les dates à confirmer, et l'utilisateur tranche.
  el.querySelectorAll('.ra-unveto').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await api.deadlineAction(item.account, Number(btn.dataset.id), 'restore');
        btn.replaceWith(Object.assign(document.createElement('span'), {
          className: 'badge orange',
          textContent: '✓ rétablie — à valider dans 📅 Dates à confirmer',
        }));
        refreshDeadlinesBadge();
      } catch (err) {
        alert(err.message);
        btn.disabled = false;
      }
    });
  });
}

// Ouvre le panneau de lecture depuis un élément « intelligence » (importants,
// réponses, relances, échéances, brief) : construit l'item minimal et branche
// les callbacks de rafraîchissement de l'écran appelant.
function openReaderFor(src, { onSeen, onRemoved, dock, onReplied, onReclassified, serie } = {}) {
  if (!src || !src.folder || !src.uid) {
    alert('Ce mail n\'est plus dans l\'index (supprimé ou déplacé) — resynchronise la boîte.');
    return;
  }
  openReader(
    {
      account: src.account,
      folder: src.folder,
      uid: src.uid,
      subject: src.subject ?? '(sans sujet)',
      fromName: src.fromName ?? null,
      fromEmail: src.fromEmail ?? '',
      date: src.date,
      isSeen: src.isSeen ?? true,
    },
    null,
    { onSeen: onSeen ?? (() => {}), onRemoved: onRemoved ?? (() => route()), dock, onReplied, onReclassified, serie },
  );
}

// Retire un mail supprimé/déplacé des résultats. Depuis le 11/08 les
// résultats sont GROUPÉS par interlocuteur : il faut le retirer de son
// groupe, et faire disparaître le groupe s'il devient vide.
function removeItemFromResults(item) {
  const d = searchState.data;
  if (!d?.groups) return;
  for (const g of d.groups) {
    const idx = g.items.indexOf(item);
    if (idx < 0) continue;
    g.items.splice(idx, 1);
    g.count = Math.max(0, g.count - 1);
    if (item.hasAttachments) g.withAttachments = Math.max(0, g.withAttachments - 1);
    d.total = Math.max(0, d.total - 1);
    d.examined = Math.max(0, d.examined - 1);
    break;
  }
  d.groups = d.groups.filter((g) => g.items.length > 0);
  renderSearchResults();
}

// ---------------------------------------------------------------- Journal
// Familles d'opérations pour les filtres du journal (revue UX P1.5).
const OP_FAMILIES = {
  mails: ['ui_cleanup_sender', 'bulk_delete_by_sender', 'delete_emails', 'ui_delete_message',
    'ui_move_message', 'ui_mark_message', 'ui_bulk_delete', 'ui_bulk_move', 'ui_bulk_mark',
    'move_emails', 'mark_emails', 'create_folder', 'ui_send_mail', 'apply_mail_rule',
    'rule_auto_apply', 'retention_auto_apply', 'grand_menage', 'ui_unsubscribe', 'ui_unsubscribe_manual', 'ui_review_decide', 'ui_review_validate', 'ui_review_undo', 'ui_restore_message',
    'ui_accounting_send', 'accounting_detect', 'accounting_attachment_download'],
  analyses: ['ai_analysis', 'detect_deadlines', 'ui_analysis_feedback', 'repair_snippets', 'ui_review_learning_dismiss'],
  suivi: ['snooze_reply', 'dismiss_reply', 'restore_reply', 'snooze_followup', 'mark_followup_done',
    'restore_followup', 'confirm_deadline', 'dismiss_deadline', 'complete_deadline',
    'restore_deadline', 'propose_deadline', 'create_task', 'task_from_deadline',
    'complete_task', 'dismiss_task', 'reopen_task',
    'rentila_command_created', 'rentila_command_approved', 'rentila_command_cancelled', 'rentila_command_result'],
};
function opFamily(tool) {
  for (const [fam, tools] of Object.entries(OP_FAMILIES)) if (tools.includes(tool)) return fam;
  return 'reglages';
}

// Les lots d'analyse IA consécutifs sont regroupés en une seule ligne
// (« 240 mails analysés (5 lots) ») — le détail lot par lot reste dans
// logs/operations.jsonl.
function groupOps(ops) {
  const out = [];
  for (const op of ops) {
    const last = out[out.length - 1];
    const count = Number(op.params?.verdicts ?? op.items?.length ?? 0);
    if (op.tool === 'ai_analysis' && last?.tool === 'ai_analysis') {
      last._group = last._group ?? { count: Number(last.params?.verdicts ?? last.items?.length ?? 0), batches: 1 };
      last._group.count += count;
      last._group.batches += 1;
      last.items = undefined; // la liste d'un seul lot serait trompeuse
    } else {
      out.push({ ...op });
    }
  }
  return out;
}

const opsState = { filter: 'all', operations: [] };
async function renderOperations() {
  const main = $('#main');
  main.innerHTML = `<div class="page-head"><div><h1>📜 Journal d'activité</h1>
    <div class="sub">Tout ce qui a été fait (par toi, l'assistant ou Claude), le plus récent d'abord.</div></div></div>
    <div class="tabs" id="ops-tabs"></div>
    <div class="panel"><div class="panel-body" id="ops-body"><span class="spinner"></span></div></div>`;
  const { operations } = await api.operations(100);
  opsState.operations = operations;
  renderOpsList();
}

function renderOpsList() {
  const filters = [
    ['all', 'Tout'], ['mails', 'Actions sur les mails'],
    ['analyses', 'Analyses'], ['suivi', 'Suivi'], ['reglages', 'Réglages'],
  ];
  $('#ops-tabs').innerHTML = filters
    .map(([key, label]) => `<button class="tab ${opsState.filter === key ? 'active' : ''}" data-ops-filter="${key}">${label}</button>`)
    .join('');
  document.querySelectorAll('[data-ops-filter]').forEach((b) =>
    b.addEventListener('click', () => { opsState.filter = b.dataset.opsFilter; renderOpsList(); }));

  const ops = groupOps(
    opsState.operations.filter((op) => opsState.filter === 'all' || opFamily(op.tool) === opsState.filter),
  );
  $('#ops-body').innerHTML = ops.length
    ? ops.map(opLine).join('')
    : '<div class="empty">Rien dans le journal pour ce filtre.</div>';
}

installTopLoader();
boot();
