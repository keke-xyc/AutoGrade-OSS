"use strict";
document.querySelectorAll('input[type="password"]').forEach(input => {
  const wrapper = document.createElement("div");
  wrapper.className = "password-field";
  input.before(wrapper);
  wrapper.append(input);
  input.spellcheck = false;
  input.setAttribute("autocapitalize", "none");
  input.setAttribute("autocorrect", "off");

  const button = document.createElement("button");
  button.type = "button";
  button.className = "password-toggle";
  button.setAttribute("aria-controls", input.id);
  button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/><path class="password-slash" d="m3 3 18 18"/></svg>';
  const label = input.labels[0].textContent.trim();
  function setVisible(visible) {
    input.type = visible ? "text" : "password";
    button.dataset.visible = String(visible);
    button.setAttribute("aria-label", (visible ? "隐藏" : "显示") + label);
    button.title = button.getAttribute("aria-label");
  }
  setVisible(false);
  // Keep the input and mobile keyboard focused when the eye is tapped.
  button.addEventListener("pointerdown", event => event.preventDefault());
  button.addEventListener("click", () => {
    const start = input.selectionStart, end = input.selectionEnd;
    setVisible(input.type === "password");
    // Edge can reset the caret after changing the field type.
    requestAnimationFrame(() => input.setSelectionRange(start, end));
  });
  input.form.addEventListener("submit", () => setVisible(false), true);
  input.form.addEventListener("reset", () => setVisible(false));
  wrapper.append(button);
});
