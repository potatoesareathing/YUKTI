import { Suspense, type ReactNode } from 'react'
import { Canvas } from '@react-three/fiber'
import { Color, FogExp2 } from 'three'
import { PALETTE } from '@/lib/palette'

/**
 * The lighting rig, held in one place so every scene is lit identically.
 *
 * Three sources, each doing a specific job:
 *   key    — warm brass from upper left, the instrument's working light
 *   fill   — cool Bhuvan blue from the opposite side, so shadowed faces of the
 *            extrusions stay readable instead of going flat black
 *   rim    — low and behind, separating district silhouettes from the plate
 *
 * Exponential fog in ink pulls the far edge of the plate into the background,
 * which is what stops the map reading as a rectangle floating in a void.
 */
export function Rig() {
  return (
    <>
      <ambientLight intensity={0.56} color={PALETTE.khaki} />
      <directionalLight
        position={[-46, 62, 38]}
        intensity={1.95}
        color={PALETTE.brassLit}
        castShadow
        shadow-mapSize={[1024, 1024]}
        shadow-camera-far={220}
        shadow-camera-left={-80}
        shadow-camera-right={80}
        shadow-camera-top={80}
        shadow-camera-bottom={-80}
      />
      <directionalLight position={[54, 34, -30]} intensity={0.78} color={PALETTE.bhuvan} />
      <directionalLight position={[0, 8, -74]} intensity={0.5} color={PALETTE.brass} />
      <hemisphereLight args={[PALETTE.bhuvanDim, PALETTE.ink, 0.32]} />
    </>
  )
}

interface SceneProps {
  children: ReactNode
  className?: string
  /** Disable pointer events when the canvas is purely a backdrop. */
  interactive?: boolean
  dpr?: [number, number]
}

export function Scene({ children, className, interactive = true, dpr = [1, 1.8] }: SceneProps) {
  return (
    <Canvas
      className={className}
      dpr={dpr}
      shadows
      gl={{ antialias: true, powerPreference: 'high-performance', alpha: false }}
      camera={{ fov: 38, near: 0.5, far: 700, position: [-10, 158, 156] }}
      style={{ pointerEvents: interactive ? 'auto' : 'none' }}
      onCreated={({ scene, gl }) => {
        scene.background = new Color(PALETTE.ink)
        scene.fog = new FogExp2(PALETTE.ink, 0.0034)
        gl.setClearColor(PALETTE.ink, 1)
      }}
    >
      <Suspense fallback={null}>{children}</Suspense>
    </Canvas>
  )
}
