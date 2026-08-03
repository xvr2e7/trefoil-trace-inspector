# Trefoil Trace Inspector

Browser-only 3D viewer for the tracing experiments:

- **Hand Tracking** — Unity pilot study (`*_Hand.csv`).
- **Rotating Trace** — SteamVR fingertip-tracker task (`RotatingTrace_*.csv`).
- **Calibration** — the cube and trefoil blocks of that task (`RotatingTrace_Calib_*.csv`).
- **Ellipse–Circle** — depth-scale control (`EllipseCircle_Traj_*.csv` + `EllipseCircle_*.csv`).

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

**Ellipse–Circle (`EllipseCircle_Traj_*.csv` + `EllipseCircle_*.csv`).** Drop
both files of a session together: the trajectory file holds the samples, but the
aspect ratio lives in the summary, and without it there is no reference circle
and no depth scale. Samples are de-rotated by their own `DiskAngleDeg` into the
disk's frame, in units of the disk's major radius (so a veridically traced
circle has radius 1):

```
p_local[i] = R_z(-DiskAngleDeg[i]) · (p_world[i] - disk_center) / (WorldDiameter/2)
```

with `disk_center = (0, 1.0, 0.65)`. The disk's own rotation is assumed identity
in the scene — rotating the disk object in Unity would break this.

The view draws the flat ellipse actually on screen (z=0) plus **both** tilt
readings of it, the one the trace matches solid and the mirror faint, since the
percept is bistable. Per trial it reports the traced depth against the isotropic
prediction (`k`), the fitted slant against the implied slant (`k(slant)`), the
distance to the predicted circle, and — when the two tilt arms come out even —
a warning that the percept flipped mid-trial, which is what drives a fitted
slant of ~0° with the depth extent intact. Movie mode steps through disk
revolutions, not hand traversals.

## Develop

```sh
npm install
npm run dev
```
