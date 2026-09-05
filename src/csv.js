import * as THREE from "three";

// ---------------------------------------------------------------------------
// Hand-tracking pilot files (`*_Hand.csv`).
// ---------------------------------------------------------------------------
// The two trailing JSON columns contain unescaped inner quotes that break
// naive CSV parsing, so we split manually: the head is the first 12
// comma-separated fields, then the rest is two JSON blobs joined by the
// literal `}","{`.
export function parseHandCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    let commas = 0;
    let jsonStart = -1;
    for (let k = 0; k < line.length; k++) {
      if (line[k] === ",") {
        commas++;
        if (commas === 12) {
          jsonStart = k + 1;
          break;
        }
      }
    }
    if (jsonStart < 0) continue;
    const head = line.slice(0, jsonStart - 1).split(",");
    const rest = line.slice(jsonStart);
    const sep = rest.indexOf('}","{');
    if (sep < 0) continue;
    const worldStr = rest.slice(1, sep + 1);
    const trefStr = rest.slice(sep + 4, -1);
    let worldJson, trefJson;
    try {
      worldJson = JSON.parse(worldStr);
    } catch {
      continue;
    }
    try {
      trefJson = JSON.parse(trefStr);
    } catch {
      continue;
    }
    rows.push({
      TrialNumber: +head[0],
      ConfigurationId: +head[1],
      RepetitionNumber: +head[2],
      Handedness: head[3],
      R1: +head[4],
      R2: +head[5],
      RotationSpeed: +head[6],
      Direction: +head[7],
      FreezeAngle: +head[8],
      NumTracePoints: +head[9],
      TracingDuration: +head[10],
      Timestamp: head[11],
      world: worldJson.points,
      trefoil: trefJson.points,
    });
  }
  return rows;
}

//   p_local = R_z(-FreezeAngle) * (p_world - trefoil_pos) / 0.1
// All six pilots are right-handed → frozen target sits at (+0.3, 1.0, 0.8).
const FROZEN_POS_RIGHT = new THREE.Vector3(0.3, 1.0, 0.8);
const FROZEN_POS_LEFT = new THREE.Vector3(-0.3, 1.0, 0.8);
const HAND_STIM_SCALE = 0.1;

export function handLocal3D(worldPts, freezeAngleDeg, handedness = "Right") {
  const pos = handedness?.toLowerCase().startsWith("l")
    ? FROZEN_POS_LEFT
    : FROZEN_POS_RIGHT;
  const a = -THREE.MathUtils.degToRad(freezeAngleDeg);
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const out = new Array(worldPts.length);
  for (let i = 0; i < worldPts.length; i++) {
    const px = (worldPts[i].x - pos.x) / HAND_STIM_SCALE;
    const py = (worldPts[i].y - pos.y) / HAND_STIM_SCALE;
    const pz = (worldPts[i].z - pos.z) / HAND_STIM_SCALE;
    out[i] = { x: ca * px - sa * py, y: sa * px + ca * py, z: pz };
  }
  return out;
}

// "CD0310_Hand.csv" → "CD0310".
export function participantFromFilename(name) {
  const base = name.replace(/\.csv$/i, "");
  return base.replace(/_Hand$/i, "");
}

// ---------------------------------------------------------------------------
// Rotating-trace SteamVR files (`RotatingTrace_*.csv`).
// ---------------------------------------------------------------------------
// Rows are one tracker sample each; samples are grouped by TrialIndex and
// stored as parallel arrays of world points + per-sample trefoil rotation.
export function parseTrackerCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map((h) => h.trim());
  const col = Object.fromEntries(header.map((h, i) => [h, i]));
  const required = [
    "TrialIndex", "Block", "TrialInBlock", "R1", "R2",
    "RotationSpeed", "RotationDirection", "PointIndex",
    "WorldX", "WorldY", "WorldZ", "TrefoilAngleDeg",
    "TimeStamp", "TrialDuration",
  ];
  for (const k of required) {
    if (!(k in col)) throw new Error(`missing column: ${k}`);
  }

  const trials = new Map();
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split(",");
    if (f.length < header.length) continue;
    const tid = +f[col.TrialIndex];
    let t = trials.get(tid);
    if (!t) {
      t = {
        TrialIndex: tid,
        Block: +f[col.Block],
        TrialInBlock: +f[col.TrialInBlock],
        R1: +f[col.R1],
        R2: +f[col.R2],
        RotationSpeed: +f[col.RotationSpeed],
        RotationDirection: +f[col.RotationDirection],
        TrialDuration: +f[col.TrialDuration],
        DisplayRefreshRateHz:
          col.DisplayRefreshRateHz != null ? +f[col.DisplayRefreshRateHz] : NaN,
        MeasuredFrameRateHz:
          col.MeasuredFrameRateHz != null ? +f[col.MeasuredFrameRateHz] : NaN,
        world: [],
        angles: [],
        times: [],
      };
      trials.set(tid, t);
    }
    t.world.push({
      x: +f[col.WorldX],
      y: +f[col.WorldY],
      z: +f[col.WorldZ],
    });
    t.angles.push(+f[col.TrefoilAngleDeg]);
    t.times.push(+f[col.TimeStamp]);
  }
  return [...trials.values()].sort((a, b) => a.TrialIndex - b.TrialIndex);
}

// Trefoil stimulus: center (0, 1, 0.65), scale 0.08 — matches Unity scene.
//
// De-rotation for RotatingTrace: the trefoil rotates around Z.
//   p_local[i] = R_z(-TrefoilAngleDeg[i]) · (p_world[i] - STIM_CENTER) / STIM_SCALE
//
// Undoing the Z-rotation per sample places every point in a frame where the
// trefoil is stationary. The Z component carries the depth the participant
// reported for that position on the curve.
export const DEFAULT_STIM_CENTER = { x: 0, y: 1.0, z: 0.65 }
export const DEFAULT_STIM_SCALE = 0.08
// World-space edge length = CubeCalibrator.edgeLength × cube transform scale.
// Default: edgeLength 0.3 × transformScale 0.8 = 0.24 m.
export const DEFAULT_CUBE_WORLD_EDGE = 0.24
// RotatingTraceExperimentManager.cubeRotationSpeed, applied about the cube's
// local Z by CubeCalibrator.Update.
export const DEFAULT_CUBE_SPIN_SPEED = 30

export function trackerLocal3D(worldPts, anglesDeg, center = DEFAULT_STIM_CENTER, scale = DEFAULT_STIM_SCALE) {
  const out = new Array(worldPts.length);
  for (let i = 0; i < worldPts.length; i++) {
    const a = -THREE.MathUtils.degToRad(anglesDeg[i]);
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const px = (worldPts[i].x - center.x) / scale;
    const py = (worldPts[i].y - center.y) / scale;
    const pz = (worldPts[i].z - center.z) / scale;
    out[i] = { x: ca * px - sa * py, y: sa * px + ca * py, z: pz };
  }
  return out;
}

// "RotatingTrace_20260513_151342.csv" → "20260513_151342".
export function sessionFromFilename(name) {
  const base = name.replace(/\.csv$/i, "");
  return base.replace(/^RotatingTrace_/i, "") || base;
}

// ---------------------------------------------------------------------------
// Calibration files (`RotatingTrace_Calib_*.csv`).
// ---------------------------------------------------------------------------
// One file per session; all 5 calibration phases are stored together,
// distinguished by the TrialType column:
//   cube_static         – static cube              (no NearestCurve data; angles = 0)
//   cube_rotating       – rotating cube            (no NearestCurve data; angles = 0
//                                                   in the file — recovered by fitCubeSpin)
//   trefoil2d_static    – flat 2D ribbon, paused   (no NearestCurve data; angles = 0)
//   trefoil3d_static    – 3D model, static         (NearestCurve populated; angles = 0)
//   trefoil3d_rotating  – 3D model, Z-rotating     (NearestCurve + ModelRotYDeg populated)
//
// TrialIndex repeats 0..N-1 within each phase, so rows are grouped by the
// composite key (TrialType, TrialIndex) to prevent cross-phase collision.
// `hasCurve` is true only for trefoil3d_* rows where NearestCurveXYZ is
// non-zero; `localNearest` will be null for all other types.
export function parseCalibCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map((h) => h.trim());
  const col = Object.fromEntries(header.map((h, i) => [h, i]));
  const required = [
    "TrialType", "TrialIndex", "PointIndex",
    "WorldX", "WorldY", "WorldZ",
    "NearestCurveX", "NearestCurveY", "NearestCurveZ",
    "NearestPhi", "ModelRotYDeg", "TimeStamp", "TrialDuration",
  ];
  for (const k of required) {
    if (!(k in col)) throw new Error(`missing column: ${k}`);
  }
  const hasOnCurveData = 'DistanceToCurve' in col && 'IsOnCurve' in col;

  const trials = new Map();
  let seqId = 0;
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split(",");
    if (f.length < header.length) continue;
    const trialType = f[col.TrialType].trim();
    const trialIdx  = +f[col.TrialIndex];
    const key = `${trialType}_${trialIdx}`;
    let t = trials.get(key);
    if (!t) {
      t = {
        CalibTrialIndex: seqId++,
        TrialType: trialType,
        TrialIndex: trialIdx,
        TrialDuration: +f[col.TrialDuration],
        hasCurve: false,
        world: [],
        nearest: [],
        phis: [],
        angles: [],
        times: [],
        distanceToCurve: hasOnCurveData ? [] : null,
        isOnCurve:       hasOnCurveData ? [] : null,
      };
      trials.set(key, t);
    }
    t.world.push({ x: +f[col.WorldX], y: +f[col.WorldY], z: +f[col.WorldZ] });
    const nx = +f[col.NearestCurveX];
    const ny = +f[col.NearestCurveY];
    const nz = +f[col.NearestCurveZ];
    t.nearest.push({ x: nx, y: ny, z: nz });
    if (nx !== 0 || ny !== 0 || nz !== 0) t.hasCurve = true;
    t.phis.push(+f[col.NearestPhi]);
    t.angles.push(+f[col.ModelRotYDeg]);
    t.times.push(+f[col.TimeStamp]);
    if (hasOnCurveData) {
      const dStr = f[col.DistanceToCurve].trim();
      t.distanceToCurve.push(dStr === '' ? NaN : +dStr);
      const ocStr = f[col.IsOnCurve].trim();
      t.isOnCurve.push(ocStr === '' ? NaN : +ocStr);
    }
  }
  return [...trials.values()].sort((a, b) => a.CalibTrialIndex - b.CalibTrialIndex);
}

// De-rotation for calib trefoil trials.
//
// Both FourierTrefoil3D (3D calib model, SetRotationMode zAxis:true) and
// TrefoilGenerator (2D main ribbon) rotate around the Z-axis:
//   transform.localRotation = Quaternion.Euler(0, 0, angle)
//
// `ModelRotYDeg` in the CSV stores the cumulative Z-rotation angle
// (the field is named after an older Y-axis design; the value is Z).
//
// De-rotation formula — identical to trackerLocal3D:
//   p_local[i] = R_z(-angle[i]) · (p_world[i] - STIM_CENTER) / STIM_SCALE
//
// Apply to both world and nearest-curve points to bring them into the
// trefoil's stationary local frame. For static trials (angles all 0) this
// reduces to a plain translate+scale.
export function calibDerotate(worldPts, anglesDeg, center = DEFAULT_STIM_CENTER, scale = DEFAULT_STIM_SCALE) {
  const out = new Array(worldPts.length);
  for (let i = 0; i < worldPts.length; i++) {
    const a = -THREE.MathUtils.degToRad(anglesDeg[i]);
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const px = (worldPts[i].x - center.x) / scale;
    const py = (worldPts[i].y - center.y) / scale;
    const pz = (worldPts[i].z - center.z) / scale;
    out[i] = { x: ca * px - sa * py, y: sa * px + ca * py, z: pz };
  }
  return out;
}

// "RotatingTrace_Calib_20260513_151342.csv" → "20260513_151342".
export function sessionFromCalibFilename(name) {
  const base = name.replace(/\.csv$/i, "");
  return base.replace(/^RotatingTrace_Calib_/i, "") || base;
}

// ---------------------------------------------------------------------------
// Recovering the rotating cube's spin angle.
// ---------------------------------------------------------------------------
// Unity never wrote it. RecordCalibPoint() samples a rotation angle only for
// trefoil3d_* trials, so every cube_rotating row carries ModelRotYDeg=0 even
// though CubeCalibrator really spins the cube at cubeRotationSpeed about its
// local Z. De-rotating with those zeros freezes a cube that was moving: on real
// trials it misplaces the trace relative to the cube by 27-32 mm rms (up to
// 12 cm) and halves the apparent on-cube fraction.
//
// The angle survives in the data anyway. DistanceToCurve was measured live
// against the truly rotated cube, so it pins the angle down at every sample.
// Fitting theta(t) = theta0 + omega·(t - t_first) against it recovers omega to
// ±0.05 deg/s and theta0 to ±0.05 deg on real 30 s trials, with an rms
// residual of 0.04 mm — the CSV's own 4-decimal rounding floor — and
// reproduces the logged IsOnCurve fraction to within 0.2 points.
//
// One caveat the caller should surface: the 9 scored edges are a square front
// face, a square back face and ONE connecting depth edge, so the residual is
// nearly 4-fold symmetric about Z. Only that single depth edge tells theta from
// theta+90. Whole trials resolve cleanly (the 90 deg aliases cost 18-27 mm rms
// against 0.04 mm for the true angle), but a short fragment can settle on an
// alias, so the fit reports its margin over the best one.

// Cube corners in CubeCalibrator's local frame, in units of half an edge.
// Order matches CubeCalibrator.localVertices.
const CUBE_CORNERS = [
  [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
  [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
];
// CubeCalibrator.polylineOrder = {0,1,2,3,0,4,5,6,7,4} as edges: the 9 the
// participant traces, and the only ones DistanceToCurve is measured against.
export const CUBE_TRACED_EDGES = [
  [0, 1], [1, 2], [2, 3], [3, 0], [0, 4], [4, 5], [5, 6], [6, 7], [7, 4],
];
// The 3 remaining edges. Drawn in the headset (dimmed by the shader) but never
// scored — including them changes distances by up to 24 mm on real traces.
export const CUBE_UNTRACED_EDGES = [[1, 5], [2, 6], [3, 7]];

const MIN_SPIN_FIT_POINTS = 30;
const SPIN_FIT_COARSE_SAMPLES = 250;   // decimation for the 1-degree sweep
const SPIN_FIT_ALIAS_SEPARATION = 45;  // degrees; anything closer is the same minimum

// Traced edges as {ax,ay,az, ux,uy,uz, len} for a cube at rest, centred on the
// origin. Points get rotated into this frame rather than the cube out of it.
function tracedEdgeSegments(halfEdge) {
  return CUBE_TRACED_EDGES.map(([i, j]) => {
    const a = CUBE_CORNERS[i].map((v) => v * halfEdge);
    const b = CUBE_CORNERS[j].map((v) => v * halfEdge);
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const len = Math.hypot(dx, dy, dz);
    return { ax: a[0], ay: a[1], az: a[2], ux: dx / len, uy: dy / len, uz: dz / len, len };
  });
}

function distToSegments(x, y, z, segs) {
  let best = Infinity;
  for (const s of segs) {
    const px = x - s.ax, py = y - s.ay, pz = z - s.az;
    let t = px * s.ux + py * s.uy + pz * s.uz;
    if (t < 0) t = 0; else if (t > s.len) t = s.len;
    const ex = px - t * s.ux, ey = py - t * s.uy, ez = pz - t * s.uz;
    const d = ex * ex + ey * ey + ez * ez;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

// rms gap between the distance a spinning cube would have produced and the
// distance Unity logged.
function spinResidual(pts, dists, dts, segs, center, theta0, omega) {
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = -((theta0 + omega * dts[i]) * Math.PI) / 180;
    const ca = Math.cos(a), sa = Math.sin(a);
    const qx = pts[i].x - center.x, qy = pts[i].y - center.y;
    const d = distToSegments(ca * qx - sa * qy, sa * qx + ca * qy, pts[i].z - center.z, segs);
    const e = d - dists[i];
    sum += e * e;
  }
  return Math.sqrt(sum / pts.length);
}

// Returns { angles, theta0, omega, rms, aliasRms, confident, n } or null when
// the trial carries no usable DistanceToCurve column.
// `angles` covers every sample, ready to hand to calibDerotate.
export function fitCubeSpin(worldPts, distanceToCurve, times, {
  center = DEFAULT_STIM_CENTER,
  worldEdge = DEFAULT_CUBE_WORLD_EDGE,
  speed = DEFAULT_CUBE_SPIN_SPEED,
} = {}) {
  if (!worldPts?.length || !distanceToCurve || !times?.length) return null;

  const pts = [], dists = [], dts = [];
  const t0 = times[0];
  for (let i = 0; i < worldPts.length; i++) {
    if (!Number.isFinite(distanceToCurve[i])) continue;
    pts.push(worldPts[i]);
    dists.push(distanceToCurve[i]);
    dts.push(times[i] - t0);
  }
  if (pts.length < MIN_SPIN_FIT_POINTS) return null;

  const segs = tracedEdgeSegments(worldEdge / 2);
  const step = Math.max(1, Math.floor(pts.length / SPIN_FIT_COARSE_SAMPLES));
  const cp = [], cd = [], ct = [];
  for (let i = 0; i < pts.length; i += step) { cp.push(pts[i]); cd.push(dists[i]); ct.push(dts[i]); }

  // Coarse sweep: 1 degree over both spin directions.
  const coarse = [];
  for (const omega of [speed, -speed]) {
    for (let th = 0; th < 360; th += 1) {
      coarse.push({ theta0: th, omega, rms: spinResidual(cp, cd, ct, segs, center, th, omega) });
    }
  }
  coarse.sort((a, b) => a.rms - b.rms);
  const top = coarse[0];

  // Best candidate that is a genuinely different solution, not the same
  // minimum sampled one degree over — this is the 90-degree alias margin.
  const alias = coarse.find((c) => {
    if (c.omega !== top.omega) return true;
    const d = Math.abs(c.theta0 - top.theta0) % 360;
    return Math.min(d, 360 - d) >= SPIN_FIT_ALIAS_SEPARATION;
  });

  // Refine on the full sample set: theta, then omega, then theta again.
  let { theta0, omega } = top;
  let rms = spinResidual(pts, dists, dts, segs, center, theta0, omega);
  const sweep = (values, apply) => {
    for (const v of values) {
      const cand = apply(v);
      const r = spinResidual(pts, dists, dts, segs, center, cand.theta0, cand.omega);
      if (r < rms) { rms = r; theta0 = cand.theta0; omega = cand.omega; }
    }
  };
  const range = (lo, hi, inc) => {
    const out = [];
    for (let v = lo; v <= hi + 1e-9; v += inc) out.push(v);
    return out;
  };
  sweep(range(theta0 - 1, theta0 + 1, 0.05), (v) => ({ theta0: v, omega }));
  sweep(range(omega - 0.5, omega + 0.5, 0.02), (v) => ({ theta0, omega: v }));
  sweep(range(theta0 - 0.2, theta0 + 0.2, 0.01), (v) => ({ theta0: v, omega }));

  const angles = new Array(worldPts.length);
  for (let i = 0; i < worldPts.length; i++) angles[i] = theta0 + omega * (times[i] - t0);

  const aliasRms = alias ? alias.rms : Infinity;
  return {
    angles,
    theta0: ((theta0 % 360) + 360) % 360,
    omega,
    rms,
    aliasRms,
    // A real solution beats its aliases by two to three orders of magnitude.
    confident: aliasRms > Math.max(rms * 5, 0.002),
    n: pts.length,
  };
}

// ---------------------------------------------------------------------------
// Ellipse–Circle control files (`EllipseCircle_Traj_*.csv` + `EllipseCircle_*.csv`).
// ---------------------------------------------------------------------------
// The control task spins a flat ellipse about the line of sight; the participant
// traces the rim of the circle they see tilted in depth. Two files per session:
//
//   EllipseCircle_Traj_*.csv  one row per sample — world path, the disk's spin
//                             angle at that sample, and the de-rotated copy
//                             Unity wrote (Local{X,Y,Z}, metres).
//   EllipseCircle_*.csv       one row per trial — aspect ratio, predicted depth,
//                             Unity's own fit. Needed for the reference circle
//                             and the depth scale k: the trajectory file alone
//                             does not carry the aspect ratio.
//
// The two are merged on (session, TrialIndex).

// Disk transform, from EllipseCircle.unity: EllipseDisk sits at (0, 1, 0.65) with
// identity rotation and uniform scale 0.4, so its local diameter of 1.0 is 0.4 m
// in the world.
export const DEFAULT_DISK_CENTER = { x: 0, y: 1.0, z: 0.65 }
export const DEFAULT_DISK_DIAMETER = 0.4

export function parseEllipseTrajCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0)
  if (lines.length < 2) return []
  const header = lines[0].split(",").map((h) => h.trim())
  const col = Object.fromEntries(header.map((h, i) => [h, i]))
  const required = [
    "TrialIndex", "PointIndex", "WorldX", "WorldY", "WorldZ",
    "DiskAngleDeg", "TimeStamp",
  ]
  for (const k of required) {
    if (!(k in col)) throw new Error(`missing column: ${k}`)
  }
  // Pre-2026-07-31 files logged world samples only, with no spin angle — those
  // traces cannot be de-rotated, and the missing column is caught above.
  const hasLogged = "LocalX" in col && "LocalY" in col && "LocalZ" in col

  const trials = new Map()
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split(",")
    if (f.length < header.length) continue
    const tid = +f[col.TrialIndex]
    let t = trials.get(tid)
    if (!t) {
      t = {
        TrialIndex: tid,
        world: [],
        angles: [],
        times: [],
        logged: hasLogged ? [] : null,
      }
      trials.set(tid, t)
    }
    t.world.push({ x: +f[col.WorldX], y: +f[col.WorldY], z: +f[col.WorldZ] })
    t.angles.push(+f[col.DiskAngleDeg])
    t.times.push(+f[col.TimeStamp])
    if (hasLogged) {
      t.logged.push({ x: +f[col.LocalX], y: +f[col.LocalY], z: +f[col.LocalZ] })
    }
  }
  return [...trials.values()].sort((a, b) => a.TrialIndex - b.TrialIndex)
}

// One row per trial → Map(TrialIndex → row). Unity's own fit is kept so the
// inspector's recomputation can be checked against it.
export function parseEllipseSummaryCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0)
  if (lines.length < 2) return new Map()
  const header = lines[0].split(",").map((h) => h.trim())
  const col = Object.fromEntries(header.map((h, i) => [h, i]))
  for (const k of ["TrialIndex", "AspectRatio", "WorldDiameter", "PredictedDepth"]) {
    if (!(k in col)) throw new Error(`missing column: ${k}`)
  }
  const num = (f, k) => (k in col ? +f[col[k]] : NaN)

  const out = new Map()
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split(",")
    if (f.length < header.length) continue
    out.set(+f[col.TrialIndex], {
      TrialIndex: +f[col.TrialIndex],
      ConfigId: num(f, "ConfigId"),
      RepetitionNumber: num(f, "RepetitionNumber"),
      AspectRatio: num(f, "AspectRatio"),
      ImpliedSlantDeg: num(f, "ImpliedSlantDeg"),
      WorldDiameter: num(f, "WorldDiameter"),
      PredictedDepth: num(f, "PredictedDepth"),
      RotationSpeed: num(f, "RotationSpeed"),
      Direction: num(f, "Direction"),
      TraceDuration: num(f, "TraceDuration"),
      NumTracePoints: num(f, "NumTracePoints"),
      // Unity's fit, in the disk frame (metres / degrees).
      TracedDepthZ: num(f, "TracedDepthZ"),
      FitSlantDeg: num(f, "FitSlantDeg"),
      MeasuredFrameRateHz: num(f, "MeasuredFrameRateHz"),
    })
  }
  return out
}

// World → disk frame, in units of the disk's major RADIUS, so a veridically
// traced circle has radius 1 and the viewer's default framing fits it:
//   p_local[i] = R_z(-DiskAngleDeg[i]) · (p_world[i] - center) / radius
//
// Same rotation convention as trackerLocal3D — both Unity stimuli spin with
// `transform.localRotation = Quaternion.Euler(0, 0, angle)`. The disk's un-spun
// rotation Q0 is dropped because it is identity in EllipseCircle.unity; rotating
// the disk object in the scene would invalidate this.
export function ellipseDerotate(
  worldPts, anglesDeg,
  center = DEFAULT_DISK_CENTER,
  radius = DEFAULT_DISK_DIAMETER / 2,
) {
  const out = new Array(worldPts.length)
  for (let i = 0; i < worldPts.length; i++) {
    const a = -THREE.MathUtils.degToRad(anglesDeg[i])
    const ca = Math.cos(a)
    const sa = Math.sin(a)
    const px = (worldPts[i].x - center.x) / radius
    const py = (worldPts[i].y - center.y) / radius
    const pz = (worldPts[i].z - center.z) / radius
    out[i] = { x: ca * px - sa * py, y: sa * px + ca * py, z: pz }
  }
  return out
}

// Per-trial fit of a de-rotated rim trace. Lengths in radius units; multiply by
// `radius` for metres. The slant fit is centroid-relative, matching
// EllipseCircleExperimentManager.FitSlantDeg, so the two are comparable.
export function fitEllipseTrace(local3D) {
  const n = local3D.length
  if (!n) return null

  let cx = 0, cy = 0, cz = 0
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (const p of local3D) {
    cx += p.x; cy += p.y; cz += p.z
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.z < minZ) minZ = p.z
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
    if (p.z > maxZ) maxZ = p.z
  }
  cx /= n; cy /= n; cz /= n

  // z = tan(sigma)·y about the centroid.
  let syy = 0, syz = 0
  for (const p of local3D) {
    const dy = p.y - cy
    const dz = p.z - cz
    syy += dy * dy
    syz += dy * dz
  }
  const slope = syy > 1e-12 ? syz / syy : 0
  const slantDeg = THREE.MathUtils.radToDeg(Math.atan(Math.abs(slope)))

  // How one-sided the tilt is. Each sample contributes |dy·dz| to the arm whose
  // sign it carries; a rim traced at one steady tilt puts nearly everything on
  // one arm, so the share sits near 1. If the percept flips mid-trial the two
  // arms even out toward 0.5 and the least-squares slant cancels to ~0 — which
  // would otherwise read as "saw no depth" rather than "saw both tilts".
  let wPos = 0, wNeg = 0
  for (const p of local3D) {
    const w = (p.y - cy) * (p.z - cz)
    if (w >= 0) wPos += w
    else wNeg -= w
  }
  const wTotal = wPos + wNeg
  const tiltShare = wTotal > 1e-12 ? Math.max(wPos, wNeg) / wTotal : 1

  return {
    tiltShare,
    centroid: { x: cx, y: cy, z: cz },
    extent: { x: maxX - minX, y: maxY - minY, z: maxZ - minZ },
    depth: maxZ - minZ,
    slope,
    slantDeg,
    // Sign of the tilt the participant reported: which way the rim leans in
    // depth. A mid-trial percept flip shows up as a slope near zero.
    tiltSign: slope >= 0 ? 1 : -1,
  }
}

// Predicted rim for aspect ratio a: the circle whose projection is the drawn
// ellipse, tilted about the major (x) axis. Radius units, so the major axis is 1.
//   c(t) = (cos t, a·sin t, s·sqrt(1-a^2)·sin t),   s = ±1 (bistable)
// s = +1 and s = -1 are both valid percepts of the same image.
export function predictedCircle(aspectRatio, sign = 1, segments = 180) {
  const a = Math.min(Math.max(aspectRatio, 0), 1)
  const depthAmp = sign * Math.sqrt(Math.max(0, 1 - a * a))
  const pts = new Array(segments + 1)
  for (let i = 0; i <= segments; i++) {
    const t = (i / segments) * Math.PI * 2
    const ct = Math.cos(t)
    const st = Math.sin(t)
    pts[i] = { x: ct, y: a * st, z: depthAmp * st }
  }
  return pts
}

// The flat ellipse actually drawn on the display (the retinal projection).
export function flatEllipse(aspectRatio, segments = 180) {
  return predictedCircle(aspectRatio, 0, segments)
}

// Distance from each sample to the predicted circle, for one tilt sign.
//
// The circle's plane is spanned by the orthonormal pair u = (1,0,0) and
// v = (0, a, s·sqrt(1-a^2)) — unit because a^2 + (1-a^2) = 1 — with normal
// n = u × v. In that basis the rim is the unit circle, so a point at radius r
// and out-of-plane height h is hypot(r-1, h) away from it.
//
// The circle is centered on the local-frame ORIGIN, which is the disk's own
// center, NOT the centroid of the trace being judged. (Centering a reference on
// the trace is the bug that made the cube overlay drift; see git history.)
export function circleFitError(local3D, aspectRatio, sign) {
  const a = Math.min(Math.max(aspectRatio, 0), 1)
  const d = Math.sqrt(Math.max(0, 1 - a * a))
  const vy = a, vz = sign * d
  const ny = -sign * d, nz = a

  let sum = 0
  let max = 0
  for (const p of local3D) {
    const pu = p.x
    const pv = p.y * vy + p.z * vz
    const h = p.y * ny + p.z * nz
    const r = Math.hypot(pu, pv)
    const dist = Math.hypot(r - 1, h)
    sum += dist
    if (dist > max) max = dist
  }
  return { mean: sum / local3D.length, max }
}

// Pick the tilt the trace actually matches, and report how well.
export function bestCircleFit(local3D, aspectRatio) {
  if (!local3D.length) return null
  const pos = circleFitError(local3D, aspectRatio, 1)
  const neg = circleFitError(local3D, aspectRatio, -1)
  return pos.mean <= neg.mean
    ? { sign: 1, ...pos, other: neg.mean }
    : { sign: -1, ...neg, other: pos.mean }
}

// Largest gap between the de-rotated points the inspector computes and the ones
// Unity logged. Non-zero means the assumed disk center/diameter differs from the
// scene's, so the whole local frame is off.
export function loggedLocalResidual(local3D, logged, radius) {
  if (!logged?.length) return null
  let max = 0
  const n = Math.min(local3D.length, logged.length)
  for (let i = 0; i < n; i++) {
    const dx = local3D[i].x * radius - logged[i].x
    const dy = local3D[i].y * radius - logged[i].y
    const dz = local3D[i].z * radius - logged[i].z
    const d = Math.hypot(dx, dy, dz)
    if (d > max) max = d
  }
  return max
}

// "EllipseCircle_Traj_20260731_120000.csv" → "20260731_120000".
export function sessionFromEllipseFilename(name) {
  const base = name.replace(/\.csv$/i, "")
  return base.replace(/^EllipseCircle_(Traj_)?/i, "") || base
}

// ---------------------------------------------------------------------------
// Movie-mode: cycle partitioning.
// ---------------------------------------------------------------------------

// Unwrap a degree-valued angle series so the cumulative rotation is monotonic.
// Each step is assumed to be the shortest arc (< 180°).
function unwrapAngles(angles) {
  if (angles.length === 0) return [];
  const out = new Float64Array(angles.length);
  out[0] = angles[0];
  for (let i = 1; i < angles.length; i++) {
    let diff = angles[i] - angles[i - 1];
    diff = ((diff + 180) % 360 + 360) % 360 - 180;
    out[i] = out[i - 1] + diff;
  }
  return out;
}

/**
 * Split a trial into per-rotation-cycle frames for the movie view.
 *
 * Works for both RotatingTrace (Z-axis rotation, TrefoilAngleDeg) and
 * calib trefoil trials (Z-axis rotation, ModelRotYDeg) — both store their
 * rotation series in `trial.angles`.
 *
 * `trial.local3D` must already be populated (done during file ingestion).
 * If `trial.localNearest` is present (calib data), it is partitioned into
 * the same cycles and exposed as `frame.nearestCurve`.
 *
 * Returns:
 *   frames   – array of { local3D, nearestCurve, times, rawAngles,
 *                          cycleIndex, isPartial, angleRange }
 *   warnings – human-readable strings describing numerical concerns
 */
export function partitionIntoCycles(trial) {
  const { local3D, angles, times, localNearest } = trial;

  if (!local3D || local3D.length === 0) {
    return { frames: [], warnings: ["No derotated data on trial."] };
  }

  const warnings = [];

  // --- Step 1: unwrap the angle series ---
  const unwrapped = unwrapAngles(angles);

  // --- Step 2: flag large inter-sample jumps ---
  for (let i = 1; i < angles.length; i++) {
    let diff = angles[i] - angles[i - 1];
    diff = ((diff + 180) % 360 + 360) % 360 - 180;
    if (Math.abs(diff) > 90) {
      warnings.push(
        `Large angular step at sample ${i}: ${Math.abs(diff).toFixed(1)}° ` +
          `(raw ${angles[i - 1].toFixed(1)}° → ${angles[i].toFixed(1)}°). ` +
          `Unwrapping may be unreliable near this sample.`
      );
    }
  }

  // --- Step 3: assign each sample to a 360° cycle ---
  const startAngle = unwrapped[0];
  const groups = new Map();
  for (let i = 0; i < local3D.length; i++) {
    const progress = Math.abs(unwrapped[i] - startAngle);
    const cyc = Math.floor(progress / 360);
    if (!groups.has(cyc)) {
      groups.set(cyc, {
        local3D: [],
        nearestCurve: localNearest ? [] : null,
        times: [],
        rawAngles: [],
        unwrappedAngles: [],
      });
    }
    const g = groups.get(cyc);
    g.local3D.push(local3D[i]);
    if (localNearest) g.nearestCurve.push(localNearest[i]);
    g.times.push(times[i]);
    g.rawAngles.push(angles[i]);
    g.unwrappedAngles.push(unwrapped[i]);
  }

  // --- Step 4: build frames, note partial cycles ---
  const frames = [];
  const cycleNums = [...groups.keys()].sort((a, b) => a - b);
  for (const cyc of cycleNums) {
    const g = groups.get(cyc);
    const uFirst = g.unwrappedAngles[0];
    const uLast = g.unwrappedAngles[g.unwrappedAngles.length - 1];
    const angleRange = Math.abs(uLast - uFirst);
    const isPartial = angleRange < 330;

    if (isPartial) {
      warnings.push(
        `Cycle ${cyc} spans only ${angleRange.toFixed(0)}° ` +
          `(${g.local3D.length} samples) — partial rotation, shown in grey.`
      );
    }

    frames.push({
      local3D: g.local3D,
      nearestCurve: g.nearestCurve,
      times: g.times,
      rawAngles: g.rawAngles,
      cycleIndex: cyc,
      isPartial,
      angleRange,
    });
  }

  return { frames, warnings };
}

// ---------------------------------------------------------------------------
// Shared reference curves.
// ---------------------------------------------------------------------------

// 2D flat reference (z forced to 0) — used for main-experiment and trefoil2d_static.
const refCache = {};
export async function loadReference(R2, baseUrl) {
  const key = R2.toFixed(1);
  if (refCache[key]) return refCache[key];
  const url = `${baseUrl}reference/coords_R2_${key}.csv`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`reference fetch failed: ${url}`);
  const text = await res.text();
  const pts = text
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((l) => {
      const [, x, y] = l.split(",").map(Number);
      return { x, y, z: 0 };
    });
  pts.push({ ...pts[0] });
  refCache[key] = pts;
  return pts;
}

// 3D reference curve (z from coords CSV * amplitude) — used for trefoil3d_* calib types.
// The coords CSV was generated with the same R1/R2 as the calibration model, but the
// calib 3D model sits 90° about Y of the CSV's orientation,
// so x/z are rotated here: (x, z*amplitude) → (z*amplitude, -x).
const ref3DCache = {};
export async function loadReference3D(R2, amplitude, baseUrl) {
  const key = `${R2.toFixed(1)}_${amplitude.toFixed(3)}`;
  if (ref3DCache[key]) return ref3DCache[key];
  const url = `${baseUrl}reference/coords_R2_${R2.toFixed(1)}.csv`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`reference fetch failed: ${url}`);
  const text = await res.text();
  const pts = text
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((l) => {
      const [, x, y, z] = l.split(",").map(Number);
      const zAmp = z * amplitude;
      return { x: zAmp, y, z: -x };
    });
  pts.push({ ...pts[0] });
  ref3DCache[key] = pts;
  return pts;
}
