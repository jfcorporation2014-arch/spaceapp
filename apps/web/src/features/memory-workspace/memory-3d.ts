import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
export type MemoryPoint3D = { x: number; y: number; z: number };
export type MemoryCamera3D = { yaw: number; pitch: number; zoom: number };
export const DEFAULT_MEMORY_CAMERA: MemoryCamera3D = { yaw: 0.3, pitch: -0.15, zoom: 1 };

// Avalanche each seed so the three axes are independent even for similar file IDs.
const unit = (seed: string) => {
  let hash = 2166136261;
  for (const character of seed) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  hash = Math.imul(hash ^ (hash >>> 16), 0x7feb352d);
  hash = Math.imul(hash ^ (hash >>> 15), 0x846ca68b);
  return ((hash ^ (hash >>> 16)) >>> 0) / 4294967295;
};

/** Independent XYZ force layout. No coordinates are inherited from the 2D map. */
export function createMemoryNetwork3DStepper(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[]) {
  const ordered = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  const index = new Map(ordered.map((node, i) => [node.id, i]));
  const root = ordered.findIndex(node => node.type === "SOURCE" && isMemoryCoreLabel(node.label));
  const count = ordered.length;
  const points = ordered.map(node => ({
    x: (unit(`${node.id}:x`) - 0.5) * 260,
    y: (unit(`${node.id}:y`) - 0.5) * 260,
    z: (unit(`${node.id}:z`) - 0.5) * 260
  }));
  if (root >= 0) points[root] = { x: 0, y: 0, z: 0 };
  const links = [...edges].sort((a, b) => a.id.localeCompare(b.id)).flatMap(edge => {
    const a = index.get(edge.source), b = index.get(edge.target);
    if (a === undefined || b === undefined || a === b) return [];
    const fileLink = ordered[a]!.type === "SOURCE" && ordered[b]!.type === "SOURCE";
    return [{ a, b, length: fileLink ? 110 : edge.type === "CONTAINS" ? 34 : 55,
      strength: fileLink ? 0.035 : edge.type === "CONTAINS" ? 0.028 : 0.004 }];
  });
  // Initialize records around their actual file, in a volume rather than a plane.
  for (const edge of edges) {
    const a = index.get(edge.source), b = index.get(edge.target);
    if (edge.type !== "CONTAINS" || a === undefined || b === undefined || ordered[a]!.type !== "SOURCE" || ordered[b]!.type !== "MEMORY") continue;
    const parent = points[a]!, id = ordered[b]!.id;
    points[b] = { x: parent.x + (unit(`${id}:dx`) - 0.5) * 70,
      y: parent.y + (unit(`${id}:dy`) - 0.5) * 70, z: parent.z + (unit(`${id}:dz`) - 0.5) * 70 };
  }
  const fx = new Float64Array(count), fy = new Float64Array(count), fz = new Float64Array(count);
  let step = 0;
  const advance = (iterations: number): boolean => {
  const end = Math.min(180, step + iterations);
  // Bounded spatial-grid repulsion and link springs act equally on all three axes.
  for (; step < end; step++) {
    fx.fill(0); fy.fill(0); fz.fill(0);
    if (count > 3000) {
      // Large, dense graphs use each cell's center of mass. Pairwise repulsion
      // would otherwise become quadratic when thousands share one cell.
      type Cell = { sourceCount: number; memoryCount: number; sx: number; sy: number; sz: number; mx: number; my: number; mz: number };
      const grid = new Map<number, Cell>();
      const key = (x: number, y: number, z: number) => (x + 1024) * 4194304 + (y + 1024) * 2048 + z + 1024;
      for (let i = 0; i < count; i++) {
        const p = points[i]!, cellKey = key(Math.floor(p.x / 32), Math.floor(p.y / 32), Math.floor(p.z / 32));
        let cell = grid.get(cellKey);
        if (!cell) { cell = { sourceCount: 0, memoryCount: 0, sx: 0, sy: 0, sz: 0, mx: 0, my: 0, mz: 0 }; grid.set(cellKey, cell); }
        if (ordered[i]!.type === "SOURCE") { cell.sourceCount++; cell.sx += p.x; cell.sy += p.y; cell.sz += p.z; }
        else { cell.memoryCount++; cell.mx += p.x; cell.my += p.y; cell.mz += p.z; }
      }
      for (let i = 0; i < count; i++) {
        const p = points[i]!, source = ordered[i]!.type === "SOURCE";
        const gx = Math.floor(p.x / 32), gy = Math.floor(p.y / 32), gz = Math.floor(p.z / 32);
        for (let x = gx - 1; x <= gx + 1; x++) for (let y = gy - 1; y <= gy + 1; y++) for (let z = gz - 1; z <= gz + 1; z++) {
          const cell = grid.get(key(x, y, z));
          if (!cell) continue;
          const selfCell = x === gx && y === gy && z === gz;
          const sources = cell.sourceCount - (selfCell && source ? 1 : 0);
          if (sources > 0) {
            const dx = p.x - (cell.sx - (selfCell && source ? p.x : 0)) / sources;
            const dy = p.y - (cell.sy - (selfCell && source ? p.y : 0)) / sources;
            const dz = p.z - (cell.sz - (selfCell && source ? p.z : 0)) / sources;
            const strength = 28 * sources / Math.max(1, dx * dx + dy * dy + dz * dz);
            fx[i]! += dx * strength; fy[i]! += dy * strength; fz[i]! += dz * strength;
          }
          const memories = cell.memoryCount - (selfCell && !source ? 1 : 0);
          if (memories > 0) {
            const dx = p.x - (cell.mx - (selfCell && !source ? p.x : 0)) / memories;
            const dy = p.y - (cell.my - (selfCell && !source ? p.y : 0)) / memories;
            const dz = p.z - (cell.mz - (selfCell && !source ? p.z : 0)) / memories;
            const strength = (source ? 28 : 12) * memories / Math.max(1, dx * dx + dy * dy + dz * dz);
            fx[i]! += dx * strength; fy[i]! += dy * strength; fz[i]! += dz * strength;
          }
        }
      }
    } else {
      const grid = new Map<string, number[]>();
      for (let i = 0; i < count; i++) {
        const p = points[i]!, key = `${Math.floor(p.x / 32)},${Math.floor(p.y / 32)},${Math.floor(p.z / 32)}`;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key)!.push(i);
      }
      for (let i = 0; i < count; i++) {
        const p = points[i]!, gx = Math.floor(p.x / 32), gy = Math.floor(p.y / 32), gz = Math.floor(p.z / 32);
        for (let x = gx - 1; x <= gx + 1; x++) for (let y = gy - 1; y <= gy + 1; y++) for (let z = gz - 1; z <= gz + 1; z++) {
          for (const j of grid.get(`${x},${y},${z}`) ?? []) {
            if (j <= i) continue;
            const q = points[j]!, dx = p.x - q.x, dy = p.y - q.y, dz = p.z - q.z;
            const distanceSquared = Math.max(1, dx * dx + dy * dy + dz * dz);
            const strength = (ordered[i]!.type === "SOURCE" || ordered[j]!.type === "SOURCE" ? 28 : 12) / distanceSquared;
            fx[i]! += dx * strength; fy[i]! += dy * strength; fz[i]! += dz * strength;
            fx[j]! -= dx * strength; fy[j]! -= dy * strength; fz[j]! -= dz * strength;
          }
        }
      }
    }
    for (const link of links) {
      const a = points[link.a]!, b = points[link.b]!;
      const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, distance = Math.max(0.01, Math.hypot(dx, dy, dz));
      const spring = (distance - link.length) * link.strength / distance;
      fx[link.a]! += dx * spring; fy[link.a]! += dy * spring; fz[link.a]! += dz * spring;
      fx[link.b]! -= dx * spring; fy[link.b]! -= dy * spring; fz[link.b]! -= dz * spring;
    }
    const cooling = 1 - step / 230;
    for (let i = 0; i < count; i++) {
      if (i === root) continue;
      const p = points[i]!;
      const dx = fx[i]! - p.x * 0.0005, dy = fy[i]! - p.y * 0.0005, dz = fz[i]! - p.z * 0.0005;
      const stepScale = Math.min(1, 4 / Math.max(0.01, Math.hypot(dx, dy, dz))) * cooling;
      p.x += dx * stepScale; p.y += dy * stepScale; p.z += dz * stepScale;
    }
  }
  return step === 180;
  };
  const snapshot = () => new Map(ordered.map((node, i) => [node.id, { ...points[i]! }]));
  const packed = () => {
    const result = new Float32Array(count * 3);
    points.forEach((point, i) => result.set([point.x, point.y, point.z], i * 3));
    return result;
  };
  return { advance, snapshot, packed };
}

export function layoutMemoryNetwork3D(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[]): Map<string, MemoryPoint3D> {
  const stepper = createMemoryNetwork3DStepper(nodes, edges);
  stepper.advance(180);
  return stepper.snapshot();
}

export function projectMemoryPoint(point: MemoryPoint3D, camera: MemoryCamera3D, scale: number, width: number, height: number) {
  const x = point.x * Math.cos(camera.yaw) + point.z * Math.sin(camera.yaw);
  const depth = -point.x * Math.sin(camera.yaw) + point.z * Math.cos(camera.yaw);
  const y = point.y * Math.cos(camera.pitch) - depth * Math.sin(camera.pitch);
  const z = point.y * Math.sin(camera.pitch) + depth * Math.cos(camera.pitch);
  const perspective = 650 / Math.max(120, 650 + z * scale);
  return { x: width / 2 + x * scale * camera.zoom * perspective, y: height / 2 - y * scale * camera.zoom * perspective, z, perspective };
}

/** Normalized covariance determinant: 0 for a plane, 1 for equal spread in XYZ. */
export function memory3DVolumeRatio(points: MemoryPoint3D[]): number {
  if (points.length < 4) return 0;
  const center = points.reduce((sum, p) => ({ x: sum.x + p.x / points.length, y: sum.y + p.y / points.length, z: sum.z + p.z / points.length }), { x: 0, y: 0, z: 0 });
  let xx = 0, yy = 0, zz = 0, xy = 0, xz = 0, yz = 0;
  for (const p of points) {
    const x = p.x - center.x, y = p.y - center.y, z = p.z - center.z;
    xx += x * x; yy += y * y; zz += z * z; xy += x * y; xz += x * z; yz += y * z;
  }
  const determinant = xx * yy * zz + 2 * xy * xz * yz - xx * yz * yz - yy * xz * xz - zz * xy * xy;
  return Math.max(0, determinant / Math.max(1e-12, ((xx + yy + zz) / 3) ** 3));
}
