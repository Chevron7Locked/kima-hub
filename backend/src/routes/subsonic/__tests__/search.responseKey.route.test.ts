/**
 * search3 and getSimilarSongs2 answer under their own element names, search2 and getSimilarSongs under the legacy ones,
 * whatever letter case the client writes the endpoint in (a router matches any case, so the answer cannot be decided by
 * reading the path text). Real router; only Subsonic auth is injected, as the parent router would.
 */

import express from "express";
import request from "supertest";
import { searchRouter } from "../search";

const app = express()
    .use((req: any, _res, next) => { req.user = { id: "zz-rkey-user", username: "zz-rkey-user", role: "user" }; next(); })
    .use("/", searchRouter);

const answer = (view: string, query: Record<string, string>) =>
    request(app).get(`/${view}`).query({ f: "json", ...query }).expect(200).then((r) => Object.keys(r.body["subsonic-response"]));

describe("the element a search answers under", () => {
    it.each([
        ["search3.view", "searchResult3"],
        ["Search3.view", "searchResult3"],
        ["SEARCH3.VIEW", "searchResult3"],
        ["search2.view", "searchResult2"],
        ["Search2.view", "searchResult2"],
    ])("%s answers %s", async (view, key) => {
        expect(await answer(view, { query: "zz-no-such-song" })).toContain(key);
    });
});

describe("the element similar songs answer under", () => {
    it.each([
        ["getSimilarSongs2.view", "similarSongs2"],
        ["GetSimilarSongs2.view", "similarSongs2"],
        ["getsimilarsongs2.view", "similarSongs2"],
        ["getSimilarSongs.view", "similarSongs"],
        ["GetSimilarSongs.view", "similarSongs"],
    ])("%s answers %s", async (view, key) => {
        expect(await answer(view, { id: "zz-no-such-id" })).toContain(key);
    });
});
