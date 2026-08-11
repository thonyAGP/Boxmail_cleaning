// Client API minimal — toutes les requêtes passent par /api (session cookie).

// Indicateur d'activité réseau global : chaque requête (ou téléchargement)
// incrémente un compteur ; l'interface affiche une barre de chargement tant
// qu'il est > 0. Un seul branchement → un loader sur TOUS les écrans.
let inFlight = 0;
function activityBegin() {
  inFlight += 1;
  if (inFlight === 1) window.dispatchEvent(new CustomEvent('api-activity', { detail: { active: true } }));
}
function activityEnd() {
  inFlight = Math.max(0, inFlight - 1);
  if (inFlight === 0) window.dispatchEvent(new CustomEvent('api-activity', { detail: { active: false } }));
}

async function request(method, path, body) {
  activityBegin();
  try {
    const res = await fetch(`/api${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* réponse vide */
    }
    if (!res.ok) {
      const err = new Error(data?.error || `Erreur ${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  } finally {
    activityEnd();
  }
}

export const api = {
  me: () => request('GET', '/me'),
  login: (password) => request('POST', '/login', { password }),
  logout: () => request('POST', '/logout'),
  overview: () => request('GET', '/overview'),
  accountOverview: (slug) => request('GET', `/accounts/${encodeURIComponent(slug)}/overview`),
  folders: (slug) => request('GET', `/accounts/${encodeURIComponent(slug)}/folders`),
  stats: (slug, { folder = 'INBOX', limit = 50, since = '' } = {}) => {
    const q = new URLSearchParams({ folder, limit: String(limit) });
    if (since) q.set('since', since);
    return request('GET', `/accounts/${encodeURIComponent(slug)}/stats?${q}`);
  },
  today: () => request('GET', '/today'),
  // Dépouillement du courrier entrant (Lot 1).
  reviewSummary: () => request('GET', '/review/summary'),
  reviewQueue: () => request('GET', '/review/queue'),
  reviewDecide: (ids, decision) => request('POST', '/review/decide', { ids, decision }),
  reviewValidate: (payload) => request('POST', '/review/validate', payload),
  reviewUndo: (messageId) => request('POST', '/review/undo', { messageId }),
  // Annulation d'une corbeille (bandeau 10 s) : ramène les mails de la
  // corbeille dans leur dossier et les remet au dépouillement.
  reviewRestore: (groups) => request('POST', '/review/restore', { groups }),
  whatsNew: () => request('GET', '/whatsnew'),
  whatsNewSeen: (id) => request('POST', '/whatsnew/' + encodeURIComponent(id) + '/seen'),
  rentilaOverview: () => request('GET', '/rentila/overview'),
  rentilaCommands: (status) => request('GET', '/rentila/commands' + (status ? '?status=' + status : '')),
  rentilaCommandCreate: (payload) => request('POST', '/rentila/commands', payload),
  rentilaCommandApprove: (id) => request('POST', '/rentila/commands/' + id + '/approve'),
  rentilaCommandCancel: (id) => request('POST', '/rentila/commands/' + id + '/cancel'),
  reviewLearning: () => request('GET', '/review/learning'),
  reviewLearningDismiss: (key) => request('POST', '/review/learning/dismiss', { key }),
  suggestions: () => request('GET', '/suggestions'),
  suggestionDismiss: (kind, refKey) => request('POST', '/suggestions/dismiss', { kind, refKey }),
  reviewSample: (n = 10) => request('GET', `/review/sample?n=${n}`),
  reviewFeedback: (payload) => request('POST', '/review/feedback', payload),
  report: () => request('GET', '/report'),
  grandMenage: (policyIds) => request('POST', '/grand-menage', { policyIds }),
  retention: () => request('GET', '/retention'),
  retentionPreview: (id) => request('GET', `/retention/${id}/preview`),
  retentionApply: (id) => request('POST', `/retention/${id}/apply`),
  retentionUpdate: (id, patch) => request('PATCH', `/retention/${id}`, patch),
  todayNoise: (bucket) => request('GET', `/today/noise/${encodeURIComponent(bucket)}`),
  senderSetCategory: (slug, email, category) =>
    request('PATCH', `/accounts/${encodeURIComponent(slug)}/senders`, { email, category }),
  senderSetPriority: (slug, email, priority) =>
    request('PATCH', `/accounts/${encodeURIComponent(slug)}/senders`, { email, priority }),
  categorizeAll: () => request('POST', '/categorize'),
  analysisCoverage: () => request('GET', '/analysis/coverage'),
  snippetsBackfill: (scope = 'recent') => request('POST', '/snippets/backfill', { scope }),
  cleanup: (slug) => request('GET', `/accounts/${encodeURIComponent(slug)}/cleanup`),
  cleanupPreview: (slug, sender, folder = 'INBOX') =>
    request('POST', `/accounts/${encodeURIComponent(slug)}/cleanup/preview`, { sender, folder }),
  cleanupMessages: (slug, sender, folder = 'INBOX') =>
    request(
      'GET',
      `/accounts/${encodeURIComponent(slug)}/cleanup/messages?` +
        new URLSearchParams({ sender, folder }),
    ),
  cleanupExecute: (slug, sender, uids, folder = 'INBOX') =>
    request('POST', `/accounts/${encodeURIComponent(slug)}/cleanup/execute`, {
      sender,
      folder,
      uids,
    }),
  messagesUnified: ({ offset = 0, limit = 50, unseen = false, attachments = false, sort = 'date', dir = 'desc', role = 'inbox', q = '' } = {}) =>
    request(
      'GET',
      `/messages?offset=${offset}&limit=${limit}&sort=${sort}&dir=${dir}&role=${role}` +
        (unseen ? '&unseen=1' : '') +
        (attachments ? '&attachments=1' : '') +
        (q ? `&q=${encodeURIComponent(q)}` : ''),
    ),
  accountSetColor: (slug, color) =>
    request('PATCH', `/accounts/${encodeURIComponent(slug)}`, { color }),
  accountsReorder: (order) => request('PUT', '/accounts/order', { order }),
  accountQuotaRefresh: (slug) =>
    request('POST', `/accounts/${encodeURIComponent(slug)}/quota/refresh`),
  accountRename: (slug, to) =>
    request('POST', `/accounts/${encodeURIComponent(slug)}/rename`, { to }),
  accountRemove: (slug) =>
    request('DELETE', `/accounts/${encodeURIComponent(slug)}`),
  startSync: (slug, mode) =>
    request('POST', `/accounts/${encodeURIComponent(slug)}/sync`, { mode }),
  enroll: (account) => request('POST', '/enroll', { account }),
  enrollStart: (account) => request('POST', '/enroll/start', { account }),
  tasks: () => request('GET', '/tasks'),
  taskCreate: (payload) => request('POST', '/tasks', payload),
  taskAction: (id, action) => request('POST', `/tasks/${id}/${action}`),
  deadlines: () => request('GET', '/attention/deadlines'),
  deadlinesDetect: (slug, deep = false, sinceDays = 30) =>
    request('POST', `/accounts/${encodeURIComponent(slug)}/deadlines/detect`, { deep, sinceDays }),
  deadlineAction: (slug, id, action) =>
    request('POST', `/accounts/${encodeURIComponent(slug)}/deadlines/${id}/${action}`),
  search: (params) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '' && v !== false) q.set(k, String(v));
    }
    return request('GET', `/search?${q}`);
  },
  // « Retrouver sans classer » (11/08) : même index, résultat groupé par
  // interlocuteur au lieu d'une liste à plat.
  find: (params) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '' && v !== false) q.set(k, String(v));
    }
    return request('GET', `/find?${q}`);
  },
  attachmentNamesBackfill: () => request('POST', '/attachment-names/backfill'),
  analyzeMessage: (slug, { folder, uid, text }) =>
    request('POST', `/accounts/${encodeURIComponent(slug)}/messages/analysis`, { folder, uid, text }),
  setMessageIntent: (slug, { folder, uid, intent }) =>
    request('PATCH', `/accounts/${encodeURIComponent(slug)}/messages/intent`, { folder, uid, intent }),
  proposeDeadline: (slug, { folder, uid, date, type, sourceText }) =>
    request('POST', `/accounts/${encodeURIComponent(slug)}/messages/propose-deadline`, {
      folder,
      uid,
      date,
      type,
      sourceText,
    }),
  sendMail: (slug, payload) =>
    request('POST', `/accounts/${encodeURIComponent(slug)}/send`, payload),
  listMessages: (slug, { folder = 'INBOX', offset = 0, limit = 50, unseen = false, attachments = false, sort = 'date', dir = 'desc', q = '' } = {}) => {
    const p = new URLSearchParams({ folder, offset: String(offset), limit: String(limit), sort, dir });
    if (unseen) p.set('unseen', '1');
    if (attachments) p.set('attachments', '1');
    if (q) p.set('q', q);
    return request('GET', `/accounts/${encodeURIComponent(slug)}/messages?${p}`);
  },
  bulkAction: (slug, { folder, uids, action, destination }) =>
    request('POST', `/accounts/${encodeURIComponent(slug)}/messages/bulk`, {
      folder,
      uids,
      action,
      destination,
    }),
  // URL directe (même origine, cookie de session).
  attachmentUrl: (slug, folder, uid, index) =>
    `/api/accounts/${encodeURIComponent(slug)}/messages/${encodeURIComponent(folder)}/${uid}/attachments/${index}`,
  // inline=1 → « Voir » : le navigateur affiche (PDF/image) au lieu de télécharger.
  attachmentInlineUrl: (slug, folder, uid, index) =>
    `/api/accounts/${encodeURIComponent(slug)}/messages/${encodeURIComponent(folder)}/${uid}/attachments/${index}?inline=1`,
  // Toutes les pièces jointes en un .zip.
  attachmentsZipUrl: (slug, folder, uid) =>
    `/api/accounts/${encodeURIComponent(slug)}/messages/${encodeURIComponent(folder)}/${uid}/attachments.zip`,
  readMessage: (slug, folder, uid) =>
    request(
      'GET',
      `/accounts/${encodeURIComponent(slug)}/messages/${encodeURIComponent(folder)}/${uid}`,
    ),
  messageAction: (slug, { folder, uid, action, destination }) =>
    request('POST', `/accounts/${encodeURIComponent(slug)}/messages/actions`, {
      folder,
      uid,
      action,
      destination,
    }),
  // Transmet un mail (sa facture) à Fiscal-Manager depuis le lecteur.
  messageToAccounting: (slug, { folder, uid }) =>
    request('POST', `/accounts/${encodeURIComponent(slug)}/messages/to-accounting`, { folder, uid }),
  // Ramène des mails de la corbeille vers leur dossier (bandeau « Annuler »).
  messageRestore: (slug, { folder, uids, trashUids }) =>
    request('POST', `/accounts/${encodeURIComponent(slug)}/messages/restore`, {
      folder,
      uids,
      trashUids,
    }),
  rules: (slug) => request('GET', `/accounts/${encodeURIComponent(slug)}/rules`),
  rulesSuggest: (slug) => request('POST', `/accounts/${encodeURIComponent(slug)}/rules/suggest`),
  ruleCreate: (slug, payload) => request('POST', `/accounts/${encodeURIComponent(slug)}/rules`, payload),
  rulePreview: (slug, id) => request('GET', `/accounts/${encodeURIComponent(slug)}/rules/${id}/preview`),
  ruleApply: (slug, id) => request('POST', `/accounts/${encodeURIComponent(slug)}/rules/${id}/apply`),
  ruleUpdate: (slug, id, patch) => request('PATCH', `/accounts/${encodeURIComponent(slug)}/rules/${id}`, patch),
  ruleDelete: (slug, id) => request('DELETE', `/accounts/${encodeURIComponent(slug)}/rules/${id}`),
  brief: (type = 'daily') => request('GET', `/brief?type=${type}`),
  briefGenerate: (type = 'daily') => request('POST', '/brief/generate', { type }),
  version: () => request('GET', '/version'),
  updateCheck: () => request('GET', '/update/check'),
  updateApply: () => request('POST', '/update/apply'),
  health: () => fetch('/health').then((r) => r.ok),
  job: (id) => request('GET', `/jobs/${encodeURIComponent(id)}`),
  jobs: () => request('GET', '/jobs'),
  syncAll: (mode = 'recent') => request('POST', '/sync-all', { mode }),
  operations: (limit = 30) => request('GET', `/operations?limit=${limit}`),
  replies: (sinceDays = 60) => request('GET', `/attention/replies?sinceDays=${sinceDays}`),
  followups: (sinceDays = 60) => request('GET', `/attention/followups?sinceDays=${sinceDays}`),
  important: (sinceDays = 30, minScore = 40, includeRead = false) =>
    request(
      'GET',
      `/attention/important?sinceDays=${sinceDays}&minScore=${minScore}` +
        (includeRead ? '&includeRead=1' : ''),
    ),
  followupSnooze: (slug, threadId, days) =>
    request(
      'POST',
      `/accounts/${encodeURIComponent(slug)}/attention/followups/${threadId}/snooze`,
      { days },
    ),
  followupDismiss: (slug, threadId) =>
    request('POST', `/accounts/${encodeURIComponent(slug)}/attention/followups/${threadId}/dismiss`),
  followupRestore: (slug, threadId) =>
    request('POST', `/accounts/${encodeURIComponent(slug)}/attention/followups/${threadId}/restore`),
  replySnooze: (slug, threadId, days) =>
    request(
      'POST',
      `/accounts/${encodeURIComponent(slug)}/attention/replies/${threadId}/snooze`,
      { days },
    ),
  replyDismiss: (slug, threadId) =>
    request('POST', `/accounts/${encodeURIComponent(slug)}/attention/replies/${threadId}/dismiss`),
  replyRestore: (slug, threadId) =>
    request('POST', `/accounts/${encodeURIComponent(slug)}/attention/replies/${threadId}/restore`),
  // Désinscriptions (P2.2)
  unsubscribeList: ({ account, done } = {}) => {
    const q = new URLSearchParams();
    if (account) q.set('account', account);
    if (done) q.set('done', '1');
    return request('GET', `/unsubscribe${q.toString() ? `?${q}` : ''}`);
  },
  unsubscribeRefresh: () => request('POST', '/unsubscribe/refresh'),
  unsubscribeSender: (slug, email) =>
    request('POST', `/accounts/${encodeURIComponent(slug)}/unsubscribe`, { email }),
  unsubscribeMark: (slug, email) =>
    request('POST', `/accounts/${encodeURIComponent(slug)}/unsubscribe/mark`, { email }),
  // Transfert des boîtes entre installations
  accountsExport: (passphrase, accounts) =>
    request('POST', '/accounts/export', { passphrase, accounts }),
  accountsImport: (envelope, passphrase, overwrite) =>
    request('POST', '/accounts/import', { envelope, passphrase, overwrite }),
  // Santé du système (P0.4)
  health: () => request('GET', '/health'),
  // Sauvegardes (P0.3)
  backups: () => request('GET', '/backups'),
  backupCreate: () => request('POST', '/backups'),
  backupDownloadUrl: (file) => `/api/backups/${encodeURIComponent(file)}/download`,
  // Pour les opérations hors request() (téléchargements de PJ en fetch direct)
  // qui veulent aussi allumer la barre de chargement globale.
  activity: { begin: activityBegin, end: activityEnd },
};

// ---- Helpers de formatage partagés ----
export function fmtSize(bytes) {
  if (bytes == null) return '—';
  if (bytes > 1e9) return (bytes / 1e9).toFixed(1) + ' Go';
  if (bytes > 1e6) return (bytes / 1e6).toFixed(1) + ' Mo';
  if (bytes > 1e3) return (bytes / 1e3).toFixed(0) + ' Ko';
  return bytes + ' o';
}

export function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }) +
    ' ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

export function fmtNum(n) {
  return (n ?? 0).toLocaleString('fr-FR');
}

export function esc(s) {
  const div = document.createElement('div');
  div.textContent = s ?? '';
  return div.innerHTML;
}
