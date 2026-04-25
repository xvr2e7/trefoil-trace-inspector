import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { parseHandCsv, worldToLocal3D, loadReference, participantFromFilename } from './csv.js'
import { Viewer, REP_COLORS, ALL_COLORS } from './viewer.js'

const BASE_URL = import.meta.env.BASE_URL

function hex(c) {
  return '#' + c.toString(16).padStart(6, '0')
}

export default function App() {
  const plotRef = useRef(null)
  const viewerRef = useRef(null)

  // Map of participant id → trial array (with .local3D precomputed).
  const [bundles, setBundles] = useState({})
  const [participant, setParticipant] = useState(null)
  const [mode, setMode] = useState('single')
  const [singleIdx, setSingleIdx] = useState(0)
  const [condIdx, setCondIdx] = useState(0)
  const [showRef, setShowRef] = useState(true)
  const [dragOver, setDragOver] = useState(false)
  const [parseErr, setParseErr] = useState(null)
  const [hover, setHover] = useState(null)

  const trials = participant ? bundles[participant] ?? [] : []
  const byCondition = useMemo(() => {
    const m = {}
    for (const t of trials) (m[t.ConfigurationId] ??= []).push(t)
    for (const k of Object.keys(m)) m[k].sort((a, b) => a.RepetitionNumber - b.RepetitionNumber)
    return m
  }, [trials])
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
        v.addTrace(t.local3D, REP_COLORS[t.RepetitionNumber] ?? ALL_COLORS[0], {
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
  }, [trials, byCondition, mode, singleIdx, condIdx, showRef])

  // Resize plot when the layout might have changed (e.g. participant added).
  useEffect(() => {
    viewerRef.current?.resize()
  }, [bundles, participant])

  const ingestFiles = useCallback(async (files) => {
    setParseErr(null)
    const csvFiles = [...files].filter((f) => /\.csv$/i.test(f.name))
    if (!csvFiles.length) {
      setParseErr('No .csv files in drop')
      return
    }
    const next = { ...bundles }
    let firstNew = null
    const errors = []
    for (const f of csvFiles) {
      try {
        const text = await f.text()
        const rows = parseHandCsv(text)
        if (!rows.length) {
          errors.push(`${f.name}: 0 rows parsed`)
          continue
        }
        for (const t of rows) {
          t.local3D = worldToLocal3D(t.world, t.FreezeAngle, t.Handedness)
        }
        const id = participantFromFilename(f.name)
        next[id] = rows
        firstNew ??= id
      } catch (e) {
        errors.push(`${f.name}: ${e.message ?? e}`)
      }
    }
    setBundles(next)
    if (firstNew) {
      setParticipant(firstNew)
      setSingleIdx(0)
    }
    if (errors.length) setParseErr(errors.join('\n'))
  }, [bundles])

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
    let name = participant ?? 'view'
    if (mode === 'single') name += `_trial${trials[singleIdx]?.TrialNumber ?? singleIdx}`
    else if (mode === 'condition') name += `_cond${condIdx}`
    else name += '_all'
    a.download = `${name}.png`
    a.href = url
    a.click()
  }, [participant, mode, singleIdx, condIdx, trials])

  // Info panel content (depends on mode).
  const info = (() => {
    if (!trials.length) return ''
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
  })()

  // Legend rows.
  const legend = (() => {
    if (!trials.length) return null
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
  })()

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
        <div className="hint-sm">or drop *_Hand.csv files anywhere</div>

        <h3>Participant</h3>
        <select
          value={participant ?? ''}
          onChange={(e) => {
            setParticipant(e.target.value || null)
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
          {['single', 'condition', 'all'].map((m) => (
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

        {mode === 'condition' && (
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
            drop one or more <code>*_Hand.csv</code> files here
          </div>
        )}
      </div>
    </div>
  )
}
