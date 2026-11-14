/* The metadata of a share page (title, Open Graph card), read from the backend by the web server on behalf of a visitor
 * or a chat app. The visitor's forwarded address goes along, so the backend's per-address limits see the visitor and
 * not the web server. */

import type { Metadata } from "next";
import { backendUrl } from "@/lib/backend-url";
import { sharePreviewImage } from "@/lib/sharePreviewImage";

const FALLBACK: Metadata = { title: "shared music - kima" };

const OPEN_GRAPH_TYPE: Record<string, "music.album" | "music.playlist" | "music.song"> = {
    album: "music.album",
    playlist: "music.playlist",
    track: "music.song",
};

export async function shareMetadata(token: string, requestHeaders: Headers): Promise<Metadata> {
    try {
        const forwarded: Record<string, string> = {};
        const forwardedFor = requestHeaders.get("x-forwarded-for");
        if (forwardedFor) forwarded["x-forwarded-for"] = forwardedFor;
        const res = await fetch(`${backendUrl}/api/share/${encodeURIComponent(token)}`, {
            headers: forwarded,
            next: { revalidate: 0 },
        });
        if (!res.ok) return FALLBACK;
        const data = await res.json();
        const title = data.entity?.name || data.entity?.title || "shared music";
        const artistName = data.entity?.artist?.name || data.entity?.album?.artist?.name || "kima";
        const image = sharePreviewImage(token, data.entity, requestHeaders);
        return {
            title: `${title} - kima`.toLowerCase(),
            openGraph: {
                title: title.toLowerCase(),
                description: `by ${artistName} -- shared on kima`.toLowerCase(),
                images: image ? [{ url: image }] : [],
                type: OPEN_GRAPH_TYPE[data.entityType] ?? "music.song",
                siteName: "kima",
            },
        };
    } catch {
        return FALLBACK;
    }
}
