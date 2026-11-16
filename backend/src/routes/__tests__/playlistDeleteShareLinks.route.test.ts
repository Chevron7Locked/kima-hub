/**
 * Deleting a playlist, from the web app or a Subsonic app, removes the share links that name it (a share link has no
 * foreign key, so one left behind would dangle), and no other playlist's link. Real database and routers.
 */
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import playlistsRoutes from "../playlists";
import { playlistRouter as subsonicPlaylists } from "../subsonic/playlists";
import { prisma } from "../../utils/db";
import { mountAsServer } from "./helpers/serverMount";

const MARK = "zz-playlist-share";

let userId: string;
let username: string;

const web = express();
web.use(express.json());
mountAsServer(web, "/playlists", playlistsRoutes, "/api/playlists");

const subsonic = express();
subsonic.use((req, _res, next) => {
    (req as any).user = { id: userId };
    next();
});
subsonic.use("/rest", subsonicPlaylists);

const bearer = () => `Bearer ${jwt.sign({ userId, username, role: "user", tokenVersion: 0 }, process.env.JWT_SECRET!, { expiresIn: "1h" })}`;

async function playlistWithLink(tag: string): Promise<string> {
    const playlist = await prisma.playlist.create({ data: { userId, name: `${MARK} ${tag}` } });
    await prisma.shareLink.create({ data: { token: `${MARK}-${tag}`, entityType: "playlist", entityId: playlist.id, createdBy: userId } });
    return playlist.id;
}

const linkTokens = async () =>
    (await prisma.shareLink.findMany({ where: { token: { startsWith: MARK } }, select: { token: true }, orderBy: { token: "asc" } })).map((l) => l.token);

beforeAll(async () => {
    await prisma.user.deleteMany({ where: { username: { startsWith: MARK } } });
    const user = await prisma.user.create({ data: { username: `${MARK}-user`, passwordHash: "x", role: "user" } });
    userId = user.id;
    username = user.username;
});

afterAll(async () => {
    await prisma.user.deleteMany({ where: { username: { startsWith: MARK } } });
});

beforeEach(async () => {
    await prisma.shareLink.deleteMany({ where: { token: { startsWith: MARK } } });
    await prisma.playlist.deleteMany({ where: { name: { startsWith: MARK } } });
});

describe("deleting a playlist removes its share links", () => {
    it("on the web", async () => {
        const gone = await playlistWithLink("web-gone");
        await playlistWithLink("web-stays");

        expect((await request(web).delete(`/playlists/${gone}`).set("Authorization", bearer())).status).toBe(200);

        expect(await prisma.playlist.count({ where: { id: gone } })).toBe(0);
        expect(await linkTokens()).toEqual([`${MARK}-web-stays`]);
    });

    it("through Subsonic deletePlaylist", async () => {
        const gone = await playlistWithLink("sub-gone");
        await playlistWithLink("sub-stays");

        const res = await request(subsonic).get(`/rest/deletePlaylist.view?f=json&id=${gone}`);

        expect(res.body["subsonic-response"].status).toBe("ok");
        expect(await prisma.playlist.count({ where: { id: gone } })).toBe(0);
        expect(await linkTokens()).toEqual([`${MARK}-sub-stays`]);
    });

    it("and a refused delete (another person's playlist) leaves the link", async () => {
        const other = await prisma.user.create({ data: { username: `${MARK}-other`, passwordHash: "x", role: "user" } });
        const playlist = await prisma.playlist.create({ data: { userId: other.id, name: `${MARK} theirs` } });
        await prisma.shareLink.create({ data: { token: `${MARK}-theirs`, entityType: "playlist", entityId: playlist.id, createdBy: other.id } });

        expect((await request(web).delete(`/playlists/${playlist.id}`).set("Authorization", bearer())).status).toBe(403);
        const res = await request(subsonic).get(`/rest/deletePlaylist.view?f=json&id=${playlist.id}`);

        expect(res.body["subsonic-response"].status).toBe("failed");
        expect(await prisma.playlist.count({ where: { id: playlist.id } })).toBe(1);
        expect(await linkTokens()).toEqual([`${MARK}-theirs`]);
    });
});
