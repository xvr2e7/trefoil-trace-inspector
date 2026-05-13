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
const STIM_SCALE = 0.1;

export function handLocal3D(worldPts, freezeAngleDeg, handedness = "Right") {
  const pos = handedness?.toLowerCase().startsWith("l")
    ? FROZEN_POS_LEFT
    : FROZEN_POS_RIGHT;
  const a = -THREE.MathUtils.degToRad(freezeAngleDeg);
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const out = new Array(worldPts.length);
  for (let i = 0; i < worldPts.length; i++) {
    const px = (worldPts[i].x - pos.x) / STIM_SCALE;
    const py = (worldPts[i].y - pos.y) / STIM_SCALE;
    const pz = (worldPts[i].z - pos.z) / STIM_SCALE;
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
    "MarkerPhi", "TimeStamp", "TrialDuration",
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
        phis: [],
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
    t.phis.push(+f[col.MarkerPhi]);
    t.times.push(+f[col.TimeStamp]);
  }
  return [...trials.values()].sort((a, b) => a.TrialIndex - b.TrialIndex);
}

// The trefoil rotates continuously, so each sample is de-rotated by its own
// TrefoilAngleDeg:
//   p_local[i] = R_z(-angle[i]) * (p_world[i] - STIM_CENTER) / STIM_SCALE
const STIM_CENTER = new THREE.Vector3(0, 1.0, 0.4);

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
