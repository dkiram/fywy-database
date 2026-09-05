/**
 * Restores scroll position when returning to a page via back/forward and when
 * an on-page filter or pagination control updates the URL.
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
  const previousKey = useRef(location.key);

  // A query-string update creates a new router key even though it is still the
  // same list screen. Carry the old entry's position onto that replacement so
  // an async page/filter refresh cannot strand the employee at the top.
  if (previousKey.current !== location.key) {
    if (navigationType === "REPLACE") {
      const saved = scrollPositions.get(previousKey.current) ?? window.scrollY;
      scrollPositions.set(location.key, saved);
    }
    previousKey.current = location.key;
  }

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
    if (navigationType === "REPLACE") {
      const saved = scrollPositions.get(location.key);
      if (saved != null) window.scrollTo(0, saved);
      return;
    }
    // REPLACE is used when an on-page filter or page number is written to the
    // URL. It is still the same screen, so leave the employee at the table
    // controls they just used. A genuinely new screen is a PUSH and starts at
    // the top as expected.
    if (navigationType === "PUSH") window.scrollTo(0, 0);
  }, [ready, location.key, navigationType]);
}
