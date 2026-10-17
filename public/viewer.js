import { renderMarkdown } from "./markdown.js";

/** Interface text from i18n.js, which loads in <head> before this module. */
const t = (key, params) => globalThis.lantingI18n ? globalThis.lantingI18n.t(key, params) : key;

const status = document.getElementById("viewer-status");
const content = document.getElementById("file-content");
const login = document.getElementById("viewer-login");
const params = new URLSearchParams(location.search);
const filePath = params.get("path");
const VIEWABLE_PATH = /\.(?:md|svg|png|jpe?g|gif|webp|avif|bmp|ico)$/i;

function rewriteRelativeLinks(root) {
  const base = filePath.split("/");
  base.pop();
  for (const link of root.querySelectorAll("a[href]")) {
    const href = link.getAttribute("href");
    if (!href || /^(?:https?:|mailto:|\/|#)/i.test(href)) continue;
    const hashStart = href.indexOf("#");
    const relative = hashStart < 0 ? href : href.slice(0, hashStart);
    const hash = hashStart < 0 ? "" : href.slice(hashStart);
    if (!relative) continue;

    let decoded;
    try {
      decoded = decodeURIComponent(relative);
    } catch {
      continue;
    }
    const segments = [...base];
    let aboveRoot = false;
    for (const segment of decoded.split("/")) {
      if (!segment || segment === ".") continue;
      if (segment === "..") {
        if (segments.length <= 1) {
          aboveRoot = true;
          break;
        }
        segments.pop();
      } else {
        segments.push(segment);
      }
    }
    const resolved = segments.join("/");
    if (aboveRoot || !resolved.startsWith("/") || !VIEWABLE_PATH.test(resolved)) continue;
    link.href = `/view?${new URLSearchParams({ path: resolved })}${hash}`;
  }
}

async function loadFile() {
  document.getElementById("file-name").textContent = t("viewer.title");
  document.title = `${t("viewer.title")} · lanting`;
  status.textContent = t("viewer.loading");
  if (!filePath || params.getAll("path").length !== 1) {
    throw new Error(t("viewer.badLink"));
  }
  const name = filePath.split("/").pop() || filePath;
  document.getElementById("file-name").textContent = name;
  document.title = `${name} · lanting`;
  const raw = `/raw?${new URLSearchParams({ path: filePath })}`;
  const markdown = /\.md$/i.test(filePath);
  const response = await fetch(raw, { method: markdown ? "GET" : "HEAD", cache: "no-store" });
  if (response.status === 401) {
    status.textContent = t("viewer.loginRequired");
    login.href = `/?${new URLSearchParams({ returnTo: location.pathname + location.search })}`;
    login.hidden = false;
    return;
  }
  if (!response.ok) {
    throw new Error(response.status === 404
      ? t("viewer.notFound")
      : t("viewer.readFailed"));
  }
  if (markdown) {
    content.append(renderMarkdown(await response.text()));
    rewriteRelativeLinks(content);
  } else if (response.headers.get("content-type")?.startsWith("image/")) {
    const image = document.createElement("img");
    image.alt = name;
    image.className = "viewer-image";
    image.addEventListener("error", () => {
      status.hidden = false;
      status.textContent = t("viewer.imageFailed");
    });
    image.src = raw;
    content.append(image);
  } else {
    throw new Error(t("viewer.unsupported"));
  }
  status.hidden = true;
}

void loadFile().catch((error) => {
  status.textContent = error instanceof Error ? error.message : t("viewer.failed");
});
