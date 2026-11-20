// Copies the selectable fonts from node_modules to public/fonts, one stylesheet per
// font, so a page loads only the font in use (and none of the others' CSS).
// Runs before `next dev` and `next build` (see package.json).
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(root, "package.json"));
const fonts = JSON.parse(readFileSync(path.join(root, "src/lib/font-files.json"), "utf8"));
const out = path.join(root, "public/fonts");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
let files = 0;
for (const [id, { pkg, css }] of Object.entries(fonts)) {
  if (!/^[a-z0-9]+$/.test(id)) throw new Error(`Bad font id ${id}`);
  const dir = path.dirname(require.resolve(`${pkg}/package.json`));
  const { version } = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  mkdirSync(path.join(out, id));
  let sheet = `/* ${pkg} ${version} (see its LICENSE) */\n`;
  for (const name of css) {
    const text = readFileSync(path.join(dir, name), "utf8");
    sheet += text
      // The .woff fallback is for browsers older than anything Tidewiki runs in: not shipped.
      .replace(/,\s*url\(\.\/files\/[\w.-]+\.woff\)\s*format\('woff'\)/g, "")
      .replace(/url\(\.\/files\/([\w.-]+\.woff2)\)/g, (_, file) => {
        copyFileSync(path.join(dir, "files", file), path.join(out, id, file));
        files++;
        return `url(/fonts/${id}/${file}?v=${version})`;
      });
    if (/url\(\.\//.test(sheet)) throw new Error(`${pkg}: a font file reference wasn't rewritten`);
  }
  copyFileSync(path.join(dir, "LICENSE"), path.join(out, id, "LICENSE"));
  writeFileSync(path.join(out, `${id}.css`), sheet);
}
console.log(`fonts: ${Object.keys(fonts).length} fonts, ${files} files → public/fonts`);

// Fonts for PDF export (server side only, so not under public/): complete TrueType files —
// the web fonts above are split into language subsets, a PDF needs one file with every glyph.
const pdfOut = path.join(root, "pdf-fonts");
rmSync(pdfOut, { recursive: true, force: true });
mkdirSync(pdfOut, { recursive: true });
const PDF_FONTS = {
  "@expo-google-fonts/inter": {
    "Inter-Regular.ttf": "400Regular/Inter_400Regular.ttf",
    "Inter-Italic.ttf": "400Regular_Italic/Inter_400Regular_Italic.ttf",
    "Inter-SemiBold.ttf": "600SemiBold/Inter_600SemiBold.ttf",
    "Inter-SemiBoldItalic.ttf": "600SemiBold_Italic/Inter_600SemiBold_Italic.ttf",
  },
  "@expo-google-fonts/jetbrains-mono": {
    "JetBrainsMono-Regular.ttf": "400Regular/JetBrainsMono_400Regular.ttf",
    "JetBrainsMono-Bold.ttf": "700Bold/JetBrainsMono_700Bold.ttf",
  },
};
for (const [pkg, files] of Object.entries(PDF_FONTS)) {
  const dir = path.dirname(require.resolve(`${pkg}/package.json`));
  for (const [to, from] of Object.entries(files)) copyFileSync(path.join(dir, from), path.join(pdfOut, to));
  copyFileSync(path.join(dir, "LICENSE_FONT"), path.join(pdfOut, `LICENSE-${pkg.split("/")[1]}.txt`));
}
console.log(`fonts: PDF fonts → pdf-fonts`);
