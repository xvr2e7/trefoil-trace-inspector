# Trefoil Trace Inspector

Browser-only 3D viewer for two trefoil-tracing experiments:

- **Hand Tracking** — Unity pilot study (`*_Hand.csv`).
- **Rotating Trace** — SteamVR fingertip-tracker task (`RotatingTrace_*.csv`).

Drop files onto the page (or use the file picker); everything is parsed and
rendered client-side. The left-panel **Dataset** toggle switches between the
two inspections, and the bundled set for each side is kept in memory so you
can flip back and forth without re-dropping. Drops auto-route by filename and
switch the toggle to match the first incoming file.

## Features

- Single-trial / condition (hand only) / all-trials-overlay views.
- 3D orbit camera with iso/front/top/side presets, reference 2D outline at z=0.
- PNG export of the current view.
- Reference trefoil geometry is bundled as static assets.

## Data assumptions

**Hand Tracking (`*_Hand.csv`).** One row per trial. The trailing two columns
are JSON blobs (`world` points + the trefoil reference at trial time). The
trefoil is frozen at `FreezeAngle` during the tracing window:

```
p_local = R_z(-FreezeAngle) · (p_world - frozen_pos) / 0.1
```

with `frozen_pos = (±0.3, 1.0, 0.8)` (sign by handedness).

**Rotating Trace (`RotatingTrace_*.csv`).** One sample per row, columns:
`TrialIndex, Block, TrialInBlock, R1, R2, RotationSpeed, RotationDirection,
PointIndex, WorldX, WorldY, WorldZ, TrefoilAngleDeg, MarkerPhi, TimeStamp,
TrialDuration, DisplayRefreshRateHz, MeasuredFrameRateHz`. The trefoil
rotates continuously, so each sample is de-rotated by its own
`TrefoilAngleDeg`:

```
p_local[i] = R_z(-TrefoilAngleDeg[i]) · (p_world[i] - stim_center) / 0.1
```

with `stim_center = (0, 1.0, 0.4)`. Stimulus parameters (R1, R2, speed,
direction) are assumed constant across trials in a file.

## Develop

```sh
npm install
npm run dev
```
