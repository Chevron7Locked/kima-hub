import { expect, it } from "vitest";
import { pathFor } from "../paths";

// An id is one path segment. One holding "/", "?" or "#" must not reach another route or cut the address short.
const odd = "a/b?c#d";
const encoded = "a%2Fb%3Fc%23d";

it("puts an id in the path as one segment", () => {
    expect(pathFor("/album", odd)).toBe(`/album/${encoded}`);
});

it("leaves an ordinary id as it is", () => {
    expect(pathFor("/playlist", "cmf3x0a9b0000")).toBe("/playlist/cmf3x0a9b0000");
});

it("takes a number, and encodes every segment it is given", () => {
    expect(pathFor("/podcasts", 12345)).toBe("/podcasts/12345");
    expect(pathFor("/device-link/status", odd, "cover")).toBe(`/device-link/status/${encoded}/cover`);
});

it("makes a path of the base alone when there is no id", () => {
    expect(pathFor("/stats")).toBe("/stats");
});
