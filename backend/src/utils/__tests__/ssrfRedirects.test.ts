/**
 * validateUrlForFetch checks only the address it is given; a host it allows can redirect elsewhere. The guards make
 * every hop pass the same check. A real local server plays the host; 127.0.0.1 and localhost are internal addresses.
 */
jest.mock("dns/promises", () => {
    // allowed.test stands for a public host; everything else resolves for real.
    const actual = jest.requireActual("dns/promises");
    return { ...actual, lookup: (host: string, ...rest: unknown[]) => (host === "allowed.test" ? Promise.resolve({ address: "93.184.216.34", family: 4 }) : actual.lookup(host, ...rest)) };
});

import http from "http";
import type { AddressInfo } from "net";
import axios from "axios";
import { fetchChecked, guardedAxios, isBlockedFetch, isBlockedIp, validateUrlForFetch } from "../ssrf";

let host: http.Server;
let port = 0;
let reachedSecret = 0;

beforeAll(async () => {
    host = http.createServer((req, res) => {
        if (req.url === "/to-metadata") {
            res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" });
        } else if (req.url === "/to-mapped") {
            // 127.0.0.1 written as an IPv4-mapped IPv6 address, as a URL parser normalises it.
            res.writeHead(302, { Location: `http://[::ffff:7f00:1]:${port}/secret` });
        } else if (req.url === "/to-name") {
            res.writeHead(302, { Location: `http://localhost:${port}/secret` });
        } else if (req.url === "/secret") {
            reachedSecret++;
            res.writeHead(200);
        } else {
            res.writeHead(200);
        }
        res.end("ok");
    });
    await new Promise<void>((ok) => host.listen(0, "127.0.0.1", () => ok()));
    port = (host.address() as AddressInfo).port;
});

afterAll(() => new Promise<void>((ok) => host.close(() => ok())));
beforeEach(() => {
    reachedSecret = 0;
});

describe("guardedAxios", () => {
    it("is needed: plain axios follows the redirect to the internal address", async () => {
        await axios.get(`http://127.0.0.1:${port}/to-name`, { timeout: 5000 });
        expect(reachedSecret).toBe(1);
    });

    it("refuses a redirect to an internal IP before connecting", async () => {
        await expect(axios.get(`http://127.0.0.1:${port}/to-metadata`, { ...guardedAxios, timeout: 5000 })).rejects.toThrow(
            /Blocked: redirect to internal address 169\.254\.169\.254/,
        );
    });

    it("refuses a redirect to an internal address written in IPv6 form, and says it refused", async () => {
        const error = await axios.get(`http://127.0.0.1:${port}/to-mapped`, { ...guardedAxios, timeout: 5000 }).catch((e) => e);
        expect(reachedSecret).toBe(0);
        expect(isBlockedFetch(error)).toBe(true);
    });

    it("refuses a redirect to a name that resolves to an internal address", async () => {
        await expect(axios.get(`http://127.0.0.1:${port}/to-name`, { ...guardedAxios, timeout: 5000 })).rejects.toThrow(
            /Blocked: localhost is an internal address/,
        );
        expect(reachedSecret).toBe(0);
    });

    it("refuses a first address whose name resolves to an internal address", async () => {
        await expect(axios.get(`http://localhost:${port}/secret`, { ...guardedAxios, timeout: 5000 })).rejects.toThrow(/Blocked/);
        expect(reachedSecret).toBe(0);
    });
});

describe("fetchChecked", () => {
    const realFetch = global.fetch;
    afterEach(() => {
        global.fetch = realFetch;
    });
    const redirect = (to: string) => new Response(null, { status: 302, headers: { Location: to } });

    it("checks the first address", async () => {
        await expect(fetchChecked(`http://127.0.0.1:${port}/`)).rejects.toThrow(/Blocked: Blocked: internal address/);
    });

    it("checks every address it is redirected to, before fetching it", async () => {
        const fetchMock = jest.fn().mockResolvedValueOnce(redirect("http://169.254.169.254/latest/meta-data/"));
        global.fetch = fetchMock;
        await expect(fetchChecked("http://allowed.test/cover.jpg")).rejects.toThrow(/Blocked: Blocked: internal address/);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("follows a redirect between allowed addresses", async () => {
        const fetchMock = jest
            .fn()
            .mockResolvedValueOnce(redirect("/moved.jpg"))
            .mockResolvedValueOnce(new Response("image", { status: 200 }));
        global.fetch = fetchMock;
        const res = await fetchChecked("http://allowed.test/cover.jpg");
        expect(res.status).toBe(200);
        expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(["http://allowed.test/cover.jpg", "http://allowed.test/moved.jpg"]);
        expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
    });
});

describe("which addresses are internal", () => {
    it.each([
        ["127.0.0.1", true], ["10.1.2.3", true], ["172.16.0.1", true], ["172.32.0.1", false], ["192.168.1.1", true],
        ["169.254.169.254", true], ["100.64.0.1", true], ["0.0.0.0", true], ["224.0.0.1", true], ["8.8.8.8", false],
        ["::1", true], ["::", true], ["::ffff:7f00:1", true], ["::ffff:127.0.0.1", true], ["::ffff:a9fe:a9fe", true],
        ["::7f00:1", true], ["fd12:3456::1", true], ["fe80::1", true], ["ff02::1", true],
        ["64:ff9b::7f00:1", true], ["64:ff9b::808:808", false], ["2606:4700:4700::1111", false], ["not-an-ip", true],
    ])("%s → %s", (ip, internal) => {
        expect(isBlockedIp(ip)).toBe(internal);
    });

    it("checks an address written as the host itself, without a name lookup", async () => {
        expect(await validateUrlForFetch("http://[::ffff:7f00:1]/")).toMatch(/internal address/);
        expect(await validateUrlForFetch("http://[2606:4700:4700::1111]/")).toBeNull();
    });
});
