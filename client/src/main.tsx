/** Boots React, routing, and the employee authentication provider. */
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { AuthProvider } from "./auth/AuthContext";
import "./index.css";
import App from "./App";

// The browser's own automatic scroll restoration runs on popstate before
// React has re-rendered the returned-to page, so it measures a page that is
// still its previous (often shorter, still-loading) height and lands in the
// wrong place. useScrollRestoration takes over that job deliberately, once
// the page's data has actually finished loading, so the two must not run at
// the same time.
if ("scrollRestoration" in window.history) {
  window.history.scrollRestoration = "manual";
}

createRoot(document.getElementById("root")!).render(
<BrowserRouter>
  <AuthProvider>
    <App />
  </AuthProvider>
</BrowserRouter>
);
