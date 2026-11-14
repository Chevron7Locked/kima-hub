import express from "express";

const defaultJsonParser = express.json({ limit: "1mb" });
const largeJsonParser = express.json({ limit: "5mb" });

/** The one route that carries a large body: the whole queue, saved on every change. */
const PLAYBACK_STATE = "/api/playback-state";

/**
 * Reads a JSON body: 5 MB for the playback state, 1 MB for everything else. The path matches by whole segment, so
 * `/api/playback-stateX` gets the small limit. It runs before the access check, so the body is read first.
 */
export const jsonBodyParser: express.RequestHandler = (req, res, next) => {
    const large = req.path === PLAYBACK_STATE || req.path.startsWith(`${PLAYBACK_STATE}/`);
    return (large ? largeJsonParser : defaultJsonParser)(req, res, next);
};
