/**
 * Who is logged in to Soulseek as the account: a marker in Redis, "process X since T".
 *
 * The Soulseek server lets one session in per account: a second login drops the first. The connection lock is held only
 * while a connect runs, so a process that waited for another's connect finds the lock free once that connect is over,
 * and the other process is by then logged in. Without the marker it would log in too and knock the other off, and the
 * two would take turns doing it. A process that waited reads the marker before it logs in itself.
 *
 * The marker is set after a login and removed when this process lets go of it, and only the process that set it
 * removes or renews it. It carries a short life that a heartbeat keeps renewing, so one left behind by a process that
 * died expires by itself. The one process holding the login is the only one that can search or download as the account:
 * there is no way for another process to route through it, so the others fail saying who holds it.
 */
import os from "os";
import { redisClient } from "../utils/redis";
import { logger } from "../utils/logger";
import { deleteIfToken, pexpireIfToken } from "../utils/tokenGuardedKey";

const DEFAULT_KEY = "soulseek:logged-in-by";

export interface LoginHolder {
    /** The process that is logged in. */
    by: string;
    /** When it logged in. */
    at: Date;
}

interface Options {
    /** The marker's Redis key. */
    key?: string;
    /** Names this process in the marker. */
    id?: string;
    /** How long the marker lives without a heartbeat, in ms. */
    ttlMs?: number;
    /** How often the marker is renewed while this process is logged in, in ms. */
    beatMs?: number;
}

export class SoulseekLogin {
    private readonly key: string;
    private readonly id: string;
    private readonly ttlMs: number;
    private readonly beatMs: number;
    private value: string | null = null;
    private beat: NodeJS.Timeout | null = null;

    constructor(options: Options = {}) {
        this.key = options.key ?? DEFAULT_KEY;
        this.id = options.id ?? `${os.hostname()}:${process.pid}`;
        this.ttlMs = options.ttlMs ?? 90_000;
        this.beatMs = options.beatMs ?? 30_000;
    }

    /** This process is logged in: say so, and keep saying so until `clear`. A Redis failure is logged, not thrown. */
    async mark(): Promise<void> {
        this.stopBeat();
        const value = `${this.id}|${new Date().toISOString()}`;
        this.value = value;
        try {
            await redisClient.set(this.key, value, "PX", this.ttlMs);
        } catch (error) {
            logger.warn(`[Soulseek] Could not record the login: ${(error as Error).message}`);
        }
        // Only a login that is still this one keeps beating: a clear or a newer mark may have come while the write ran.
        if (this.value !== value) return;
        this.beat = setInterval(() => {
            pexpireIfToken(redisClient, this.key, value, this.ttlMs).catch((error: Error) => {
                logger.warn(`[Soulseek] Could not renew the login marker: ${error.message}`);
            });
        }, this.beatMs);
        this.beat.unref();
    }

    /** This process is no longer logged in. Removes the marker only if it is still this login's own. */
    async clear(): Promise<void> {
        this.stopBeat();
        const value = this.value;
        this.value = null;
        if (value === null) return;
        try {
            await deleteIfToken(redisClient, this.key, value);
        } catch (error) {
            logger.warn(`[Soulseek] Could not remove the login marker: ${(error as Error).message}`);
        }
    }

    /** Another process's login, or null when none is recorded or the record is this process's own. Throws when Redis does. */
    async heldByOther(): Promise<LoginHolder | null> {
        const value = await redisClient.get(this.key);
        if (value === null) return null;
        const split = value.lastIndexOf("|");
        const by = split === -1 ? value : value.slice(0, split);
        const at = new Date(split === -1 ? NaN : value.slice(split + 1));
        if (by === this.id) return null;
        return { by, at };
    }

    private stopBeat(): void {
        if (this.beat) clearInterval(this.beat);
        this.beat = null;
    }
}

export const soulseekLogin = new SoulseekLogin();
