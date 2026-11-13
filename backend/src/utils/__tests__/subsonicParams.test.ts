/**
 * The Subsonic parameter reader: what a route gets for a parameter sent once, repeated, left out or left blank.
 * Read through a real Express app, so the shapes are the ones its query parser produces.
 */

import express from "express";
import request from "supertest";
import { one, many } from "../subsonicParams";

const app = express();
app.get("/read", (req, res) => {
    res.json({ one: one(req, "id") ?? null, many: many(req, "id"), kept: many(req, "id", { keepBlank: true }) });
});

async function read(queryString: string): Promise<{ one: string | null; many: string[]; kept: string[] }> {
    return (await request(app).get(`/read?${queryString}`)).body;
}

describe("one", () => {
    it("reads a value sent once", async () => {
        expect((await read("id=abc")).one).toBe("abc");
    });

    it("reads the first of a repeated value", async () => {
        expect((await read("id=abc&id=def&id=ghi")).one).toBe("abc");
    });

    it("answers undefined for a missing parameter", async () => {
        expect((await read("other=1")).one).toBeNull();
    });

    it("keeps a blank value blank, so a route can tell it from a missing one", async () => {
        expect((await read("id=")).one).toBe("");
    });

    it("ignores a value that is not text, such as a nested one", async () => {
        expect((await read("id[a]=b")).one).toBeNull();
        expect((await read("id[a]=b&id=abc")).one).toBe("abc");
    });
});

describe("many", () => {
    it("answers one value in a list", async () => {
        expect((await read("id=abc")).many).toEqual(["abc"]);
    });

    it("answers every repeated value in the order sent", async () => {
        expect((await read("id=abc&id=def&id=ghi")).many).toEqual(["abc", "def", "ghi"]);
    });

    it("answers an empty list for a missing parameter", async () => {
        expect((await read("other=1")).many).toEqual([]);
    });

    it("drops blank values", async () => {
        expect((await read("id=&id=abc&id=")).many).toEqual(["abc"]);
        expect((await read("id=")).many).toEqual([]);
    });

    it("ignores values that are not text", async () => {
        expect((await read("id[a]=b&id=abc")).many).toEqual(["abc"]);
    });

    it("keeps blank values, in place, when asked, so two lists sent side by side stay paired", async () => {
        expect((await read("id=&id=abc&id=")).kept).toEqual(["", "abc", ""]);
        expect((await read("other=1")).kept).toEqual([]);
    });
});
