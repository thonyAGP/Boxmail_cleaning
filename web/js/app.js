import { api, fmtSize, fmtDate, fmtDateTime, fmtNum, esc } from './api.js';

/**
 * Mail Assistant — SPA sans framework.
 * Routage par hash : #/dashboard, #/account/<slug>, #/operations
 * Pass 1 : login, tableau de bord, stats expéditeurs, sync avec progression.
 */

const $ = (sel, root = document) => root.querySelector(sel);
let overviewCache = null;
let serverVersion = null;

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
  } else if (hash.startsWith('#/replies')) {
    document.querySelector('[data-nav="replies"]')?.classList.add('active');
  } else if (hash.startsWith('#/followups')) {
    document.querySelector('[data-nav="followups"]')?.classList.add('active');
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
  } else if (hash.startsWith('#/replies')) {
    renderReplies();
  } else if (hash.startsWith('#/followups')) {
    renderFollowups();
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
        <div class="panel-head"><h2>↩️ Réponses en attente</h2>
          <a class="btn btn-sm" href="#/replies">Voir tout</a></div>
        <div class="panel-body" id="dash-replies"><span class="spinner"></span></div>
        <div class="panel-head"><h2>⏰ Relances à faire</h2>
          <a class="btn btn-sm" href="#/followups">Voir tout</a></div>
        <div class="panel-body" id="dash-followups"><span class="spinner"></span></div>
        <div class="panel-body muted" style="font-size:12px; padding-top:0">
          ⭐ Mails importants et 📅 échéances arrivent dans les prochaines étapes.</div>
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

  // Réponses en attente (top 5, les plus en retard d'abord).
  api.replies().then((d) => {
    refreshRepliesBadge(d);
    const el = $('#dash-replies');
    if (!el) return;
    const top = d.items.filter((i) => i.state === 'active').slice(0, 5);
    el.innerHTML = top.length
      ? top.map((i) => `<div class="op-line">
          <span class="op-time">${fmtDate(i.date)}</span>
          <span style="flex:1"><strong>${esc(i.fromName || i.fromEmail)}</strong> —
            ${esc(i.subject)}
            <span class="muted" style="font-size:12px">· ${esc(i.account)}</span></span>
          ${i.overdue ? `<span class="badge red">en retard</span>` : `<span class="badge gray">${waitLabel(i.waitingHours)}</span>`}
        </div>`).join('') +
        (d.counts.active > 5
          ? `<div class="muted" style="font-size:12px; padding-top:8px">…et ${fmtNum(d.counts.active - 5)} autre(s) — <a href="#/replies">voir tout</a>.</div>`
          : '')
      : '<div class="empty">🎉 Rien en attente de réponse sur les 60 derniers jours.</div>';
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
      ? top.map((i) => `<div class="op-line">
          <span class="op-time">${fmtDate(i.date)}</span>
          <span style="flex:1"><strong>${esc(i.counterpartyName || i.counterpartyEmail)}</strong> —
            ${esc(i.subject)}
            <span class="muted" style="font-size:12px">· ${esc(i.account)}</span></span>
          ${i.overdue ? `<span class="badge red">à relancer</span>` : `<span class="badge gray">${waitLabel(i.waitingHours)}</span>`}
        </div>`).join('') +
        (d.counts.active > 3
          ? `<div class="muted" style="font-size:12px; padding-top:8px">…et ${fmtNum(d.counts.active - 3)} autre(s) — <a href="#/followups">voir tout</a>.</div>`
          : '')
      : '<div class="empty">👍 Personne à relancer sur les 60 derniers jours.</div>';
  }).catch(() => {
    const el = $('#dash-followups');
    if (el) el.innerHTML = '<div class="empty">Index pas encore prêt.</div>';
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
      🛟 « Reporter » et « Ignorer » ne touchent pas aux mails : c'est un simple marque-page local,
      journalisé, et annulable à tout moment depuis les onglets Reportés / Ignorés.
      Un fil ignoré réapparaît si un nouveau mail y arrive.</div>`;

  body.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      repliesState.tab = btn.dataset.tab;
      renderRepliesBody();
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

function replyRow(i) {
  const ident = `data-account="${esc(i.account)}" data-thread="${i.threadId}"`;
  const actions =
    i.state === 'active'
      ? `<select class="reply-snooze" ${ident} title="Cacher ce fil quelques jours, puis il revient">
           <option value="">⏰ Reporter…</option>
           <option value="1">1 jour</option><option value="3">3 jours</option>
           <option value="7">7 jours</option><option value="30">30 jours</option>
         </select>
         <button class="btn btn-sm reply-dismiss" ${ident} title="Pas de réponse nécessaire">🔕 Ignorer</button>`
      : `<button class="btn btn-sm reply-restore" ${ident}>↩︎ Remettre en liste</button>`;
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
        <span class="badge blue">${esc(i.account)}</span>
        ${i.isSeen ? '' : '<span class="badge orange">non lu</span>'}
      </div>
      <div class="reply-subject">${esc(i.subject)}
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
      🛟 « Reporter » et « Traité » ne touchent pas aux mails : simple marque-page local, journalisé,
      annulable depuis les onglets Reportées / Traitées. Un fil marqué traité réapparaît si un
      nouveau message y arrive.</div>`;

  body.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      followupsState.tab = btn.dataset.tab;
      renderFollowupsBody();
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

function followupRow(i) {
  const ident = `data-account="${esc(i.account)}" data-thread="${i.threadId}"`;
  const actions =
    i.state === 'active'
      ? `<select class="followup-snooze" ${ident} title="Cacher ce fil quelques jours, puis il revient">
           <option value="">⏰ Reporter…</option>
           <option value="1">1 jour</option><option value="3">3 jours</option>
           <option value="7">7 jours</option><option value="30">30 jours</option>
         </select>
         <button class="btn btn-sm followup-dismiss" ${ident} title="Relance envoyée ou plus nécessaire">✓ Traité</button>`
      : `<button class="btn btn-sm followup-restore" ${ident}>↩︎ Remettre en liste</button>`;
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
        <span class="badge blue">${esc(i.account)}</span>
        ${i.hasInbound ? '' : '<span class="badge gray">premier contact</span>'}
      </div>
      <div class="reply-subject">${esc(i.subject)}
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
