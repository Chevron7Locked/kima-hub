/**
 * Organization worker for Singles directory
 *
 * With direct soulseek-ts integration, downloads go straight to Singles/Artist/Album/
 * This file now only handles:
 * 1. One-time migration of existing Soulseek/ files to Singles/ structure
 * 2. Legacy slskd job cleanup (if any remain from before migration)
 */

import { logger } from "../utils/logger";
import path from "path";
import fs from "fs";
import { readdir, copyFile, unlink, mkdir, rmdir, writeFile, stat } from "fs/promises";
import { sessionLog } from "../utils/playlistLogger";
import { prisma } from "../utils/db";

/** Async existsSync equivalent -- avoids blocking the event loop on a stat check. */
async function pathExists(p: string): Promise<boolean> {
    try {
        await stat(p);
        return true;
    } catch {
        return false;
    }
}

/**
 * Migrate existing files from Soulseek/ directory to Singles/Artist/Album/ structure
 * This is a one-time migration that runs on first organize after update
 */
async function migrateExistingSoulseekFiles(musicPath: string): Promise<void> {
    const soulseekDir = path.join(musicPath, "Soulseek");
    const singlesDir = path.join(musicPath, "Singles");
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

            // Sanitize for filesystem
            const sanitize = (name: string) => name.replace(/[<>:"/\\|?*]/g, "_").trim();
            artist = sanitize(artist);
            album = sanitize(album);

            // Destination path
            const destDir = path.join(singlesDir, artist, album);
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
                continue; // Skip this file, try next
            }

            // Move file (copy then delete original)
            await copyFile(filePath, destFile);
            await unlink(filePath);
            migrated++;

            sessionLog('ORGANIZE', `Migrated: ${filename} -> Singles/${artist}/${album}/`);
        } catch (err: any) {
            sessionLog('ORGANIZE', `Failed to migrate ${filePath}: ${err.message}`, 'WARN');
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

    // Mark migration as complete
    try {
        await writeFile(migrationMarker, new Date().toISOString());
    } catch (e) {
        // Ignore
    }

    sessionLog('ORGANIZE', `Migration complete: ${migrated}/${audioFiles.length} files moved to Singles`);
}

/**
 * Clean up any legacy slskd download jobs that are stuck in processing
 * This handles the transition from slskd Docker sidecar to direct soulseek-ts
 */
async function cleanupLegacySlskdJobs(): Promise<void> {
    try {
        // Find any old slskd jobs that are still processing
        const legacyJobs = await prisma.downloadJob.findMany({
            where: {
                status: "processing",
                metadata: {
                    path: ["source"],
                    equals: "slskd",
                },
            },
        });

        if (legacyJobs.length > 0) {
            sessionLog('ORGANIZE', `Found ${legacyJobs.length} legacy slskd jobs to clean up`);

            for (const job of legacyJobs) {
                await prisma.downloadJob.update({
                    where: { id: job.id },
                    data: {
                        status: "failed",
                        error: "slskd integration replaced with direct soulseek-ts connection",
                        completedAt: new Date(),
                    },
                });
                sessionLog('ORGANIZE', `Marked legacy job ${job.id} (${job.subject}) as failed`);
            }
        }
    } catch (err: any) {
        sessionLog('ORGANIZE', `Failed to clean up legacy jobs: ${err.message}`, 'WARN');
    }
}

/**
 * Main organization function
 * With direct soulseek-ts, this mainly handles migration and cleanup
 */
export async function organizeSingles(): Promise<void> {
    sessionLog('ORGANIZE', '=== STARTING SINGLES ORGANIZATION ===');

    // Get music path from environment variable
    let musicPath = process.env.MUSIC_PATH;

    // If not in env, try reading from .env file in project root
    if (!musicPath) {
        try {
            const envPath = path.join(process.cwd(), "..", ".env");
            const envContent = fs.readFileSync(envPath, "utf-8");
            const match = envContent.match(/^MUSIC_PATH=(.+)$/m);
            if (match) {
                musicPath = match[1].trim().replace(/^["']|["']$/g, "");
            }
        } catch (error) {
            // .env file doesn't exist or can't be read
        }
    }

    if (!musicPath) {
        const error = "MUSIC_PATH is not set. Cannot organize downloads.";
        sessionLog('ORGANIZE', error, 'ERROR');
        throw new Error(error);
    }

    sessionLog('ORGANIZE', `Music path: ${musicPath.replace(/\\/g, "/")}`);

    // Run one-time migration of existing Soulseek files
    await migrateExistingSoulseekFiles(musicPath);

    // Clean up any legacy slskd jobs
    await cleanupLegacySlskdJobs();

    sessionLog('ORGANIZE', '=== ORGANIZATION COMPLETE ===');
}

