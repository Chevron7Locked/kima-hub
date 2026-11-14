/**
 * Who may reach each mounted router, by mount path. The families are described in ./access; ./mounts pairs each
 * path with its router. A mount with no entry here refuses everything. A route that differs from its mount is listed
 * under `routes`, written as the router writes it.
 *
 * This file imports no router, so a test can mount one router with the access the server gives it.
 */

import type { Access } from "./access";

export interface MountAccess {
    access: Access;
    /** The per-address runaway limit, in front of the access check. */
    runawayLimit?: boolean;
    /** Reads JSON bodies up to 5 MB, after the access check (see ./access). */
    largeJsonBody?: boolean;
}

const publicAccess: Access = { family: "public" };
const signedIn: Access = { family: "signed-in" };
/** Signed in, where streaming URLs carry the token in `?token=`. */
const signedInByUrlToken: Access = { family: "signed-in", urlToken: true };

export const mountAccess: Record<string, MountAccess> = {
    "/api/auth": {
        access: {
            ...signedIn,
            routes: {
                "POST /login": "public",
                "POST /logout": "public",
                "POST /refresh": "public",
                "GET /users": "admin",
                "POST /create-user": "admin",
                "DELETE /users/:id": "admin",
            },
        },
    },
    "/api/onboarding": {
        access: {
            ...signedIn,
            routes: {
                "POST /register": "public",
                "GET /status": "public",
                "POST /lidarr": "admin",
                "POST /audiobookshelf": "admin",
                "POST /soulseek": "admin",
            },
        },
    },
    "/api/share": {
        access: {
            family: "share-token",
            routes: { "POST /": "signed-in", "DELETE /:token": "signed-in" },
        },
    },
    "/api/api-keys": { access: signedIn, runawayLimit: true },
    "/api/device-link": {
        access: { ...signedInByUrlToken, routes: { "POST /verify": "public" } },
        runawayLimit: true,
    },
    // Closed by default: a route added to the library router is for admins until it is listed here as signed-in.
    // Cover art and the album cover search carry the image limit instead, and streaming carries none (middleware/rateLimiter).
    "/api/library": {
        access: {
            family: "admin",
            urlToken: true,
            routes: {
                "GET /album-cover/:mbid": "signed-in",
                "GET /albums": "signed-in",
                "GET /albums/:id": "signed-in",
                "GET /artist-counts/status": "signed-in",
                "GET /artists": "signed-in",
                "GET /artists/:id": "signed-in",
                "GET /artists/:id/play-tracks": "signed-in",
                "GET /cover-art/:id?": "signed-in",
                "GET /decades": "signed-in",
                "GET /genres": "signed-in",
                "GET /image-backfill/status": "signed-in",
                "GET /radio": "signed-in",
                "GET /radio/row": "signed-in",
                "GET /radio/stations": "signed-in",
                "GET /recently-added": "signed-in",
                "GET /recently-listened": "signed-in",
                "GET /scan/status/:jobId": "signed-in",
                "GET /tracks": "signed-in",
                "GET /tracks/:id": "signed-in",
                "GET /tracks/:id/lyrics": "signed-in",
                "GET /tracks/:id/stream": "signed-in",
                "GET /tracks/:id/waveform": "signed-in",
                "GET /tracks/shuffle": "signed-in",
                "POST /tracks/:id/prewarm": "signed-in",
            },
        },
        runawayLimit: true,
    },
    "/api/plays": { access: signedIn, runawayLimit: true },
    "/api/whats-new": { access: signedIn, runawayLimit: true },
    "/api/stats": { access: signedIn, runawayLimit: true },
    "/api/settings": {
        access: { ...signedIn, routes: { "POST /cleanup-stale-jobs": "admin" } },
        runawayLimit: true,
    },
    "/api/system-settings": {
        access: { family: "admin", routes: { "GET /public-config": "signed-in" } },
        runawayLimit: true,
    },
    // No runaway limit: playback state syncs often. It saves the whole queue, so it reads a body of up to 5 MB, once
    // the access check has passed.
    "/api/playback-state": { access: signedIn, largeJsonBody: true },
    "/api/playlists": { access: signedInByUrlToken, runawayLimit: true },
    "/api/search": { access: signedIn, runawayLimit: true },
    "/api/recommendations": { access: signedInByUrlToken, runawayLimit: true },
    "/api/downloads": {
        access: { ...signedInByUrlToken, routes: { "POST /clear-lidarr-queue": "admin" } },
        runawayLimit: true,
    },
    "/api/notifications": { access: signedIn, runawayLimit: true },
    // The router applies the webhook limit, which lets requests carrying the secret through.
    "/api/webhooks": { access: { family: "webhook" } },
    // The cover stays reachable without a session: lock-screen artwork requests it that way, so the runaway limit is
    // its only bound. The stream route accepts a token in the URL.
    "/api/audiobooks": {
        access: {
            ...signedInByUrlToken,
            routes: { "GET /:id/cover": "public", "OPTIONS /:id/cover": "public" },
        },
        runawayLimit: true,
    },
    // Images and the audio routes take a token in the URL; the rest want a session, key or header.
    "/api/podcasts": {
        access: {
            ...signedIn,
            urlToken: [
                "GET /categories",
                "GET /charts",
                "GET /discover/top",
                "GET /discover/genres",
                "GET /discover/genre/:genreId",
                "GET /preview/:itunesId/snippet",
                "GET /:id/similar",
                "GET /:id/cover",
                "GET /episodes/:episodeId/cover",
                "GET /:podcastId/episodes/:episodeId/stream",
            ],
        },
        runawayLimit: true,
    },
    "/api/artists": { access: signedInByUrlToken, runawayLimit: true },
    "/api/soulseek": {
        access: { ...signedIn, routes: { "POST /connect": "admin", "POST /disconnect": "admin" } },
        runawayLimit: true,
    },
    "/api/discover": {
        access: {
            ...signedInByUrlToken,
            routes: { "POST /cleanup-lidarr": "admin", "POST /fix-tagging": "admin" },
        },
        runawayLimit: true,
    },
    "/api/mixes": { access: signedInByUrlToken, runawayLimit: true },
    // Closed by default, like the library: a route added to the enrichment router is for admins until it is listed here.
    "/api/enrichment": {
        access: {
            family: "admin",
            routes: {
                "GET /concurrency": "signed-in",
                "GET /failures": "signed-in",
                "GET /failures/counts": "signed-in",
                "GET /progress": "signed-in",
                "GET /status": "signed-in",
            },
        },
        runawayLimit: true,
    },
    "/api/spotify": { access: signedInByUrlToken, runawayLimit: true },
    "/api/browse": { access: signedInByUrlToken, runawayLimit: true },
    // The analyzers report here with the server's own secret.
    "/api/analysis": {
        access: { family: "admin", routes: { "POST /vibe/failure": "internal", "POST /vibe/success": "internal" } },
        runawayLimit: true,
    },
    "/api/releases": { access: signedInByUrlToken, runawayLimit: true },
    "/api/vibe": { access: signedIn, runawayLimit: true },
    // Read-only public vibe feed, mounted only when KIMA_PUBLIC_VIBE=true.
    "/api/public/vibe": { access: { family: "internal" }, runawayLimit: true },
    "/api/system": { access: signedIn, runawayLimit: true },
    "/api/events/ticket": { access: signedInByUrlToken, runawayLimit: true },
    // Public: the stream proves itself with the one-time ticket the route reads; long-lived, so no runaway limit.
    "/api/events": { access: publicAccess },
    // Subsonic limits and signs in its own requests.
    "/rest": { access: { family: "subsonic" } },
    "/health": { access: publicAccess },
    "/api/health": { access: publicAccess },
    // The queue dashboard (Bull Board) takes its place here (routes/mounts `mountQueueBoardSlot`), and its router is put
    // in the place once the workers have started, so its path is declared here with the rest.
    "/api/admin/queues": { access: { family: "admin" } },
    // The runaway limit comes first, so a looping client is held before the sign-in check.
    "/api/metrics": { access: { family: "admin" }, runawayLimit: true },
};
