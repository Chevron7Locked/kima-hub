import { Request, Response } from "express";
import { XMLBuilder } from "fast-xml-parser";
import { version } from "../../package.json";

const SUBSONIC_API_VERSION = "1.16.1";
const SERVER_TYPE = "Kima";

const xmlBuilder = new XMLBuilder({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    format: false,
    suppressEmptyNode: true,
    suppressBooleanAttributes: false,  // emit true/false as quoted strings per XML spec
});

// Recursively strip the @_ attribute prefix for JSON output.
// fast-xml-parser uses @_ internally for XML attributes; Subsonic JSON uses plain keys.
function stripAttrPrefix(obj: unknown): unknown {
    if (Array.isArray(obj)) return obj.map(stripAttrPrefix);
    if (obj !== null && typeof obj === "object") {
        return Object.fromEntries(
            Object.entries(obj as Record<string, unknown>).map(([k, v]) => {
                const key = k === "#text" ? "value" : k.startsWith("@_") ? k.slice(2) : k;
                return [key, stripAttrPrefix(v)];
            })
        );
    }
    return obj;
}

function buildEnvelope(status: "ok" | "failed", data?: object) {
    return {
        "subsonic-response": {
            "@_xmlns": "http://subsonic.org/restapi",
            "@_status": status,
            "@_version": SUBSONIC_API_VERSION,
            "@_type": SERVER_TYPE,
            "@_serverVersion": version,
            "@_openSubsonic": true,
            ...(data ?? {}),
        },
    };
}

export function subsonicOk(req: Request, res: Response, data?: object) {
    const envelope = buildEnvelope("ok", data);
    if (req.query.f === "json" || req.query.f === "jsonp") {
        return res.json(stripAttrPrefix(envelope));
    }
    res.set("Content-Type", "text/xml; charset=utf-8");
    res.send('<?xml version="1.0" encoding="UTF-8"?>' + xmlBuilder.build(envelope));
}

export function subsonicError(
    req: Request,
    res: Response,
    code: number,
    message: string
) {
    // HTTP status is always 200 per Subsonic protocol spec
    const envelope = buildEnvelope("failed", {
        error: { "@_code": code, "@_message": message },
    });
    if (req.query.f === "json" || req.query.f === "jsonp") {
        return res.json(stripAttrPrefix(envelope));
    }
    res.set("Content-Type", "text/xml; charset=utf-8");
    res.send('<?xml version="1.0" encoding="UTF-8"?>' + xmlBuilder.build(envelope));
}

export const SubsonicError = {
    GENERIC: 0,
    MISSING_PARAM: 10,
    CLIENT_TOO_OLD: 20,
    SERVER_TOO_OLD: 30,
    WRONG_CREDENTIALS: 40,
    TOKEN_AUTH_NOT_SUPPORTED: 41,
    NOT_AUTHORIZED: 50,
    NOT_FOUND: 70,
} as const;
