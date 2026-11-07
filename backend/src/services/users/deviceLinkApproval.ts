/**
 * Device-link requests waiting for their owner. A right code does not hand out a key by itself: the app's request is
 * held here until the signed-in owner of the code answers. Held in memory: one backend process, and a restart just
 * drops the waiters.
 */

/** What a held request is told: the owner's ruling, that nobody answered, that another request already waits, or that it went away. */
export type Outcome = "approved" | "denied" | "no-answer" | "already-waiting" | "gone";

type EndOfWait = "approved" | "denied" | "no-answer";

const WAIT_MS = 45_000;

interface Waiter {
    deviceName: string;
    release: (outcome: Outcome) => void;
}

const waiting = new Map<string, Waiter>();

/**
 * Holds a request for `codeId` until its owner answers. A code holds one request at a time; a second is turned away.
 * When `gone` aborts (the app hung up), the request stops waiting and the code is free for the next one.
 */
export function waitForAnswer(codeId: string, deviceName: string, gone: AbortSignal): Promise<Outcome> {
    if (waiting.has(codeId)) return Promise.resolve("already-waiting");
    return new Promise((resolve) => {
        const timer = setTimeout(() => endWait(codeId, "no-answer"), WAIT_MS);
        const release = (outcome: Outcome) => {
            clearTimeout(timer);
            gone.removeEventListener("abort", dropWaiter);
            resolve(outcome);
        };
        const dropWaiter = () => {
            waiting.delete(codeId);
            release("gone");
        };
        gone.addEventListener("abort", dropWaiter);
        waiting.set(codeId, { deviceName, release });
        if (gone.aborted) dropWaiter();
    });
}

function endWait(codeId: string, outcome: EndOfWait): boolean {
    const held = waiting.get(codeId);
    if (!held) return false;
    waiting.delete(codeId);
    held.release(outcome);
    return true;
}

/** Lets the one held request for `codeId` through; false when nothing is held. */
export const approve = (codeId: string) => endWait(codeId, "approved");

/** Refuses the one held request for `codeId`; false when nothing is held. */
export const deny = (codeId: string) => endWait(codeId, "denied");

/** The name the device gave, when a request for `codeId` is waiting. */
export function waitingDevice(codeId: string): string | null {
    return waiting.get(codeId)?.deviceName ?? null;
}
