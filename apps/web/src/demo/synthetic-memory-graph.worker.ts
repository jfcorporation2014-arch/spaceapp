import { syntheticMemoryGraphChunk, type SyntheticGraphSize } from "./synthetic-memory-graph.js";

self.onmessage = (event: MessageEvent<{ size: SyntheticGraphSize }>) => {
  const size = event.data.size;
  for (let start = 0; start < size; start += 2000) {
    self.postMessage({ ...syntheticMemoryGraphChunk(size, start, start + 2000), complete: start + 2000 >= size });
  }
};
