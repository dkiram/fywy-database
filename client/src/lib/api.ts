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

/**
 * Called when the server says the session is no longer valid.
 *
 * Sessions now lapse after an hour of inactivity, which means any request can
 * come back 401 at any moment. Without somewhere central to notice that, each
 * screen would render its own "could not load" error and the person would be
 * left staring at a broken page that never explains it signed them out.
 */
type UnauthorizedHandler = () => void;

let onUnauthorized: UnauthorizedHandler | null = null;

export function setUnauthorizedHandler(handler: UnauthorizedHandler | null) {
  onUnauthorized = handler;
}

/**
 * Endpoints whose 401 means "those credentials are wrong", not "your session
 * ended". Routing those through the expiry path would show a returning user a
 * session-timeout notice for what was really a typo.
 */
const AUTH_ENDPOINTS = ["/api/auth/login", "/api/auth/me"];

export async function apiFetch(
  url: string,
  options: RequestInit = {}
) {
  const response = await fetch(`${API_BASE_URL}${url}`, {
    ...options,

    credentials: "include",

    headers: {
      ...options.headers,
    },
  });

  if (
    response.status === 401 &&
    !AUTH_ENDPOINTS.some((endpoint) => url.startsWith(endpoint))
  ) {
    onUnauthorized?.();
  }

  return response;
}
