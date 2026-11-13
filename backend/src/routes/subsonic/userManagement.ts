import { Router } from "express";
import { prisma } from "../../utils/db";
import { subsonicOk } from "../../utils/subsonicResponse";
import { wrap } from "./mappers";
import { mapSubsonicUser, requireSubsonicAdmin } from "./userHelpers";

export const userManagementRouter = Router();

userManagementRouter.all("/getUsers.view", wrap(async (req, res) => {
    if (!requireSubsonicAdmin(req, res)) return;

    const users = await prisma.user.findMany({
        select: {
            username: true,
            role: true,
        },
        orderBy: { username: "asc" },
    });

    return subsonicOk(req, res, {
        users: {
            user: users.map(mapSubsonicUser),
        },
    });
}));
