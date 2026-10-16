import { existsSync } from "fs";
import { redisClient } from "../utils/redis";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { fpcalcPresent } from "./fpcalc";

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

const HEARTBEAT_TTL = 300000; // 5 minutes
const CACHE_TTL = 60000; // 60 seconds

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

    private async workerAlive(heartbeatKey: string): Promise<boolean> {
        const heartbeat = await redisClient.get(heartbeatKey);
        if (!heartbeat) return false;
        const timestamp = parseInt(heartbeat, 10);
        return !isNaN(timestamp) && Date.now() - timestamp < HEARTBEAT_TTL;
    }

    /** The Essentia analyzer process is running now (its heartbeat is fresh), not merely installed. */
    async analyzerRunning(): Promise<boolean> {
        return this.workerAlive("audio:worker:heartbeat");
    }

    /** The CLAP analyzer process is running now (its heartbeat is fresh), not merely installed. */
    async clapRunning(): Promise<boolean> {
        return this.workerAlive("clap:worker:heartbeat");
    }

    private async checkMusicCNN(): Promise<boolean> {
        try {
            // Analyzer script bundled in image = feature is available
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
            // If explicitly disabled via env var, CLAP is not available
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

    /**
     * fpcalc gates the AcoustID fingerprint path; ACOUSTID_DISABLED=true turns it
     * off even when the binary exists. Probed once per process.
     */
    private checkFpcalc(): boolean {
        return fpcalcPresent();
    }

    invalidateCache(): void {
        this.cache = null;
        this.lastCheck = 0;
    }
}

export const featureDetection = new FeatureDetectionService();
