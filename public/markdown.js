export function parseMarkdown(source) {
  const lines = String(source ?? "").replace(/\r\n?/g, "\n").split("\n");
  return parseBlocks(lines);
}

export function tokenizeInline(source) {
  const text = String(source ?? "");
  const tokens = [];
  let index = 0;

  while (index < text.length) {
    const rest = text.slice(index);

    if (rest[0] === "\\" && rest.length > 1) {
      pushText(tokens, rest[1]);
      index += 2;
      continue;
    }

    const code = /^(`+)([\s\S]*?)\1/.exec(rest);
    if (code) {
      tokens.push({ type: "code", text: code[2] });
      index += code[0].length;
      continue;
    }

    const image = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/.exec(rest);
    if (image) {
      tokens.push({ type: "imageLink", text: image[1] || "未命名图片", href: image[2] });
      index += image[0].length;
      continue;
    }

    const link = /^\[([^\]]+)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/.exec(rest);
    if (link) {
      tokens.push({ type: "link", children: tokenizeInline(link[1]), href: link[2] });
      index += link[0].length;
      continue;
    }

    const strongDelimiter = rest.startsWith("**") ? "**" : null;
    if (strongDelimiter) {
      const end = text.indexOf(strongDelimiter, index + 2);
      if (end > index + 2) {
        tokens.push({
          type: "strong",
          children: tokenizeInline(text.slice(index + 2, end)),
        });
        index = end + 2;
        continue;
      }
    }

    if (rest[0] === "*") {
      const end = text.indexOf("*", index + 1);
      const content = end > index ? text.slice(index + 1, end) : "";
      if (content && !/^\s|\s$/.test(content)) {
        tokens.push({ type: "emphasis", children: tokenizeInline(content) });
        index = end + 1;
        continue;
      }
    }

    const special = findNextInlineSpecial(text, index + 1);
    const end = special < 0 ? text.length : special;
    pushText(tokens, text.slice(index, end));
    index = end;
  }

  return tokens;
}

export function sanitizeHref(value) {
  // 浏览器解析 URL 时会先丢掉控制字符，所以判断协议之前必须自己先去掉，
  // 否则 "\u0001javascript:…" 这类写法会绕过下面的白名单。
  const href = String(value ?? "").replace(/[\u0000-\u0020\u007f]/g, "");
  if (!href || href.startsWith("//")) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href)?.[1]?.toLowerCase();
  if (scheme && !["http", "https", "mailto"].includes(scheme)) return null;
  return href;
}

export function renderMarkdown(source, ownerDocument = document) {
  const root = ownerDocument.createElement("div");
  root.className = "markdown-body";
  appendBlocks(root, parseMarkdown(source), ownerDocument);
  return root;
}

export async function copyTextToClipboard(text, ownerDocument = document) {
  const clipboard = ownerDocument.defaultView?.navigator?.clipboard;
  if (typeof clipboard?.writeText === "function") {
    await clipboard.writeText(String(text ?? ""));
    return;
  }

  const textarea = ownerDocument.createElement("textarea");
  textarea.value = String(text ?? "");
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  ownerDocument.body.append(textarea);
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);

  try {
    if (!ownerDocument.execCommand("copy")) {
      throw new Error("浏览器未能复制代码");
    }
  } finally {
    textarea.remove();
  }
}

function parseBlocks(lines) {
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    if (!lines[index]?.trim()) {
      index += 1;
      continue;
    }

    const fence = fenceStart(lines[index]);
    if (fence) {
      const content = [];
      index += 1;
      while (index < lines.length && !isFenceEnd(lines[index], fence)) {
        content.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({
        type: "code",
        language: fence.language,
        text: content.join("\n"),
      });
      continue;
    }

    const table = parseTable(lines, index);
    if (table) {
      blocks.push(table.block);
      index = table.nextIndex;
      continue;
    }

    const heading = /^\s{0,3}(#{1,6})[ \t]+(.+?)\s*#*\s*$/.exec(lines[index]);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2] });
      index += 1;
      continue;
    }

    if (isHorizontalRule(lines[index])) {
      blocks.push({ type: "rule" });
      index += 1;
      continue;
    }

    if (/^\s{0,3}>/.test(lines[index])) {
      const quoted = [];
      while (index < lines.length && /^\s{0,3}>/.test(lines[index])) {
        quoted.push(lines[index].replace(/^\s{0,3}>[ \t]?/, ""));
        index += 1;
      }
      blocks.push({ type: "blockquote", blocks: parseBlocks(quoted) });
      continue;
    }

    const list = listItem(lines[index]);
    if (list) {
      const items = [];
      const ordered = list.ordered;
      const start = list.start;
      while (index < lines.length) {
        const item = listItem(lines[index]);
        if (!item || item.ordered !== ordered) break;
        items.push(item.text);
        index += 1;
      }
      blocks.push({ type: "list", ordered, start, items });
      continue;
    }

    const paragraph = [];
    while (index < lines.length && lines[index]?.trim()) {
      if (paragraph.length && isBlockStart(lines, index)) break;
      paragraph.push(lines[index].trim());
      index += 1;
    }
    blocks.push({ type: "paragraph", text: paragraph.join("\n") });
  }

  return blocks;
}

function fenceStart(line) {
  const match = /^\s{0,3}(`{3,}|~{3,})(?:[ \t]*([^\s`~]+))?[ \t]*$/.exec(line);
  if (!match) return null;
  return {
    marker: match[1][0],
    length: match[1].length,
    language: match[2] || "",
  };
}

function isFenceEnd(line, fence) {
  const trimmed = line.trim();
  return trimmed.length >= fence.length &&
    [...trimmed].every((character) => character === fence.marker);
}

function parseTable(lines, index) {
  const headerLine = lines[index];
  const separatorLine = lines[index + 1];
  if (!headerLine?.includes("|") || !separatorLine?.includes("|")) return null;

  const headers = splitTableRow(headerLine);
  const separators = splitTableRow(separatorLine);
  if (!headers.length || separators.length !== headers.length) return null;
  if (!separators.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s/g, "")))) {
    return null;
  }

  const alignments = separators.map((cell) => {
    const compact = cell.replace(/\s/g, "");
    if (compact.startsWith(":") && compact.endsWith(":")) return "center";
    if (compact.endsWith(":")) return "right";
    return "left";
  });
  const rows = [];
  let nextIndex = index + 2;
  while (nextIndex < lines.length && lines[nextIndex]?.trim().includes("|")) {
    const cells = splitTableRow(lines[nextIndex]);
    rows.push(headers.map((_, cellIndex) => cells[cellIndex] || ""));
    nextIndex += 1;
  }

  return {
    block: { type: "table", headers, alignments, rows },
    nextIndex,
  };
}

function splitTableRow(line) {
  let source = line.trim();
  if (source.startsWith("|")) source = source.slice(1);
  if (source.endsWith("|") && !source.endsWith("\\|")) source = source.slice(0, -1);

  const cells = [];
  let cell = "";
  let inCode = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\\" && source[index + 1] === "|") {
      cell += "|";
      index += 1;
    } else if (character === "`") {
      inCode = !inCode;
      cell += character;
    } else if (character === "|" && !inCode) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function listItem(line) {
  const unordered = /^\s{0,3}[-+*][ \t]+(.+)$/.exec(line);
  if (unordered) return { ordered: false, start: 1, text: unordered[1] };
  const ordered = /^\s{0,3}(\d+)[.)][ \t]+(.+)$/.exec(line);
  if (!ordered) return null;
  return { ordered: true, start: Number(ordered[1]), text: ordered[2] };
}

function isBlockStart(lines, index) {
  const line = lines[index] || "";
  return Boolean(
    fenceStart(line) ||
    parseTable(lines, index) ||
    /^\s{0,3}#{1,6}[ \t]+/.test(line) ||
    /^\s{0,3}>/.test(line) ||
    listItem(line) ||
    isHorizontalRule(line)
  );
}

function isHorizontalRule(line) {
  const compact = line.trim().replace(/\s/g, "");
  return /^(?:\*{3,}|-{3,})$/.test(compact);
}

function findNextInlineSpecial(text, from) {
  for (let index = from; index < text.length; index += 1) {
    if ("\\`![]*".includes(text[index])) return index;
  }
  return -1;
}

function pushText(tokens, text) {
  if (!text) return;
  const previous = tokens.at(-1);
  if (previous?.type === "text") {
    previous.text += text;
  } else {
    tokens.push({ type: "text", text });
  }
}

function appendBlocks(parent, blocks, ownerDocument) {
  for (const block of blocks) {
    if (block.type === "heading") {
      const heading = ownerDocument.createElement(`h${block.level}`);
      appendInline(heading, tokenizeInline(block.text), ownerDocument);
      parent.append(heading);
    } else if (block.type === "paragraph") {
      const paragraph = ownerDocument.createElement("p");
      appendInline(paragraph, tokenizeInline(block.text), ownerDocument);
      parent.append(paragraph);
    } else if (block.type === "rule") {
      parent.append(ownerDocument.createElement("hr"));
    } else if (block.type === "code") {
      parent.append(renderCodeBlock(block, ownerDocument));
    } else if (block.type === "blockquote") {
      const quote = ownerDocument.createElement("blockquote");
      appendBlocks(quote, block.blocks, ownerDocument);
      parent.append(quote);
    } else if (block.type === "list") {
      const list = ownerDocument.createElement(block.ordered ? "ol" : "ul");
      if (block.ordered && block.start !== 1) list.start = block.start;
      for (const item of block.items) {
        const listItem = ownerDocument.createElement("li");
        appendInline(listItem, tokenizeInline(item), ownerDocument);
        list.append(listItem);
      }
      parent.append(list);
    } else if (block.type === "table") {
      parent.append(renderTable(block, ownerDocument));
    }
  }
}

function renderCodeBlock(block, ownerDocument) {
  const wrapper = ownerDocument.createElement("div");
  wrapper.className = "markdown-code-block";

  const button = ownerDocument.createElement("button");
  button.className = "markdown-code-copy";
  button.type = "button";
  button.setAttribute("aria-live", "polite");
  setCopyButtonState(button, "idle", ownerDocument);

  let resetTimer = null;
  button.addEventListener("click", async () => {
    const view = ownerDocument.defaultView;
    if (resetTimer !== null) {
      view?.clearTimeout(resetTimer);
      resetTimer = null;
    }

    try {
      await copyTextToClipboard(block.text, ownerDocument);
      setCopyButtonState(button, "success", ownerDocument);
    } catch {
      setCopyButtonState(button, "error", ownerDocument);
    }

    const reset = () => {
      setCopyButtonState(button, "idle", ownerDocument);
      resetTimer = null;
    };
    resetTimer = view?.setTimeout(reset, 1_600) ?? setTimeout(reset, 1_600);
  });

  const pre = ownerDocument.createElement("pre");
  const code = ownerDocument.createElement("code");
  if (/^[a-z0-9_+-]+$/i.test(block.language)) {
    code.dataset.language = block.language;
  }
  code.textContent = block.text;
  pre.append(code);
  wrapper.append(button, pre);
  return wrapper;
}

function setCopyButtonState(button, state, ownerDocument) {
  const labels = {
    idle: "复制代码",
    success: "已复制",
    error: "复制失败",
  };
  const label = labels[state];
  button.title = label;
  button.setAttribute("aria-label", label);
  if (state === "idle") delete button.dataset.state;
  else button.dataset.state = state;
  button.replaceChildren(createCopyStateIcon(state, ownerDocument));
}

function createCopyStateIcon(state, ownerDocument) {
  const namespace = "http://www.w3.org/2000/svg";
  const svg = ownerDocument.createElementNS(namespace, "svg");
  svg.setAttribute("class", "markdown-code-copy-icon");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.6");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");

  const paths = state === "success"
    ? ["M4 10.5 8 14.5 16 6.5"]
    : state === "error"
    ? ["M6 6l8 8", "M14 6l-8 8"]
    : [
      "M7.5 6.5h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Z",
      "M13.5 6.5v-2a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h1",
    ];
  for (const pathData of paths) {
    const path = ownerDocument.createElementNS(namespace, "path");
    path.setAttribute("d", pathData);
    svg.append(path);
  }
  return svg;
}

function renderTable(block, ownerDocument) {
  const wrapper = ownerDocument.createElement("div");
  wrapper.className = "markdown-table-wrap";
  const table = ownerDocument.createElement("table");
  const head = ownerDocument.createElement("thead");
  const headRow = ownerDocument.createElement("tr");
  block.headers.forEach((text, index) => {
    const cell = ownerDocument.createElement("th");
    cell.style.textAlign = block.alignments[index];
    appendInline(cell, tokenizeInline(text), ownerDocument);
    headRow.append(cell);
  });
  head.append(headRow);
  table.append(head);

  if (block.rows.length) {
    const body = ownerDocument.createElement("tbody");
    for (const row of block.rows) {
      const tableRow = ownerDocument.createElement("tr");
      row.forEach((text, index) => {
        const cell = ownerDocument.createElement("td");
        cell.style.textAlign = block.alignments[index];
        appendInline(cell, tokenizeInline(text), ownerDocument);
        tableRow.append(cell);
      });
      body.append(tableRow);
    }
    table.append(body);
  }

  wrapper.append(table);
  return wrapper;
}

function appendInline(parent, tokens, ownerDocument) {
  for (const token of tokens) {
    if (token.type === "text") {
      appendTextWithBreaks(parent, token.text, ownerDocument);
    } else if (token.type === "code") {
      const code = ownerDocument.createElement("code");
      code.textContent = token.text;
      parent.append(code);
    } else if (token.type === "strong" || token.type === "emphasis") {
      const element = ownerDocument.createElement(token.type === "strong" ? "strong" : "em");
      appendInline(element, token.children, ownerDocument);
      parent.append(element);
    } else if (token.type === "link") {
      appendLink(parent, token.href, token.children, ownerDocument);
    } else if (token.type === "imageLink") {
      const label = [{ type: "text", text: `图片：${token.text}` }];
      appendLink(parent, token.href, label, ownerDocument, "markdown-image-link");
    }
  }
}

function appendTextWithBreaks(parent, text, ownerDocument) {
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    if (index) parent.append(ownerDocument.createElement("br"));
    if (line) parent.append(ownerDocument.createTextNode(line));
  });
}

function appendLink(parent, href, children, ownerDocument, className = "") {
  const safeHref = sanitizeHref(href);
  if (!safeHref) {
    const span = ownerDocument.createElement("span");
    if (className) span.className = className;
    appendInline(span, children, ownerDocument);
    parent.append(span);
    return;
  }

  const link = ownerDocument.createElement("a");
  link.href = safeHref;
  if (className) link.className = className;
  if (/^https?:/i.test(safeHref)) {
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  }
  appendInline(link, children, ownerDocument);
  parent.append(link);
}
