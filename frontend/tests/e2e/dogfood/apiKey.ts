import { expect, type Page } from "@playwright/test";

/**
 * Creates an API key named `keyName` for the signed-in user, runs `run` with its plaintext, and
 * revokes the key afterwards even if `run` throws.
 */
export async function withApiKey<T>(page: Page, token: string, keyName: string, run: (apiKey: string) => Promise<T>): Promise<T> {
    const headers = { Authorization: `Bearer ${token}` };
    const made = await page.request.post("/api/api-keys", { data: { deviceName: keyName }, headers });
    expect(made.ok(), `provisioning an API key returned ${made.status()}`).toBeTruthy();
    const apiKey = (await made.json()).apiKey as string;
    expect(apiKey, "the key was created but no plaintext came back").toBeTruthy();
    try {
        return await run(apiKey);
    } finally {
        const list = await page.request.get("/api/api-keys", { headers });
        if (list.ok()) {
            const keys = (await list.json()).apiKeys as Array<{ id: string; name?: string }>;
            const mine = keys.find((k) => (k.name ?? "").includes(keyName));
            if (mine) await page.request.delete(`/api/api-keys/${mine.id}`, { headers }).catch(() => {});
        }
    }
}
