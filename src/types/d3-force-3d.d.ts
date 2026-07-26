declare module 'd3-force-3d' {
  export interface SimNode {
    id: string
    x?: number
    y?: number
    z?: number
    vx?: number
    vy?: number
    vz?: number
    fx?: number | null
    fy?: number | null
    fz?: number | null
  }

  export interface SimLink {
    source: string | SimNode
    target: string | SimNode
  }

  export interface Force {
    (alpha?: number): void
    initialize?: (nodes: SimNode[]) => void
  }

  export interface LinkForce extends Force {
    id(fn: (n: SimNode) => string): LinkForce
    distance(fn: number | ((l: SimLink, i: number) => number)): LinkForce
    strength(fn: number | ((l: SimLink, i: number) => number)): LinkForce
    links(links: SimLink[]): LinkForce
  }

  export interface ManyBodyForce extends Force {
    strength(fn: number | ((n: SimNode, i: number) => number)): ManyBodyForce
    distanceMax(d: number): ManyBodyForce
    theta(t: number): ManyBodyForce
  }

  export interface CenterForce extends Force {
    strength(s: number): CenterForce
  }

  export interface RadialForce extends Force {
    strength(fn: number | ((n: SimNode, i: number) => number)): RadialForce
  }

  export interface Simulation {
    nodes(nodes: SimNode[]): Simulation
    nodes(): SimNode[]
    force(name: string, force: Force | null): Simulation
    alpha(a: number): Simulation
    alphaDecay(a: number): Simulation
    alphaMin(a: number): Simulation
    velocityDecay(a: number): Simulation
    tick(n?: number): Simulation
    stop(): Simulation
    restart(): Simulation
  }

  export function forceSimulation(nodes?: SimNode[], numDimensions?: number): Simulation
  export function forceLink(links?: SimLink[]): LinkForce
  export function forceManyBody(): ManyBodyForce
  export function forceCenter(x?: number, y?: number, z?: number): CenterForce
  export function forceRadial(radius: number, x?: number, y?: number, z?: number): RadialForce
}
