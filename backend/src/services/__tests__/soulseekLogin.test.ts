/**
 * The marker of who is logged in to Soulseek as the account, against the real Redis. Two processes are two
 * instances with different ids and one key.
 */
import { redisClient, waitForRedisReady } from "../../utils/redis";
import { closeClient } from "../../utils/closeRedisClient";
import { SoulseekLogin } from "../soulseekLogin";

const KEY = "test:soulseek-login-marker";
const makeLogin = (id: string, extra: { ttlMs?: number; beatMs?: number } = {}) => new SoulseekLogin({ key: KEY, id, ...extra });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let running: SoulseekLogin[] = [];
const start = (id: string, extra?: { ttlMs?: number; beatMs?: number }) => {
    const login = makeLogin(id, extra);
    running.push(login);
    return login;
};

beforeAll(() => waitForRedisReady());
beforeEach(() => redisClient.del(KEY));
afterEach(async () => {
    await Promise.all(running.map((login) => login.clear()));
    running = [];
    await redisClient.del(KEY);
});
afterAll(() => closeClient(redisClient));

it("finds nobody logged in when nothing is recorded", async () => {
    expect(await start("a").heldByOther()).toBeNull();
});

it("shows another process who is logged in and since when, and shows the process itself nothing", async () => {
    const a = start("host-a:11");
    const b = start("host-b:22");
    const before = Date.now();

    await a.mark();

    const seen = await b.heldByOther();
    expect(seen?.by).toBe("host-a:11");
    expect(seen!.at.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(seen!.at.getTime()).toBeLessThanOrEqual(Date.now());
    expect(await a.heldByOther()).toBeNull();
});

it("is gone once the process that set it lets go", async () => {
    const a = start("a");
    await a.mark();

    await a.clear();

    expect(await start("b").heldByOther()).toBeNull();
});

it("is not removed by a process that did not set it", async () => {
    const a = start("a");
    const b = start("b");
    await a.mark();

    await b.clear();

    expect((await b.heldByOther())?.by).toBe("a");
});

it("is not removed by the clear of a login that a newer login replaced", async () => {
    const a = start("a");
    await a.mark();
    const clearing = a.clear();
    // The clear read its own value synchronously; a login made right after it is a different one.
    await a.mark();
    await clearing;

    expect((await start("b").heldByOther())?.by).toBe("a");
});

it("expires by itself when the process that set it died, so nobody is kept out for good", async () => {
    // Its heartbeat is slower than its life, as if the process stopped beating.
    const a = start("a", { ttlMs: 300, beatMs: 60_000 });
    await a.mark();
    expect(await redisClient.pttl(KEY)).toBeGreaterThan(0);

    await sleep(450);

    expect(await start("b").heldByOther()).toBeNull();
});

it("is renewed while the process is logged in, so a long login keeps it", async () => {
    const a = start("a", { ttlMs: 400, beatMs: 100 });
    await a.mark();

    await sleep(900);

    expect((await start("b").heldByOther())?.by).toBe("a");
});

it("stops being renewed once cleared", async () => {
    const a = start("a", { ttlMs: 300, beatMs: 50 });
    await a.mark();
    await a.clear();
    await sleep(200);

    expect(await redisClient.exists(KEY)).toBe(0);
});
