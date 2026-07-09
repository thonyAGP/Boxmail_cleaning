// Client API minimal — toutes les requêtes passent par /api (session cookie).

async function request(method, path, body) {
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
  messagesUnified: ({ offset = 0, limit = 50, unseen = false, attachments = false } = {}) =>
    request(
      'GET',
      `/messages?offset=${offset}&limit=${limit}` +
        (unseen ? '&unseen=1' : '') +
        (attachments ? '&attachments=1' : ''),
    ),
  accountSetColor: (slug, color) =>
    request('PATCH', `/accounts/${encodeURIComponent(slug)}`, { color }),
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
  analyzeMessage: (slug, { folder, uid, text }) =>
    request('POST', `/accounts/${encodeURIComponent(slug)}/messages/analysis`, { folder, uid, text }),
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
  listMessages: (slug, { folder = 'INBOX', offset = 0, limit = 50, unseen = false, attachments = false } = {}) => {
    const q = new URLSearchParams({ folder, offset: String(offset), limit: String(limit) });
    if (unseen) q.set('unseen', '1');
    if (attachments) q.set('attachments', '1');
    return request('GET', `/accounts/${encodeURIComponent(slug)}/messages?${q}`);
  },
  bulkAction: (slug, { folder, uids, action, destination }) =>
    request('POST', `/accounts/${encodeURIComponent(slug)}/messages/bulk`, {
      folder,
      uids,
      action,
      destination,
    }),
  // URL directe (même origine, cookie de session) : le navigateur télécharge.
  attachmentUrl: (slug, folder, uid, index) =>
    `/api/accounts/${encodeURIComponent(slug)}/messages/${encodeURIComponent(folder)}/${uid}/attachments/${index}`,
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
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' }) +
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
