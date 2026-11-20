"use client";
import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Check, ImagePlus, RotateCcw } from "lucide-react";
import { call } from "@/lib/client-api";
import {
  ACCENT_PRESETS,
  accentPair,
  applyPreset,
  autoFactor,
  checkCustomCss,
  CUSTOM_FONT_RE,
  DEVICE_KEY,
  FONT_GROUPS,
  FONT_SHEETS,
  FONTS,
  fontHref,
  fontStack,
  GRADIENTS,
  PAGE_MAX,
  parseDisplay,
  PRESET_GROUPS,
  presetMatches,
  rootFontSize,
  SHEET_OPACITY_MIN,
  SIZE_MAX,
  SIZE_MIN,
  THEME_PRESETS,
  themeCss,
  type Appearance,
  type Display,
  type FontId,
  type GradientId,
  type ThemePreset,
} from "@/lib/appearance";
import { useToast } from "./ui";
import { useT } from "./i18n";

export type BackgroundImage = { name: string; title: string };

/** Tidewiki's own greys, for previews of "theme" backgrounds. */
const STONE = { light: { bg: "#f2f2ef", band: "#2a2f36" }, dark: { bg: "#111316", band: "#0b0d10" } };

/* ----------------------------------------------------------- live preview */

/** Puts a look on this page right away (the server does the same for every page once it's saved). */
function applyToPage(a: Appearance, css: string) {
  const style = document.getElementById("tw-theme");
  if (style) style.textContent = themeCss(a, css);
  const href = fontHref(a.font);
  let link = document.getElementById("tw-font") as HTMLLinkElement | null;
  if (href) {
    if (!link) {
      link = document.createElement("link");
      link.id = "tw-font";
      link.rel = "stylesheet";
      document.head.appendChild(link);
    }
    if (link.getAttribute("href") !== href) link.href = href;
  } else link?.remove();
}

/** The font list and the preset cards show every font: load their small stylesheets while this is open. */
function useAllFonts() {
  useEffect(() => {
    for (const href of FONT_SHEETS) {
      if (document.querySelector(`link[data-font-preview][href="${href}"]`)) continue;
      const el = document.createElement("link");
      el.rel = "stylesheet";
      el.href = href;
      el.dataset.fontPreview = "";
      document.head.appendChild(el);
    }
  }, []);
}

/* -------------------------------------------------------------- controls */

/**
 * A colour well. Dragging through the picker sends dozens of changes a second; the page takes at
 * most one per frame (the well itself follows every one).
 */
function ColorWell({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const pending = useRef<string | null>(null);
  const frame = useRef(0);
  const send = useRef(onChange);
  useEffect(() => {
    send.current = onChange;
  });
  const flush = () => {
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    const v = pending.current;
    pending.current = null;
    if (v !== null) send.current(v);
    setDraft(null);
  };
  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      if (pending.current !== null) send.current(pending.current);
    },
    [],
  );
  return (
    <input
      type="color"
      className="ap-well"
      aria-label={label}
      value={draft ?? value}
      onChange={(e) => {
        pending.current = e.target.value;
        setDraft(e.target.value);
        if (!frame.current) frame.current = requestAnimationFrame(flush);
      }}
      onBlur={() => pending.current !== null && flush()}
    />
  );
}

function ColorPair({
  label,
  hint,
  light,
  dark,
  fallback,
  onLight,
  onDark,
}: {
  label: string;
  hint?: string;
  light: string;
  dark: string;
  fallback: { light: string; dark: string };
  onLight: (v: string) => void;
  onDark: (v: string) => void;
}) {
  const t = useT();
  return (
    <div className="field">
      <span className="ap-label">{label}</span>
      <div className="ap-pair">
        {(
          [
            [t("Light theme"), light, fallback.light, onLight],
            [t("Dark theme"), dark, fallback.dark, onDark],
          ] as const
        ).map(([name, value, fb, on]) => (
          <span key={name} className="ap-swatch">
            <ColorWell label={`${label}, ${name}`} value={value || fb} onChange={on} />
            <span>
              {name}
              <span className="mono hint ap-code">{value || t("default")}</span>
            </span>
            {value && (
              <button type="button" className="btn ghost sm" onClick={() => on("")}>
                {t("Reset")}
              </button>
            )}
          </span>
        ))}
      </div>
      {hint && <p className="hint">{hint}</p>}
    </div>
  );
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<readonly [T, string]>;
  onChange: (v: T) => void;
}) {
  return (
    <div className="ap-seg" role="radiogroup" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </div>
  );
}

function Slider({
  id,
  label,
  min,
  max,
  step = 1,
  value,
  onChange,
  onCommit,
}: {
  id: string;
  label: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (v: number) => void;
  onCommit?: (v: number) => void;
}) {
  return (
    <div className="field">
      <label htmlFor={id} className="ap-label">
        {label}
      </label>
      <input
        id={id}
        className="ap-range"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerUp={(e) => onCommit?.(Number((e.target as HTMLInputElement).value))}
        onKeyUp={(e) => onCommit?.(Number((e.target as HTMLInputElement).value))}
      />
    </div>
  );
}

/** One layer of the background: a title with an on/off switch, its settings below while on. */
function Layer({
  id,
  title,
  hint,
  on,
  onChange,
  children,
}: {
  id: string;
  title: string;
  hint: string;
  on: boolean;
  onChange: (on: boolean) => void;
  children: ReactNode;
}) {
  return (
    <div className={`ap-layer${on ? " on" : ""}`}>
      <div className="switch">
        <input id={id} type="checkbox" role="switch" checked={on} onChange={(e) => onChange(e.target.checked)} />
        <div style={{ flex: 1 }}>
          <label className="t" htmlFor={id}>
            {title}
          </label>
          <div className="d">{hint}</div>
        </div>
      </div>
      {on && <div className="ap-layer-body">{children}</div>}
    </div>
  );
}

/** A tiny picture of a preset: band, page, a card, the accent and a sample of the font. */
const PresetCard = memo(
  function PresetCard({ p, active, onPick }: { p: ThemePreset; active: boolean; onPick: () => void }) {
    const t = useT();
    const page = p.background.base === "color" && p.background.colorDark ? p.background.colorDark : STONE.dark.bg;
    const band = p.band.dark || STONE.dark.band;
    const gradient = p.background.gradientOn ? GRADIENTS[p.background.gradient].dark : undefined;
    return (
      <button type="button" className={`ap-preset${active ? " on" : ""}`} aria-pressed={active} onClick={onPick}>
        <span className="ap-preset-pic" style={{ background: page, backgroundImage: gradient }}>
          <span className="ap-preset-band" style={{ background: band }} />
          <span className="ap-preset-card" style={{ background: `color-mix(in oklab, ${page} 92%, white)` }}>
            <span className="ap-dot" style={{ background: p.accent }} />
            <span style={{ fontFamily: fontStack(p.font, ""), fontWeight: 650 }}>Aa</span>
            <span className="ap-bar" style={{ background: accentPair(p.accent, p.accentLight).dark }} />
          </span>
        </span>
        <span className="ap-preset-name">
          {t(p.name)}
          {active && <Check size={14} aria-hidden />}
        </span>
      </button>
    );
  },
  (a, b) => a.p === b.p && a.active === b.active,
);

/* ------------------------------------------------------------------ panel */

/**
 * Darstellung: everything about the wiki's look, shown on this page as you change it and saved a
 * moment later. Presets, default theme, size, accent colour, font, background layers, header band
 * and content opacity are for administrators; the owner's own CSS needs the owner's password.
 */
export function AppearancePanel({
  initial,
  initialCss,
  isOwner,
  images: initialImages,
}: {
  initial: Appearance;
  initialCss: string;
  isOwner: boolean;
  images: BackgroundImage[];
}) {
  const t = useT();
  const router = useRouter();
  const toast = useToast();
  const [a, setA] = useState(initial);
  const [css, setCss] = useState(initialCss);
  const [savedCss, setSavedCss] = useState(initialCss);
  const [cssPw, setCssPw] = useState("");
  const [cssBusy, setCssBusy] = useState(false);
  const [images, setImages] = useState(initialImages);
  const [uploading, setUploading] = useState(false);
  const [device, setDevice] = useState<Display | null>(null);
  const [sizeDraft, setSizeDraft] = useState(initial.display.size);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(a);
  useAllFonts();

  // this browser's own size, if it has one
  useEffect(() => {
    try {
      const d = parseDisplay(JSON.parse(localStorage.getItem(DEVICE_KEY) ?? "null"));
      if (d) {
        setDevice(d);
        setSizeDraft(d.size);
      }
    } catch {
      /* storage blocked */
    }
  }, []);

  const cssProblem = checkCustomCss(css);
  const previewCss = cssProblem ? savedCss : css;

  const save = async () => {
    timer.current = null;
    const r = await call<Appearance>("/api/appearance", "PUT", latest.current);
    if (!r.ok) toast.show({ ok: false, text: t(r.data.error ?? "Couldn’t save.") });
  };
  // flush a pending save when leaving the page
  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
        void call("/api/appearance", "PUT", latest.current);
      }
    },
    [],
  );

  const change = (next: Appearance, mine = true) => {
    const v = mine ? { ...next, preset: THEME_PRESETS.find((p) => presetMatches(p, next))?.id ?? "custom" } : next;
    latest.current = v;
    setA(v);
    applyToPage(v, previewCss);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), 450);
  };
  const edit = (fn: (x: Appearance) => Appearance) => change(fn(latest.current));

  // the size, shared or only for this browser
  const shownDisplay = device ?? a.display;
  const applyDevice = (d: Display | null) => {
    const s = document.documentElement.style;
    if (d) {
      s.fontSize = rootFontSize(d);
      s.setProperty("--page-max", PAGE_MAX[d.width]);
      localStorage.setItem(DEVICE_KEY, JSON.stringify(d));
    } else {
      s.fontSize = "";
      s.removeProperty("--page-max");
      localStorage.removeItem(DEVICE_KEY);
    }
  };
  const changeDisplay = (patch: Partial<Display>) => {
    if (device) {
      const d = { ...device, ...patch };
      setDevice(d);
      try {
        applyDevice(d);
      } catch {
        /* storage blocked: lasts until reload */
      }
    } else edit((x) => ({ ...x, display: { ...x.display, ...patch } }));
  };
  const [screenFactor, setScreenFactor] = useState(1);
  useEffect(() => setScreenFactor(autoFactor(screen.width, screen.height)), []);
  const screenPercent = Math.round(screenFactor * shownDisplay.size);

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const res = await fetch(`/api/media?name=${encodeURIComponent(file.name.slice(0, 120))}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/octet-stream" },
        body: file,
      });
      const d = (await res.json().catch(() => ({}))) as { url?: string; kind?: string; error?: string };
      if (!res.ok || !d.url) {
        toast.show({ ok: false, text: t(d.error ?? "Upload failed.") });
        return;
      }
      if (d.kind && d.kind !== "image") {
        toast.show({ ok: false, text: t("Choose an image (PNG, JPEG, GIF or WebP).") });
        return;
      }
      const name = d.url.replace(/^\/media\//, "");
      setImages((cur) => [{ name, title: file.name }, ...cur]);
      edit((x) => ({ ...x, background: { ...x.background, imageOn: true, image: d.url! } }));
    } finally {
      setUploading(false);
    }
  };

  const saveCss = async () => {
    setCssBusy(true);
    const r = await call("/api/appearance/css", "PUT", { css, password: cssPw });
    setCssBusy(false);
    if (!r.ok) {
      toast.show({ ok: false, text: t(r.data.error ?? "Couldn’t save.") });
      return;
    }
    setSavedCss(css);
    setCssPw("");
    toast.show({ ok: true, text: t("Saved.") });
    router.refresh();
  };

  const bg = a.background;
  const fontsByGroup = FONT_GROUPS.map((group) => ({
    group,
    fonts: (Object.entries(FONTS) as Array<[FontId, (typeof FONTS)[FontId]]>).filter(([, f]) => f.group === group),
  }));

  return (
    <>
      {toast.node}
      <section className="panel ap-presets">
        <div className="row between">
          <h2 className="section-title">{t("Presets")}</h2>
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => change(applyPreset(a, THEME_PRESETS[0]), false)}
          >
            <RotateCcw size={15} aria-hidden />
            {t("Back to Tide")}
          </button>
        </div>
        {PRESET_GROUPS.map((group) => (
          <div key={group}>
            <h3 className="ap-group">{t(group)}</h3>
            <div className="ap-preset-grid">
              {THEME_PRESETS.filter((p) => p.group === group).map((p) => (
                <PresetCard
                  key={p.id}
                  p={p}
                  active={presetMatches(p, a)}
                  onPick={() => change(applyPreset(latest.current, p), false)}
                />
              ))}
            </div>
          </div>
        ))}
        <p className="hint">
          {t("A preset sets colours, background and font. Change anything below to make it your own.")}
        </p>
      </section>

      <div className="settings-cols">
        <div className="settings-col">
          <section className="panel">
            <h2 className="section-title">{t("Theme and size")}</h2>
            <div className="field">
              <span className="ap-label">{t("Default theme")}</span>
              <Segmented
                label={t("Default theme")}
                value={a.theme}
                options={[
                  ["system", t("Follow device")],
                  ["light", t("Light")],
                  ["dark", t("Dark")],
                ]}
                onChange={(theme) => edit((x) => ({ ...x, theme }))}
              />
              <p className="hint">{t("For everyone who hasn’t picked one with the sun/moon button.")}</p>
            </div>
            <div className="field">
              <span className="ap-label">{t("Size")}</span>
              <Segmented
                label={t("Size")}
                value={shownDisplay.scale}
                options={[
                  ["fixed", t("Fixed")],
                  ["auto", t("Fit the screen")],
                ]}
                onChange={(scale) => changeDisplay({ scale })}
              />
            </div>
            <Slider
              id="ap-size"
              label={
                shownDisplay.scale === "auto" ? t("Adjust {n} %", { n: sizeDraft }) : t("Size {n} %", { n: sizeDraft })
              }
              min={SIZE_MIN}
              max={SIZE_MAX}
              step={5}
              value={sizeDraft}
              onChange={setSizeDraft}
              onCommit={(size) => size !== shownDisplay.size && changeDisplay({ size })}
            />
            <p className="hint">
              {shownDisplay.scale === "auto"
                ? t(
                    "Grows only on screens larger than 2560 × 1440 px (4K without system scaling, TVs); browser zoom (Ctrl + / −) works on top. On this screen: {n} %.",
                    { n: screenPercent },
                  )
                : t(
                    "Everything is shown at {n} % of the browser’s own size, on every screen; browser zoom (Ctrl + / −) works on top.",
                    { n: shownDisplay.size },
                  )}
            </p>
            <div className="field">
              <span className="ap-label">{t("Page width")}</span>
              <Segmented
                label={t("Page width")}
                value={shownDisplay.width}
                options={[
                  ["full", t("Full width")],
                  ["wide", t("Wide")],
                  ["standard", t("Standard")],
                ]}
                onChange={(width) => changeDisplay({ width })}
              />
              <p className="hint">{t("How wide the page may get before it is centred. Scales with the size.")}</p>
            </div>
            <div className="switch">
              <input
                id="ap-device"
                type="checkbox"
                role="switch"
                checked={!!device}
                onChange={(e) => {
                  const d = e.target.checked ? { ...a.display } : null;
                  setDevice(d);
                  setSizeDraft((d ?? a.display).size);
                  try {
                    applyDevice(d);
                  } catch {
                    /* storage blocked */
                  }
                }}
              />
              <div style={{ flex: 1 }}>
                <label className="t" htmlFor="ap-device">
                  {t("Only on this device")}
                </label>
                <div className="d">
                  {device
                    ? t("This browser keeps its own size. Turn off to use the shared one again.")
                    : t("Give this browser its own size, e.g. for a wall screen. Stored in this browser.")}
                </div>
              </div>
            </div>
          </section>

          <section className="panel">
            <h2 className="section-title">{t("Accent colour")}</h2>
            <div className="ap-accents">
              {ACCENT_PRESETS.map((p) => {
                const on = a.accent === p.hex && (!a.accentLight || a.accentLight === p.light);
                return (
                  <button
                    key={p.hex}
                    type="button"
                    className={`ap-accent${on ? " on" : ""}`}
                    title={t(p.name)}
                    aria-label={t(p.name)}
                    aria-pressed={on}
                    onClick={() => edit((x) => ({ ...x, accent: p.hex, accentLight: p.light }))}
                    style={{ background: `linear-gradient(135deg, ${p.light} 50%, ${p.hex} 50%)` }}
                  />
                );
              })}
            </div>
            <ColorPair
              label={t("Your own")}
              hint={t("Pick each theme separately. Leave the light one on default and it’s derived from the dark one.")}
              light={a.accentLight}
              dark={a.accent}
              fallback={{ light: accentPair(a.accent, "").light, dark: "#8eaedb" }}
              onLight={(v) => edit((x) => ({ ...x, accentLight: v }))}
              onDark={(v) => edit((x) => ({ ...x, accent: v || "#8eaedb" }))}
            />
          </section>

          <section className="panel">
            <h2 className="section-title">{t("Font")}</h2>
            <div className="field">
              <label htmlFor="ap-font" className="sr-only">
                {t("Font")}
              </label>
              <select
                id="ap-font"
                className="input"
                value={a.font}
                onChange={(e) => edit((x) => ({ ...x, font: e.target.value as Appearance["font"] }))}
              >
                {fontsByGroup.map(({ group, fonts }) => (
                  <optgroup key={group} label={t(group)}>
                    {fonts.map(([id, f]) => (
                      <option key={id} value={id}>
                        {f.name} — {t(f.note)}
                      </option>
                    ))}
                    {group === "Device" && <option value="custom">{t("Another font on my device…")}</option>}
                  </optgroup>
                ))}
              </select>
            </div>
            {a.font === "custom" && (
              <div className="field">
                <label htmlFor="ap-custom-font">{t("Font name")}</label>
                <input
                  id="ap-custom-font"
                  className="input"
                  value={a.customFont}
                  maxLength={60}
                  placeholder="Segoe UI"
                  onChange={(e) =>
                    CUSTOM_FONT_RE.test(e.target.value) && edit((x) => ({ ...x, customFont: e.target.value }))
                  }
                />
                <p className="hint">
                  {t("Must be installed on every device that opens the wiki; others fall back to Inter.")}
                </p>
              </div>
            )}
            <p className="ap-sample" style={{ fontFamily: fontStack(a.font, a.customFont) }}>
              {t("The quick brown fox jumps over 13 lazy servers. 0123456789")}
            </p>
          </section>
        </div>

        <div className="settings-col">
          <section className="panel">
            <h2 className="section-title">{t("Background")}</h2>
            <div className="ap-layer on">
              <div className="row between" style={{ flexWrap: "wrap", gap: ".6rem" }}>
                <div>
                  <span className="ap-label">{t("Base")}</span>
                  <div className="hint">
                    {t("The page colour. The content area, lines and fields are tinted to match.")}
                  </div>
                </div>
                <Segmented
                  label={t("Base")}
                  value={bg.base}
                  options={[
                    ["theme", t("Theme grey")],
                    ["color", t("Own colour")],
                  ]}
                  onChange={(base) => edit((x) => ({ ...x, background: { ...x.background, base } }))}
                />
              </div>
              {bg.base === "color" && (
                <ColorPair
                  label={t("Page colour")}
                  light={bg.colorLight}
                  dark={bg.colorDark}
                  fallback={{ light: STONE.light.bg, dark: STONE.dark.bg }}
                  onLight={(v) => edit((x) => ({ ...x, background: { ...x.background, colorLight: v } }))}
                  onDark={(v) => edit((x) => ({ ...x, background: { ...x.background, colorDark: v } }))}
                />
              )}
            </div>

            <Layer
              id="ap-image"
              title={t("Image")}
              hint={t("Over the base. Darkening blends it towards the page colour.")}
              on={bg.imageOn}
              onChange={(on) => edit((x) => ({ ...x, background: { ...x.background, imageOn: on } }))}
            >
              <div className="ap-images" role="radiogroup" aria-label={t("Background image")}>
                <label className="ap-upload">
                  <ImagePlus size={20} aria-hidden />
                  <span>{uploading ? t("Uploading…") : t("Upload image")}</span>
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/gif,image/webp"
                    className="sr-only"
                    disabled={uploading}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      e.target.value = "";
                      if (f) void upload(f);
                    }}
                  />
                </label>
                {images.map((img) => {
                  const url = `/media/${img.name}`;
                  const on = bg.image === url;
                  return (
                    <button
                      key={img.name}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      title={img.title}
                      className={`ap-image${on ? " on" : ""}`}
                      onClick={() => edit((x) => ({ ...x, background: { ...x.background, image: url } }))}
                    >
                      <img src={url} alt={img.title} loading="lazy" />
                    </button>
                  );
                })}
              </div>
              {!bg.image && <p className="hint">{t("Upload an image or pick one of the wiki’s images.")}</p>}
              <div className="form-grid">
                <Slider
                  id="ap-blur"
                  label={t("Blur {n} px", { n: bg.blur })}
                  min={0}
                  max={40}
                  value={bg.blur}
                  onChange={(blur) => edit((x) => ({ ...x, background: { ...x.background, blur } }))}
                />
                <Slider
                  id="ap-dim"
                  label={t("Darken {n} %", { n: bg.dim })}
                  min={0}
                  max={90}
                  value={bg.dim}
                  onChange={(dim) => edit((x) => ({ ...x, background: { ...x.background, dim } }))}
                />
              </div>
            </Layer>

            <Layer
              id="ap-gradient"
              title={t("Gradient")}
              hint={t("On top of everything, as a soft glow of colour.")}
              on={bg.gradientOn}
              onChange={(on) => edit((x) => ({ ...x, background: { ...x.background, gradientOn: on } }))}
            >
              <div className="ap-gradients" role="radiogroup" aria-label={t("Gradient")}>
                {(Object.entries(GRADIENTS) as Array<[GradientId, (typeof GRADIENTS)[GradientId]]>).map(([id, g]) => (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={bg.gradient === id}
                    className={`ap-gradient${bg.gradient === id ? " on" : ""}`}
                    onClick={() => edit((x) => ({ ...x, background: { ...x.background, gradient: id } }))}
                  >
                    <span
                      style={{
                        background: bg.base === "color" && bg.colorDark ? bg.colorDark : STONE.dark.bg,
                        backgroundImage: g.dark,
                      }}
                    />
                    {t(g.name)}
                  </button>
                ))}
              </div>
            </Layer>
          </section>

          <section className="panel">
            <h2 className="section-title">{t("Header and content area")}</h2>
            <ColorPair
              label={t("Header band")}
              light={a.band.light}
              dark={a.band.dark}
              fallback={{ light: STONE.light.band, dark: STONE.dark.band }}
              onLight={(v) => edit((x) => ({ ...x, band: { ...x.band, light: v } }))}
              onDark={(v) => edit((x) => ({ ...x, band: { ...x.band, dark: v } }))}
            />
            <Slider
              id="ap-opacity"
              label={t("Content opacity {n} %", { n: a.sheetOpacity })}
              min={SHEET_OPACITY_MIN}
              max={100}
              value={a.sheetOpacity}
              onChange={(sheetOpacity) => edit((x) => ({ ...x, sheetOpacity }))}
            />
            <p className="hint">
              {t("Below 100 % the background shows through the page and the side panel, frosted.")}
            </p>
          </section>

          <section className="panel">
            <h2 className="section-title">{t("Custom CSS")}</h2>
            <textarea
              className="input mono ap-css"
              aria-label={t("Custom CSS")}
              aria-describedby="ap-css-hint"
              rows={7}
              spellCheck={false}
              value={css}
              disabled={!isOwner}
              placeholder={".sheet { border-radius: 4px; }"}
              onChange={(e) => {
                setCss(e.target.value);
                if (!checkCustomCss(e.target.value)) applyToPage(latest.current, e.target.value);
              }}
            />
            {cssProblem && css !== savedCss && <p className="error-text">{t(cssProblem)}</p>}
            <p id="ap-css-hint" className="hint">
              {isOwner
                ? t(
                    "Applied after everything else, on every page. The page is .sheet, the side panel .rail, the header .top. It may not load anything from other servers. Only the owner can change it, with the password.",
                  )
                : t("Only the owner can change the custom CSS.")}
            </p>
            {isOwner && css !== savedCss && (
              <form
                className="row"
                style={{ gap: ".5rem", flexWrap: "wrap", alignItems: "flex-end" }}
                onSubmit={(e) => {
                  e.preventDefault();
                  void saveCss();
                }}
              >
                <div className="field" style={{ flex: "1 1 14rem", margin: 0 }}>
                  <label htmlFor="ap-css-pw">{t("Your password")}</label>
                  <input
                    id="ap-css-pw"
                    className="input"
                    type="password"
                    autoComplete="current-password"
                    value={cssPw}
                    onChange={(e) => setCssPw(e.target.value)}
                  />
                </div>
                <button type="submit" className="btn" disabled={cssBusy || !!cssProblem || !cssPw}>
                  {cssBusy ? t("Saving…") : t("Save CSS")}
                </button>
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => {
                    setCss(savedCss);
                    applyToPage(latest.current, savedCss);
                  }}
                >
                  {t("Discard")}
                </button>
              </form>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
