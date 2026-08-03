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

**Calibration (`RotatingTrace_Calib_*.csv`).** All five blocks live in one file,
split by `TrialType`. Samples use the same de-rotation as the main task, with
`stim_center = (0, 1.0, 0.65)` and scale `0.08`. Ground truth is the reference
curve from the coords CSV for the trefoil blocks, and for the cube blocks a
0.24 m wireframe at the origin of that frame — the cube sits at the same world
position as the trefoil, so both rest on the same fixed basis. Only the 9 edges
of `CubeCalibrator.polylineOrder` are scored; the other 3 are drawn faint,
as the headset shader draws them.

`cube_rotating` needs one extra step. Unity samples a rotation angle only for
the trefoil blocks, so those rows carry `ModelRotYDeg=0` even though the cube
was spinning, and de-rotating from the file alone freezes a moving cube — worth
27–32 mm rms on real trials, and half the apparent on-cube fraction. The angle
survives in `DistanceToCurve`, which was measured live against the true rotated
cube, so the viewer fits `theta(t) = theta0 + omega·t` back out of it. On full
30 s trials this lands at the CSV's own rounding floor (0.04 mm) and reproduces
the logged `IsOnCurve` fraction to 0.2 points. The trial readout names the
recovered rate and phase. Set **cube spin** in Scene Config to the Unity
`cubeRotationSpeed`; both directions are tried. The 9 scored edges are nearly
4-fold symmetric about Z — one depth edge breaks the tie — so a short fragment
can land on a 90° alias; the fit reports its margin over the nearest one and
falls back to drawing the cube unrotated when that margin is thin.

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
