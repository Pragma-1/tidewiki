import { api } from "@/lib/api";
import { serveMedia } from "@/lib/media-serve";
import { isPrivateMedia } from "@/lib/media";
import { levelOf } from "@/lib/access";
import { HttpError } from "@/lib/validate";
export const dynamic = "force-dynamic";

// Uploaded files. Same read permission as the wiki itself; a file that only private pages show is
// private like them (not found for everyone who can't see those pages).
export const GET = api<{ name: string }>(
  "public",
  async ({ params, req, user }) => {
    if (await isPrivateMedia(params.name, levelOf(user))) throw new HttpError(404, "File not found.");
    return serveMedia(params.name, req);
  },
  { readGate: true },
);
