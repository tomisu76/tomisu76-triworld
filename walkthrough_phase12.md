# Canonical Globe Streaming

## 1. Architectural Changes

### `src/globe/` Subsystem
The new `globe` subsystem implements camera-driven LOD streaming for the TriWorld platform:
- **`quadtree.ts`**: Implements math for Slippy Map tiles, quadtree bounding boxes, and parent/child relationships.
- **`canonical-globe.ts`**: Defines the `CanonicalGlobeTile` interface representing a hierarchical quadtree node and its varying states (`unloaded`, `fetching`, `ready`, `visible`, `cached`, `evicted`).
- **`tile-source.ts`**: Abstract compilation pipeline which lazily loads the `canonical-tile-compiler`, fetches from Overpass, and caches the result.
- **`tile-residency-manager.ts`**: Memory-management layer with a 500-tile cache budget prioritizing least-recently-used evictions.
- **`globe-tile-scheduler.ts`**: Reacts to `GlobeCameraState`, calculates screen space error (SSE), and traverses the hierarchical quadtree to refine tiles or cull out-of-view regions.

### Dual Experience
The project now strictly hosts two isolated experiences:
1. **MapNG Selection Mode:** Fixed local quad, explicit bounds selection, purely 2D, identical to previous behavior.
2. **Canonical Globe Mode:** Full 3D camera experience, continuous streaming via the new `GlobeTileScheduler`.

## 2. Testing and Validation
- **Unit Tests:** `quadtree.test.ts` and `scheduler.test.ts` implemented and passing via Vitest.
- **Build Integrity:** `npm run build` passes with zero type errors.

## 3. Usage
Click the **"Globe Streaming"** toggle to swap the scene to 3D mode and instantly begin loading canonical geometric primitives around the camera based on view frustum screen space error.
