/**
 * Two processes (the server and the worker of the split image) each tell admins once about the same unreadable
 * credential. The notification store keeps one row per admin per `groupKey`, so the admin sees one notice, and a
 * restart brings it back unread until the credential is fixed. Real database; each process is its own copy of the code.
 */
import { prisma } from "../db";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";
import { expectLog } from "../../__tests__/helpers/expectedLogs";
import { decryptSettings, type noteUnreadableCredentials as NoteUnreadableCredentials } from "../encryptedFields";

const ADMIN = "zz-two-processes-admin";
const KEY = "unreadable-credential:fanartApiKey";
// 'xc1.' marks the current format, and the rest is no valid ciphertext: stored, but the key cannot read it.
const unreadable = "xc1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

type Instance = { note: typeof NoteUnreadableCredentials; stop: () => Promise<void> };

/** This code as one more process would load it: no memory of what any other process already told. */
function startProcess(): Instance {
    let instance!: Instance;
    jest.isolateModules(() => {
        const fields = require("../encryptedFields");
        const db = require("../db");
        expectLog("warn", require("../logger").logger);
        instance = {
            note: (resolved, repairing) => fields.noteUnreadableCredentials(resolved, repairing),
            stop: () => db.prisma.$disconnect(),
        };
    });
    return instance;
}

const settings = () => decryptSettings({ fanartApiKey: unreadable });
const rows = () => prisma.notification.findMany({ where: { userId: ADMIN, groupKey: KEY } });

beforeAll(async () => {
    await prisma.user.create({ data: { id: ADMIN, username: ADMIN, passwordHash: "x", role: "admin", tokenVersion: 0 } });
});

afterEach(async () => {
    await prisma.notification.deleteMany({ where: { userId: ADMIN } });
});

afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: ADMIN } });
    await closeEngineConnections();
});

it("shows an admin one notice when two processes send it", async () => {
    const [one, two] = [startProcess(), startProcess()];
    try {
        await Promise.all([one.note(settings(), () => []), two.note(settings(), () => [])]);
    } finally {
        await Promise.all([one.stop(), two.stop()]);
    }

    const found = await rows();
    expect(found).toHaveLength(1);
    expect(found[0]).toEqual(expect.objectContaining({ read: false, cleared: false, title: "Fanart.tv API key cannot be read" }));
});

it("brings a read notice back unread when a process starts and the credential is still unreadable", async () => {
    const first = startProcess();
    const restarted = startProcess();
    try {
        await first.note(settings(), () => []);
        await prisma.notification.updateMany({ where: { userId: ADMIN, groupKey: KEY }, data: { read: true } });
        await restarted.note(settings(), () => []);
    } finally {
        await Promise.all([first.stop(), restarted.stop()]);
    }

    const found = await rows();
    expect(found).toHaveLength(1);
    expect(found[0].read).toBe(false);
});
