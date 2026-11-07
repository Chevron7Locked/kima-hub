export type MusicPlatform =
    | "youtubeMusic"
    | "youtube"
    | "spotify"
    | "deezer"
    | "soundcloud"
    | "mixcloud";

// music.youtube.com is listed before youtube.com so the more specific domain wins.
const SUPPORTED_DOMAINS: Array<[string, MusicPlatform]> = [
    ["music.youtube.com", "youtubeMusic"],
    ["youtube.com", "youtube"],
    ["youtu.be", "youtube"],
    ["spotify.com", "spotify"],
    ["deezer.com", "deezer"],
    ["soundcloud.com", "soundcloud"],
    ["mixcloud.com", "mixcloud"],
];

export interface MusicLink {
    platform: MusicPlatform;
    /** The supported domain the host matched, so a caller never needs a host test of its own. */
    domain: string;
    /** The address as parsed, which is the form every caller passes onward. */
    url: string;
}

export function recogniseMusicLink(raw: unknown): MusicLink | null {
    if (typeof raw !== "string") return null;
    let parsed: URL;
    try {
        parsed = new URL(raw);
    } catch {
        return null;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    const match = SUPPORTED_DOMAINS.find(([domain]) => parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`));
    return match ? { platform: match[1], domain: match[0], url: parsed.href } : null;
}

/** What a person is told when a music link was pasted without its scheme. */
export const FULL_LINK_MESSAGE = "Paste the full link, starting with https://";

/** True for text that would be a music link if it began with https://, such as `open.spotify.com/playlist/abc`. */
export function lacksLinkScheme(raw: unknown): boolean {
    if (typeof raw !== "string") return false;
    const text = raw.trim();
    // `spotify:playlist:abc` and `ftp://...` name a scheme; they are the wrong kind of link, not a missing one.
    if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return false;
    return recogniseMusicLink(`https://${text}`) !== null;
}

/** The address as a music link, or a thrown error naming why it is not one. */
export function requireMusicLink(raw: unknown): MusicLink {
    const link = recogniseMusicLink(raw);
    if (!link) throw new Error("Not a link to a supported music site");
    return link;
}
