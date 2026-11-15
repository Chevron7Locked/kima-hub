/**
 * Guess limits: caps on wrong tries at a secret, counted per thing being guessed and never per address, which a client
 * can forge. Counters live in memory: one backend process, and a restart resets them.
 *
 * The memory is bounded. A made-up name gets a counter like any other, so a flood of random names would otherwise grow
 * the map until its windows end. At most MAX_COUNTERS are held: when a new subject arrives and the map is full, finished
 * counters go first, then the oldest live one. Dropping the oldest live counter forgets that subject's wrong tries, which
 * is acceptable: a client sending enough new names to fill the map is a client in a loop, and the runaway limit on its
 * address still stops it. An account under attack keeps its count unless that many other subjects arrive after it within
 * one window. That holds where the address is trustworthy (behind a reverse proxy that sets it); on a direct LAN address
 * a client can forge it, and docs/security.md already says such access gets no per-person address limits.
 */

import { createHash } from "crypto";
import { normalizeUsername } from "./accounts";

/** The tries taken so far at one secret, and when that count ends. */
interface Counter {
    tries: number;
    endsAt: number;
}

/** One try taken at a subject, kept by the caller to hand back to the limit that gave it. It shows nothing of the count. */
export interface GuessTry {
    readonly __guessTry: never;
}

/** What a limit remembers of a try: which counter it was counted in, so a refund can tell whether that is still the one held. */
interface TryRecord {
    subject: string;
    counter: Counter;
    given: boolean;
}

/** Counters held per limit: far above the accounts a Kima server has, small enough to cost little memory. */
const MAX_COUNTERS = 10_000;

/** A fixed-size stand-in for a subject, so a counter's memory does not depend on how long a made-up username is. */
const fingerprint = (subject: string) => createHash("sha256").update(subject).digest("hex");

export class GuessLimit {
    /**
     * Kept in the order the windows began, which is the order they end, because every window is the same length and a
     * counter whose window restarts is moved to the back. So the front is always the oldest and the first to finish.
     */
    private readonly windows = new Map<string, Counter>();

    /** The tries this limit has handed out. Weak, so a try the caller drops costs nothing. */
    private readonly taken = new WeakMap<GuessTry, TryRecord>();

    private record(subject: string, counter: Counter): GuessTry {
        const attempt = Object.freeze({}) as GuessTry;
        this.taken.set(attempt, { subject, counter, given: false });
        return attempt;
    }

    constructor(
        private readonly max: number,
        private readonly windowMs: number,
        private readonly maxCounters: number = MAX_COUNTERS,
    ) {}

    /** How many counters are held. */
    get size(): number {
        return this.windows.size;
    }

    /** Takes one try at `subject` and answers it, or answers null when none are left. */
    take(rawSubject: string): GuessTry | null {
        const subject = fingerprint(rawSubject);
        const now = Date.now();
        const current = this.windows.get(subject);
        if (current && current.endsAt > now) {
            if (current.tries >= this.max) return null;
            current.tries++;
            return this.record(subject, current);
        }
        this.windows.delete(subject);
        this.makeRoom(now);
        const counter = { tries: 1, endsAt: now + this.windowMs };
        this.windows.set(subject, counter);
        return this.record(subject, counter);
    }

    /** Drops finished counters from the front, then the oldest live ones, until one more subject fits. */
    private makeRoom(now: number): void {
        for (const [subject, counter] of this.windows) {
            if (counter.endsAt > now) break;
            this.windows.delete(subject);
        }
        while (this.windows.size >= this.maxCounters) {
            const oldest = this.windows.keys().next();
            if (oldest.done) return;
            this.windows.delete(oldest.value);
        }
    }

    /**
     * The try turned out right, so it was no wrong guess. It is given back once, and only while the count it was taken
     * in is still the live one: the password check takes a while, and if that count was dropped or its window ended
     * meanwhile, a refund would lower a newer count that never held this try.
     */
    giveBack(attempt: GuessTry): void {
        const record = this.taken.get(attempt);
        if (!record || record.given) return;
        record.given = true;
        const held = this.windows.get(record.subject);
        if (held !== record.counter || held.endsAt <= Date.now()) return;
        if (held.tries > 0) held.tries--;
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
