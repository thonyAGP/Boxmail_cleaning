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
  accountColorMap = new Map(
    (overviewCache?.enrolled ?? []).map((e, i) => [e.account, ACCOUNT_PALETTE[i % ACCOUNT_PALETTE.length]]),
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
function accountChip(slug) {
  if (!slug) return '';
  const c = accountColor(slug);
  return `<span class="badge acct-chip" style="background:${c}1f; color:${c}; border:1px solid ${c}55">${esc(slug)}</span>`;
}
let smtpEnabled = false; // renseigné par /api/me au chargement

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
  route();
  startJobWatcher();
  refreshRepliesBadge();
  refreshFollowupsBadge();
  refreshImportantBadge();
  refreshDeadlinesBadge();
  refreshTasksBadge();
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

// Badge « importance haute » (score ≥ 70) sur le lien ⭐ Mails importants.
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

// Badge « en retard » sur le lien Relances à faire de la sidebar.
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

// Badge « en retard » sur le lien Réponses en attente de la sidebar.
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
  location.hash = '#/dashboard';
  showLogin();
});

$('#add-account-btn').addEventListener('click', openEnrollModal);

// Compte dont la sync doit démarrer automatiquement à l'ouverture de sa vue
// (après un enrôlement réussi).
let pendingAutoSync = null;

// ---------------------------------------------------------------- Sidebar
async function refreshOverview() {
  overviewCache = await api.overview();
  rebuildAccountColors();
  const nav = $('#accounts-nav');
  const bySlug = new Map(overviewCache.accounts.map((a) => [a.account, a]));
  const items = overviewCache.enrolled.map((e) => {
    const ov = bySlug.get(e.account);
    const unseen = ov?.inbox?.unseen;
    return `<a href="#/account/${esc(e.account)}" class="side-link" data-account="${esc(e.account)}">
      <span class="acct-dot" style="background:${accountColor(e.account)}"></span>
      <span class="account-email" title="${esc(e.username)}">${esc(e.account)}</span>
      ${unseen != null ? `<span class="badge blue">${fmtNum(unseen)}</span>` : '<span class="badge gray">à sync</span>'}
    </a>`;
  });
  nav.innerHTML =
    items.join('') ||
    '<div class="side-link disabled">Aucun compte enrôlé</div>';
  highlightNav();
}

function highlightNav() {
  const hash = location.hash || '#/dashboard';
  document.querySelectorAll('.side-link').forEach((el) => el.classList.remove('active'));
  if (hash.startsWith('#/account/')) {
    const slug = decodeURIComponent(hash.split('/')[2] ?? '');
    document.querySelector(`[data-account="${CSS.escape(slug)}"]`)?.classList.add('active');
  } else if (hash.startsWith('#/operations')) {
    document.querySelector('[data-nav="operations"]')?.classList.add('active');
  } else if (hash.startsWith('#/inbox')) {
    document.querySelector('[data-nav="inbox"]')?.classList.add('active');
  } else if (hash.startsWith('#/search')) {
    document.querySelector('[data-nav="search"]')?.classList.add('active');
  } else if (hash.startsWith('#/replies')) {
    document.querySelector('[data-nav="replies"]')?.classList.add('active');
  } else if (hash.startsWith('#/followups')) {
    document.querySelector('[data-nav="followups"]')?.classList.add('active');
  } else if (hash.startsWith('#/deadlines')) {
    document.querySelector('[data-nav="deadlines"]')?.classList.add('active');
  } else if (hash.startsWith('#/important')) {
    document.querySelector('[data-nav="important"]')?.classList.add('active');
  } else if (hash.startsWith('#/tasks')) {
    document.querySelector('[data-nav="tasks"]')?.classList.add('active');
  } else {
    document.querySelector('[data-nav="dashboard"]')?.classList.add('active');
  }
}

// ---------------------------------------------------------------- Router
window.addEventListener('hashchange', route);

function route() {
  highlightNav();
  const hash = location.hash || '#/dashboard';
  if (hash.startsWith('#/account/')) {
    renderAccount(decodeURIComponent(hash.split('/')[2] ?? ''));
  } else if (hash.startsWith('#/operations')) {
    renderOperations();
  } else if (hash.startsWith('#/inbox')) {
    renderInbox(decodeURIComponent(hash.split('/')[2] ?? ''));
  } else if (hash.startsWith('#/search')) {
    renderSearch();
  } else if (hash.startsWith('#/replies')) {
    renderReplies();
  } else if (hash.startsWith('#/followups')) {
    renderFollowups();
  } else if (hash.startsWith('#/deadlines')) {
    renderDeadlines();
  } else if (hash.startsWith('#/important')) {
    renderImportant();
  } else if (hash.startsWith('#/tasks')) {
    renderTasks();
  } else {
    renderDashboard();
  }
}

// ---------------------------------------------------------------- Dashboard
async function renderDashboard() {
  const main = $('#main');
  main.innerHTML = `<div class="page-head"><div><h1>Bonjour 👋</h1>
    <div class="sub">Voici ce qui se passe dans vos boîtes.</div></div>
    <div class="head-actions">
      <button class="btn" id="syncall-btn" title="Synchronise chaque boîte l'une après l'autre, en arrière-plan">🔄 Tout synchroniser</button>
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
    body.innerHTML = `<div class="notice warn">Aucun compte enrôlé. Lancer
      <code>npm run enroll -- --account &lt;nom&gt;</code> sur le serveur.</div>`;
    return;
  }

  const totalInbox = ov.accounts.reduce((s, a) => s + (a.inbox?.messages ?? 0), 0);
  const totalUnseen = ov.totals.unseenInbox;
  const totalNews = ov.accounts.reduce((s, a) => s + (a.inbox?.newsletters ?? 0), 0);

  // Nettoyage conseillé (tous comptes indexés, en parallèle).
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
          <button class="btn btn-sm btn-primary" id="brief-generate">☀️ Régénérer</button>
        </div>
      </div>
      <div class="panel-body" id="brief-body"><div class="empty"><span class="spinner"></span>Chargement…</div></div>
    </div>

    <div class="cards">
      <div class="kpi"><div class="kpi-label">📥 Mails en boîte de réception</div>
        <div class="kpi-value">${fmtNum(totalInbox)}</div>
        <div class="kpi-sub">${ov.accounts.length} boîte(s) indexée(s)</div></div>
      <div class="kpi accent"><div class="kpi-label">🔵 Non lus</div>
        <div class="kpi-value">${fmtNum(totalUnseen)}</div></div>
      <div class="kpi orange"><div class="kpi-label">📰 Newsletters / notifications</div>
        <div class="kpi-value">${fmtNum(totalNews)}</div>
        <div class="kpi-sub">mails avec lien de désinscription</div></div>
      <div class="kpi green"><div class="kpi-label">🧹 Supprimables sans risque</div>
        <div class="kpi-value">${fmtNum(deletable)}</div>
        <div class="kpi-sub">estimation par expéditeur</div></div>
    </div>

    ${ov.neverSynced.length ? `<div class="notice warn">⚠️ Boîte(s) jamais synchronisée(s) :
      ${ov.neverSynced.map((n) => `<strong>${esc(n)}</strong>`).join(', ')} —
      ouvrir la boîte dans le menu puis lancer une synchronisation.</div>` : ''}

    <div class="grid-2">
      <div class="panel">
        <div class="panel-head"><h2>Aperçu par compte</h2></div>
        <div class="panel-body tight"><table>
          <thead><tr><th>Compte</th><th class="num">INBOX</th><th class="num">Non lus</th><th>Volume</th><th></th></tr></thead>
          <tbody>${ov.accounts
            .map((a) => {
              const max = Math.max(...ov.accounts.map((x) => x.inbox?.messages ?? 0), 1);
              const pct = Math.round(((a.inbox?.messages ?? 0) / max) * 100);
              return `<tr>
                <td><strong>${esc(a.account)}</strong><br><span class="muted" style="font-size:12px">${esc(a.emailAddress)}</span></td>
                <td class="num">${fmtNum(a.inbox?.messages ?? 0)}</td>
                <td class="num">${fmtNum(a.inbox?.unseen ?? 0)}</td>
                <td><div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div></td>
                <td><a class="btn btn-sm" href="#/account/${esc(a.account)}">Ouvrir</a></td>
              </tr>`;
            })
            .join('')}</tbody>
        </table></div>
      </div>

      <div class="panel">
        <div class="panel-head"><h2>Nettoyage conseillé</h2>
          <span class="badge green">${fmtNum(deletable)} mails « sûrs »</span></div>
        <div class="panel-body tight">
          ${allCandidates.length === 0 ? '<div class="empty">Aucun candidat détecté (ou boîtes pas encore synchronisées).</div>' : `
          <table><thead><tr><th>Expéditeur</th><th class="num">Mails</th><th class="num">Taille</th><th>Risque</th><th></th></tr></thead>
          <tbody>${allCandidates.slice(0, 8).map((c) => `<tr>
            <td>${esc(c.senderName || c.sender)}<br><span class="muted" style="font-size:12px">${esc(c.sender)} · ${esc(c.account)}</span></td>
            <td class="num">${fmtNum(c.messageCount)}</td>
            <td class="num">${fmtSize(c.totalSizeBytes)}</td>
            <td><span class="badge ${c.riskLevel === 'safe' ? 'green' : 'orange'}">${c.riskLevel === 'safe' ? 'Sûr' : 'Moyen'}</span></td>
            <td><button class="btn btn-sm cleanup-btn" data-account="${esc(c.account)}"
              data-sender="${esc(c.sender)}" data-name="${esc(c.senderName || c.sender)}">🧹 Nettoyer</button></td>
          </tr>`).join('')}</tbody></table>
          <div class="panel-body muted" style="font-size:12.5px">« Nettoyer » = aperçu détaillé puis, après TA
          confirmation, déplacement vers la corbeille (récupérable ~30 jours). Rien n'est supprimé définitivement.</div>`}
        </div>
      </div>
    </div>

    <div class="grid-2">
      <div class="panel">
        <div class="panel-head"><h2>⭐ Mails importants</h2>
          <a class="btn btn-sm" href="#/important">Voir tout</a></div>
        <div class="panel-body" id="dash-important"><span class="spinner"></span></div>
        <div class="panel-head"><h2>↩️ Réponses en attente</h2>
          <a class="btn btn-sm" href="#/replies">Voir tout</a></div>
        <div class="panel-body" id="dash-replies"><span class="spinner"></span></div>
        <div class="panel-head"><h2>⏰ Relances à faire</h2>
          <a class="btn btn-sm" href="#/followups">Voir tout</a></div>
        <div class="panel-body" id="dash-followups"><span class="spinner"></span></div>
        <div class="panel-head"><h2>📅 Échéances à venir</h2>
          <a class="btn btn-sm" href="#/deadlines">Voir tout</a></div>
        <div class="panel-body" id="dash-deadlines"><span class="spinner"></span></div>
        <div class="panel-head"><h2>☑️ Tâches à faire</h2>
          <a class="btn btn-sm" href="#/tasks">Voir tout</a></div>
        <div class="panel-body" id="dash-tasks"><span class="spinner"></span></div>
      </div>
      <div class="panel">
        <div class="panel-head"><h2>Activité récente</h2>
          <a class="btn btn-sm" href="#/operations">Voir tout</a></div>
        <div class="panel-body" id="dash-ops"><span class="spinner"></span></div>
      </div>
    </div>`;

  initBriefPanel();

  api.operations(6).then(({ operations }) => {
    const el = $('#dash-ops');
    if (!el) return;
    el.innerHTML = operations.length
      ? operations.map(opLine).join('')
      : '<div class="empty">Aucune opération pour l\'instant.</div>';
  });

  // Mails importants (top 5, score le plus haut d'abord).
  api.important().then((d) => {
    refreshImportantBadge(d);
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

  // Réponses en attente (top 5, les plus en retard d'abord).
  api.replies().then((d) => {
    refreshRepliesBadge(d);
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

  // Relances à faire (top 3, les plus en retard d'abord).
  api.followups().then((d) => {
    refreshFollowupsBadge(d);
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

  // Échéances à venir (top 5 futures, proposées + confirmées).
  api.deadlines().then((d) => {
    refreshDeadlinesBadge(d);
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

  // Tâches à faire (top 5, échéances proches en tête).
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
  api.updateCheck().then(({ behind, commits }) => {
    if (!behind) return;
    const el = document.createElement('div');
    el.className = 'notice';
    el.innerHTML = `⬆️ <strong>Mise à jour disponible</strong> (${fmtNum(behind)} nouveauté${behind > 1 ? 's' : ''}) :
      <span class="muted">${commits.slice(0, 3).map(esc).join(' · ')}</span>
      <button class="btn btn-primary btn-sm" id="update-btn" style="margin-left:10px">Mettre à jour maintenant</button>`;
    body.prepend(el);
    $('#update-btn').addEventListener('click', () => applyUpdateFlow(el));
  }).catch(() => {});
}

// Relie tous les [data-open] d'un conteneur au panneau de lecture. `mapFn`
// adapte l'élément (ex. relance → mail envoyé) avant ouverture.
function bindOpenables(root, items, mapFn) {
  root.querySelectorAll('[data-open]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      const raw = items[Number(el.dataset.open)];
      if (!raw) return;
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
      calculé depuis l'index local).</div>`;
    return;
  }

  const chip = (icon, n, label, href, cls = '') =>
    `<a class="brief-chip ${cls}" ${href ? `href="${href}"` : ''}>
      ${icon} <strong>${fmtNum(n)}</strong> ${label}</a>`;

  const chips = [
    chip('📥', b.totals.newMessages, `nouveaux (${esc(b.periodLabel)})`, ''),
    chip('🔵', b.totals.unseenInbox, 'non lus au total', ''),
    chip('⭐', b.important.high, 'importants (haute)', '#/important', b.important.high ? 'hot' : ''),
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
      ${fmtNum(b.previousBrief.newMessagesSince)} nouveau(x) mail(s) indexé(s).</div>` : ''}
    <div class="grid-2">
      <div>
        ${section('⭐ À regarder en premier', importantRows)}
        ${section('📅 Échéances proches', deadlineRows)}
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
      log.textContent += '\nRed\u00e9marrage du serveur\u2026 (installation + compilation, ~1 minute)';
      const startedWait = Date.now();
      const waitUp = setInterval(async () => {
        try {
          if (await api.health()) {
            clearInterval(waitUp);
            location.reload();
            return;
          }
        } catch { /* pas encore pr\u00eat */ }
        if (Date.now() - startedWait > 180_000) {
          clearInterval(waitUp);
          container.innerHTML = `<div class="notice warn">\u23f1\ufe0f Le serveur n'est pas revenu apr\u00e8s 3 minutes.
            V\u00e9rifie la fen\u00eatre noire <strong>MailAssistant.bat</strong> (elle affiche peut-\u00eatre une
            erreur), relance-la si besoin, puis recharge cette page.</div>`;
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
      title = `↩️ Fil remis dans « Réponses en attente »`;
      break;
    case 'snooze_followup':
      title = `⏰ Relance reportée de <strong>${fmtNum(p.days ?? '?')} jour(s)</strong>`;
      break;
    case 'mark_followup_done':
      title = `✓ Relance marquée traitée`;
      break;
    case 'restore_followup':
      title = `↩️ Fil remis dans « Relances à faire »`;
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
    default:
      title = `⚙️ ${esc(op.tool ?? 'opération')}`;
  }

  const meta = [op.account, op.folder].filter(Boolean).map(esc).join(' · ');
  const items = Array.isArray(op.items) && op.items.length
    ? `<details class="op-details"><summary>Voir les ${fmtNum(op.items.length)} mails concernés</summary>
       <div class="op-items">${op.items
         .map((i) => `<div><span class="mail-date">${fmtDate(i.date)}</span> ${esc(i.subject)}</div>`)
         .join('')}</div></details>`
    : '';

  return `<div class="op-line"><span class="op-time">${fmtDateTime(op.ts)}</span>
    <span style="flex:1">${title}
    ${op.dryRun ? '<span class="badge gray">simulation — rien touché</span>' : ''}
    <span class="muted" style="font-size:12px">— ${meta}</span>${items}</span></div>`;
}

// ---------------------------------------------------------------- Vue compte
const statsState = { sortKey: 'count', sortDir: -1, data: null, selected: new Map() };

async function renderAccount(slug) {
  const main = $('#main');
  const enrolled = overviewCache?.enrolled.find((e) => e.account === slug);
  main.innerHTML = `<div class="page-head">
      <div><h1>📧 ${esc(slug)}</h1><div class="sub">${esc(enrolled?.username ?? '')}</div></div>
      <div class="head-actions">
        <a class="btn" href="#/inbox/${esc(slug)}">📥 Parcourir les mails</a>
        <button class="btn" id="sync-recent">⚡ Sync rapide</button>
        <button class="btn btn-primary" id="sync-full">🔄 Sync complète</button>
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
      <div class="kpi"><div class="kpi-label">💾 Taille INBOX</div>
        <div class="kpi-value" style="font-size:20px">${fmtSize(ov.inbox?.totalSizeBytes)}</div></div>
      <div class="kpi"><div class="kpi-label">👥 Expéditeurs</div>
        <div class="kpi-value">${fmtNum(ov.senderCount)}</div>
        <div class="kpi-sub">dernière sync : ${fmtDateTime(ov.lastSyncAt)}</div></div>
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
          <button class="btn btn-sm" id="f-apply">Appliquer</button>
        </div></div>
      <div class="panel-body tight" id="stats-table"><div class="empty"><span class="spinner"></span></div></div>
    </div>
    <div id="account-cleanup"></div>`;

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
    <div class="panel-head"><h2>🧹 Nettoyage conseillé</h2>
      <span class="badge green">${fmtNum(data.totalDeletableEstimate)} mails « sûrs »</span></div>
    <div class="panel-body tight">
      <table><thead><tr><th>Expéditeur</th><th class="num">Mails</th><th class="num">Non lus</th>
        <th class="num">Taille</th><th>Risque</th><th>Pourquoi</th><th></th></tr></thead>
      <tbody>${data.candidates.map((c) => `<tr>
        <td>${esc(c.senderName || c.sender)}<br><span class="muted" style="font-size:12px">${esc(c.sender)}</span></td>
        <td class="num">${fmtNum(c.messageCount)}</td>
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
      ${th('count', 'Mails')}${th('totalSizeBytes', 'Taille')}${th('unsubscribePct', 'Newsletter')}${th('latestDate', 'Dernier mail')}
    </tr></thead>
    <tbody>${senders
      .map(
        (s) => `<tr>
        <td><input type="checkbox" class="stats-check" data-address="${esc(s.address)}"
          data-name="${esc(s.name || '')}" ${sel.has(s.address) ? 'checked' : ''}></td>
        <td>${esc(s.name || s.address)}<br><span class="muted" style="font-size:12px">${esc(s.address)}</span></td>
        <td class="num"><strong>${fmtNum(s.count)}</strong></td>
        <td class="num">${fmtSize(s.totalSizeBytes)}</td>
        <td class="num">${s.unsubscribePct > 0 ? `<span class="badge ${s.unsubscribePct >= 80 ? 'orange' : 'gray'}">${s.unsubscribePct}%</span>` : '—'}</td>
        <td class="num">${fmtDate(s.latestDate)}</td>
      </tr>`,
      )
      .join('')}</tbody></table>
    <div class="panel-body muted" style="font-size:12.5px">
      ${fmtNum(data.totalMessages)} messages analysés (index local — instantané).
      Coche des expéditeurs pour les exporter en contacts (.vcf/.csv).</div>`;

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
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal">
    <div class="modal-head"><h2>🧹 Nettoyer « ${esc(senderName)} »</h2>
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
  // Sélection par défaut : uniquement les mails clairement automatiques.
  const selected = new Set(autos.map((m) => m.uid));

  $('#modal-body').innerHTML = `
    <p>Mails de <strong>${esc(sender)}</strong> (dossier ${esc(preview.folder)}) :</p>
    <div class="preview-grid">
      <div class="preview-item"><div class="lbl">Mails au total</div><div class="val">${fmtNum(preview.count)}</div></div>
      <div class="preview-item"><div class="lbl">Taille totale</div><div class="val">${fmtSize(preview.totalSizeBytes)}</div></div>
      <div class="preview-item"><div class="lbl">Plus ancien</div><div class="val" style="font-size:13px">${fmtDate(preview.oldestMessageAt)}</div></div>
      <div class="preview-item"><div class="lbl">Plus récent</div><div class="val" style="font-size:13px">${fmtDate(preview.newestMessageAt)}</div></div>
    </div>

    <div class="cat-toggle">
      <label><input type="checkbox" id="cat-auto" checked>
        🤖 <strong>Automatiques</strong> (${fmtNum(autos.length)}) — lien de désinscription ou expéditeur noreply</label>
      <label><input type="checkbox" id="cat-perso">
        👤 <strong>Possiblement personnels</strong> (${fmtNum(persos.length)}) — répondu, suivi, conversation,
        ou sans marqueur automatique. <strong>Décochés par défaut.</strong></label>
    </div>

    <button class="btn btn-sm" id="toggle-list">📋 Voir la liste complète (${fmtNum(list.messages.length)})</button>
    ${list.truncated ? `<span class="muted" style="font-size:12px"> (${fmtNum(list.total)} au total, affichage limité à ${fmtNum(list.messages.length)})</span>` : ''}
    <div class="mail-list hidden" id="mail-list">
      ${list.messages.map((m) => `
        <label class="mail-row ${m.kind}">
          <input type="checkbox" data-uid="${m.uid}" data-kind="${m.kind}" ${m.kind === 'auto' ? 'checked' : ''}>
          <span class="mail-date">${fmtDate(m.date)}</span>
          <span class="mail-subject" title="${esc(m.signals.join(' · '))}">${esc(m.subject)}</span>
          <span class="badge ${m.kind === 'auto' ? 'gray' : 'blue'}">${m.kind === 'auto' ? '🤖 auto' : '👤 perso'}</span>
          ${m.isSeen ? '' : '<span class="badge orange">non lu</span>'}
        </label>`).join('')}
    </div>
    <div class="trash-note">🛟 Soft delete uniquement : les mails cochés vont dans la corbeille Outlook et restent
      récupérables ~30 jours. Lots de 200, chaque lot journalisé avec la liste exacte des mails.</div>`;

  $('#modal-foot').innerHTML = `
    <button class="btn" id="modal-cancel">Annuler</button>
    <button class="btn btn-green" id="modal-confirm"></button>`;
  $('#modal-cancel').addEventListener('click', closeModal);

  const confirmBtn = $('#modal-confirm');
  const updateConfirm = () => {
    confirmBtn.textContent = `Déplacer ${fmtNum(selected.size)} mails vers la corbeille`;
    confirmBtn.disabled = selected.size === 0;
  };
  updateConfirm();

  $('#toggle-list').addEventListener('click', () => $('#mail-list').classList.toggle('hidden'));

  const rowBoxes = [...overlay.querySelectorAll('.mail-row input[type=checkbox]')];
  const syncCategoryBox = (kind) => {
    const boxes = rowBoxes.filter((b) => b.dataset.kind === kind);
    const box = kind === 'auto' ? $('#cat-auto') : $('#cat-perso');
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
      ${r.duplicateOf ? `<div class="notice warn">⚠️ Cette adresse est <strong>déjà enrôlée</strong>
        sous le nom « ${esc(r.duplicateOf)} » ! Tu as probablement choisi le mauvais compte.
        Refais « Ajouter un compte » avec le même nom <strong>${esc(r.account ?? name)}</strong>
        et choisis « Utiliser un autre compte » dans la fenêtre Microsoft.</div>` : ''}
      <p class="muted" style="margin-top:10px; font-size:12.5px">💡 La synchronisation peut aussi se
      lancer plus tard depuis la page de la boîte — tu peux enchaîner l'ajout de tes autres comptes.</p>`;
    $('.modal-foot').innerHTML = `
      <button class="btn" id="enroll-another">＋ Ajouter une autre boîte</button>
      <button class="btn" id="enroll-close">Fermer</button>
      <button class="btn btn-primary" id="enroll-sync">🔄 Synchroniser maintenant</button>`;
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
          zone.innerHTML = `<div class="notice warn">❌ Échec de l'enrôlement : ${esc(ev.data.error ?? '')}<br>
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
          zone.innerHTML = `<div class="notice warn">❌ Échec de l'enrôlement : ${esc(j.error ?? '')}<br>
            <span class="muted" style="font-size:12px">Causes fréquentes : code expiré (15 min),
            connexion refusée, ou mauvaise boîte utilisée. Tu peux réessayer.</span></div>`;
          $('#enroll-form').classList.remove('hidden');
        }
      }
    }, 1500);
  });
}

// ---------------------------------------------------------------- Réponses en attente
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
    <div><h1>↩️ Réponses en attente</h1>
      <div class="sub">Mails reçus qui attendent une réponse de ta part — détectés depuis l'index local
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
      Si les boîtes ne sont pas encore indexées, lance d'abord une synchronisation.</div>`;
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
        ${t.label} <span class="badge ${t.key === 'overdue' && t.n > 0 ? 'red' : 'gray'}">${fmtNum(t.n)}</span></button>`,
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
    <div><h1>⏰ Relances à faire</h1>
      <div class="sub">Mails que TU as envoyés, restés sans réponse : le correspondant à relancer est
      indiqué. Détecté depuis l'index local (destinataires no-reply exclus) — synchronise tes boîtes
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
      Si les boîtes ne sont pas encore indexées, lance d'abord une synchronisation.</div>`;
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
        ${t.label} <span class="badge ${t.key === 'overdue' && t.n > 0 ? 'red' : 'gray'}">${fmtNum(t.n)}</span></button>`,
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
      ? `<select class="followup-snooze" ${ident} title="Cacher ce fil quelques jours, puis il revient">
           <option value="">⏰ Reporter…</option>
           <option value="1">1 jour</option><option value="3">3 jours</option>
           <option value="7">7 jours</option><option value="30">30 jours</option>
         </select>
         <button class="btn btn-sm followup-dismiss" ${ident} title="Relance envoyée ou plus nécessaire">✓ Traité</button>`
      : `<button class="btn btn-sm followup-restore" ${ident}>↩︎ Remettre en liste</button>`) +
    `<button class="btn btn-sm openable-btn" data-open="${idx}">📖 Lire</button>`;
  const stateInfo =
    i.state === 'snoozed'
      ? `<span class="badge blue">reportée jusqu'au ${fmtDate(i.snoozedUntil)}</span>`
      : i.state === 'dismissed'
        ? '<span class="badge gray">traitée</span>'
        : i.overdue
          ? `<span class="badge red">⏰ à relancer — sans réponse depuis ${waitLabel(i.waitingHours)}</span>`
          : `<span class="badge gray">sans réponse depuis ${waitLabel(i.waitingHours)}</span>`;
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

// ---------------------------------------------------------------- Mails importants
const importantState = { sinceDays: 30, minScore: 40, includeRead: false, data: null };

// Pastille de score colorée : rouge ≥ 70, orange 40-69, gris < 40.
function scoreBadge(score) {
  const cls = score >= 70 ? 'high' : score >= 40 ? 'medium' : 'low';
  return `<span class="score-pill ${cls}" title="Score d'importance sur 100">${score}</span>`;
}

async function renderImportant() {
  const main = $('#main');
  main.innerHTML = `<div class="page-head">
    <div><h1>⭐ Mails importants</h1>
      <div class="sub">Chaque mail reçu est noté sur 100 par des règles simples (banque/administration,
      urgence, vraie personne, question, montant…) — les raisons sont affichées sous chaque mail.
      Détecté depuis l'index local : synchronise tes boîtes pour des résultats à jour.</div></div>
    <div class="head-actions">
      <select id="important-minscore" title="Score minimal affiché">
        ${[[40, 'Score ≥ 40'], [50, 'Score ≥ 50'], [70, 'Score ≥ 70 (haute importance)']]
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
      Si les boîtes ne sont pas encore indexées, lance d'abord une synchronisation.</div>`;
    return;
  }
  refreshImportantBadge(importantState.data);
  renderImportantBody();
}

function renderImportantBody() {
  const body = $('#important-body');
  const d = importantState.data;
  if (!body || !d) return;

  body.innerHTML = `
    <div class="cards">
      <div class="kpi"><div class="kpi-label">🔴 Importance haute (≥ 70)</div>
        <div class="kpi-value">${fmtNum(d.counts.high)}</div></div>
      <div class="kpi orange"><div class="kpi-label">🟠 Importance moyenne (40-69)</div>
        <div class="kpi-value">${fmtNum(d.counts.medium)}</div></div>
      <div class="kpi"><div class="kpi-label">⚪ Faible (&lt; 40)</div>
        <div class="kpi-value">${fmtNum(d.counts.low)}</div>
        <div class="kpi-sub">masqués par le filtre de score</div></div>
    </div>
    <div class="panel"><div class="panel-body tight">
      ${d.items.length === 0
        ? `<div class="empty">Aucun mail à score ≥ ${d.minScore} sur cette période${d.includeRead ? '' : ' (parmi les non-lus)'}. 👍</div>`
        : d.items.map(importantRow).join('')}
    </div></div>
    <div class="panel-body muted" style="font-size:12.5px; padding:0 4px">
      📖 Clique un sujet pour lire le mail ici (et agir : corbeille, déplacer, lu/non lu).
      Le score est indicatif — les raisons listées sous chaque mail expliquent pourquoi il est là.</div>`;

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
        ? '<span class="badge red">importance haute</span>'
        : i.level === 'medium'
          ? '<span class="badge orange">importance moyenne</span>'
          : '<span class="badge gray">importance faible</span>'}
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
    <div><h1>📅 Échéances</h1>
      <div class="sub">Dates limites détectées dans tes mails (paiements, documents à fournir,
      rendez-vous…). Chaque échéance est PROPOSÉE : à toi de la confirmer ou de l'ignorer —
      rien n'est ajouté à un calendrier automatiquement.</div></div>
    <div class="head-actions">
      <label style="display:flex; align-items:center; gap:6px; font-size:12.5px" class="muted"
        title="Lit aussi le CONTENU des mails au sujet évocateur (max 50 par boîte) — plus lent">
        <input type="checkbox" id="deadlines-deep"> analyse approfondie</label>
      <button class="btn btn-primary" id="deadlines-detect">🔍 Analyser mes mails</button>
      <button class="btn" id="deadlines-refresh">↻ Actualiser</button>
    </div></div>
    <div id="deadlines-detect-zone"></div>
    <div id="deadlines-body"><div class="empty"><span class="spinner"></span>Chargement…</div></div>`;
  $('#deadlines-refresh').addEventListener('click', loadDeadlines);
  $('#deadlines-detect').addEventListener('click', runDeadlineDetect);
  await loadDeadlines();
}

async function runDeadlineDetect() {
  const btn = $('#deadlines-detect');
  const zone = $('#deadlines-detect-zone');
  const deep = $('#deadlines-deep').checked;
  btn.disabled = true;
  zone.innerHTML = `<div class="notice"><span class="spinner"></span>
    Détection en cours sur toutes les boîtes${deep ? ' (analyse approfondie — lecture des contenus)' : ''}…
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
      zone.innerHTML = `<div class="notice">✅ Détection terminée :
        <strong>${fmtNum(created)}</strong> nouvelle(s) échéance(s) proposée(s).</div>`;
      btn.disabled = false;
      await loadDeadlines();
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
  const inTab = (x, tab) =>
    tab === 'proposed' ? x.status === 'proposed' && isFuture(x)
    : tab === 'confirmed' ? x.status === 'confirmed' && isFuture(x)
    : tab === 'past' ? (!isFuture(x) && x.status !== 'dismissed') || x.status === 'done'
    : x.status === 'dismissed';
  const tabs = [
    { key: 'proposed', label: 'Proposées', n: d.counts.proposed },
    { key: 'confirmed', label: 'Confirmées', n: d.counts.confirmed },
    { key: 'past', label: 'Passées / faites', n: d.counts.past },
    { key: 'dismissed', label: 'Ignorées', n: d.counts.dismissed },
  ];
  const items = d.items.filter((x) => inTab(x, deadlinesState.tab));
  const emptyMessages = {
    proposed: 'Aucune échéance à valider. Clique « 🔍 Analyser mes mails » pour lancer une détection.',
    confirmed: 'Aucune échéance confirmée à venir.',
    past: 'Aucune échéance passée.',
    dismissed: 'Aucune échéance ignorée.',
  };

  body.innerHTML = `
    <div class="tabs">${tabs
      .map(
        (t) => `<button class="tab ${deadlinesState.tab === t.key ? 'active' : ''}" data-tab="${t.key}">
        ${t.label} <span class="badge ${t.key === 'proposed' && t.n > 0 ? 'red' : 'gray'}">${fmtNum(t.n)}</span></button>`,
      )
      .join('')}</div>
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

// ---------------------------------------------------------------- Tâches (L5.5)
const tasksState = { tab: 'todo', data: null };

async function renderTasks() {
  const main = $('#main');
  main.innerHTML = `<div class="page-head">
    <div><h1>☑️ Tâches</h1>
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
        ${t.label} <span class="badge ${t.key === 'todo' && d.counts.overdue > 0 ? 'red' : 'gray'}">${fmtNum(t.n)}</span></button>`,
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
  folder: '',
  offset: 0,
  pageSize: 50,
  unseen: false,
  attachments: false,
  data: null,
  folders: [],
  selected: new Set(), // clés `compte|dossier|uid` (page courante uniquement)
};

const isUnifiedInbox = () => inboxState.account === '';
const inboxKey = (i) => `${i.account}|${i.folder}|${i.uid}`;

async function renderInbox(slugFromHash) {
  const main = $('#main');
  const accounts = (overviewCache?.enrolled ?? []).map((e) => e.account);
  if (accounts.length === 0) {
    main.innerHTML = `<div class="page-head"><div><h1>📥 Boîte de réception</h1></div></div>
      <div class="notice warn">Aucun compte enrôlé.</div>`;
    return;
  }
  if (slugFromHash && accounts.includes(slugFromHash)) inboxState.account = slugFromHash;
  if (inboxState.account && !accounts.includes(inboxState.account)) {
    inboxState.account = ''; // compte disparu → retour à la vue unifiée
  }

  main.innerHTML = `<div class="page-head">
    <div><h1>📥 Boîte de réception</h1>
      <div class="sub">Tous les mails du dossier, page par page (index local — instantané).
      Clique un mail pour le lire ; coche pour agir en masse. Synchronise pour des résultats à jour.</div></div>
    <div class="head-actions">
      <select id="inbox-account" title="Boîte">
        <option value="" ${inboxState.account === '' ? 'selected' : ''}>🌐 Toutes les boîtes</option>
        ${accounts
          .map((a) => `<option value="${esc(a)}" ${a === inboxState.account ? 'selected' : ''}>${esc(a)}</option>`)
          .join('')}</select>
      <select id="inbox-folder" title="Dossier"></select>
      <label style="display:flex; align-items:center; gap:6px; font-size:12.5px" class="muted">
        <input type="checkbox" id="inbox-unseen" ${inboxState.unseen ? 'checked' : ''}> non lus</label>
      <label style="display:flex; align-items:center; gap:6px; font-size:12.5px" class="muted"
        title="Seuls les mails indexés depuis la version « pièces jointes » portent l'info 📎 — les plus anciens apparaîtront après une resynchronisation complète.">
        <input type="checkbox" id="inbox-attachments" ${inboxState.attachments ? 'checked' : ''}> 📎 avec PJ</label>
      <button class="btn" id="inbox-refresh">↻ Actualiser</button>
      <button class="btn btn-primary" id="inbox-compose">✉️ Nouveau mail</button>
    </div></div>
    <div id="inbox-notice"></div>
    <div id="inbox-body"><div class="empty"><span class="spinner"></span>Chargement…</div></div>`;

  $('#inbox-account').addEventListener('change', async (e) => {
    inboxState.account = e.target.value;
    localStorage.setItem('bm.inboxAccount', inboxState.account);
    inboxState.folder = '';
    inboxState.offset = 0;
    inboxState.selected.clear();
    await loadInboxFolders();
    loadInbox();
  });
  $('#inbox-folder').addEventListener('change', (e) => {
    inboxState.folder = e.target.value;
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
    sel.innerHTML = '<option value="">📥 INBOX de toutes les boîtes</option>';
    sel.disabled = true;
    inboxState.folder = '';
    inboxState.folders = [];
    return;
  }
  sel.disabled = false;
  sel.innerHTML = '<option>…</option>';
  try {
    const { folders } = await api.folders(inboxState.account);
    inboxState.folders = folders;
    const usable = folders.filter((f) => f.messageCount > 0 || f.role === 'inbox');
    if (!inboxState.folder) {
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

async function loadInbox() {
  const body = $('#inbox-body');
  if (!body) return;
  body.innerHTML = '<div class="empty"><span class="spinner"></span>Chargement…</div>';
  try {
    inboxState.data = isUnifiedInbox()
      ? await api.messagesUnified({
          offset: inboxState.offset,
          limit: inboxState.pageSize,
          unseen: inboxState.unseen,
          attachments: inboxState.attachments,
        })
      : await api.listMessages(inboxState.account, {
          folder: inboxState.folder,
          offset: inboxState.offset,
          limit: inboxState.pageSize,
          unseen: inboxState.unseen,
          attachments: inboxState.attachments,
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
  renderInboxBody();
}

function renderInboxBody() {
  const body = $('#inbox-body');
  const d = inboxState.data;
  if (!body || !d) return;
  const sel = inboxState.selected;
  const pageEnd = Math.min(d.offset + d.items.length, d.total);

  body.innerHTML = `
    <div id="inbox-bulkbar" class="export-bar ${sel.size ? '' : 'hidden'}"></div>
    <div class="panel"><div class="panel-body tight">
      ${d.items.length === 0
        ? `<div class="empty">${
            inboxState.attachments
              ? 'Aucun mail avec pièce jointe ici. NB : seuls les mails indexés depuis la version « pièces jointes » portent cette info — une resynchronisation complète la pose sur les nouveaux arrivages.'
              : inboxState.unseen ? 'Aucun mail non lu dans ce dossier. 🎉' : 'Dossier vide (ou pas encore indexé).'
          }</div>`
        : `<table><thead><tr>
            <th style="width:30px"><input type="checkbox" id="inbox-check-all" title="Cocher la page"></th>
            <th style="width:100px">Date</th>
            ${isUnifiedInbox() ? '<th style="width:110px">Boîte</th>' : ''}
            <th style="width:220px">Expéditeur</th><th>Sujet</th><th></th>
          </tr></thead>
          <tbody>${d.items
            .map(
              (i, k) => `<tr class="${i.isSeen ? '' : 'unread-row'}">
              <td style="box-shadow: inset 3px 0 ${accountColor(i.account)}"><input type="checkbox" class="inbox-check" data-key="${esc(inboxKey(i))}" ${sel.has(inboxKey(i)) ? 'checked' : ''}></td>
              <td class="muted" style="white-space:nowrap; font-size:12px">${fmtDate(i.date)}</td>
              ${isUnifiedInbox() ? `<td>${accountChip(i.account)}</td>` : ''}
              <td style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:220px"
                title="${esc(i.fromEmail)}">${i.isOutbound ? '<span class="badge gray">envoyé</span> ' : ''}${esc(i.fromName || i.fromEmail)}</td>
              <td><span class="openable ${i.isSeen ? '' : 'unread-subject'}" data-open="${k}" title="Lire le mail">${esc(i.subject)}</span></td>
              <td style="white-space:nowrap">${i.hasAttachments ? `<span class="badge gray" title="${i.attachmentCount} pièce(s) jointe(s)">📎${i.attachmentCount > 1 ? i.attachmentCount : ''}</span>` : ''}
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

  body.querySelectorAll('[data-open]').forEach((el) => {
    el.addEventListener('click', () => {
      const i = d.items[Number(el.dataset.open)];
      openReaderFor(i, {
        onSeen: (_, seen) => { i.isSeen = seen; renderInboxBody(); },
        onRemoved: () => loadInbox(),
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
  body.querySelectorAll('.inbox-check').forEach((box) => {
    box.addEventListener('change', () => {
      if (box.checked) sel.add(box.dataset.key);
      else sel.delete(box.dataset.key);
      renderInboxBulkbar();
    });
  });
  renderInboxBulkbar();
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
    <button class="btn btn-sm" id="bulk-delete" style="color:var(--red)">🗑️ Corbeille</button>
    ${isUnifiedInbox() ? '' : `<select id="bulk-move"><option value="">📦 Déplacer vers…</option>
      ${others.map((f) => `<option value="${esc(f.path)}">${esc(f.path)}</option>`).join('')}</select>`}
    <button class="btn btn-sm" id="bulk-seen">Marquer lus</button>
    <button class="btn btn-sm" id="bulk-unseen">Marquer non lus</button>
    <button class="btn btn-sm" id="bulk-clear">Tout décocher</button>
    ${isUnifiedInbox() ? '<span class="muted" style="font-size:12px">(déplacement : choisir une boîte précise — les dossiers diffèrent selon les comptes)</span>' : ''}`;

  const run = async (action, destination) => {
    const n = inboxState.selected.size;
    if (action === 'delete' &&
        !confirm(`Déplacer ${n} mail(s) vers la corbeille ?\n(Récupérable ~30 jours dans Outlook — jamais de suppression définitive.)`)) return;
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
      for (const [gk, uids] of groups) {
        const [acct, folder] = gk.split('|');
        const r = await api.bulkAction(acct, { folder, uids, action, destination });
        moved += r.moved ?? 0;
        count += r.count ?? 0;
        skipped += r.skipped ?? 0;
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
const searchState = {
  q: '',
  account: '',
  folder: '',
  from: '',
  subject: '',
  since: '',
  before: '',
  unseen: false,
  attachments: false,
  showFilters: false,
  data: null,
  searched: false,
};

const FOLDER_LABELS = { inbox: '📥', sent: '📤 envoyés', trash: '🗑️ corbeille', spam: '⚠️ spam', archive: '📦 archive', drafts: '📝 brouillons' };

function folderBadge(i) {
  if (i.folderRole === 'inbox') return '';
  const label = FOLDER_LABELS[i.folderRole] ?? esc(i.folder);
  return `<span class="badge gray">${label}</span>`;
}

async function renderSearch() {
  const main = $('#main');
  const accounts = (overviewCache?.enrolled ?? []).map((e) => e.account);
  main.innerHTML = `<div class="page-head">
    <div><h1>🔎 Recherche</h1>
      <div class="sub">Cherche dans toutes tes boîtes d'un coup (index local — instantané), puis clique un mail
      pour le lire ici, sans ouvrir Outlook. Synchronise tes boîtes pour des résultats à jour.</div></div></div>
    <form class="search-bar" id="search-form">
      <input type="search" id="s-q" placeholder="Sujet, expéditeur, adresse… (ex. facture, EDF, marie)"
        value="${esc(searchState.q)}" autocomplete="off">
      <button type="submit" class="btn btn-primary">🔎 Rechercher</button>
      <button type="button" class="btn" id="s-toggle-filters">${searchState.showFilters ? 'Masquer les filtres' : '⚙️ Filtres'}</button>
    </form>
    <div class="search-filters ${searchState.showFilters ? '' : 'hidden'}" id="search-filters">
      <label>Boîte <select id="s-account">
        <option value="">toutes</option>
        ${accounts.map((a) => `<option value="${esc(a)}" ${a === searchState.account ? 'selected' : ''}>${esc(a)}</option>`).join('')}
      </select></label>
      <label>Dossier <input type="text" id="s-folder" placeholder="tous (ex. INBOX)" value="${esc(searchState.folder)}" style="width:130px"></label>
      <label>Expéditeur <input type="text" id="s-from" placeholder="nom ou adresse" value="${esc(searchState.from)}" style="width:150px"></label>
      <label>Sujet <input type="text" id="s-subject" placeholder="contient…" value="${esc(searchState.subject)}" style="width:150px"></label>
      <label>Du <input type="date" id="s-since" value="${esc(searchState.since)}"></label>
      <label>Au <input type="date" id="s-before" value="${esc(searchState.before)}"></label>
      <label><input type="checkbox" id="s-unseen" ${searchState.unseen ? 'checked' : ''}> non lus seulement</label>
      <label title="Info posée à la synchronisation — les mails indexés avant la version « pièces jointes » ne la portent pas encore.">
        <input type="checkbox" id="s-attachments" ${searchState.attachments ? 'checked' : ''}> 📎 avec pièces jointes</label>
    </div>
    <div id="search-results">${searchState.searched ? '' : `<div class="empty">Tape un mot-clé ci-dessus, ou ouvre les filtres pour chercher par expéditeur ou par date.</div>`}</div>`;

  $('#s-toggle-filters').addEventListener('click', () => {
    searchState.showFilters = !searchState.showFilters;
    $('#search-filters').classList.toggle('hidden', !searchState.showFilters);
    $('#s-toggle-filters').textContent = searchState.showFilters ? 'Masquer les filtres' : '⚙️ Filtres';
  });
  $('#search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    searchState.q = $('#s-q').value.trim();
    searchState.account = $('#s-account').value;
    searchState.folder = $('#s-folder').value.trim();
    searchState.from = $('#s-from').value.trim();
    searchState.subject = $('#s-subject').value.trim();
    searchState.since = $('#s-since').value;
    searchState.before = $('#s-before').value;
    searchState.unseen = $('#s-unseen').checked;
    searchState.attachments = $('#s-attachments').checked;
    runSearch();
  });

  // Résultats encore en mémoire (retour sur l'écran) : on les réaffiche.
  if (searchState.data) renderSearchResults();
}

async function runSearch() {
  const el = $('#search-results');
  const hasCriteria =
    searchState.q || searchState.account || searchState.folder || searchState.from ||
    searchState.subject || searchState.since || searchState.before || searchState.unseen ||
    searchState.attachments;
  if (!hasCriteria) {
    el.innerHTML = '<div class="empty">Donne au moins un critère (mot-clé, expéditeur, date…).</div>';
    return;
  }
  el.innerHTML = '<div class="empty"><span class="spinner"></span>Recherche…</div>';
  searchState.searched = true;
  try {
    searchState.data = await api.search({
      q: searchState.q,
      account: searchState.account,
      folder: searchState.folder,
      from: searchState.from,
      subject: searchState.subject,
      since: searchState.since,
      before: searchState.before,
      unseen: searchState.unseen,
      attachments: searchState.attachments,
      limit: 200,
    });
  } catch (err) {
    el.innerHTML = `<div class="notice warn">⚠️ ${esc(err.message)}<br>
      Si les boîtes ne sont pas encore indexées, lance d'abord une synchronisation.</div>`;
    return;
  }
  renderSearchResults();
}

function renderSearchResults() {
  const el = $('#search-results');
  const d = searchState.data;
  if (!el || !d) return;
  if (d.items.length === 0) {
    el.innerHTML = '<div class="empty">Aucun mail trouvé avec ces critères. 🤷</div>';
    return;
  }

  // Groupé par compte, dans l'ordre des résultats (déjà triés par date desc).
  const groups = new Map();
  d.items.forEach((item, idx) => {
    if (!groups.has(item.account)) groups.set(item.account, []);
    groups.get(item.account).push({ item, idx });
  });

  el.innerHTML = `
    <div class="panel-body muted" style="font-size:12.5px; padding:0 4px 8px">
      <strong>${fmtNum(d.total)}</strong> mail(s) trouvé(s)${d.truncated ? ` — les ${fmtNum(d.items.length)} plus récents sont affichés (affine avec les filtres)` : ''}.
    </div>
    ${[...groups.entries()].map(([account, rows]) => `
      <div class="panel">
        <div class="result-group-head">📧 ${esc(account)}
          <span class="badge blue">${fmtNum(rows.length)}</span></div>
        <div class="panel-body tight">
          ${rows.map(({ item: i, idx }) => `
            <div class="result-row ${i.isSeen ? '' : 'unread'}" data-idx="${idx}">
              <span class="mail-date">${fmtDate(i.date)}</span>
              <span class="result-from" title="${esc(i.fromEmail)}">${i.isOutbound ? '<span class="badge gray">envoyé</span> ' : ''}${esc(i.fromName || i.fromEmail)}</span>
              <span class="result-subject">${esc(i.subject)}</span>
              ${i.hasAttachments ? `<span class="badge gray" title="${i.attachmentCount} pièce(s) jointe(s)">📎</span>` : ''}
              ${folderBadge(i)}
              ${i.isSeen ? '' : '<span class="badge orange">non lu</span>'}
            </div>`).join('')}
        </div>
      </div>`).join('')}
    <div class="panel-body muted" style="font-size:12.5px; padding:0 4px">
      🛟 La recherche lit uniquement l'index local. Ouvrir un mail le télécharge en direct depuis la
      boîte ; les actions (corbeille, déplacer…) sont journalisées et le soft delete reste la règle.</div>`;

  el.querySelectorAll('.result-row').forEach((row) => {
    row.addEventListener('click', () => {
      const item = searchState.data.items[Number(row.dataset.idx)];
      if (item) openReader(item, row);
    });
  });
}

// --------------------------------------------------- Panneau de lecture (L3)
// Réutilisé par TOUS les écrans (recherche, importants, réponses, relances,
// échéances, dashboard, brief) : il suffit d'un item {account, folder, uid,
// subject, fromName, fromEmail, date, isSeen} et de deux callbacks optionnels.
function closeReader() {
  document.querySelector('.reader-overlay')?.remove();
  document.querySelector('.reader')?.remove();
  document.querySelector('.result-row.selected')?.classList.remove('selected');
}

async function openReader(item, row, opts = {}) {
  // Par défaut : comportement de l'écran Recherche (rafraîchit ses résultats).
  const onSeen = opts.onSeen ?? (() => renderSearchResults());
  const onRemoved = opts.onRemoved ?? (() => removeItemFromResults(item));
  closeReader();
  row?.classList.add('selected');

  const overlay = document.createElement('div');
  overlay.className = 'reader-overlay';
  overlay.addEventListener('click', closeReader);
  const panel = document.createElement('div');
  panel.className = 'reader';
  panel.innerHTML = `
    <div class="reader-head">
      <h2>${esc(item.subject)}</h2>
      <button class="modal-close" title="Fermer">✕</button>
    </div>
    <div class="reader-meta">
      <div><strong>${esc(item.fromName || item.fromEmail)}</strong>
        <span class="muted">${esc(item.fromEmail)}</span></div>
      <div class="muted">${fmtDateTime(item.date)} · ${esc(item.account)} · dossier ${esc(item.folder)}
        ${item.isSeen ? '' : ' · <span class="badge orange">non lu</span>'}</div>
      <div class="muted" id="reader-to"></div>
    </div>
    <div class="reader-analysis hidden" id="reader-analysis"></div>
    <div class="reader-body" id="reader-body"><div class="empty"><span class="spinner"></span>
      Téléchargement du mail depuis la boîte…</div></div>
    <div class="reader-attachments hidden" id="reader-attachments"></div>
    <div class="reader-actions" id="reader-actions">
      ${smtpEnabled ? `<button class="btn btn-sm btn-primary" id="reader-reply" title="Répondre à l'expéditeur">↩️ Répondre</button>
      <button class="btn btn-sm" id="reader-forward" title="Transférer ce mail à quelqu'un d'autre">➡️ Transférer</button>` : ''}
      <button class="btn btn-sm" id="reader-task" title="Créer une tâche liée à ce mail">☑️ Tâche</button>
      <button class="btn btn-sm" id="reader-toggle-seen">${item.isSeen ? 'Marquer non lu' : 'Marquer lu'}</button>
      <select id="reader-move"><option value="">📦 Déplacer vers…</option></select>
      <button class="btn btn-sm" id="reader-delete" style="color:var(--red)">🗑️ Corbeille</button>
      <span class="muted" style="font-size:11.5px; margin-left:auto">soft delete — récupérable ~30 j</span>
    </div>`;
  document.body.appendChild(overlay);
  document.body.appendChild(panel);
  panel.querySelector('.modal-close').addEventListener('click', closeReader);
  const onKey = (e) => {
    if (e.key === 'Escape') {
      closeReader();
      document.removeEventListener('keydown', onKey);
    }
  };
  document.addEventListener('keydown', onKey);

  // Analyse heuristique du mail (L5.4) : importance, état du fil, échéances
  // trouvées dans le texte affiché. Local, sans IMAP supplémentaire, sans LLM.
  const loadAnalysis = (text) => {
    api.analyzeMessage(item.account, { folder: item.folder, uid: item.uid, text })
      .then((a) => renderReaderAnalysis(a, item))
      .catch(() => {});
  };

  // Corps du mail : lecture IMAP live. En cas d'échec (boîte injoignable),
  // on l'explique proprement — les actions restent disponibles.
  let loadedText = ''; // corps téléchargé, pour la citation dans une réponse
  api.readMessage(item.account, item.folder, item.uid).then((body) => {
    const el = $('#reader-body');
    if (!el) return;
    loadedText = body.text || '';
    el.textContent = body.text || '(mail sans contenu texte)';
    if (body.truncated) {
      const note = document.createElement('div');
      note.className = 'notice warn';
      note.style.marginTop = '14px';
      note.textContent = '✂️ Mail très long : seul le début est affiché ici. L\'original complet reste dans ta boîte.';
      el.appendChild(note);
    }
    if (body.to) {
      const to = $('#reader-to');
      if (to) to.textContent = `À : ${body.to}`;
    }
    if (body.attachments?.length) {
      const az = $('#reader-attachments');
      if (az) {
        az.classList.remove('hidden');
        // Lien direct même origine : le cookie de session part avec la requête,
        // le serveur renvoie Content-Disposition → le navigateur télécharge.
        az.innerHTML = `<strong>📎 ${fmtNum(body.attachments.length)} pièce(s) jointe(s)</strong>
          <span class="muted">(clique pour télécharger)</span>
          ${body.attachments.map((a, ai) => `<div class="att">
            <a class="att-dl" href="${api.attachmentUrl(item.account, item.folder, item.uid, ai)}"
              download="${esc(a.filename || `piece-jointe-${ai + 1}`)}"
              title="Télécharger ${esc(a.filename || 'la pièce jointe')}">⬇️ ${esc(a.filename || 'sans nom')}</a>
            <span class="muted">${fmtSize(a.sizeBytes)}</span></div>`).join('')}`;
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
      injoignable ou mail déplacé). Les infos ci-dessus viennent de l'index local.</div>`;
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

  const doAction = async (btn, action, destination) => {
    btn.disabled = true;
    try {
      await api.messageAction(item.account, { folder: item.folder, uid: item.uid, action, destination });
      return true;
    } catch (err) {
      alert(err.message);
      btn.disabled = false;
      return false;
    }
  };

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
      onRemoved(item);
      closeReader();
    }
  });

  $('#reader-delete').addEventListener('click', async (e) => {
    if (!confirm('Déplacer ce mail vers la corbeille ?\n(Récupérable ~30 jours dans Outlook — jamais de suppression définitive.)')) return;
    if (await doAction(e.target, 'delete')) {
      onRemoved(item);
      closeReader();
    }
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
    });
  });
  $('#reader-task')?.addEventListener('click', () => {
    openTaskModal({
      title: item.subject,
      account: item.account,
      messageRef: { folder: item.folder, uid: item.uid },
    });
  });
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
function openComposeModal({ account, to = '', cc = '', subject = '', text = '', replyRef = null }) {
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
      <textarea id="c-text" rows="12" style="width:100%; margin-top:10px; border:1px solid var(--border); border-radius:8px; padding:10px 12px; font:inherit; resize:vertical"></textarea>
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
  const ta = $('#c-text');
  ta.value = text;
  // Réponse : curseur en haut, au-dessus de la citation.
  ta.focus();
  ta.setSelectionRange(0, 0);

  $('#c-send').addEventListener('click', async () => {
    const toVal = $('#c-to').value.trim();
    const ccVal = $('#c-cc').value.trim();
    const subjectVal = $('#c-subject').value.trim();
    const textVal = ta.value;
    const errEl = $('#c-error');
    errEl.innerHTML = '';
    if (!toVal || !subjectVal || !textVal.trim()) {
      errEl.innerHTML = '<div class="notice warn" style="margin-top:10px">Destinataire, objet et message sont requis.</div>';
      return;
    }
    const nbDest = toVal.split(/[,;]/).filter((s) => s.trim()).length +
      ccVal.split(/[,;]/).filter((s) => s.trim()).length;
    if (!confirm(`Envoyer ce mail à ${nbDest} destinataire(s) depuis ${account} ?`)) return;

    const btn = $('#c-send');
    btn.disabled = true;
    btn.textContent = 'Envoi en cours…';
    try {
      const r = await api.sendMail(account, {
        to: toVal,
        cc: ccVal,
        subject: subjectVal,
        text: textVal,
        replyTo: replyRef ?? undefined,
      });
      $('.modal-body').innerHTML = `<div class="notice">✅ Mail envoyé à
        <strong>${r.sentTo.map(esc).join(', ')}</strong>.<br>
        ${r.copiedTo ? `Copie déposée dans « ${esc(r.copiedTo)} ».`
          : '⚠️ La copie dans « Éléments envoyés » n\'a pas pu être déposée (le mail est bien parti).'}</div>`;
      $('.modal-foot').innerHTML = '<button class="btn btn-primary" id="c-done">Fermer</button>';
      $('#c-done').addEventListener('click', () => {
        closeModal();
        closeReader(); // le mail est traité : on referme aussi le panneau de lecture
        route(); // rafraîchit l'écran (réponses en attente, etc.)
      });
    } catch (err) {
      btn.disabled = false;
      btn.textContent = '✉️ Envoyer';
      errEl.innerHTML = `<div class="notice warn" style="margin-top:10px">❌ ${esc(err.message)}</div>`;
    }
  });
}

// Section « 🤖 Analyse » du panneau de lecture (L5.4) — heuristiques locales.
function renderReaderAnalysis(a, item) {
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
        <span>importance ${a.importance.level === 'high' ? 'haute' : a.importance.level === 'medium' ? 'moyenne' : 'faible'}
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
        <button class="btn btn-sm ra-propose" data-k="${k}">➕ Proposer</button></span>`,
    )
    .join(' ');

  el.innerHTML = `
    <div class="ra-title">🤖 Analyse Mail Assistant <span class="muted" style="font-size:11px">(règles locales — rien n'est envoyé à un service externe)</span></div>
    ${impLine}
    <div class="ra-line"><span class="badge ${replyBadge}">↩️</span> <span>${esc(a.reply.label)}</span></div>
    ${existing || detected
      ? `<div class="ra-line"><span>Échéances :</span> ${existing} ${detected}</div>`
      : ''}`;

  el.querySelectorAll('.ra-propose').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const d = a.deadlines.detected[Number(btn.dataset.k)];
      btn.disabled = true;
      try {
        await api.proposeDeadline(item.account, {
          folder: item.folder,
          uid: item.uid,
          date: d.date,
          type: d.type,
          sourceText: d.sourceText,
        });
        btn.replaceWith(Object.assign(document.createElement('span'), {
          className: 'badge orange',
          textContent: '✓ proposée — à valider dans 📅 Échéances',
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
function openReaderFor(src, { onSeen, onRemoved } = {}) {
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
    { onSeen: onSeen ?? (() => {}), onRemoved: onRemoved ?? (() => route()) },
  );
}

// Retire un mail supprimé/déplacé de la liste de résultats.
function removeItemFromResults(item) {
  const d = searchState.data;
  if (!d) return;
  const idx = d.items.indexOf(item);
  if (idx >= 0) {
    d.items.splice(idx, 1);
    d.total = Math.max(0, d.total - 1);
  }
  renderSearchResults();
}

// ---------------------------------------------------------------- Journal
async function renderOperations() {
  const main = $('#main');
  main.innerHTML = `<div class="page-head"><div><h1>📜 Journal d'activité</h1>
    <div class="sub">Toutes les opérations d'écriture (Claude et interface), les plus récentes d'abord.</div></div></div>
    <div class="panel"><div class="panel-body" id="ops-body"><span class="spinner"></span></div></div>`;
  const { operations } = await api.operations(100);
  $('#ops-body').innerHTML = operations.length
    ? operations.map(opLine).join('')
    : '<div class="empty">Aucune opération journalisée pour l\'instant.</div>';
}

boot();
