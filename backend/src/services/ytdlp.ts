import { execFile } from "child_process";
import { logger } from "../utils/logger";
import { requireMusicLink, MusicPlatform } from "./musicLink";

interface YtDlpTrack {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  duration: number | null;
  url: string;
  thumbnailUrl: string | null;
  hasNativeMetadata: boolean;
}

export interface YtDlpPlaylist {
  id: string;
  title: string;
  uploader: string | null;
  tracks: YtDlpTrack[];
  platform: string;
}

function parseArtistTitle(
  rawTitle: string,
  uploader: string | null,
): { title: string; artist: string } {
  // Many YouTube videos use "Artist - Title" format
  const dashMatch = rawTitle.match(/^(.+?)\s*[-–—]\s*(.+)$/);
  if (dashMatch) {
    return { artist: dashMatch[1].trim(), title: dashMatch[2].trim() };
  }

  // Fall back to uploader as artist (strip " - Topic" suffix from YouTube Music auto-channels)
  const artist = uploader
    ? uploader.replace(/\s*-\s*Topic$/i, "").trim()
    : "Unknown Artist";
  return { artist, title: rawTitle.trim() };
}

const PLATFORM_LABELS: Partial<Record<MusicPlatform, string>> = {
  youtubeMusic: "YouTube Music",
  youtube: "YouTube",
  soundcloud: "SoundCloud",
  mixcloud: "Mixcloud",
};

function platformLabel(platform: MusicPlatform): string {
  return PLATFORM_LABELS[platform] || "External";
}

function runYtDlp(args: string[], timeoutMs = 300_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("yt-dlp", args, { maxBuffer: 50 * 1024 * 1024, timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        logger.warn(`[yt-dlp] stderr: ${stderr}`);
        if ((err as any).killed || (err as any).signal === "SIGTERM") {
          reject(new Error("Playlist extraction timed out. Try a smaller playlist."));
          return;
        }
        reject(new Error(`yt-dlp failed: ${err.message}`));
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * `--ies default,-generic` turns off yt-dlp's catch-all extractor, which would otherwise fetch any address it is given;
 * `--` makes the address a positional argument whatever it starts with.
 */
export function playlistArgs(url: string): string[] {
  return [
    "--flat-playlist",
    "--dump-json",
    "--no-warnings",
    "--extractor-args", "youtube:lang=en",
    "--ies", "default,-generic",
    "--",
    url,
  ];
}

export async function extractPlaylist(address: string): Promise<YtDlpPlaylist> {
  const link = requireMusicLink(address);
  const stdout = await runYtDlp(playlistArgs(link.url));

  const lines = stdout.trim().split("\n").filter(Boolean);
  if (lines.length === 0) {
    throw new Error("yt-dlp returned no results");
  }

  const entries = lines
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);

  const firstEntry = entries[0];
  const playlistTitle =
    firstEntry._playlist_title ||
    firstEntry.playlist_title ||
    firstEntry.playlist ||
    platformLabel(link.platform) + " Playlist";

  const playlistId =
    firstEntry._playlist_id ||
    firstEntry.playlist_id ||
    `ytdlp-${Date.now()}`;

  const platform = platformLabel(link.platform);

  const tracks: YtDlpTrack[] = entries.map((entry: any) => {
    const rawTitle = entry.title || entry.fulltitle || "Unknown";
    const uploader = entry.uploader || entry.channel || entry.artist || null;
    const { artist, title } = parseArtistTitle(rawTitle, uploader);
    const hasNativeMetadata = !!(entry.artist || entry.track || entry.album);

    return {
      id: entry.id || entry.url || `${Date.now()}`,
      title: entry.track || title,
      artist: entry.artist || artist,
      album: entry.album || null,
      duration: entry.duration ? Math.round(entry.duration * 1000) : null,
      url: entry.url && entry.url.startsWith("http")
        ? entry.url
        : entry.webpage_url || `https://www.youtube.com/watch?v=${entry.id}`,
      thumbnailUrl: entry.thumbnail || entry.thumbnails?.[0]?.url || null,
      hasNativeMetadata,
    };
  });

  logger.info(`[yt-dlp] Extracted ${tracks.length} tracks from ${platform} playlist "${playlistTitle}"`);

  return {
    id: playlistId,
    title: playlistTitle,
    uploader: firstEntry.playlist_uploader || firstEntry.uploader || null,
    tracks,
    platform,
  };
}
