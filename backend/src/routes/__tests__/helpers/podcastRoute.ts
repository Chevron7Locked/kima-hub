/** Shared setup for the podcast route tests, which run the real router against the real database. */

/** The auth middleware replaced by one that signs `userId` in. */
export function podcastAuthMock(userId: string) {
    const signIn = (req: any, _res: any, next: any) => {
        req.user = { id: userId, username: "t" };
        next();
    };
    return { requireAuth: signIn, requireAuthOrToken: signIn };
}

/** A 600-second episode published on the given day of October 2026. */
export const episodeOnDay = (id: string, day: number) => ({
    id,
    guid: id,
    title: id,
    audioUrl: `https://a.invalid/${id}.mp3`,
    duration: 600,
    publishedAt: new Date(Date.UTC(2026, 9, day)),
});
