import { api, json } from "@/lib/api";
import { audit } from "@/lib/audit";
import { listMedia, mediaUsage, storeUpload } from "@/lib/media";
import { consume } from "@/lib/rate-limit";
import { HttpError } from "@/lib/validate";
export const dynamic = "force-dynamic";

export const GET = api("admin", async () => json({ files: listMedia(), ...mediaUsage() }));

// Raw request body = the file. Type is decided by the file's own bytes, never by headers or the name.
export const POST = api("editor", async ({ req, user, ip }) => {
  if (!consume(`upload:${user!.id}`, 60, 3600)) throw new HttpError(429, "Too many uploads. Try again later.");
  if (!req.body) throw new HttpError(400, "Empty request.");
  const declared = Number(req.headers.get("content-length") || 0);
  const m = await storeUpload(req.body, declared, req.nextUrl.searchParams.get("name"), user!.id);
  audit("media.uploaded", user!.id, ip, `${m.name} (${m.mime}, ${Math.round(m.size / 1024)} KB)`);
  return json({ url: `/media/${m.name}`, kind: m.kind, name: m.original_name }, 201);
});
