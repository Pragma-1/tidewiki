import { ShareView, shareMetadata } from "@/components/share-view";
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ token: string }> };
export async function generateMetadata({ params }: Props) {
  return shareMetadata((await params).token);
}

/** A shared link: the shared page, readable without an account. */
export default async function SharedPage({ params }: Props) {
  return <ShareView token={(await params).token} />;
}
