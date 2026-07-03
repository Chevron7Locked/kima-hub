// backend/src/routes/library/trackPath.ts
// Shared helper for resolving a Track's stored filePath against the music
// root, guarding against path traversal (e.g. filePath containing "../../").
import path from "path";
import { config } from "../../config";

/**
 * Resolve a track's stored `filePath` to an absolute path under the music
 * directory. Returns null if the resolved path would escape the music root.
 */
export function resolveTrackFilePath(filePath: string): string | null {
  const normalizedFilePath = filePath.replace(/\\/g, "/");
  const resolvedMusicPath = path.resolve(config.music.musicPath);
  const absolutePath = path.resolve(resolvedMusicPath, normalizedFilePath);

  if (!absolutePath.startsWith(resolvedMusicPath + path.sep)) {
    return null;
  }

  return absolutePath;
}
