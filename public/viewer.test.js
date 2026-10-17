import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { lantingI18n } from "./i18n.test-support.js";
import vm from "node:vm";

import { renderMarkdown } from "./markdown.js";

const viewer = (await readFile(new URL("./viewer.js", import.meta.url), "utf8"))
  .replace(/^import .*;\n/u, "")
  .replace("void loadFile()", "loadFile()");

async function view(filePath, response) {
  const elements = new Map();
  function element(tagName) {
    return {
      tagName,
      children: [],
      listeners: {},
      textContent: "",
      hidden: false,
      append(...children) { this.children.push(...children); },
      addEventListener(type, listener) { this.listeners[type] = listener; },
      getAttribute(name) { return this[name] ?? null; },
      querySelectorAll(selector) {
        const matches = [];
        function visit(node) {
          if (selector === "a[href]" && node.tagName === "a" && node.href !== undefined) {
            matches.push(node);
          }
          for (const child of node.children ?? []) visit(child);
        }
        for (const child of this.children) visit(child);
        return matches;
      },
      setAttribute(name, value) { this[name] = value; },
    };
  }
  const document = {
    title: "",
    createElement: element,
    createTextNode(textContent) { return { textContent }; },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, element("div"));
      return elements.get(id);
    },
  };
  document.getElementById("viewer-login").hidden = true;
  const requests = [];
  await vm.runInNewContext(viewer, {
    lantingI18n,
    document,
    URLSearchParams,
    location: { pathname: "/view", search: `?${new URLSearchParams({ path: filePath })}` },
    renderMarkdown: (text) => renderMarkdown(text, document),
    fetch: async (url, options) => {
      requests.push({ url, options });
      return response;
    },
  });
  return { elements, requests };
}

test("viewer renders Markdown as DOM text and encodes special path characters", async () => {
  const file = "/projects/demo/文档 # ? %.md";
  const { elements, requests } = await view(
    file,
    new Response("# Title\n\n<script>alert(1)</script>"),
  );
  assert.equal(new URL(requests[0].url, "https://example.com").searchParams.get("path"), file);
  assert.equal(requests[0].options.cache, "no-store");
  assert.equal(elements.get("viewer-status").hidden, true);
  const markdown = elements.get("file-content").children[0];
  assert.equal(markdown.children[0].tagName, "h1");
  assert.equal(markdown.children[1].children[0].textContent, "<script>alert(1)</script>");
});

test("viewer uses an image context for SVG and retains the target on login", async () => {
  const file = "/projects/demo/image.svg";
  const shown = await view(
    file,
    new Response(null, { headers: { "content-type": "image/svg+xml" } }),
  );
  assert.equal(shown.requests[0].options.method, "HEAD");
  const image = shown.elements.get("file-content").children[0];
  assert.equal(image.tagName, "img");
  assert.equal(image.src, shown.requests[0].url);

  const denied = await view(file, new Response(null, { status: 401 }));
  assert.equal(denied.elements.get("file-content").children.length, 0);
  const login = denied.elements.get("viewer-login");
  assert.equal(login.hidden, false);
  const returnTo = new URL(login.href, "https://example.com").searchParams.get("returnTo");
  assert.equal(new URL(returnTo, "https://example.com").searchParams.get("path"), file);
});

test("viewer reports missing files without offering a download", async () => {
  const { elements } = await view("/projects/demo/missing.md", new Response(null, { status: 404 }));
  assert.equal(elements.get("file-content").children.length, 0);
  assert.match(elements.get("viewer-status").textContent, /文件不存在/u);
  assert.equal(elements.get("viewer-login").hidden, true);
});

test("viewer rewrites only supported relative file links", async () => {
  const source = [
    "[same](spec.md)",
    "[parent](../remotes/open-questions.md)",
    "![image](img/a.png)",
    "[http](http://example.com/a.md)",
    "[https](https://example.com/a.md)",
    "[mail](mailto:test@example.com)",
    "[absolute](/view?path=%2Fprojects%2Fexisting.md)",
    "[anchor](#章节)",
    "[source](../src/main.ts)",
    "[section](../guide.md#章节)",
    "[unicode](子目录/%E8%AF%B4%E6%98%8E%20%E6%96%87%E4%BB%B6.md)",
    "[malformed](bad%ZZ.md)",
    "[escape](../../../../outside.md)",
  ].join("\n\n");
  const { elements } = await view("/projects/notes/plans/current.md", new Response(source));
  const markdown = elements.get("file-content").children[0];
  const links = Object.fromEntries(markdown.querySelectorAll("a[href]").map((link) => [
    link.children[0].textContent,
    link,
  ]));
  const pathOf = (label) => new URL(links[label].href, "https://example.com").searchParams.get("path");

  assert.equal(pathOf("same"), "/projects/notes/plans/spec.md");
  assert.equal(pathOf("parent"), "/projects/notes/remotes/open-questions.md");
  assert.equal(pathOf("图片：image"), "/projects/notes/plans/img/a.png");
  assert.equal(links["图片：image"].className, "markdown-image-link");
  assert.equal(links.http.href, "http://example.com/a.md");
  assert.equal(links.https.href, "https://example.com/a.md");
  assert.equal(links.mail.href, "mailto:test@example.com");
  assert.equal(links.absolute.href, "/view?path=%2Fprojects%2Fexisting.md");
  assert.equal(links.anchor.href, "#章节");
  assert.equal(links.source.href, "../src/main.ts");
  assert.equal(pathOf("section"), "/projects/notes/guide.md");
  assert.equal(decodeURIComponent(new URL(links.section.href, "https://example.com").hash), "#章节");
  assert.equal(pathOf("unicode"), "/projects/notes/plans/子目录/说明 文件.md");
  assert.equal(links.malformed.href, "bad%ZZ.md");
  assert.equal(links.escape.href, "../../../../outside.md");
  assert.equal(links.same.target, undefined);
});
