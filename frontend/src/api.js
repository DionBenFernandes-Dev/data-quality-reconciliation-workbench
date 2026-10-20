const API_BASE = (import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8000/api').replace(/\/$/, '');

async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, { ...options, headers });
  } catch {
    throw new Error('Cannot reach the local API. Start the FastAPI server and try again.');
  }
  if (!response.ok) {
    let message = `Request failed (${response.status}).`;
    try {
      const body = await response.json();
      message = body.detail || body.message || message;
    } catch { /* Keep the safe generic message. */ }
    throw new Error(message);
  }
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) return response.json();
  return response;
}

export function uploadFile(file) {
  const form = new FormData();
  form.append('file', file);
  return request('/uploads', { method: 'POST', body: form });
}

export function apiGet(path) { return request(path); }
export function apiPost(path, data) { return request(path, { method: 'POST', body: JSON.stringify(data) }); }
export function apiPatch(path, data) { return request(path, { method: 'PATCH', body: JSON.stringify(data) }); }
export function apiDelete(path) { return request(path, { method: 'DELETE' }); }

export async function downloadExport(runId, format) {
  const response = await request(`/runs/${encodeURIComponent(runId)}/export?format=${format}`);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `reconciliation-${runId.slice(0, 8)}.${format}`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
