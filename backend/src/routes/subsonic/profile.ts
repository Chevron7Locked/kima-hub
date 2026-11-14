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

    const target = requested
        ? await findUserByUsername(given, { id: true, username: true, role: true })
        : { id: req.user!.id, username: req.user!.username, role: req.user!.role };

    // Asking about oneself needs no admin, whatever name form was typed; anyone else is an admin's to look up.
    if (target?.id !== req.user!.id && !requireSubsonicAdmin(req, res)) {
        return;
    }

    if (!target) {
        return subsonicError(req, res, SubsonicError.NOT_FOUND, "User not found");
    }

    return subsonicOk(req, res, {
        user: mapSubsonicUser(target),
    });
}));