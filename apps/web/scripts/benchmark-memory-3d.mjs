import { syntheticMemoryGraph } from "../src/demo/synthetic-memory-graph.ts";
import { createMemoryAtlas } from "../src/features/memory-workspace/memory-atlas.ts";
import { createMemoryNetwork3DStepper, DEFAULT_MEMORY_CAMERA } from "../src/features/memory-workspace/memory-3d.ts";
import { indexProjectedMemory, pickProjectedMemory, selectMemoryLabelCandidates } from "../src/features/memory-workspace/memory-3d-picking.ts";

const size = Number(process.argv[2] ?? 2000);
if (![2000, 10000, 50000].includes(size)) throw new Error("Expected 2000, 10000 or 50000 nodes");
const timed = (fn) => { const start = performance.now(); const value = fn(); return { value, ms: performance.now() - start }; };
const generated = timed(() => syntheticMemoryGraph(size));
const atlas = timed(() => createMemoryAtlas(generated.value.nodes, generated.value.edges, false));
const stepper = timed(() => createMemoryNetwork3DStepper(atlas.value.nodes, atlas.value.edges));
const first = timed(() => stepper.value.advance(30));
const remaining = timed(() => { while (!stepper.value.advance(30)) {} });
const positions = stepper.value.snapshot();
const projection = timed(() => indexProjectedMemory(atlas.value.nodes, positions, DEFAULT_MEMORY_CAMERA, 1280, 720, null));
const picks = [];
for (let i = 0; i < 1000; i++) {
  const x = 300 + (i * 37) % 700, y = 100 + (i * 17) % 500;
  const start = performance.now();
  pickProjectedMemory(atlas.value.nodes, projection.value, x, y);
  picks.push(performance.now() - start);
}
picks.sort((a, b) => a - b);
const labels = timed(() => selectMemoryLabelCandidates(atlas.value.nodes, projection.value, null, 1.7));
console.log(JSON.stringify({
  size, edges: generated.value.edges.length,
  milliseconds: {
    generate: generated.ms, atlas: atlas.ms, prepareLayout: stepper.ms,
    first30Iterations: first.ms, remaining150Iterations: remaining.ms,
    projectAndIndex: projection.ms, pickP95: picks[Math.floor(picks.length * 0.95)], labels: labels.ms
  },
  selectedLabels: labels.value.length,
  hardware: "CPU-only Node benchmark; browser frame timing requires a separate GPU trace"
}, null, 2));
