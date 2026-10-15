import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { inflateSync } from "node:zlib";

// 样式表以外不能引用 CSS 变量的颜色：页面头部、PWA 清单和图标。
// 页面底色在配色模块里由公式混出，这里按同一公式算出实际色值再比对。

const styles = await readFile(new URL("./styles.css", import.meta.url), "utf8");
const root = styles.slice(0, styles.indexOf("\n}"));
const ICON_TILE = "#141413";

function declaration(name) {
  const match = root.match(new RegExp(`^\\s*${name}:\\s*([^;]+);`, "mu"));
  assert.ok(match, `配色模块缺少 ${name}`);
  return match[1].trim();
}

function rgb(hex) {
  return [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
}

function hex(channels) {
  return `#${channels.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;
}

function mix(a, percent, b) {
  const p = percent / 100;
  return a.map((c, i) => c * p + b[i] * (1 - p));
}

function pageBackground() {
  // 公式写死在这里；配色模块的公式变了，这两条断言会先失败，提醒同步修改本测试。
  assert.equal(declaration("--tint"), "color-mix(in srgb, var(--theme) var(--mix-tint), var(--neutral))");
  assert.equal(declaration("--surface-page"), "color-mix(in srgb, var(--tint) var(--mix-surface-page), black)");
  const percent = (name) => Number.parseFloat(declaration(name));
  const tint = mix(rgb(declaration("--theme")), percent("--mix-tint"), rgb(declaration("--neutral")));
  return hex(mix(tint, percent("--mix-surface-page"), [0, 0, 0]));
}

async function text(name) {
  return readFile(new URL(`./${name}`, import.meta.url), "utf8");
}

async function exists(url) {
  try {
    await access(url);
    return true;
  } catch {
    return false;
  }
}

/** 解码 8 位、非隔行的 RGB / RGBA PNG，返回取像素的函数。 */
function decodePng(buffer) {
  let offset = 8;
  let width = 0;
  let colorType = 0;
  const data = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      assert.equal(body[8], 8, "只支持 8 位深度");
      colorType = body[9];
      assert.equal(body[12], 0, "只支持非隔行");
    }
    if (type === "IDAT") data.push(body);
    offset += length + 12;
  }
  const channels = colorType === 6 ? 4 : 3;
  assert.ok(colorType === 6 || colorType === 2, `不支持的颜色类型 ${colorType}`);
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * width);
  for (let y = 0; y < width; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const value = raw[y * (stride + 1) + 1 + x];
      const left = x >= channels ? pixels[y * stride + x - channels] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const corner = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels] : 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - corner;
        const [pa, pb, pc] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - corner)];
        predicted = pa <= pb && pa <= pc ? left : pb <= pc ? up : corner;
      }
      pixels[y * stride + x] = (value + predicted) & 0xff;
    }
  }
  return {
    width,
    pixel(x, y) {
      const i = y * stride + x * channels;
      return { color: hex([pixels[i], pixels[i + 1], pixels[i + 2]]), alpha: channels === 4 ? pixels[i + 3] : 255 };
    },
  };
}

test("page headers and the manifest use the page background", async () => {
  const background = pageBackground();
  for (const page of ["index.html", "view.html"]) {
    const match = (await text(page)).match(/<meta name="theme-color" content="([^"]+)">/u);
    assert.ok(match, `${page} 缺少 theme-color`);
    assert.equal(match[1], background, page);
  }
  const manifest = JSON.parse(await text("manifest.webmanifest"));
  assert.equal(manifest.theme_color, background);
  assert.equal(manifest.background_color, background);
});

test("the app icon tile is the shared dark tile in svg, renderer and PNGs", async () => {
  const svg = await text("icon.svg");
  assert.match(svg, new RegExp(`<rect width="512" height="512" rx="112" fill="${ICON_TILE}"/>`, "u"));

  const renderer = new URL("../tools/render-icons.py", import.meta.url);
  if (await exists(renderer)) {
    const [r, g, b] = rgb(ICON_TILE).map((c) => `0x${c.toString(16).padStart(2, "0").toUpperCase()}`);
    assert.match(await readFile(renderer, "utf8"), new RegExp(`^BG = \\(${r}, ${g}, ${b}\\)$`, "mu"));
  }

  const manifest = JSON.parse(await text("manifest.webmanifest"));
  for (const icon of manifest.icons) {
    const png = decodePng(await readFile(new URL(`.${icon.src}`, import.meta.url)));
    // 顶边正中靠下一点：在圆角之内，也在图形之外，只会是底板。
    const sample = png.pixel(png.width >> 1, Math.round(png.width * 0.08));
    assert.deepEqual(sample, { color: ICON_TILE, alpha: 255 }, icon.src);
  }
});
