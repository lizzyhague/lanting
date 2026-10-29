const t = (key, params) => globalThis.lantingI18n ? globalThis.lantingI18n.t(key, params) : key;

export function formatDeliverySize(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}

export function renderDeliveryCard(delivery, ownerDocument = document, options = {}) {
  const now = options.now ?? (() => Date.now());
  const request = options.fetch ?? ((...args) => globalThis.fetch(...args));
  const card = ownerDocument.createElement("span");
  card.className = "delivery-card";
  const badge = ownerDocument.createElement("span");
  badge.className = "delivery-type";
  badge.setAttribute("aria-hidden", "true");
  const name = String(delivery.name ?? "");
  const extension = /\.([^.]+)$/.exec(name)?.[1];
  badge.textContent = extension ? extension.toUpperCase().slice(0, 4) : "FILE";
  const details = ownerDocument.createElement("span");
  details.className = "delivery-details";
  const filename = ownerDocument.createElement("span");
  filename.className = "delivery-name";
  filename.textContent = name;
  filename.title = name;
  const metadata = ownerDocument.createElement("span");
  metadata.className = "delivery-meta";
  details.append(filename, metadata);
  card.append(badge, details);

  function expire() {
    card.dataset.state = "expired";
    metadata.textContent = t("delivery.expired");
    details.replaceChildren(filename, metadata);
    card.replaceChildren(badge, details);
  }

  if (delivery.status === "failed") {
    card.dataset.state = "failed";
    badge.textContent = "!";
    metadata.textContent = t(`delivery.failure.${delivery.reason}`);
    return card;
  }
  if (now() >= delivery.expiresAtMs) {
    expire();
    return card;
  }
  card.dataset.state = "available";
  const locale = globalThis.lantingI18n?.language() === "zh" ? "zh-CN" : "en";
  const date = new Date(delivery.expiresAtMs).toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });
  metadata.textContent = `${formatDeliverySize(delivery.size)} · ${t("delivery.until", { date })}`;
  const button = ownerDocument.createElement("button");
  button.className = "delivery-download";
  button.type = "button";
  button.textContent = t("delivery.download");
  button.setAttribute("aria-label", t("delivery.downloadFile", { name }));
  const feedback = ownerDocument.createElement("span");
  feedback.className = "delivery-feedback";
  feedback.setAttribute("role", "status");
  details.append(feedback);
  const url = `/deliveries/${encodeURIComponent(delivery.attachmentId)}`;
  button.addEventListener("click", async () => {
    if (button.disabled) return;
    if (now() >= delivery.expiresAtMs) { expire(); return; }
    button.disabled = true;
    feedback.textContent = "";
    try {
      const response = await request(url, { method: "HEAD", cache: "no-store", credentials: "same-origin" });
      if (response.status === 410 || response.status === 404) { expire(); return; }
      if (response.status !== 200) throw new Error("Download unavailable");
      if (now() >= delivery.expiresAtMs) { expire(); return; }
      const link = ownerDocument.createElement("a");
      link.href = url;
      link.download = name;
      link.hidden = true;
      ownerDocument.body.append(link);
      link.click();
      link.remove();
    } catch {
      feedback.textContent = t("delivery.downloadFailed");
    } finally {
      button.disabled = false;
    }
  });
  card.append(button);
  return card;
}
