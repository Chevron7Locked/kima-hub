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

export async function GET(request: Request) {
    const targetUrl = `${getBackendUrl()}/health${new URL(request.url).search}`;
    const headers = new Headers(request.headers);
    headers.delete("host");

    const upstream = await fetch(targetUrl, {
        method: "GET",
        headers,
        redirect: "manual",
    });

    return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: upstream.headers,
    });
}
