/**
 * Reading what a person pasted or uploaded into a list of songs, before any of it is matched to the library. A music
 * link is read by the adapter for its site (Spotify, Deezer, or any other supported site through song.link and yt-dlp);
 * an M3U file by its own parser. Each answers with the same thing, the songs in the source's order.
 */
import pLimit from "p-limit";
import { SpotifyTrack, spotifyService } from "../spotify";
import { deezerService } from "../deezer";
import { trackIdentityService } from "../trackIdentity";
import { extractPlaylist as ytdlpExtractPlaylist } from "../ytdlp";
import { withRetry } from "../../utils/async";
import { logger } from "../../utils/logger";
import type { MusicLink } from "../musicLink";
import type { Tracklist } from "./types";

/** Where a read has got to, for the screen that is waiting on it. */
export type ReadStage = "resolving" | "matching";

export interface ReadHooks {
  /** Songs fetched so far, for the sources that fetch in pages. */
  onFetchProgress?: (fetched: number, total: number) => void;
  /** The source is read and its songs are about to be matched ("matching"), or a source with no list of its own is being worked out ("resolving"). */
  onStage?: (stage: ReadStage) => void;
}

const deezerPlaylistId = (url: string): string | null => url.match(/playlist[\/:](\d+)/)?.[1] ?? null;

/** The name a link's playlist carries at its source, for the sites where a lookup for the name alone is cheap. */
export async function musicLinkName(link: MusicLink): Promise<string | undefined> {
  if (link.platform === "deezer") {
    const id = deezerPlaylistId(link.url);
    return id ? ((await deezerService.getPlaylistName(id)) ?? undefined) : undefined;
  }
  if (link.platform === "spotify") return (await spotifyService.getPlaylistName(link.url)) ?? undefined;
  return undefined;
}

/** The songs a music link holds, in the source's order. Throws a message fit to show when the link cannot be read. */
export async function readMusicLink(link: MusicLink, hooks: ReadHooks = {}): Promise<Tracklist> {
  switch (link.platform) {
    case "spotify":
      return readSpotify(link.url, hooks);
    case "deezer":
      return readDeezer(link.url, hooks);
    default:
      hooks.onStage?.("resolving");
      return readExternal(link);
  }
}

async function readSpotify(url: string, hooks: ReadHooks): Promise<Tracklist> {
  const playlist = await spotifyService.getPlaylist(url, hooks.onFetchProgress);
  if (!playlist) {
    throw new Error("Could not fetch playlist from Spotify. Make sure it's a valid public playlist URL.");
  }
  hooks.onStage?.("matching");
  return {
    tracks: playlist.tracks,
    playlist: {
      id: playlist.id,
      name: playlist.name,
      description: playlist.description,
      owner: playlist.owner,
      imageUrl: playlist.imageUrl,
      trackCount: playlist.trackCount,
    },
    source: "Spotify",
  };
}

async function readDeezer(url: string, hooks: ReadHooks): Promise<Tracklist> {
  const id = deezerPlaylistId(url);
  if (!id) throw new Error("Invalid Deezer playlist URL");
  const deezerPlaylist = await withRetry(() => deezerService.getPlaylist(id, hooks.onFetchProgress));
  if (!deezerPlaylist) throw new Error("Deezer playlist not found");
  hooks.onStage?.("matching");

  const tracks: SpotifyTrack[] = deezerPlaylist.tracks.map((track: any, index: number) => ({
    spotifyId: track.deezerId,
    title: track.title,
    artist: track.artist,
    artistId: track.artistId || "",
    album: track.album || "Unknown Album",
    albumId: track.albumId || "",
    isrc: null,
    durationMs: track.durationMs,
    trackNumber: track.trackNumber || index + 1,
    previewUrl: track.previewUrl || null,
    coverUrl: track.coverUrl || deezerPlaylist.imageUrl || null,
  }));

  return {
    tracks,
    playlist: {
      id: deezerPlaylist.id,
      name: deezerPlaylist.title,
      description: deezerPlaylist.description || null,
      owner: deezerPlaylist.creator || "Deezer",
      imageUrl: deezerPlaylist.imageUrl || null,
      trackCount: deezerPlaylist.trackCount || tracks.length,
    },
    source: "Deezer",
  };
}

async function readExternal(link: MusicLink): Promise<Tracklist> {
  const { platform, url } = link;

  const isSingleTrack = !isPlaylistLink(link);
  if (isSingleTrack) {
    const resolved = await trackIdentityService.resolveUrl(url);
    if (!resolved) {
      throw new Error(`Could not resolve track from ${platform} URL`);
    }

    const track: SpotifyTrack = {
      spotifyId: resolved.spotifyId || `ext-${Date.now()}`,
      title: resolved.title,
      artist: resolved.artist,
      artistId: "",
      album: resolved.album || "Unknown Album",
      albumId: "",
      isrc: resolved.isrc,
      durationMs: 0,
      trackNumber: 1,
      previewUrl: null,
      coverUrl: resolved.coverUrl,
    };

    return {
      tracks: [track],
      playlist: {
        id: `external-${Date.now()}`,
        name: `${platform} import`,
        description: null,
        owner: "",
        imageUrl: resolved.coverUrl || null,
        trackCount: 1,
      },
      source: platform,
    };
  }

  return readYtDlpPlaylist(url);
}

function isPlaylistLink({ platform, url }: MusicLink): boolean {
  const parsed = new URL(url);
  switch (platform) {
    case "youtube":
      return parsed.searchParams.has("list");
    case "youtubeMusic":
      return parsed.searchParams.has("list") || parsed.pathname.includes("/playlist");
    case "soundcloud":
      return parsed.pathname.includes("/sets/");
    case "mixcloud":
      return parsed.pathname.includes("/playlist/");
    default:
      return false;
  }
}

async function readYtDlpPlaylist(url: string): Promise<Tracklist> {
  const playlist = await ytdlpExtractPlaylist(url);

  if (playlist.tracks.length === 0) {
    throw new Error(`No tracks found in ${playlist.platform} playlist`);
  }

  const resolvedTracks: SpotifyTrack[] = [];
  const tracksNeedingSongLink = playlist.tracks.filter((t) => !t.hasNativeMetadata);
  const limit = pLimit(3);

  logger.info(
    `[yt-dlp] ${playlist.tracks.length} tracks total, ${tracksNeedingSongLink.length} need song.link resolution`,
  );

  await Promise.all(
    playlist.tracks.map((track, idx) =>
      limit(async () => {
        const coverUrl: string | null = track.thumbnailUrl;

        if (!track.hasNativeMetadata) {
          try {
            const resolved = await Promise.race([
              trackIdentityService.resolveUrl(track.url),
              new Promise<null>((resolve) => setTimeout(() => resolve(null), 8_000)),
            ]);
            if (resolved?.title && resolved?.artist) {
              resolvedTracks.push({
                spotifyId: resolved.spotifyId || `ext-${playlist.id}-${idx}`,
                title: resolved.title,
                artist: resolved.artist,
                artistId: "",
                album: resolved.album || track.album || "Unknown Album",
                albumId: "",
                isrc: resolved.isrc || null,
                durationMs: track.duration || 0,
                trackNumber: idx + 1,
                previewUrl: null,
                coverUrl: resolved.coverUrl || coverUrl,
              });
              return;
            }
          } catch {
            // song.link could not resolve it; fall back to yt-dlp's own metadata below
          }
        }

        resolvedTracks.push({
          spotifyId: `ext-${playlist.id}-${idx}`,
          title: track.title,
          artist: track.artist,
          artistId: "",
          album: track.album || "Unknown Album",
          albumId: "",
          isrc: null,
          durationMs: track.duration || 0,
          trackNumber: idx + 1,
          previewUrl: null,
          coverUrl,
        });
      }),
    ),
  );

  resolvedTracks.sort((a, b) => a.trackNumber - b.trackNumber);

  if (resolvedTracks.length === 0) {
    throw new Error(`Could not resolve any tracks from ${playlist.platform} playlist`);
  }

  return {
    tracks: resolvedTracks,
    playlist: {
      id: playlist.id,
      name: playlist.title,
      description: null,
      owner: playlist.uploader || "",
      imageUrl: resolvedTracks[0]?.coverUrl || null,
      trackCount: resolvedTracks.length,
    },
    source: playlist.platform,
  };
}



export interface M3UEntry {
    filePath: string;
    artist: string | null;
    title: string | null;
    durationSeconds: number | null;
}

/** An M3U import in which no entry matched a playable song in the library: it makes no playlist. */
export class M3UNothingMatched extends Error {
    constructor(readonly total: number) {
        super(`none of the ${total} ${total === 1 ? "entry" : "entries"} in this file matched a song in your library`);
        this.name = "M3UNothingMatched";
    }
}

/** An M3U file with a null byte in it: not a text playlist. */
export class M3UContainsNullBytes extends Error {
    constructor() {
        super("M3U content contains null bytes");
        this.name = "M3UContainsNullBytes";
    }
}

/** An M3U file with more entries than a playlist may hold. */
export class M3UTooManyEntries extends Error {
    constructor(readonly maxEntries: number) {
        super(`M3U file exceeds maximum of ${maxEntries} entries`);
        this.name = "M3UTooManyEntries";
    }
}

interface ParseOptions {
    maxEntries?: number;
}

export function parseM3U(content: string, options: ParseOptions = {}): M3UEntry[] {
    const { maxEntries = 10000 } = options;

    if (content.includes("\0")) {
        throw new M3UContainsNullBytes();
    }

    const lines = content.replace(/\r\n/g, "\n").split("\n");
    const entries: M3UEntry[] = [];
    let pendingMeta: { artist: string | null; title: string | null; duration: number | null } | null = null;

    for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;

        if (line === "#EXTM3U") continue;

        if (line.startsWith("#EXTINF:")) {
            const afterHash = line.slice(8);
            const commaIdx = afterHash.indexOf(",");
            if (commaIdx === -1) continue;

            const duration = parseInt(afterHash.slice(0, commaIdx), 10);
            const display = afterHash.slice(commaIdx + 1).trim();

            const sepIdx = display.indexOf(" - ");
            if (sepIdx > 0) {
                pendingMeta = {
                    artist: display.slice(0, sepIdx).trim(),
                    title: display.slice(sepIdx + 3).trim(),
                    duration: isNaN(duration) ? null : duration,
                };
            } else {
                pendingMeta = { artist: null, title: display || null, duration: isNaN(duration) ? null : duration };
            }
            continue;
        }

        if (line.startsWith("#")) continue;

        const filePath = line.replace(/\\/g, "/");

        entries.push({
            filePath,
            artist: pendingMeta?.artist ?? null,
            title: pendingMeta?.title ?? null,
            durationSeconds: pendingMeta?.duration ?? null,
        });
        pendingMeta = null;

        if (entries.length > maxEntries) {
            throw new M3UTooManyEntries(maxEntries);
        }
    }

    return entries;
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
const windows1252 = new TextDecoder("windows-1252");

/**
 * An uploaded playlist file's text, read the way `.m3u` and `.m3u8` files are read: as UTF-16 when it opens with a UTF-16
 * byte order mark (what Windows Notepad's "Unicode" saves), as UTF-8 when it opens with a UTF-8 byte order mark (dropped)
 * or is valid UTF-8, otherwise as Windows-1252, the "Latin-1" every player takes it for.
 */
export function decodeM3U(bytes: Buffer): string {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString("utf16le");
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return Buffer.from(bytes.subarray(2)).swap16().toString("utf16le");
    if (bytes.subarray(0, 3).equals(UTF8_BOM)) return bytes.subarray(3).toString("utf-8");
    try {
        return strictUtf8.decode(bytes);
    } catch {
        return windows1252.decode(bytes);
    }
}
