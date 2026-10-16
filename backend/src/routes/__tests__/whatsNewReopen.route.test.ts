/**
 * GET /whats-new/current reads the newest release again, closed or not, with only the items that apply to the
 * user and what they already answered. A small fixture release stands in for the catalogue, so the test does not
 * change with each release: one item for everyone, one admin-only choice. Real router, database and auth.
 */
import type { Release } from "../../services/releases/catalog";

const FIXTURE: Release = {
    version: "9.0.0",
    title: "Kima 9",
    summary: "A fixture release.",
    date: "2099-01-01",
    items: [
        { kind: "note", key: "fixture.note", title: "For everyone", summary: "s", body: "b" },
        { kind: "choice", key: "fixture.admin", title: "For admins", summary: "s", body: "b", defaultValue: false, requires: "admin" },
    ],
};
jest.mock("../../services/releases/catalog", () => {
    const actual = jest.requireActual("../../services/releases/catalog");
    return { ...actual, RELEASES: [FIXTURE], findRelease: (v: string) => (v === FIXTURE.version ? FIXTURE : undefined) };
});

import express from "express";
import request from "supertest";
import { prisma } from "../../utils/db";
import { generateToken } from "../../middleware/auth";
import whatsNewRoutes from "../whatsNew";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

const USER = "whatsnew_reopen_user";
const ADMIN = "whatsnew_reopen_admin";

function app() {
    const a = express();
    a.use(express.json());
    a.use("/whats-new", whatsNewRoutes);
    return a;
}

const as = (id: string, role: "user" | "admin") => `Bearer ${generateToken({ id, username: id, role, tokenVersion: 0 })}`;
const keys = (body: { release: { items: Array<{ key: string }> } }) => body.release.items.map((i) => i.key);

beforeAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [USER, ADMIN] } } });
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
    await prisma.user.create({ data: { id: ADMIN, username: ADMIN, passwordHash: "x", role: "admin", tokenVersion: 0 } });
});

afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [USER, ADMIN] } } });
    await closeEngineConnections();
});

it("reads the closed current release again, with only this user's items", async () => {
    expect((await request(app()).post(`/whats-new/${FIXTURE.version}/dismiss`).set("Authorization", as(USER, "user")).send({})).status).toBe(200);

    const pending = await request(app()).get("/whats-new/pending").set("Authorization", as(USER, "user"));
    expect(pending.body.releases.map((r: { version: string }) => r.version)).not.toContain(FIXTURE.version);

    const again = await request(app()).get("/whats-new/current").set("Authorization", as(USER, "user"));
    expect(again.status).toBe(200);
    expect(again.body.release.version).toBe(FIXTURE.version);
    expect(keys(again.body)).toEqual(["fixture.note"]);
    expect(again.body.answers).toEqual({});
});

it("gives an admin the admin-only choice too, with the answer they gave", async () => {
    const answered = await request(app())
        .post(`/whats-new/${FIXTURE.version}/choice`)
        .set("Authorization", as(ADMIN, "admin"))
        .send({ key: "fixture.admin", enabled: true });
    expect(answered.status).toBe(200);

    const asAdmin = await request(app()).get("/whats-new/current").set("Authorization", as(ADMIN, "admin"));
    expect(asAdmin.status).toBe(200);
    expect(keys(asAdmin.body)).toEqual(["fixture.note", "fixture.admin"]);
    expect(asAdmin.body.answers).toEqual({ "fixture.admin": true });

    const asUser = await request(app()).get("/whats-new/current").set("Authorization", as(USER, "user"));
    expect(keys(asUser.body)).toEqual(["fixture.note"]);
    expect(asUser.body.answers).toEqual({});
});

it("needs a signed-in user", async () => {
    expect((await request(app()).get("/whats-new/current")).status).toBe(401);
});
