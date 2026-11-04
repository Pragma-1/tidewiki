import Link from "next/link";
import { Shell } from "@/components/shell";
import { getT } from "@/lib/i18n-server";
export default async function NotFound() {
  const t = await getT();
  return (
    <Shell live={false}>
      <div className="auth">
        <h1>{t("Page not found")}</h1>
        <p className="lead">{t("This page doesn’t exist, or it was moved or deleted.")}</p>
        <Link className="btn" href="/">
          {t("Back to the start")}
        </Link>
      </div>
    </Shell>
  );
}
