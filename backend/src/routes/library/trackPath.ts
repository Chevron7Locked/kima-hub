// backend/src/routes/library/trackPath.ts
// Shared helper for resolving a Track's stored filePath against the music
// root, guarding against path traversal (e.g. filePath containing "../../").
import path from "path";
import { config } from "../../config";

/**
 * Resolve path segments to an absolute path under the music directory, or null
 * if the result would escape it.
 *
 * Use this for ANY filesystem path built from database values, and especially
 * before deleting one. Two different kinds of value end up here and both can
 * carry traversal:
 *
 *   - `Track.filePath`, written by the scanner from a real path on disk.
 *   - `Artist.name` and `Album.title`, which come from the file's OWN TAGS.
 *     Those are attacker-controlled in the only sense that matters here: adding
 *     a file to the watched folder is the normal way to use Kima, and an album
 *     tagged "../../../../tmp/x" is a path the delete routines would otherwise
 *     hand straight to `fs.rmSync(..., { recursive: true, force: true })`.
 *
 * Returns null for the music root itself, not just for paths outside it --
 * every caller wants something INSIDE the library, and "delete the music
 * directory" is never the intended answer.
 */
export function resolveWithinMusicRoot(...segments: string[]): string | null {
  // Backslashes are normalised because a Windows-scanned library stores them,
  // and `path.resolve` on posix would treat "..\\.." as one odd filename
  // rather than as traversal.
  const normalized = segments.map((s) => s.replace(/\\/g, "/"));
  const resolvedMusicPath = path.resolve(config.music.musicPath);
  const absolutePath = path.resolve(resolvedMusicPath, ...normalized);

  if (!absolutePath.startsWith(resolvedMusicPath + path.sep)) {
    return null;
  }

  return absolutePath;
}

/**
 * Resolve a track's stored `filePath` to an absolute path under the music
 * directory. Returns null if the resolved path would escape the music root.
 */
export function resolveTrackFilePath(filePath: string): string | null {
  return resolveWithinMusicRoot(filePath);
}
