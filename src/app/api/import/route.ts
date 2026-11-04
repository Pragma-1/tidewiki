import { rmSync } from "node:fs";
import { api, json } from "@/lib/api";
import { audit } from "@/lib/audit";
import { consume } from "@/lib/rate-limit";
import { importArchive, receiveUpload, type Conflict } from "@/lib/transfer";
import { HttpError } from "@/lib/validate";
export const dynamic = "force-dynamic";

let busy = false; // one import at a time

// Body = a .zip (wiki export or any folder of .md files) or a single .md file.
// mode=preview only reports what would happen; mode=apply writes, atomically.
export const POST = api("admin", async ({ req, user, ip, t }) => {
  const sp = req.nextUrl.searchParams;
  const apply = sp.get("mode") === "apply";
  const c = sp.get("conflict");
  const conflict: Conflict = c === "overwrite" || c === "copy" ? c : "skip";
  if (!req.body) throw new HttpError(400, "Empty request.");
  if (!consume(`import:${user!.id}`, 30, 3600)) throw new HttpError(429, "Slow down a little.");
  if (busy) throw new HttpError(409, "Another import is running. Try again in a moment.");
  busy = true;
  let file: string | null = null;
  try {
    file = await receiveUpload(req.body, Number(req.headers.get("content-length") || 0));
    const r = await importArchive(file, { apply, conflict, userId: user!.id, singleName: sp.get("name") ?? undefined });
    if (apply)
      audit(
        "admin.import",
        user!.id,
        ip,
        `${r.created} created, ${r.updated} updated, ${r.skipped} skipped, ${r.media} files`,
      );
    return json({ ...r, warnings: r.warnings.slice(0, 200).map((w) => t(w)) });
  } finally {
    busy = false;
    if (file) rmSync(file, { force: true });
  }
});
