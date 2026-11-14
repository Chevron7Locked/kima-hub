/**
 * Checks every figure the stats page shows by recomputing it from raw rows by a
 * different route: loops instead of window functions, sorts instead of
 * `sum() OVER`, a sorted array instead of `percentile_cont`.
 * Run: npx tsx scripts/verify-stats.ts
 */

import { readFileSync } from "node:fs";
import { prisma } from "../src/utils/db";
import { redisClient } from "../src/utils/redis";
import { closeClient } from "../src/utils/closeRedisClient";
import { auditFalseStarts } from "../src/services/playHistoryRepair";
import { listeningStats, trackPlayCount, PLAY_CREDIT_CAP_SECONDS } from "../src/services/stats/listening";
import { shelfStats } from "../src/services/stats/shelf";
import { signature } from "../src/services/stats/signature";
import { withListens, type Period } from "../src/services/stats/listens";
import { spokenStats } from "../src/services/stats/spoken";

const TZ = process.env.VERIFY_TZ || "Europe/London";

/** The two sections as the stats route reads them: one fold of the plays, handed to the section. */
const listening = (userId: string, tz: string, period: Period = "all") =>
    withListens(userId, period, (l) => listeningStats(l, tz));
const signatureOf = (userId: string, tz: string, period: Period = "all") =>
    withListens(userId, period, (l) => signature(l, tz));

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, service: unknown, independent: unknown, note = "") {
    const ok = JSON.stringify(service) === JSON.stringify(independent);
    if (ok) { pass++; console.log(`  ok    ${name}  = ${fmt(service)}${note ? "  (" + note + ")" : ""}`); }
    else {
        fail++;
        const line = `  FAIL  ${name}\n          service says ${fmt(service)}\n          recomputed   ${fmt(independent)}${note ? "\n          " + note : ""}`;
        failures.push(line); console.log(line);
    }
}

/** For floats, where bit-exact equality is the wrong test. */
function near(name: string, service: number, independent: number, tol: number, note = "") {
    const d = Math.abs(service - independent);
    if (d <= tol) { pass++; console.log(`  ok    ${name}  = ${round(service)}  (±${d.toExponential(1)})${note ? "  " + note : ""}`); }
    else {
        fail++;
        const line = `  FAIL  ${name}\n          service says ${round(service)}\n          recomputed   ${round(independent)}  (off by ${round(d)}, tolerance ${tol})${note ? "\n          " + note : ""}`;
        failures.push(line); console.log(line);
    }
}

function note(name: string, text: string) { console.log(`  note  ${name}: ${text}`); }
function fmt(v: unknown) { return typeof v === "number" ? String(round(v)) : JSON.stringify(v); }
function round(n: number) { return Number.isInteger(n) ? n : Number(n.toFixed(6)); }

/* A play row starts a new listen when the previous play of the same track was
 * longer ago than the track's duration. The services use a window function;
 * this is a sort and a loop over raw rows. */
interface Raw { id: string; trackId: string; playedAt: Date; source: string; duration: number;
                energy: number | null; valence: number | null; bpm: number | null;
                albumId: string; artistId: string; trackNo: number | null;
                key: string | null; keyScale: string | null; year: number | null; location: string; }

function collapse(rows: Raw[]): Raw[] {
    const byTrack = new Map<string, Raw[]>();
    for (const r of rows) {
        const list = byTrack.get(r.trackId) ?? [];
        list.push(r);
        byTrack.set(r.trackId, list);
    }
    const kept: Raw[] = [];
    for (const list of byTrack.values()) {
        list.sort((a, b) => a.playedAt.getTime() - b.playedAt.getTime() || (a.id < b.id ? -1 : 1));
        let prev: Date | null = null;
        for (const r of list) {
            const window = Math.max(r.duration, 30);
            const gap = prev === null ? Infinity : (r.playedAt.getTime() - prev.getTime()) / 1000;
            if (gap > window) { kept.push(r); prev = r.playedAt; }
        }
    }
    return kept.sort((a, b) => a.playedAt.getTime() - b.playedAt.getTime() || (a.id < b.id ? -1 : 1));
}

/** Wall-clock parts in a named zone, without pulling in a date library. */
function localParts(d: Date, tz: string) {
    const f = new Intl.DateTimeFormat("en-GB", {
        timeZone: tz, weekday: "short", hour: "2-digit", hour12: false,
        year: "numeric", month: "2-digit",
    });
    const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
    const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday as string);
    return { dow, hour: Number(p.hour) % 24, month: `${p.year}-${p.month}` };
}

async function main() {
    // The account with the most plays, so the most checks compare real numbers.
    const busiest = await prisma.$queryRaw<Array<{ userId: string; n: number }>>`
        SELECT "userId", count(*)::int AS n FROM "Play" GROUP BY 1 ORDER BY 2 DESC LIMIT 1`;
    // With no plays every play-based check compares zeros, so a pass would prove nothing.
    if (!busiest.length) {
        console.log("No plays to verify against. Point DATABASE_URL at a database with listening history.");
        process.exitCode = 1;
        return;
    }
    const user = await prisma.user.findUniqueOrThrow({ where: { id: busiest[0].userId }, select: { id: true, username: true, role: true } });
    console.log(`\nVerifying against user "${user.username}" (${user.role}), timezone ${TZ}\n`);

    const raw = await prisma.$queryRaw<Raw[]>`
        SELECT p.id, p."trackId", p."playedAt", p.source::text AS source,
               t.duration, t.energy, t.valence, t.bpm, t."albumId", t."trackNo",
               t.key, t."keyScale", al."artistId", al.location::text AS location,
               coalesce(al."displayYear", al.year) AS year
        FROM "Play" p
        JOIN "Track" t  ON t.id  = p."trackId"
        JOIN "Album" al ON al.id = t."albumId"
        WHERE p."userId" = ${user.id}`;

    const listens = collapse(raw);
    console.log(`Raw play rows: ${raw.length.toLocaleString()}   collapsed to listens: ${listens.length.toLocaleString()}\n`);

    /* ── listening ─────────────────────────────────────────────────────── */
    console.log("listening");
    const L = await listening(user.id, TZ);

    check("plays", L.plays, listens.length);
    check("estimatedSeconds", L.estimatedSeconds,
        listens.reduce((n, r) => n + Math.min(r.duration, PLAY_CREDIT_CAP_SECONDS), 0));
    check("distinctTracks", L.distinctTracks, new Set(listens.map((r) => r.trackId)).size);
    check("distinctAlbums", L.distinctAlbums, new Set(listens.map((r) => r.albumId)).size);
    check("distinctArtists", L.distinctArtists, new Set(listens.map((r) => r.artistId)).size);

    const clockSum = L.clock.flat().reduce((a, b) => a + b, 0);
    check("clock sums to plays", clockSum, L.plays);

    // Bucketed independently, through the browser's own timezone database
    // rather than Postgres's. Two different zoneinfo implementations agreeing
    // is a stronger result than one agreeing with itself.
    const grid: number[][] = Array.from({ length: 7 }, () => new Array(24).fill(0));
    for (const r of listens) { const { dow, hour } = localParts(r.playedAt, TZ); grid[dow][hour]++; }
    check("clock grid (tz bucketing)", L.clock, grid, "Postgres AT TIME ZONE vs Intl.DateTimeFormat");

    let best = { weekday: 0, hour: 0, plays: -1 };
    for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) if (grid[d][h] > best.plays) best = { weekday: d, hour: h, plays: grid[d][h] };
    check("peak cell", L.peak, best.plays > 0 ? best : null);

    check("bySource sums to plays", Object.values(L.bySource).reduce((a, b) => a + b, 0), L.plays);
    const src: Record<string, number> = {};
    // A play of a song still in Discover is its own source, whichever client played it (the album's location says so).
    for (const r of listens) { const k = r.location === "DISCOVER" ? "DISCOVER" : r.source; src[k] = (src[k] ?? 0) + 1; }
    // A record has no meaningful key order (the query's GROUP BY returns sources in whatever order its plan likes).
    const bySorted = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
    check("bySource breakdown", bySorted(L.bySource), bySorted(src));

    const feat = listens.filter((r) => r.energy !== null && r.valence !== null);
    check("shape sums to analysed listens", L.shape.reduce((n, s) => n + s.plays, 0), feat.length);
    const oob = L.shape.filter((s) => s.x < 1 || s.x > 24 || s.y < 1 || s.y > 24);
    check("shape cells all inside the grid", oob.length, 0);

    const topT = [...new Map<string, number>(
        Object.entries(listens.reduce((m: Record<string, number>, r) => { m[r.trackId] = (m[r.trackId] ?? 0) + 1; return m; }, {})),
    ).entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    check("top track play count", L.topTracks[0]?.plays ?? 0, topT[0]?.[1] ?? 0);

    /* ── shelf ─────────────────────────────────────────────────────────── */
    console.log("\nshelf");
    const S = await shelfStats(user.id);
    check("neverPlayed = total - heard", S.neverPlayed, S.tracks.total - S.tracks.heard);
    check("analysis parts sum to total", S.analysis.done + S.analysis.pending + S.analysis.failed, S.analysis.total);
    check("heard <= total (tracks)", S.tracks.heard <= S.tracks.total, true);
    check("heard <= total (albums)", S.albums.heard <= S.albums.total, true);
    check("heard <= total (artists)", S.artists.heard <= S.artists.total, true);
    check("decade albums <= shelf albums",
        S.decades.reduce((n, d) => n + d.albums, 0) <= S.albums.total, true);
    check("every decade heard <= albums", S.decades.every((d) => d.heard <= d.albums), true);

    const statuses = await prisma.$queryRaw<Array<{ status: string; n: number }>>`
        SELECT t."analysisStatus" AS status, count(*)::int AS n
        FROM "Track" t JOIN "Album" al ON al.id = t."albumId"
        WHERE al.location = 'LIBRARY' GROUP BY 1 ORDER BY 2 DESC`;
    note("analysisStatus values present", statuses.map((s) => `${s.status}=${s.n}`).join(", "));
    const permFailed = statuses.find((s) => s.status === "permanently_failed")?.n ?? 0;
    check("permanently_failed counted as failed, not pending", permFailed === 0 || S.analysis.failed >= permFailed, true,
        `${permFailed} tracks are permanently_failed`);

    /* ── signature ─────────────────────────────────────────────────────── */
    console.log("\nsignature");
    const G = await signatureOf(user.id, TZ);

    if (G.concentration) {
        // Pareto by sorting, not by a running window sum.
        const counts = new Map<string, number>();
        for (const r of listens) counts.set(r.trackId, (counts.get(r.trackId) ?? 0) + 1);
        const sorted = [...counts.values()].sort((a, b) => b - a);
        const total = sorted.reduce((a, b) => a + b, 0);
        const rankAt = (frac: number) => { let run = 0; for (let i = 0; i < sorted.length; i++) { run += sorted[i]; if (run >= total * frac) return i + 1; } return sorted.length; };
        check("concentration.distinct", G.concentration.distinct, counts.size);
        check("concentration.forHalf", G.concentration.forHalf, rankAt(0.5));
        check("concentration.forEighty", G.concentration.forEighty, rankAt(0.8));
        check("forHalf <= forEighty <= distinct",
            G.concentration.forHalf <= G.concentration.forEighty && G.concentration.forEighty <= G.concentration.distinct, true);
    } else note("concentration", "null");

    if (G.albumHabit) {
        // Walk the collapsed listens in time order and count transitions inside
        // a 15-minute sitting, the same definition the SQL uses.
        let moves = 0, same = 0, order = 0;
        for (let i = 1; i < listens.length; i++) {
            const gap = (listens[i].playedAt.getTime() - listens[i - 1].playedAt.getTime()) / 1000;
            if (gap >= 900) continue;
            moves++;
            if (listens[i].albumId === listens[i - 1].albumId) {
                same++;
                if (listens[i].trackNo !== null && listens[i - 1].trackNo !== null &&
                    listens[i].trackNo === listens[i - 1].trackNo! + 1) order++;
            }
        }
        check("albumHabit.moves", G.albumHabit.moves, moves);
        near("albumHabit.sameAlbumPct", G.albumHabit.sameAlbumPct, moves ? (same / moves) * 100 : 0, 0.6);
        near("albumHabit.inOrderPct", G.albumHabit.inOrderPct, moves ? (order / moves) * 100 : 0, 0.6);
        check("inOrder <= sameAlbum", G.albumHabit.inOrderPct <= G.albumHabit.sameAlbumPct, true);
    } else note("albumHabit", "null");

    if (G.key) {
        const withKey = listens.filter((r) => r.key !== null && r.keyScale !== null);
        const minor = withKey.filter((r) => r.keyScale === "minor").length;
        near("key.minorPct", G.key.minorPct, withKey.length ? (minor / withKey.length) * 100 : 0, 0.06);
        check("key.all sums to keyed listens", G.key.all.reduce((n, k) => n + k.plays, 0), withKey.length);
        // The ledger prints "77% minor -- most often <top[0]>". If the most
        // played key is a major one, that gloss contradicts the figure above it.
        const topIsMinor = /minor$/.test(G.key.top[0]?.key ?? "");
        check("top key's scale agrees with minorPct majority",
            G.key.minorPct >= 50 ? topIsMinor : !topIsMinor, true,
            `minorPct=${G.key.minorPct}, top=${G.key.top[0]?.key}`);
    } else note("key", "null");

    if (G.era) {
        const years = listens.map((r) => r.year).filter((y): y is number => y !== null).sort((a, b) => a - b);
        const mid = years.length % 2 ? years[(years.length - 1) / 2]
                                     : (years[years.length / 2 - 1] + years[years.length / 2]) / 2;
        near("era.medianYear", G.era.medianYear, mid, 0.5, "percentile_cont vs sorted array");
        near("era buckets sum to 100%", G.era.buckets.reduce((n, b) => n + b.percent, 0), 100, 0.3);
    } else note("era", "null");

    const hourlyPlays = G.hourly.reduce((n, h) => n + h.plays, 0);
    check("hourly sums to listens with energy", hourlyPlays, listens.filter((r) => r.energy !== null).length);
    check("hourly hours all 0-23", G.hourly.every((h) => h.hour >= 0 && h.hour <= 23), true);
    check("hourly energy all 0-1", G.hourly.every((h) => h.energy >= 0 && h.energy <= 1), true);

    for (const row of G.ownedVsPlayed) {
        const lo = row.unit === "bpm" ? 30 : 0, hi = row.unit === "bpm" ? 260 : 1;
        // Null is a distinct failure from out-of-range: it means the row was
        // built for a user who has no plays to average, and the frontend turns
        // it into `left: NaN%`.
        const finite = Number.isFinite(row.owned) && Number.isFinite(row.played);
        check(`ownedVsPlayed "${row.label}" is a real number`, finite, true,
            `owned=${row.owned} played=${row.played}`);
        if (finite) check(`ownedVsPlayed "${row.label}" in range`,
            row.owned >= lo && row.owned <= hi && row.played >= lo && row.played <= hi, true,
            `owned=${round(row.owned)} played=${round(row.played)}`);
    }

    /* ── spoken ────────────────────────────────────────────────────────── */
    console.log("\nspoken");
    const P = await spokenStats(user.id);
    check("audiobook seconds >= 0", P.audiobooks.seconds >= 0, true);
    check("current percent in 0..1", P.audiobooks.current === null ||
        (P.audiobooks.current.percent >= 0 && P.audiobooks.current.percent <= 1), true,
        P.audiobooks.current ? `percent=${round(P.audiobooks.current.percent)}` : "no book in progress");

    const bookRows = await prisma.$queryRaw<Array<{ n: number; fin: number; ct: number; dur: number }>>`
        SELECT count(*)::int AS n, count(*) FILTER (WHERE "isFinished")::int AS fin,
               coalesce(sum("currentTime"),0)::float8 AS ct, coalesce(sum(duration),0)::float8 AS dur
        FROM "AudiobookProgress" WHERE "userId" = ${user.id}`;
    check("audiobook total = finished + inProgress + setAside",
        P.audiobooks.finished + P.audiobooks.inProgress + P.audiobooks.setAside, bookRows[0].n);
    // A finished book whose stored position never reached its duration is
    // counted at the position, so the hours figure reads low.
    const shortfall = await prisma.$queryRaw<Array<{ n: number; lost: number }>>`
        SELECT count(*)::int AS n, coalesce(sum(duration - "currentTime"),0)::float8 AS lost
        FROM "AudiobookProgress"
        WHERE "userId" = ${user.id} AND "isFinished" AND "currentTime" < duration * 0.99`;
    note("finished books whose position < duration",
        `${shortfall[0].n} books, ${Math.round(shortfall[0].lost / 3600)}h not counted in the hours figure`);

    /* ── the rolling windows ───────────────────────────────────────────── */
    //
    // The window filters the walk's result, not its input: filtering rows first
    // would turn a listen that began before the window into a new one at its edge.
    console.log("\nwindows");
    const now = Date.now();
    const startedWithin = (days: number) =>
        listens.filter((r) => r.playedAt.getTime() >= now - days * 86400_000).length;

    for (const [period, days] of [["30d", 30], ["12mo", 365]] as const) {
        const W = await listening(user.id, TZ, period);
        // Recomputed by collapsing the WHOLE history first and only then
        // keeping the listens that began in range — the same order of
        // operations the SQL claims to use.
        check(`${period}: plays`, W.plays, startedWithin(days));
        check(`${period}: clock sums to plays`,
            W.clock.flat().reduce((a, b) => a + b, 0), W.plays);
        check(`${period}: estimatedSeconds`, W.estimatedSeconds,
            listens.filter((r) => r.playedAt.getTime() >= now - days * 86400_000)
                   .reduce((n, r) => n + Math.min(r.duration, PLAY_CREDIT_CAP_SECONDS), 0));
        check(`${period}: no phantom listens at the boundary`, W.plays <= L.plays, true,
            `${W.plays} in window vs ${L.plays} all time`);
    }

    const w30 = await listening(user.id, TZ, "30d");
    const w12 = await listening(user.id, TZ, "12mo");
    check("30d <= 12mo <= all", w30.plays <= w12.plays && w12.plays <= L.plays, true,
        `${w30.plays} / ${w12.plays} / ${L.plays}`);

    const s30 = await signatureOf(user.id, TZ, "30d");
    check("windowed signature stays internally consistent",
        s30.concentration === null ||
        (s30.concentration.forHalf <= s30.concentration.forEighty &&
         s30.concentration.forEighty <= s30.concentration.distinct), true);
    check("windowed key percentages still sum sanely",
        s30.key === null || (s30.key.minorPct >= 0 && s30.key.minorPct <= 100), true);

    /* ── the player bar's number ───────────────────────────────────────── */
    //
    // The player bar's play count must match this page's for the same track.
    console.log("\nplayer bar");
    const topTrack = L.topTracks[0];
    if (topTrack) {
        const single = await trackPlayCount(user.id, topTrack.id);
        check("track count matches the top-tracks list", single, topTrack.plays,
            `"${topTrack.title}"`);
        const byHand = listens.filter((r) => r.trackId === topTrack.id).length;
        check("track count matches an independent recount", single, byHand);
    } else note("player bar", "no plays to check against");

    const unknown = await trackPlayCount(user.id, "no-such-track-id");
    check("an unknown track counts zero rather than throwing", unknown, 0);

    /* ── numbers the interface repeats back ────────────────────────────── */
    //
    // Two server limits are repeated in client copy, which cannot import them;
    // if a cap moves, this fails and names the file that must move with it.
    console.log("\nshared limits");
    const playableSrc = readFileSync(
        new URL("../src/services/stats/playable.ts", import.meta.url), "utf8");
    const routeSrc = readFileSync(
        new URL("../src/routes/stats.ts", import.meta.url), "utf8");
    check("playable MAX_TRACKS is 100", /const MAX_TRACKS = 100;/.test(playableSrc), true,
        "frontend/features/stats/components/Finding.tsx SLICE_CAP must match");
    check("route MAX_TRACKS_PER_ACTION is 2000", /const MAX_TRACKS_PER_ACTION = 2000;/.test(routeSrc), true,
        "frontend/features/stats/components/FalseStarts.tsx MAX_PER_ACTION must match");

    /* ── the audit's own promise ───────────────────────────────────────── */
    //
    // The delete removes only listens proven skipped. Tracks under 30 seconds
    // can never register a play, so they are reported apart and left alone.
    console.log("\nplay-history audit");
    const audit = await auditFalseStarts(user.id);
    check("heard + skipped + tooShort + unclear == listens",
        audit.heard + audit.skipped + audit.tooShort + audit.unclear, audit.totalListens);
    check("tooShort is reported separately from skipped", typeof audit.tooShort, "number",
        `${audit.tooShort} listens of tracks too short to ever count`);
    const doomedTracks = audit.tracks.filter((t) => t.skipped > 0).map((t) => t.trackId);
    const tooShortOnly = audit.tracks.filter((t) => t.skipped === 0 && t.tooShort > 0);
    check("a track that is only too-short is never queued for deletion",
        tooShortOnly.every((t) => !doomedTracks.includes(t.trackId)), true,
        `${tooShortOnly.length} such track(s)`);

    console.log(`\n${pass} passed, ${fail} failed\n`);
    if (fail) { console.log("Failures:\n" + failures.join("\n")); process.exitCode = 1; }
}

// Importing the stats modules opens Redis; closed here with Prisma so the script exits.
main()
    .catch((e) => { console.error(e); process.exitCode = 1; })
    .finally(() => Promise.all([prisma.$disconnect(), closeClient(redisClient)]));
