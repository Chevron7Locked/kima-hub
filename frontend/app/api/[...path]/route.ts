export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const getBackendUrl = (): string => {
    const env = (globalThis as { process?: { env?: Record<string, string> } })
        .process?.env;
    const base =
        env?.BACKEND_URL ||
        env?.NEXT_PUBLIC_API_URL ||
        "http://127.0.0.1:3006";
    return base.replace(/\/$/, "");
};

const buildTargetUrl = (request: Request, path: string): string => {
    const base = getBackendUrl();
    const url = new URL(`${base}/api/${path}`);
    url.search = new URL(request.url).search;
    return url.toString();
};

const buildProxyHeaders = (request: Request): Headers => {
    const headers = new Headers(request.headers);
    headers.delete("host");

    const host = request.headers.get("host");
    if (host) {
        headers.set("x-forwarded-host", host);
    }
    headers.set(
        "x-forwarded-proto",
        new URL(request.url).protocol.replace(":", "")
    );

    const forwardedFor = request.headers.get("x-forwarded-for");
    const realIp = request.headers.get("x-real-ip");
    if (!forwardedFor && realIp) {
        headers.set("x-forwarded-for", realIp);
    }

    return headers;
};

const proxy = async (
    request: Request,
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

type RouteParams = { params: { path?: string[] } };

export async function GET(request: Request, { params }: RouteParams) {
    return proxy(request, params.path?.join("/") ?? "");
}

export async function POST(request: Request, { params }: RouteParams) {
    return proxy(request, params.path?.join("/") ?? "");
}

export async function PUT(request: Request, { params }: RouteParams) {
    return proxy(request, params.path?.join("/") ?? "");
}

export async function PATCH(request: Request, { params }: RouteParams) {
    return proxy(request, params.path?.join("/") ?? "");
}

export async function DELETE(request: Request, { params }: RouteParams) {
    return proxy(request, params.path?.join("/") ?? "");
}
