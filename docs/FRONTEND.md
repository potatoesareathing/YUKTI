# YUKTI frontend — API wiring & graph view

## API boundary

All UI data goes through `src/data/api.ts`.

- **Async:** `loadPlatformData()` → `GET {VITE_API_BASE_URL}/api/bootstrap` hydrates module caches.
- **Sync accessors:** `getNetwork()`, `getDistrictFlows()`, `stateTotals()`, etc. read those caches. Calling them before hydration returns empty arrays/objects.

Set the API base (no trailing slash) in `.env` / Slate build env:

```
VITE_API_BASE_URL=https://yukti-api-50044348137.development.catalystappsail.in
```

Local default if unset: `http://127.0.0.1:8000`. See `.env.example`.

## Bootstrap hydration

`Landing` and `Platform` call `loadPlatformData()` on mount and bump a `dataEpoch` counter when it resolves. The 3D `<Scene>` is keyed on `dataEpoch` and only mounts after epoch &gt; 0 so force-graph / constellation never snapshot an empty `networkCache`.

`useGeo()` also awaits bootstrap (via `getIncidents()`), so district boundaries and platform data stay in step.

## Network graph visualization (MOD-02)

`src/three/GraphView.tsx` runs a live `d3-force-3d` layout in Three.js.

AppSail bootstrap ships ~6–7k nodes. Warming force simulation over the full graph blocked the main thread so the WebGL canvas never painted (nodes/lines “missing”). The view now:

1. Draws a **high-centrality core** (soft cap ~420 nodes), always expanding to include the current selection / path endpoints and their neighbours.
2. Scales warmup ticks with subgraph size.
3. Remounts when `revision` / `dataEpoch` changes after bootstrap.

Side panels and path finding still use the **full** cached graph via `getNetwork()` / `shortestPath()`.

Landing Act III `Constellation` re-reads flows/hubs on the same revision. Cross-district ribbons need `flows.flows` from the API; hubs render from `flows.hubs` even when there are no cross-district corridors.

## Live URLs

| Surface | URL |
|---------|-----|
| Slate UI | https://yukti-exuqctrg.onslate.in |
| AppSail API | https://yukti-api-50044348137.development.catalystappsail.in |

Deployment steps: [CATALYST-DEPLOY.md](./CATALYST-DEPLOY.md).
