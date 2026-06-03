import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import {
  parseHandCsv, handLocal3D, participantFromFilename,
  parseTrackerCsv, trackerLocal3D, sessionFromFilename,
  parseCalibCsv, calibDerotate, sessionFromCalibFilename,
  loadReference, loadReference3D, partitionIntoCycles,
  DEFAULT_STIM_CENTER, DEFAULT_STIM_SCALE, DEFAULT_CUBE_SCALE,
} from './csv.js'
import { Viewer, REP_COLORS, ALL_COLORS } from './viewer.js'

const BASE_URL = import.meta.env.BASE_URL
const MIN_POINTS = 10
// Calibration stimulus parameters — must match Unity inspector values in
// RotatingTraceExperimentManager (R2) and FourierTrefoil3D (calibAmplitude).
const CALIB_R2 = 1.5
const CALIB_AMPLITUDE = 1.0

const DEFAULT_CONFIG = {
  cx: DEFAULT_STIM_CENTER.x,
  cy: DEFAULT_STIM_CENTER.y,
  cz: DEFAULT_STIM_CENTER.z,
  stimScale: DEFAULT_STIM_SCALE,
  cubeScale: DEFAULT_CUBE_SCALE,
}

function hex(c) {
  return '#' + c.toString(16).padStart(6, '0')
}

// 'hand' | 'tracker' | 'calib' — falls back to null for unrecognised files.
function datasetFromFilename(name) {
  if (/^RotatingTrace_Calib_/i.test(name)) return 'calib'
  if (/^RotatingTrace_/i.test(name)) return 'tracker'
  if (/_Hand\.csv$/i.test(name)) return 'hand'
  return null
}

export default function App() {
  const plotRef = useRef(null)
  const viewerRef = useRef(null)

  const [dataset, setDataset] = useState('hand') // 'hand' | 'tracker' | 'calib'

  // Per-dataset bundles + active key, kept separate so switching the toggle
  // doesn't lose either side's loaded data.
  const [handBundles, setHandBundles] = useState({})
  const [trackerBundles, setTrackerBundles] = useState({})
  const [calibBundles, setCalibBundles] = useState({})
  const [handKey, setHandKey] = useState(null)
  const [trackerKey, setTrackerKey] = useState(null)
  const [calibKey, setCalibKey] = useState(null)

  // Scene config: trefoil/cube position + scale exposed for runtime tuning.
  const [stimConfig, setStimConfig] = useState(DEFAULT_CONFIG)
  const [draftConfig, setDraftConfig] = useState(DEFAULT_CONFIG)

  const [mode, setMode] = useState('single') // 'single' | 'condition' (hand only) | 'all' | 'movie' (tracker/calib)
  const [singleIdx, setSingleIdx] = useState(0)
  const [condIdx, setCondIdx] = useState(0)
  const [calibTypeFilter, setCalibTypeFilter] = useState('trefoil3d_rotating')
  const [showRef, setShowRef] = useState(true)
  const [dragOver, setDragOver] = useState(false)
  const [parseErr, setParseErr] = useState(null)
  const [hover, setHover] = useState(null)

  // Movie-mode state
  const [movieResult, setMovieResult] = useState(null)  // { frames, warnings }
  const [movieFrameIdx, setMovieFrameIdx] = useState(0)
  const [moviePlaying, setMoviePlaying] = useState(false)
  const [movieFps, setMovieFps] = useState(2)
  const [movieRefPts, setMovieRefPts] = useState(null)  // 2D reference (tracker only)
  const movieLastTsRef = useRef(null)

  const bundles = dataset === 'hand' ? handBundles : dataset === 'tracker' ? trackerBundles : calibBundles
  const activeKey = dataset === 'hand' ? handKey : dataset === 'tracker' ? trackerKey : calibKey
  // For calib dataset, apply TrialType filter before passing to all rendering
  // paths. For hand/tracker datasets, returns the raw bundle unchanged.
  const trials = useMemo(() => {
    const all = (activeKey && bundles[activeKey]) ? bundles[activeKey] : []
    if (dataset !== 'calib' || calibTypeFilter === 'all') return all
    return all.filter((t) => t.TrialType === calibTypeFilter)
  }, [bundles, activeKey, dataset, calibTypeFilter])

  const byCondition = useMemo(() => {
    if (dataset !== 'hand') return {}
    const m = {}
    for (const t of trials) (m[t.ConfigurationId] ??= []).push(t)
    for (const k of Object.keys(m)) m[k].sort((a, b) => a.RepetitionNumber - b.RepetitionNumber)
    return m
  }, [trials, dataset])
  const condIds = Object.keys(byCondition).map(Number).sort((a, b) => a - b)

  // Boot the Three.js viewer once the container is mounted.
  useEffect(() => {
    if (!plotRef.current) return
    const v = new Viewer(plotRef.current)
    viewerRef.current = v
    v.setHoverCallback((h) => {
      if (!h) { setHover(null); return }
      const r = plotRef.current.getBoundingClientRect()
      setHover({ p: h.point, i: h.index, x: h.clientX - r.left, y: h.clientY - r.top })
    })
    return () => {
      v.dispose()
      viewerRef.current = null
    }
  }, [])

  // If we switch to a dataset that doesn't support the current mode, fall back.
  useEffect(() => {
    if (dataset === 'tracker' && mode === 'condition') setMode('single')
    if (dataset === 'calib' && mode === 'condition') setMode('single')
    if (dataset === 'hand' && mode === 'movie') setMode('single')
  }, [dataset, mode])

  // Reset trial index when calib type filter changes (filtered list may be shorter).
  useEffect(() => { setSingleIdx(0) }, [calibTypeFilter])

  // Re-render scene whenever the chosen view changes (non-movie modes).
  useEffect(() => {
    const v = viewerRef.current
    if (!v) return
    if (mode === 'movie') return
    let cancelled = false
    ;(async () => {
      v.clearAll()
      if (!trials.length) return

      if (dataset === 'calib') {
        if (mode === 'single') {
          const t = trials[Math.min(singleIdx, trials.length - 1)]
          if (!t) return
          if (showRef && t.localNearest?.length) v.addRef3D(t.localNearest)
          if (showRef && t.cubeRef) v.addWireframeCube(t.cubeRef.center, t.cubeRef.halfEdge)
          v.addTrace(t.local3D, REP_COLORS[t.CalibTrialIndex % REP_COLORS.length], {
            showDots: true, alpha: 1.0,
          })
        } else {
          // all — keep per-trial colors so trials are distinguishable
          for (let i = 0; i < trials.length; i++) {
            const t = trials[i]
            if (showRef && t.localNearest?.length) v.addRef3D(t.localNearest)
            if (showRef && t.cubeRef) v.addWireframeCube(t.cubeRef.center, t.cubeRef.halfEdge)
            v.addTrace(t.local3D, ALL_COLORS[i % ALL_COLORS.length], {
              alpha: 0.55, showDots: true, dotSize: 0.03,
            })
          }
        }
        return
      }

      if (mode === 'single') {
        const t = trials[Math.min(singleIdx, trials.length - 1)]
        if (!t) return
        if (showRef) v.addReference(await loadReference(t.R2, BASE_URL))
        if (cancelled) return
        const repIdx = dataset === 'hand' ? t.RepetitionNumber : t.TrialIndex
        v.addTrace(t.local3D, REP_COLORS[repIdx % REP_COLORS.length] ?? ALL_COLORS[0], {
          showDots: true,
          alpha: 1.0,
        })
      } else if (mode === 'condition') {
        const ts = byCondition[condIdx] ?? []
        if (ts.length && showRef) v.addReference(await loadReference(ts[0].R2, BASE_URL))
        if (cancelled) return
        for (const t of ts) {
          v.addTrace(t.local3D, REP_COLORS[t.RepetitionNumber] ?? ALL_COLORS[0], {
            alpha: 0.9,
            showDots: true,
            dotSize: 0.04,
          })
        }
      } else {
        const r2s = [...new Set(trials.map((t) => t.R2))]
        if (showRef) {
          for (const r2 of r2s) v.addReference(await loadReference(r2, BASE_URL))
        }
        if (cancelled) return
        trials.forEach((t, i) =>
          v.addTrace(t.local3D, ALL_COLORS[i % ALL_COLORS.length], {
            alpha: 0.55,
            showDots: true,
            dotSize: 0.03,
          }),
        )
      }
    })().catch((e) => {
      console.error(e)
      setParseErr(String(e.message ?? e))
    })
    return () => { cancelled = true }
  }, [trials, byCondition, mode, singleIdx, condIdx, showRef, dataset])

  // Resize plot when the layout might have changed.
  useEffect(() => {
    viewerRef.current?.resize()
  }, [handBundles, trackerBundles, calibBundles, dataset, handKey, trackerKey, calibKey])

  // --- Movie mode effects ---

  // (1) Compute cycle frames whenever we enter movie mode or the trial changes.
  useEffect(() => {
    if (mode !== 'movie' || !trials.length) {
      setMovieResult(null)
      setMovieFrameIdx(0)
      setMoviePlaying(false)
      return
    }
    const t = trials[Math.min(singleIdx, trials.length - 1)]
    if (!t?.local3D) { setMovieResult(null); return }
    const result = partitionIntoCycles(t)
    setMovieResult(result)
    setMovieFrameIdx(0)
    setMoviePlaying(false)
    movieLastTsRef.current = null
  }, [mode, trials, singleIdx])

  // (2) Preload the 2D reference curve for tracker movie mode (calib uses its
  //     own per-frame nearestCurve, so no server load is needed there).
  useEffect(() => {
    if (mode !== 'movie' || !trials.length || !showRef || dataset === 'calib') {
      setMovieRefPts(null)
      return
    }
    const t = trials[Math.min(singleIdx, trials.length - 1)]
    if (!t) { setMovieRefPts(null); return }
    let cancelled = false
    loadReference(t.R2, BASE_URL)
      .then((pts) => { if (!cancelled) setMovieRefPts(pts) })
      .catch(() => { if (!cancelled) setMovieRefPts(null) })
    return () => { cancelled = true }
  }, [mode, trials, singleIdx, showRef, dataset])

  // (3) Animation loop — advances movieFrameIdx at movieFps frames/second.
  useEffect(() => {
    if (!moviePlaying || !movieResult?.frames.length) return
    const numFrames = movieResult.frames.length
    const msPerFrame = 1000 / movieFps
    let raf
    const tick = (ts) => {
      if (movieLastTsRef.current === null) movieLastTsRef.current = ts
      const elapsed = ts - movieLastTsRef.current
      if (elapsed >= msPerFrame) {
        const steps = Math.floor(elapsed / msPerFrame)
        setMovieFrameIdx((prev) => (prev + steps) % numFrames)
        movieLastTsRef.current = ts - (elapsed % msPerFrame)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => { cancelAnimationFrame(raf); movieLastTsRef.current = null }
  }, [moviePlaying, movieResult, movieFps])

  // (4) Render the current movie frame to the Three.js scene.
  useEffect(() => {
    if (mode !== 'movie' || !movieResult?.frames.length) return
    const v = viewerRef.current
    if (!v) return

    const { frames } = movieResult
    const numFrames = frames.length
    const idx = ((movieFrameIdx % numFrames) + numFrames) % numFrames
    const frame = frames[idx]

    const movieTrial = trials[Math.min(singleIdx, trials.length - 1)]
    v.clearAll()
    // Tracker: 2D flat reference loaded from server.
    if (movieRefPts) v.addReference(movieRefPts)
    // Calib: curve or cube ground truth for this trial.
    if (frame.nearestCurve?.length && showRef) v.addRef3D(frame.nearestCurve)
    if (movieTrial?.cubeRef && showRef) v.addWireframeCube(movieTrial.cubeRef.center, movieTrial.cubeRef.halfEdge)

    const color = frame.isPartial ? 0x888888 : REP_COLORS[idx % REP_COLORS.length]
    v.addTrace(frame.local3D, color, { showDots: true, alpha: 1.0 })
  }, [mode, movieResult, movieFrameIdx, movieRefPts, showRef])

  // Re-derive local3D for all loaded tracker + calib bundles when config changes.
  const applyStimConfig = useCallback((cfg) => {
    const center = { x: cfg.cx, y: cfg.cy, z: cfg.cz }
    const scale = cfg.stimScale
    const halfEdge = (cfg.cubeScale / 2) / cfg.stimScale

    setTrackerBundles((prev) => {
      if (!Object.keys(prev).length) return prev
      const next = {}
      for (const [key, rows] of Object.entries(prev)) {
        next[key] = rows.map((t) => ({ ...t, local3D: trackerLocal3D(t.world, t.angles, center, scale) }))
      }
      return next
    })

    setCalibBundles((prev) => {
      if (!Object.keys(prev).length) return prev
      const next = {}
      for (const [key, rows] of Object.entries(prev)) {
        next[key] = rows.map((t) => {
          const local3D = calibDerotate(t.world, t.angles, center, scale)
          if (t.cubeRef !== null) {
            const n = local3D.length
            const cx = local3D.reduce((s, p) => s + p.x, 0) / n
            const cy = local3D.reduce((s, p) => s + p.y, 0) / n
            const cz = local3D.reduce((s, p) => s + p.z, 0) / n
            return { ...t, local3D, cubeRef: { center: { x: cx, y: cy, z: cz }, halfEdge } }
          }
          return { ...t, local3D }
        })
      }
      return next
    })

    setStimConfig(cfg)
  }, [])

  const ingestFiles = useCallback(async (files) => {
    setParseErr(null)
    const csvFiles = [...files].filter((f) => /\.csv$/i.test(f.name))
    if (!csvFiles.length) {
      setParseErr('No .csv files in drop')
      return
    }
    const nextHand = { ...handBundles }
    const nextTracker = { ...trackerBundles }
    const nextCalib = { ...calibBundles }
    let firstNewHand = null
    let firstNewTracker = null
    let firstNewCalib = null
    const errors = []
    const cfgCenter = { x: stimConfig.cx, y: stimConfig.cy, z: stimConfig.cz }
    const cfgScale = stimConfig.stimScale
    const cfgHalfEdge = (stimConfig.cubeScale / 2) / stimConfig.stimScale
    for (const f of csvFiles) {
      const kind = datasetFromFilename(f.name) ?? dataset
      try {
        const text = await f.text()
        if (kind === 'calib') {
          const rows = parseCalibCsv(text).filter((t) => t.world.length >= MIN_POINTS)
          if (!rows.length) {
            errors.push(`${f.name}: 0 trials with ≥${MIN_POINTS} points`)
            continue
          }
          // Ground truth per trial type:
          //   trefoil2d_static        → 2D flat curve at z=0 from coords CSV
          //   trefoil3d_static/rotating → 3D curve from coords CSV, z scaled by CALIB_AMPLITUDE
          //   cube_*                  → wireframe cube; center estimated from data centroid,
          //                            halfEdge = (cubeScale/2) / stimScale in trefoil-local units
          const TREFOIL_TYPES = new Set(['trefoil2d_static', 'trefoil3d_static', 'trefoil3d_rotating'])
          for (const t of rows) {
            t.local3D = calibDerotate(t.world, t.angles, cfgCenter, cfgScale)
            if (TREFOIL_TYPES.has(t.TrialType)) {
              t.hasCurve = true
              t.cubeRef = null
              t.localNearest = t.TrialType === 'trefoil2d_static'
                ? await loadReference(CALIB_R2, BASE_URL)
                : await loadReference3D(CALIB_R2, CALIB_AMPLITUDE, BASE_URL)
            } else {
              // Estimate cube center from centroid of de-rotated trace points
              const n = t.local3D.length
              const cx = t.local3D.reduce((s, p) => s + p.x, 0) / n
              const cy = t.local3D.reduce((s, p) => s + p.y, 0) / n
              const cz = t.local3D.reduce((s, p) => s + p.z, 0) / n
              t.hasCurve = true
              t.cubeRef = { center: { x: cx, y: cy, z: cz }, halfEdge: cfgHalfEdge }
              t.localNearest = null
            }
          }
          const id = sessionFromCalibFilename(f.name)
          nextCalib[id] = rows
          firstNewCalib ??= id
        } else if (kind === 'tracker') {
          const rows = parseTrackerCsv(text).filter((t) => t.world.length >= MIN_POINTS)
          if (!rows.length) {
            errors.push(`${f.name}: 0 trials with ≥${MIN_POINTS} points`)
            continue
          }
          for (const t of rows) t.local3D = trackerLocal3D(t.world, t.angles, cfgCenter, cfgScale)
          const id = sessionFromFilename(f.name)
          nextTracker[id] = rows
          firstNewTracker ??= id
        } else {
          const rows = parseHandCsv(text)
          if (!rows.length) {
            errors.push(`${f.name}: 0 rows parsed`)
            continue
          }
          for (const t of rows) t.local3D = handLocal3D(t.world, t.FreezeAngle, t.Handedness)
          const id = participantFromFilename(f.name)
          nextHand[id] = rows
          firstNewHand ??= id
        }
      } catch (e) {
        errors.push(`${f.name}: ${e.message ?? e}`)
      }
    }
    setHandBundles(nextHand)
    setTrackerBundles(nextTracker)
    setCalibBundles(nextCalib)
    // Switch to the most-specific newly loaded dataset.
    if (firstNewCalib) {
      setCalibKey(firstNewCalib)
      setDataset('calib')
      setSingleIdx(0)
      if (mode === 'condition') setMode('single')
    } else if (firstNewTracker) {
      setTrackerKey(firstNewTracker)
      setDataset('tracker')
      setSingleIdx(0)
      if (mode === 'condition') setMode('single')
    } else if (firstNewHand) {
      setHandKey(firstNewHand)
      setDataset('hand')
      setSingleIdx(0)
    }
    if (errors.length) setParseErr(errors.join('\n'))
  }, [handBundles, trackerBundles, calibBundles, dataset, mode, stimConfig])

  const onDrop = useCallback(
    (e) => {
      e.preventDefault()
      setDragOver(false)
      if (e.dataTransfer?.files?.length) ingestFiles(e.dataTransfer.files)
    },
    [ingestFiles],
  )

  const onPick = useCallback(
    (e) => {
      if (e.target.files?.length) ingestFiles(e.target.files)
      e.target.value = ''
    },
    [ingestFiles],
  )

  const onExport = useCallback(() => {
    const v = viewerRef.current
    if (!v) return
    const url = v.snapshot()
    const a = document.createElement('a')
    let name = activeKey ?? 'view'
    if (mode === 'single') {
      const t = trials[singleIdx]
      const trialId = dataset === 'hand' ? t?.TrialNumber
        : dataset === 'calib' ? t?.CalibTrialIndex
        : t?.TrialIndex
      name += `_trial${trialId ?? singleIdx}`
    } else if (mode === 'condition') name += `_cond${condIdx}`
    else if (mode === 'movie') {
      const t = trials[Math.min(singleIdx, trials.length - 1)]
      const trialId = dataset === 'calib' ? t?.CalibTrialIndex : (t?.TrialIndex ?? singleIdx)
      const numFrames = movieResult?.frames.length ?? 1
      const idx = ((movieFrameIdx % numFrames) + numFrames) % numFrames
      name += `_trial${trialId}_cycle${idx + 1}of${numFrames}`
    } else name += '_all'
    a.download = `${name}.png`
    a.href = url
    a.click()
  }, [activeKey, mode, singleIdx, condIdx, trials, dataset, movieResult, movieFrameIdx])

  // Info panel content.
  const info = (() => {
    if (!trials.length) return ''

    if (dataset === 'calib') {
      if (mode === 'movie') {
        const t = trials[Math.min(singleIdx, trials.length - 1)]
        if (!t) return ''
        if (!movieResult?.frames.length) return 'Computing cycles…'
        const numFrames = movieResult.frames.length
        const idx = ((movieFrameIdx % numFrames) + numFrames) % numFrames
        const frame = movieResult.frames[idx]
        const t0 = frame.times[0]?.toFixed(2) ?? '?'
        const t1 = frame.times[frame.times.length - 1]?.toFixed(2) ?? '?'
        return (
          `Cycle ${idx + 1} / ${numFrames}${frame.isPartial ? ' (partial — grey)' : ''}\n` +
          `angle span: ${frame.angleRange.toFixed(0)}°  samples: ${frame.local3D.length}\n` +
          `time: [${t0}s, ${t1}s]\n` +
          `${t.TrialType} · trial ${t.TrialIndex}  duration=${t.TrialDuration.toFixed(2)}s`
        )
      }
      if (mode === 'single') {
        const t = trials[Math.min(singleIdx, trials.length - 1)]
        if (!t) return ''
        let onCurveInfo = ''
        if (t.isOnCurve) {
          const valid = t.isOnCurve.filter((v) => !isNaN(v))
          const onN = valid.filter((v) => v === 1).length
          const pct = valid.length ? (onN / valid.length * 100).toFixed(1) : '—'
          const validDist = (t.distanceToCurve || []).filter((v) => !isNaN(v))
          const meanMm = validDist.length
            ? (validDist.reduce((s, v) => s + v, 0) / validDist.length * 1000).toFixed(1)
            : '—'
          onCurveInfo = `\non-curve: ${onN}/${valid.length} pts (${pct}%)  mean dist: ${meanMm}mm`
        }
        return (
          `${t.TrialType} · trial ${t.TrialIndex}\n` +
          `duration=${t.TrialDuration.toFixed(2)}s  samples=${t.world.length}` +
          (t.hasCurve ? '  [ground truth ✓]' : '') +
          onCurveInfo
        )
      }
      const types = [...new Set(trials.map((t) => t.TrialType))].join(', ')
      const trialsWithOC = trials.filter((t) => t.isOnCurve)
      let aggInfo = ''
      if (trialsWithOC.length) {
        const allValid = trialsWithOC.flatMap((t) => t.isOnCurve.filter((v) => !isNaN(v)))
        const onN = allValid.filter((v) => v === 1).length
        const pct = allValid.length ? (onN / allValid.length * 100).toFixed(1) : '—'
        aggInfo = `\non-curve: ${onN}/${allValid.length} pts (${pct}%) across ${trialsWithOC.length} trials`
      }
      return `${trials.length} calib trials  [${types}]` + aggInfo
    }

    if (dataset === 'hand') {
      if (mode === 'single') {
        const t = trials[singleIdx]
        if (!t) return ''
        return (
          `Trial ${t.TrialNumber} · cfg ${t.ConfigurationId} · rep ${t.RepetitionNumber}\n` +
          `R1=${t.R1}  R2=${t.R2}  speed=${t.RotationSpeed}°/s  dir=${t.Direction}\n` +
          `freeze=${t.FreezeAngle.toFixed(1)}°  duration=${t.TracingDuration.toFixed(2)}s\n` +
          `trace points: ${t.NumTracePoints}`
        )
      }
      if (mode === 'condition') {
        const ts = byCondition[condIdx] ?? []
        if (!ts.length) return `Condition ${condIdx}: no trials`
        const s = ts[0]
        const meanDur = ts.reduce((a, t) => a + t.TracingDuration, 0) / ts.length
        return (
          `Condition ${condIdx} · ${ts.length} repetitions\n` +
          `R1=${s.R1}  R2=${s.R2}  speed=${s.RotationSpeed}°/s  dir=${s.Direction}\n` +
          `mean duration: ${meanDur.toFixed(2)}s`
        )
      }
      const r2s = [...new Set(trials.map((t) => t.R2))]
      return `All ${trials.length} trials overlaid\nR2 values: ${r2s.join(', ')}`
    }

    // tracker
    if (mode === 'movie') {
      const t = trials[Math.min(singleIdx, trials.length - 1)]
      if (!t) return ''
      const dir = t.RotationDirection > 0 ? 'CCW' : 'CW'
      if (!movieResult?.frames.length) return 'Computing cycles…'
      const numFrames = movieResult.frames.length
      const idx = ((movieFrameIdx % numFrames) + numFrames) % numFrames
      const frame = movieResult.frames[idx]
      const t0 = frame.times[0]?.toFixed(2) ?? '?'
      const t1 = frame.times[frame.times.length - 1]?.toFixed(2) ?? '?'
      return (
        `Cycle ${idx + 1} / ${numFrames}${frame.isPartial ? ' (partial — grey)' : ''}\n` +
        `angle span: ${frame.angleRange.toFixed(0)}°  samples: ${frame.local3D.length}\n` +
        `time: [${t0}s, ${t1}s]\n` +
        `Trial ${t.TrialIndex}: R1=${t.R1} R2=${t.R2} ${t.RotationSpeed}°/s ${dir}`
      )
    }
    if (mode === 'single') {
      const t = trials[singleIdx]
      if (!t) return ''
      const dir = t.RotationDirection > 0 ? 'CCW' : 'CW'
      return (
        `Trial ${t.TrialIndex} · block ${t.Block} · in-block ${t.TrialInBlock}\n` +
        `R1=${t.R1}  R2=${t.R2}  speed=${t.RotationSpeed}°/s  dir=${dir}\n` +
        `duration=${t.TrialDuration.toFixed(2)}s  samples=${t.world.length}\n` +
        `measured fps=${t.MeasuredFrameRateHz.toFixed(1)}`
      )
    }
    const s = trials[0]
    const meanDur = trials.reduce((a, t) => a + t.TrialDuration, 0) / trials.length
    return (
      `All ${trials.length} trials overlaid\n` +
      `R1=${s.R1}  R2=${s.R2}  speed=${s.RotationSpeed}°/s  dir=${s.RotationDirection > 0 ? 'CCW' : 'CW'}\n` +
      `mean duration: ${meanDur.toFixed(2)}s`
    )
  })()

  // Legend rows.
  const legend = (() => {
    if (!trials.length) return null

    if (dataset === 'calib') {
      if (mode === 'movie') {
        const t = trials[Math.min(singleIdx, trials.length - 1)]
        if (!movieResult?.frames.length) return null
        const numFrames = movieResult.frames.length
        const idx = ((movieFrameIdx % numFrames) + numFrames) % numFrames
        const frame = movieResult.frames[idx]
        const color = frame.isPartial ? 0x888888 : REP_COLORS[idx % REP_COLORS.length]
        return (
          <>
            <div>
              <span className="sw" style={{ background: hex(color) }} />
              cycle {idx + 1}/{numFrames}{frame.isPartial ? ' (partial)' : ''}
            </div>
            {showRef && t && t.hasCurve && (
              <div>
                <span className="sw" style={{ background: '#70e0c0' }} />
                {t.cubeRef ? 'cube wireframe (est. center)' : 'ground truth'}
              </div>
            )}
            <div style={{ color: '#5a6070', marginTop: 4 }}>grey = partial cycle</div>
          </>
        )
      }
      if (mode === 'single') {
        const t = trials[Math.min(singleIdx, trials.length - 1)]
        if (!t) return null
        return (
          <>
            <div>
              <span className="sw" style={{ background: hex(REP_COLORS[t.CalibTrialIndex % REP_COLORS.length]) }} />
              {t.TrialType} · trial {t.TrialIndex}
            </div>
            {showRef && t.hasCurve && (
              <div>
                <span className="sw" style={{ background: '#70e0c0' }} />
                {t.cubeRef ? 'cube wireframe (est. center)' : 'ground truth'}
              </div>
            )}
          </>
        )
      }
      return (
        <>
          <div style={{ color: '#8891a3' }}>all {trials.length} calib trials</div>
          {trials.map((t, i) => (
            <div key={t.CalibTrialIndex}>
              <span className="sw" style={{ background: hex(ALL_COLORS[i % ALL_COLORS.length]) }} />
              {t.TrialType} · {t.TrialIndex}
            </div>
          ))}
          {showRef && (
            <div>
              <span className="sw" style={{ background: '#70e0c0' }} />
              ground truth
            </div>
          )}
        </>
      )
    }

    if (dataset === 'hand') {
      if (mode === 'single') {
        const t = trials[singleIdx]
        if (!t) return null
        return (
          <>
            <div>
              <span className="sw" style={{ background: hex(REP_COLORS[t.RepetitionNumber] ?? ALL_COLORS[0]) }} />
              trace (rep {t.RepetitionNumber})
            </div>
            <div>
              <span className="sw" style={{ background: '#a0b4dc' }} />
              reference (R2={t.R2}, z=0)
            </div>
          </>
        )
      }
      if (mode === 'condition') {
        const ts = byCondition[condIdx] ?? []
        return ts.map((t) => (
          <div key={t.TrialNumber}>
            <span className="sw" style={{ background: hex(REP_COLORS[t.RepetitionNumber] ?? ALL_COLORS[0]) }} />
            rep {t.RepetitionNumber} (trial {t.TrialNumber})
          </div>
        ))
      }
      return (
        <>
          <div style={{ color: '#8891a3' }}>all {trials.length} trials</div>
          {condIds.map((c) => {
            const s = byCondition[c][0]
            return (
              <div key={c}>
                cfg {c}: R1={s.R1} R2={s.R2} spd={s.RotationSpeed} dir={s.Direction}
              </div>
            )
          })}
        </>
      )
    }

    // tracker — movie mode
    if (mode === 'movie') {
      const t = trials[Math.min(singleIdx, trials.length - 1)]
      if (!movieResult?.frames.length) return null
      const numFrames = movieResult.frames.length
      const idx = ((movieFrameIdx % numFrames) + numFrames) % numFrames
      const frame = movieResult.frames[idx]
      const color = frame.isPartial ? 0x888888 : REP_COLORS[idx % REP_COLORS.length]
      return (
        <>
          <div>
            <span className="sw" style={{ background: hex(color) }} />
            cycle {idx + 1}/{numFrames}{frame.isPartial ? ' (partial)' : ''}
          </div>
          {showRef && t && (
            <div>
              <span className="sw" style={{ background: '#a0b4dc' }} />
              reference (R2={t.R2}, z=0)
            </div>
          )}
          <div style={{ color: '#5a6070', marginTop: 4 }}>grey = partial cycle</div>
        </>
      )
    }
    // tracker — single
    if (mode === 'single') {
      const t = trials[singleIdx]
      if (!t) return null
      return (
        <>
          <div>
            <span className="sw" style={{ background: hex(REP_COLORS[t.TrialIndex % REP_COLORS.length]) }} />
            trace (trial {t.TrialIndex})
          </div>
          <div>
            <span className="sw" style={{ background: '#a0b4dc' }} />
            reference (R2={t.R2}, z=0)
          </div>
        </>
      )
    }
    return (
      <>
        <div style={{ color: '#8891a3' }}>all {trials.length} trials</div>
        {trials.map((t, i) => (
          <div key={t.TrialIndex}>
            <span className="sw" style={{ background: hex(ALL_COLORS[i % ALL_COLORS.length]) }} />
            trial {t.TrialIndex}
          </div>
        ))}
      </>
    )
  })()

  const datasetLabel = dataset === 'hand' ? 'Participant' : dataset === 'calib' ? 'Calib session' : 'Session'
  const dropHint = dataset === 'hand'
    ? <>or drop <code>*_Hand.csv</code> files anywhere</>
    : dataset === 'calib'
    ? <>or drop <code>RotatingTrace_Calib_*.csv</code> files anywhere</>
    : <>or drop <code>RotatingTrace_*.csv</code> files anywhere</>
  const setActiveKey = dataset === 'hand' ? setHandKey : dataset === 'tracker' ? setTrackerKey : setCalibKey

  const refLabel = dataset === 'calib' ? 'ground-truth curve' : '2D outline at z=0'
  const modesForDataset = dataset === 'hand'
    ? ['single', 'condition', 'all']
    : ['single', 'all', 'movie']

  return (
    <div
      id="layout"
      className={dragOver ? 'dragover' : ''}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <div id="panel">
        <h3>Dataset</h3>
        <div className="modes">
          {[
            ['hand', 'Hand Tracking'],
            ['tracker', 'Rotating Trace'],
            ['calib', 'Calibration'],
          ].map(([k, label]) => (
            <button
              key={k}
              className={dataset === k ? 'active' : ''}
              onClick={() => { setDataset(k); setSingleIdx(0) }}
            >
              {label}
            </button>
          ))}
        </div>

        <h3>Data</h3>
        <label className="filebtn">
          <input
            type="file"
            accept=".csv"
            multiple
            onChange={onPick}
            style={{ display: 'none' }}
          />
          choose files…
        </label>
        <div className="hint-sm">{dropHint}</div>

        <h3>{datasetLabel}</h3>
        <select
          value={activeKey ?? ''}
          onChange={(e) => { setActiveKey(e.target.value || null); setSingleIdx(0) }}
          disabled={!Object.keys(bundles).length}
        >
          {!Object.keys(bundles).length && <option value="">(no data)</option>}
          {Object.keys(bundles).sort().map((p) => (
            <option key={p} value={p}>
              {p} ({bundles[p].length})
            </option>
          ))}
        </select>

        <h3>View</h3>
        <div className="modes">
          {modesForDataset.map((m) => (
            <button
              key={m}
              className={mode === m ? 'active' : ''}
              onClick={() => setMode(m)}
            >
              {m === 'all' ? 'All' : m === 'movie' ? 'Movie' : m[0].toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>

        {(mode === 'single' || mode === 'movie') && (
          <>
            <h3>Trial</h3>
            <div className="row">
              <button onClick={() => setSingleIdx((i) => Math.max(0, i - 1))}>◀</button>
              <input
                type="range"
                min={0}
                max={Math.max(0, trials.length - 1)}
                step={1}
                value={singleIdx}
                onChange={(e) => setSingleIdx(+e.target.value)}
                style={{ flex: 1 }}
                disabled={!trials.length}
              />
              <button onClick={() => setSingleIdx((i) => Math.min(trials.length - 1, i + 1))}>▶</button>
            </div>
          </>
        )}

        {mode === 'movie' && (dataset === 'tracker' || dataset === 'calib') && (
          <>
            <h3>Percept Movie</h3>
            {movieResult && movieResult.frames.length > 0 ? (
              <>
                <div className="row">
                  <button
                    onClick={() => { setMoviePlaying((p) => !p); movieLastTsRef.current = null }}
                    style={{ flex: 1 }}
                  >
                    {moviePlaying ? 'Pause' : 'Play'}
                  </button>
                  <button
                    onClick={() => {
                      setMoviePlaying(false)
                      setMovieFrameIdx(0)
                      movieLastTsRef.current = null
                    }}
                  >
                    Reset
                  </button>
                </div>

                <div className="row">
                  <span className="movie-label">frame</span>
                  <input
                    type="range"
                    min={0}
                    max={Math.max(0, movieResult.frames.length - 1)}
                    step={1}
                    value={((movieFrameIdx % movieResult.frames.length) + movieResult.frames.length) % movieResult.frames.length}
                    onChange={(e) => {
                      setMoviePlaying(false)
                      setMovieFrameIdx(+e.target.value)
                      movieLastTsRef.current = null
                    }}
                    style={{ flex: 1 }}
                  />
                  <span className="movie-label">
                    {((movieFrameIdx % movieResult.frames.length) + movieResult.frames.length) % movieResult.frames.length + 1}
                    /{movieResult.frames.length}
                  </span>
                </div>

                <div className="row">
                  <span className="movie-label">fps</span>
                  <input
                    type="range"
                    min={0.5}
                    max={8}
                    step={0.5}
                    value={movieFps}
                    onChange={(e) => setMovieFps(+e.target.value)}
                    style={{ flex: 1 }}
                  />
                  <span className="movie-label">{movieFps}</span>
                </div>

                {movieResult.warnings.length > 0 && (
                  <div id="movie-warn">
                    <div className="movie-warn-hdr">Derotation notes</div>
                    {movieResult.warnings.map((w, i) => (
                      <div key={i}>{w}</div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div className="hint-sm">No cycles detected in this trial.</div>
            )}
          </>
        )}

        {dataset === 'hand' && mode === 'condition' && (
          <>
            <h3>Condition</h3>
            <div className="cond">
              {(condIds.length ? condIds : [0, 1, 2, 3]).map((c) => (
                <button
                  key={c}
                  className={condIdx === c ? 'active' : ''}
                  onClick={() => setCondIdx(c)}
                  disabled={!byCondition[c]}
                >
                  {c}
                </button>
              ))}
            </div>
          </>
        )}

        {dataset === 'calib' && (
          <>
            <h3>Trial Type</h3>
            <select
              value={calibTypeFilter}
              onChange={(e) => { setCalibTypeFilter(e.target.value); setSingleIdx(0) }}
              disabled={!Object.keys(calibBundles).length}
            >
              <option value="all">all types</option>
              {[...new Set((activeKey && calibBundles[activeKey] ? calibBundles[activeKey] : []).map((t) => t.TrialType))].sort().map((type) => (
                <option key={type} value={type}>{type}</option>
              ))}
            </select>
          </>
        )}

        <h3>Camera</h3>
        <div className="views">
          {[
            ['iso', 'iso'],
            ['front', 'front (xy)'],
            ['top', 'top (xz)'],
            ['side', 'side (yz)'],
          ].map(([k, label]) => (
            <button key={k} onClick={() => viewerRef.current?.setView(k)}>
              {label}
            </button>
          ))}
        </div>

        <h3>Reference</h3>
        <label>
          <input type="checkbox" checked={showRef} onChange={(e) => setShowRef(e.target.checked)} /> {refLabel}
        </label>

        <h3>Scene Config</h3>
        <div className="cfg-grid">
          {[['cx', 'pos X'], ['cy', 'pos Y'], ['cz', 'pos Z']].map(([k, label]) => (
            <div key={k} className="cfg-row">
              <label>{label}</label>
              <input
                type="number"
                step="0.01"
                value={draftConfig[k]}
                onChange={(e) => setDraftConfig((c) => ({ ...c, [k]: +e.target.value }))}
              />
            </div>
          ))}
          <div className="cfg-row">
            <label>trefoil scale</label>
            <input
              type="number"
              step="0.001"
              value={draftConfig.stimScale}
              onChange={(e) => setDraftConfig((c) => ({ ...c, stimScale: +e.target.value }))}
            />
          </div>
          <div className="cfg-row">
            <label>cube scale</label>
            <input
              type="number"
              step="0.01"
              value={draftConfig.cubeScale}
              onChange={(e) => setDraftConfig((c) => ({ ...c, cubeScale: +e.target.value }))}
            />
          </div>
        </div>
        <div className="row">
          <button style={{ flex: 1 }} onClick={() => applyStimConfig(draftConfig)}>Apply</button>
          <button onClick={() => { setDraftConfig(DEFAULT_CONFIG); applyStimConfig(DEFAULT_CONFIG) }}>Reset</button>
        </div>

        <h3>Export</h3>
        <button className="export" onClick={onExport} disabled={!trials.length}>
          download PNG
        </button>

        <div id="info">{info}</div>
        {parseErr && <div id="err">{parseErr}</div>}
      </div>

      <div id="plot" ref={plotRef}>
        <div className="legend">{legend}</div>
        <div className="hint">drag = orbit · right-drag = pan · scroll = zoom</div>
        {hover && (
          <div
            className="tooltip"
            style={{
              left: Math.min(hover.x + 12, (plotRef.current?.clientWidth ?? 0) - 160),
              top: Math.max(hover.y - 12, 4),
            }}
          >
            <div>#{hover.i}</div>
            <div>x: {hover.p.x.toFixed(4)}</div>
            <div>y: {hover.p.y.toFixed(4)}</div>
            <div>z: {hover.p.z.toFixed(4)}</div>
          </div>
        )}
        {!Object.keys(bundles).length && (
          <div className="empty">
            drop one or more{' '}
            {dataset === 'hand' ? <code>*_Hand.csv</code>
              : dataset === 'calib' ? <code>RotatingTrace_Calib_*.csv</code>
              : <code>RotatingTrace_*.csv</code>}{' '}
            files here
          </div>
        )}
      </div>
    </div>
  )
}
