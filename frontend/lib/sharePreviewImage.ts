/* The preview image of a share link, for chat apps that fetch the Open Graph image themselves: an absolute address on
 * the host the link was opened on, through the share's own cover route (the same one SharePageClient uses, and the only
 * one that serves a cover to a stranger). A cover that route would refuse, or no cover at all, gives no image. */

interface ShareEntityCover {
    coverUrl?: string | null;
    album?: { coverUrl?: string | null } | null;
    items?: { track?: { album?: { coverUrl?: string | null } | null } | null }[] | null;
}

const first = (value: string | null) => value?.split(",")[0]?.trim() || "";

function origin(headers: Headers): string | null {
    // A host is a name or address with an optional port; anything else is not one and never reaches the image address.
    const isHost = (h: string) => /^([A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])(:\d{1,5})?$/.test(h);
    const host = [first(headers.get("x-forwarded-host")), first(headers.get("host"))].find(isHost);
    if (!host) return null;
    const proto = first(headers.get("x-forwarded-proto")).toLowerCase();
    return `${proto === "https" ? "https" : "http"}://${host}`;
}

export function sharePreviewImage(token: string, entity: ShareEntityCover | undefined, headers: Headers): string | null {
    const cover = entity?.coverUrl || entity?.album?.coverUrl || entity?.items?.[0]?.track?.album?.coverUrl;
    // The cover route serves stored covers only, as the share page itself does.
    if (!cover || !cover.startsWith("native:")) return null;
    const base = origin(headers);
    if (!base) return null;
    return `${base}/api/share/${encodeURIComponent(token)}/cover-art/${encodeURIComponent(cover)}?size=500`;
}
