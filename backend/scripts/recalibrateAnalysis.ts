// backend/scripts/recalibrateAnalysis.ts
//
// One-time script to apply post-processing fixes to existing analyzed tracks:
// 1. NULL out acousticness (was dynamicRange proxy, CLAP zero-shot is now sole writer)
// 2. NULL out V/A + instrumentalness + speechiness for CLAP re-detection
// 3. Reset analysis + vibe status to trigger full re-analysis

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function recalibrate() {
    console.log("Starting batch recalibration of existing analyzed tracks...");

    // Fix 1: NULL out acousticness (was dynamicRange / 12 proxy, now CLAP zero-shot)
    const acousticResult = await prisma.$executeRaw`
        UPDATE "Track"
        SET acousticness = NULL
        WHERE "analysisStatus" = 'completed'
    `;
    console.log(`Acousticness cleared for CLAP re-detection: ${acousticResult} tracks`);

    // Fix 2: NULL out V/A and instrumentalness -- old values came from heuristic formula
    // (mood-weighted averages in [0,1] space) or broken MusiCNN voice_instrumental head.
    // Re-analysis will populate them from DEAM models with temperature scaling + CLAP vocal detection.
    const vaResult = await prisma.$executeRaw`
        UPDATE "Track"
        SET valence = NULL, arousal = NULL, instrumentalness = NULL, speechiness = NULL
        WHERE "analysisStatus" = 'completed'
    `;
    console.log(`Cleared V/A + instrumentalness for re-analysis: ${vaResult} tracks`);

    // Fix 3: Reset analysis status so full pipeline re-runs (mood post-processing, V/A, acousticness)
    const analysisResult = await prisma.$executeRaw`
        UPDATE "Track"
        SET "analysisStatus" = 'pending'
        WHERE "analysisStatus" = 'completed'
    `;
    console.log(`Analysis status reset for re-processing: ${analysisResult} tracks`);

    // Fix 4: Reset vibe analysis so CLAP vocal detection runs on all tracks
    const vibeResult = await prisma.$executeRaw`
        UPDATE "Track"
        SET "vibeAnalysisStatus" = 'pending'
        WHERE "vibeAnalysisStatus" = 'completed'
    `;
    console.log(`Vibe status reset for CLAP vocal detection: ${vibeResult} tracks`);

    // Fix 5: Delete existing embeddings so vibe phase re-queues all tracks
    const embedResult = await prisma.$executeRaw`
        DELETE FROM track_embeddings
    `;
    console.log(`Cleared ${embedResult} existing embeddings for re-generation`);

    console.log("Batch recalibration complete. Start the application to trigger re-enrichment.");
}

recalibrate()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
