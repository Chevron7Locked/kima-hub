import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * SSE proxy route handler.
 *
 * Next.js rewrites buffer streaming responses, which breaks Server-Sent Events.
 * This route handler fetches the backend SSE endpoint and streams the response
 * directly to the client, bypassing the rewrite proxy entirely.
 */
export async function GET(request: NextRequest) {
    const token = request.nextUrl.searchParams.get("token");
    if (!token) {
        return new Response("Unauthorized", { status: 401 });
    }

    const backendUrl =
        process.env.BACKEND_URL ||
        process.env.NEXT_PUBLIC_BACKEND_URL ||
        "http://127.0.0.1:3006";

    const abortController = new AbortController();

    // Abort the backend request when the client disconnects
    request.signal.addEventListener("abort", () => {
        abortController.abort();
    });

    let backendResponse: Response;
    try {
        backendResponse = await fetch(
            `${backendUrl}/api/events?token=${encodeURIComponent(token)}`,
            {
                headers: {
                    Accept: "text/event-stream",
                    "Cache-Control": "no-cache",
                },
                signal: abortController.signal,
            }
        );
    } catch {
        return new Response("Backend unavailable", { status: 502 });
    }

    if (!backendResponse.ok) {
        const body = await backendResponse.text();
        return new Response(body, { status: backendResponse.status });
    }

    if (!backendResponse.body) {
        return new Response("No stream from backend", { status: 502 });
    }

    return new Response(backendResponse.body, {
        headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
        },
    });
}
