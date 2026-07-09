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
  startSync: (slug, mode) =>
    request('POST', `/accounts/${encodeURIComponent(slug)}/sync`, { mode }),
  enroll: (account) => request('POST', '/enroll', { account }),
  enrollStart: (account) => request('POST', '/enroll/start', { account }),
  version: () => request('GET', '/version'),
  updateCheck: () => request('GET', '/update/check'),
  updateApply: () => request('POST', '/update/apply'),
  health: () => fetch('/health').then((r) => r.ok),
  job: (id) => request('GET', `/jobs/${encodeURIComponent(id)}`),
  operations: (limit = 30) => request('GET', `/operations?limit=${limit}`),
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
