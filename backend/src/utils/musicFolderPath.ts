import path from "path";

/**
 * One folder or file name from a name someone else chose (a playlist's artist or album, a Soulseek peer's file name):
 * path separators, characters filesystems refuse and control characters become "_", and a name that is empty or only
 * dots ("." and ".." walk the tree) becomes "_". Anything else, leading dots included, is kept.
 */
export function safePathPart(name: string): string {
    // eslint-disable-next-line no-control-regex
    const cleaned = name.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim();
    return /^\.*$/.test(cleaned) ? "_" : cleaned;
}

/** The music folder joined with each name made safe; the result is always inside the music folder. */
export function pathInMusicFolder(musicPath: string, ...names: string[]): string {
    const root = path.resolve(musicPath);
    const full = path.join(root, ...names.map(safePathPart));
    if (!full.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) {
        throw new Error(`Download path escapes the music folder: ${full}`);
    }
    return full;
}
