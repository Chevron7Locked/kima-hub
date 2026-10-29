import { existsSync } from "fs";
import { redisClient } from "../utils/redis";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { fpcalcService } from "./fpcalc";

// Analyzer script paths in the Docker image
const ESSENTIA_ANALYZER_PATH = "/app/audio-analyzer/analyzer.py";
const CLAP_ANALYZER_PATH = "/app/audio-analyzer-clap/analyzer.py";

interface AvailableFeatures {
    musicCNN: boolean;
    vibeEmbeddings: boolean;
    audiobookshelfEnabled: boolean;
    /** chromaprint fpcalc binary present — gates the AcoustID identity path. */
    fpcalc: boolean;
}

/** An analyzer whose heartbeat is older than this is not running. */
const HEARTBEAT_TTL = 300000;
const CACHE_TTL = 60000;

class FeatureDetectionService {
    private cache: AvailableFeatures | null = null;
    private lastCheck: number = 0;

    async getFeatures(): Promise<AvailableFeatures> {
        const now = Date.now();
        if (this.cache && now - this.lastCheck < CACHE_TTL) {
            return this.cache;
        }

        const [musicCNN, vibeEmbeddings, audiobookshelfEnabled, fpcalc] =
            await Promise.all([
                this.checkMusicCNN(),
                this.checkCLAP(),
                this.checkAudiobookshelf(),
                this.checkFpcalc(),
            ]);

        this.cache = { musicCNN, vibeEmbeddings, audiobookshelfEnabled, fpcalc };
        this.lastCheck = now;

        logger.debug(
            `[FEATURE-DETECTION] Features: musicCNN=${musicCNN}, vibeEmbeddings=${vibeEmbeddings}, audiobookshelf=${audiobookshelfEnabled}, fpcalc=${fpcalc}`
        );

        return this.cache;
    }

    private async workerAlive(heartbeatKey: string, withinMs = HEARTBEAT_TTL): Promise<boolean> {
        const heartbeat = await redisClient.get(heartbeatKey);
        if (!heartbeat) return false;
        const timestamp = parseInt(heartbeat, 10);
        return !isNaN(timestamp) && Date.now() - timestamp < withinMs;
    }

    /** The Essentia analyzer process is running now (its heartbeat is fresh), not merely installed. */
    async analyzerRunning(): Promise<boolean> {
        return this.workerAlive("audio:worker:heartbeat");
    }

    /** The CLAP analyzer process is running now (its heartbeat is younger than `withinMs`), not merely installed. */
    async clapRunning(withinMs = HEARTBEAT_TTL): Promise<boolean> {
        return this.workerAlive("clap:worker:heartbeat", withinMs);
    }

    private async checkMusicCNN(): Promise<boolean> {
        try {
            // The image ships the analyzer.
            if (existsSync(ESSENTIA_ANALYZER_PATH)) {
                return true;
            }

            if (await this.workerAlive("audio:worker:heartbeat")) return true;

            const trackWithEnergy = await prisma.track.findFirst({
                where: { energy: { not: null } },
                select: { id: true },
            });
            return trackWithEnergy !== null;
        } catch (error) {
            logger.error("[FEATURE-DETECTION] Error checking MusicCNN:", error);
            return false;
        }
    }

    private async checkCLAP(): Promise<boolean> {
        try {
            const disabled = process.env.DISABLE_CLAP;
            if (disabled === "true" || disabled === "1") {
                return false;
            }

            if (existsSync(CLAP_ANALYZER_PATH)) {
                return true;
            }

            if (await this.workerAlive("clap:worker:heartbeat")) return true;

            const embeddingCount = await prisma.trackEmbedding.count();
            return embeddingCount > 0;
        } catch (error) {
            logger.error("[FEATURE-DETECTION] Error checking CLAP:", error);
            return false;
        }
    }

    private async checkAudiobookshelf(): Promise<boolean> {
        try {
            const settings = await prisma.systemSettings.findUnique({
                where: { id: "default" },
                select: { audiobookshelfEnabled: true },
            });
            return settings?.audiobookshelfEnabled ?? false;
        } catch (error) {
            logger.error("[FEATURE-DETECTION] Error checking Audiobookshelf:", error);
            return false;
        }
    }

    /** fpcalc gates AcoustID fingerprinting; ACOUSTID_DISABLED=true counts as absent. Probed once per process. */
    private checkFpcalc(): Promise<boolean> {
        return fpcalcService.isAvailable();
    }
}

export const featureDetection = new FeatureDetectionService();
