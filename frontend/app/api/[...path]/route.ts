import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const getBackendUrl = (): string => {
    const base =
        process.env.BACKEND_URL ||
        process.env.NEXT_PUBLIC_API_URL ||
        "http://127.0.0.1:3006";
    return base.replace(/\/$/, "");
};

const buildTargetUrl = (request: NextRequest, path: string): string => {
    const base = getBackendUrl();
    const url = new URL(`${base}/api/${path}`);
    url.search = request.nextUrl.search;
    return url.toString();
};

const buildProxyHeaders = (request: NextRequest): Headers => {
    const headers = new Headers(request.headers);
    headers.delete("host");

    const host = request.headers.get("host");
    if (host) {
        headers.set("x-forwarded-host", host);
    }
    headers.set("x-forwarded-proto", request.nextUrl.protocol.replace(":", ""));

    const forwardedFor = request.headers.get("x-forwarded-for");
    const realIp = request.headers.get("x-real-ip");
    if (!forwardedFor && realIp) {
        headers.set("x-forwarded-for", realIp);
    }

    return headers;
};

const proxy = async (
    request: NextRequest,
    path: string
): Promise<Response> => {
    const targetUrl = buildTargetUrl(request, path);
    const headers = buildProxyHeaders(request);

    const init: RequestInit = {
        method: request.method,
        headers,
        redirect: "manual",
    };

    if (request.method !== "GET" && request.method !== "HEAD") {
        init.body = await request.arrayBuffer();
    }

    const upstream = await fetch(targetUrl, init);
    const responseHeaders = new Headers(upstream.headers);

    return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
    });
};

type RouteParams = { params: Promise<{ path: string[] }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
    const { path } = await params;
    return proxy(request, path.join("/"));
}

export async function POST(request: NextRequest, { params }: RouteParams) {
    const { path } = await params;
    return proxy(request, path.join("/"));
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
    const { path } = await params;
    return proxy(request, path.join("/"));
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
    const { path } = await params;
    return proxy(request, path.join("/"));
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
    const { path } = await params;
    return proxy(request, path.join("/"));
}
