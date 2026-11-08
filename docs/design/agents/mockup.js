// Mockup behavior only: theme toggle, drawers, menu close. No data, no wallet.
(() => {
  const root = document.documentElement;
  const toggle = document.querySelector('[data-mock="theme"]');
  const sync = () => toggle?.setAttribute("aria-pressed", String(root.dataset.theme === "dark"));
  sync();
  toggle?.addEventListener("click", () => {
    root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
    try { localStorage.setItem("kd.theme", root.dataset.theme); } catch {}
    sync();
  });

  document.addEventListener("click", (e) => {
    const t = e.target instanceof Element ? e.target : null;
    const open = t?.closest('[data-mock="open"]');
    if (open) {
      const d = document.getElementById(open.getAttribute("data-target") ?? "");
      if (d instanceof HTMLDialogElement) d.showModal();
      return;
    }
    const close = t?.closest('[data-mock="close"]');
    if (close) close.closest("dialog")?.close();
    // A click on the backdrop closes the drawer.
    if (t instanceof HTMLDialogElement) t.close();
    // A click outside the "New agent" menu closes it.
    for (const m of document.querySelectorAll("details.mk-menu[open]")) if (!m.contains(t)) m.removeAttribute("open");
  });
})();
