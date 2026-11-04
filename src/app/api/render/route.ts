import { api, json } from "@/lib/api";
import { LIMITS } from "@/lib/config";
import { renderMarkdown } from "@/lib/markdown";
import { consume } from "@/lib/rate-limit";
import { HttpError, str } from "@/lib/validate";
import { getSettings } from "@/lib/settings";
export const dynamic = "force-dynamic";

// Live preview. Rendering happens on the server with the same sanitiser as published pages.
export const POST = api("editor", async ({ body, user, lang }) => {
  if (!consume(`render:${user!.id}`, 90, 60)) throw new HttpError(429, "Slow down a little.");
  const b = await body(LIMITS.pageBytes + 8192);
  return json(
    renderMarkdown(str(b.content, "Content", { max: LIMITS.pageBytes, optional: true, trim: false }), {
      lang,
      autoloadExternal: getSettings().external_media_autoload,
    }),
  );
});
