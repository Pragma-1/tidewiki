import { db } from "@/lib/db";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    db().prepare("SELECT 1").get();
    return new Response("ok", { headers: { "Cache-Control": "no-store" } });
  } catch {
    return new Response("db error", { status: 503 });
  }
}
