// The wiki's look: presets, accent colour, font, background layers, header band, content opacity,
// size and page width, plus the owner's own CSS. Ported from Tidedeck (same presets, fonts and
// colour rules) and mapped onto Tidewiki's CSS variables. Pure functions only: the settings page
// uses them for the live preview, the server for every page.
import fontFiles from "./font-files.json";
import { msg } from "./msg";

/* ------------------------------------------------------------------ fonts */

export const FONT_GROUPS = [
  msg("Clean"),
  msg("Friendly"),
  msg("Serif"),
  msg("Futuristic"),
  msg("Condensed and bold"),
  msg("Retro"),
  msg("Handwritten"),
  msg("Monospace"),
  msg("Device"),
] as const;

/** adjust: the font's small letters are much smaller than usual; scale them to about Inter's (font-size-adjust). */
type FontInfo = { name: string; note: string; stack: string; group: (typeof FONT_GROUPS)[number]; adjust?: number };

/**
 * Fonts bundled in the image (self-hosted, nothing loads from Google). Inter and JetBrains Mono are
 * part of the interface; every other one is its own small stylesheet in /fonts, loaded only when
 * it's the one in use (see font-files.json and scripts/fonts.mjs).
 */
export const FONTS = {
  inter: { name: "Inter", note: msg("Tide default"), group: "Clean", stack: '"Inter Variable", Inter' },
  plex: {
    name: "IBM Plex Sans",
    note: msg("Technical, a little warmer"),
    group: "Clean",
    stack: '"IBM Plex Sans Variable", "IBM Plex Sans"',
  },
  manrope: { name: "Manrope", note: msg("Modern and rounded"), group: "Clean", stack: '"Manrope Variable", Manrope' },
  atkinson: {
    name: "Atkinson Hyperlegible",
    note: msg("Made for low vision"),
    group: "Clean",
    stack: '"Atkinson Hyperlegible Next Variable", "Atkinson Hyperlegible Next"',
  },
  space: {
    name: "Space Grotesk",
    note: msg("Quirky geometric"),
    group: "Friendly",
    stack: '"Space Grotesk Variable", "Space Grotesk"',
  },
  nunito: { name: "Nunito", note: msg("Soft and friendly"), group: "Friendly", stack: '"Nunito Variable", Nunito' },
  comfortaa: {
    name: "Comfortaa",
    note: msg("Round, airy geometric"),
    group: "Friendly",
    stack: '"Comfortaa Variable", Comfortaa',
  },
  quicksand: {
    name: "Quicksand",
    note: msg("Light and rounded"),
    group: "Friendly",
    stack: '"Quicksand Variable", Quicksand',
  },
  syne: { name: "Syne", note: msg("Arty, wide when bold"), group: "Friendly", stack: '"Syne Variable", Syne' },
  bricolage: {
    name: "Bricolage Grotesque",
    note: msg("Ink-trapped, characterful"),
    group: "Friendly",
    stack: '"Bricolage Grotesque Variable", "Bricolage Grotesque"',
  },
  serif: {
    name: "Source Serif",
    note: msg("Bookish serif"),
    group: "Serif",
    stack: '"Source Serif 4 Variable", "Source Serif 4", Georgia',
  },
  fraunces: {
    name: "Fraunces",
    note: msg("Soft, old-style serif"),
    group: "Serif",
    stack: '"Fraunces Variable", Fraunces, Georgia',
  },
  playfair: {
    name: "Playfair Display",
    note: msg("High-contrast, elegant"),
    group: "Serif",
    stack: '"Playfair Display Variable", "Playfair Display", Georgia',
  },
  dmserif: {
    name: "DM Serif Display",
    note: msg("Bold editorial headlines"),
    group: "Serif",
    stack: '"DM Serif Display", Georgia',
  },
  orbitron: {
    name: "Orbitron",
    note: msg("Square sci-fi"),
    group: "Futuristic",
    stack: '"Orbitron Variable", Orbitron',
  },
  exo: { name: "Exo 2", note: msg("Techy, easy to read"), group: "Futuristic", stack: '"Exo 2 Variable", "Exo 2"' },
  unbounded: {
    name: "Unbounded",
    note: msg("Wide and loud"),
    group: "Futuristic",
    stack: '"Unbounded Variable", Unbounded',
  },
  oswald: {
    name: "Oswald",
    note: msg("Condensed poster type"),
    group: "Condensed and bold",
    stack: '"Oswald Variable", Oswald',
  },
  shoulders: {
    name: "Big Shoulders",
    note: msg("Tall, industrial"),
    group: "Condensed and bold",
    stack: '"Big Shoulders Display Variable", "Big Shoulders Display"',
  },
  vt323: { name: "VT323", note: msg("Old terminal"), group: "Retro", stack: "VT323, ui-monospace", adjust: 0.53 },
  pixelify: {
    name: "Pixelify Sans",
    note: msg("Pixel art, still readable"),
    group: "Retro",
    stack: '"Pixelify Sans Variable", "Pixelify Sans"',
  },
  silkscreen: { name: "Silkscreen", note: msg("Tiny 8-bit capitals"), group: "Retro", stack: "Silkscreen" },
  typewriter: {
    name: "Special Elite",
    note: msg("Worn typewriter"),
    group: "Retro",
    stack: '"Special Elite", "Courier New", monospace',
  },
  courier: {
    name: "Courier Prime",
    note: msg("Clean typewriter"),
    group: "Retro",
    stack: '"Courier Prime", "Courier New", monospace',
  },
  caveat: {
    name: "Caveat",
    note: msg("Handwritten notes"),
    group: "Handwritten",
    stack: '"Caveat Variable", Caveat',
    adjust: 0.53,
  },
  mono: {
    name: "JetBrains Mono",
    note: msg("Everything monospaced"),
    group: "Monospace",
    stack: '"JetBrains Mono Variable", ui-monospace',
  },
  recursive: {
    name: "Recursive",
    note: msg("Casual, semi-mono"),
    group: "Monospace",
    stack: '"Recursive Variable", Recursive',
  },
  system: {
    name: "System font",
    note: msg("Whatever your device uses"),
    group: "Device",
    stack: "system-ui, -apple-system",
  },
} as const satisfies Record<string, FontInfo>;
export type FontId = keyof typeof FONTS;
export const FONT_IDS = Object.keys(FONTS) as FontId[];

const FILES = fontFiles as Record<string, { pkg: string; css: string[] }>;

/** The stylesheet a font needs (null: built in or the device's own). */
export function fontHref(font: FontId | "custom"): string | null {
  return font !== "custom" && Object.hasOwn(FILES, font) ? `/fonts/${font}.css` : null;
}

/** Every font with a stylesheet, for showing them side by side in the settings. */
export const FONT_SHEETS = Object.keys(FILES).map((id) => `/fonts/${id}.css`);

const FALLBACK = '"Segoe UI Variable", "Segoe UI", system-ui, -apple-system, Roboto, sans-serif';
export const CUSTOM_FONT_RE = /^[\w \-]{0,60}$/;

export function fontStack(font: FontId | "custom", custom: string): string {
  if (font === "custom") {
    const name = custom.replace(/[^\w \-]/g, "").trim();
    return name ? `"${name}", ${FONTS.inter.stack}, ${FALLBACK}` : `${FONTS.inter.stack}, ${FALLBACK}`;
  }
  return `${FONTS[font].stack}, ${FALLBACK}`;
}

/* --------------------------------------------------------------- gradients */

/** Page backgrounds drawn behind the content, one version per theme. */
export const GRADIENTS = {
  aurora: {
    name: msg("Aurora"),
    light:
      "radial-gradient(1100px 650px at 5% -5%, rgb(60 190 160 / 0.20), transparent 62%), radial-gradient(1000px 620px at 100% 0%, rgb(140 100 230 / 0.16), transparent 60%)",
    dark: "radial-gradient(1100px 650px at 5% -5%, rgb(60 200 165 / 0.20), transparent 62%), radial-gradient(1000px 620px at 100% 0%, rgb(150 110 240 / 0.22), transparent 60%)",
  },
  tidepool: {
    name: msg("Tide pool"),
    light:
      "radial-gradient(1200px 700px at 15% 0%, rgb(61 90 128 / 0.16), transparent 60%), radial-gradient(900px 600px at 90% 100%, rgb(47 111 98 / 0.14), transparent 60%)",
    dark: "radial-gradient(1200px 700px at 15% 0%, rgb(142 174 219 / 0.16), transparent 60%), radial-gradient(900px 600px at 90% 100%, rgb(124 196 180 / 0.12), transparent 60%)",
  },
  dusk: {
    name: msg("Dusk"),
    light:
      "radial-gradient(1100px 650px at 0% 0%, rgb(169 154 214 / 0.22), transparent 60%), radial-gradient(1000px 650px at 100% 100%, rgb(224 178 90 / 0.20), transparent 60%)",
    dark: "radial-gradient(1100px 650px at 0% 0%, rgb(120 90 200 / 0.22), transparent 60%), radial-gradient(1000px 650px at 100% 100%, rgb(224 150 70 / 0.16), transparent 60%)",
  },
  mist: {
    name: msg("Mist"),
    light:
      "linear-gradient(180deg, rgb(61 90 128 / 0.10), transparent 55%), linear-gradient(0deg, rgb(183 128 42 / 0.06), transparent 40%)",
    dark: "linear-gradient(180deg, rgb(142 174 219 / 0.09), transparent 55%), linear-gradient(0deg, rgb(224 178 90 / 0.05), transparent 40%)",
  },
  synthwave: {
    name: msg("Synthwave"),
    light:
      "radial-gradient(1200px 600px at 50% 110%, rgb(255 80 180 / 0.22), transparent 65%), radial-gradient(1000px 520px at 50% -10%, rgb(80 200 255 / 0.18), transparent 60%), linear-gradient(180deg, rgb(120 60 200 / 0.08), rgb(255 90 170 / 0.08))",
    dark: "radial-gradient(1200px 600px at 50% 110%, rgb(255 60 170 / 0.30), transparent 65%), radial-gradient(1000px 520px at 50% -10%, rgb(60 200 255 / 0.20), transparent 60%), linear-gradient(180deg, rgb(70 20 140 / 0.35), rgb(150 20 110 / 0.22))",
  },
  sunset: {
    name: msg("Sunset"),
    light:
      "radial-gradient(1300px 700px at 85% 105%, rgb(255 130 60 / 0.24), transparent 62%), radial-gradient(1000px 600px at 0% 0%, rgb(230 90 130 / 0.16), transparent 60%)",
    dark: "radial-gradient(1300px 700px at 85% 105%, rgb(255 120 50 / 0.26), transparent 62%), radial-gradient(1000px 600px at 0% 0%, rgb(200 60 120 / 0.22), transparent 60%)",
  },
  reef: {
    name: msg("Reef"),
    light:
      "radial-gradient(1100px 650px at 100% 0%, rgb(255 130 110 / 0.20), transparent 60%), radial-gradient(1100px 700px at 0% 100%, rgb(40 180 170 / 0.18), transparent 62%)",
    dark: "radial-gradient(1100px 650px at 100% 0%, rgb(255 120 100 / 0.20), transparent 60%), radial-gradient(1100px 700px at 0% 100%, rgb(30 170 160 / 0.22), transparent 62%)",
  },
} as const;
export type GradientId = keyof typeof GRADIENTS;
export const GRADIENT_IDS = Object.keys(GRADIENTS) as GradientId[];

/* ------------------------------------------------------------ the setting */

export const PAGE_WIDTHS = ["full", "wide", "standard"] as const;
export const SIZE_MIN = 70;
export const SIZE_MAX = 200;
export const SHEET_OPACITY_MIN = 40;

export type Background = {
  /** "theme": the theme's grey; "color": your own colour per theme (blocks and lines follow it) */
  base: "theme" | "color";
  colorLight: string;
  colorDark: string;
  imageOn: boolean;
  /** an uploaded image of this wiki: /media/<name> */
  image: string;
  blur: number;
  dim: number;
  gradientOn: boolean;
  gradient: GradientId;
};
export type Display = { scale: "auto" | "fixed"; size: number; width: (typeof PAGE_WIDTHS)[number] };
export type Appearance = {
  preset: string;
  /** default theme for browsers that haven't chosen one */
  theme: "system" | "light" | "dark";
  accent: string;
  accentLight: string;
  font: FontId | "custom";
  customFont: string;
  background: Background;
  band: { light: string; dark: string };
  /** content area and side panel, 40–100 % (below 100 the background shows through, frosted) */
  sheetOpacity: number;
  display: Display;
};

export const DEFAULT_ACCENT = "#8eaedb";
export const DEFAULT_APPEARANCE: Appearance = {
  preset: "tide",
  theme: "system",
  accent: DEFAULT_ACCENT,
  accentLight: "#3d5a80",
  font: "inter",
  customFont: "",
  background: {
    base: "theme",
    colorLight: "",
    colorDark: "",
    imageOn: false,
    image: "",
    blur: 0,
    dim: 40,
    gradientOn: false,
    gradient: "aurora",
  },
  band: { light: "", dark: "" },
  sheetOpacity: 100,
  display: { scale: "auto", size: 100, width: "full" },
};

const HEX = /^#[0-9a-f]{6}$/;
export const MEDIA_IMAGE_RE = /^\/media\/[A-Za-z0-9_-]{16,40}\.(?:png|jpg|gif|webp)$/;

/**
 * Checks an appearance coming from a browser (or the database). Everything must be exactly of the
 * expected kind — hex colours, known ids, whole numbers in range, an image of this wiki — or the
 * whole value is refused (null). Unknown keys are ignored. Nothing here can reach the page's CSS
 * except through these checks.
 */
export function parseAppearance(raw: unknown): Appearance | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const d = DEFAULT_APPEARANCE;
  const pick = <T>(v: unknown, def: T, ok: (v: unknown) => boolean): T | undefined =>
    v === undefined ? def : ok(v) ? (v as T) : undefined;
  const hex = (v: unknown) => typeof v === "string" && HEX.test(v);
  const hexOrEmpty = (v: unknown) => v === "" || hex(v);
  const int = (min: number, max: number) => (v: unknown) =>
    typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
  const oneOf = (list: readonly string[]) => (v: unknown) => typeof v === "string" && list.includes(v);
  const obj = (v: unknown) => (v === undefined ? {} : v && typeof v === "object" && !Array.isArray(v) ? v : null);

  const bgRaw = obj(o.background) as Record<string, unknown> | null;
  const bandRaw = obj(o.band) as Record<string, unknown> | null;
  const dispRaw = obj(o.display) as Record<string, unknown> | null;
  if (!bgRaw || !bandRaw || !dispRaw) return null;

  const a = {
    preset: pick(o.preset, d.preset, (v) => typeof v === "string" && /^[a-z0-9-]{1,30}$/.test(v)),
    theme: pick(o.theme, d.theme, oneOf(["system", "light", "dark"])),
    accent: pick(lower(o.accent), d.accent, hex),
    accentLight: pick(lower(o.accentLight), d.accentLight, hexOrEmpty),
    font: pick(o.font, d.font, oneOf([...FONT_IDS, "custom"])),
    customFont: pick(o.customFont, d.customFont, (v) => typeof v === "string" && CUSTOM_FONT_RE.test(v)),
    background: {
      base: pick(bgRaw.base, d.background.base, oneOf(["theme", "color"])),
      colorLight: pick(lower(bgRaw.colorLight), d.background.colorLight, hexOrEmpty),
      colorDark: pick(lower(bgRaw.colorDark), d.background.colorDark, hexOrEmpty),
      imageOn: pick(bgRaw.imageOn, d.background.imageOn, (v) => typeof v === "boolean"),
      image: pick(
        bgRaw.image,
        d.background.image,
        (v) => v === "" || (typeof v === "string" && MEDIA_IMAGE_RE.test(v)),
      ),
      blur: pick(bgRaw.blur, d.background.blur, int(0, 40)),
      dim: pick(bgRaw.dim, d.background.dim, int(0, 90)),
      gradientOn: pick(bgRaw.gradientOn, d.background.gradientOn, (v) => typeof v === "boolean"),
      gradient: pick(bgRaw.gradient, d.background.gradient, oneOf(GRADIENT_IDS)),
    },
    band: {
      light: pick(lower(bandRaw.light), d.band.light, hexOrEmpty),
      dark: pick(lower(bandRaw.dark), d.band.dark, hexOrEmpty),
    },
    sheetOpacity: pick(o.sheetOpacity, d.sheetOpacity, int(SHEET_OPACITY_MIN, 100)),
    display: {
      scale: pick(dispRaw.scale, d.display.scale, oneOf(["auto", "fixed"])),
      size: pick(dispRaw.size, d.display.size, int(SIZE_MIN, SIZE_MAX)),
      width: pick(dispRaw.width, d.display.width, oneOf(PAGE_WIDTHS)),
    },
  };
  const missing = (v: unknown): boolean =>
    v === undefined || (typeof v === "object" && v !== null && Object.values(v).some(missing));
  return missing(a) ? null : (a as Appearance);
}
const lower = (v: unknown) => (typeof v === "string" ? v.toLowerCase() : v);

/** The stored value, or the default when it's missing or (from an older version) no longer valid. */
export function appearanceFrom(stored: string): Appearance {
  try {
    return parseAppearance(JSON.parse(stored)) ?? DEFAULT_APPEARANCE;
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

/* --------------------------------------------------------------- presets */

export const PRESET_GROUPS = [msg("Tide"), msg("Colour schemes"), msg("Styles"), msg("Sea and nature")] as const;

export type ThemePreset = {
  id: string;
  name: string;
  group: (typeof PRESET_GROUPS)[number];
  accent: string;
  accentLight: string;
  font: FontId;
  /** Base and gradient layers. A preset never touches the image layer: that one is yours. */
  background: Pick<Background, "base" | "colorLight" | "colorDark" | "gradientOn" | "gradient">;
  band: { light: string; dark: string };
};

const bg = (colorLight = "", colorDark = "", gradient?: GradientId): ThemePreset["background"] => ({
  base: colorLight || colorDark ? "color" : "theme",
  colorLight,
  colorDark,
  gradientOn: !!gradient,
  gradient: gradient ?? "aurora",
});

/** One-click looks, the same as Tidedeck's: Tide is Tidewiki's own design, the rest are its relatives. */
export const THEME_PRESETS: ThemePreset[] = [
  {
    id: "tide",
    group: "Tide",
    name: "Tide",
    accent: "#8eaedb",
    accentLight: "#3d5a80",
    font: "inter",
    background: bg(),
    band: { light: "", dark: "" },
  },
  {
    id: "harbour",
    group: "Tide",
    name: msg("Harbour night"),
    accent: "#7fb2f0",
    accentLight: "#2c5a96",
    font: "inter",
    background: bg("#eef2f7", "#0c1420"),
    band: { light: "#16263b", dark: "#070d16" },
  },
  {
    id: "sandbar",
    group: "Tide",
    name: msg("Sandbar"),
    accent: "#e0b25a",
    accentLight: "#8a5d17",
    font: "manrope",
    background: bg("#f4efe6", "#16130e"),
    band: { light: "#3a3127", dark: "#0e0b07" },
  },
  {
    id: "kelp",
    group: "Tide",
    name: msg("Kelp forest"),
    accent: "#7cc4b4",
    accentLight: "#2f6f62",
    font: "nunito",
    background: bg("#edf3f0", "#0d1412"),
    band: { light: "#1e3a33", dark: "#060e0b" },
  },
  {
    id: "heather",
    group: "Tide",
    name: msg("Heather"),
    accent: "#b4a4e6",
    accentLight: "#5b4b8a",
    font: "plex",
    background: bg("#f3f1f7", "#131119"),
    band: { light: "#2e2840", dark: "#0b0910" },
  },
  {
    id: "aurora",
    group: "Tide",
    name: msg("Aurora"),
    accent: "#8fe3c8",
    accentLight: "#1f7a63",
    font: "space",
    background: bg("", "", "aurora"),
    band: { light: "#101a24", dark: "#05080c" },
  },
  {
    id: "paper",
    group: "Tide",
    name: msg("Paper"),
    accent: "#9fb6e0",
    accentLight: "#2f4a7a",
    font: "serif",
    background: bg("#faf8f2", "#191816"),
    band: { light: "#2b2a27", dark: "#0d0c0b" },
  },
  {
    id: "phosphor",
    group: "Tide",
    name: "Phosphor",
    accent: "#ffb454",
    accentLight: "#9a5b00",
    font: "mono",
    background: bg("#f3f1ea", "#0b0a08"),
    band: { light: "#1a1712", dark: "#040302" },
  },
  {
    id: "legible",
    group: "Tide",
    name: msg("Clear view"),
    accent: "#9cc3ff",
    accentLight: "#1f4f99",
    font: "atkinson",
    background: bg(),
    band: { light: "", dark: "" },
  },

  {
    id: "nord",
    group: "Colour schemes",
    name: "Nord",
    accent: "#88c0d0",
    accentLight: "#5e81ac",
    font: "plex",
    background: bg("#eceff4", "#2e3440"),
    band: { light: "#3b4252", dark: "#242933" },
  },
  {
    id: "dracula",
    group: "Colour schemes",
    name: "Dracula",
    accent: "#bd93f9",
    accentLight: "#644ac9",
    font: "mono",
    background: bg("#fffbeb", "#282a36"),
    band: { light: "#3a3c4e", dark: "#1e1f29" },
  },
  {
    id: "gruvbox",
    group: "Colour schemes",
    name: "Gruvbox",
    accent: "#fabd2f",
    accentLight: "#b57614",
    font: "recursive",
    background: bg("#fbf1c7", "#282828"),
    band: { light: "#3c3836", dark: "#1d2021" },
  },
  {
    id: "catppuccin",
    group: "Colour schemes",
    name: "Catppuccin",
    accent: "#cba6f7",
    accentLight: "#8839ef",
    font: "quicksand",
    background: bg("#eff1f5", "#1e1e2e"),
    band: { light: "#313244", dark: "#11111b" },
  },
  {
    id: "tokyonight",
    group: "Colour schemes",
    name: "Tokyo Night",
    accent: "#7aa2f7",
    accentLight: "#2e7de9",
    font: "exo",
    background: bg("#e1e2e7", "#1a1b26"),
    band: { light: "#24283b", dark: "#16161e" },
  },
  {
    id: "rosepine",
    group: "Colour schemes",
    name: "Rosé Pine",
    accent: "#c4a7e7",
    accentLight: "#907aa9",
    font: "fraunces",
    background: bg("#faf4ed", "#191724"),
    band: { light: "#26233a", dark: "#12101b" },
  },
  {
    id: "solarized",
    group: "Colour schemes",
    name: "Solarized",
    accent: "#2aa198",
    accentLight: "#268bd2",
    font: "plex",
    background: bg("#fdf6e3", "#002b36"),
    band: { light: "#073642", dark: "#00212b" },
  },

  {
    id: "synthwave",
    group: "Styles",
    name: "Synthwave",
    accent: "#ff7edb",
    accentLight: "#c2187a",
    font: "orbitron",
    background: bg("#f7f0ff", "#140a26", "synthwave"),
    band: { light: "#2a0c4e", dark: "#120424" },
  },
  {
    id: "terminal",
    group: "Styles",
    name: "Terminal",
    accent: "#33ff66",
    accentLight: "#0a7a2a",
    font: "vt323",
    background: bg("#eef5ee", "#050a06"),
    band: { light: "#0f2414", dark: "#020402" },
  },
  {
    id: "typewriter",
    group: "Styles",
    name: msg("Typewriter"),
    accent: "#e06a5c",
    accentLight: "#a3261a",
    font: "typewriter",
    background: bg("#f3ecdc", "#1c1a16"),
    band: { light: "#2d2a24", dark: "#0f0e0b" },
  },
  {
    id: "editorial",
    group: "Styles",
    name: "Editorial",
    accent: "#ff6b5a",
    accentLight: "#c0261a",
    font: "playfair",
    background: bg("#fbfaf7", "#121212"),
    band: { light: "#1a1a1a", dark: "#050505" },
  },
  {
    id: "blueprint",
    group: "Styles",
    name: msg("Blueprint"),
    accent: "#9cd0ff",
    accentLight: "#1d5fa3",
    font: "recursive",
    background: bg("#e8f0f8", "#0e2a47"),
    band: { light: "#0b2440", dark: "#081c33" },
  },
  {
    id: "arcade",
    group: "Styles",
    name: "Arcade",
    accent: "#ffd319",
    accentLight: "#9a6b00",
    font: "pixelify",
    background: bg("#f4f0ff", "#0d0221"),
    band: { light: "#241047", dark: "#06010f" },
  },
  {
    id: "poster",
    group: "Styles",
    name: msg("Poster"),
    accent: "#ff7a3d",
    accentLight: "#b8460f",
    font: "oswald",
    background: bg("#f2f0eb", "#141414"),
    band: { light: "#1f1f1f", dark: "#080808" },
  },
  {
    id: "notebook",
    group: "Styles",
    name: msg("Notebook"),
    accent: "#7fb0ff",
    accentLight: "#2563c9",
    font: "caveat",
    background: bg("#fdfbf3", "#1d1f24"),
    band: { light: "#2a2d35", dark: "#101115" },
  },

  {
    id: "deepsea",
    group: "Sea and nature",
    name: msg("Deep sea"),
    accent: "#4fd1c5",
    accentLight: "#0e7c74",
    font: "manrope",
    background: bg("#e6f0f6", "#04121f", "tidepool"),
    band: { light: "#0b2236", dark: "#020a12" },
  },
  {
    id: "reef",
    group: "Sea and nature",
    name: msg("Coral reef"),
    accent: "#ff8a80",
    accentLight: "#c2453a",
    font: "comfortaa",
    background: bg("#f2f8f7", "#08161c", "reef"),
    band: { light: "#3a2a27", dark: "#0a0f12" },
  },
  {
    id: "arctic",
    group: "Sea and nature",
    name: msg("Arctic"),
    accent: "#a5d8ff",
    accentLight: "#1c6aa3",
    font: "quicksand",
    background: bg("#f3f8fb", "#0e1a22"),
    band: { light: "#23394a", dark: "#08121a" },
  },
  {
    id: "sunset",
    group: "Sea and nature",
    name: msg("Sunset"),
    accent: "#ffb38a",
    accentLight: "#b4501c",
    font: "syne",
    background: bg("#fbf3ec", "#1a1012", "sunset"),
    band: { light: "#3a1f1a", dark: "#170a0a" },
  },
  {
    id: "moss",
    group: "Sea and nature",
    name: msg("Moss"),
    accent: "#a3c47a",
    accentLight: "#4d6b2a",
    font: "bricolage",
    background: bg("#f1f4ec", "#10140e"),
    band: { light: "#273220", dark: "#080a06" },
  },
];

export function presetMatches(p: ThemePreset, a: Appearance): boolean {
  return (
    a.accent === p.accent &&
    a.accentLight === p.accentLight &&
    a.font === p.font &&
    a.background.base === p.background.base &&
    (p.background.base !== "color" ||
      (a.background.colorLight === p.background.colorLight && a.background.colorDark === p.background.colorDark)) &&
    a.background.gradientOn === p.background.gradientOn &&
    (!p.background.gradientOn || a.background.gradient === p.background.gradient) &&
    a.band.light === p.band.light &&
    a.band.dark === p.band.dark
  );
}

/** A preset sets colours, font, base and gradient; your image, size and theme stay. */
export function applyPreset(a: Appearance, p: ThemePreset): Appearance {
  return {
    ...a,
    preset: p.id,
    accent: p.accent,
    accentLight: p.accentLight,
    font: p.font,
    customFont: "",
    background: { ...a.background, ...p.background },
    band: { ...p.band },
  };
}

/* ----------------------------------------------------------------- accent */

function parse(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const toHex = (rgb: number[]) => "#" + rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("");
function luminance([r, g, b]: number[]) {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
/** Dark text or white text, whichever reads better on the colour. */
function foregroundFor(rgb: number[]) {
  const l = luminance(rgb);
  return contrast(l, luminance([15, 18, 22])) >= contrast(l, 1) ? "#0f1216" : "#ffffff";
}

export const ACCENT_PRESETS: Array<{ name: string; hex: string; light: string }> = [
  { name: msg("Tide (slate blue)"), hex: "#8eaedb", light: "#3d5a80" },
  { name: msg("Amber"), hex: "#e0b25a", light: "#8a5d17" },
  { name: msg("Sea glass"), hex: "#7cc4b4", light: "#2f6f62" },
  { name: msg("Heather"), hex: "#a99ad6", light: "#5b4b8a" },
  { name: msg("Rosewood"), hex: "#e09aa6", light: "#93404f" },
  { name: msg("Pewter"), hex: "#a8b0ba", light: "#4f5864" },
];

/**
 * The accent pair: as chosen on dark surfaces; on light ones the chosen light colour, or the
 * dark one darkened until it reads well on white (4.5:1, text-link contrast).
 */
export function accentPair(
  hex: string,
  lightHex = "",
): { dark: string; light: string; darkFg: string; lightFg: string } {
  const base = HEX.test(hex) ? parse(hex) : parse(DEFAULT_ACCENT);
  const preset = ACCENT_PRESETS.find((p) => p.hex === hex.toLowerCase());
  const picked = HEX.test(lightHex) ? lightHex : preset?.light;
  const white = luminance([255, 255, 255]);
  let light = picked ? parse(picked) : base;
  for (let k = 0; !picked && k < 16 && contrast(luminance(light), white) < 4.5; k++)
    light = light.map((c) => c * 0.88) as typeof base;
  return { dark: toHex(base), light: toHex(light), darkFg: foregroundFor(base), lightFg: foregroundFor(light) };
}

/* -------------------------------------------------------------- page size */

/** The page width caps; "full" fills the screen (Tidewiki's own default). */
export const PAGE_MAX: Record<Display["width"], string> = { full: "none", wide: "150rem", standard: "105rem" };

/** Root font size: the browser's own size (so its zoom and font settings count), times the factors. */
export function rootFontSize(d: Display): string {
  const f = Math.round(d.size) / 100;
  return d.scale === "auto" ? `calc(100% * var(--ui-auto, 1) * ${f})` : `calc(100% * ${f})`;
}
export const autoFactor = (screenWidth: number) =>
  Math.round(Math.min(2.5, Math.max(1, (screenWidth || 0) / 2048)) * 100) / 100;

/** A size kept in one browser only (e.g. a wall screen), over the shared one. */
export const DEVICE_KEY = "tidewiki:display";

export function parseDisplay(v: unknown): Display | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (o.scale !== "auto" && o.scale !== "fixed") return null;
  if (typeof o.size !== "number" || !Number.isInteger(o.size) || o.size < SIZE_MIN || o.size > SIZE_MAX) return null;
  if (typeof o.width !== "string" || !(PAGE_WIDTHS as readonly string[]).includes(o.width)) return null;
  return { scale: o.scale, size: o.size, width: o.width as Display["width"] };
}

/**
 * Runs before the first paint (with the page's CSP nonce): the screen factor for the automatic
 * size, and this browser's own size if it has one. Mirrors rootFontSize/PAGE_MAX; every value is
 * checked before use.
 */
export const DEVICE_SCRIPT = `try{document.documentElement.style.setProperty("--ui-auto",String(Math.round(Math.min(2.5,Math.max(1,(screen.width||0)/2048))*100)/100))}catch(e){}try{var d=JSON.parse(localStorage.getItem(${JSON.stringify(DEVICE_KEY)})||"null");if(d&&(d.scale==="auto"||d.scale==="fixed")&&typeof d.size==="number"&&d.size>=${SIZE_MIN}&&d.size<=${SIZE_MAX}){var f=Math.round(d.size)/100,s=document.documentElement.style,W=${JSON.stringify(PAGE_MAX)},w=Object.prototype.hasOwnProperty.call(W,d.width)?W[d.width]:W.full;s.fontSize=d.scale==="auto"?"calc(100% * var(--ui-auto, 1) * "+f+")":"calc(100% * "+f+")";s.setProperty("--page-max",w)}}catch(e){}`;

/* -------------------------------------------------------------------- CSS */

/** Surfaces from a custom page colour, so the content area and lines stay in tune with it. */
function lightSurfaces(c: string) {
  return [
    `--bg: ${c}`,
    `--sheet: color-mix(in oklab, ${c} 18%, white)`,
    `--panel: color-mix(in oklab, ${c} 55%, white)`,
    `--line: color-mix(in oklab, ${c} 88%, black)`,
    `--line-2: color-mix(in oklab, ${c} 94%, black)`,
    `--code: color-mix(in oklab, ${c} 40%, white)`,
  ];
}
function darkSurfaces(c: string) {
  return [
    `--bg: ${c}`,
    `--sheet: color-mix(in oklab, ${c} 94%, white)`,
    `--panel: color-mix(in oklab, ${c} 90%, white)`,
    `--line: color-mix(in oklab, ${c} 80%, white)`,
    `--line-2: color-mix(in oklab, ${c} 86%, white)`,
    `--code: color-mix(in oklab, ${c} 92%, black)`,
  ];
}
function accentDecls(c: string, fg: string, dark: boolean) {
  return [
    `--accent: ${c}`,
    `--accent-ink: ${fg}`,
    `--focus: ${c}`,
    `--accent-soft: color-mix(in oklab, ${c} ${dark ? 18 : 12}%, var(--sheet))`,
    `--accent-2: color-mix(in oklab, ${c} 60%, var(--ink-2))`,
    `--sel: color-mix(in srgb, ${c} ${dark ? 38 : 30}%, transparent)`,
    `--sel-solid: color-mix(in oklab, ${c} ${dark ? 45 : 40}%, var(--sheet))`,
  ];
}

/**
 * Everything the appearance changes, as one stylesheet: rendered on the server into every page (no
 * flash of the default look) and replaced live in the settings. Only checked values reach it, and
 * nothing in it can close the <style> element.
 */
export function themeCss(a: Appearance, customCss = ""): string {
  const ac = accentPair(a.accent, a.accentLight);
  // Tide's own accent keeps the hand-tuned values from globals.css
  const tide = ac.dark === DEFAULT_ACCENT && ac.light === "#3d5a80";
  const light: string[] = [`--sans: ${fontStack(a.font, a.customFont)}`];
  const dark: string[] = [];
  if (!tide) {
    light.push(...accentDecls(ac.light, ac.lightFg, false));
    dark.push(...accentDecls(ac.dark, ac.darkFg, true));
  }
  const b = a.background;
  if (b.base === "color") {
    if (b.colorLight) light.push(...lightSurfaces(b.colorLight));
    if (b.colorDark) dark.push(...darkSurfaces(b.colorDark));
  }
  if (a.band.light) light.push(`--band: ${a.band.light}`);
  if (a.band.dark) dark.push(`--band: ${a.band.dark}`);
  const adjust = a.font !== "custom" ? (FONTS[a.font] as FontInfo).adjust : undefined;

  // Selectors one step more specific than globals.css, so the order of the stylesheets never matters.
  let css = `html:root{font-size:${rootFontSize(a.display)};--page-max:${PAGE_MAX[a.display.width]}}`;
  css += `html:root{${light.join(";")}}`;
  // dark: chosen in this browser, or the device's preference when nothing is chosen
  if (dark.length) {
    css += `html:root[data-theme="dark"]{${dark.join(";")}}`;
    css += `@media (prefers-color-scheme: dark){html:root:not([data-theme]){${dark.join(";")}}}`;
  }
  if (adjust) css += `html body{font-size-adjust:${adjust}}`;

  const gradient = b.gradientOn ? GRADIENTS[b.gradient] : null;
  if (gradient)
    css +=
      `html:root{--gradient:${gradient.light}}html:root[data-theme="dark"]{--gradient:${gradient.dark}}` +
      `@media (prefers-color-scheme: dark){html:root:not([data-theme]){--gradient:${gradient.dark}}}`;
  if (b.imageOn && MEDIA_IMAGE_RE.test(b.image)) {
    // the image, blurred, darkened towards the page colour, the gradient over it
    css +=
      `html body{background:transparent}` +
      `html body::before,html body::after{content:"";position:fixed;z-index:-1;pointer-events:none}` +
      `html body::before{inset:${b.blur ? -2 * b.blur : 0}px;background:url("${b.image}") center/cover no-repeat;${b.blur ? `filter:blur(${b.blur}px)` : ""}}` +
      `html body::after{inset:0;background-color:color-mix(in oklab, var(--bg) ${b.dim}%, transparent);background-image:${gradient ? "var(--gradient)" : "none"}}`;
  } else if (gradient) {
    css += `html body{background-image:var(--gradient);background-attachment:fixed}`;
  }
  if (a.sheetOpacity < 100) {
    const p = a.sheetOpacity;
    css +=
      `html .sheet{background:color-mix(in oklab, var(--sheet) ${p}%, transparent);backdrop-filter:blur(14px)}` +
      `html .rail{background:color-mix(in oklab, var(--panel) ${p}%, transparent);backdrop-filter:blur(14px)}`;
  }
  if (customCss) css += `\n/* custom CSS */\n${customCss}`;
  // Rendered into a <style> element: values are checked, but never let anything close it.
  return css.replace(/</g, "\\3c ");
}

/* -------------------------------------------------------------- custom CSS */

export const CUSTOM_CSS_MAX = 50_000;

/**
 * The owner's own CSS may restyle anything, but not reach out: no @import, and url() only to this
 * wiki (a path starting with "/", or an inline data: image). Otherwise CSS selectors on form fields
 * could send what someone types to another server. CSS escapes (u\72l, \40import) are decoded
 * before checking, so they can't hide anything. Returns an error text, or null when it's fine.
 */
export function checkCustomCss(css: unknown): string | null {
  if (typeof css !== "string") return msg("Invalid CSS.");
  if (css.length > CUSTOM_CSS_MAX) return msg("The CSS is too long (at most 50,000 characters).");
  if (/[\u0000-\u0008\u000b\u000e-\u001f]/.test(css)) return msg("Invalid CSS.");
  const plain = css
    .replace(/\/\*[\s\S]*?\*\//g, "") // comments
    .replace(/\\([0-9a-f]{1,6})\s?/gi, (_, h: string) =>
      String.fromCodePoint(Math.min(parseInt(h, 16), 0x10ffff) || 0xfffd),
    )
    .replace(/\\(.)/g, "$1")
    .toLowerCase();
  if (/@import|@namespace|expression\s*\(|javascript:|-moz-binding|behavior\s*:/.test(plain))
    return msg("@import, expression() and similar aren't allowed.");
  for (const m of plain.matchAll(/(?:url|image-set|image|cross-fade|src)\s*\(\s*(["']?)\s*([^"')]*)/g)) {
    const target = m[2].trim();
    if (target.startsWith("/") && !target.startsWith("//")) continue;
    if (/^data:image\/(?:png|gif|jpeg|webp);/.test(target)) continue;
    if (target === "" || target.startsWith("var(")) continue;
    return msg("Addresses in url() must point to this wiki (start with /).");
  }
  // image-set("…") and similar take bare strings too
  if (/(?:image-set|cross-fade)\s*\([^)]*["']\s*(?:https?:|\/\/)/.test(plain))
    return msg("Addresses in url() must point to this wiki (start with /).");
  return null;
}
