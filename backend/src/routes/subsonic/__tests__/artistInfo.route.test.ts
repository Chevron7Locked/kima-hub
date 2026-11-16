/**
 * getArtistInfo2 lists the similar artists the library holds, including ones
 * whose names carry accents or an ampersand. Real router, real database.
 */
import express from "express";
import request from "supertest";
import { prisma } from "../../../utils/db";
import { normalizeArtistName } from "../../../services/artistIdentity";
import { artistInfoRouter } from "../artistInfo";
import { closeEngineConnections } from "../../../__tests__/helpers/engineConnections";

const P = "sbinfo";

async function artist(key: string, name: string, similarArtistsJson?: object) {
    await prisma.artist.create({
        data: { id: `${P}${key}`, name, normalizedName: normalizeArtistName(name), identityKey: `${P}-${key}`, similarArtistsJson },
    });
}

const app = express();
app.use((req: any, _res, next) => {
    req.user = { id: `${P}usr`, username: "tester", role: "user" };
    next();
});
app.use("/rest", artistInfoRouter);

beforeAll(async () => {
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await artist("b", "Beyoncé");
    await artist("sg", "Simon & Garfunkel");
    await artist("main", "Destiny's Child", [
        { name: "Beyoncé", match: 0.9 },
        { name: "Simon & Garfunkel", match: 0.4 },
        { name: "Nobody In The Library", match: 0.3 },
    ]);
});

afterAll(async () => {
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await closeEngineConnections();
});

// Express routes a call whatever its letter case, so the key follows the route that answered, not the path's text.
it("answers getArtistInfo2 under artistInfo2 and the legacy getArtistInfo under artistInfo, however the name is cased", async () => {
    const v2 = await request(app).get(`/rest/getartistinfo2.view?id=${P}main&f=json`);
    expect(v2.body["subsonic-response"].artistInfo2).toBeDefined();
    const legacy = await request(app).get(`/rest/getArtistInfo.view?id=${P}main&f=json`);
    expect(legacy.body["subsonic-response"].artistInfo).toBeDefined();
    expect(legacy.body["subsonic-response"].artistInfo2).toBeUndefined();
});

it("names similar artists whose names carry accents or an ampersand", async () => {
    const res = await request(app).get(`/rest/getArtistInfo2.view?id=${P}main&f=json`);
    expect(res.status).toBe(200);
    const similar = res.body["subsonic-response"].artistInfo2.similarArtist;
    expect(similar.map((a: { name: string }) => a.name)).toEqual(["Beyoncé", "Simon & Garfunkel"]);
});
