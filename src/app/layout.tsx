import type { Metadata, Viewport } from "next";
import { cookies, headers } from "next/headers";
import "@fontsource-variable/inter/opsz.css";
import "@fontsource-variable/inter/opsz-italic.css";
import "@fontsource-variable/jetbrains-mono";
import "./globals.css";
import { getSettings } from "@/lib/settings";
import { getLang } from "@/lib/i18n-server";
import { serverTimeZone, translate } from "@/lib/i18n";
import { LangProvider } from "@/components/i18n";
import { appearanceFrom, checkCustomCss, DEVICE_SCRIPT, fontHref, themeCss } from "@/lib/appearance";

/** The browser's toolbar follows the header band (Darstellung). */
export async function generateViewport(): Promise<Viewport> {
  const a = appearanceFrom((await getSettings()).appearance);
  return {
    width: "device-width",
    initialScale: 1,
    themeColor: [
      { media: "(prefers-color-scheme: light)", color: a.band.light || "#2a2f36" },
      { media: "(prefers-color-scheme: dark)", color: a.band.dark || "#121418" },
    ],
  };
}
export async function generateMetadata(): Promise<Metadata> {
  const name = (await getSettings()).site_name;
  return {
    title: { default: name, template: `%s · ${name}` },
    description: translate(await getLang(), "A self-hosted wiki."),
    robots: { index: false },
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const chosen = (await cookies()).get("theme")?.value;
  const lang = await getLang();
  const cfg = await getSettings();
  const look = appearanceFrom(cfg.appearance);
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  // this browser's choice (sun/moon button), else the wiki's default theme, else the device's
  const theme = chosen === "dark" || chosen === "light" ? chosen : look.theme !== "system" ? look.theme : undefined;
  const font = fontHref(look.font);
  // checked again on the way out: a value from a restored backup never skips the rules
  return (
    <html lang={lang} data-theme={theme} suppressHydrationWarning>
      <head>
        {/* screen factor for the automatic size, and this device's own size — before the first paint */}
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: DEVICE_SCRIPT }} />
        {font && <link id="tw-font" rel="stylesheet" href={font} />}
        <style
          id="tw-theme"
          dangerouslySetInnerHTML={{ __html: themeCss(look, checkCustomCss(cfg.custom_css) ? "" : cfg.custom_css) }}
        />
      </head>
      <body>
        <LangProvider lang={lang} tz={serverTimeZone()}>
          {children}
        </LangProvider>
      </body>
    </html>
  );
}
