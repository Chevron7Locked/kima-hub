import * as fs from "fs";
import { logger } from "../utils/logger";
import * as path from "path";

/** Writes one log file per discovery playlist generation. */
class DiscoveryLogger {
    private logDir: string;
    private currentLogFile: string | null = null;
    private currentStream: fs.WriteStream | null = null;

    constructor() {
        this.logDir = process.env.NODE_ENV === "production"
            ? "/app/logs/discovery"
            : path.join(process.cwd(), "data", "logs", "discovery");
    }

    start(userId: string): string {
        if (!fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir, { recursive: true });
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const filename = `discovery-${timestamp}.log`;
        this.currentLogFile = path.join(this.logDir, filename);

        this.currentStream = fs.createWriteStream(this.currentLogFile, { flags: "a" });

        this.write("═".repeat(60));
        this.write(`DISCOVERY WEEKLY GENERATION LOG`);
        this.write(`Started: ${new Date().toISOString()}`);
        this.write(`User ID: ${userId}`);
        this.write("═".repeat(60));
        this.write("");

        return this.currentLogFile;
    }

    write(message: string, indent: number = 0): void {
        const prefix = "  ".repeat(indent);
        const timestamp = new Date().toISOString().split("T")[1].split(".")[0];
        const line = `[${timestamp}] ${prefix}${message}`;

        if (this.currentStream) {
            this.currentStream.write(line + "\n");
        }

        logger.debug(message);
    }

    section(title: string): void {
        this.write("");
        this.write("─".repeat(50));
        this.write(`> ${title}`);
        this.write("─".repeat(50));
    }

    success(message: string, indent: number = 0): void {
        this.write(`✓ ${message}`, indent);
    }

    error(message: string, indent: number = 0): void {
        this.write(`✗ ${message}`, indent);
    }

    warn(message: string, indent: number = 0): void {
        this.write(`[WARN] ${message}`, indent);
    }

    info(message: string, indent: number = 0): void {
        this.write(`ℹ ${message}`, indent);
    }

    table(data: Record<string, any>, indent: number = 1): void {
        for (const [key, value] of Object.entries(data)) {
            this.write(`${key}: ${value}`, indent);
        }
    }

    list(items: string[], indent: number = 1): void {
        for (const item of items) {
            this.write(`• ${item}`, indent);
        }
    }

    end(success: boolean, summary?: string): void {
        this.write("");
        this.write("═".repeat(60));
        this.write(`GENERATION ${success ? "COMPLETED" : "FAILED"}`);
        if (summary) {
            this.write(summary);
        }
        this.write(`Ended: ${new Date().toISOString()}`);
        this.write("═".repeat(60));

        if (this.currentStream) {
            this.currentStream.end();
            this.currentStream = null;
        }
    }

    /**
     * Get all log files (most recent first)
     */
    getAllLogs(): { filename: string; date: Date; size: number }[] {
        if (!fs.existsSync(this.logDir)) {
            return [];
        }

        return fs.readdirSync(this.logDir)
            .filter(f => f.startsWith("discovery-") && f.endsWith(".log"))
            .map(filename => {
                const filePath = path.join(this.logDir, filename);
                const stats = fs.statSync(filePath);
                return {
                    filename,
                    date: stats.mtime,
                    size: stats.size
                };
            })
            .sort((a, b) => b.date.getTime() - a.date.getTime());
    }

    /**
     * Clean up old logs (keep last N)
     */
    cleanup(keepCount: number = 20): number {
        const logs = this.getAllLogs();
        let deleted = 0;

        for (let i = keepCount; i < logs.length; i++) {
            const filePath = path.join(this.logDir, logs[i].filename);
            fs.unlinkSync(filePath);
            deleted++;
        }

        return deleted;
    }
}

export const discoveryLogger = new DiscoveryLogger();






