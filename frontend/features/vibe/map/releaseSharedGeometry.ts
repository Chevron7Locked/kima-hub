import { Pass } from "postprocessing";
import type { BufferGeometry } from "three";

// The library's type definitions leave this static property out; it exists in the build.
export const sharedFullscreenGeometry = (): BufferGeometry => (Pass as unknown as { fullscreenGeometry: BufferGeometry }).fullscreenGeometry;

/**
 * The post-processing library draws every full-screen pass from one triangle it creates once for the whole page.
 * Each renderer that draws it hangs a "dispose" listener on that triangle, and the listener points back at the
 * renderer. Nothing removes it unless the triangle is disposed, so every visit to the map would leave its renderer
 * (graphics context, canvas and the page elements above it) alive. Disposing it on the way out drops the listeners;
 * a renderer that draws it again simply uploads it again.
 */
export function releaseSharedGeometry() {
    sharedFullscreenGeometry().dispose();
}
