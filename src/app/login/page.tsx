import { redirect } from "next/navigation";
import { Shell } from "@/components/shell";
import { LoginForm } from "@/components/auth-forms";
import { gate } from "@/lib/guard";
import { getSettings } from "@/lib/settings";
import { getT } from "@/lib/i18n-server";
export const dynamic = "force-dynamic";
export async function generateMetadata() {
  return { title: (await getT())("Sign in") };
}

export default async function Login({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const user = await gate("none", { allowPending2fa: true });
  if (user) redirect("/");
  const cfg = getSettings();
  return (
    <Shell live={false}>
      <LoginForm
        next={(await searchParams).next}
        canRegister={cfg.allow_registration}
        canReset={cfg.allow_password_reset}
      />
    </Shell>
  );
}
