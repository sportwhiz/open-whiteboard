import { useEffect, useState } from "react";
import { findSettingIndex } from "./settings-search";

/** Follow settings-search links on account, admin and connection pages. */
export function useFindSetting(root: string, section = "") {
  // Read once: development double-runs effects, and the URL is cleaned below.
  const [findQuery] = useState(() => new URLSearchParams(location.search).get("find"));
  useEffect(() => {
    const query = findQuery;
    if (!query) return;
    const url = new URL(location.href);
    if (url.searchParams.has("find")) { url.searchParams.delete("find"); history.replaceState(history.state, "", url); }
    let attempts = 0;
    let timer = 0;
    const locate = () => {
      const content = document.querySelector<HTMLElement>(root);
      const candidates = Array.from(content?.querySelectorAll<HTMLElement>("h2, h3, legend, .identity-field > span, label.identity-check, .identity-row strong, .identity-field label, button, select[aria-label], input[aria-label]") ?? []).filter(element => element.getClientRects().length);
      const index = findSettingIndex(candidates.map(element => element.matches("select, input") ? element.getAttribute("aria-label") ?? "" : element.textContent ?? ""), query);
      // Sections load their data first; wait for the setting to appear.
      if (index < 0 && attempts++ < 25) { timer = window.setTimeout(locate, 200); return; }
      const match = index >= 0 ? candidates[index] : content?.querySelector<HTMLElement>("h1") ?? null;
      if (!match) return;
      const container = match.matches("button, select, input") ? match : match.closest<HTMLElement>(".identity-row, .identity-check, .identity-field, fieldset") ?? match;
      const control = container.matches("button, select, input") ? container : container.matches("label") || container.matches(".identity-field")
        ? container.querySelector<HTMLElement>("input, select, textarea")
        : container.querySelector<HTMLElement>("button, a[href], input, select");
      container.scrollIntoView({ block: "center", behavior: "smooth" });
      container.classList.add("setting-found");
      window.setTimeout(() => container.classList.remove("setting-found"), 2400);
      if (control) control.focus({ preventScroll: true });
      else { match.tabIndex = -1; match.focus({ preventScroll: true }); }
    };
    timer = window.setTimeout(locate, 50);
    return () => window.clearTimeout(timer);
  }, [root, section]);
}
