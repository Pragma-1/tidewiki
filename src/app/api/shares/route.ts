import { api, json } from "@/lib/api";
import { audit } from "@/lib/audit";
import { levelOf } from "@/lib/access";
import { listShares, revokeAllShares } from "@/lib/shares";
export const dynamic = "force-dynamic";

/** Every working shared link of pages this administrator may see. */
export const GET = api("admin", async ({ user }) => json({ links: await listShares(levelOf(user)) }));

/** Revokes all of them at once. */
export const DELETE = api("admin", async ({ user, ip }) => {
  const n = await revokeAllShares(levelOf(user));
  if (n) await audit("page.share_revoked", user!.id, ip, `all (${n})`);
  return json({ revoked: n });
});
