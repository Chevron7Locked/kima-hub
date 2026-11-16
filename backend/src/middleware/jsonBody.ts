import express from "express";
import { mountAccess } from "../routes/mountAccess";

const defaultJsonParser = express.json({ limit: "1mb" });

/** The mounts that carry a large body (the playback state: the whole queue, saved on every change), as the mounts declare them. */
const LARGE_BODY_MOUNTS = Object.entries(mountAccess)
    .filter(([, mount]) => mount.largeJsonBody)
    .map(([path]) => path.toLowerCase());

/**
 * Reads a JSON body of up to 1 MB, in front of every route. A mount that declares `largeJsonBody` (the playback state) is left unread: its mount reads up to
 * 5 MB (`largeJsonBody`) once the access check has passed, so a stranger cannot make the server parse a large body.
 * The path matches by whole segment, so `/api/playback-stateX` gets the small limit here, and without regard to case,
 * the way Express matches the mount: `POST /API/playback-state` reaches the playback state's mount, so it is left for
 * the mount's 5 MB parser and not cut off at 1 MB here.
 */
export const jsonBodyParser: express.RequestHandler = (req, res, next) => {
    const path = req.path.toLowerCase();
    const readByItsMount = LARGE_BODY_MOUNTS.some((mount) => path === mount || path.startsWith(`${mount}/`));
    return readByItsMount ? next() : defaultJsonParser(req, res, next);
};

/** Reads a JSON body of up to 5 MB. A mount that declares `largeJsonBody` gets it after its access check. */
export const largeJsonBody: express.RequestHandler = express.json({ limit: "5mb" });
