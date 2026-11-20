import "./setup-env";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { imageSize, pagePdf } from "@/lib/pdf";
import { SYSTEM_PAGES } from "@/lib/seed";
import { MEDIA_DIR } from "@/lib/media";
import { BASE_URL } from "@/lib/config";

const fx = (n: string) => readFileSync(path.join(import.meta.dirname, "fixtures", n));
const hasTool = (t: string) => {
  try {
    execFileSync("which", [t], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const text = (pdf: Buffer) => {
  const f = path.join(process.env.WIKI_DATA_DIR!, `t-${Math.random().toString(36).slice(2)}.pdf`);
  writeFileSync(f, pdf);
  if (process.env.PDF_OUT)
    copyFileSync(f, path.join(process.env.PDF_OUT, `${Math.random().toString(36).slice(2)}.pdf`));
  return execFileSync("pdftotext", ["-layout", f, "-"]).toString("utf8");
};
const page = (title: string, content: string) => ({ title, content, rev: 3, updated_at: 1_790_000_000, slug: "seite" });
const opts = { lang: "de" as const, siteName: "Tidewiki", pageUrl: "https://wiki.example/w/seite" };

describe("PDF export", () => {
  it("reads image sizes from PNG and JPEG headers only", () => {
    expect(imageSize(fx("meta.png"))).toMatchObject({ w: expect.any(Number), h: expect.any(Number) });
    expect(imageSize(fx("exif.jpg"))).toMatchObject({ w: expect.any(Number), h: expect.any(Number) });
    expect(imageSize(fx("exif.webp"))).toBeNull();
    expect(imageSize(fx("comment.gif"))).toBeNull();
    expect(imageSize(Buffer.from("not an image"))).toBeNull();
    expect(imageSize(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull(); // a bad segment length
  });

  it("the Markdown guide (every feature) becomes a valid PDF with its text, page numbers and bookmarks", async () => {
    const g = SYSTEM_PAGES["markdown-guide"].versions.de;
    const pdf = await pagePdf(page(g.title, g.content), opts);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(20_000);
    expect(pdf.toString("latin1")).toContain("/Outlines");
    if (!hasTool("pdftotext")) return;
    const txt = text(pdf);
    expect(txt).toContain("Markdown-Anleitung");
    expect(txt).toMatch(/Seite 1 von \d+/);
    expect(txt).toContain("https://wiki.example/w/seite");
    // the fonts are embedded (and German text comes out as German text)
    expect(txt).toContain("Öffnen Sie diese Seite");
    expect(txt).toContain("Fußnoten");
    const info = execFileSync("pdffonts", ["-"], { input: pdf }).toString();
    expect(info).toMatch(/Inter/);
    expect(info).toMatch(/JetBrainsMono/);
  });

  it("images of the wiki go in; foreign images, videos and embeds become links — nothing is fetched", async () => {
    mkdirSync(MEDIA_DIR(), { recursive: true });
    writeFileSync(path.join(MEDIA_DIR(), "abcdefghijklmnop1234.png"), fx("meta.png"));
    writeFileSync(path.join(MEDIA_DIR(), "abcdefghijklmnop1234.jpg"), fx("exif.jpg"));
    writeFileSync(path.join(MEDIA_DIR(), "abcdefghijklmnop1234.webp"), fx("exif.webp"));
    const md = [
      "Bild: ![Plan](/media/abcdefghijklmnop1234.png) und ![Foto](/media/abcdefghijklmnop1234.jpg)",
      "![WebP](/media/abcdefghijklmnop1234.webp)",
      "![Fremd](https://evil.example/track.png)",
      "![Fehlt](/media/zzzzzzzzzzzzzzzzzzzz.png)",
      "@[Vortrag](https://www.youtube.com/watch?v=dQw4w9WgXcQ)",
      "![Clip](/media/abcdefghijklmnop1234.mp4)",
      "[Seite](/w/andere) [Anker](#h-oben) [mail](mailto:a@b.example) [js](javascript:alert(1))",
    ].join("\n\n");
    const pdf = await pagePdf(page("Bilder", md), opts);
    const raw = pdf.toString("latin1");
    expect(raw.match(/\/Subtype \/Image/g)?.length).toBe(2); // the PNG and the JPEG
    expect(raw).not.toContain("javascript:");
    expect(raw).toContain(`${BASE_URL}/w/andere`);
    expect(raw).toContain("mailto:a@b.example");
    expect(raw).not.toContain("TRAILER-SECRET"); // image metadata never travels into the PDF
    if (!hasTool("pdftotext")) return;
    const txt = text(pdf);
    expect(txt).toContain("Bild: WebP");
    expect(txt).toContain("Bild: Fremd");
    expect(raw).toContain("(https://evil.example/track.png)"); // a link, never loaded
    expect(txt).toContain("YouTube: Vortrag");
  });

  it("a deleted picture never comes back out of the cache", async () => {
    mkdirSync(MEDIA_DIR(), { recursive: true });
    const f = path.join(MEDIA_DIR(), "cachetestcachetest01.png");
    writeFileSync(f, fx("meta.png"));
    const md = "![Plan](/media/cachetestcachetest01.png)";
    const count = (b: Buffer) => b.toString("latin1").match(/\/Subtype \/Image/g)?.length ?? 0;
    expect(count(await pagePdf(page("Cache", md), opts))).toBe(1);
    rmSync(f);
    expect(count(await pagePdf(page("Cache", md), opts))).toBe(0);
  });

  it("long lines, wide tables, emoji, odd characters and deep nesting don't break the layout", async () => {
    const long = "x".repeat(500);
    const md = [
      `Ein sehr langes Wort: ${long}`,
      "```js\nconst a = 1; // " + "y".repeat(400) + "\nfunction f(){ return `ok`; }\n```",
      "| " +
        Array.from({ length: 12 }, (_, i) => `Spalte ${i}`).join(" | ") +
        " |\n|" +
        "---|".repeat(12) +
        "\n| " +
        Array.from({ length: 12 }, () => long.slice(0, 80)).join(" | ") +
        " |",
      "Emoji :smile: 😀 und Steuerzeichen \u0001\u0007 und RTL ‮ evil",
      "- [x] erledigt\n- [ ] offen\n  - verschachtelt\n    1. tief\n       > Zitat\n       > ::: warning Achtung\n       > Text\n       > :::",
      "::: danger Gefahr\n**fett** _kursiv_ ~~durch~~ ==markiert== H~2~O x^2^ `code`\n:::",
      "Fußnote[^1].\n\n[^1]: Die Fußnote.",
      "Begriff\n: Erklärung",
    ].join("\n\n");
    const pdf = await pagePdf(page("Grenzfälle", md), opts);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    if (!hasTool("pdftotext")) return;
    const txt = text(pdf);
    expect(txt).toContain("Grenzfälle");
    expect(txt).toContain(":smile:"); // no emoji glyph in the fonts: the short code instead
    expect(txt).toContain("Die Fußnote.");
    expect(txt).toContain("Erklärung");
  });

  it("an empty page and a huge page both work", async () => {
    expect((await pagePdf(page("Leer", ""), opts)).subarray(0, 5).toString()).toBe("%PDF-");
    const big = Array.from({ length: 2500 }, (_, i) => `## Abschnitt ${i}\n\nText ${i} `.repeat(3)).join("\n");
    const t0 = Date.now();
    const pdf = await pagePdf(page("Groß", big.slice(0, 512 * 1024)), opts);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(Date.now() - t0).toBeLessThan(60_000);
  });

  it("at most two are made at once", async () => {
    const g = SYSTEM_PAGES["markdown-guide"].versions.en;
    const all = await Promise.allSettled(
      [1, 2, 3, 4].map(() => pagePdf(page(g.title, g.content), { ...opts, lang: "en" })),
    );
    expect(all.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(2);
    expect(all.some((r) => r.status === "rejected" && /busy/.test(String((r as PromiseRejectedResult).reason)))).toBe(
      true,
    );
  });

  it("the fonts are there", () => {
    for (const f of ["Inter-Regular.ttf", "Inter-SemiBold.ttf", "JetBrainsMono-Regular.ttf"])
      expect(existsSync(path.join(process.cwd(), "pdf-fonts", f))).toBe(true);
  });
});
