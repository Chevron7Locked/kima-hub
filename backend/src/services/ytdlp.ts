import { execFile } from "child_process";
import { logger } from "../utils/logger";

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

function detectPlatformFromUrl(url: string): string {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (hostname.includes("music.youtube.com")) return "YouTube Music";
    if (hostname.includes("youtube.com") || hostname.includes("youtu.be")) return "YouTube";
    if (hostname.includes("soundcloud.com")) return "SoundCloud";
    if (hostname.includes("bandcamp.com")) return "Bandcamp";
    if (hostname.includes("mixcloud.com")) return "Mixcloud";
    return "External";
  } catch {
    return "External";
  }
}

function runYtDlp(args: string[], timeoutMs = 300_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("yt-dlp", args, { maxBuffer: 50 * 1024 * 1024, timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        logger?.warn(`[yt-dlp] stderr: ${stderr}`);
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

export async function extractPlaylist(url: string): Promise<YtDlpPlaylist> {
  const stdout = await runYtDlp([
    "--flat-playlist",
    "--dump-json",
    "--no-warnings",
    "--extractor-args", "youtube:lang=en",
    url,
  ]);

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
    detectPlatformFromUrl(url) + " Playlist";

  const playlistId =
    firstEntry._playlist_id ||
    firstEntry.playlist_id ||
    `ytdlp-${Date.now()}`;

  const platform = detectPlatformFromUrl(url);

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

  logger?.info(`[yt-dlp] Extracted ${tracks.length} tracks from ${platform} playlist "${playlistTitle}"`);

  return {
    id: playlistId,
    title: playlistTitle,
    uploader: firstEntry.playlist_uploader || firstEntry.uploader || null,
    tracks,
    platform,
  };
}
