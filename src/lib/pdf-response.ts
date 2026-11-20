import { pagePdf, type PdfPage } from "./pdf";
import type { Lang } from "./i18n";

/** "Größe & Maße" → "Grosse-Masse.pdf" for old clients; the real name goes in filename* (RFC 6266/5987). */
function disposition(title: string): string {
  const clean =
    title
      .replace(/[\u0000-\u001f\u007f"\\/:*?<>|]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "page";
  const ascii =
    clean
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/ß/g, "ss")
      .replace(/[^\x20-\x7e]/g, "")
      .replace(/[^A-Za-z0-9._ -]/g, "")
      .trim()
      .replace(/ /g, "-") || "page";
  return `attachment; filename="${ascii}.pdf"; filename*=UTF-8''${encodeURIComponent(`${clean}.pdf`)}`;
}

/** A page as a PDF download. */
export async function pdfResponse(page: PdfPage, opts: { lang: Lang; siteName: string; pageUrl: string }) {
  const pdf = await pagePdf(page, opts);
  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": disposition(page.title),
      "Content-Length": String(pdf.length),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      // a PDF opened in the browser is a document of its own: no scripts, no plug-ins, no framing
      "Content-Security-Policy": "default-src 'none'; sandbox; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
    },
  });
}
