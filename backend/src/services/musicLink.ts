export type MusicPlatform =
    | "youtubeMusic"
    | "youtube"
    | "spotify"
    | "deezer"
    | "appleMusic"
    | "tidal"
    | "soundcloud"
    | "mixcloud";

// music.youtube.com is listed before youtube.com so the more specific domain wins.
const SUPPORTED_DOMAINS: Array<[string, MusicPlatform]> = [
    ["music.youtube.com", "youtubeMusic"],
    ["youtube.com", "youtube"],
    ["youtu.be", "youtube"],
    ["spotify.com", "spotify"],
    ["deezer.com", "deezer"],
    ["music.apple.com", "appleMusic"],
    ["tidal.com", "tidal"],
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
