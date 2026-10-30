#!/usr/bin/env node
// Gives the E2E test user a listening history on a throwaway test stack, so the stats journeys have plays to read.
// Each play goes through the Subsonic scrobble a client sends, the same path a real listen takes; nothing is written
// to the database directly. Spread over two years at different hours, a third each in the last month, the rest of the
// year and the year before, so each period the stats page offers shows a different count; some songs are heard more
// than others.
// Env: KIMA_UI_BASE_URL, KIMA_TEST_USERNAME, KIMA_TEST_PASSWORD, KIMA_STATS_ALLOWED_TARGETS, KIMA_SEED_PLAYS
// (default 120). Runs only on a marked test copy, as the stats journey's destructive buttons do: the target's
// host:port in KIMA_STATS_ALLOWED_TARGETS and a playlist named __kima-test-copy__ owned by the test user. Never on
// the production port; does nothing when the account already has more than 50 plays.

const base = process.env.KIMA_UI_BASE_URL;
const username = process.env.KIMA_TEST_USERNAME;
const password = process.env.KIMA_TEST_PASSWORD;
const wanted = Number(process.env.KIMA_SEED_PLAYS || 120);
const KEY_NAME = "e2e-seed-plays";

class SeedError extends Error {}

async function call(path, init = {}) {
    const res = await fetch(new URL(path, base), init);
    if (!res.ok) throw new SeedError(`${init.method || "GET"} ${path.split("?")[0]} answered ${res.status}`);
    return res.json();
}

/** Revokes every key this script has made, including one a crashed earlier run left. */
async function revokeKeys(auth) {
    const res = await fetch(new URL("/api/api-keys", base), { headers: auth });
    if (!res.ok) return;
    for (const key of (await res.json()).apiKeys ?? []) {
        if ((key.name ?? "").includes(KEY_NAME)) {
            await fetch(new URL(`/api/api-keys/${key.id}`, base), { method: "DELETE", headers: auth });
        }
    }
}

async function main() {
    if (!base || !username || !password) throw new SeedError("KIMA_UI_BASE_URL, KIMA_TEST_USERNAME and KIMA_TEST_PASSWORD are required");
    const url = new URL(base);
    const target = `${url.hostname}:${url.port || (url.protocol === "https:" ? "443" : "80")}`;
    if (target.endsWith(":3030")) throw new SeedError(`${base} is the production port`);
    const allowed = (process.env.KIMA_STATS_ALLOWED_TARGETS ?? "").split(",").map((s) => s.trim());
    if (!allowed.includes(target)) throw new SeedError(`${target} is not listed in KIMA_STATS_ALLOWED_TARGETS`);

    const { token } = await call("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
    });
    const auth = { Authorization: `Bearer ${token}` };
    // A run killed after making its key never reached its own cleanup.
    await revokeKeys(auth);

    const playlists = await call("/api/playlists?limit=100", { headers: auth });
    if (!playlists.some((p) => p.isOwner && p.name === "__kima-test-copy__")) {
        throw new SeedError(`${username} owns no playlist named __kima-test-copy__, so this is not a marked test copy`);
    }

    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const stats = await call(`/api/stats?tz=${encodeURIComponent(tz)}&period=all`, { headers: auth });
    if (stats.listening.plays > 50) {
        console.log(`[seed plays] ${username} already has ${stats.listening.plays} plays; nothing to do`);
        return;
    }

    const { tracks } = await call("/api/library/tracks?limit=500", { headers: auth });
    const playable = tracks.filter((t) => t.duration > 30);
    if (playable.length < 20) throw new SeedError(`the library has ${playable.length} songs over 30 seconds; at least 20 are needed`);

    // A fixed sequence (mulberry32), so every stack gets the same history shape.
    let state = 20261029;
    const next = () => {
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    let sent = 0;
    try {
        const { apiKey } = await call("/api/api-keys", {
            method: "POST",
            headers: { ...auth, "Content-Type": "application/json" },
            body: JSON.stringify({ deviceName: KEY_NAME }),
        });
        const day = 24 * 60 * 60 * 1000;
        const now = Date.now();
        for (let i = 0; i < wanted; i++) {
            // Squaring favours the first songs, so a few are heard often and most once or twice.
            const track = playable[Math.floor(next() ** 2 * Math.min(playable.length, 80))];
            // Any hour of the day, clear of the edges of the 30-day and 12-month windows.
            const daysAgo = [1 + next() * 27, 32 + next() * 320, 370 + next() * 330][i % 3];
            const playedAt = Math.round(now - daysAgo * day - next() * day);
            const query = new URLSearchParams({
                u: username, apiKey, id: track.id, time: String(playedAt), submission: "true", v: "1.16.1", c: "kima-e2e-seed", f: "json",
            });
            const reply = await call(`/rest/scrobble.view?${query}`);
            if (reply["subsonic-response"]?.status !== "ok") throw new SeedError(`scrobble ${i + 1} was refused`);
            sent++;
        }
    } finally {
        await revokeKeys(auth);
    }

    const after = await call(`/api/stats?tz=${encodeURIComponent(tz)}&period=all`, { headers: auth });
    console.log(`[seed plays] sent ${sent} scrobbles; ${username} now has ${after.listening.plays} plays`);
    if (after.listening.plays <= 50) throw new SeedError("fewer than 51 plays were recorded");
}

main().catch((err) => {
    console.error(`[seed plays] ${err instanceof SeedError ? err.message : err}`);
    process.exit(1);
});
