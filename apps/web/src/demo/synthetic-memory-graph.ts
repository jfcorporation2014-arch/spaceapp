import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";

export type SyntheticGraphSize = 2000 | 10000 | 50000;

/** Stable, public demo data. Each non-root node has three bounded links. */
export function syntheticMemoryGraphChunk(size: SyntheticGraphSize, start: number, end: number): { nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[] } {
  const nodes: MemoryGraphNode[] = [];
  const edges: MemoryGraphEdge[] = [];
  if (start === 0) nodes.push({ id: "source:synthetic-core", type: "SOURCE", label: "space.md", sourcePath: "/demo/synthetic/space.md", recordId: null });
  for (let i = Math.max(1, start); i < Math.min(size, end); i++) {
    const id = `memory:synthetic-${i}`;
    nodes.push({ id, type: "MEMORY", label: `Synthetic memory ${i}`, sourcePath: "/demo/synthetic/space.md", recordId: id });
    edges.push({ id: `memory_edge:synthetic-root-${i}`, type: "CONTAINS", source: "source:synthetic-core", target: id });
    edges.push({ id: `memory_edge:synthetic-chain-${i}`, type: "DERIVED_FROM", source: id, target: `memory:synthetic-${i === 1 ? size - 1 : i - 1}` });
    edges.push({ id: `memory_edge:synthetic-skip-${i}`, type: "DERIVED_FROM", source: id, target: `memory:synthetic-${i < 3 ? size - 3 + i : i - 2}` });
  }
  return { nodes, edges };
}

export function syntheticMemoryGraph(size: SyntheticGraphSize): { nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[] } {
  return syntheticMemoryGraphChunk(size, 0, size);
}
