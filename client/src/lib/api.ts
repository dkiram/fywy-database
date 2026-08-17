/**
 * Adds the API origin and session cookie behavior to every client request.
 *
 * In production the built frontend is served by the same Express process that
 * serves /api, so the base is empty and requests stay same-origin. During local
 * development the Vite dev server proxies /api to the API process, so the base
 * is empty there too. VITE_API_BASE_URL is an escape hatch for the case where
 * the client genuinely needs to talk to a different origin.
 */
const API_BASE_URL = (
  import.meta.env.VITE_API_BASE_URL ?? ""
).replace(/\/$/, "");

export async function apiFetch(
  url: string,
  options: RequestInit = {}
) {
  return fetch(`${API_BASE_URL}${url}`, {
    ...options,

    credentials: "include",

    headers: {
      ...options.headers,
    },
  });
}
