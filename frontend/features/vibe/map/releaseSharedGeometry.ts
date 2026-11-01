import { Pass } from "postprocessing";
import type { BufferGeometry } from "three";

// The library's type definitions leave this static property out; it exists in the build.
export const sharedFullscreenGeometry = (): BufferGeometry => (Pass as unknown as { fullscreenGeometry: BufferGeometry }).fullscreenGeometry;

/**
 * The post-processing library draws every full-screen pass from one shared triangle, and each renderer that draws it
 * adds a "dispose" listener pointing back at the renderer. Disposing the triangle on the way out drops those
 * listeners, so a visit to the map does not keep its renderer (context, canvas, page elements) alive.
 */
export function releaseSharedGeometry() {
    sharedFullscreenGeometry().dispose();
}
