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

// Trefoil stimulus: center (0, 1, 0.8), scale 0.1 — matches Unity scene.
//
// De-rotation for RotatingTrace: the trefoil rotates around Z.
//   p_local[i] = R_z(-TrefoilAngleDeg[i]) · (p_world[i] - STIM_CENTER) / STIM_SCALE
//
// Undoing the Z-rotation per sample places every point in a frame where the
// trefoil is stationary. The Z component carries the depth the participant
// reported for that position on the curve.
const STIM_CENTER = new THREE.Vector3(0, 1.0, 0.8);
const STIM_SCALE = 0.1;

export function trackerLocal3D(worldPts, anglesDeg) {
  const out = new Array(worldPts.length);
  for (let i = 0; i < worldPts.length; i++) {
    const a = -THREE.MathUtils.degToRad(anglesDeg[i]);
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const px = (worldPts[i].x - STIM_CENTER.x) / STIM_SCALE;
    const py = (worldPts[i].y - STIM_CENTER.y) / STIM_SCALE;
    const pz = (worldPts[i].z - STIM_CENTER.z) / STIM_SCALE;
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
// Calibration files (`RotatingTrace_Calib3D_*.csv`).
// ---------------------------------------------------------------------------
// Each row is one tracker sample. The 3D trefoil ground truth is known and
// rotates around the Y-axis. NearestCurveXYZ is the closest point on the
// 3D trefoil to the tracker position in world space, at ModelRotationYDeg.
export function parseCalib3DCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map((h) => h.trim());
  const col = Object.fromEntries(header.map((h, i) => [h, i]));
  const required = [
    "CalibTrialIndex", "PointIndex",
    "TrackerWorldX", "TrackerWorldY", "TrackerWorldZ",
    "NearestCurveX", "NearestCurveY", "NearestCurveZ",
    "NearestPhi", "ModelRotationYDeg", "TimeStamp", "TrialDuration",
  ];
  for (const k of required) {
    if (!(k in col)) throw new Error(`missing column: ${k}`);
  }

  const trials = new Map();
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split(",");
    if (f.length < header.length) continue;
    const tid = +f[col.CalibTrialIndex];
    let t = trials.get(tid);
    if (!t) {
      t = {
        CalibTrialIndex: tid,
        TrialDuration: +f[col.TrialDuration],
        world: [],
        nearest: [],
        phis: [],
        angles: [],
        times: [],
      };
      trials.set(tid, t);
    }
    t.world.push({
      x: +f[col.TrackerWorldX],
      y: +f[col.TrackerWorldY],
      z: +f[col.TrackerWorldZ],
    });
    t.nearest.push({
      x: +f[col.NearestCurveX],
      y: +f[col.NearestCurveY],
      z: +f[col.NearestCurveZ],
    });
    t.phis.push(+f[col.NearestPhi]);
    t.angles.push(+f[col.ModelRotationYDeg]);
    t.times.push(+f[col.TimeStamp]);
  }
  return [...trials.values()].sort((a, b) => a.CalibTrialIndex - b.CalibTrialIndex);
}

// De-rotation for Calib3D: the 3D trefoil rotates around Y.
//   p_local[i] = R_y(-ModelRotationYDeg[i]) · (p_world[i] - STIM_CENTER) / STIM_SCALE
//
// Apply to both TrackerWorld and NearestCurve to bring both into the
// trefoil's stationary local frame. NearestCurve de-rotated reconstructs
// the known 3D trefoil shape; TrackerWorld de-rotated shows the participant's
// trace in that same frame.
//
// R_y(-θ) applied to [px, py, pz]:
//   x' =  cos(θ)·px + sin(θ)·pz  (equivalently: ca·px + sa·pz with a = -θ, sa = -sin(θ))
//   y' =  py
//   z' = -sin(θ)·px + cos(θ)·pz  (equivalently: -sa·px + ca·pz)
export function calib3DLocal3D(worldPts, anglesDeg) {
  const out = new Array(worldPts.length);
  for (let i = 0; i < worldPts.length; i++) {
    const a = -THREE.MathUtils.degToRad(anglesDeg[i]);
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const px = (worldPts[i].x - STIM_CENTER.x) / STIM_SCALE;
    const py = (worldPts[i].y - STIM_CENTER.y) / STIM_SCALE;
    const pz = (worldPts[i].z - STIM_CENTER.z) / STIM_SCALE;
    // R_y(a) where a = -θ  →  R_y(-θ)
    out[i] = { x: ca * px + sa * pz, y: py, z: -sa * px + ca * pz };
  }
  return out;
}

// "RotatingTrace_Calib3D_20260513_151342.csv" → "20260513_151342".
export function sessionFromCalibFilename(name) {
  const base = name.replace(/\.csv$/i, "");
  return base.replace(/^RotatingTrace_Calib3D_/i, "") || base;
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
 * Calib3D (Y-axis rotation, ModelRotationYDeg) — both store their rotation
 * series in `trial.angles`.
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
// Shared reference outline.
// ---------------------------------------------------------------------------
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
