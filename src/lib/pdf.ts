import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
// loaded by the worker; imported here so the build ships the package (and its dependencies)
import "pdfmake";
import { openSync } from "fontkit";
import hljs from "highlight.js/lib/common";
import { parseMarkdown, type Token } from "./markdown";
import { classify, MEDIA_PATH } from "./embed-url";
import { MEDIA_DIR, stripImage } from "./media";
import { BASE_URL } from "./config";
import { formatDate, makeT, type Lang, type T } from "./i18n";
import { HttpError } from "./validate";

/*
 * A page as a PDF, laid out on the server (pdfmake → pdfkit): A4, embedded Inter and JetBrains
 * Mono, headings as bookmarks, page numbers, tables with repeated header rows, highlighted code,
 * callouts, task lists, footnotes, and the wiki's own PNG/JPEG images.
 *
 * Safety: the PDF is built from the parsed Markdown only — no HTML, no browser. pdfmake may not
 * fetch anything over the network and may only read the font files (both enforced through its
 * access policies); images are read by this code from the wiki's media folder and handed over
 * as data, after their size has been checked. Nothing from elsewhere is ever loaded: external
 * images and videos become links. At most two PDFs are made at the same time.
 */

const FONT_DIR = () => path.join(/* turbopackIgnore: true */ process.cwd(), "pdf-fonts");
const FONT_FILES = {
  Inter: {
    normal: "Inter-Regular.ttf",
    bold: "Inter-SemiBold.ttf",
    italics: "Inter-Italic.ttf",
    bolditalics: "Inter-SemiBoldItalic.ttf",
  },
  Mono: {
    normal: "JetBrainsMono-Regular.ttf",
    bold: "JetBrainsMono-Bold.ttf",
    italics: "JetBrainsMono-Regular.ttf",
    bolditalics: "JetBrainsMono-Bold.ttf",
  },
} as const;

type Glyphs = { hasGlyphForCodePoint(c: number): boolean };
type FontFiles = Record<
  keyof typeof FONT_FILES,
  { normal: string; bold: string; italics: string; bolditalics: string }
>;
let ready: { glyphs: { text: Glyphs; mono: Glyphs }; fonts: FontFiles } | null = null;
function setup() {
  if (ready) return ready;
  const dir = FONT_DIR();
  const fonts = Object.fromEntries(
    Object.entries(FONT_FILES).map(([fam, f]) => [
      fam,
      Object.fromEntries(Object.entries(f).map(([k, v]) => [k, path.join(/* turbopackIgnore: true */ dir, v)])),
    ]),
  ) as FontFiles;
  for (const f of Object.values(fonts))
    for (const p of Object.values(f)) if (!existsSync(p)) throw new Error(`PDF font missing: ${p} (run npm run fonts)`);
  ready = { glyphs: { text: openSync(fonts.Inter.normal), mono: openSync(fonts.Mono.normal) }, fonts };
  return ready;
}

/* ------------------------------------------------------------------ look */

const C = {
  ink: "#1d2329",
  ink2: "#5b6470",
  line: "#d5dae1",
  accent: "#2c5a96",
  codeBg: "#f4f6f8",
  codeInline: "#eef1f4",
  mark: "#fff1a8",
  callout: {
    info: { bar: "#3d7bd9", bg: "#eef4fd" },
    tip: { bar: "#2f9a6a", bg: "#ecf8f2" },
    warning: { bar: "#d08a12", bg: "#fdf5e6" },
    danger: { bar: "#d2453d", bg: "#fdeeed" },
  } as Record<string, { bar: string; bg: string }>,
};
// highlight.js classes → colours (GitHub's light theme)
const HL: Record<string, string> = {
  keyword: "#cf222e",
  "meta keyword": "#cf222e",
  built_in: "#8250df",
  type: "#8250df",
  literal: "#0550ae",
  number: "#0550ae",
  string: "#0a3069",
  regexp: "#0a3069",
  symbol: "#0550ae",
  title: "#8250df",
  "title function_": "#8250df",
  "title class_": "#953800",
  attr: "#0550ae",
  attribute: "#0550ae",
  variable: "#953800",
  params: "#24292f",
  comment: "#6e7781",
  quote: "#6e7781",
  meta: "#0550ae",
  tag: "#116329",
  name: "#116329",
  selector: "#116329",
  "selector-class": "#6639ba",
  "selector-id": "#0550ae",
  addition: "#116329",
  deletion: "#82071e",
  section: "#0550ae",
  bullet: "#953800",
  link: "#0a3069",
  property: "#0550ae",
};

const PAGE = { width: 595.28, height: 841.89, margins: [56, 58, 56, 58] as [number, number, number, number] };
const CONTENT_W = PAGE.width - PAGE.margins[0] - PAGE.margins[2];
const BASE_SIZE = 10.5;
const CODE_SIZE = 8.4;
const CODE_COLS = Math.floor((CONTENT_W - 24) / (CODE_SIZE * 0.6)) - 1; // JetBrains Mono: every glyph 0.6 em
const MAX_IMAGES = 60;
const NO_LIGATURES = { calt: false, liga: false, dlig: false };
const MAX_IMAGE_BYTES = 60 * 1024 * 1024;
const MAX_PIXELS = 50_000_000;

/* ------------------------------------------------------------ building */

type Run = Record<string, unknown> & { text: string };
type Node = Record<string, unknown>;
type Style = {
  bold?: boolean;
  italics?: boolean;
  strike?: boolean;
  underline?: boolean;
  mark?: boolean;
  code?: boolean;
  /** inside a code block: the block sets size and background */
  block?: boolean;
  sub?: boolean;
  sup?: boolean;
  link?: string;
  dest?: string;
  color?: string;
};

/** Width × height from a PNG or JPEG header (null if it isn't one of those or looks broken). */
export function imageSize(b: Buffer): { w: number; h: number } | null {
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47 && b.toString("latin1", 12, 16) === "IHDR")
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        i += 2;
        continue;
      }
      const len = b.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
        return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
      if (len < 2) return null;
      i += 2 + len;
    }
  }
  return null;
}

class Builder {
  images: Record<string, string> = {};
  imageBytes = 0;
  footnotes = new Map<number, Node[]>();
  outline: { level: number; id: string }[] = [];
  t: T;
  constructor(
    readonly lang: Lang,
    readonly glyphs: { text: Glyphs; mono: Glyphs },
    readonly pageUrl: string,
    readonly withImages: boolean,
  ) {
    this.t = makeT(lang);
  }

  /** Splits text into runs the embedded fonts can draw; characters neither font has are left out. */
  cover(text: string, s: Style): Run[] {
    const base = s.code ? this.glyphs.mono : this.glyphs.text;
    const other = s.code ? this.glyphs.text : this.glyphs.mono;
    const runs: Run[] = [];
    let cur = "",
      curMono = !!s.code;
    const flush = () => {
      if (cur) runs.push(...this.longWords({ ...this.styleOf(s, curMono), text: cur }));
      cur = "";
    };
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      if (cp < 0x20 && ch !== "\n") continue;
      let mono: boolean | null;
      if (ch === "\n" || ch === " " || base.hasGlyphForCodePoint(cp)) mono = !!s.code;
      else if (other.hasGlyphForCodePoint(cp)) mono = !s.code;
      else mono = null; // e.g. emoji: no glyph in either font
      if (mono === null) continue;
      if (mono !== curMono) {
        flush();
        curMono = mono;
      }
      cur += ch;
    }
    flush();
    return runs;
  }

  /**
   * An unbroken run longer than a line (a long URL, say) gets invisible break opportunities
   * (zero-width spaces) every 24 characters instead of running off the page. (pdfmake's own
   * "break-all" takes time that grows with the square of the word's length.)
   */
  longWords(run: Run): Run[] {
    if (!/\S{40,}/.test(run.text)) return [run];
    return [{ ...run, text: run.text.replace(/\S{40,}/g, (w) => [...w].join("").replace(/(.{24})/gu, "$1\u200b")) }];
  }

  styleOf(s: Style, mono: boolean): Record<string, unknown> {
    const o: Record<string, unknown> = {};
    // JetBrains Mono's coding ligatures ("->", "==" …) hit a glyph fontkit can't read; plain
    // characters are what code should show anyway
    if (mono) Object.assign(o, { font: "Mono", fontFeatures: NO_LIGATURES });
    if (s.code && !s.block) {
      o.fontSize = BASE_SIZE * 0.88;
      o.background = C.codeInline;
    }
    if (s.bold) o.bold = true;
    if (s.italics) o.italics = true;
    const deco = [s.strike && "lineThrough", s.underline && "underline"].filter(Boolean);
    if (deco.length) o.decoration = deco[0];
    if (s.mark) o.background = C.mark;
    if (s.sub) o.sub = true;
    if (s.sup) o.sup = true;
    if (s.link) {
      o.link = s.link;
      o.color = C.accent;
    }
    if (s.dest) {
      o.linkToDestination = s.dest;
      o.color = C.accent;
    }
    if (s.color) o.color = s.color;
    return o;
  }

  /** A link target in the PDF: wiki paths become full addresses, #anchors jump inside the document. */
  href(raw: string): Pick<Style, "link" | "dest"> {
    if (raw.startsWith("#")) {
      const id = raw.slice(1);
      return /^[\p{L}\p{N}_:-]{1,120}$/u.test(id) ? { dest: id } : {};
    }
    if (raw.startsWith("/") && !raw.startsWith("//")) return { link: BASE_URL + raw };
    if (/^(https?:|mailto:)/i.test(raw)) return { link: raw };
    return {};
  }

  /** Inline content → text runs, with images (which can't sit inside a line in a PDF) as separate blocks. */
  inline(children: Token[], base: Style = {}): (Run[] | Node)[] {
    const out: (Run[] | Node)[] = [];
    let runs: Run[] = [];
    const stack: Style[] = [base];
    const top = () => stack[stack.length - 1];
    const push = (patch: Style) => stack.push({ ...top(), ...patch });
    const pop = () => {
      if (stack.length > 1) stack.pop();
    };
    const text = (s: string, extra: Style = {}) => runs.push(...this.cover(s, { ...top(), ...extra }));
    const block = (n: Node | null) => {
      if (!n) return;
      if (runs.length) out.push(runs);
      runs = [];
      out.push(n);
    };
    for (const tok of children) {
      switch (tok.type) {
        case "text":
          text(tok.content);
          break;
        case "softbreak":
          text(" ");
          break;
        case "hardbreak":
          text("\n");
          break;
        case "code_inline":
          text(tok.content, { code: true });
          break;
        case "strong_open":
          push({ bold: true });
          break;
        case "em_open":
          push({ italics: true });
          break;
        case "s_open":
          push({ strike: true });
          break;
        case "ins_open":
          push({ underline: true });
          break;
        case "mark_open":
          push({ mark: true });
          break;
        case "sub_open":
          push({ sub: true });
          break;
        case "sup_open":
          push({ sup: true });
          break;
        case "abbr_open":
          push({});
          break;
        case "link_open":
          push(this.href(String(tok.attrGet("href") ?? "")));
          break;
        case "strong_close":
        case "em_close":
        case "s_close":
        case "ins_close":
        case "mark_close":
        case "sub_close":
        case "sup_close":
        case "abbr_close":
        case "link_close":
          pop();
          break;
        case "emoji":
          if (
            /^\p{Extended_Pictographic}/u.test(tok.content) &&
            !this.glyphs.text.hasGlyphForCodePoint(tok.content.codePointAt(0)!)
          )
            text(`:${tok.markup}:`);
          else text(tok.content);
          break;
        case "footnote_ref": {
          const n = (tok.meta as { id: number }).id + 1;
          text(`[${n}]`, { sup: true, dest: `fn${n}` });
          break;
        }
        case "html_inline":
          // the task-list plugin's checkbox; drawn by the list instead
          break;
        case "image": {
          const src = String(tok.attrGet("src") ?? "");
          const alt = (tok.children ?? []).map((c) => c.content).join("") || tok.content;
          block(this.image(src, alt));
          break;
        }
        case "media_embed": {
          const { url, title } = tok.meta as { url: string; title: string };
          block(this.embed(url, title));
          break;
        }
        default:
          if (tok.content && !tok.type.endsWith("_open") && !tok.type.endsWith("_close")) text(tok.content);
      }
    }
    if (runs.length) out.push(runs);
    return out;
  }

  /** A paragraph-like block: text runs → one text node; images stay blocks. */
  para(children: Token[], node: Node, base: Style = {}): Node[] {
    return this.inline(children, base).flatMap((part) =>
      Array.isArray(part)
        ? this.chunks(part).map((text, k, all) => ({
            ...node,
            text,
            ...(k < all.length - 1 ? { margin: [0, 0, 0, 0] } : {}),
          }))
        : [part],
    );
  }

  /**
   * pdfmake's time for one paragraph grows with the square of its length; a paragraph of more
   * than 20,000 characters is laid out in parts (split between words).
   */
  chunks(runs: Run[]): Run[][] {
    const LIMIT = 20_000;
    let total = 0;
    for (const r of runs) total += r.text.length;
    if (total <= LIMIT) return [runs];
    const out: Run[][] = [];
    let cur: Run[] = [],
      len = 0;
    for (const r of runs) {
      let rest = r.text;
      while (len + rest.length > LIMIT) {
        const room = LIMIT - len;
        const cut = rest.lastIndexOf(" ", room);
        const at = cut > 0 ? cut + 1 : room;
        cur.push({ ...r, text: rest.slice(0, at) });
        out.push(cur);
        cur = [];
        len = 0;
        rest = rest.slice(at);
      }
      if (rest) {
        cur.push({ ...r, text: rest });
        len += rest.length;
      }
    }
    if (cur.length) out.push(cur);
    return out;
  }

  image(src: string, alt: string): Node | null {
    const e = classify(src);
    if (e && e.kind !== "link") return this.embed(src, alt);
    const placeholder = (why: string, link?: string) => ({
      text: [
        { text: `${this.t("Image")}: `, bold: true },
        { text: alt || why, ...(link ? { link, color: C.accent } : {}) },
      ],
      color: C.ink2,
      italics: true,
      fontSize: 9.5,
      margin: [0, 4, 0, 6],
    });
    if (!MEDIA_PATH.test(src)) {
      try {
        const u = new URL(src);
        return placeholder(u.href, /^https?:$/.test(u.protocol) ? u.href : undefined);
      } catch {
        return alt ? placeholder(alt) : null;
      }
    }
    const name = src.slice("/media/".length);
    const file = path.join(/* turbopackIgnore: true */ MEDIA_DIR(), name);
    if (!this.withImages || Object.keys(this.images).length >= MAX_IMAGES)
      return placeholder(this.t("shown in the wiki"), this.pageUrl);
    try {
      const size = statSync(file).size;
      if (this.imageBytes + size > MAX_IMAGE_BYTES) return placeholder(this.t("shown in the wiki"), this.pageUrl);
      const raw = readFileSync(file);
      const dim = imageSize(raw);
      // only PNG and JPEG can go into a PDF as they are; other formats are shown in the wiki
      if (!dim || dim.w < 1 || dim.h < 1 || dim.w * dim.h > MAX_PIXELS)
        return placeholder(this.t("shown in the wiki"), this.pageUrl);
      const png = raw[0] === 0x89;
      // uploads were stripped of metadata already; done again, so nothing but the picture can travel
      const buf = stripImage(raw, png ? "png" : "jpg");
      const mime = png ? "image/png" : "image/jpeg";
      this.imageBytes += size;
      const key = `img${Object.keys(this.images).length}`;
      this.images[key] = `data:${mime};base64,${buf.toString("base64")}`;
      // never wider than the page, never blown up beyond its own size (96 dpi → points)
      const width = Math.min(CONTENT_W, dim.w * 0.75);
      const height = (width * dim.h) / dim.w;
      const maxH = PAGE.height - PAGE.margins[1] - PAGE.margins[3] - 60;
      const fit = height > maxH ? { fit: [CONTENT_W, maxH] } : { width };
      return {
        stack: [
          { image: key, ...fit, alignment: "center" },
          ...(alt ? [{ text: alt, fontSize: 8.5, color: C.ink2, alignment: "center", margin: [0, 3, 0, 0] }] : []),
        ],
        margin: [0, 6, 0, 8],
        unbreakable: true,
      };
    } catch {
      return placeholder(this.t("shown in the wiki"), this.pageUrl);
    }
  }

  /** Videos and provider embeds can't play on paper: a line with a link to them. */
  embed(url: string, title: string): Node | null {
    const e = classify(url);
    if (!e) return null;
    const href = e.kind === "video" ? (e.src.startsWith("/") ? this.pageUrl : e.src) : e.href;
    const label =
      e.kind === "youtube" ? "YouTube" : e.kind === "vimeo" ? "Vimeo" : e.kind === "video" ? this.t("Video") : e.host;
    return {
      text: [
        { text: e.kind === "link" ? "→ " : "▶ ", color: C.accent },
        { text: `${label}: `, bold: true },
        ...this.cover(title || href, { link: href }),
      ],
      margin: [0, 3, 0, 6],
    };
  }

  /** Code: highlighted, wrapped at the page edge (with a mark), in rows so it can run across pages. */
  code(content: string, lang: string): Node {
    let lines: Run[][] = [];
    const known = lang && hljs.getLanguage(lang);
    const raw = content.replace(/\n$/, "");
    if (known && raw.length < 200_000) {
      const html = hljs.highlight(raw, { language: lang, ignoreIllegals: true }).value;
      lines = this.hlLines(html);
    } else lines = raw.split("\n").map((l) => [{ text: l }]);
    // wrap long lines
    const wrapped: Run[][] = [];
    for (const line of lines) {
      let cur: Run[] = [],
        col = 0;
      for (const r of line) {
        let rest = r.text;
        while (col + [...rest].length > CODE_COLS) {
          const take = CODE_COLS - col;
          const chars = [...rest];
          cur.push({ ...r, text: chars.slice(0, take).join("") });
          wrapped.push(cur);
          cur = [{ text: "↪ ", color: C.ink2 }];
          col = 2;
          rest = chars.slice(take).join("");
        }
        if (rest) {
          cur.push({ ...r, text: rest });
          col += [...rest].length;
        }
      }
      wrapped.push(cur.length ? cur : [{ text: " " }]);
    }
    const rows: Node[][] = [];
    for (let i = 0; i < wrapped.length; i += 40) {
      const chunk = wrapped.slice(i, i + 40);
      const text: Run[] = [];
      chunk.forEach((l, k) => {
        for (const r of l)
          text.push(...this.cover(r.text, { code: true, block: true, color: r.color as string | undefined }));
        if (k < chunk.length - 1) text.push({ text: "\n" });
      });
      rows.push([{ text, fontSize: CODE_SIZE, lineHeight: 1.22, preserveLeadingSpaces: true }]);
    }
    return {
      table: { widths: ["*"], body: rows },
      layout: "twCode",
      margin: [0, 2, 0, 9],
    };
  }

  /** highlight.js HTML (spans and escaped text only) → coloured runs per line. */
  hlLines(html: string): Run[][] {
    const lines: Run[][] = [[]];
    const stack: (string | undefined)[] = [];
    const ent = (s: string) =>
      s.replace(/&(lt|gt|amp|quot|#x27|#39);/g, (_m, e: string) =>
        e === "lt" ? "<" : e === "gt" ? ">" : e === "amp" ? "&" : e === "quot" ? '"' : "'",
      );
    for (const part of html.split(/(<span class="[^"]*">|<\/span>)/)) {
      if (!part) continue;
      const open = /^<span class="([^"]*)">$/.exec(part);
      if (open) {
        const cls = open[1].replace(/hljs-/g, "").trim();
        stack.push(HL[cls] ?? HL[cls.split(" ")[0]] ?? stack[stack.length - 1]);
        continue;
      }
      if (part === "</span>") {
        stack.pop();
        continue;
      }
      const color = [...stack].reverse().find(Boolean);
      ent(part)
        .split("\n")
        .forEach((seg, i) => {
          if (i > 0) lines.push([]);
          if (seg) lines[lines.length - 1].push(color ? { text: seg, color } : { text: seg });
        });
    }
    return lines;
  }

  /**
   * A heading must not end up alone at the bottom of a page: it is kept together with the block
   * after it when that block is small (pdfmake's page-break callback would lay the whole document
   * out again for every heading — far too slow for long pages).
   */
  keepHeadings(nodes: Node[]): Node[] {
    const out: Node[] = [];
    for (let k = 0; k < nodes.length; k++) {
      const n = nodes[k];
      const next = nodes[k + 1];
      if (n.headlineLevel && next && !next.headlineLevel && JSON.stringify(next).length < 4000) {
        out.push({ stack: [n, next], unbreakable: true });
        k++;
      } else out.push(n);
    }
    return out;
  }

  /** Block tokens from `i` up to the matching close (or the end) → pdfmake nodes. */
  blocks(tokens: Token[], i: number, until?: string): [Node[], number] {
    const out: Node[] = [];
    while (i < tokens.length) {
      const tok = tokens[i];
      if (until && tok.type === until) return [out, i + 1];
      switch (tok.type) {
        case "heading_open": {
          const level = Number(tok.tag.slice(1));
          const id = String(tok.attrGet("id") ?? "");
          const children = tokens[i + 1].children ?? [];
          const plain = children
            .filter((c) => c.type === "text" || c.type === "code_inline")
            .map((c) => c.content)
            .join("")
            .trim();
          while (this.outline.length && this.outline[this.outline.length - 1].level >= level) this.outline.pop();
          const parent = this.outline[this.outline.length - 1]?.id;
          const node: Node = { style: `h${Math.min(level, 6)}`, headlineLevel: level };
          if (id && /^[\p{L}\p{N}_-]{1,120}$/u.test(id) && level <= 4) {
            Object.assign(node, {
              id,
              outline: true,
              outlineText: plain || " ",
              ...(parent ? { outlineParentId: parent } : {}),
            });
            this.outline.push({ level, id });
          }
          out.push(...this.para(children, node));
          i += 3;
          break;
        }
        case "paragraph_open": {
          const children = tokens[i + 1].children ?? [];
          out.push(...this.para(children, { style: tok.hidden ? "tight" : "p" }));
          i += 3;
          break;
        }
        case "bullet_list_open":
        case "ordered_list_open": {
          const ordered = tok.type === "ordered_list_open";
          const [items, next] = this.listItems(tokens, i + 1, ordered ? "ordered_list_close" : "bullet_list_close");
          const list: Node = ordered ? { ol: items } : { ul: items };
          const start = Number(tok.attrGet("start") ?? 1);
          if (ordered && Number.isSafeInteger(start) && start !== 1) list.start = start;
          out.push({ ...list, margin: [0, 1, 0, 7] });
          i = next;
          break;
        }
        case "blockquote_open": {
          const [inner, next] = this.blocks(tokens, i + 1, "blockquote_close");
          out.push(this.boxed(inner, "quote", { color: C.ink2 }));
          i = next;
          break;
        }
        case "fence":
        case "code_block":
          out.push(this.code(tok.content, tok.info.trim().split(/\s+/)[0] ?? ""));
          i++;
          break;
        case "hr":
          out.push({
            canvas: [{ type: "line", x1: 0, y1: 0, x2: CONTENT_W, y2: 0, lineWidth: 0.6, lineColor: C.line }],
            margin: [0, 8, 0, 10],
          });
          i++;
          break;
        case "table_open": {
          const [node, next] = this.table(tokens, i + 1);
          out.push(node);
          i = next;
          break;
        }
        case "dl_open": {
          const [inner, next] = this.blocks(tokens, i + 1, "dl_close");
          out.push({ stack: inner, margin: [0, 0, 0, 6] });
          i = next;
          break;
        }
        case "dt_open": {
          out.push(...this.para(tokens[i + 1].children ?? [], { style: "tight", bold: true, margin: [0, 4, 0, 1] }));
          i += 3;
          break;
        }
        case "dd_open": {
          const [inner, next] = this.blocks(tokens, i + 1, "dd_close");
          out.push({ stack: inner, margin: [16, 0, 0, 3] });
          i = next;
          break;
        }
        case "footnote_block_open": {
          let j = i + 1;
          while (j < tokens.length && tokens[j].type !== "footnote_block_close") {
            if (tokens[j].type === "footnote_open") {
              const n = (tokens[j].meta as { id: number }).id + 1;
              const [inner, next] = this.blocks(tokens, j + 1, "footnote_close");
              this.footnotes.set(n, inner);
              j = next;
            } else j++;
          }
          i = j + 1;
          break;
        }
        default: {
          const box = /^container_(info|tip|warning|danger|details)_open$/.exec(tok.type);
          if (box) {
            const kind = box[1];
            const [inner, next] = this.blocks(tokens, i + 1, `container_${kind}_close`);
            const title = tok.info.trim().slice(kind.length).trim();
            if (kind === "details") {
              out.push({
                stack: [{ text: `▶ ${title || "Details"}`, bold: true, margin: [0, 2, 0, 3] }, ...inner],
                margin: [0, 0, 0, 6],
              });
            } else {
              const c = C.callout[kind];
              const head = title
                ? [{ text: this.cover(title, { bold: true }), color: c.bar, margin: [0, 0, 0, 3] }]
                : [];
              out.push(this.boxed([...head, ...inner], kind as "info"));
            }
            i = next;
            break;
          }
          i++; // anything else (closing tokens of a level we don't track) carries no content
        }
      }
    }
    return [out, i];
  }

  /** A box with a coloured bar on the left (quotes: "quote", callouts: their kind). */
  boxed(inner: Node[], kind: "quote" | "info" | "tip" | "warning" | "danger", extra: Node = {}): Node {
    return {
      table: { widths: ["*"], body: [[{ stack: inner.length ? inner : [{ text: " " }], ...extra }]] },
      layout: `twBox_${kind}`,
      margin: [0, 2, 0, 9],
    };
  }

  listItems(tokens: Token[], i: number, close: string): [Node[], number] {
    const items: Node[] = [];
    while (i < tokens.length && tokens[i].type !== close) {
      if (tokens[i].type !== "list_item_open") {
        i++;
        continue;
      }
      const task = /\btask-list-item\b/.test(String(tokens[i].attrGet("class") ?? ""));
      let checked = false;
      if (task) {
        const inl = tokens.slice(i + 1, i + 4).find((x) => x.type === "inline");
        checked = !!inl?.children?.some((c) => c.type === "html_inline" && /\bchecked\b/.test(c.content));
      }
      const [inner, next] = this.blocks(tokens, i + 1, "list_item_close");
      const stack = inner.length ? inner : [{ text: " " }];
      if (task) {
        const box: Node[] = [
          { type: "rect", x: 0, y: 2.5, w: 8.5, h: 8.5, r: 1.5, lineWidth: 0.8, lineColor: C.ink2 },
          ...(checked
            ? [
                {
                  type: "polyline",
                  points: [
                    { x: 1.8, y: 6.8 },
                    { x: 3.8, y: 8.9 },
                    { x: 7, y: 4.2 },
                  ],
                  lineWidth: 1.2,
                  lineColor: C.accent,
                },
              ]
            : []),
        ];
        items.push({
          columns: [
            { canvas: box, width: 12 },
            { stack, width: "*" },
          ],
          columnGap: 3,
          listType: "none",
        });
      } else items.push({ stack });
      i = next;
    }
    return [items, i + 1];
  }

  table(tokens: Token[], i: number): [Node, number] {
    const body: Node[][] = [];
    let headerRows = 0;
    let row: Node[] | null = null;
    while (i < tokens.length && tokens[i].type !== "table_close") {
      const tok = tokens[i];
      if (tok.type === "tr_open") row = [];
      else if (tok.type === "tr_close" && row) {
        body.push(row);
        row = null;
      } else if ((tok.type === "th_open" || tok.type === "td_open") && row) {
        const head = tok.type === "th_open";
        const align = /text-align:(left|center|right)/.exec(String(tok.attrGet("style") ?? ""))?.[1];
        const parts = this.inline(tokens[i + 1].children ?? [], head ? { bold: true } : {});
        const cell: Node = {
          stack: parts.map((p) => (Array.isArray(p) ? { text: p } : p)),
          ...(align ? { alignment: align } : {}),
          ...(head ? { fillColor: "#eef1f5" } : {}),
        };
        row.push(cell);
        i += 2;
      } else if (tok.type === "thead_close") headerRows = body.length;
      i++;
    }
    const cols = Math.max(1, ...body.map((r) => r.length));
    for (const r of body) while (r.length < cols) r.push({ text: "" });
    // column widths by how much text they hold, so short columns stay narrow
    const len = (n: Node): number => {
      const s = JSON.stringify(n.stack ?? n.text ?? "");
      return s.length;
    };
    const weight = Array.from({ length: cols }, (_, c) =>
      Math.min(60, Math.max(6, ...body.map((r) => Math.min(len(r[c]) / 3, 60)))),
    );
    const sum = weight.reduce((a, b) => a + b, 0);
    const widths = weight.map((w) => Math.max(28, ((CONTENT_W - cols * 9) * w) / sum));
    return [
      {
        table: { headerRows, widths, body, dontBreakRows: true },
        layout: "twTable",
        fontSize: 9.5,
        margin: [0, 2, 0, 10],
      },
      i + 1,
    ];
  }
}

/* ----------------------------------------------------------------- export */

export type PdfPage = { title: string; content: string; rev: number; updated_at: number; slug: string };
type Opts = { lang: Lang; siteName: string; pageUrl: string };

/*
 * pdfmake lays a document out synchronously, and a long page takes seconds: done on the server's
 * main thread, it would freeze the whole wiki meanwhile. So the layout runs in a worker thread
 * with a time and memory limit (the document handed over is plain data; the worker adds the few
 * functions pdfmake needs), at most two at a time, and finished PDFs are kept for a while.
 */
const WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const path = require("node:path");
const pdfmake = require("pdfmake");
const { doc, fonts, colors } = workerData;
pdfmake.setFonts(fonts);
const allowed = new Set(Object.values(fonts).flatMap((f) => Object.values(f).map((p) => path.resolve(p))));
pdfmake.setUrlAccessPolicy(() => false);
pdfmake.setLocalAccessPolicy((p) => allowed.has(path.resolve(p)));
const box = (c) => ({
  fillColor: () => c.bg, hLineWidth: () => 0, vLineWidth: (i) => (i === 0 ? 3 : 0), vLineColor: () => c.bar,
  paddingLeft: () => 10, paddingRight: () => 10, paddingTop: () => 7, paddingBottom: () => 2,
});
const layouts = {
  twCode: {
    fillColor: () => colors.codeBg, hLineWidth: () => 0, vLineWidth: () => 0, paddingLeft: () => 9, paddingRight: () => 9,
    paddingTop: (i) => (i === 0 ? 7 : 0), paddingBottom: (i, node) => (i === node.table.body.length - 1 ? 7 : 0),
  },
  twTable: {
    hLineWidth: () => 0.5, vLineWidth: () => 0.5, hLineColor: () => colors.line, vLineColor: () => colors.line,
    paddingLeft: () => 4, paddingRight: () => 4, paddingTop: () => 3, paddingBottom: () => 3,
  },
};
for (const [k, c] of Object.entries(colors.boxes)) layouts["twBox_" + k] = box(c);
pdfmake.setTableLayouts(layouts);
const { header, footer } = doc.parts;
delete doc.parts;
doc.header = (n) => (n > 1 ? header : null);
doc.footer = (n, total) => ({
  ...footer,
  columns: [footer.columns[0], { ...footer.columns[1], text: footer.label.replace("{n}", n).replace("{total}", total) }],
});
pdfmake.createPdf(doc).getBuffer().then(
  (b) => parentPort.postMessage({ ok: new Uint8Array(b) }),
  (e) => parentPort.postMessage({ error: String((e && e.message) || e) }),
);
`;

const TIME_LIMIT_MS = 45_000;
let running = 0;
const MAX_RUNNING = 2;
const cache = new Map<string, Buffer>();
let cacheBytes = 0;
const CACHE_MAX = 64 * 1024 * 1024;

function layoutInWorker(doc: object, fonts: object): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const colors = {
      codeBg: C.codeBg,
      line: C.line,
      boxes: { quote: { bar: "#c4cbd4", bg: "#f7f8fa" }, ...C.callout },
    };
    const w = new Worker(WORKER, {
      eval: true,
      workerData: { doc, fonts, colors },
      resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64 },
      stdout: true, // pdfmake's notes don't belong in the server log
      stderr: true,
    });
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void w.terminate();
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new HttpError(503, "This page is too long to turn into a PDF."))),
      TIME_LIMIT_MS,
    );
    w.on("message", (m: { ok?: Uint8Array; error?: string }) =>
      finish(() => (m.ok ? resolve(Buffer.from(m.ok)) : reject(new Error(m.error ?? "PDF failed")))),
    );
    w.on("error", (e) => finish(() => reject(e)));
    w.on("exit", (code) => finish(() => reject(new Error(`PDF worker stopped (${code})`))));
  });
}

/**
 * The PDF for a page. `pageUrl` is printed in the footer and used where something can only be
 * seen in the wiki (videos, images that can't go into a PDF) — the page's address in the wiki,
 * or the wiki's base address for a visitor of a shared link (never the link itself).
 */
export async function pagePdf(page: PdfPage, opts: Opts): Promise<Buffer> {
  const key = createHash("sha256")
    .update(JSON.stringify([page.slug, page.rev, page.updated_at, page.title, opts.lang, opts.siteName, opts.pageUrl]))
    .update(page.content)
    .update(mediaState(page.content))
    .digest("hex");
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  if (running >= MAX_RUNNING) throw new HttpError(503, "The server is busy. Try again in a moment.");
  running++;
  try {
    const { glyphs, fonts } = setup();
    let pdf: Buffer;
    try {
      pdf = await layoutInWorker(build(page, opts, glyphs, true), fonts);
    } catch (e) {
      // an image pdfkit can't read must not cost the whole document; a timeout stays a timeout
      if (e instanceof HttpError) throw e;
      pdf = await layoutInWorker(build(page, opts, glyphs, false), fonts);
    }
    if (pdf.length < CACHE_MAX / 4) {
      cache.set(key, pdf);
      cacheBytes += pdf.length;
      while (cacheBytes > CACHE_MAX || cache.size > 200) {
        const old = cache.keys().next().value as string;
        cacheBytes -= cache.get(old)!.length;
        cache.delete(old);
      }
    }
    return pdf;
  } finally {
    running--;
  }
}

/**
 * Which of the page's own files exist right now (and which version of them): part of the cache
 * key, so a deleted picture never comes back out of a PDF made before it was deleted.
 */
function mediaState(content: string): string {
  const names = new Set<string>();
  for (const m of content.matchAll(/\/media\/([A-Za-z0-9_-]{16,40}\.(?:png|jpg))\b/g)) {
    names.add(m[1]);
    if (names.size > MAX_IMAGES * 4) break;
  }
  return [...names]
    .map((n) => {
      try {
        const st = statSync(path.join(/* turbopackIgnore: true */ MEDIA_DIR(), n));
        return `${n}:${st.size}:${st.mtimeMs}`;
      } catch {
        return `${n}:-`;
      }
    })
    .join("|");
}

/** The document as plain data (no functions: it goes to the worker). */
function build(page: PdfPage, opts: Opts, glyphs: { text: Glyphs; mono: Glyphs }, withImages: boolean): object {
  const b = new Builder(opts.lang, glyphs, opts.pageUrl, withImages);
  const t = b.t;
  const content = b.keepHeadings(b.blocks(parseMarkdown(page.content, opts.lang), 0)[0]);
  const notes = [...b.footnotes.entries()].sort((x, y) => x[0] - y[0]);
  const date = formatDate(page.updated_at, opts.lang);
  return {
    pageSize: "A4",
    pageMargins: PAGE.margins,
    language: opts.lang === "de" ? "de-DE" : "en",
    info: {
      title: page.title,
      author: opts.siteName,
      subject: page.title,
      creator: "Tidewiki",
      producer: "Tidewiki",
    },
    defaultStyle: { font: "Inter", fontSize: BASE_SIZE, lineHeight: 1.32, color: C.ink },
    styles: {
      title: { fontSize: 21, bold: true, lineHeight: 1.15, margin: [0, 0, 0, 4] },
      meta: { fontSize: 8.5, color: C.ink2, margin: [0, 0, 0, 6] },
      h1: { fontSize: 17, bold: true, lineHeight: 1.2, margin: [0, 14, 0, 5] },
      h2: { fontSize: 14, bold: true, lineHeight: 1.2, margin: [0, 13, 0, 4] },
      h3: { fontSize: 12, bold: true, margin: [0, 10, 0, 3] },
      h4: { fontSize: 10.5, bold: true, margin: [0, 8, 0, 2] },
      h5: { fontSize: 10, bold: true, color: C.ink2, margin: [0, 6, 0, 2] },
      h6: { fontSize: 9.5, bold: true, color: C.ink2, margin: [0, 6, 0, 2] },
      p: { margin: [0, 0, 0, 7] },
      tight: { margin: [0, 0, 0, 2] },
      note: { fontSize: 8.5, color: C.ink2 },
    },
    parts: {
      header: {
        columns: [
          { text: b.cover(opts.siteName, {}), width: "auto" },
          { text: b.cover(page.title, {}), alignment: "right" },
        ],
        fontSize: 7.5,
        color: C.ink2,
        margin: [PAGE.margins[0], 26, PAGE.margins[2], 0],
      },
      footer: {
        columns: [
          { text: b.longWords({ text: opts.pageUrl }), link: opts.pageUrl, width: "*" },
          { text: "", alignment: "right", width: "auto" },
        ],
        label: t("Page {n} of {total}"),
        columnGap: 12,
        fontSize: 7.5,
        color: C.ink2,
        margin: [PAGE.margins[0], 22, PAGE.margins[2], 0],
      },
    },
    images: b.images,
    content: [
      { text: b.cover(page.title, {}), style: "title" },
      {
        text: b.cover(`${opts.siteName} · ${t("Updated {date}", { date })} · ${t("version {n}", { n: page.rev })}`, {}),
        style: "meta",
      },
      {
        canvas: [{ type: "line", x1: 0, y1: 0, x2: CONTENT_W, y2: 0, lineWidth: 0.8, lineColor: C.line }],
        margin: [0, 0, 0, 12],
      },
      ...content,
      ...(notes.length
        ? [
            {
              canvas: [{ type: "line", x1: 0, y1: 0, x2: 120, y2: 0, lineWidth: 0.6, lineColor: C.line }],
              margin: [0, 10, 0, 6],
            },
            ...notes.map(([n, inner]) => ({
              id: `fn${n}`,
              columns: [
                { text: `${n}.`, width: 16 },
                { stack: inner, width: "*" },
              ],
              style: "note",
              margin: [0, 0, 0, 3],
            })),
          ]
        : []),
    ],
  };
}
