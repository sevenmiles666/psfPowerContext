export const baseUrl = process.env.PAPERTRAIL_URL || 'http://127.0.0.1:8791';

export async function request(path, { method = 'GET', body, form, expected = 200 } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    body: form || (body === undefined ? undefined : JSON.stringify(body)),
    headers: form ? {} : body === undefined ? {} : { 'Content-Type': 'application/json' },
  });
  const data = await response.json().catch(() => ({}));
  const allowed = Array.isArray(expected) ? expected : [expected];
  if (!allowed.includes(response.status)) {
    throw new Error(`${method} ${path} 返回 ${response.status}，预期 ${allowed.join('/')}：${data.error || JSON.stringify(data)}`);
  }
  return { status: response.status, data };
}

export function uploadForm(files) {
  const form = new FormData();
  for (const file of files) {
    form.append('files', new Blob([file.buffer], { type: file.type || 'application/octet-stream' }), file.name);
  }
  return form;
}

export const libraryPath = (id, suffix = '') => `/api/libraries/${id}${suffix}`;
