import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/** Immutable copies of public scripts/styles; no separate build command is needed. */
export class WebAssets {
  readonly #root: string;
  readonly #files: ReadonlySet<string>;
  #publishing: Promise<void> = Promise.resolve();

  constructor(root: string, files: Iterable<string>) {
    this.#root = root;
    this.#files = new Set(files);
  }

  async page(html: Buffer): Promise<Buffer> {
    // Only collect files from the HTTP allowlist, never arbitrary public/ contents.
    const entries: [string, Buffer][] = [];
    for (const file of [...this.#files].sort()) {
      try {
        entries.push([file, await readFile(path.join(this.#root, file))]);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const hash = createHash("sha256");
    for (const [file, body] of entries) hash.update(file).update("\0").update(String(body.length)).update("\0").update(body);
    const version = hash.digest("hex");
    const directory = path.join(this.#root, ".web-assets", version);
    // Serialize publication so no request can receive a partially written snapshot.
    const publish = this.#publishing.then(async () => {
      try {
        if ((await stat(directory)).isDirectory()) return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await mkdir(path.dirname(directory), { recursive: true });
      const staging = await mkdtemp(path.join(path.dirname(directory), ".staging-"));
      try {
        for (const [file, body] of entries) await writeFile(path.join(staging, file), body);
        try { await rename(staging, directory); }
        catch (error) {
          if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        }
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    });
    this.#publishing = publish.catch(() => {});
    await publish;

    const available = new Set(entries.map(([file]) => file));
    const rewritten = html.toString("utf8").replace(
      /\b(src|href)="\/([^"?#]+)(?:\?[^"#]*)?"/gu,
      (original, attribute: string, file: string) => {
        if (!this.#files.has(file)) return original;
        if (!available.has(file)) throw new Error(`Missing public asset: ${file}`);
        return `${attribute}="/assets/${version}/${file}"`;
      },
    );
    // SW saves an offline page only after every script, including module imports, is cached.
    const assetList = entries.map(([file]) => `/assets/${version}/${file}`).join(",");
    return Buffer.from(rewritten.replace("</head>", `<meta name="lanting-assets" content="${assetList}">\n</head>`));
  }

  async read(pathname: string): Promise<{ body: Buffer; file: string } | null> {
    const match = /^\/assets\/([a-f0-9]{64})\/([a-zA-Z0-9_.-]+)$/u.exec(pathname);
    if (!match || !this.#files.has(match[2]!)) return null;
    try {
      return {
        body: await readFile(path.join(this.#root, ".web-assets", match[1]!, match[2]!)),
        file: match[2]!,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
}
