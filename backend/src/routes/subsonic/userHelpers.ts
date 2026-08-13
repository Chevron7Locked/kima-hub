import { Request, Response } from "express";
import { subsonicError, SubsonicError } from "../../utils/subsonicResponse";

/**
 * True (and writes nothing) if the caller is an admin. False AND writes the
 * shared "Admin privileges required" Subsonic error otherwise -- callers
 * that need to check compose this with `&&`, e.g.
 * `if (!requireSubsonicAdmin(req, res)) return;` for a route that is ALWAYS
 * admin-only, or `if (target !== self && !requireSubsonicAdmin(req, res)) return;`
 * for one that allows a self-operation too -- `&&` short-circuits, so the
 * error is only written when the check actually needed to run.
 *
 * Pulled out because six call sites across this directory
 * (`getUsers.view`/`createUser.view`/`updateUser.view`/`deleteUser.view`/
 * `changePassword.view` in userManagement.ts, `getUser.view` in profile.ts,
 * and now `startScan.view` in index.ts) each independently wrote
 * `req.user!.role !== "admin"` -- exactly the "one rule, several
 * near-identical inline copies" shape that has already produced real bugs on
 * this track (see `vibeProfileService.ts`'s `hasMoodSignal` for the social
 * layer's version of the same lesson): `startScan.view` was simply missing
 * its copy, letting any authenticated user trigger a full library scan. A
 * shared function can't be silently missing a call site the way a
 * copy-pasted inline check can be silently missing from one.
 *
 * Not built on the existing `requireAdmin` middleware (middleware/auth.ts):
 * that's an Express middleware taking `(req, res, next)`, and most routes in
 * this directory are wrapped in `wrap()` (./mappers), which is arity-2 and
 * not generic over its request type -- `wrap(requireAdmin)` doesn't compose
 * the way it looks like it should. Fixing that is a real change to
 * mappers.ts, a wire-contract file; this helper removes the duplication
 * without waiting on it.
 */
export function requireSubsonicAdmin(req: Request, res: Response): boolean {
    if (req.user!.role !== "admin") {
        subsonicError(req, res, SubsonicError.NOT_AUTHORIZED, "Admin privileges required");
        return false;
    }
    return true;
}

export function mapSubsonicUser(user: { username: string; role: string }) {
    return {
        "@_username": user.username,
        "@_scrobblingEnabled": true,
        "@_adminRole": user.role === "admin",
        "@_settingsRole": true,
        "@_downloadRole": true,
        "@_uploadRole": false,
        "@_playlistRole": true,
        "@_coverArtRole": false,
        "@_commentRole": false,
        "@_podcastRole": false,
        "@_streamRole": true,
        "@_jukeboxRole": false,
        "@_shareRole": false,
        folder: [1],
    };
}

export function decodeSubsonicPassword(raw: string): string {
    if (raw.startsWith("enc:")) {
        const hex = raw.slice(4);
        if (/^[0-9a-fA-F]+$/.test(hex) && hex.length % 2 === 0) {
            return Buffer.from(hex, "hex").toString("utf8");
        }
    }
    return raw;
}