"use strict";
(() => {
  const key = "autograde-theme";
  const system = window.matchMedia("(prefers-color-scheme: dark)");
  const valid = value => ["light", "dark"].includes(value) ? value : "system";
  let preference = "system";
  try { preference = valid(localStorage.getItem(key)); } catch {}

  function apply() {
    const theme = preference === "system" ? (system.matches ? "dark" : "light") : preference;
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]').content = theme === "dark" ? "#131b18" : "#f5f6f2";
    document.querySelector('meta[name="color-scheme"]').content = theme;
    const label = {system: "跟随系统", light: "浅色", dark: "深色"}[preference];
    document.querySelectorAll("[data-theme-control]").forEach(control => {
      const summary = control.querySelector("summary");
      summary.setAttribute("aria-label", "外观主题：" + label);
      summary.title = "外观主题：" + label;
      control.querySelector("[data-theme-icon]").setAttribute("href", "#theme-" + preference);
      control.querySelectorAll("[data-theme-choice]").forEach(button => {
        button.setAttribute("aria-pressed", String(button.dataset.themeChoice === preference));
      });
    });
  }

  // Run before the stylesheet to apply the saved appearance on the first paint.
  apply();
  document.addEventListener("DOMContentLoaded", apply);
  system.addEventListener("change", () => { if (preference === "system") apply(); });
  document.addEventListener("click", event => {
    const control = event.target.closest("[data-theme-control]");
    document.querySelectorAll("[data-theme-control][open]").forEach(other => { if (other !== control) other.open = false; });
    const choice = event.target.closest("[data-theme-choice]");
    if (!choice) return;
    preference = valid(choice.dataset.themeChoice);
    try {
      if (preference === "system") localStorage.removeItem(key);
      else localStorage.setItem(key, preference);
    } catch {}
    apply();
    control.open = false;
    control.querySelector("summary").focus();
  });
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    document.querySelectorAll("[data-theme-control][open]").forEach(control => {
      control.open = false;
      control.querySelector("summary").focus();
    });
  });
  window.addEventListener("storage", event => {
    if (event.key === key || event.key === null) {
      preference = valid(event.newValue);
      apply();
    }
  });
})();
