/**
 * The iPhone app plays a show's first episode with a stream ticket in the address. Real router, auth, database and
 * Redis, so the path the auth check sees is the one a mounted router gives it. A show id that is not a number is
 * answered 404 by the route itself, past the auth check and before any outside service.
 */
import express from "express";
import request from "supertest";
import podcastRoutes from "../podcasts";
import { generateStreamTicket } from "../../middleware/auth";
import { prisma } from "../../utils/db";
import { waitForRedisReady } from "../../utils/redis";

const USER = "u_snippet_ticket";
const app = express();
app.use("/api/podcasts", podcastRoutes);
let ticket: string;

beforeAll(async () => {
    await waitForRedisReady();
    const user = await prisma.user.upsert({ where: { id: USER }, create: { id: USER, username: USER, passwordHash: "x" }, update: {} });
    ticket = generateStreamTicket(user);
});

afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
});

it("lets a stream ticket reach the first-episode sample", async () => {
    const res = await request(app).get("/api/podcasts/preview/not_a_number/snippet").query({ token: ticket });
    expect(res.status).toBe(404);
});

it("takes the ticket as a Bearer credential too", async () => {
    const res = await request(app).get("/api/podcasts/preview/not_a_number/snippet").set("Authorization", `Bearer ${ticket}`);
    expect(res.status).toBe(404);
});

it("answers 404 when the show id hides an encoded slash", async () => {
    const res = await request(app).get("/api/podcasts/preview/a%2Fb/snippet").query({ token: ticket });
    expect(res.status).toBe(404);
});

it("refuses a ticket on a trailing-slash spelling of the sample", async () => {
    const res = await request(app).get("/api/podcasts/preview/not_a_number/snippet/").query({ token: ticket });
    expect(res.status).toBe(401);
});

it.each(["/api/podcasts/preview/not_a_number", "/api/podcasts/preview/not_a_number/similar", "/api/podcasts/for-you"])(
    "refuses a stream ticket on %s, which is not audio",
    async (path) => {
        const res = await request(app).get(path).query({ token: ticket });
        expect(res.status).toBe(401);
    },
);
