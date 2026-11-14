import { Router } from "express";
import { subsonicOk, subsonicError, SubsonicError } from "../../utils/subsonicResponse";
import { wrap } from "./mappers";
import { mapSubsonicUser, requireSubsonicAdmin } from "./userHelpers";
import { one } from "../../utils/subsonicParams";
import { findUserByUsername, normalizeUsername } from "../../services/users/accounts";

export const profileRouter = Router();

profileRouter.all("/getUser.view", wrap(async (req, res) => {
    const given = one(req, "username") ?? "";
    const requested = normalizeUsername(given);
    // Asking about oneself needs no admin, including an account stored with padding, named as stored.
    const isSelf = requested === req.user!.username || given === req.user!.username;
    if (requested && !isSelf && !requireSubsonicAdmin(req, res)) {
        return;
    }

    const target = requested
        ? await findUserByUsername(given, { username: true, role: true })
        : { username: req.user!.username, role: req.user!.role };

    if (!target) {
        return subsonicError(req, res, SubsonicError.NOT_FOUND, "User not found");
    }

    return subsonicOk(req, res, {
        user: mapSubsonicUser(target),
    });
}));