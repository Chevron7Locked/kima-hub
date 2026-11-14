import type { Metadata } from "next";
import { headers } from "next/headers";
import { sharePreviewImage } from "@/lib/sharePreviewImage";
import SharePageClient from "./SharePageClient";
import { backendUrl } from "@/lib/backend-url";

interface Props {
    params: Promise<{ token: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
    const { token } = await params;
    try {
        const res = await fetch(`${backendUrl}/api/share/${encodeURIComponent(token)}`, {
            next: { revalidate: 0 },
        });
        if (!res.ok) return { title: "shared music - kima" };
        const data = await res.json();
        const title =
            data.entity?.name || data.entity?.title || "shared music";
        const artistName =
            data.entity?.artist?.name ||
            data.entity?.album?.artist?.name ||
            "kima";
        const image = sharePreviewImage(token, data.entity, await headers());
        return {
            title: `${title} - kima`.toLowerCase(),
            openGraph: {
                title: title.toLowerCase(),
                description: `by ${artistName} -- shared on kima`.toLowerCase(),
                images: image ? [{ url: image }] : [],
                type: "music.song",
                siteName: "kima",
            },
        };
    } catch {
        return { title: "shared music - kima" };
    }
}

export default function SharePage() {
    return <SharePageClient />;
}
