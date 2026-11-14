/**
 * How long-running work learns of the shutdown, and how the shutdown learns what a request started. No database:
 * the work here is held open by the test.
 */

import {
    runAsRequestWork,
    shutdownStop,
    sleepUnlessStopped,
    stopSignal,
    useShutdownCheck,
    whenRequestWorkEnded,
    withShutdownSignal,
} from "../stopCheck";

const held = () => {
    let release!: () => void;
    let fail!: (e: Error) => void;
    const done = new Promise<void>((resolve, reject) => {
        release = resolve;
        fail = reject;
    });
    return { done, release, fail };
};
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

afterEach(() => useShutdownCheck(() => false));

describe("sleepUnlessStopped", () => {
    it("waits the whole time when nothing stops", async () => {
        const started = Date.now();
        await sleepUnlessStopped(300, { shouldStop: () => false });
        expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    });

    it("ends within a moment when the stop check turns true during the wait", async () => {
        let stop = false;
        const started = Date.now();
        const sleeping = sleepUnlessStopped(10_000, { shouldStop: () => stop });
        setTimeout(() => (stop = true), 30);
        await sleeping;
        expect(Date.now() - started).toBeLessThan(2_000);
    });

    it("does not wait at all when already stopped", async () => {
        const started = Date.now();
        await sleepUnlessStopped(10_000, { shouldStop: () => true });
        expect(Date.now() - started).toBeLessThan(500);
    });

    it("waits the whole time for work with no stop check", async () => {
        const started = Date.now();
        await sleepUnlessStopped(120, {});
        expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    });
});

describe("stopSignal", () => {
    it("aborts once the stop check turns true, and not before", async () => {
        let stop = false;
        const { signal, release } = stopSignal({ shouldStop: () => stop });
        expect(signal.aborted).toBe(false);
        stop = true;
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(signal.aborted).toBe(true);
        release();
    });

    it("is already aborted when work starts after the shutdown began", () => {
        const { signal, release } = stopSignal({ shouldStop: () => true });
        expect(signal.aborted).toBe(true);
        release();
    });

    it("stops watching once released", async () => {
        const shouldStop = jest.fn(() => false);
        const { release } = stopSignal({ shouldStop });
        release();
        shouldStop.mockClear();
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(shouldStop).not.toHaveBeenCalled();
    });
});

describe("withShutdownSignal", () => {
    it("hands the work a signal that aborts once the shutdown begins, and answers what the work answers", async () => {
        let begun = false;
        useShutdownCheck(() => begun);
        let handed!: AbortSignal;

        const answer = await withShutdownSignal(async (signal) => {
            handed = signal;
            expect(signal.aborted).toBe(false);
            begun = true;
            await new Promise((resolve) => setTimeout(resolve, 400));
            return "answer";
        });

        expect(answer).toBe("answer");
        expect(handed.aborted).toBe(true);
    });

    it("stops watching the shutdown when the work ends, even by failing", async () => {
        const check = jest.fn(() => false);
        useShutdownCheck(check);

        await expect(
            withShutdownSignal(async () => {
                throw new Error("boom");
            }),
        ).rejects.toThrow("boom");
        check.mockClear();
        await new Promise((resolve) => setTimeout(resolve, 300));

        expect(check).not.toHaveBeenCalled();
    });
});

describe("runAsRequestWork", () => {
    it("holds the drain until the work has ended, and hands the work the shutdown's stop check", async () => {
        let begun = false;
        useShutdownCheck(() => begun);
        const work = held();
        let handed: { shouldStop?: () => boolean } = {};

        const running = runAsRequestWork(async (stop) => {
            handed = stop;
            await work.done;
            return "answer";
        });
        let drained = false;
        void whenRequestWorkEnded().then(() => (drained = true));
        await flush();
        await flush();
        expect(drained).toBe(false);
        expect(handed.shouldStop!()).toBe(false);
        begun = true;
        expect(handed.shouldStop!()).toBe(true);

        work.release();
        expect(await running).toBe("answer");
        await flush();
        expect(drained).toBe(true);
    });

    it("is counted from the moment it is called, before the work's first await", async () => {
        const work = held();
        const running = runAsRequestWork(() => work.done);
        let drained = false;
        void whenRequestWorkEnded().then(() => (drained = true));
        await flush();
        expect(drained).toBe(false);
        work.release();
        await running;
    });

    it("does not hold the drain for work that failed, and the caller still sees the failure", async () => {
        const work = held();
        const running = runAsRequestWork(() => work.done);
        const seen = running.catch((e: Error) => e.message);
        work.fail(new Error("boom"));
        expect(await seen).toBe("boom");
        await whenRequestWorkEnded();
    });

    it("waits for work started while it was waiting", async () => {
        const first = held();
        const second = held();
        void runAsRequestWork(() => first.done);
        let drained = false;
        void whenRequestWorkEnded().then(() => (drained = true));
        void runAsRequestWork(() => second.done);
        first.release();
        await flush();
        await flush();
        expect(drained).toBe(false);
        second.release();
        await flush();
        await flush();
        expect(drained).toBe(true);
    });

    it("has nothing to wait for when no request started work", async () => {
        await whenRequestWorkEnded();
    });
});

describe("shutdownStop", () => {
    it("follows the registered shutdown, until then nothing is shutting down", () => {
        expect(shutdownStop().shouldStop!()).toBe(false);
        useShutdownCheck(() => true);
        expect(shutdownStop().shouldStop!()).toBe(true);
    });
});
