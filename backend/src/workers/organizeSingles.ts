/**
 * Singles folder organisation: the one-time move of old Soulseek/ files into
 * Singles/Artist/Album/.
 */

import path from "path";
import { pathInMusicFolder } from "../utils/musicFolderPath";
import { readdir, copyFile, unlink, mkdir, rmdir, writeFile, stat, rename } from "fs/promises";
import { sessionLog } from "../utils/playlistLogger";
import { getSystemSettings } from "../utils/systemSettings";

/** Async existsSync equivalent -- avoids blocking the event loop on a stat check. */
async function pathExists(p: string): Promise<boolean> {
    try {
        await stat(p);
        return true;
    } catch {
        return false;
    }
}

/** True when the error means source and destination are on different volumes. */
function isCrossDevice(err: unknown): boolean {
    return (err as NodeJS.ErrnoException)?.code === "EXDEV";
}

/**
 * Move a file with no window where it exists in neither place: rename on one
 * volume; across volumes copy, check the size, then delete the original.
 */
async function moveFile(src: string, dest: string): Promise<void> {
    try {
        await rename(src, dest);
        return;
    } catch (err) {
        if (!isCrossDevice(err)) throw err;
    }
    await copyFile(src, dest);
    const expected = (await stat(src)).size;
    if ((await stat(dest)).size !== expected) {
        await unlink(dest).catch(() => {});
        throw new Error(`Copy of ${src} came up short — original kept`);
    }
    await unlink(src);
}

/**
 * Migrate existing files from Soulseek/ directory to Singles/Artist/Album/ structure
 * This is a one-time migration that runs on first organize after update
 */
async function migrateExistingSoulseekFiles(musicPath: string): Promise<void> {
    const soulseekDir = path.join(musicPath, "Soulseek");
    const migrationMarker = path.join(musicPath, ".soulseek-migrated");

    // Check if already migrated
    if (await pathExists(migrationMarker)) {
        return; // Already migrated
    }

    // Check if Soulseek directory exists
    if (!(await pathExists(soulseekDir))) {
        // No Soulseek folder, mark as migrated
        try {
            await writeFile(migrationMarker, new Date().toISOString());
        } catch (e) {
            // Ignore write errors
        }
        return;
    }

    sessionLog('ORGANIZE', '=== MIGRATING EXISTING SOULSEEK FILES TO SINGLES ===');

    const audioExtensions = new Set(['.mp3', '.flac', '.m4a', '.ogg', '.opus', '.wav', '.aac']);

    // Recursively find all audio files in Soulseek folder
    async function findAudioFiles(dir: string): Promise<string[]> {
        const files: string[] = [];
        try {
            const entries = await readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    files.push(...await findAudioFiles(fullPath));
                } else if (entry.isFile()) {
                    const ext = path.extname(entry.name).toLowerCase();
                    if (audioExtensions.has(ext)) {
                        files.push(fullPath);
                    }
                }
            }
        } catch (e) {
            // Ignore read errors
        }
        return files;
    }

    const audioFiles = await findAudioFiles(soulseekDir);

    if (audioFiles.length === 0) {
        sessionLog('ORGANIZE', 'No audio files found in Soulseek folder');
        try {
            await writeFile(migrationMarker, new Date().toISOString());
        } catch (e) {
            // Ignore
        }
        return;
    }

    sessionLog('ORGANIZE', `Found ${audioFiles.length} files to migrate`);

    let migrated = 0;
    let failed = 0;
    for (const filePath of audioFiles) {
        try {
            // Get relative path from Soulseek folder
            const relativePath = path.relative(soulseekDir, filePath);
            const parts = relativePath.split(path.sep);
            const filename = parts[parts.length - 1];

            // Parse folder structure to get artist/album
            let artist = "Unknown Artist";
            let album = "Unknown Album";

            if (parts.length > 1) {
                const folderName = parts[0];
                const dashIndex = folderName.indexOf(" - ");
                if (dashIndex > 0) {
                    artist = folderName.substring(0, dashIndex).trim();
                    let albumPart = folderName.substring(dashIndex + 3).trim();
                    albumPart = albumPart.replace(/\s*\(\d{4}\)\s*/g, " ").trim();
                    albumPart = albumPart.replace(/\s*[\[\{][^\]\}]*[\]\}]\s*/g, " ").trim();
                    albumPart = albumPart.replace(/\s*CDDA\s*/gi, " ").trim();
                    album = albumPart || "Unknown Album";
                } else {
                    album = folderName;
                }
            }

            const destDir = pathInMusicFolder(musicPath, "Singles", artist, album);
            const destFile = path.join(destDir, filename);

            // Skip if destination already exists
            if (await pathExists(destFile)) {
                continue;
            }

            // Create destination directory (idempotent - won't fail if exists)
            try {
                await mkdir(destDir, { recursive: true });
            } catch (err: any) {
                sessionLog('ORGANIZE', `Failed to create directory ${destDir}: ${err.message}`, 'WARN');
                failed++; // marker stays unwritten so this file is retried
                continue; // Skip this file, try next
            }

            // Move file with verification (rename, or copy → verify → unlink).
            await moveFile(filePath, destFile);
            migrated++;

            sessionLog('ORGANIZE', `Migrated: ${filename} -> Singles/${artist}/${album}/`);
        } catch (err: any) {
            sessionLog('ORGANIZE', `Failed to migrate ${filePath}: ${err.message}`, 'WARN');
            failed++; // marker stays unwritten so this file is retried
        }
    }

    // Clean up empty directories in Soulseek folder
    try {
        const cleanEmptyDirs = async (dir: string): Promise<void> => {
            const entries = await readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    await cleanEmptyDirs(path.join(dir, entry.name));
                }
            }
            // Check if directory is now empty
            if ((await readdir(dir)).length === 0 && dir !== soulseekDir) {
                await rmdir(dir);
            }
        };
        await cleanEmptyDirs(soulseekDir);

        // Remove Soulseek folder if empty
        if ((await readdir(soulseekDir)).length === 0) {
            await rmdir(soulseekDir);
            sessionLog('ORGANIZE', 'Removed empty Soulseek folder');
        }
    } catch (e) {
        // Ignore cleanup errors
    }

    // Write the completion marker only when nothing failed, so the next run
    // retries what is left (moved files skip on the destination check).
    if (failed === 0) {
        try {
            await writeFile(migrationMarker, new Date().toISOString());
        } catch (e) {
            // Ignore
        }
        sessionLog('ORGANIZE', `Migration complete: ${migrated}/${audioFiles.length} files moved to Singles`);
    } else {
        sessionLog(
            'ORGANIZE',
            `Migration incomplete: ${migrated} moved, ${failed} failed — next organize will retry the rest`,
            'WARN',
        );
    }
}

/**
 * Move files from the old Soulseek/ folder into Singles/Artist/Album/.
 */
export async function organizeSingles(): Promise<void> {
    sessionLog('ORGANIZE', '=== STARTING SINGLES ORGANIZATION ===');

    // The music folder comes from the settings row, like every download writer, never from env.
    const settings = await getSystemSettings();
    const musicPath = settings?.musicPath;

    if (!musicPath) {
        const error = "Music path is not configured — set it on the Settings page.";
        sessionLog('ORGANIZE', error, 'ERROR');
        throw new Error(error);
    }

    sessionLog('ORGANIZE', `Music path: ${musicPath.replace(/\\/g, "/")}`);

    // Run one-time migration of existing Soulseek files
    await migrateExistingSoulseekFiles(musicPath);

    sessionLog('ORGANIZE', '=== ORGANIZATION COMPLETE ===');
}

