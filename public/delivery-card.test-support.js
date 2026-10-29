export function recordingDocument() {
  const clicks = [];
  const createElement = (tagName) => ({
    tagName: tagName.toUpperCase(), children: [], attributes: {}, dataset: {}, listeners: {}, textContent: "",
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    addEventListener(type, listener) { this.listeners[type] = listener; },
    click() { clicks.push({ href: this.href, download: this.download }); },
    remove() { this.removed = true; },
  });
  return { createElement, body: createElement("body"), clicks,
    createTextNode(text) { return { textContent: text }; },
    createElementNS(_namespace, tagName) { return createElement(tagName); } };
}

export function descendants(node, className) {
  return [node, ...(node.children ?? []).flatMap((child) => descendants(child, className))]
    .filter((item) => item.className === className);
}
