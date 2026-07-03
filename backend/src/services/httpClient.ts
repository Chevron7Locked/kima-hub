/**
 * Shared rate-limited HTTP GET helper.
 *
 * Third-party enrichment integrations each re-implement the same
 * `rateLimiter.execute(service, () => axios.get(...))` wrapper. This
 * centralizes that pattern so new integrations can route their GETs through
 * the global rate limiter without duplicating the boilerplate.
 */

import axios, { AxiosRequestConfig } from "axios";
import { rateLimiter, ServiceName } from "./rateLimiter";

/**
 * Perform a rate-limited GET request, resolving to the response body.
 *
 * @param service - the rate-limiter service key (see SERVICE_CONFIGS in rateLimiter.ts)
 * @param url - the request URL
 * @param config - optional axios request config (headers, params, etc.)
 */
export async function rateLimitedGet<T = any>(
    service: ServiceName,
    url: string,
    config?: AxiosRequestConfig
): Promise<T> {
    return rateLimiter.execute(service, async () => {
        const res = await axios.get<T>(url, config);
        return res.data;
    });
}
