#!/usr/bin/env ts-node
/**
 * Backfill Script: Populate originalYear for existing albums
 *
 * This script populates the new originalYear field for albums that don't have it yet.
 *
 * Strategy:
 * 1. For albums already enriched with MusicBrainz data, copy year to originalYear
 *    (since enrichment overwrites year with the original release date)
 * 2. Skip temporary albums (temp-* MBIDs)
 *
 * Usage:
 *   npx ts-node scripts/backfill-original-year.ts [--dry-run]
 *
 * Options:
 *   --dry-run    Show what would be updated without making changes
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function backfillOriginalYear(dryRun: boolean = false) {
    console.log("=== Backfill originalYear Script ===\n");
    console.log(
        `Mode: ${
            dryRun ? "DRY RUN (no changes)" : "LIVE (will update database)"
        }\n`
    );

    try {
        // Find albums that need backfilling
        const albumsToBackfill = await prisma.album.findMany({
            where: {
                originalYear: null,
                year: { not: null }, // Only albums that have a year value
                rgMbid: { not: { startsWith: "temp-" } }, // Skip temporary albums
            },
            select: {
                id: true,
                rgMbid: true,
                title: true,
                year: true,
                originalYear: true,
                artist: {
                    select: {
                        name: true,
                    },
                },
            },
        });

        console.log(`Found ${albumsToBackfill.length} albums to backfill\n`);

        if (albumsToBackfill.length === 0) {
            console.log("✓ No albums need backfilling. All done!");
            return;
        }

        // Show sample of albums to be updated
        console.log("Sample of albums to be updated:");
        albumsToBackfill.slice(0, 5).forEach((album, idx) => {
            console.log(
                `  ${idx + 1}. "${album.title}" by ${album.artist.name}`
            );
            console.log(
                `     Current: year=${album.year}, originalYear=${album.originalYear}`
            );
            console.log(`     Will set: originalYear=${album.year}\n`);
        });

        if (albumsToBackfill.length > 5) {
            console.log(
                `  ... and ${albumsToBackfill.length - 5} more albums\n`
            );
        }

        if (dryRun) {
            console.log(
                "DRY RUN: No changes made. Remove --dry-run to apply updates."
            );
            return;
        }

        // Confirm before proceeding in live mode
        console.log(
            `Proceeding with backfill of ${albumsToBackfill.length} albums...\n`
        );

        // Process in batches to avoid overwhelming the database
        const BATCH_SIZE = 100;
        let processed = 0;
        let updated = 0;

        for (let i = 0; i < albumsToBackfill.length; i += BATCH_SIZE) {
            const batch = albumsToBackfill.slice(i, i + BATCH_SIZE);

            // Update each album in the batch
            const updatePromises = batch.map((album) =>
                prisma.album.update({
                    where: { id: album.id },
                    data: { originalYear: album.year },
                })
            );

            await Promise.all(updatePromises);

            processed += batch.length;
            updated += batch.length;

            const progress = (
                (processed / albumsToBackfill.length) *
                100
            ).toFixed(1);
            console.log(
                `Progress: ${processed}/${albumsToBackfill.length} (${progress}%) albums updated`
            );
        }

        console.log(`\n✓ Backfill complete!`);
        console.log(`  - Total albums updated: ${updated}`);
        console.log(`  - Field populated: originalYear`);
        console.log(
            `\nNote: Future albums will have originalYear populated automatically during enrichment.`
        );
    } catch (error) {
        console.error("\n✗ Error during backfill:", error);
        throw error;
    } finally {
        await prisma.$disconnect();
    }
}

// Parse command line arguments
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");

// Run the backfill
backfillOriginalYear(dryRun)
    .then(() => {
        process.exit(0);
    })
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
