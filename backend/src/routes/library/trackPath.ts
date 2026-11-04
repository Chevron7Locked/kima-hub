// Shared helper for resolving a Track's stored filePath against the music
// root, guarding against path traversal (e.g. filePath containing "../../").
import fs from "fs";
import path from "path";
import { config } from "../../config";

/**
 * Join path segments under the music directory, or null if the result escapes
 * it or is the root itself. Use it for every path built from database values,
 * above all before deleting: artist and album names come from file tags, and a
 * tag like "../../tmp/x" would otherwise reach `fs.rmSync`.
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

/** What a listener is told when a delete would have to reach past the music folder. */
export const LINKED_OUT_REFUSAL =
  "This music is in a linked folder outside your music folder, so Kima can't delete it. Remove the link instead.";

/**
 * Whether a stored song's folder is behind a link leading out of the music folder. Deleting it would reach a file
 * outside the library, and keeping the file while dropping its row would only bring the song back on the next scan,
 * so the delete is refused whole. A song that is itself a link is fine: only the link goes. A folder that is no longer
 * there has nothing to delete; one that cannot be read is treated as leading out.
 */
export function isBehindLinkOut(filePath: string): boolean {
  const absolutePath = resolveWithinMusicRoot(filePath);
  if (!absolutePath) return false;
  try {
    const realRoot = fs.realpathSync(path.resolve(config.music.musicPath));
    const realFolder = fs.realpathSync(path.dirname(absolutePath));
    return realFolder !== realRoot && !realFolder.startsWith(realRoot + path.sep);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ENOENT";
  }
}
