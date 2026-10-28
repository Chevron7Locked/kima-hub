/**
 * Which Kima server a test run may talk to. Kept free of other imports so the
 * Playwright config and the sign-in setup can load it without needing a login.
 */

/** Port the real, in-use Kima server listens on. No test run may ever target it. */
const PRODUCTION_PORT = "3030";

/** The host:port of a URL, with the scheme's default port filled in. */
export function hostPort(url: string): string {
    const u = new URL(url);
    const port = u.port || (u.protocol === "https:" ? "443" : "80");
    return `${u.hostname}:${port}`;
}

/**
 * The server address the tests run against, taken only from KIMA_UI_BASE_URL.
 * There is no default: a missing address, or one on the production port, stops the run.
 */
export function requireBaseUrl(): string {
    const value = process.env.KIMA_UI_BASE_URL;
    if (!value) {
        throw new Error(
            "KIMA_UI_BASE_URL is not set. Set it to the address of the test server " +
                "(for example http://127.0.0.1:3056). The tests never choose a server on their own.",
        );
    }
    let target: string;
    try {
        target = hostPort(value);
    } catch {
        throw new Error(`KIMA_UI_BASE_URL is not a web address: "${value}"`);
    }
    if (target.endsWith(`:${PRODUCTION_PORT}`)) {
        throw new Error(
            `KIMA_UI_BASE_URL points at port ${PRODUCTION_PORT}, which is the production Kima server. ` +
                "These tests never run against it. Point KIMA_UI_BASE_URL at a test server.",
        );
    }
    return value;
}

/** The playlist name that marks an account as a disposable copy of a real one. */
export const TEST_COPY_MARKER = "__kima-test-copy__";

export type DestructiveVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Whether tests that permanently delete play history may run against this server.
 * All three must hold: the server is on the exact-address allowlist (never the
 * production port), the run was opted in for exactly this address, and the
 * signed-in account owns a playlist named TEST_COPY_MARKER.
 *
 * @param playlistNames names of the playlists the signed-in user owns
 */
export function destructiveVerdict(baseUrl: string, playlistNames: () => Promise<string[]>): Promise<DestructiveVerdict> {
    return (async (): Promise<DestructiveVerdict> => {
        const target = hostPort(baseUrl);
        if (target.endsWith(`:${PRODUCTION_PORT}`)) {
            return { ok: false, reason: `${target} is the production port` };
        }
        const allowed = (process.env.KIMA_STATS_ALLOWED_TARGETS ?? "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        if (!allowed.includes(target)) {
            return { ok: false, reason: `${target} is not listed in KIMA_STATS_ALLOWED_TARGETS` };
        }
        if (process.env.KIMA_STATS_DESTRUCTIVE_OK !== target) {
            return { ok: false, reason: `KIMA_STATS_DESTRUCTIVE_OK is not set to exactly ${target}` };
        }
        // A copy is marked by giving its test account a playlist with this name; a real account has none.
        const names = await playlistNames();
        if (!names.includes(TEST_COPY_MARKER)) {
            return { ok: false, reason: `the signed-in account has no playlist named ${TEST_COPY_MARKER}, so it is not a marked test copy` };
        }
        return { ok: true };
    })();
}
