/** The code a pending-song retry answers with, beside its text, when Soulseek has no files for the song (404). */
const NO_SOURCES_CODE = "NO_SOURCES";

export interface RetryNotice {
    title: string;
    message?: string;
}

/**
 * What to tell the person when retrying pending songs fails: a song Soulseek has no files for (404 `NO_SOURCES`), Soulseek
 * itself not answering (502, with the reason in `error`), or anything else. The code is read, never the server's words.
 * `generic` is the title for the anything-else case, which differs between one song and all of them.
 */
export function retryNotice(error: unknown, generic: string): RetryNotice {
    const { status, data } = (error ?? {}) as { status?: number; data?: { code?: unknown; message?: unknown; error?: unknown } };
    if (status === 404 && data?.code === NO_SOURCES_CODE) {
        return { title: "Track not found on Soulseek", message: typeof data.message === "string" ? data.message : undefined };
    }
    if (status === 502) {
        return { title: "Soulseek is not answering", message: typeof data?.error === "string" ? data.error : undefined };
    }
    return { title: generic };
}
