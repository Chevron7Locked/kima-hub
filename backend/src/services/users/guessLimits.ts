/**
 * Guess limits: caps on wrong tries at a secret, counted per thing being guessed and never per address, which a client
 * can forge. Counters live in memory: one backend process, and a restart resets them.
 */

import { createHash } from "crypto";
import { normalizeUsername } from "./accounts";

/** The tries taken so far at one secret, and when that count ends. */
interface Counter {
    tries: number;
    endsAt: number;
}

/** A fixed-size stand-in for a subject, so a counter's memory does not depend on how long a made-up username is. */
const fingerprint = (subject: string) => createHash("sha256").update(subject).digest("hex");

export class GuessLimit {
    private readonly windows = new Map<string, Counter>();
    private nextSweepAt = 0;

    constructor(
        private readonly max: number,
        private readonly windowMs: number,
    ) {}

    /** How many counters are held. */
    get size(): number {
        return this.windows.size;
    }

    /** Takes one try at `subject`, or answers false when none are left. */
    take(rawSubject: string): boolean {
        const subject = fingerprint(rawSubject);
        const now = Date.now();
        this.dropFinished(now);
        const current = this.windows.get(subject);
        if (!current || current.endsAt <= now) {
            this.windows.set(subject, { tries: 1, endsAt: now + this.windowMs });
            return true;
        }
        if (current.tries >= this.max) return false;
        current.tries++;
        return true;
    }

    /** Forgets counters whose window has ended, at most once per window, so the work stays small. */
    private dropFinished(now: number): void {
        if (now < this.nextSweepAt) return;
        this.nextSweepAt = now + this.windowMs;
        for (const [subject, counter] of this.windows) {
            if (counter.endsAt <= now) this.windows.delete(subject);
        }
    }

    /** The try turned out right, so it was no wrong guess. */
    giveBack(subject: string): void {
        const current = this.windows.get(fingerprint(subject));
        if (current && current.tries > 0) current.tries--;
    }
}

/**
 * What a password guess is counted against, built here for both sign-in surfaces. A typed name that reached an account
 * counts against that account, so every way of typing it shares one count and two accounts whose names trim alike keep
 * their own. A name that reached no account counts against the trimmed name, so guessing at a made-up name stays limited
 * and the reply gives nothing away. The two kinds of subject cannot be mistaken for each other.
 */
export const passwordGuessSubject = (typedName: string, account: { id: string } | null): string =>
    account ? `account:${account.id}` : `name:${normalizeUsername(typedName)}`;

const FIFTEEN_MINUTES = 15 * 60 * 1000;

/** Passwords and two-factor codes at web login, per account. */
export const webLoginGuesses = new GuessLimit(20, FIFTEEN_MINUTES);

/** Passwords over Subsonic, per account: its own count, apart from web login. */
export const subsonicGuesses = new GuessLimit(20, FIFTEEN_MINUTES);
