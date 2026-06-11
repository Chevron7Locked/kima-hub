export type RangeParseResult =
    | { ok: true; start: number; end: number }
    | { ok: false; status: 416; reason: "unsatisfiable" }
    | { ok: false; status: 200; reason: "multi" };

/**
 * Parse an HTTP Range header value into start/end byte offsets.
 * Handles standard ranges, open-ended ranges, and suffix ranges (bytes=-N).
 * Clamps end to file boundary per RFC 7233 Section 2.1.
 *
 * Multi-range requests (bytes=0-99,200-299) are reported as reason "multi":
 * RFC 9110 Section 14.2 permits ignoring the Range header, so callers serve
 * the full file as 200 rather than a multipart/byteranges response.
 */
export function parseRangeHeader(
    rangeHeader: string,
    fileSize: number
): RangeParseResult {
    const value = rangeHeader.replace(/bytes=/, "");

    if (value.includes(",")) {
        return { ok: false, status: 200, reason: "multi" };
    }

    const parts = value.split("-");
    const startPart = parts[0];
    const endPart = parts[1];

    let start: number;
    let end: number;

    if (startPart === "") {
        const suffixLength = parseInt(endPart || "", 10);
        if (Number.isNaN(suffixLength) || suffixLength <= 0) {
            return { ok: false, status: 416, reason: "unsatisfiable" };
        }
        start = Math.max(fileSize - suffixLength, 0);
        end = fileSize - 1;
    } else {
        const parsedStart = parseInt(startPart, 10);
        const parsedEnd = endPart ? parseInt(endPart, 10) : fileSize - 1;

        if (Number.isNaN(parsedStart)) {
            return { ok: false, status: 416, reason: "unsatisfiable" };
        }

        start = parsedStart;
        end = Number.isNaN(parsedEnd) ? fileSize - 1 : parsedEnd;
    }

    // Clamp end to file boundary per RFC 7233 Section 2.1
    end = Math.min(end, fileSize - 1);

    // Validate range
    if (start >= fileSize || start > end || start < 0) {
        return { ok: false, status: 416, reason: "unsatisfiable" };
    }

    return { ok: true, start, end };
}
