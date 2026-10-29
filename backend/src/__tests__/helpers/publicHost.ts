import dnsPromises from "dns/promises";
import http from "http";

/**
 * A made-up public host for tests whose upstream is a local server. The fetch guard refuses every internal
 * address, the local server's included, so tests reach it under this name: the name is checked as a public
 * address, and a connection to it lands on 127.0.0.1 at the URL's port (the one stand-in, for the internet).
 */
const PUBLIC_HOST = "public.test";
const PUBLIC_ADDRESS = "93.184.216.34";

/** `http://public.test:<port>` for a local server on that port. Call routePublicHost first. */
export const publicUrl = (port: number) => `http://${PUBLIC_HOST}:${port}`;

/** Routes PUBLIC_HOST to this machine until the spies are restored (jest.restoreAllMocks). */
export function routePublicHost(): void {
    const connect = http.Agent.prototype.createConnection;
    jest.spyOn(http.Agent.prototype, "createConnection").mockImplementation(function (this: http.Agent, options, callback) {
        const to = options.host === PUBLIC_HOST ? { ...options, host: "127.0.0.1", lookup: undefined } : options;
        return connect.call(this, to, callback);
    });
    const lookup = dnsPromises.lookup;
    jest.spyOn(dnsPromises, "lookup").mockImplementation(((host: string, ...rest: unknown[]) =>
        host === PUBLIC_HOST
            ? Promise.resolve({ address: PUBLIC_ADDRESS, family: 4 })
            : (lookup as (...a: unknown[]) => unknown)(host, ...rest)) as typeof dnsPromises.lookup);
}
