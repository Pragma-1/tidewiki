import { api, json } from "@/lib/api";
import { audit } from "@/lib/audit";
import { levelOf } from "@/lib/access";
import { revokeShare, shareId } from "@/lib/shares";
import { HttpError } from "@/lib/validate";
export const dynamic = "force-dynamic";

/** Revokes one link for good: whoever has it gets "not found" from now on. */
export const DELETE = api<{ id: string }>("admin", async ({ params, user, ip }) => {
  const s = await revokeShare(shareId(params.id), levelOf(user));
  if (!s) throw new HttpError(404, "This link doesn’t exist.");
  await audit("page.share_revoked", user!.id, ip, `${s.slug} #${s.id}`);
  return json({ ok: true });
});
