import { api, fmtSize, fmtDate, fmtDateTime, fmtNum, esc } from './api.js';

/**
 * Mail Assistant — SPA sans framework.
 * Routage par hash : #/dashboard, #/account/<slug>, #/operations
 * Pass 1 : login, tableau de bord, stats expéditeurs, sync avec progression.
 */

const $ = (sel, root = document) => root.querySelector(sel);
let overviewCache = null;

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
  await refreshOverview();
  route();
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

// ---------------------------------------------------------------- Sidebar
async function refreshOverview() {
  overviewCache = await api.overview();
  const nav = $('#accounts-nav');
  const bySlug = new Map(overviewCache.accounts.map((a) => [a.account, a]));
  const items = overviewCache.enrolled.map((e) => {
    const ov = bySlug.get(e.account);
    const unseen = ov?.inbox?.unseen;
    return `<a href="#/account/${esc(e.account)}" class="side-link" data-account="${esc(e.account)}">
      📧 <span class="account-email" title="${esc(e.username)}">${esc(e.account)}</span>
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
  } else {
    renderDashboard();
  }
}

// ---------------------------------------------------------------- Dashboard
async function renderDashboard() {
  const main = $('#main');
  main.innerHTML = `<div class="page-head"><div><h1>Bonjour 👋</h1>
    <div class="sub">Voici ce qui se passe dans vos boîtes.</div></div>
    <div class="head-actions"><button class="btn" id="refresh-btn">🔄 Actualiser</button></div></div>
    <div id="dash-body"><div class="empty"><span class="spinner"></span>Chargement…</div></div>`;
  $('#refresh-btn').addEventListener('click', async () => {
    await refreshOverview();
    renderDashboard();
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
          <table><thead><tr><th>Expéditeur</th><th class="num">Mails</th><th class="num">Taille</th><th>Risque</th></tr></thead>
          <tbody>${allCandidates.slice(0, 8).map((c) => `<tr>
            <td>${esc(c.senderName || c.sender)}<br><span class="muted" style="font-size:12px">${esc(c.sender)} · ${esc(c.account)}</span></td>
            <td class="num">${fmtNum(c.messageCount)}</td>
            <td class="num">${fmtSize(c.totalSizeBytes)}</td>
            <td><span class="badge ${c.riskLevel === 'safe' ? 'green' : 'orange'}">${c.riskLevel === 'safe' ? 'Sûr' : 'Moyen'}</span></td>
          </tr>`).join('')}</tbody></table>
          <div class="panel-body muted" style="font-size:12.5px">La suppression depuis l'interface arrive à la
          prochaine passe — en attendant, passer par Claude Cowork (dry-run puis confirmation).</div>`}
        </div>
      </div>
    </div>

    <div class="grid-2">
      <div class="panel placeholder-card">
        <div class="panel-head"><h2>⭐ Mails importants &nbsp;·&nbsp; ↩️ Réponses en attente &nbsp;·&nbsp; 📅 Échéances</h2>
        <span class="badge gray">Phase 4 — bientôt</span></div>
        <div class="panel-body muted">La détection intelligente (importance, réponses oubliées,
        relances, échéances) arrive dans la prochaine étape du projet, sur la base de l'index
        déjà en place.</div>
      </div>
      <div class="panel">
        <div class="panel-head"><h2>Activité récente</h2>
          <a class="btn btn-sm" href="#/operations">Voir tout</a></div>
        <div class="panel-body" id="dash-ops"><span class="spinner"></span></div>
      </div>
    </div>`;

  api.operations(6).then(({ operations }) => {
    const el = $('#dash-ops');
    if (!el) return;
    el.innerHTML = operations.length
      ? operations.map(opLine).join('')
      : '<div class="empty">Aucune opération pour l\'instant.</div>';
  });
}

function opLine(op) {
  const label = {
    create_folder: '📁 Dossier créé',
    move_emails: '📦 Mails déplacés',
    mark_emails: '🏷️ Flags modifiés',
    delete_emails: '🗑️ Suppression',
    bulk_delete_by_sender: '🗑️ Suppression par expéditeur',
  }[op.tool] ?? `⚙️ ${op.tool ?? 'opération'}`;
  return `<div class="op-line"><span class="op-time">${fmtDateTime(op.ts)}</span>
    <span>${label} — <strong>${esc(op.account ?? '')}</strong>
    ${op.dryRun ? '<span class="badge gray">dry-run</span>' : ''}
    <span class="muted">${esc(op.result ?? '')}</span></span></div>`;
}

// ---------------------------------------------------------------- Vue compte
const statsState = { sortKey: 'count', sortDir: -1, data: null };

async function renderAccount(slug) {
  const main = $('#main');
  const enrolled = overviewCache?.enrolled.find((e) => e.account === slug);
  main.innerHTML = `<div class="page-head">
      <div><h1>📧 ${esc(slug)}</h1><div class="sub">${esc(enrolled?.username ?? '')}</div></div>
      <div class="head-actions">
        <button class="btn" id="sync-recent">⚡ Sync rapide</button>
        <button class="btn btn-primary" id="sync-full">🔄 Sync complète</button>
      </div></div>
    <div id="sync-zone"></div>
    <div id="account-body"><div class="empty"><span class="spinner"></span>Chargement…</div></div>`;

  $('#sync-recent').addEventListener('click', () => runSync(slug, 'recent'));
  $('#sync-full').addEventListener('click', () => runSync(slug, 'full'));

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
    </div>`;

  $('#f-apply').addEventListener('click', () => loadStats(slug));
  await loadStats(slug);
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

  el.innerHTML = `
    <table><thead><tr>
      <th data-sort="address">Expéditeur</th>
      ${th('count', 'Mails')}${th('totalSizeBytes', 'Taille')}${th('unsubscribePct', 'Newsletter')}${th('latestDate', 'Dernier mail')}
    </tr></thead>
    <tbody>${senders
      .map(
        (s) => `<tr>
        <td>${esc(s.name || s.address)}<br><span class="muted" style="font-size:12px">${esc(s.address)}</span></td>
        <td class="num"><strong>${fmtNum(s.count)}</strong></td>
        <td class="num">${fmtSize(s.totalSizeBytes)}</td>
        <td class="num">${s.unsubscribePct > 0 ? `<span class="badge ${s.unsubscribePct >= 80 ? 'orange' : 'gray'}">${s.unsubscribePct}%</span>` : '—'}</td>
        <td class="num">${fmtDate(s.latestDate)}</td>
      </tr>`,
      )
      .join('')}</tbody></table>
    <div class="panel-body muted" style="font-size:12.5px">
      ${fmtNum(data.totalMessages)} messages analysés (index local — instantané).</div>`;

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
}

// ---------------------------------------------------------------- Sync + jobs
async function runSync(slug, mode) {
  const zone = $('#sync-zone');
  zone.innerHTML = `<div class="notice"><span class="spinner"></span>
    Synchronisation <strong>${mode === 'full' ? 'complète' : 'rapide'}</strong> de ${esc(slug)} en cours…
    <div class="sync-log" id="sync-log"></div></div>`;
  let job;
  try {
    ({ jobId: job } = await api.startSync(slug, mode));
  } catch (err) {
    zone.innerHTML = `<div class="notice warn">⚠️ ${esc(err.message)}</div>`;
    return;
  }
  const log = $('#sync-log');
  const timer = setInterval(async () => {
    try {
      const j = await api.job(job);
      log.textContent = j.progress.slice(-30).join('\n');
      log.scrollTop = log.scrollHeight;
      if (j.status !== 'running') {
        clearInterval(timer);
        if (j.status === 'done') {
          const r = j.result ?? {};
          zone.innerHTML = `<div class="notice">✅ Sync terminée en ${((r.durationMs ?? 0) / 1000).toFixed(1)}s —
            ${fmtNum(r.newMessages ?? 0)} nouveaux, ${fmtNum(r.deletedMessages ?? 0)} disparus,
            ${fmtNum(r.foldersSynced?.length ?? 0)} dossiers.</div>`;
          await refreshOverview();
          renderAccount(slug);
        } else {
          zone.innerHTML = `<div class="notice warn">❌ Échec de la sync : ${esc(j.error ?? '')}</div>`;
        }
      }
    } catch {
      clearInterval(timer);
    }
  }, 1200);
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
