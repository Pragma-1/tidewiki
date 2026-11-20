import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { getSettings } from "./settings";
import { isLang, makeT, type Lang } from "./i18n";

/** A visitor's own choice (the DE/EN button in the header); without it the wiki's default language. */
export const LANG_COOKIE = "lang";

/**
 * The interface language for this request: the visitor's choice, else the language set under
 * Settings → General. Only the interface (and the built-in pages while nobody edited them) is
 * translated — pages people write stay as they were written.
 */
export async function getLang(): Promise<Lang> {
  const chosen = (await cookies()).get(LANG_COOKIE)?.value;
  if (isLang(chosen)) return chosen;
  return (await getSettings()).language;
}

/** The same for API routes (error messages, mails sent on the visitor's behalf). */
export async function langFromRequest(req: NextRequest): Promise<Lang> {
  const chosen = req.cookies.get(LANG_COOKIE)?.value;
  if (isLang(chosen)) return chosen;
  return (await getSettings()).language;
}

export async function getT() {
  return makeT(await getLang());
}
