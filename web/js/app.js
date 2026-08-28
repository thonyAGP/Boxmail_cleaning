Warning: truncated output (original token count: 152805)
Total output lines: 12278

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
  } else if (hash.startsWith('#/pieces-compta')) {
    renderPiecesCompta();
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
      document.getElementById('rv-rea…92805 tokens truncated…itle="Trier par expéditeur">Expéditeur ${sortArrow('from')}</th>
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
  /** Réponse synthétique et ses preuves ; les résultats bruts restent dessous. */
  answer: null,
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
  searchState.answer = null;
  try {
    // La liste locale et la synthèse partent ensemble : si Workers AI est
    // indisponible, les résultats vérifiables restent utilisables.
    const [liste, reponse] = await Promise.allSettled([
      api.find({
        q: searchState.q,
        account: searchState.account,
        attachments: searchState.attachments,
        sort: searchState.sort,
        groups: 8,
        per: 25,
      }),
      api.answer(searchState.q, searchState.account),
    ]);
    if (liste.status === 'rejected') throw liste.reason;
    searchState.data = liste.value;
    searchState.answer = reponse.status === 'fulfilled'
      ? reponse.value
      : { answer: null, warning: reponse.reason?.message || 'La réponse synthétique a échoué.', sources: [] };
  } catch (err) {
    el.innerHTML = `<div class="notice warn">⚠️ ${esc(err.message)}<br>
      Si une boîte n'est pas encore synchronisée, lance d'abord une synchronisation.</div>`;
    return;
  }
  renderSearchResults();
}

function renduReponse() {
  const r = searchState.answer;
  if (!r) return '';
  const texte = r.answer
    ? esc(r.answer).replace(/\n/g, '<br>').replace(/\[(\d+)\]/g, '<strong class="answer-cite">[$1]</strong>')
    : `<span class="muted">${esc(r.warning || 'Je ne peux pas encore formuler une réponse fiable.')}</span>`;
  const sources = (r.sources ?? []).map((s, idx) => {
    const i = s.item;
    const nom = i.attachmentNames?.[0];
    return `<button class="answer-source" data-answer-source="${idx}">
      <strong>[${s.numero}] ${esc(nom || i.subject || 'Mail sans sujet')}</strong>
      <span>${i.isOutbound ? 'envoyé' : 'reçu'} le ${fmtDate(i.date)} · ${esc(i.fromName || i.fromEmail)}</span>
      <small>${esc((s.signaux ?? []).join(' · '))}</small>
    </button>`;
  }).join('');
  return `<section class="panel answer-card">
    <div class="answer-title">✨ Ce que j’ai trouvé</div>
    <div class="answer-text">${texte}</div>
    ${sources ? `<div class="answer-sources"><div class="muted">Preuves utilisées</div>${sources}</div>` : ''}
    ${r.answer && r.warning ? `<div class="notice warn">${esc(r.warning)}</div>` : ''}
  </section>`;
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
    ${renduReponse()}
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

  el.querySelectorAll('[data-answer-source]').forEach((b) => {
    b.addEventListener('click', () => {
      const source = searchState.answer?.sources?.[Number(b.dataset.answerSource)];
      if (source?.item) openReader(source.item, b, {
        dock: $('#search-dock') && window.innerWidth > 1100 ? $('#search-dock') : null,
        serie: { refs: searchState.answer.sources.map((s) => s.item), index: Number(b.dataset.answerSource) },
      });
    });
  });

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
    await chargerContexte(zone, ref, 'lie', bouton.dataset.sujet || '', { item, opts });
  });

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

/**
 * L'HISTOIRE D'UN SUJET — les trois focales, du plus étroit au plus large.
 *
 * ⚠️ HISSÉE HORS DU LECTEUR LE 27/08. Ce panneau vivait à l'intérieur de
 * `renderReaderAnalysis`, donc il n'existait QUE quand un mail était ouvert.
 * Résultat : « Voir l'histoire », depuis une attente, ne pouvait pas s'en
 * servir et retombait sur une recherche par mot-clé. Sur le dossier SIDER
 * — un remboursement de 1 000 € — cela rendait 153 mails chez 42
 * interlocuteurs. Son verdict : « tu vas me noyer sinon sur la liste des
 * emails de SIDER sans te limiter dans un 1er temps aux vrais emails qui
 * sont l'historique du sujet ».
 *
 * Les trois focales SONT cette gradation, et elles existaient déjà :
 *   « Ce sujet »        → le fil, l'histoire réelle du dossier ;
 *   « Lié à ce mail »   → ce qui s'y rattache ailleurs ;
 *   « Tout avec X »     → tout l'interlocuteur, et seulement s'il le demande.
 *
 * `ctx` porte ce qui dépend de l'appelant :
 *   - `item` / `opts`      : le lecteur, pour empiler le retour ;
 *   - `avantOuverture`     : une modale, pour se refermer avant d'ouvrir un mail.
 */
async function chargerContexte(zone, ref, focale, sujetCourant, ctx = {}) {
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
    ${onglet('tout', `Tout avec ${esc(d.organisation || (d.displayName || '').split(' ')[0] || 'lui')}`, d.compteurs.tout)}
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
    // `ctx` est reconduit : sans lui, changer d'onglet dans la modale
    // d'historique lui ferait perdre de quoi se refermer avant d'ouvrir un mail.
    chargerContexte(zone, ref, b.dataset.focale, sujetCourant, ctx);
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
        // SEUL endroit qui change réellement de document. Depuis le lecteur,
        // il empile le mail courant pour que le retour soit possible et NOMMÉ.
        // Depuis une modale d'historique, il n'y a rien à empiler : on ferme.
        if (ctx.item) {
          _pileLecture.push({ item: ctx.item, opts: ctx.opts, label: sujetCourant || ctx.item.subject });
        } else {
          ctx.avantOuverture?.();
        }
        openReaderFor(
          { account: h.dataset.account, folder: h.dataset.folder, uid: Number(h.dataset.uid) },
          ctx.opts,
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
