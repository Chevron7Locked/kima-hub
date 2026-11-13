/**
 * A grouped alert drops only an identical repeat, judged by its data whatever
 * the key order; a new type, link or value replaces the row and brings it back unread. A repeat
 * stores exactly the data it came with, none when it came with none.
 */

import { prisma } from "../../utils/db";
import { notificationService } from "../notificationService";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

const USER = "nsg_user";
const alert = (type: "system" | "error", href: string) =>
    notificationService.create({ userId: USER, type, title: "Lidarr", message: "Check it", metadata: { href }, groupKey: "nsg" });

beforeAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
});

afterEach(async () => {
    await prisma.notification.deleteMany({ where: { userId: USER } });
});

afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await closeEngineConnections();
});

const markRead = () => prisma.notification.updateMany({ where: { userId: USER }, data: { read: true } });
const only = async () => {
    const rows = await prisma.notification.findMany({ where: { userId: USER } });
    expect(rows).toHaveLength(1);
    return rows[0];
};

it("drops an identical repeat", async () => {
    await alert("error", "/settings#lidarr");
    await markRead();
    await alert("error", "/settings#lidarr");

    expect((await only()).read).toBe(true);
});

it("replaces the row when only the link changes", async () => {
    await alert("error", "/settings#lidarr");
    await markRead();
    await alert("error", "/settings#downloads");

    expect(await only()).toMatchObject({ read: false, metadata: { href: "/settings#downloads" } });
});

it("replaces the row when only the type changes", async () => {
    await alert("error", "/settings#lidarr");
    await markRead();
    await alert("system", "/settings#lidarr");

    expect(await only()).toMatchObject({ read: false, type: "system" });
});

describe("comparing data", () => {
    // jsonb keeps shorter keys first, so "href" is stored ahead of "albumTitle".
    const withData = (metadata: Record<string, unknown>) =>
        notificationService.create({ userId: USER, type: "error", title: "Lidarr", message: "Check it", metadata, groupKey: "nsg" });

    it("drops a repeat whose data matches in a different key order", async () => {
        await withData({ albumTitle: "Blue", href: "/settings#lidarr", nested: { zeta: 1, a: [1, 2] }, gone: undefined });
        await markRead();
        await withData({ nested: { a: [1, 2], zeta: 1 }, href: "/settings#lidarr", albumTitle: "Blue" });

        expect((await only()).read).toBe(true);
    });

    it("replaces the row when the data differs", async () => {
        await withData({ albumTitle: "Blue", href: "/settings#lidarr", nested: { a: [1, 2] } });
        await markRead();
        await withData({ albumTitle: "Blue", href: "/settings#lidarr", nested: { a: [2, 1] } });

        expect(await only()).toMatchObject({ read: false, metadata: { nested: { a: [2, 1] } } });
    });
});

describe("a repeat shows what the new event says", () => {
    const send = (metadata?: Record<string, unknown>) =>
        notificationService.create({ userId: USER, type: "error", title: "Lidarr", message: "Check it", metadata, groupKey: "nsg" });

    it("stores no data when the repeat comes with none", async () => {
        await send({ href: "/settings#lidarr", albumTitle: "Blue" });
        await send();

        const row = await only();
        expect(row.metadata).toBeNull();
        expect(row.read).toBe(false);
    });

    it("stores exactly the new data, none of the old", async () => {
        await send({ href: "/settings#lidarr", albumTitle: "Blue" });
        await send({ href: "/settings#downloads" });

        expect((await only()).metadata).toEqual({ href: "/settings#downloads" });
    });

    it("still drops an identical repeat that came with no data", async () => {
        await send();
        await markRead();
        await send();

        expect((await only()).read).toBe(true);
    });
});
