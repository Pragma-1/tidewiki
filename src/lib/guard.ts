import { redirect } from "next/navigation";
import { getCurrentUser } from "./session-cookie";
import { getSettings } from "./settings";
import { userCount, type SessionUser } from "./auth";

type Need = "read" | "edit" | "admin" | "user" | "none";

/** Server-component gate. Every page declares what it needs; the checks can't be forgotten. */
export async function gate(need: Need, opts: { allowPending2fa?: boolean } = {}): Promise<SessionUser | null> {
  if ((await userCount()) === 0) redirect("/setup");
  const user = await getCurrentUser();
  if (user?.needs2faSetup && !opts.allowPending2fa) redirect("/account");
  if (need === "read" && !user && !(await getSettings()).public_read) redirect("/login");
  if (need !== "read" && need !== "none" && !user) redirect("/login");
  if (need === "edit" && user?.role === "viewer") redirect("/");
  if (need === "admin" && user?.role !== "admin") redirect("/");
  return user;
}

/**
 * The rule of gate("read") without redirecting — for generateMetadata, which Next renders next to
 * the page: a page title must not reach someone the page itself turns away.
 */
export async function mayRead(): Promise<boolean> {
  if ((await userCount()) === 0) return false;
  const user = await getCurrentUser();
  if (user) return !user.needs2faSetup;
  return (await getSettings()).public_read;
}
