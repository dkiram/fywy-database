export async function apiFetch(
  url: string,
  options: RequestInit = {}
) {
  return fetch(`http://localhost:3000${url}`, {
    ...options,

    credentials: "include",

    headers: {
      ...options.headers,
    },
  });
}