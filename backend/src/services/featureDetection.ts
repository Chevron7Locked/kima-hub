import { existsSync } from "fs";
import { redisClient } from "../utils/redis";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";

// Analyzer script paths in the Docker image
const ESSENTIA_ANALYZER_PATH = "/app/audio-analyzer/analyzer.py";
const CLAP_ANALYZER_PATH = "/app/audio-analyzer-clap/analyzer.py";

export interface AvailableFeatures {
    musicCNN: boolean;
    vibeEmbeddings: boolean;
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

        const [musicCNN, vibeEmbeddings] = await Promise.all([
            this.checkMusicCNN(),
            this.checkCLAP(),
        ]);

        this.cache = { musicCNN, vibeEmbeddings };
        this.lastCheck = now;

        logger.debug(
            `[FEATURE-DETECTION] Features: musicCNN=${musicCNN}, vibeEmbeddings=${vibeEmbeddings}`
        );

        return this.cache;
    }

    private async checkMusicCNN(): Promise<boolean> {
        try {
            // Analyzer script bundled in image = feature is available
            if (existsSync(ESSENTIA_ANALYZER_PATH)) {
                return true;
            }

            const heartbeat = await redisClient.get("audio:worker:heartbeat");
            if (heartbeat) {
                const timestamp = parseInt(heartbeat, 10);
                if (!isNaN(timestamp) && Date.now() - timestamp < HEARTBEAT_TTL) {
                    return true;
                }
            }

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

            const heartbeat = await redisClient.get("clap:worker:heartbeat");
            if (heartbeat) {
                const timestamp = parseInt(heartbeat, 10);
                if (!isNaN(timestamp) && Date.now() - timestamp < HEARTBEAT_TTL) {
                    return true;
                }
            }

            const embeddingCount = await prisma.trackEmbedding.count();
            return embeddingCount > 0;
        } catch (error) {
            logger.error("[FEATURE-DETECTION] Error checking CLAP:", error);
            return false;
        }
    }

    invalidateCache(): void {
        this.cache = null;
        this.lastCheck = 0;
    }
}

export const featureDetection = new FeatureDetectionService();
