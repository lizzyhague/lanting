/** Interface text from i18n.js; looked up on each call so a language switch applies to the next render. */
const t = (key, params) => globalThis.lantingI18n ? globalThis.lantingI18n.t(key, params) : key;

export function createConfirmDialog({
  dialog,
  titleElement,
  messageElement,
  acceptButton,
  cancelButton,
  document = globalThis.document,
}) {
  let settle = null;

  dialog.addEventListener("close", () => {
    const resolve = settle;
    settle = null;
    resolve?.(dialog.returnValue === "confirm");
  });

  cancelButton.addEventListener("click", () => {
    dialog.close("");
  });

  function show(message, { title = t("confirm.title"), confirmLabel = t("confirm.ok"), danger = false } = {}) {
    titleElement.textContent = title;
    const paragraphs = String(message).split(/\n+/u).map((part) => part.trim()).filter(Boolean);
    messageElement.replaceChildren(...paragraphs.map((text) => {
      const paragraph = document.createElement("p");
      paragraph.textContent = text;
      return paragraph;
    }));
    acceptButton.textContent = confirmLabel;
    acceptButton.classList.toggle("danger", danger);
    acceptButton.classList.toggle("primary", !danger);

    settle?.(false);
    settle = null;
    dialog.returnValue = "";
    if (!dialog.open) dialog.showModal();
    cancelButton.focus();
    return new Promise((resolve) => {
      settle = resolve;
    });
  }

  return { show };
}
