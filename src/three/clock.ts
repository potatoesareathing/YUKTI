/**
 * Per-frame animation state, deliberately kept OUT of React.
 *
 * The sweep and the reveal update sixty times a second. Routing them through
 * component state — or through the Zustand store — would re-render the tree on
 * every frame to move a number that only the render loop reads. So they live
 * here as plain mutable fields: written by whichever scene owns the timeline,
 * read inside `useFrame` by the meshes that respond to them.
 *
 * Rule: nothing in this object may be read during render. If a value needs to
 * appear in the DOM, it belongs in the store instead, updated at a human rate.
 */
export const sceneClock = {
  /** 0..1 position of the west→east sweep line. */
  sweep: 0,
  /** 0..1 extrusion reveal. 1 is fully grown. */
  growth: 1,
  /** Seconds since the current scene mounted. */
  elapsed: 0,
}

export function resetSceneClock(growth = 0): void {
  sceneClock.sweep = 0
  sceneClock.growth = growth
  sceneClock.elapsed = 0
}
