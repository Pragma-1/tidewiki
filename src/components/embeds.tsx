"use client";
import { useEffect } from "react";
import { safeUrl, VIMEO_ID, YT_ID } from "@/lib/embed-url";
import { useT } from "./i18n";
import type { T } from "@/lib/i18n";

/**
 * Two-click embeds: the server only renders a placeholder. Nothing is requested from YouTube,
 * Vimeo or a foreign image host until the reader clicks. Elements are built with DOM APIs from
 * re-validated values — no HTML strings, so a crafted data-* attribute can't inject markup.
 */
function activate(box: HTMLElement, t: T) {
  const kind = box.dataset.embed;
  let el: HTMLElement | null = null;
  if (kind === "youtube" && YT_ID.test(box.dataset.id ?? "")) {
    el = frame(`https://www.youtube-nocookie.com/embed/${box.dataset.id}`);
  } else if (kind === "vimeo" && VIMEO_ID.test(box.dataset.id ?? "")) {
    el = frame(`https://player.vimeo.com/video/${box.dataset.id}?dnt=1`);
  } else if (kind === "image") {
    const u = safeUrl(box.dataset.src ?? "");
    if (u && u.protocol === "https:") {
      const img = document.createElement("img");
      img.src = u.href;
      img.alt = box.dataset.alt ?? "";
      img.loading = "lazy";
      img.referrerPolicy = "no-referrer";
      el = img;
    }
  }
  if (!el) return;
  const nodes: Node[] = [el];
  if (kind === "youtube" || kind === "vimeo") {
    // keep the "open on …" link (it opens in a new tab) and add the picture-in-picture toggle
    const tools = document.createElement("div");
    tools.className = "media-tools";
    tools.append(pipButton(t));
    const open = box.querySelector<HTMLAnchorElement>("a.embed-open");
    if (open) tools.append(open);
    nodes.push(tools);
  }
  box.replaceChildren(...nodes);
  box.classList.add("embed-active");
}

function frame(src: string) {
  const f = document.createElement("iframe");
  f.src = src;
  f.title = "Video";
  // no autoplay (also blocked by Permissions-Policy): the reader starts playback in the player
  f.allow = "encrypted-media; picture-in-picture; fullscreen";
  f.allowFullscreen = true;
  // YouTube refuses to play without a Referer; send only our origin, never the page path.
  f.referrerPolicy = "strict-origin-when-cross-origin";
  f.setAttribute(
    "sandbox",
    "allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox",
  );
  return f;
}

function pipButton(t: T) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "pip-btn";
  b.textContent = t("Picture-in-picture");
  return b;
}

/* --------------------------------------------------- picture-in-picture */

/**
 * A mini player that stays on screen while the reader scrolls, for uploaded videos as well as
 * YouTube/Vimeo (whose iframes can't be pulled out of the page; the browser's own
 * picture-in-picture for uploaded videos stays available in the video's controls). Pinning only
 * changes CSS — the player is never moved in the DOM, so playback continues without reloading. A
 * placeholder keeps the page from jumping. The player can be dragged by its top bar and resized
 * from its top-left corner (pointer or arrow keys); where it was and how big is kept per browser.
 */
const PIP_KEY = "tidewiki:pip";
const EDGE = 8; // px kept free around the player
type Geo = { r: number; b: number; w: number }; // distance from the right and bottom edge, width (px)

const viewport = () => ({
  vw: document.documentElement.clientWidth || window.innerWidth,
  vh: document.documentElement.clientHeight || window.innerHeight,
});
const remPx = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;

function savedGeo(): Geo | null {
  try {
    const v = JSON.parse(localStorage.getItem(PIP_KEY) ?? "null") as unknown;
    if (!v || typeof v !== "object") return null;
    const { r, b, w } = v as Record<string, unknown>;
    const ok = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 20000;
    return ok(r) && ok(b) && ok(w) ? { r, b, w } : null;
  } catch {
    return null;
  }
}
function saveGeo(g: Geo) {
  try {
    localStorage.setItem(PIP_KEY, JSON.stringify({ r: Math.round(g.r), b: Math.round(g.b), w: Math.round(g.w) }));
  } catch {
    /* private mode or storage full: the player still works, it just isn't remembered */
  }
}

/** Default: a good share of the window, never tiny, never wider than the window. */
function defaultGeo(): Geo {
  const { vw } = viewport();
  const rem = remPx();
  return { r: rem, b: rem, w: Math.min(Math.max(20 * rem, 0.38 * vw), 52 * rem, vw - 2 * EDGE) };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/** Applies a position and size, kept fully inside the window. Returns what was applied. */
function place(box: HTMLElement, g: Geo): Geo {
  const { vw, vh } = viewport();
  const minW = Math.min(14 * remPx(), vw - 2 * EDGE);
  let w = clamp(g.w, minW, vw - 2 * EDGE);
  box.style.width = `${w}px`;
  // the height follows the width (16:9 player plus bar and buttons); shrink until it fits the window
  for (let i = 0; i < 4 && box.offsetHeight > vh - 2 * EDGE && w > minW; i++) {
    w = clamp(w - ((box.offsetHeight - (vh - 2 * EDGE)) * 16) / 9 - 1, minW, vw - 2 * EDGE);
    box.style.width = `${w}px`;
  }
  const h = box.offsetHeight;
  const out = { w, r: clamp(g.r, EDGE, vw - w - EDGE), b: clamp(g.b, EDGE, vh - h - EDGE) };
  box.style.right = `${out.r}px`;
  box.style.bottom = `${out.b}px`;
  return out;
}

const geoOf = (box: HTMLElement): Geo => ({
  r: parseFloat(box.style.right) || 0,
  b: parseFloat(box.style.bottom) || 0,
  w: parseFloat(box.style.width) || box.offsetWidth,
});

function control(className: string, label: string, onKey: (e: KeyboardEvent, step: number) => boolean) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = className;
  b.setAttribute("aria-label", label);
  b.title = label;
  b.addEventListener("keydown", (e) => {
    if (onKey(e, e.shiftKey ? 64 : 16)) e.preventDefault();
  });
  return b;
}

/** Drag with mouse, pen or finger; the iframe is made click-through meanwhile so it can't swallow the pointer. */
function dragWith(handle: HTMLElement, box: HTMLElement, move: (start: Geo, dx: number, dy: number) => Geo) {
  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !box.classList.contains("floating")) return;
    e.preventDefault();
    const start = geoOf(box);
    const x0 = e.clientX,
      y0 = e.clientY;
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      /* capture is a nicety */
    }
    box.classList.add("dragging");
    const onMove = (m: PointerEvent) => {
      if (m.pointerId === e.pointerId) place(box, move(start, m.clientX - x0, m.clientY - y0));
    };
    let done = false;
    const end = () => {
      if (done) return;
      done = true;
      box.classList.remove("dragging");
      for (const [ev, fn] of listeners) handle.removeEventListener(ev, fn as EventListener);
      if (box.classList.contains("floating")) saveGeo(geoOf(box));
    };
    const listeners: [string, (ev: PointerEvent) => void][] = [
      ["pointermove", onMove],
      ["pointerup", end],
      ["pointercancel", end],
      ["lostpointercapture", end],
    ];
    for (const [ev, fn] of listeners) handle.addEventListener(ev, fn as EventListener);
  });
}

function unpin(box: HTMLElement, t: T) {
  box.classList.remove("floating", "dragging");
  box.querySelectorAll(":scope > .float-bar").forEach((el) => el.remove());
  box.style.removeProperty("right");
  box.style.removeProperty("bottom");
  box.style.removeProperty("width");
  const ph = box.previousElementSibling;
  if (ph?.classList.contains("float-ph")) ph.remove();
  const btn = box.querySelector<HTMLButtonElement>(".pip-btn");
  if (btn) {
    btn.textContent = t("Picture-in-picture");
    btn.setAttribute("aria-pressed", "false");
  }
}

function pin(box: HTMLElement, t: T) {
  document.querySelectorAll<HTMLElement>(".md .floating").forEach((b) => unpin(b, t)); // one mini player at a time
  const ph = document.createElement("div");
  ph.className = "float-ph";
  ph.style.height = `${box.offsetHeight}px`;
  ph.setAttribute("aria-hidden", "true");
  box.before(ph);

  // top bar: resize corner on the left, the rest is the handle to move it
  const bar = document.createElement("div");
  bar.className = "float-bar";
  const size = control("float-size", t("Resize the mini player: drag, or use the arrow keys"), (e, step) => {
    const g = geoOf(box);
    if (e.key === "ArrowLeft" || e.key === "ArrowUp" || e.key === "+") g.w += step;
    else if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === "-") g.w -= step;
    else return false;
    saveGeo(place(box, g));
    return true;
  });
  const grip = control("float-grip", t("Move the mini player: drag, or use the arrow keys"), (e, step) => {
    const g = geoOf(box);
    if (e.key === "ArrowLeft") g.r += step;
    else if (e.key === "ArrowRight") g.r -= step;
    else if (e.key === "ArrowUp") g.b += step;
    else if (e.key === "ArrowDown") g.b -= step;
    else return false;
    saveGeo(place(box, g));
    return true;
  });
  // right and bottom edge stay put while resizing from the top-left corner
  dragWith(size, box, (s, dx, dy) => ({
    ...s,
    w: s.w - (Math.abs(dx) >= Math.abs(dy) * (16 / 9) ? dx : (dy * 16) / 9),
  }));
  dragWith(grip, box, (s, dx, dy) => ({ ...s, r: s.r - dx, b: s.b - dy }));
  bar.append(size, grip);
  box.prepend(bar);

  box.classList.add("floating");
  place(box, savedGeo() ?? defaultGeo());
  const btn = box.querySelector<HTMLButtonElement>(".pip-btn");
  if (btn) {
    btn.textContent = t("Back into the page");
    btn.setAttribute("aria-pressed", "true");
  }
}

function togglePip(btn: HTMLElement, t: T) {
  const box = btn.closest<HTMLElement>(".media-video, .embed");
  if (!box) return;
  if (box.classList.contains("floating")) unpin(box, t);
  else pin(box, t);
}

export function EmbedActivator() {
  const t = useT();
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const target = e.target as Element | null;
      const copy = target?.closest?.(".md .copy-code") as HTMLButtonElement | null;
      if (copy) {
        const code = copy.parentElement?.querySelector("code")?.textContent ?? "";
        void navigator.clipboard?.writeText(code).then(() => {
          copy.dataset.done = "1";
          setTimeout(() => {
            delete copy.dataset.done;
          }, 1500);
        });
        return;
      }
      const pipBtn = target?.closest?.(".md .pip-btn") as HTMLElement | null;
      if (pipBtn) {
        e.preventDefault();
        togglePip(pipBtn, t);
        return;
      }
      const btn = target?.closest?.(".md .embed-load");
      const box = btn?.closest<HTMLElement>(".embed");
      if (box) {
        e.preventDefault();
        activate(box, t);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // Escape in a dialog, the search box or a text field belongs to that, not to the player
      const el = e.target instanceof Element ? e.target : null;
      if (document.querySelector("dialog[open]") || el?.closest("input, textarea, select, [contenteditable]")) return;
      document.querySelectorAll<HTMLElement>(".md .floating").forEach((b) => unpin(b, t));
    };
    // keep the mini player inside the window when it gets smaller (rotation, split screen, zoom)
    let raf = 0;
    const onResize = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() =>
        document.querySelectorAll<HTMLElement>(".md .floating").forEach((b) => place(b, geoOf(b))),
      );
    };
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [t]);
  return null;
}
