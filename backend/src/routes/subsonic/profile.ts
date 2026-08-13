import { Router } from "express";
import { prisma } from "../../utils/db";
import { subsonicOk, subsonicError, SubsonicError } from "../../utils/subsonicResponse";
import { wrap } from "./mappers";
import { mapSubsonicUser, requireSubsonicAdmin } from "./userHelpers";

export const profileRouter = Router();

profileRouter.all("/getUser.view", wrap(async (req, res) => {
    const requested = req.query.username as string | undefined;
    if (requested && requested !== req.user!.username && !requireSubsonicAdmin(req, res)) {
        return;
    }

    const target = requested
        ? await prisma.user.findUnique({
              where: { username: requested },
              select: { username: true, role: true },
          })
        : { username: req.user!.username, role: req.user!.role };

    if (!target) {
        return subsonicError(req, res, SubsonicError.NOT_FOUND, "User not found");
    }

    return subsonicOk(req, res, {
        user: mapSubsonicUser(target),
    });
}));