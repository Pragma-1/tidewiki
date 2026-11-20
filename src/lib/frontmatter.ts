/* Pure helpers, used on the server (import/export) and in the editor (open .md file). */

/**
 * `---\ntitle: "…"\naccess: admins\n---` — only `title` and `access` (a private page: "admins" or
 * "owner") are read; no YAML parser is involved.
 */
export function parseFrontMatter(text: string): {
  title: string | null;
  body: string;
  access: "admins" | "owner" | null;
} {
  const t = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!t.startsWith("---\n")) return { title: null, body: t, access: null };
  const end = t.indexOf("\n---", 4);
  if (end < 0 || end > 8192) return { title: null, body: t, access: null };
  let title: string | null = null;
  let access: "admins" | "owner" | null = null;
  for (const line of t.slice(4, end).split("\n")) {
    const a = /^access:\s*"?(admins|owner)"?\s*$/.exec(line);
    if (a) access = a[1] as "admins" | "owner";
    const m = /^title:\s*(.*)$/.exec(line);
    if (!m) continue;
    const v = m[1].trim();
    if (v.startsWith('"')) {
      try {
        const p = JSON.parse(v);
        if (typeof p === "string") title = p;
      } catch {
        /* ignore */
      }
    } else title = v.replace(/^'(.*)'$/, "$1");
  }
  const rest = t.slice(end + 4).replace(/^[^\n]*\n/, "");
  return { title: title?.trim() || null, body: rest.replace(/^\n+/, ""), access };
}

/** A page as a Markdown file; `access` 1/2 marks a private page (kept when the file is imported again). */
export const toMarkdownFile = (title: string, content: string, access = 0) =>
  `---\ntitle: ${JSON.stringify(title)}\n${access === 1 ? "access: admins\n" : access === 2 ? "access: owner\n" : ""}---\n\n${content.replace(/\r\n?/g, "\n")}${content.endsWith("\n") ? "" : "\n"}`;
