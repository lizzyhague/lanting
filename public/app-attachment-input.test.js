import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { t } from "./i18n.test-support.js";

const source = await readFile(new URL("./app.js", import.meta.url), "utf8");
const start = source.indexOf("let nextDraftId = 1;");
const end = source.indexOf("/** First request a ticket", start);
assert.ok(start >= 0 && end > start);

function target() {
  const listeners = {};
  const classes = new Set();
  const attributes = {};
  return {
    textContent: "", value: "", listeners, classes, attributes,
    addEventListener(name, handler) { listeners[name] = handler; },
    classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) },
    setAttribute(name, value) { attributes[name] = value; },
    removeAttribute(name) { delete attributes[name]; },
    contains(node) { return node === this || node === this.child; },
  };
}
function harness() {
  const elements = Object.fromEntries(["composer", "messageInput", "fileInput", "composerStatus"].map((key) => [key, target()]));
  const state = { authenticated: true, current: { group: { id: "group" } }, drafts: [] };
  const uploads = [];
  const document = target();
  const window = target();
  vm.runInNewContext(source.slice(start, end), {
    elements, state, document, window, t, File, Date,
    MAX_MESSAGE_ATTACHMENTS: 100, MAX_UPLOAD_BYTES: 25 * 1024 * 1024,
    renderDrafts() {}, renderComposer() {},
    upload(current, draft, file) { uploads.push({ current, draft, file }); },
  });
  function emit(where, name, data = {}) {
    const event = { prevented: false, preventDefault() { this.prevented = true; }, ...data };
    where.listeners[name](event);
    return event;
  }
  function drop(items) {
    return emit(elements.composer, "drop", { dataTransfer: { items } });
  }
  return { elements, state, uploads, document, window, emit, drop };
}
const fileItem = (file) => ({ kind: "file", getAsFile: () => file });
const file = (name = "a.txt") => new File(["hello"], name, { type: "text/plain" });

test("drops multiple files and skips directories in the same batch", () => {
  const h = harness();
  h.drop([fileItem(file()), { kind: "file", webkitGetAsEntry: () => ({ isDirectory: true }), getAsFile() { throw Error("directory read"); } }, fileItem(file("b.txt"))]);
  assert.deepEqual(h.uploads.map(({ file }) => file.name), ["a.txt", "b.txt"]);
  assert.equal(h.elements.composerStatus.textContent, t("attach.noFolders"));
});
test("rejects links and prevents navigation outside the composer", () => {
  const h = harness();
  assert.ok(h.drop([{ kind: "string", type: "text/uri-list" }]).prevented);
  assert.equal(h.elements.composerStatus.textContent, t("attach.noWebContent"));
  assert.equal(h.uploads.length, 0);
  assert.ok(h.emit(h.document, "drop").prevented);
});
test("pasted screenshot names include a timestamp and sequence while other names survive", () => {
  const h = harness();
  const image = new File(["png"], "image.png", { type: "image/png", lastModified: 42 });
  const event = h.emit(h.elements.messageInput, "paste", { clipboardData: { files: [image, image, file("notes.txt")] } });
  assert.ok(event.prevented);
  assert.match(h.uploads[0].file.name, /^screenshot-\d{8}-\d{6}-1\.png$/);
  assert.match(h.uploads[1].file.name, /-2\.png$/);
  assert.equal(h.uploads[0].file.lastModified, 42);
  assert.equal(h.uploads[2].file.name, "notes.txt");
});
test("plain text paste keeps the browser default", () => {
  const h = harness();
  assert.equal(h.emit(h.elements.messageInput, "paste", { clipboardData: { files: [] } }).prevented, false);
  assert.equal(h.uploads.length, 0);
});
test("all entry points enforce the attachment count before starting uploads", () => {
  for (const entry of ["drop", "paste", "picker"]) {
    const h = harness();
    h.state.drafts = Array.from({ length: 99 }, () => ({}));
    const files = [file(), file("b.txt")];
    if (entry === "drop") h.drop(files.map(fileItem));
    if (entry === "paste") h.emit(h.elements.messageInput, "paste", { clipboardData: { files } });
    if (entry === "picker") { h.elements.fileInput.files = files; h.emit(h.elements.fileInput, "change"); }
    assert.equal(h.state.drafts.length, 100);
    assert.equal(h.uploads.length, 1);
    assert.equal(h.elements.composerStatus.textContent, t("attach.tooMany", { max: 100 }));
  }
});
test("oversized files fail locally before uploads start", () => {
  const h = harness();
  h.drop([fileItem({ name: "big.bin", size: 26 * 1024 * 1024 }), fileItem(file())]);
  assert.equal(h.state.drafts[0].status, "failed");
  assert.equal(h.state.drafts[0].error, t("attach.tooLarge"));
  assert.equal(h.uploads.length, 1);
});
test("drag highlight survives child transitions and clears on leaving or cancelling", () => {
  const h = harness();
  const composer = h.elements.composer;
  composer.child = {};
  const enter = () => h.emit(composer, "dragover", { dataTransfer: { types: ["Files"] } });
  enter();
  assert.ok(composer.classes.has("file-drag-over"));
  h.emit(composer, "dragleave", { relatedTarget: composer.child });
  assert.ok(composer.classes.has("file-drag-over"));
  h.emit(composer, "dragleave", { relatedTarget: null });
  assert.equal(composer.classes.size, 0);
  enter();
  h.emit(h.window, "blur");
  assert.equal(composer.classes.size, 0);
});
test("unavailable attachments neither highlight nor upload", () => {
  for (const unavailable of ["authenticated", "current"]) {
    const h = harness();
    h.state[unavailable] = null;
    h.emit(h.elements.composer, "dragover", { dataTransfer: { types: ["Files"] } });
    h.drop([fileItem(file())]);
    const paste = h.emit(h.elements.messageInput, "paste", { clipboardData: { files: [file()] } });
    assert.equal(h.elements.composer.classes.size, 0);
    assert.equal(h.uploads.length, 0);
    assert.equal(paste.prevented, false);
  }
});
