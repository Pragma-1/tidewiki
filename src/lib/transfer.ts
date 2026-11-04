import { waitForDrain } from "./stream-util";
import {
  createWriteStream,
  mkdirSync,
  openSync,
  readSync,
  closeSync,
  rmSync,
  writeFileSync,
  renameSync,
  readFileSync,
  statSync,
  existsSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { Unzip, UnzipInflate, UnzipPassThrough, Zip, ZipDeflate, ZipPassThrough } from "fflate";
import { db, now } from "./db";
import { LIMITS as APP } from "./config";
import { getPage, getTree, createPage, updatePage, type TreeNode } from "./pages";
import { LIMITS as MEDIA, MEDIA_DIR, sniff, stripImage, type MediaRow } from "./media";
import { HttpError, slugify } from "./validate";

/* ============================================================ front matter */

export { parseFrontMatter, toMarkdownFile } from "./frontmatter";
import { parseFrontMatter, toMarkdownFile } from "./frontmatter";

const cleanTitle = (s: string) =>
  s
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, APP.titleChars);
const firstHeading = (md: string) => /^#\s+(.+)$/m.exec(md)?.[1]?.trim() ?? null;
const prettify = (seg: string) => {
  const s = seg
    .replace(/\.(md|markdown)$/i, "")
    .replace(/[-_]+/g, " ")
    .trim();
  return s ? s[0].toUpperCase() + s.slice(1) : "Untitled";
};

/* ================================================================ export */

/** Folder layout: leaf pages are `slug.md`, pages with children are `slug/index.md`; media in `_media/`. */
function exportPaths(nodes: TreeNode[], prefix = ""): { id: number; path: string }[] {
  return nodes.flatMap((n) =>
    n.children.length
      ? [{ id: n.id, path: `${prefix}${n.slug}/index.md` }, ...exportPaths(n.children, `${prefix}${n.slug}/`)]
      : [{ id: n.id, path: `${prefix}${n.slug}.md` }],
  );
}

/** Streams the whole wiki as a ZIP. Pull-based, so memory stays flat no matter how big the media folder is. */
export function exportWikiZip(): ReadableStream<Uint8Array> {
  let pullWaiter: (() => void) | null = null;
  let cancelled = false;
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>(
    {
      start(c) {
        ctrl = c;
      },
      pull() {
        pullWaiter?.();
        pullWaiter = null;
      },
      cancel() {
        cancelled = true;
        pullWaiter?.();
      },
    },
    { highWaterMark: 8 },
  );
  const drained = async () => {
    while (!cancelled && (ctrl.desiredSize ?? 1) <= 0)
      await new Promise<void>((r) => {
        pullWaiter = r;
      });
  };

  const zip = new Zip((err, chunk, final) => {
    if (cancelled) return;
    if (err) {
      ctrl.error(err);
      return;
    }
    ctrl.enqueue(chunk);
    if (final) ctrl.close();
  });
  const addText = (name: string, text: string) => {
    const f = new ZipDeflate(name, { level: 6 });
    zip.add(f);
    f.push(new TextEncoder().encode(text), true);
  };

  (async () => {
    try {
      const paths = exportPaths(getTree());
      const pages = db().prepare("SELECT id, slug, title, content, updated_at FROM pages").all() as {
        id: number;
        slug: string;
        title: string;
        content: string;
        updated_at: number;
      }[];
      const byId = new Map(pages.map((p) => [p.id, p]));
      const media = db().prepare("SELECT name, original_name, mime FROM media ORDER BY id").all() as Pick<
        MediaRow,
        "name" | "original_name" | "mime"
      >[];
      addText(
        "tidewiki.json",
        JSON.stringify(
          {
            format: "tidewiki-export",
            version: 1,
            exported_at: new Date().toISOString(),
            pages: paths.map((p) => ({ path: p.path, slug: byId.get(p.id)!.slug, title: byId.get(p.id)!.title })),
            media: media.map((m) => ({ name: m.name, original_name: m.original_name, mime: m.mime })),
          },
          null,
          2,
        ),
      );
      for (const p of paths) {
        if (cancelled) return;
        const page = byId.get(p.id)!;
        addText(p.path, toMarkdownFile(page.title, page.content));
        await drained();
      }
      for (const m of media) {
        const file = path.join(/* turbopackIgnore: true */ MEDIA_DIR(), m.name);
        if (!existsSync(file)) continue;
        const entry = new ZipPassThrough(`_media/${m.name}`); // images/videos are already compressed
        zip.add(entry);
        const fh = await open(file, "r");
        try {
          const buf = Buffer.alloc(256 * 1024);
          for (;;) {
            if (cancelled) return;
            const { bytesRead } = await fh.read(buf, 0, buf.length, null);
            entry.push(new Uint8Array(buf.subarray(0, bytesRead)), bytesRead === 0);
            if (bytesRead === 0) break;
            await drained();
          }
        } finally {
          await fh.close();
        }
      }
      zip.end();
    } catch (e) {
      if (!cancelled) ctrl.error(e);
    }
  })();
  return stream;
}

/* ================================================================ import */

export const IMPORT_LIMITS = {
  upload: (Number.parseInt(process.env.WIKI_MAX_IMPORT_MB || "", 10) || 1024) * 1024 * 1024,
  entries: 5000,
  markdownTotal: 100 * 1024 * 1024,
  uncompressedTotal: 4 * 1024 * 1024 * 1024,
};
export type Conflict = "skip" | "overwrite" | "copy";
export type PlanItem = {
  path: string;
  title: string;
  slug: string;
  parent: string | null;
  action: "create" | "overwrite" | "skip" | "copy";
};
export type ImportResult = {
  pages: PlanItem[];
  media: number;
  mediaReused: number;
  warnings: string[];
  created: number;
  updated: number;
  skipped: number;
};

const IMPORT_DIR = () => path.join(/* turbopackIgnore: true */ MEDIA_DIR(), ".import");

/** Streams the request body into a temp file with a hard cap. */
export async function receiveUpload(body: ReadableStream<Uint8Array>, declared: number): Promise<string> {
  if (declared > IMPORT_LIMITS.upload) throw new HttpError(413, "This file is too large.");
  mkdirSync(IMPORT_DIR(), { recursive: true, mode: 0o700 });
  const file = path.join(/* turbopackIgnore: true */ IMPORT_DIR(), `upload-${randomBytes(9).toString("hex")}`);
  const out = createWriteStream(file, { mode: 0o600 });
  let failed: Error | null = null;
  out.on("error", (e) => {
    failed = e;
  });
  const reader = body.getReader();
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > IMPORT_LIMITS.upload) throw new HttpError(413, "This file is too large.");
      if (failed) throw new HttpError(500, "Something went wrong on the server.");
      if (!out.write(value)) await waitForDrain(out);
    }
    await new Promise<void>((res, rej) => out.end((e?: Error | null) => (e ? rej(e) : res())));
    if (size === 0) throw new HttpError(400, "Empty request.");
    return file;
  } catch (e) {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
    out.destroy();
    rmSync(file, { force: true });
    throw e;
  }
}

type Entry = { path: string; kind: "md" | "media"; data?: Buffer; tmp?: string; size: number };

/** Archive paths are only ever *names* here — nothing is written to disk under them, so zip-slip can't happen. */
function normalizeEntry(raw: string): { path: string; kind: "md" | "media" } | { skip: string } {
  const p = raw.replace(/\\/g, "/").replace(/^\.\//, "");
  if (/[\u0000-\u001f\u007f]/.test(p) || p.length > 400) return { skip: "invalid name" };
  if (p.endsWith("/") || p === "tidewiki.json") return { skip: "folder" }; // folders and our own manifest: silently ignored
  const segs = p.split("/");
  if (segs.some((s) => s === "" || s === "." || s === "..") || p.startsWith("/")) return { skip: "unsafe path" };
  if (segs.some((s) => s.startsWith(".") || s === "__MACOSX")) return { skip: "hidden file" };
  if (
    segs[0] === "_media" &&
    segs.length === 2 &&
    /^[\w.-]{1,120}\.(png|jpe?g|gif|webp|mp4|webm|ogv|mov)$/i.test(segs[1])
  )
    return { path: p, kind: "media" };
  if (/\.(md|markdown)$/i.test(p)) return { path: p, kind: "md" };
  return { skip: "unsupported file type" };
}

/** Decompresses a ZIP with every limit enforced *while* inflating (zip bombs stop at the cap, not after). */
async function readZip(file: string, wantMedia: boolean, warnings: string[]): Promise<Entry[]> {
  mkdirSync(IMPORT_DIR(), { recursive: true, mode: 0o700 });
  const entries: Entry[] = [];
  let count = 0,
    total = 0,
    mdTotal = 0,
    fatal: Error | null = null;
  const pending = new Set<Promise<void>>();
  const unzip = new Unzip((f) => {
    if (fatal) return;
    if (++count > IMPORT_LIMITS.entries) {
      fatal = new HttpError(413, "The archive has too many files.");
      return;
    }
    const n = normalizeEntry(f.name);
    if ("skip" in n) {
      if (n.skip !== "folder" && n.skip !== "hidden file") warnings.push(`${f.name.slice(0, 120)}: ${n.skip}`);
      return;
    }
    const cap = n.kind === "md" ? APP.pageBytes : /\.(png|jpe?g|gif|webp)$/i.test(n.path) ? MEDIA.image : MEDIA.video;
    const e: Entry = { path: n.path, kind: n.kind, size: 0 };
    const chunks: Buffer[] = [];
    let ws: ReturnType<typeof createWriteStream> | null = null;
    if (n.kind === "media") {
      if (!wantMedia) {
        e.size = -1;
      } else {
        e.tmp = path.join(/* turbopackIgnore: true */ IMPORT_DIR(), `m-${randomBytes(9).toString("hex")}`);
        ws = createWriteStream(e.tmp, { mode: 0o600 });
        ws.on("error", () => {
          /* reported via size check below */
        });
      }
    }
    let over = false;
    const done = new Promise<void>((resolve) => {
      f.ondata = (err, data, final) => {
        if (err) {
          warnings.push(`${n.path}: ${err.message}`);
          over = true;
          ws?.destroy();
          resolve();
          return;
        }
        if (over) return;
        e.size += data.length;
        total += data.length;
        if (n.kind === "md") mdTotal += data.length;
        if (total > IMPORT_LIMITS.uncompressedTotal || mdTotal > IMPORT_LIMITS.markdownTotal) {
          fatal = new HttpError(413, "The archive unpacks to more data than allowed.");
          over = true;
          f.terminate();
          ws?.destroy();
          resolve();
          return;
        }
        if (e.size > cap) {
          warnings.push(`${n.path}: too large, skipped`);
          over = true;
          f.terminate();
          ws?.destroy();
          resolve();
          return;
        }
        if (n.kind === "md") chunks.push(Buffer.from(data));
        else ws?.write(data);
        if (final) {
          if (n.kind === "md") {
            e.data = Buffer.concat(chunks);
            entries.push(e);
            resolve();
          } else if (ws)
            ws.end(() => {
              entries.push(e);
              resolve();
            });
          else {
            entries.push(e);
            resolve();
          }
        }
      };
    });
    pending.add(done);
    try {
      f.start();
    } catch (err) {
      warnings.push(`${n.path}: ${(err as Error).message}`);
    }
  });
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough);

  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(256 * 1024);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      try {
        unzip.push(new Uint8Array(buf.subarray(0, n)), n === 0);
      } catch (err) {
        throw new HttpError(400, `This archive can’t be read: ${(err as Error).message.slice(0, 120)}`);
      }
      if (fatal) throw fatal;
      if (n === 0) break;
      await new Promise((r) => setImmediate(r)); // stay responsive for other requests
    }
  } finally {
    closeSync(fd);
  }
  await Promise.all(pending);
  if (fatal) throw fatal;
  return entries;
}

function decodeText(b: Buffer, name: string, warnings: string[]): string | null {
  if (b.includes(0)) {
    warnings.push(`${name}: not a text file, skipped`);
    return null;
  }
  const s = new TextDecoder("utf-8", { fatal: false }).decode(b);
  if (s.includes("�")) warnings.push(`${name}: contained invalid UTF-8 characters (replaced)`);
  return s;
}

/**
 * Imports a ZIP (wiki export or any folder of .md files) or a single .md file.
 * `apply=false` only plans and reports; nothing is written.
 */
export async function importArchive(
  file: string,
  opts: { apply: boolean; conflict: Conflict; userId: number; singleName?: string },
): Promise<ImportResult> {
  const warnings: string[] = [];
  const head = Buffer.alloc(4);
  const fd = openSync(file, "r");
  readSync(fd, head, 0, 4, 0);
  closeSync(fd);
  const isZip = head.readUInt32LE(0) === 0x04034b50 || head.readUInt32LE(0) === 0x06054b50;
  let entries: Entry[];
  if (isZip) entries = await readZip(file, opts.apply, warnings);
  else {
    if (statSync(file).size > APP.pageBytes) throw new HttpError(413, "This page is too large.");
    const name = (opts.singleName || "import.md").replace(/[^\w.\- ]/g, "").slice(0, 120) || "import.md";
    entries = [
      { path: /\.(md|markdown)$/i.test(name) ? name : `${name}.md`, kind: "md", data: readFileSync(file), size: 0 },
    ];
  }
  const tmpFiles = entries.map((e) => e.tmp).filter(Boolean) as string[];
  try {
    return await plan(entries, opts, warnings);
  } finally {
    for (const t of tmpFiles) rmSync(t, { force: true });
  }
}

async function plan(
  entries: Entry[],
  opts: { apply: boolean; conflict: Conflict; userId: number },
  warnings: string[],
): Promise<ImportResult> {
  // ---- pages: folder structure -> hierarchy
  type Node = {
    key: string;
    title: string;
    slug: string;
    content: string;
    parentKey: string | null;
    depth: number;
    path: string;
  };
  const nodes = new Map<string, Node>();
  const keyOf = (p: string) => {
    const s = p.replace(/\.(md|markdown)$/i, "");
    return s.endsWith("/index") ? s.slice(0, -6) : s === "index" ? "" : s;
  };
  for (const e of entries.filter((x) => x.kind === "md").sort((a, b) => a.path.localeCompare(b.path))) {
    const text = decodeText(e.data!, e.path, warnings);
    if (text === null) continue;
    const key = keyOf(e.path);
    if (key === "") {
      warnings.push(`${e.path}: a root index page was imported as “Home”`);
    }
    const fm = parseFrontMatter(text);
    const seg = key.split("/").pop() || "home";
    const title = cleanTitle(fm.title ?? firstHeading(fm.body) ?? prettify(seg)) || "Untitled";
    nodes.set(key || "home", {
      key: key || "home",
      title,
      slug: slugify(seg),
      content: fm.body,
      parentKey: null,
      depth: 0,
      path: e.path,
    });
  }
  // folders without an index page become empty chapter pages
  for (const n of [...nodes.values()]) {
    const segs = n.key.split("/");
    for (let i = 1; i < segs.length; i++) {
      const k = segs.slice(0, i).join("/");
      if (!nodes.has(k))
        nodes.set(k, {
          key: k,
          title: prettify(segs[i - 1]),
          slug: slugify(segs[i - 1]),
          content: "",
          parentKey: null,
          depth: 0,
          path: `${k}/`,
        });
    }
  }
  for (const n of nodes.values()) {
    const segs = n.key.split("/");
    n.depth = segs.length;
    let parent: string | null = segs.length > 1 ? segs.slice(0, -1).join("/") : null;
    // the wiki nests at most LIMITS.maxPageDepth levels: deeper pages hang under the deepest allowed ancestor
    while (parent && parent.split("/").length >= APP.maxPageDepth) parent = parent.split("/").slice(0, -1).join("/");
    if (parent !== (segs.length > 1 ? segs.slice(0, -1).join("/") : null))
      warnings.push(`${n.path}: nested too deeply, placed under “${nodes.get(parent!)?.title}”`);
    n.parentKey = parent;
  }
  const ordered = [...nodes.values()].sort(
    (a, b) => a.key.split("/").length - b.key.split("/").length || a.key.localeCompare(b.key),
  );
  if (ordered.length > 2000) throw new HttpError(413, "The archive has too many files.");

  // ---- media: reuse identical names (re-import into the same wiki), otherwise store through the upload pipeline
  const mediaEntries = entries.filter((e) => e.kind === "media");
  const rename = new Map<string, string>();
  let mediaReused = 0;
  const stored: string[] = [];
  const claimed = new Set<string>(); // a slug used twice inside the archive must not "conflict" with itself
  const planItems: PlanItem[] = ordered.map((n) => {
    const existing = claimed.has(n.slug) ? undefined : getPage(n.slug);
    claimed.add(n.slug);
    const action: PlanItem["action"] = !existing
      ? "create"
      : opts.conflict === "overwrite"
        ? "overwrite"
        : opts.conflict === "copy"
          ? "copy"
          : "skip";
    return {
      path: n.path,
      title: n.title,
      slug: n.slug,
      parent: n.parentKey ? nodes.get(n.parentKey)!.title : null,
      action,
    };
  });
  const result: ImportResult = {
    pages: planItems,
    media: mediaEntries.length,
    mediaReused: 0,
    warnings,
    created: 0,
    updated: 0,
    skipped: planItems.filter((p) => p.action === "skip").length,
  };
  if (!opts.apply) return result;

  try {
    for (const e of mediaEntries) {
      const oldName = e.path.split("/")[1];
      if (db().prepare("SELECT 1 FROM media WHERE name=?").get(oldName)) {
        rename.set(oldName, oldName);
        mediaReused++;
        continue;
      }
      const buf = readFileSync(e.tmp!);
      const type = sniff(buf.subarray(0, 64));
      if (!type) {
        warnings.push(`${e.path}: not a supported image or video, skipped`);
        continue;
      }
      let data: Buffer;
      try {
        data = type.kind === "image" ? stripImage(buf, type.ext) : buf;
      } catch {
        warnings.push(`${e.path}: damaged file, skipped`);
        continue;
      }
      const name = `${randomBytes(16).toString("base64url")}.${type.ext}`;
      const dest = path.join(/* turbopackIgnore: true */ MEDIA_DIR(), name);
      writeFileSync(`${dest}.part`, data, { mode: 0o600 });
      renameSync(`${dest}.part`, dest);
      stored.push(dest);
      db()
        .prepare("INSERT INTO media(name,mime,kind,size,original_name,created_by,created_at) VALUES(?,?,?,?,?,?,?)")
        .run(name, type.mime, type.kind, data.length, oldName.slice(0, 120), opts.userId, now());
      rename.set(oldName, name);
    }
    result.mediaReused = mediaReused;
    const fix = (md: string) =>
      md.replace(/\/media\/([A-Za-z0-9_-]{8,60}\.(?:png|jpe?g|gif|webp|mp4|webm|ogv|mov))/g, (m, n: string) =>
        rename.has(n) ? `/media/${rename.get(n)}` : m,
      );

    // ---- pages, all-or-nothing
    db().transaction(() => {
      const idByKey = new Map<string, number>();
      ordered.forEach((n, i) => {
        const item = planItems[i];
        const parentId = n.parentKey ? (idByKey.get(n.parentKey) ?? null) : null;
        const existing = item.action === "create" || item.action === "copy" ? undefined : getPage(n.slug);
        if (item.action === "skip" && existing) {
          idByKey.set(n.key, existing.id);
          return;
        }
        if (item.action === "overwrite" && existing) {
          const p = updatePage(existing.slug, {
            title: n.title,
            content: fix(n.content),
            parentId: parentId === existing.id ? existing.parent_id : parentId,
            expectedRev: existing.rev,
            userId: opts.userId,
          });
          idByKey.set(n.key, p.id);
          result.updated++;
          return;
        }
        const p = createPage({ title: n.title, content: fix(n.content), parentId, userId: opts.userId, slug: n.slug });
        item.slug = p.slug;
        idByKey.set(n.key, p.id);
        result.created++;
      });
    })();
    return result;
  } catch (e) {
    // roll back stored media too, so a failed import leaves nothing behind
    for (const f of stored) {
      rmSync(f, { force: true });
      db().prepare("DELETE FROM media WHERE name=?").run(path.basename(f));
    }
    throw e;
  }
}
