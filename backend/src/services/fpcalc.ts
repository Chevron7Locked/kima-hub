import { execFile, execFileSync } from "child_process";
import { promisify } from "util";
import { logger } from "../utils/logger";

const execFileAsync = promisify(execFile);

/** fpcalc on a full-length track is fast (<1s typical) but be generous. */
const FPCALC_TIMEOUT_MS = 30000;

const PROBE_TIMEOUT_MS = 5000;

/**
 * Whether the fpcalc binary runs. ACOUSTID_DISABLED=true counts as absent, so
 * the feature list and the service agree on one answer.
 */
function fpcalcPresent(): boolean {
    if (process.env.ACOUSTID_DISABLED === "true") {
        return false;
    }
    try {
        execFileSync("fpcalc", ["-version"], { timeout: PROBE_TIMEOUT_MS });
        return true;
    } catch {
        return false;
    }
}

interface Fingerprint {
    duration: number;
    fingerprint: string;
}

/**
 * A real fpcalc failure. With `-ignore-errors` set, a non-zero exit cannot be
 * explained by a single damaged frame — it is a genuine failure of the run —
 * so the error carries the exit code and fpcalc's stderr text verbatim:
 * classifyFailure reads the message and routes the stage record accordingly.
 */
class FpcalcFailure extends Error {
    readonly exitCode: number;
    readonly stderr: string;

    constructor(filePath: string, exitCode: number, stderr: string) {
        super(
            `fpcalc exited with code ${exitCode} for ${filePath}` +
                (stderr.trim() ? `: ${stderr.trim()}` : ""),
        );
        this.name = "FpcalcFailure";
        this.exitCode = exitCode;
        this.stderr = stderr;
    }
}

/**
 * Runs `fpcalc` (Chromaprint) for AcoustID. The Docker image installs it; where
 * it is missing the AcoustID path is disabled rather than crashing the worker.
 * Availability is probed once.
 */
class FpcalcService {
    private available: boolean | null = null;

    /** True when the fpcalc binary exists and executes. Probed once. */
    async isAvailable(): Promise<boolean> {
        if (this.available !== null) return this.available;
        this.available = fpcalcPresent();
        if (!this.available && process.env.ACOUSTID_DISABLED !== "true") {
            logger.warn(
                "[fpcalc] chromaprint fpcalc binary not found — AcoustID identification disabled (install chromaprint or set ACOUSTID_DISABLED=true)"
            );
        }
        return this.available;
    }

    /**
     * Fingerprint an audio file; throws on any failure. Runs with `-ignore-errors`
     * so a bad frame is skipped rather than ending the run and truncating the
     * fingerprint, as the analyzer does. A non-zero exit is then a real failure,
     * and its stdout is not parsed.
     */
    async fingerprintFile(filePath: string): Promise<Fingerprint> {
        if (!(await this.isAvailable())) {
            throw new FpcalcFailure(filePath, -1, "fpcalc binary not available");
        }
        let stdout: string;
        try {
            ({ stdout } = await execFileAsync(
                "fpcalc",
                ["-json", "-ignore-errors", filePath],
                { timeout: FPCALC_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 }
            ));
        } catch (err: any) {
            // Failed exit: do not look at stdout. Report the exit code and
            // fpcalc's own stderr text so the failure is classifiable.
            logger.debug(
                `[fpcalc] Failed for ${filePath} (exit ${err?.code ?? -1}): ${err?.stderr ?? err?.message}`
            );
            throw new FpcalcFailure(
                filePath,
                typeof err?.code === "number" ? err.code : -1,
                typeof err?.stderr === "string" ? err.stderr : "",
            );
        }
        const parsed = JSON.parse(stdout) as {
            duration?: number;
            fingerprint?: string;
        };
        if (
            !parsed.fingerprint ||
            !Number.isFinite(parsed.duration) ||
            (parsed.duration ?? 0) <= 0
        ) {
            throw new FpcalcFailure(
                filePath,
                0,
                "incomplete fpcalc output (no fingerprint or duration)",
            );
        }
        return {
            duration: Math.round(parsed.duration as number),
            fingerprint: parsed.fingerprint,
        };
    }
}

export const fpcalcService = new FpcalcService();
