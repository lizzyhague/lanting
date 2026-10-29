import assert from "node:assert/strict";
import test from "node:test";
import { lantingI18n } from "./i18n.test-support.js";
import { renderDeliveryCard, formatDeliverySize } from "./delivery-card.js";
import { descendants, recordingDocument } from "./delivery-card.test-support.js";

const ready = { path: "/work/report.docx", name: "report.docx", status: "available",
  attachmentId: "11111111-1111-4111-8111-111111111111", size: 1024, expiresAtMs: Date.UTC(2030, 10, 28) };
const now = () => Date.UTC(2030, 9, 29);
const one = (card, name) => descendants(card, name)[0];

test("available cards show the type, filename, size, expiry date and download action", () => {
  const card = renderDeliveryCard(ready, recordingDocument(), { now });
  assert.equal(card.dataset.state, "available");
  assert.equal(one(card, "delivery-type").textContent, "DOCX");
  assert.equal(one(card, "delivery-name").textContent, "report.docx");
  assert.equal(one(card, "delivery-name").title, "report.docx");
  assert.match(one(card, "delivery-meta").textContent, /1.0 KiB · 可下载至/);
  assert.equal(one(card, "delivery-download").textContent, "下载");
  assert.equal(formatDeliverySize(0), "0 B");
  assert.equal(formatDeliverySize(25 * 1024 * 1024), "25.0 MiB");
  assert.equal(one(renderDeliveryCard({ ...ready, name: "noextension" }, recordingDocument(), { now }), "delivery-type").textContent, "FILE");
});

test("all failure reasons are localized and have no download action", () => {
  const reasons = ["interrupted", "too_many", "invalid_path", "outside_root", "not_file", "sensitive_file",
    "too_large", "file_changed", "unavailable", "upload_failed"];
  for (const language of ["zh", "en"]) {
    lantingI18n.set(language);
    for (const reason of reasons) {
      const card = renderDeliveryCard({ ...ready, status: "failed", reason }, recordingDocument());
      assert.equal(card.dataset.state, "failed");
      assert.equal(descendants(card, "delivery-download").length, 0);
      assert.equal(one(card, "delivery-type").textContent, "!");
      const text = one(card, "delivery-meta").textContent;
      assert.doesNotMatch(text, /delivery.failure/);
      if (language === "zh") assert.ok(reason === "interrupted" ? text === "回复中断，未交付" : text.startsWith("未交付："));
      if (reason === "too_large" && language === "zh") assert.equal(text, "未交付：超过 25 MiB 上限");
    }
  }
  lantingI18n.set("zh");
});

test("expired cards have no download action, including the expiry boundary", () => {
  const card = renderDeliveryCard(ready, recordingDocument(), { now: () => ready.expiresAtMs });
  assert.equal(card.dataset.state, "expired");
  assert.equal(one(card, "delivery-meta").textContent, "已过期 · 副本只保留 30 天");
  assert.equal(descendants(card, "delivery-download").length, 0);
});

test("successful HEAD preflight triggers a native download from the same URL", async () => {
  const doc = recordingDocument();
  const calls = [];
  const card = renderDeliveryCard(ready, doc, { now, fetch: async (...args) => { calls.push(args); return { status: 200 }; } });
  await one(card, "delivery-download").listeners.click();
  assert.deepEqual(calls, [[`/deliveries/${ready.attachmentId}`, { method: "HEAD", cache: "no-store", credentials: "same-origin" }]]);
  assert.deepEqual(doc.clicks, [{ href: `/deliveries/${ready.attachmentId}`, download: ready.name }]);
  assert.equal(doc.body.children[0].removed, true);
});

test("404 and 410 preflight responses turn the card into expired without navigating", async () => {
  for (const status of [404, 410]) {
    const doc = recordingDocument();
    const card = renderDeliveryCard(ready, doc, { now, fetch: async () => ({ status }) });
    await one(card, "delivery-download").listeners.click();
    assert.equal(card.dataset.state, "expired");
    assert.equal(descendants(card, "delivery-download").length, 0);
    assert.deepEqual(doc.clicks, []);
  }
});

test("network and service errors preserve the download action and show feedback", async () => {
  for (const request of [async () => { throw new Error("offline"); }, async () => ({ status: 503 }), async () => ({ status: 401 })]) {
    const doc = recordingDocument();
    const card = renderDeliveryCard(ready, doc, { now, fetch: request });
    const button = one(card, "delivery-download");
    await button.listeners.click();
    assert.equal(card.dataset.state, "available");
    assert.equal(button.disabled, false);
    assert.equal(one(card, "delivery-feedback").textContent, "暂时无法下载，请稍后再试。");
    assert.deepEqual(doc.clicks, []);
  }
});

test("repeated clicks share one preflight and expiry is checked before downloading", async () => {
  let finish;
  let time = now();
  let requests = 0;
  const doc = recordingDocument();
  const card = renderDeliveryCard(ready, doc, { now: () => time, fetch: () => {
    requests++;
    return new Promise((resolve) => { finish = resolve; });
  } });
  const button = one(card, "delivery-download");
  const first = button.listeners.click();
  await button.listeners.click();
  assert.equal(requests, 1);
  time = ready.expiresAtMs;
  finish({ status: 200 });
  await first;
  assert.equal(card.dataset.state, "expired");
  assert.deepEqual(doc.clicks, []);
});
