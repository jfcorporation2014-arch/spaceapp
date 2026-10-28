import type { MemoryGraphNode } from "@space/contracts";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
import type { MemoryCamera3D, MemoryPoint3D } from "./memory-3d.js";

const CELL = 32;
const key = (column: number, row: number) => column + row * 65536;

export type ProjectedMemoryIndex = {
  points: Float32Array;
  bins: Map<number, number[]>;
  maxHitRadius: number;
  width: number;
  height: number;
};

/** Build once per camera frame; pointer events visit nearby screen cells only. */
export function indexProjectedMemory(nodes: MemoryGraphNode[], coordinates: Map<string, MemoryPoint3D>, camera: MemoryCamera3D, width: number, height: number, focusId: string | null): ProjectedMemoryIndex {
  let extent = 60;
  for (const point of coordinates.values()) extent = Math.max(extent, Math.hypot(point.x, point.y, point.z));
  const scale = Math.min(width, height) * 0.4 / extent;
  const cy = Math.cos(camera.yaw), sy = Math.sin(camera.yaw);
  const cp = Math.cos(camera.pitch), sp = Math.sin(camera.pitch);
  const zoom = camera.zoom, rootZoom = Math.sqrt(zoom);
  const points = new Float32Array(nodes.length * 5);
  const bins = new Map<number, number[]>();
  let maxHitRadius = 7;
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]!;
    const point = coordinates.get(node.id);
    if (!point) continue;
    const x = point.x * cy + point.z * sy;
    const depth = -point.x * sy + point.z * cy;
    const y = point.y * cp - depth * sp;
    const z = point.y * sp + depth * cp;
    const perspective = 650 / Math.max(120, 650 + z * scale);
    const px = width / 2 + x * scale * zoom * perspective;
    const py = height / 2 - y * scale * zoom * perspective;
    const root = node.type === "SOURCE" && isMemoryCoreLabel(node.label);
    const radius = Math.max(1, (root ? 10 : node.type === "SOURCE" ? 4.6 : 2.1) * perspective * rootZoom) * (node.id === focusId ? 1.5 : 1);
    const offset = index * 5;
    points[offset] = px;
    points[offset + 1] = py;
    points[offset + 2] = z;
    points[offset + 3] = perspective;
    points[offset + 4] = radius;
    if (px < -radius || py < -radius || px > width + radius || py > height + radius) continue;
    const cellKey = key(Math.floor(px / CELL), Math.floor(py / CELL));
    if (!bins.has(cellKey)) bins.set(cellKey, []);
    bins.get(cellKey)!.push(index);
    maxHitRadius = Math.max(maxHitRadius, radius + 3);
  }
  return { points, bins, maxHitRadius, width, height };
}

export function pickProjectedMemory(nodes: MemoryGraphNode[], index: ProjectedMemoryIndex, x: number, y: number): string | null {
  const column = Math.floor(x / CELL), row = Math.floor(y / CELL);
  const reach = Math.ceil(index.maxHitRadius / CELL);
  let best = -1, bestDepth = Infinity;
  for (let cy = row - reach; cy <= row + reach; cy++) {
    for (let cx = column - reach; cx <= column + reach; cx++) {
      for (const candidate of index.bins.get(key(cx, cy)) ?? []) {
        const offset = candidate * 5;
        const dx = index.points[offset]! - x, dy = index.points[offset + 1]! - y;
        const radius = Math.max(7, index.points[offset + 4]! + 3);
        if (dx * dx + dy * dy >= radius * radius) continue;
        const depth = index.points[offset + 2]!;
        if (depth < bestDepth) { best = candidate; bestDepth = depth; }
      }
    }
  }
  return best < 0 ? null : nodes[best]!.id;
}

/** Caps both text measurements and draw calls, even at 50,000 nodes. */
export function selectMemoryLabelCandidates(nodes: MemoryGraphNode[], index: ProjectedMemoryIndex, focusId: string | null, zoom: number, limit = 120): number[] {
  const core: number[] = [], sources: number[] = [], regular: number[] = [];
  nodes.forEach((node, i) => {
    const offset = i * 5, x = index.points[offset]!, y = index.points[offset + 1]!;
    if (!Number.isFinite(x) || x < 0 || x > index.width || y < 14 || y > index.height - 5) return;
    if (node.id === focusId || isMemoryCoreLabel(node.label)) core.push(i);
    else if (node.type === "SOURCE") sources.push(i);
    else if (zoom >= 1.6 && regular.length < limit) regular.push(i);
  });
  const focused = focusId === null ? -1 : nodes.findIndex(node => node.id === focusId);
  if (focused >= 0) core.sort((a, b) => Number(b === focused) - Number(a === focused));
  return [...core, ...sources, ...regular].slice(0, limit);
}
