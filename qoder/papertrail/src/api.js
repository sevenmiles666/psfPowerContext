export async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...options.headers,
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败（HTTP ${response.status}）。`);
  return data;
}

export const libraryPath = (libraryId, suffix = '') => `/api/libraries/${libraryId}${suffix}`;

export async function uploadFiles(libraryId, files) {
  const body = new FormData();
  for (const file of files) body.append('files', file);
  return api(libraryPath(libraryId, '/import'), { method: 'POST', body });
}
