import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { ViewCubeWidget, type ViewCubeRegionId } from './ViewCubeWidget'
import { VIEW_CUBE_DIRECTIONS } from './viewCubeModel'
import {
  createPresentationRig,
  configurePresentationRenderer,
  enhanceGlbMaterialsForPresentation,
  updatePresentationGround,
  type PresentationRig,
} from './viewportPresentation'
import { bounds3FromObject3D, reorientGlbRootForZUp } from './glbOrientation'
import {
  applyCompassHeadingDrag,
  applyOrbitDrag,
  snapCameraToDirectionVector,
  snapCompassCardinal,
  syncCameraAndControls,
  tweenCameraToView,
} from './viewCubeCamera'

/**
 * GlbViewer — a clean, self-contained three.js GLB/BIM model viewer.
 *
 * Promoted from legacy-design-tools' plan-review `BimModelViewport`
 * (lib/portal-ui, previously private/unpublished). The rendering core (WebGL
 * renderer, presentation rig, Z-up camera, OrbitControls, GLTFLoader, camera
 * fit, and the Revit-style ViewCube) is generic three.js and was fully
 * self-contained; only the plan-review coupling (the `@workspace/api-client-react`
 * GLB-URL derivation, the `MaterializableElement` element model, element rings,
 * reviewer-graduation session state, cross-tab announcements) lived in the
 * component and is NOT carried here.
 *
 * This viewer takes a plain `glbUrl` string OR raw GLB bytes (Blob /
 * ArrayBuffer) — NO plan-review data model. v1 = load a GLB + orbit + view-cube.
 * Element picking, annotations, diff, and reviewer state are plan-review
 * features and are intentionally left out.
 */

const DEFAULT_EXPOSURE = 1.15
const ISO_DIRECTION: [number, number, number] = [-1, -1, 1]

export interface GlbViewerProps {
  /**
   * URL the viewer will `fetch()` for GLB bytes. Mutually usable with `glbData`
   * (if both are given, `glbData` wins). The caller owns retrieval / auth: pass
   * a URL only if it resolves to a route you are willing to have the browser
   * hit. (Do NOT point this at an ungated object-storage route — gate retrieval
   * upstream and pass the bytes via `glbData`, or a properly gated URL.)
   */
  glbUrl?: string | null
  /** Raw GLB bytes — an ArrayBuffer or a Blob. Takes precedence over `glbUrl`. */
  glbData?: ArrayBuffer | Blob | null
  /** Optional label rendered in the corner HUD. */
  title?: string | null
  /** Fetch init (headers, etc.) forwarded when loading via `glbUrl`. */
  fetchInit?: RequestInit
  /** Background clear colour (hex int). Defaults to a dark studio slate. */
  backgroundColor?: number
  className?: string
  style?: React.CSSProperties
}

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'loaded' }
  | { status: 'error'; message: string }

async function readGlbBytes(
  source: ArrayBuffer | Blob | string,
  fetchInit: RequestInit | undefined,
  signal: AbortSignal,
): Promise<ArrayBuffer> {
  if (source instanceof ArrayBuffer) return source
  if (typeof source !== 'string') {
    // Blob (or any object with arrayBuffer()) — read its bytes directly.
    return await source.arrayBuffer()
  }
  const res = await fetch(source, { ...fetchInit, signal })
  if (!res.ok) {
    throw new Error(`Failed to load model — HTTP ${res.status} ${res.statusText}`)
  }
  return await res.arrayBuffer()
}

/**
 * Read-only three.js GLB viewer. Self-contained: mounts its own WebGL canvas,
 * a presentation-lit scene, a Z-up perspective camera + OrbitControls, and a
 * Revit-style ViewCube. Loads exactly one GLB (from `glbData` or `glbUrl`),
 * orients it Z-up, frames it, and renders until unmount.
 */
export function GlbViewer({
  glbUrl = null,
  glbData = null,
  title = null,
  fetchInit,
  backgroundColor = 0x141821,
  className,
  style,
}: GlbViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const sceneRef = useRef<THREE.Scene | null>(null)
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null)
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null)
  const controlsRef = useRef<OrbitControls | null>(null)
  const rigRef = useRef<PresentationRig | null>(null)
  const modelRootRef = useRef<THREE.Object3D | null>(null)
  const boundsRef = useRef<ReturnType<typeof bounds3FromObject3D> | null>(null)
  const tweenRef = useRef<{ cancel: () => void } | null>(null)
  const animationFrameRef = useRef<number | null>(null)

  const [webGlOk, setWebGlOk] = useState(true)
  const [load, setLoad] = useState<LoadState>({ status: 'idle' })

  // ---------- Scene / renderer / camera / controls ----------
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    } catch {
      setWebGlOk(false)
      return
    }
    renderer.setPixelRatio(window.devicePixelRatio)
    renderer.setSize(container.clientWidth || 1, container.clientHeight || 1, false)
    configurePresentationRenderer(renderer, DEFAULT_EXPOSURE)
    renderer.setClearColor(backgroundColor, 1)
    const canvas = renderer.domElement
    canvas.style.position = 'absolute'
    canvas.style.inset = '0'
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    canvas.style.display = 'block'
    canvas.style.touchAction = 'none'
    container.appendChild(canvas)
    rendererRef.current = renderer

    const scene = new THREE.Scene()
    sceneRef.current = scene

    let rig: PresentationRig | null = null
    try {
      rig = createPresentationRig(renderer, scene)
    } catch {
      scene.add(new THREE.HemisphereLight(0xe8eeff, 0x3a4248, 0.7))
      scene.add(new THREE.AmbientLight(0xffffff, 0.35))
      const key = new THREE.DirectionalLight(0xffffff, 1)
      key.position.set(140, -180, 260)
      scene.add(key)
    }
    rigRef.current = rig

    // Engineering / CAD convention: Z is "up". OrbitControls reads `camera.up`.
    const camera = new THREE.PerspectiveCamera(
      45,
      (container.clientWidth || 1) / (container.clientHeight || 1),
      0.1,
      5000,
    )
    camera.up.set(0, 0, 1)
    camera.position.set(-80, -80, 80)
    camera.lookAt(0, 0, 0)
    cameraRef.current = camera

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.target.set(0, 0, 0)
    controls.enablePan = true
    controls.enableZoom = true
    controls.screenSpacePanning = true
    controlsRef.current = controls

    let disposed = false
    const animate = () => {
      if (disposed) return
      animationFrameRef.current = requestAnimationFrame(animate)
      controls.update()
      renderer.render(scene, camera)
    }
    animationFrameRef.current = requestAnimationFrame(animate)

    const onResize = () => {
      const w = container.clientWidth || 1
      const h = container.clientHeight || 1
      renderer.setSize(w, h, false)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    }
    const ro =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null
    ro?.observe(container)
    window.addEventListener('resize', onResize)

    return () => {
      disposed = true
      if (animationFrameRef.current != null) {
        cancelAnimationFrame(animationFrameRef.current)
      }
      tweenRef.current?.cancel()
      ro?.disconnect()
      window.removeEventListener('resize', onResize)
      controls.dispose()
      rig?.dispose()
      renderer.dispose()
      canvas.remove()
      sceneRef.current = null
      rendererRef.current = null
      cameraRef.current = null
      controlsRef.current = null
      rigRef.current = null
      modelRootRef.current = null
      boundsRef.current = null
    }
    // Renderer is created once; backgroundColor changes are applied in a
    // separate effect below so we don't tear down the scene on a colour tweak.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Background colour without a full scene rebuild.
  useEffect(() => {
    rendererRef.current?.setClearColor(backgroundColor, 1)
  }, [backgroundColor])

  // ---------- Frame the loaded model ----------
  const frameModel = useCallback((animatedTween: boolean) => {
    const camera = cameraRef.current
    const controls = controlsRef.current
    const bounds = boundsRef.current
    const rig = rigRef.current
    if (!camera || !controls || !bounds) return

    const cx = (bounds.minX + bounds.maxX) / 2
    const cy = (bounds.minY + bounds.maxY) / 2
    const cz = (bounds.minZ + bounds.maxZ) / 2
    const sx = bounds.maxX - bounds.minX
    const sy = bounds.maxY - bounds.minY
    const sz = bounds.maxZ - bounds.minZ
    const span = Math.max(sx, sy, sz, 0.01)
    const distance = span * 1.5

    if (rig?.ground) {
      updatePresentationGround(
        rig.ground,
        new THREE.Vector3(cx, cy, cz),
        span,
        bounds.minZ,
      )
    }

    const target = { x: cx, y: cy, z: cz }
    const { position } = snapCameraToDirectionVector(
      camera,
      controls,
      ISO_DIRECTION,
      distance,
    )
    controls.target.set(cx, cy, cz)

    if (animatedTween) {
      tweenRef.current?.cancel()
      tweenRef.current = tweenCameraToView(camera, controls, position, target)
    } else {
      camera.position.set(position.x, position.y, position.z)
      syncCameraAndControls(camera, controls)
    }
  }, [])

  // ---------- Load the GLB ----------
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene || !webGlOk) return
    const source = glbData ?? glbUrl
    if (!source) {
      setLoad({ status: 'idle' })
      return
    }

    const controller = new AbortController()
    let cancelled = false
    setLoad({ status: 'loading' })

    void (async () => {
      try {
        const buffer = await readGlbBytes(source, fetchInit, controller.signal)
        if (cancelled) return
        const loader = new GLTFLoader()
        await new Promise<void>((resolve, reject) => {
          loader.parse(
            buffer,
            '',
            (gltf) => {
              if (cancelled) {
                resolve()
                return
              }
              // Remove any previously-loaded model.
              const prev = modelRootRef.current
              if (prev) {
                scene.remove(prev)
                prev.traverse((o) => {
                  const mesh = o as THREE.Mesh
                  if (mesh.isMesh) {
                    mesh.geometry?.dispose?.()
                    const mats = Array.isArray(mesh.material)
                      ? mesh.material
                      : [mesh.material]
                    for (const m of mats) (m as THREE.Material)?.dispose?.()
                  }
                })
              }

              const root = new THREE.Group()
              gltf.scene.children.slice().forEach((child) => root.add(child))
              try {
                reorientGlbRootForZUp(root)
                enhanceGlbMaterialsForPresentation(
                  root,
                  rigRef.current?.envMap ?? null,
                )
              } catch {
                /* raw mesh fallback — leave as-is */
              }
              scene.add(root)
              modelRootRef.current = root
              boundsRef.current = bounds3FromObject3D(root)
              frameModel(false)
              setLoad({ status: 'loaded' })
              resolve()
            },
            (err) => reject(err as unknown),
          )
        })
      } catch (err: unknown) {
        if (cancelled || controller.signal.aborted) return
        const message =
          err instanceof Error ? err.message : 'Failed to load 3D model.'
        setLoad({ status: 'error', message })
      }
    })()

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [glbUrl, glbData, fetchInit, webGlOk, frameModel])

  // ---------- ViewCube region snap ----------
  const handleSelectRegion = useCallback((region: ViewCubeRegionId) => {
    const camera = cameraRef.current
    const controls = controlsRef.current
    if (!camera || !controls) return
    const dir = VIEW_CUBE_DIRECTIONS[region]
    if (!dir) return
    const distance = camera.position.distanceTo(controls.target) || 100
    const { position, target } = snapCameraToDirectionVector(
      camera,
      controls,
      dir,
      distance,
    )
    tweenRef.current?.cancel()
    tweenRef.current = tweenCameraToView(camera, controls, position, target)
  }, [])

  const handleOrbitDrag = useCallback((dx: number, dy: number) => {
    const camera = cameraRef.current
    const controls = controlsRef.current
    if (camera && controls) applyOrbitDrag(camera, controls, dx, dy)
  }, [])

  const handleCompassHeadingDrag = useCallback((deltaRadians: number) => {
    const camera = cameraRef.current
    const controls = controlsRef.current
    if (camera && controls) applyCompassHeadingDrag(camera, controls, deltaRadians)
  }, [])

  const handleCompassSnap = useCallback((cardinal: 'n' | 'e' | 's' | 'w') => {
    const camera = cameraRef.current
    const controls = controlsRef.current
    if (camera && controls) snapCompassCardinal(camera, controls, cardinal)
  }, [])

  const handleHome = useCallback(() => frameModel(true), [frameModel])

  const containerStyle: React.CSSProperties = useMemo(
    () => ({
      position: 'relative',
      width: '100%',
      height: '100%',
      minHeight: 0,
      overflow: 'hidden',
      ...style,
    }),
    [style],
  )

  return (
    <div
      className={['glb-viewer', className].filter(Boolean).join(' ')}
      data-testid="glb-viewer"
      style={containerStyle}
    >
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />

      {!webGlOk ? (
        <div style={hudMsgStyle} role="alert">
          WebGL is unavailable in this browser — cannot render the 3D model.
        </div>
      ) : load.status === 'loading' ? (
        <div style={hudMsgStyle}>Loading 3D model…</div>
      ) : load.status === 'error' ? (
        <div style={hudMsgStyle} role="alert">
          {load.message}
        </div>
      ) : load.status === 'idle' ? (
        <div style={hudMsgStyle}>No model to display.</div>
      ) : null}

      {title ? (
        <div style={titleStyle} data-testid="glb-viewer-title">
          {title}
        </div>
      ) : null}

      {webGlOk ? (
        <div style={viewCubeSlotStyle}>
          <ViewCubeWidget
            mainCamera={cameraRef}
            orbitControls={controlsRef}
            onSelectRegion={handleSelectRegion}
            onOrbitDrag={handleOrbitDrag}
            onCompassHeadingDrag={handleCompassHeadingDrag}
            onCompassSnap={handleCompassSnap}
            onHome={handleHome}
          />
        </div>
      ) : null}
    </div>
  )
}

const hudMsgStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: 'rgba(255,255,255,0.82)',
  fontSize: 13,
  fontFamily: 'system-ui, sans-serif',
  textAlign: 'center',
  padding: 16,
  pointerEvents: 'none',
}

const titleStyle: React.CSSProperties = {
  position: 'absolute',
  top: 8,
  left: 10,
  color: 'rgba(255,255,255,0.92)',
  fontSize: 12,
  fontWeight: 600,
  fontFamily: 'system-ui, sans-serif',
  textShadow: '0 1px 2px rgba(0,0,0,0.6)',
  pointerEvents: 'none',
}

const viewCubeSlotStyle: React.CSSProperties = {
  position: 'absolute',
  top: 8,
  right: 8,
  zIndex: 2,
}
