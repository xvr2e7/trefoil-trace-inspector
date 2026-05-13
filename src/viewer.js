import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

export const REP_COLORS = [0xff6b9d, 0xffb86b, 0xc5e478, 0x6be4ff, 0xb48cff]
export const ALL_COLORS = [
  0xff6b9d, 0xff8aa0, 0xffb86b, 0xffd07a, 0xc5e478, 0xa0e08a, 0x6be4ff, 0x7ac7ff,
  0xb48cff, 0xd48aff, 0xff87d1, 0xff9970, 0xe0cd66, 0x9ed86a, 0x66d9c4, 0x6bafff,
  0x9f7dff, 0xe07aff, 0xff6e88, 0xffa14d,
]

// Plain class wrapping the Three.js scene. React owns the DOM container and
// state; this owns the renderer, camera, and the two object groups we
// repeatedly clear and refill.
export class Viewer {
  constructor(container) {
    this.container = container
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
    this.renderer.setPixelRatio(window.devicePixelRatio)
    container.appendChild(this.renderer.domElement)

    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x0b0d12)

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.target.set(0, 0, 0)

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.9))
    const dl = new THREE.DirectionalLight(0xffffff, 0.4)
    dl.position.set(2, 3, 2)
    this.scene.add(dl)

    const grid = new THREE.GridHelper(8, 16, 0x2a2f3a, 0x1a1e27)
    grid.rotation.x = Math.PI / 2
    this.scene.add(grid)
    this.scene.add(new THREE.AxesHelper(1.5))

    this.refGroup = new THREE.Group()
    this.traceGroup = new THREE.Group()
    this.scene.add(this.refGroup, this.traceGroup)

    this._raycaster = new THREE.Raycaster()
    this._raycaster.params.Points.threshold = 0.05
    this._pointer = new THREE.Vector2()
    this._hoverCb = null
    this._onPointerMove = (e) => {
      if (!this._hoverCb) return
      const r = this.renderer.domElement.getBoundingClientRect()
      const x = e.clientX - r.left
      const y = e.clientY - r.top
      this._pointer.x = (x / r.width) * 2 - 1
      this._pointer.y = -(y / r.height) * 2 + 1
      this._raycaster.setFromCamera(this._pointer, this.camera)
      const targets = []
      this.traceGroup.traverse((o) => { if (o.isPoints) targets.push(o) })
      const hits = this._raycaster.intersectObjects(targets, false)
      if (hits.length) {
        const h = hits[0]
        const pts = h.object.userData.points
        const p = pts?.[h.index]
        if (p) {
          this._hoverCb({ point: p, index: h.index, clientX: e.clientX, clientY: e.clientY })
          return
        }
      }
      this._hoverCb(null)
    }
    this._onPointerLeave = () => { this._hoverCb?.(null) }
    this.renderer.domElement.addEventListener('pointermove', this._onPointerMove)
    this.renderer.domElement.addEventListener('pointerleave', this._onPointerLeave)

    this.setView('iso')
    this._onResize = () => this.resize()
    window.addEventListener('resize', this._onResize)
    this.resize()

    this._raf = 0
    const loop = () => {
      this._raf = requestAnimationFrame(loop)
      this.controls.update()
      this.renderer.render(this.scene, this.camera)
    }
    loop()
  }

  dispose() {
    cancelAnimationFrame(this._raf)
    window.removeEventListener('resize', this._onResize)
    this.renderer.domElement.removeEventListener('pointermove', this._onPointerMove)
    this.renderer.domElement.removeEventListener('pointerleave', this._onPointerLeave)
    this.clearGroup(this.refGroup)
    this.clearGroup(this.traceGroup)
    this.controls.dispose()
    this.renderer.dispose()
    if (this.renderer.domElement.parentNode === this.container) {
      this.container.removeChild(this.renderer.domElement)
    }
  }

  setHoverCallback(cb) {
    this._hoverCb = cb
  }

  resize() {
    const r = this.container.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return
    this.renderer.setSize(r.width, r.height)
    this.camera.aspect = r.width / r.height
    this.camera.updateProjectionMatrix()
  }

  setView(kind) {
    const d = 10
    if (kind === 'front') this.camera.position.set(0, 0, d)
    else if (kind === 'top') this.camera.position.set(0, d, 0.0001)
    else if (kind === 'side') this.camera.position.set(d, 0, 0)
    else this.camera.position.set(d * 0.7, d * 0.55, d * 0.7)
    this.controls.target.set(0, 0, 0)
    this.controls.update()
  }

  clearGroup(g) {
    while (g.children.length) {
      const c = g.children.pop()
      c.geometry?.dispose()
      if (c.material) {
        if (Array.isArray(c.material)) c.material.forEach((m) => m.dispose())
        else c.material.dispose()
      }
    }
  }

  clearAll() {
    this.clearGroup(this.refGroup)
    this.clearGroup(this.traceGroup)
  }

  addReference(refPts) {
    const g = new THREE.BufferGeometry()
    const arr = new Float32Array(refPts.length * 3)
    for (let i = 0; i < refPts.length; i++) {
      arr[3 * i] = refPts[i].x
      arr[3 * i + 1] = refPts[i].y
      arr[3 * i + 2] = 0
    }
    g.setAttribute('position', new THREE.BufferAttribute(arr, 3))
    const mat = new THREE.LineBasicMaterial({
      color: 0xa0b4dc,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
    })
    this.refGroup.add(new THREE.Line(g, mat))
  }

  addTrace(points, colorHex, opts = {}) {
    const g = new THREE.BufferGeometry()
    const arr = new Float32Array(points.length * 3)
    for (let i = 0; i < points.length; i++) {
      arr[3 * i] = points[i].x
      arr[3 * i + 1] = points[i].y
      arr[3 * i + 2] = points[i].z
    }
    g.setAttribute('position', new THREE.BufferAttribute(arr, 3))
    const lineMat = new THREE.LineBasicMaterial({
      color: colorHex,
      transparent: true,
      opacity: opts.alpha ?? 1.0,
      depthWrite: false,
    })
    const grp = new THREE.Group()
    grp.add(new THREE.Line(g, lineMat))
    if (opts.showDots) {
      const pm = new THREE.PointsMaterial({
        color: colorHex,
        size: opts.dotSize ?? 0.06,
        transparent: true,
        opacity: opts.alpha ?? 1.0,
        sizeAttenuation: true,
      })
      const pts = new THREE.Points(g, pm)
      pts.userData.points = points
      grp.add(pts)
    }
    this.traceGroup.add(grp)
  }

  // Render-on-demand snapshot. preserveDrawingBuffer is on so toDataURL works
  // even though we're running an animation loop.
  snapshot() {
    this.renderer.render(this.scene, this.camera)
    return this.renderer.domElement.toDataURL('image/png')
  }
}
