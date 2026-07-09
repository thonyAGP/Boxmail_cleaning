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

$('#add-account-btn').addEventListener('click', openEnrollModal);

// Compte dont la sync doit démarrer automatiquement à l'ouverture de sa vue
// (après un enrôlement réussi).
let pendingAutoSync = null;

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

  bindCleanupButtons(body);
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
        (p.batch ? ` <span class="muted">(lot ${esc(p.batch)})</span>` : '');
      break;
    case 'bulk_delete_by_sender':
      title = `🗑️ <strong>${fmtNum(n)} mails</strong> de <strong>${senderLabel}</strong> → corbeille <span class="muted">(via Claude)</span>`;
      break;
    case 'delete_emails':
      title = `🗑️ <strong>${fmtNum(n)} mails</strong> → corbeille <span class="muted">(via Claude)</span>`;
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

  // Sync automatique juste après un enrôlement réussi.
  if (pendingAutoSync === slug) {
    pendingAutoSync = null;
    runSync(slug, 'full');
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
          $('#modal-body').innerHTML =
            j.status === 'done'
              ? `<div class="notice">✅ <strong>${fmtNum(r.deleted ?? 0)}</strong> mails déplacés vers
                 <strong>${esc(r.destination || 'la corbeille')}</strong> en ${fmtNum(r.batches ?? 0)} lot(s).
                 Récupérables ~30 jours dans Outlook.</div>`
              : `<div class="notice warn">❌ Échec : ${esc(j.error ?? '')}</div>`;
          $('#modal-foot').innerHTML = `<button class="btn btn-primary" id="modal-done">Fermer</button>`;
          $('#modal-done').addEventListener('click', async () => {
            closeModal();
            await refreshOverview();
            route();
          });
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
        <button type="submit" class="btn btn-primary">Obtenir le code</button>
      </form>
      <p class="muted" style="margin-top:12px; font-size:12.5px">
        Étape suivante : Microsoft affichera un code à saisir sur
        <strong>microsoft.com/devicelogin</strong>, où tu te connecteras avec la boîte
        Hotmail/Outlook <strong>à ajouter</strong> (pas ton compte principal, sauf si
        c'est celui-là). Le mot de passe ne passe jamais par cette page.</p>
      <div id="enroll-zone"></div>
    </div>
    <div class="modal-foot"><button class="btn" id="enroll-cancel">Fermer</button></div>
  </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('.modal-close').addEventListener('click', closeModal);
  $('#enroll-cancel').addEventListener('click', closeModal);

  $('#enroll-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#enroll-name').value.trim();
    const zone = $('#enroll-zone');
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
            <div class="lbl">1. Ouvre cette page :</div>
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
          const r = j.result ?? {};
          zone.innerHTML = `<div class="notice">✅ <strong>${esc(r.username ?? '')}</strong> ajouté sous le nom
            <strong>${esc(r.account ?? name)}</strong>.</div>`;
          $('.modal-foot').innerHTML = `
            <button class="btn" id="enroll-close">Fermer</button>
            <button class="btn btn-primary" id="enroll-sync">🔄 Synchroniser cette boîte maintenant</button>`;
          $('#enroll-close').addEventListener('click', async () => {
            closeModal();
            await refreshOverview();
          });
          $('#enroll-sync').addEventListener('click', async () => {
            closeModal();
            await refreshOverview();
            pendingAutoSync = r.account ?? name;
            location.hash = `#/account/${encodeURIComponent(r.account ?? name)}`;
            if (location.hash === `#/account/${encodeURIComponent(r.account ?? name)}`) route();
          });
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
