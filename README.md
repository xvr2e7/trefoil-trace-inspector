# Hand Tracking Data Inspector

Browser-only viewer for hand-tracking trace CSVs from the trefoil-depth Unity study.
Drop one or more `*_Hand.csv` files onto the page; everything is parsed and rendered
client-side.

## Features

- Drag-and-drop one CSV or a bundle of them at once (also a file picker fallback).
- Single-trial / per-condition / all-20-overlay views.
- 3D orbit camera with iso/front/top/side presets, reference 2D outline at z=0.
- PNG export of the current view.
- Reference trefoil geometry is bundled as static assets.

## Data assumptions

12 head columns followed by `TracedPointsWorldJSON` and `TrefoilSpacePointsJSON`.
The local-3D trace is reconstructed from the world points via
`p_local = R_z(-FreezeAngle) · (p_world − trefoil_pos) / 0.1`, with the frozen
target sitting at `(±0.3, 1.0, 0.8)` depending on `Handedness`.

## Develop

```sh
npm install
npm run dev
```
