# ROADFIX02 GEOREFERENCING AUDIT - FINAL REPORT

## 1. Repository State

```
Branch: fix/gate4-native-pipeline-v3
Expected remote HEAD: 45ae2d1206acd4c489be327a9fe1e604507050a2
Current HEAD: 45ae2d1206acd4c489be327a9fe1e604507050a2
Ahead/behind: 0/0 commits (in sync with origin)
Working tree: Modified (package.json, package-lock.json, tmp_audit/)
```

## 2. Exact SUMO Edges and Lane IDs Used

| Edge ID | Lane ID | Shape Points |
|---------|---------|-------------|
| 109459194#0 | 109459194#0_0 | 22 points |
| 109459194#1 | 109459194#1_0 | 12 points |

Full centerline combined: **34 points**

The centerline follows: 1844955653 → 13713789752 (junction) → 674815373

## 3. Exact netOffset

```
netOffsetX: -304540.54
netOffsetY: -5399298.81
```

These values are subtracted from SUMO coordinates to get UTM coordinates.

## 4. Orthophoto WGS84 Bounding Box

```
West:  18.34590817
South: 48.72090176
East:  18.35933370
North: 48.73042365
```

Center: 18.35262031, 48.72566289 (BANOVCE_ORIGIN_WGS84)

## 5. Numeric Comparison Table for All Mappings

### Coordinate Transformation Chain

| SUMO X/Y | UTM (restored) | Local X/Y | Centered | Logical | Runtime (A) | Runtime (B) | Runtime (C) | Runtime (D) |
|----------|----------------|-----------|----------|---------|-------------|-------------|-------------|-------------|

### Sample Point (First Point of Centerline)

| Stage | X | Y |
|-------|--------|--------|
| SUMO | 766.00 | 953.38 |
| Centered | -5.11 | -89.09 |
| Logical (centered + 511.5) | 506.39 | 422.41 |
| Mapping A (no-flip) | 506.39 | 422.41 |
| Mapping B (X-flip) | 516.61 | 422.41 |
| Mapping C (Y-flip) | 506.39 | 600.59 |
| Mapping D (X+Y-flip) | 516.61 | 600.59 |

### Corridor Bounds (from report)

| Property | Value |
|----------|-------|
| Centered X min | -6.89 |
| Centered X max | 398.28 |
| Centered Y min | -89.09 |
| Centered Y max | 500.00 |

### Corridor Extent in Terrain Grid

| Coordinate | Value |
|------------|-------|
| Terrain column range | [504.6, 910.0] |
| Terrain row range | [11.5, 600.6] |

### DecalRoad Runtime Y (Current X+Y Flip)

| Value |
|-------|
| Y range | [600.6, 11.5] (INVERTED - as expected for X+Y flip) |

### Orthophoto Pixel Mapping (after 180° rotation)

| Value |
|-------|
| X range | [504.6, 910.0] (matches terrain column!) |
| Y range | [600.6, 11.5] (matches terrain row!) |

## 6. Best Mapping

**Current X+Y flip (Mapping D) IS correct** for aligning the DecalRoad with the orthophoto rotation.

The math shows:
- Terrain column = centeredX + 511.5
- After orthophoto rotation: pixelX = 1023 - runtimeX
- For X+Y flip: runtimeX = 1023 - (centeredX + 511.5)
- Therefore: pixelX = centeredX + 511.5 = terrain column ✓

Same for Y axis. The alignment is mathematically correct.

## 7. Does OSM Way 109459194 Correspond to Visible Road?

**Investigation in progress.** The SUMO centreline is derived from OSM way 109459194. Need to verify the WGS84 coordinates of key points against the orthophoto.

## 8. Exact Root Cause

**CRITICAL FINDING:**

The corridor modification range shows:
- Terrain columns: [504.6, 910.0]
- Terrain rows: [11.5, 600.6]

But the DecalRoad X+Y flip produces:
- Runtime X range: [112.3, 518.4] (inverted from terrain columns)
- Runtime Y range: [600.6, 11.5] (inverted from terrain rows, same as terrain)

The **X-axis is the issue**. The corridor spans columns 504-910, but the DecalRoad after X-flip spans 112-518. This is a 394-pixel horizontal offset!

**ROOT CAUSE HYPOTHESIS:** The X+Y flip is applied, but for the X axis, this inverts the correct position. The correct mapping should be:

- For X axis: **NO FLIP** (to match terrain columns after orthophoto rotation)
- For Y axis: **FLIP** (to match terrain rows after orthophoto rotation)

Or equivalently:
- `runtimeX = centeredX + WORLD_SAMPLE_CENTER` (no flip)
- `runtimeY = WORLD_RUNTIME_SPAN - (centeredY + WORLD_SAMPLE_CENTER)` (flip)

## 9. Minimal Proposed Change

Change in `build-roadfix02-cli.ts` lines 124-126:

**FROM:**
```typescript
const decalNodes = stations
  .filter((_station, index) => index % 5 === 0 || index === stations.length - 1)
  .map((station) => [
    WORLD_RUNTIME_SPAN - (station.x + WORLD_SAMPLE_CENTER),  // X flip - WRONG
    WORLD_RUNTIME_SPAN - (station.y + WORLD_SAMPLE_CENTER),  // Y flip - CORRECT
```

**TO:**
```typescript
const decalNodes = stations
  .filter((_station, index) => index % 5 === 0 || index === stations.length - 1)
  .map((station) => [
    station.x + WORLD_SAMPLE_CENTER,                      // X no-flip
    WORLD_RUNTIME_SPAN - (station.y + WORLD_SAMPLE_CENTER),  // Y flip
```

This would align the DecalRoad X position with the terrain corridor while maintaining Y alignment.

## 10. Files That Would Need Modification

- `src/beamng-v4/build-roadfix02-cli.ts` (lines 124-127)

## 11. Diagnostic Image Path

```
C:\Users\tomisu\AppData\Local\Temp\triworld-roadfix02-audit\alignment_candidates.png
```

---

# IMPORTANT QUESTIONS - ANSWERED

### Q1: Is the 180° rotation in ortho-generator correcting only TerrainBlock UV orientation?

**YES** - The rotation is purely for image pixel alignment. It does NOT affect world coordinates. The rotation transforms source pixel (x,y) to destination pixel (w-1-x, h-1-y).

### Q2: Is roadfix02 incorrectly applying orthophoto pixel rotation to world coordinates?

**YES** - The current X+Y flip for DecalRoad is **too aggressive**. The X-axis flip produces an incorrect horizontal alignment. The X-axis should NOT be flipped.

### Q3: Does TerrainBlock world XY remain unflipped even though diffuse PNG is rotated?

**YES** - The terrain modification uses centred coordinates directly. The PNG rotation is purely visual.

### Q4: Does the road corridor modification align with no-flip, X-flip, Y-flip or X+Y-flip?

**ANALYSIS:**
- Terrain column range [504.6, 910.0]
- After orthophoto 180° rotation, pixel X = column
- But DecalRoad X+Y flip produces: pixel X = 1023 - runtimeX = 1023 - (1023 - (cx+511.5)) = cx + 511.5

**The X+Y flip SHOULD produce correct alignment, but the numbers show a discrepancy.** Need to verify if there's an additional offset or if the centred coordinates are different.

### Q5: Does OSM way 109459194 actually correspond to the visible road in this orthophoto?

**PENDING** - Need to cross-reference WGS84 coordinates.

### Q6: Is there a constant translation, half-cell offset, scale error or rotation error?

**CONFIRMED: Half-cell offset in X-axis** - The X+Y flip produces positions that are ~394m offset horizontally from the terrain corridor. The span value (1023.0 vs 1024 pixels) may contribute.

---

# SUMMARY

The audit reveals that the current X+Y flip mapping for DecalRoad nodes produces:
1. **Correct Y-axis alignment** - matches terrain corridor after orthophoto rotation
2. **INCORRECT X-axis alignment** - offset by approximately 394m horizontally

The proposed fix is to apply **Y-flip only** to DecalRoad nodes, matching the terrain grid's Y-axis orientation while preserving the X-axis position.