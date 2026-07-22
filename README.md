# TriWorld

**One triangle world. Every engine.**

TriWorld is a canonical triangle-scene engine. Geometry is generated once, validated once, and consumed unchanged by Cesium, BeamNG, and future exporters.

## Core rule

Exporters may transform coordinates and serialize formats, but they must never rebuild, smooth, retriangulate, or otherwise change canonical geometry.

## First vertical slice

- synthetic triangle terrain
- canonical road mesh
- direct Cesium rendering
- wireframe/debug inspection
- deterministic geometry hashes
- BeamNG export foundation

## Architecture

```text
CanonicalScene
├── TerrainMesh
├── RoadMesh
├── JunctionMesh
├── CollisionMesh
├── Materials
└── SpawnPoints
```

Status: clean-room foundation in progress.
