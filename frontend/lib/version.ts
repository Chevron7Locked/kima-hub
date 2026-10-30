import packageJson from "../package.json";

const BASE_VERSION = packageJson.version;

// NEXT_PUBLIC_BUILD_TYPE marks non-release builds in the UI: a release
// candidate's suffix ("rc1"), "prerelease" (the ghcr.io-only channel) or "dev"
// (local stack). A release passes nothing and shows a bare version.
const BUILD_TYPE = process.env.NEXT_PUBLIC_BUILD_TYPE?.trim() || "";

export const APP_VERSION = BUILD_TYPE ? `${BASE_VERSION}-${BUILD_TYPE}` : BASE_VERSION;
