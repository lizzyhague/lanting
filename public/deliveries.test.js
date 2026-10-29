import assert from "node:assert/strict";
import test from "node:test";
import { deliveryPath, findDeliveryLinks } from "./markdown.js";

test("delivery extraction follows rendered blocks and ignores code and images", () => {
  const link = (name) => `[${name}](/deliver?path=%2Fproject%2F${name})`;
  const source = [link("paragraph"), `# ${link("heading")}`, `- **${link("list")}**`,
    `> ${link("quote")}`, `| ${link("header")} |\n| --- |\n| ${link("cell")} |`,
    `\`${link("inline")}\``, `~~~\n${link("fenced")}\n~~~`,
    "![image](/deliver?path=%2Fimage)", "[external](https://example.com/deliver?path=%2Fexternal)",
  ].join("\n\n");
  assert.deepEqual(findDeliveryLinks(source).map((link) => link.path),
    ["paragraph", "heading", "list", "quote", "header", "cell"].map((name) => `/project/${name}`));
  assert.equal(deliveryPath("/deliver?path=%2Fproject%2F%E4%B8%AD%E6%96%87.txt"), "/project/中文.txt");
  assert.equal(deliveryPath("/deliver"), null);
  assert.equal(deliveryPath("//example.com/deliver?path=x"), null);
});
