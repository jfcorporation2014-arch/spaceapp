import { createMemoryNetwork3DStepper, layoutMemoryNetwork3D } from "./memory-3d.js";
import { layoutMemoryNetwork } from "./memory-network-layout.js";
import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";
self.onmessage = (event: MessageEvent<{ nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[]; mode?: "3D" | "BOTH" }>) => {
  if (event.data.mode !== "3D") {
    const positions = layoutMemoryNetwork(event.data.nodes, event.data.edges);
    self.postMessage({ kind: "complete", positions: [...positions], depth: [...layoutMemoryNetwork3D(event.data.nodes, event.data.edges)] });
    return;
  }
  const stepper = createMemoryNetwork3DStepper(event.data.nodes, event.data.edges);
  const publish = (complete: boolean) => {
    const packed = stepper.packed();
    self.postMessage({ kind: complete ? "complete" : "progress", packed }, { transfer: [packed.buffer] });
  };
  publish(false);
  const continueLayout = () => {
    const complete = stepper.advance(30);
    publish(complete);
    if (!complete) setTimeout(continueLayout, 0);
  };
  setTimeout(continueLayout, 0);
};
