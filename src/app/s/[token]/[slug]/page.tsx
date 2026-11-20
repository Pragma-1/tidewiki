import { ShareView, shareMetadata } from "@/components/share-view";
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ token: string; slug: string }> };
export async function generateMetadata({ params }: Props) {
  const { token, slug } = await params;
  return shareMetadata(token, slug);
}

/** A page inside a shared section (only pages the link covers; anything else is "not found"). */
export default async function SharedSubPage({ params }: Props) {
  const { token, slug } = await params;
  return <ShareView token={token} slug={slug} />;
}
