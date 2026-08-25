/**
 * Restores scroll position when returning to a page via the browser back/
 * forward buttons, instead of always snapping back to the top.
 *
 * BrowserRouter (declarative mode) does not include React Router's built-in
 * <ScrollRestoration>, which needs a data router. This is the same idea in a
 * few lines: remember scroll position per history entry in memory, and only
 * replay it on a POP navigation (back/forward) once the page's data has
 * finished loading — replaying before that would scroll to a position the
 * shorter, still-loading page doesn't have yet.
 */
import { useEffect, useRef } from "react";
import { useLocation, useNavigationType } from "react-router";

// Keyed by react-router's per-history-entry location.key, so distinct visits
// to the same route each get their own remembered position. In-memory only:
// it does not survive a hard reload, and does not need to.
const scrollPositions = new Map<string, number>();

export function useScrollRestoration(ready: boolean) {
  const location = useLocation();
  const navigationType = useNavigationType();
  const restoredForKey = useRef<string | null>(null);

  useEffect(() => {
    const key = location.key;
    const onScroll = () => {
      scrollPositions.set(key, window.scrollY);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [location.key]);

  useEffect(() => {
    if (!ready || restoredForKey.current === location.key) return;
    restoredForKey.current = location.key;

    if (navigationType === "POP") {
      const saved = scrollPositions.get(location.key);
      if (saved != null) {
        // A plain call, not requestAnimationFrame: this effect already runs
        // after React has committed and the browser has painted the restored
        // page, and rAF callbacks are paused while a tab is backgrounded —
        // which would silently drop the restore if focus moved during the
        // navigation.
        window.scrollTo(0, saved);
        return;
      }
    }
    window.scrollTo(0, 0);
  }, [ready, location.key, navigationType]);
}
