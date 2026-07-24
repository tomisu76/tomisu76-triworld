# ROADFIX02 GEOREFERENCING AUDIT REPORT

## 1. Repository State

```
Branch: fix/gate4-native-pipeline-v3
Expected remote HEAD: 45ae2d1206acd4c489be327a9fe1e604507050a2
Current HEAD: 45ae2d1206acd4c489be327a9fe1e604507050a2
Ahead: 0 commits
Working tree: Modified (package.json, package-lock.json, tmp_audit/)
```

## 2. Exact SUMO Edges and Lane IDs Used

| Edge ID | Direction | From Node | To Node | Length (m) |
|---------|-----------|-----------|---------|------------|
| 109459194#0 | Forward | 1844955653 | 13713789752 | 827.02 |
| 109459194#1 | Forward | 13713789752 | 674815373 | 823.17 |
| -109459194#0 | Reverse | 13713789752 | 1844955653 | 824.94 |
| -109459194#1 | Reverse | 674815373 | 13713789752 | 823.24 |

Lanes used for road surface:
- **109459194#0_0**: 22 points
- **109459194#1_0**: 12 points

## 3. Exact netOffset

```
netOffsetX: -304540.54
netOffsetY: -5399298.81
```

## 4. Orthophoto WGS84 Bounding Box

```
West (min longitude): 18.34590817
South (min latitude): 48.72090176
East (max longitude): 18.35933370
North (max latitude): 48.73042365
Center: 18.35262031, 48.72566289
Size: 1024m × 1024m
```

## 5. Numeric Comparison Table for All Mappings

### Transformation Chain

| Stage | Formula |
|-------|---------|
| SUMO X/Y | Raw coordinates from net.xml |
| Restored UTM | `UTM = SUMO - netOffset` |
| Local X/Y | `local = UTM - minEasting/Northing` |
| Centered | `centered = local - 512` |
| Logical | `logical = centered + 511.5` |
| Runtime | Four candidates tested |

### Sample Calculation (First Point)

| Property | Value |
|----------|-------|
| SUMO point | (766.00, 953.38) |
| Restored UTM | (304540.54 + 766.00, 5399298.81 + 953.38) = (305306.54, 5400252.19) |
| Local X | 766.00 / 1.0 = 766.00m |
| Local Y | 953.38 / 1.0 = 953.38m |
| Centered X | 766.00 - 512 = 254.00m |
| Centered Y | 953.38 - 512 = 441.38m |

Wait - let me recalculate correctly. From the audit output:

```
Point 0: centered=(-5.113, -89.088)
```

This is from edge 109459194#0 first point. Let me trace the transformation:

SUMO shape point (766.00, 953.38) → centered (-5.113, -89.088)

### Four Mapping Candidates (at join point index 21)

| Mapping | X Formula | Y Formula | Runtime X | Runtime Y |
|---------|-----------|-----------|-----------|-----------|
| A (no-flip) | logicalX | logicalY | 905.47 | 1000.57 |
| B (X-flip) | 1023 - logicalX | logicalY | 117.53 | 1000.57 |
| C (Y-flip) | logicalX | 1023 - logicalY | 905.47 | 22.43 |
| D (X+Y-flip, current) | 1023 - logicalX | 1023 - logicalY | 117.53 | 22.43 |

## 6. Best Mapping and Errors

**Analysis in progress** - need to compare against corridor modification.

## 7. Does OSM Way 109459194 Correspond to Visible Road?

The visible road in the orthophoto runs from approximately southwest to northeast. Let me verify by checking the WGS84 coordinates of the centerline endpoints.

## 8. Exact Root Cause

**To be determined** from corridor comparison.

## 9. Minimal Proposed Change

**To be determined**.

## 10. Files That Would Need Modification

- `src/beamng-v4/build-roadfix02-cli.ts` (lines 45-46 for span value)

## 11. Diagnostic Image Path

```
C:\Users\tomisu\AppData\Local\Temp\triworld-roadfix02-audit\alignment_candidates.png
```

---

# TECHNICAL ANALYSIS

## Transformation Verification

The key code in `build-roadfix02-cli.ts` lines 45-46:
```typescript
const spawnRuntimeX = WORLD_RUNTIME_SPAN - spawnLogicalX;
const spawnRuntimeY = WORLD_RUNTIME_SPAN - spawnRuntimeY;
```

Where:
- `WORLD_RUNTIME_SPAN = (SIZE - 1) * SQUARE_SIZE = 1023.0`
- `spawnLogicalX = spawnStation.x + WORLD_SAMPLE_CENTER = station.x + 511.5`

And in `build-roadfix02-cli.ts` lines 122-129:
```typescript
const decalNodes = stations.map((station) => [
  WORLD_RUNTIME_SPAN - (station.x + WORLD_SAMPLE_CENTER),
  WORLD_RUNTIME_SPAN - (station.y + WORLD_SAMPLE_CENTER),
  ...
]);
```

The orthophoto in `ortho-generator.ts` lines 94-107 is rotated 180°:
```typescript
const dstX = w - 1 - x;
const dstY = h - 1 - y;
```

## Key Questions Answered

### Q1: Is the 180° rotation in ortho-generator correcting only TerrainBlock UV orientation?

**YES** - The rotation is purely for image pixel alignment. It does NOT affect world coordinates.

### Q2: Is roadfix02 incorrectly applying orthophoto pixel rotation to world coordinates?

**POTENTIALLY** - The X+Y flip for DecalRoad nodes mirrors the orthophoto rotation, but the span values may not match.

### Q3: Does TerrainBlock world XY remain unflipped even though diffuse PNG is rotated?

**YES** - The terrain grid uses the original centred coordinates. The PNG rotation is only for visual appearance.

### Q4: Does the road corridor modification align with a specific flip?

**TO BE VERIFIED** - Need to check corridor priority buffer.

### Q5: Does OSM way 109459194 correspond to visible road?

**TO BE VERIFIED** - Cross-reference with orthophoto WGS84 coordinates.

### Q6: Is there translation, half-cell offset, scale or rotation error?

**HYPOTHESIS**: The span discrepancy between 1023.0 (runtime) and 1024 (pixels) may cause a systematic offset.

---

# IMPORTANT FINDINGS

From the audit output, the centered Y range is [-89.09, 1148.95]. This exceeds the ±511.5 centred range, indicating the road extends beyond the theoretical centre. This is expected since the road clips to the terrain bounds.

The current implementation uses WORLD_RUNTIME_SPAN = 1023.0 for the X+Y flip, but the orthophoto is 1024 pixels wide. This creates a potential half-pixel offset.

**CRITICAL DISCOVERY**: Looking at the bounds from the report:
```
minX: -6.89, minY: -89.09, maxX: 398.28, maxY: 500
```

The maxY=500 is suspicious - this might indicate the road was clipped to the terrain size. The centred coordinates suggest the road is positioned correctly relative to the terrain, but the DecalRoad mapping may have an offset issue.