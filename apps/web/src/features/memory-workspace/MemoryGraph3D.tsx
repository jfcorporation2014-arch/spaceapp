import { useMemo, useState } from "react";
import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";
import type { MemoryAtlasPosition } from "./memory-atlas.js";
import type { MemoryPoint3D } from "./memory-3d.js";
import { CanvasMemoryGraph3D } from "./CanvasMemoryGraph3D.js";
import { WebGLMemoryGraph3D } from "./WebGLMemoryGraph3D.js";

export type MemoryGraph3DProps = {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  positions: Map<string, MemoryAtlasPosition>;
  coordinates: Map<string, MemoryPoint3D>;
  showTitles: boolean;
  selectedNodeId: string | null;
  onSelectNode: (id: string) => void;
  loading: boolean;
  resetToken: number;
};

export function MemoryGraph3D(props: MemoryGraph3DProps) {
  const [webglReady, setWebglReady] = useState<boolean | null>(null);
  const fallback = useMemo(() => {
    if (webglReady !== false) return null;
    const nodes = props.nodes.slice(0, 2000);
    const ids = new Set(nodes.map(node => node.id));
    return {
      nodes,
      edges: props.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)).slice(0, 6000),
      positions: new Map([...props.positions].filter(([id]) => ids.has(id))),
      coordinates: new Map([...props.coordinates].filter(([id]) => ids.has(id)))
    };
  }, [webglReady, props.nodes, props.edges, props.positions, props.coordinates]);
  return <>
    <WebGLMemoryGraph3D {...props} active={webglReady !== false} onAvailability={setWebglReady} />
    {fallback ? <CanvasMemoryGraph3D {...props} {...fallback} /> : null}
  </>;
}
