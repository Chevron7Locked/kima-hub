/**
 * validateUrlForFetch checks only the address it is given; a host it allows can redirect elsewhere. The guards make
 * every hop pass the same check. A real local server plays a public host (__tests__/helpers/publicHost); 127.0.0.1
 * and localhost are internal addresses.
 */
jest.mock("dns/promises", () => {
    // allowed.test and rebind.test stand for public hosts when checked; everything else resolves for real.
    const actual = jest.requireActual("dns/promises");
    const publicHost = (host: string) => host === "allowed.test" || host === "rebind.test";
    // A name under .invalid never resolves (RFC 6761), so it is answered "not found" here instead of asking a resolver.
    const neverResolves = (host: string) => host.endsWith(".invalid");
    return {
        ...actual,
        lookup: (host: string, ...rest: unknown[]) =>
            publicHost(host)
                ? Promise.resolve({ address: "93.184.216.34", family: 4 })
                : neverResolves(host)
                  ? Promise.reject(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND", hostname: host }))
                  : actual.lookup(host, ...rest),
    };
});
jest.mock("dns", () => {
    // ...but rebind.test answers this machine when the connection is made: a name that changes its answer.
    const actual = jest.requireActual("dns");
    const lookup = (host: string, options: any, callback: any) =>
        host === "rebind.test"
            ? (options?.all ? callback(null, [{ address: "127.0.0.1", family: 4 }]) : callback(null, "127.0.0.1", 4))
            : actual.lookup(host, options, callback);
    return { ...actual, __esModule: true, default: { ...actual, lookup }, lookup };
});

import http from "http";
import type { AddressInfo } from "net";
import axios from "axios";
import {
    BlockedAddressError,
    InvalidAddressError,
    UnresolvedAddressError,
    fetchChecked,
    guardedAxios,
    isBlockedFetch,
    isBlockedIp,
    validateUrlForFetch,
} from "../ssrf";
import { upstreamFailure } from "../upstream";
import { publicUrl, routePublicHost } from "../../__tests__/helpers/publicHost";

let PUBLIC = "";

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
    routePublicHost();
    PUBLIC = publicUrl(port);
});

afterAll(() => {
    jest.restoreAllMocks();
    return new Promise<void>((ok) => host.close(() => ok()));
});
beforeEach(() => {
    reachedSecret = 0;
});

describe("guardedAxios", () => {
    it("is needed: plain axios follows the redirect to the internal address", async () => {
        await axios.get(`${PUBLIC}/to-name`, { timeout: 5000 });
        expect(reachedSecret).toBe(1);
    });

    it("refuses a first address written as an internal IP, before connecting", async () => {
        const error = await axios.get(`http://127.0.0.1:${port}/secret`, { ...guardedAxios, timeout: 5000 }).catch((e) => e);
        expect(isBlockedFetch(error)).toBe(true);
        expect(String(error.message)).toMatch(/Blocked: 127\.0\.0\.1 is an internal address/);
        expect(reachedSecret).toBe(0);
    });

    it("reaches a public address", async () => {
        expect((await axios.get(`${PUBLIC}/`, { ...guardedAxios, timeout: 5000 })).status).toBe(200);
    });

    it("refuses a redirect to an internal IP before connecting", async () => {
        await expect(axios.get(`${PUBLIC}/to-metadata`, { ...guardedAxios, timeout: 5000 })).rejects.toThrow(
            /Blocked: 169\.254\.169\.254 is an internal address/,
        );
    });

    it("refuses a redirect to an internal address written in IPv6 form, and says it refused", async () => {
        const error = await axios.get(`${PUBLIC}/to-mapped`, { ...guardedAxios, timeout: 5000 }).catch((e) => e);
        expect(reachedSecret).toBe(0);
        expect(isBlockedFetch(error)).toBe(true);
    });

    it("refuses a redirect to a name that resolves to an internal address", async () => {
        await expect(axios.get(`${PUBLIC}/to-name`, { ...guardedAxios, timeout: 5000 })).rejects.toThrow(
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
        const error = await fetchChecked(`http://127.0.0.1:${port}/`).catch((e) => e);
        expect(error).toBeInstanceOf(BlockedAddressError);
        expect(error.message).toBe("Blocked: internal address");
    });

    it("checks every address it is redirected to, before fetching it", async () => {
        const fetchMock = jest.fn().mockResolvedValueOnce(redirect("http://169.254.169.254/latest/meta-data/"));
        global.fetch = fetchMock;
        await expect(fetchChecked("http://allowed.test/cover.jpg")).rejects.toThrow(/^Blocked: internal address$/);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("refuses a name that passes the check, then answers an internal address when the connection is made", async () => {
        await expect(fetchChecked(`http://rebind.test:${port}/secret`)).rejects.toThrow(/rebind\.test is an internal address/);
        expect(reachedSecret).toBe(0);
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

describe("what a fetch says when it cannot go ahead", () => {
    it("a name that does not resolve is an unreachable upstream, not a refusal", async () => {
        const error = await fetchChecked("http://no-such-host.invalid/cover.jpg").catch((e) => e);
        expect(error).toBeInstanceOf(UnresolvedAddressError);
        expect(isBlockedFetch(error)).toBe(false);
        expect(upstreamFailure(error)).toBe("down");
    });

    it("something that is not an address is neither", async () => {
        const error = await fetchChecked("not a url").catch((e) => e);
        expect(error).toBeInstanceOf(InvalidAddressError);
        expect(isBlockedFetch(error)).toBe(false);
    });

    it("a non-web address is refused", async () => {
        const error = await fetchChecked("file:///etc/passwd").catch((e) => e);
        expect(error).toBeInstanceOf(BlockedAddressError);
        expect(error.message).toBe("Blocked scheme: file:");
    });
});

describe("which addresses are internal", () => {
    it.each([
        ["127.0.0.1", true], ["10.1.2.3", true], ["172.16.0.1", true], ["172.32.0.1", false], ["192.168.1.1", true],
        ["169.254.169.254", true], ["100.64.0.1", true], ["0.0.0.0", true], ["224.0.0.1", true], ["8.8.8.8", false],
        ["::1", true], ["::", true], ["::ffff:7f00:1", true], ["::ffff:127.0.0.1", true], ["::ffff:a9fe:a9fe", true],
        ["::7f00:1", true], ["fd12:3456::1", true], ["fe80::1", true], ["ff02::1", true],
        ["64:ff9b::7f00:1", true], ["64:ff9b::808:808", false], ["2606:4700:4700::1111", false], ["not-an-ip", true],
        ["2002:7f00:1::", true], ["2002:a9fe:a9fe::1", true], ["2002:808:808::", false], ["2001:0:4136:e378:8000:63bf:3fff:fdd2", true],
        ["::ffff:0:7f00:1", true], ["::ffff:0:127.0.0.1", true], ["fec0::1", true], ["192.0.0.1", true], ["198.18.0.1", true],
        ["198.19.255.1", true], ["198.20.0.1", false], ["192.0.2.10", true],
    ])("%s → %s", (ip, internal) => {
        expect(isBlockedIp(ip)).toBe(internal);
    });

    it("checks an address written as the host itself, without a name lookup", async () => {
        expect(await validateUrlForFetch("http://[::ffff:7f00:1]/")).toMatch(/internal address/);
        expect(await validateUrlForFetch("http://[2606:4700:4700::1111]/")).toBeNull();
    });
});
