import express from "express";

const defaultJsonParser = express.json({ limit: "1mb" });

/** The one route that carries a large body: the whole queue, saved on every change. */
const PLAYBACK_STATE = "/api/playback-state";

/**
 * Reads a JSON body of up to 1 MB, in front of every route. The playback state is left unread: its mount reads up to
 * 5 MB (`largeJsonBody`) once the access check has passed, so a stranger cannot make the server parse a large body.
 * The path matches by whole segment, so `/api/playback-stateX` gets the small limit here.
 */
export const jsonBodyParser: express.RequestHandler = (req, res, next) => {
    const readByItsMount = req.path === PLAYBACK_STATE || req.path.startsWith(`${PLAYBACK_STATE}/`);
    return readByItsMount ? next() : defaultJsonParser(req, res, next);
};

/** Reads a JSON body of up to 5 MB. A mount that declares `largeJsonBody` gets it after its access check. */
export const largeJsonBody: express.RequestHandler = express.json({ limit: "5mb" });
