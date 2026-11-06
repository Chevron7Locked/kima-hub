/**
 * The Lidarr webhook gets Kima's secret as a header, and Kima saves the
 * secret only when Lidarr kept that header. Lidarr's test event then tells
 * admins whether Lidarr can reach Kima.
 */

const lidarr = { get: jest.fn(), put: jest.fn(), post: jest.fn() };
jest.mock("../lidarrClient", () => ({
    ...jest.requireActual("../lidarrClient"),
    createLidarrClient: () => lidarr,
}));
jest.mock("../../utils/db", () => ({ prisma: { systemSettings: { update: jest.fn() } } }));
jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn(),
    invalidateSystemSettingsCache: jest.fn(),
}));
const notifyAdmins = jest.fn();
const resolve = jest.fn();
jest.mock("../notificationService", () => ({ notificationService: { notifyAdmins, resolve } }));
jest.mock("../../utils/encryptedFields", () => ({
    encryptSettings: (s: Record<string, string>) => ({ lidarrWebhookSecret: `enc:${s.lidarrWebhookSecret}` }),
}));

import { prisma } from "../../utils/db";
import { getSystemSettings } from "../../utils/systemSettings";
import { configureLidarrWebhook, WEBHOOK_SECRET_HEADER } from "../lidarrWebhookSetup";

const update = prisma.systemSettings.update as jest.Mock;
const sentHeaders = (call: any[]) => call[1].fields.find((f: any) => f.name === "headers").value;
const echo = (_url: string, body: any) => Promise.resolve({ data: body });

beforeEach(() => {
    jest.clearAllMocks();
    lidarr.get.mockResolvedValue({ data: [] });
});

it("creates the webhook with a new secret and saves it once Lidarr keeps it", async () => {
    (getSystemSettings as jest.Mock).mockResolvedValue({ lidarrWebhookSecret: null, unreadableFields: [] });
    lidarr.post.mockImplementation(echo);

    await configureLidarrWebhook("http://lidarr", "key");

    const [header] = sentHeaders(lidarr.post.mock.calls[0]);
    expect(header.key).toBe(WEBHOOK_SECRET_HEADER);
    expect(header.value).toMatch(/^[0-9a-f]{64}$/);
    expect(update).toHaveBeenCalledWith({
        where: { id: "default" },
        data: { lidarrWebhookSecret: `enc:${header.value}` },
    });
});

it("reuses the stored secret on the existing webhook without saving again", async () => {
    (getSystemSettings as jest.Mock).mockResolvedValue({ lidarrWebhookSecret: "kept", unreadableFields: [] });
    lidarr.get.mockResolvedValue({ data: [{ id: 3, name: "Kima", implementation: "Webhook", fields: [] }] });
    lidarr.put.mockImplementation(echo);

    await configureLidarrWebhook("http://lidarr", "key");

    expect(lidarr.put.mock.calls[0][0]).toBe("/api/v1/notification/3?forceSave=true");
    expect(sentHeaders(lidarr.put.mock.calls[0])).toEqual([{ key: WEBHOOK_SECRET_HEADER, value: "kept" }]);
    expect(update).not.toHaveBeenCalled();
});

it("does not save a secret Lidarr dropped", async () => {
    (getSystemSettings as jest.Mock).mockResolvedValue({ lidarrWebhookSecret: null, unreadableFields: [] });
    lidarr.post.mockImplementation((_url: string, body: any) =>
        Promise.resolve({ data: { ...body, fields: body.fields.filter((f: any) => f.name !== "headers") } })
    );

    await configureLidarrWebhook("http://lidarr", "key");

    expect(update).not.toHaveBeenCalled();
});

describe("Lidarr's test event", () => {
    beforeEach(() => {
        (getSystemSettings as jest.Mock).mockResolvedValue({ lidarrWebhookSecret: "kept", unreadableFields: [] });
    });

    it("is sent with the saved webhook and clears the alert when it arrives", async () => {
        lidarr.post.mockImplementation((url: string, body: any) =>
            Promise.resolve({ data: url.startsWith("/api/v1/notification/test") ? "{}" : { ...body, id: 7 } })
        );

        await configureLidarrWebhook("http://lidarr", "key");

        const [url, body] = lidarr.post.mock.calls[1];
        expect(url).toBe("/api/v1/notification/test");
        expect(body.id).toBe(7);
        expect(resolve).toHaveBeenCalledWith("lidarr-callback");
        expect(notifyAdmins).not.toHaveBeenCalled();
    });

    it("tells admins what Lidarr said when it cannot reach Kima", async () => {
        lidarr.post.mockImplementation((url: string, body: any) =>
            url.startsWith("/api/v1/notification/test")
                ? Promise.reject({
                      message: "Request failed with status code 400",
                      response: { data: [{ propertyName: "Url", errorMessage: "Unable to post to webhook: Name does not resolve" }] },
                  })
                : Promise.resolve({ data: body })
        );

        await configureLidarrWebhook("http://lidarr", "key");

        expect(notifyAdmins).toHaveBeenCalledWith(
            expect.objectContaining({
                title: "Lidarr cannot reach Kima",
                groupKey: "lidarr-callback",
                message: expect.stringContaining("Name does not resolve"),
            })
        );
        expect(notifyAdmins.mock.calls[0][0].message).toContain("http://host.docker.internal:3030/api/webhooks/lidarr");
        expect(resolve).not.toHaveBeenCalled();
    });
});
