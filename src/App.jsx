import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import {
  parseHandCsv, handLocal3D, participantFromFilename,
  parseTrackerCsv, trackerLocal3D, sessionFromFilename,
  loadReference,
} from './csv.js'
import { Viewer, REP_COLORS, ALL_COLORS } from './viewer.js'

const BASE_URL = import.meta.env.BASE_URL
const MIN_TRACKER_POINTS = 10

function hex(c) {
  return '#' + c.toString(16).padStart(6, '0')
}

// Classify a dropped filename. Falls back to 'hand' (the historical default).
function datasetFromFilename(name) {
  if (/^RotatingTrace_/i.test(name)) return 'tracker'
  if (/_Hand\.csv$/i.test(name)) return 'hand'
  return null
}

export default function App() {
  const plotRef = useRef(null)
  const viewerRef = useRef(null)

  const [dataset, setDataset] = useState('hand') // 'hand' | 'tracker'

  // Per-dataset bundles + active key, kept separate so switching the toggle
  // doesn't lose either side's loaded data.
  const [handBundles, setHandBundles] = useState({})
  const [trackerBundles, setTrackerBundles] = useState({})
  const [handKey, setHandKey] = useState(null)
  const [trackerKey, setTrackerKey] = useState(null)

  const [mode, setMode] = useState('single') // 'single' | 'condition' (hand only) | 'all'
  const [singleIdx, setSingleIdx] = useState(0)
  const [condIdx, setCondIdx] = useState(0)
  const [showRef, setShowRef] = useState(true)
  const [dragOver, setDragOver] = useState(false)
  const [parseErr, setParseErr] = useState(null)
  const [hover, setHover] = useState(null)

  const bundles = dataset === 'hand' ? handBundles : trackerBundles
  const activeKey = dataset === 'hand' ? handKey : trackerKey
  const trials = activeKey ? bundles[activeKey] ?? [] : []

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
  }, [dataset, mode])

  // Re-render scene whenever the chosen view changes.
  useEffect(() => {
    const v = viewerRef.current
    if (!v) return
    let cancelled = false
    ;(async () => {
      v.clearAll()
      if (!trials.length) return

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
    return () => {
      cancelled = true
    }
  }, [trials, byCondition, mode, singleIdx, condIdx, showRef, dataset])

  // Resize plot when the layout might have changed.
  useEffect(() => {
    viewerRef.current?.resize()
  }, [handBundles, trackerBundles, dataset, handKey, trackerKey])

  const ingestFiles = useCallback(async (files) => {
    setParseErr(null)
    const csvFiles = [...files].filter((f) => /\.csv$/i.test(f.name))
    if (!csvFiles.length) {
      setParseErr('No .csv files in drop')
      return
    }
    const nextHand = { ...handBundles }
    const nextTracker = { ...trackerBundles }
    let firstNewHand = null
    let firstNewTracker = null
    const errors = []
    for (const f of csvFiles) {
      const kind = datasetFromFilename(f.name) ?? dataset
      try {
        const text = await f.text()
        if (kind === 'tracker') {
          const rows = parseTrackerCsv(text).filter((t) => t.world.length >= MIN_TRACKER_POINTS)
          if (!rows.length) {
            errors.push(`${f.name}: 0 trials with ≥${MIN_TRACKER_POINTS} points`)
            continue
          }
          for (const t of rows) t.local3D = trackerLocal3D(t.world, t.angles)
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
    if (firstNewTracker) {
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
  }, [handBundles, trackerBundles, dataset, mode])

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
      const trialId = dataset === 'hand' ? t?.TrialNumber : t?.TrialIndex
      name += `_trial${trialId ?? singleIdx}`
    } else if (mode === 'condition') name += `_cond${condIdx}`
    else name += '_all'
    a.download = `${name}.png`
    a.href = url
    a.click()
  }, [activeKey, mode, singleIdx, condIdx, trials, dataset])

  // Info panel content.
  const info = (() => {
    if (!trials.length) return ''
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
    // tracker
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

  const datasetLabel = dataset === 'hand' ? 'Participant' : 'Session'
  const dropHint =
    dataset === 'hand'
      ? <>or drop <code>*_Hand.csv</code> files anywhere</>
      : <>or drop <code>RotatingTrace_*.csv</code> files anywhere</>
  const setActiveKey = dataset === 'hand' ? setHandKey : setTrackerKey

  return (
    <div
      id="layout"
      className={dragOver ? 'dragover' : ''}
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <div id="panel">
        <h3>Dataset</h3>
        <div className="modes">
          {[
            ['hand', 'Hand Tracking'],
            ['tracker', 'Rotating Trace'],
          ].map(([k, label]) => (
            <button
              key={k}
              className={dataset === k ? 'active' : ''}
              onClick={() => {
                setDataset(k)
                setSingleIdx(0)
              }}
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
          onChange={(e) => {
            setActiveKey(e.target.value || null)
            setSingleIdx(0)
          }}
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
          {(dataset === 'hand' ? ['single', 'condition', 'all'] : ['single', 'all']).map((m) => (
            <button
              key={m}
              className={mode === m ? 'active' : ''}
              onClick={() => setMode(m)}
            >
              {m === 'all' ? 'All' : m[0].toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>

        {mode === 'single' && (
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
          <input type="checkbox" checked={showRef} onChange={(e) => setShowRef(e.target.checked)} /> 2D outline at z=0
        </label>

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
            drop one or more {dataset === 'hand'
              ? <code>*_Hand.csv</code>
              : <code>RotatingTrace_*.csv</code>} files here
          </div>
        )}
      </div>
    </div>
  )
}
