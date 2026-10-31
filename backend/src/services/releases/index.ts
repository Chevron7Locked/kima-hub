/**
 * Deciding what a user still needs to be shown, and recording what they said.
 *
 * The server decides which releases are pending, never the client — otherwise a
 * client could suppress a consent prompt by claiming it had already been seen.
 */

import { ChoiceDecidedBy } from "@prisma/client";
import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { GPU_CHOICE_KEY, RELEASES, choicesIn, findRelease, isMoodMixItem, type Release, type ReleaseItem } from "./catalog";
import { gpuSupported } from "../gpuRuntime";
import { MOOD_MIX_RELEASE, moodMixState, type MoodMixState } from "./moodMixes";

export { findRelease, GPU_CHOICE_KEY } from "./catalog";

/** The GPU question's answer is the switch itself, not a stored choice. */
async function gpuChoiceAnswer(): Promise<boolean> {
    const settings = await prisma.systemSettings.findUnique({ where: { id: "default" }, select: { gpuOnnxEnabled: true } });
    return settings?.gpuOnnxEnabled ?? false;
}

async function isAdminUser(userId: string): Promise<boolean> {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
    return user?.role === "admin";
}

/** Whether an admin's album re-file has finished cleanly (refileProcessor.ts stamps it). */
async function albumsRefiled(): Promise<boolean> {
    const settings = await prisma.systemSettings.findUnique({ where: { id: "default" }, select: { albumsRefiledAt: true } });
    return settings?.albumsRefiledAt != null;
}

/** Whether the library holds enrichment from before `date`: an install upgraded past a release, not a fresh one. */
async function libraryEnrichedBefore(date: string): Promise<boolean> {
    const [row] = await prisma.$queryRaw<Array<{ older: boolean }>>`
        SELECT EXISTS (SELECT 1 FROM track_embeddings WHERE analyzed_at < ${new Date(date)})
            OR EXISTS (SELECT 1 FROM "Track" WHERE "analyzedAt" < ${new Date(date)}) AS older
    `;
    return row?.older === true;
}

/** Releases this user has not yet closed, oldest first, so someone away for three versions reads them in order and
 * answers older consent questions before newer ones that may depend on them. */
export async function pendingReleases(userId: string): Promise<Release[]> {
    const acked = await prisma.releaseAcknowledgement.findMany({
        where: { userId },
        select: { version: true },
    });
    const seen = new Set(acked.map((a) => a.version));
    const pending = RELEASES.filter((r) => !seen.has(r.version)).sort(byDate);
    // The window asks only what is still owed: the re-file is not, once a clean run is recorded.
    const refiled = await albumsRefiled();
    const out = (await forUser(userId, pending)).map((r) =>
        refiled ? { ...r, items: r.items.filter((i) => !(i.kind === "action" && i.run === "refileAlbums")) } : r,
    );

    // A mix under a mood 1.11 removed cannot be shown, so closing the window
    // must not be the last word on it: until the user saves or removes it,
    // the question comes back on the next visit, on its own.
    if (seen.has(MOOD_MIX_RELEASE)) {
        const release = findRelease(MOOD_MIX_RELEASE);
        const retired = release?.items.find((i) => i.kind === "action" && i.requires === "retiredMoodMix");
        const s = retired ? await moodMixState(userId) : undefined;
        if (release && retired && s?.mix?.retired && s.decision === null && s.playlist === null) {
            out.push({
                ...release,
                note: undefined,
                title: "One thing left from 1.11",
                summary: "Your old mood mix is still waiting for an answer.",
                items: [retired],
            });
        }
    }
    return out;
}

const byDate = (a: Release, b: Release) =>
    a.date === b.date ? a.version.localeCompare(b.version) : a.date < b.date ? -1 : 1;

/**
 * The newest release as this user would be shown it, closed or not, to read
 * again, with what is already settled: each choice's answer (the GPU one is the
 * setting as it stands, whoever changed it) and the mood-mix question once the
 * user decided it.
 */
export async function currentReleaseFor(
    userId: string,
): Promise<{ release: Release; answers: Record<string, boolean>; done: string[] } | undefined> {
    const newest = [...RELEASES].sort(byDate).at(-1);
    if (!newest) return undefined;
    const [release] = await forUser(userId, [newest]);
    const asked = choicesIn(release).map((c) => c.key);
    const rows = await prisma.releaseChoice.findMany({ where: { userId, key: { in: asked } }, select: { key: true, enabled: true } });
    const answers: Record<string, boolean> = Object.fromEntries(rows.map((row) => [row.key, row.enabled]));
    if (asked.includes(GPU_CHOICE_KEY)) answers[GPU_CHOICE_KEY] = await gpuChoiceAnswer();
    const done: string[] = [];
    if (await albumsRefiled()) done.push(...release.items.filter((i) => i.kind === "action" && i.run === "refileAlbums").map((i) => i.key));
    const mixItems = release.items.filter(isMoodMixItem).map((i) => i.key);
    if (mixItems.length > 0) {
        const state = await moodMixState(userId);
        if (state.decision !== null || state.playlist !== null) done.push(...mixItems);
    }
    return { release, answers, done };
}

/** The releases with only the items that apply to this user. */
async function forUser(
    userId: string,
    releases: Release[],
    enrichedBefore: (date: string) => Promise<boolean> = enrichedBeforeOnce(),
): Promise<Release[]> {
    // Items that only apply to some users are dropped for the rest: asking
    // someone with no mood mix to rebuild it would be noise, and asking a
    // non-admin to switch a system-wide setting they cannot change would be
    // worse. The user's role is only read when an item needs it.
    let state: MoodMixState | undefined;
    const mixState = async () => (state ??= await moodMixState(userId));
    let roleChecked: boolean | undefined;
    const isAdmin = async () => (roleChecked ??= await isAdminUser(userId));
    let setUpAt: Date | null | undefined;
    const installedBefore = async (date: string) => {
        if (setUpAt === undefined) {
            setUpAt = (await prisma.systemSettings.findUnique({ where: { id: "default" }, select: { createdAt: true } }))?.createdAt ?? null;
        }
        return setUpAt !== null && setUpAt < new Date(date);
    };
    const applies = async (item: ReleaseItem, release: Release): Promise<boolean> => {
        if ((item.kind === "action" || item.kind === "note") && item.olderLibraryOnly && !(await enrichedBefore(release.date))) return false;
        if (item.kind === "action" && item.installedBeforeOnly && !(await installedBefore(release.date))) return false;
        // The GPU choice is only asked where the CUDA runtime can exist; on
        // other hosts the answer would always be "unsupported_platform".
        if (item.kind === "choice" && item.key === GPU_CHOICE_KEY && !gpuSupported()) return false;
        if (!("requires" in item) || !item.requires) return true;
        if (item.requires === "admin") return isAdmin();
        if (item.kind !== "action") return true;
        const { mix } = await mixState();
        return item.requires === "retiredMoodMix" ? mix?.retired === true : mix?.retired === false;
    };

    const out: Release[] = [];
    for (const r of releases) {
        const items: ReleaseItem[] = [];
        for (const i of r.items) if (await applies(i, r)) items.push(i);
        out.push(items.length === r.items.length ? r : { ...r, items });
    }
    return out;
}

/** Per-item state on the changelog: what a user was told, asked, and what the server knows happened. */
interface ChangelogItem {
    key: string;
    kind: "note" | "action" | "choice";
    title: string;
    summary: string;
    body: string;
    cta?: string;
    run?: "wipeEnrichment" | "refileAlbums";
    confirmTitle?: string;
    confirmMessage?: string;
    confirmLabel?: string;
    ifClosed?: string;
    discloses?: string;
    links?: Array<{ label: string; href: string }>;
    /** A choice's recorded answer, and who said it — "EXPLICIT" or "DISMISSED" (silence, never consent). */
    answer?: { enabled: boolean; decidedBy: string };
    /** An action the server can verify: completed for real, not because a window closed. */
    done?: boolean;
    /** A tracked action that is still owed, and until when it shows. */
    open?: boolean;
}

interface ChangelogRelease {
    version: string;
    title: string;
    summary: string;
    date: string;
    note?: { from: string; body: string };
    /** The user closed this release's window; its open items stay visible here. */
    dismissed: boolean;
    items: ChangelogItem[];
}

/** libraryEnrichedBefore asked at most once per date, for the length of one request. */
function enrichedBeforeOnce(): (date: string) => Promise<boolean> {
    const asked = new Map<string, Promise<boolean>>();
    return (date) => {
        if (!asked.has(date)) asked.set(date, libraryEnrichedBefore(date));
        return asked.get(date)!;
    };
}

/** Actions whose completion the server can verify from real state. Everything else is informational. */
async function actionSettled(
    userId: string,
    item: ReleaseItem,
    releaseDate: string,
    enrichedBefore: (date: string) => Promise<boolean>,
): Promise<boolean | undefined> {
    if (item.kind !== "action") return undefined;
    if (item.run === "wipeEnrichment") {
        // Open until no track in the library carries analysis from before the release — i.e. the whole
        // library has been through the new engine. A rerun restamps what it finishes, so this closes
        // itself when the work is truly done.
        return !(await enrichedBefore(releaseDate));
    }
    if (item.run === "refileAlbums") return albumsRefiled();
    if (isMoodMixItem(item)) {
        const state = await moodMixState(userId);
        return state.decision !== null || state.playlist !== null;
    }
    return undefined;
}

/**
 * The permanent changelog: every release, newest first, filtered to this user,
 * each item carrying what the server knows — the answer recorded, the action
 * actually run, or a quiet "open" until it is. Reading it never writes anything.
 */
export async function changelogFor(userId: string): Promise<{ releases: ChangelogRelease[]; openCount: number }> {
    const enrichedBefore = enrichedBeforeOnce();
    const [acks, choices, filtered] = await Promise.all([
        prisma.releaseAcknowledgement.findMany({ where: { userId }, select: { version: true } }),
        prisma.releaseChoice.findMany({ where: { userId } }),
        forUser(userId, [...RELEASES].sort(byDate).reverse(), enrichedBefore),
    ]);
    const seen = new Set(acks.map((a) => a.version));
    const answers = new Map(choices.map((c) => [c.key, c]));
    if (answers.has(GPU_CHOICE_KEY)) answers.get(GPU_CHOICE_KEY)!.enabled = await gpuChoiceAnswer();
    let openCount = 0;
    const releases = await Promise.all(
        filtered.map(async (r): Promise<ChangelogRelease> => {
            const items = await Promise.all(
                r.items.map(async (i): Promise<ChangelogItem> => {
                    const out: ChangelogItem = {
                        key: i.key,
                        kind: i.kind,
                        title: i.title,
                        summary: i.summary,
                        body: i.body,
                        ...(i.kind === "action"
                            ? {
                                  cta: i.cta,
                                  run: i.run,
                                  confirmTitle: i.confirmTitle,
                                  confirmMessage: i.confirmMessage,
                                  confirmLabel: i.confirmLabel,
                                  ifClosed: i.ifClosed,
                              }
                            : i.kind === "choice"
                              ? { discloses: i.discloses }
                              : {}),
                        ...(i.links ? { links: i.links } : {}),
                    };
                    if (i.kind === "choice") {
                        const a = answers.get(i.key);
                        if (a) out.answer = { enabled: a.enabled, decidedBy: a.decidedBy };
                    }
                    if (seen.has(r.version)) {
                        const settled = await actionSettled(userId, i, r.date, enrichedBefore);
                        if (settled !== undefined) {
                            out.done = settled;
                            out.open = !settled;
                            if (!settled) openCount++;
                        }
                    }
                    return out;
                }),
            );
            return { version: r.version, title: r.title, summary: r.summary, date: r.date, note: r.note, dismissed: seen.has(r.version), items };
        }),
    );
    return { releases, openCount };
}

/** What this user was told to do and the server cannot yet see done. The quiet ledger. */
export async function openRequirements(userId: string): Promise<{ count: number; items: Array<{ version: string; key: string; title: string }> }> {
    const { releases, openCount } = await changelogFor(userId);
    const items = releases.flatMap((r) => r.items.filter((i) => i.open).map((i) => ({ version: r.version, key: i.key, title: i.title })));
    return { count: openCount, items };
}

/**
 * A `/choice` for a key the release never asked about. `moods.mixes.rebuild`
 * is refused too: it is an action, answered through `decideMoodMixes`, which
 * refuses "keep" on a retired mix.
 */
export class UnknownChoiceError extends Error {}

/** Record an explicit answer to one choice. The key must be a `choice` item of that release (else
 * UnknownChoiceError); a later dismissal never overwrites an explicit answer (`dismissRelease`). */
export async function setChoice(params: {
    userId: string;
    version: string;
    key: string;
    enabled: boolean;
}): Promise<void> {
    const { userId, version, key, enabled } = params;
    const release = findRelease(version);
    if (!release || !choicesIn(release).some((c) => c.key === key)) {
        throw new UnknownChoiceError(key);
    }
    await prisma.releaseChoice.upsert({
        where: { userId_key: { userId, key } },
        create: { userId, version, key, enabled, decidedBy: ChoiceDecidedBy.EXPLICIT },
        update: { enabled, decidedBy: ChoiceDecidedBy.EXPLICIT, decidedAt: new Date(), version },
    });
}

/**
 * Close a release for this user: unanswered choices are recorded at their
 * default as DISMISSED; answered ones stay as they are.
 */
export async function dismissRelease(userId: string, version: string): Promise<{
    recordedDefaults: string[];
}> {
    const release = findRelease(version);
    if (!release) return { recordedDefaults: [] };

    // Only the choices this user was actually shown get settled: recording a
    // decline for a question a non-admin was never asked would put a decision
    // on the books that was never theirs to make.
    const asked: Array<{ key: string; defaultValue: boolean }> = [];
    for (const c of choicesIn(release)) {
        if (c.requires === "admin" && !(await isAdminUser(userId))) continue;
        asked.push({ key: c.key, defaultValue: c.defaultValue });
    }
    const recordedDefaults: string[] = [];

    await prisma.$transaction(async (tx) => {
        for (const { key, defaultValue } of asked) {
            const existing = await tx.releaseChoice.findUnique({
                where: { userId_key: { userId, key } },
                select: { decidedBy: true },
            });
            // An explicit yes survives the window being closed.
            if (existing?.decidedBy === ChoiceDecidedBy.EXPLICIT) continue;

            await tx.releaseChoice.upsert({
                where: { userId_key: { userId, key } },
                create: {
                    userId,
                    version,
                    key,
                    enabled: defaultValue,
                    decidedBy: ChoiceDecidedBy.DISMISSED,
                },
                update: { enabled: defaultValue, decidedBy: ChoiceDecidedBy.DISMISSED, version },
            });
            recordedDefaults.push(key);
        }

        await tx.releaseAcknowledgement.upsert({
            where: { userId_version: { userId, version } },
            create: { userId, version },
            update: {},
        });
    });

    if (recordedDefaults.length) {
        logger.debug(
            `[Release] ${version} closed by ${userId}; ${recordedDefaults.length} unanswered ` +
                `choice(s) recorded at their default: ${recordedDefaults.join(", ")}`,
        );
    }
    return { recordedDefaults };
}
