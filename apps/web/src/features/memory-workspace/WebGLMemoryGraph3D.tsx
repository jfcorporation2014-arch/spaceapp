import { useEffect, useMemo, useRef } from "react";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
import { DEFAULT_MEMORY_CAMERA, memory3DVolumeRatio, projectMemoryPoint, type MemoryCamera3D } from "./memory-3d.js";
import { indexProjectedMemory, pickProjectedMemory, type ProjectedMemoryIndex } from "./memory-3d-picking.js";
import { MemoryWebGLRenderer } from "./memory-3d-webgl.js";
import type { MemoryGraph3DProps } from "./MemoryGraph3D.js";

export function WebGLMemoryGraph3D(props: MemoryGraph3DProps & { active: boolean; onAvailability: (available: boolean) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelsRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<MemoryWebGLRenderer | null>(null);
  const uploadedGraphRef = useRef<{ renderer: MemoryWebGLRenderer; nodes: MemoryGraph3DProps["nodes"]; edges: MemoryGraph3DProps["edges"]; positions: MemoryGraph3DProps["positions"] } | null>(null);
  const uploadedCoordinatesRef = useRef<MemoryGraph3DProps["coordinates"] | null>(null);
  const cameraRef = useRef<MemoryCamera3D>({ ...DEFAULT_MEMORY_CAMERA });
  const indexRef = useRef<ProjectedMemoryIndex | null>(null);
  const labelIndicesRef = useRef<number[]>([]);
  const nodeIndexRef = useRef<Map<string, number>>(new Map());
  const renderSamplesRef = useRef<number[]>([]);
  const frameSamplesRef = useRef<number[]>([]);
  const lastFrameAtRef = useRef<number | null>(null);
  const pickSamplesRef = useRef<number[]>([]);
  const frameRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const redrawRef = useRef<() => void>(() => {});
  const current = useRef(props);
  current.current = props;
  const volumeRatio = useMemo(() => memory3DVolumeRatio([...props.coordinates.values()]), [props.coordinates]);

  useEffect(() => {
    const canvas = canvasRef.current, labelCanvas = labelsRef.current;
    if (!canvas || !labelCanvas) return;
    const labelContext = labelCanvas.getContext("2d");
    if (!labelContext) { props.onAvailability(false); return; }
    let width = 1, height = 1, dpr = 1, hover: string | null = null;
    let indexTimer: number | null = null;
    const pointers = new Map<number, { x: number; y: number }>();
    let dragged = false, downX = 0, downY = 0;

    const initialize = () => {
      try {
        const renderer = new MemoryWebGLRenderer(canvas);
        const gl = renderer.gl;
        const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
        canvas.dataset.gpuRenderer = String(gl.getParameter(debugInfo ? debugInfo.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
        const started = performance.now();
        canvas.dataset.graphUploadStart = started.toFixed(0);
        renderer.setGraph(current.current.nodes, current.current.edges, current.current.positions);
        canvas.dataset.graphUploadMs = (performance.now() - started).toFixed(2);
        uploadedGraphRef.current = { renderer, nodes: current.current.nodes, edges: current.current.edges, positions: current.current.positions };
        renderer.setCoordinates(current.current.coordinates);
        uploadedCoordinatesRef.current = current.current.coordinates;
        renderer.setFocus(hover ?? current.current.selectedNodeId);
        rendererRef.current = renderer;
        current.current.onAvailability(true);
        schedule();
      } catch {
        rendererRef.current = null;
        current.current.onAvailability(false);
      }
    };
    const drawLabels = (renderer: MemoryWebGLRenderer, focusId: string | null) => {
      labelContext.clearRect(0, 0, width, height);
      if (!current.current.showTitles) return;
      labelContext.font = "11px system-ui, sans-serif";
      const boxes: Array<{ x: number; y: number; w: number }> = [];
      const focused = focusId ? nodeIndexRef.current.get(focusId) : undefined;
      const candidates = focused === undefined ? labelIndicesRef.current : [focused, ...labelIndicesRef.current];
      const visited = new Set<number>();
      const scale = Math.min(width, height) * 0.4 / renderer.getExtent();
      let measured = 0;
      for (const candidate of candidates) {
        if (visited.has(candidate)) continue;
        visited.add(candidate);
        const node = current.current.nodes[candidate]!;
        if (node.type !== "SOURCE" && node.id !== focusId && cameraRef.current.zoom < 1.6) continue;
        const point = current.current.coordinates.get(node.id);
        if (!point) continue;
        const projected = projectMemoryPoint(point, cameraRef.current, scale, width, height);
        const x = projected.x + 9, y = projected.y;
        if (x < 0 || x > width || y < 14 || y > height - 5) continue;
        if (measured++ >= 120) break;
        const label = node.label.length > 48 ? `${node.label.slice(0, 45)}…` : node.label;
        const w = labelContext.measureText(label).width;
        if (x + w > width || boxes.some(box => Math.abs(box.y - y) < 16 && x < box.x + box.w + 5 && x + w + 5 > box.x)) continue;
        boxes.push({ x, y, w });
        labelContext.fillStyle = "#09111bea";
        labelContext.fillRect(x - 3, y - 11, w + 6, 16);
        labelContext.fillStyle = isMemoryCoreLabel(node.label) ? "#fff0b0" : "#c6dfed";
        labelContext.fillText(label, x, y + 1);
      }
    };
    const render = (frameTime?: number) => {
      if (typeof frameTime === "number") {
        if (lastFrameAtRef.current !== null) {
          const samples = frameSamplesRef.current;
          samples.push(frameTime - lastFrameAtRef.current);
          if (samples.length > 120) samples.shift();
          if (samples.length >= 30) {
            const sorted = [...samples].sort((a, b) => a - b);
            canvas.dataset.frameP95Ms = sorted[Math.floor(sorted.length * 0.95)]!.toFixed(2);
          }
        }
        lastFrameAtRef.current = frameTime;
      }
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
      const renderer = rendererRef.current;
      if (!renderer || !current.current.active || !current.current.coordinates.size) return;
      const focusId = hover ?? current.current.selectedNodeId;
      try {
        const started = performance.now();
        renderer.draw(cameraRef.current, width, height, dpr);
        drawLabels(renderer, focusId);
        const samples = renderSamplesRef.current;
        samples.push(performance.now() - started);
        if (samples.length > 120) samples.shift();
        if (samples.length >= 30) {
          const sorted = [...samples].sort((a, b) => a - b);
          canvas.dataset.renderP95Ms = sorted[Math.floor(sorted.length * 0.95)]!.toFixed(2);
        }
        canvas.dataset.rotation = `${cameraRef.current.yaw.toFixed(3)},${cameraRef.current.pitch.toFixed(3)}`;
      } catch (error) {
        canvas.dataset.renderError = error instanceof Error ? error.message : String(error);
        current.current.onAvailability(false);
      }
    };
    const schedule = () => {
      if (frameRef.current || timerRef.current !== null) return;
      frameRef.current = requestAnimationFrame(render);
      // Background or embedded browser views can suspend rAF while timers still run.
      timerRef.current = window.setTimeout(render, 50);
    };
    redrawRef.current = render;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = rect.width; height = rect.height;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      labelCanvas.width = canvas.width;
      labelCanvas.height = canvas.height;
      labelContext.setTransform(dpr, 0, 0, dpr, 0, 0);
      indexRef.current = null;
      deferIndex();
      schedule();
    };
    const lost = (event: Event) => { event.preventDefault(); rendererRef.current = null; current.current.onAvailability(false); };
    const restored = () => initialize();
    const local = (event: PointerEvent) => { const rect = canvas.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; };
    const rebuildIndex = () => {
      if (!current.current.coordinates.size) return;
      indexRef.current = indexProjectedMemory(current.current.nodes, current.current.coordinates, cameraRef.current, width, height, current.current.selectedNodeId);
    };
    const deferIndex = () => {
      if (indexTimer !== null) window.clearTimeout(indexTimer);
      indexTimer = window.setTimeout(() => { indexTimer = null; rebuildIndex(); }, 120);
    };
    const hit = (x: number, y: number) => {
      const renderer = rendererRef.current;
      if (!renderer || !current.current.coordinates.size) return null;
      try {
        const started = performance.now();
        const id = indexRef.current
          ? pickProjectedMemory(current.current.nodes, indexRef.current, x, y)
          : renderer.pick(cameraRef.current, width, height, dpr, x, y);
        const samples = pickSamplesRef.current;
        samples.push(performance.now() - started);
        if (samples.length > 120) samples.shift();
        if (samples.length >= 10) {
          const sorted = [...samples].sort((a, b) => a - b);
          canvas.dataset.pickP95Ms = sorted[Math.floor(sorted.length * 0.95)]!.toFixed(2);
        }
        return id;
      } catch (error) {
        canvas.dataset.renderError = error instanceof Error ? error.message : String(error);
        current.current.onAvailability(false);
        return null;
      }
    };
    const down = (event: PointerEvent) => {
      canvas.focus(); canvas.setPointerCapture(event.pointerId);
      const point = local(event); pointers.set(event.pointerId, point); downX = point.x; downY = point.y; dragged = false; hover = null;
      rendererRef.current?.setFocus(current.current.selectedNodeId);
      schedule();
    };
    const move = (event: PointerEvent) => {
      const point = local(event), previous = pointers.get(event.pointerId);
      if (previous) {
        if (Math.hypot(point.x - downX, point.y - downY) > 4) dragged = true;
        indexRef.current = null;
        if (pointers.size === 2) {
          const other = [...pointers].find(([id]) => id !== event.pointerId)![1];
          const before = Math.hypot(previous.x - other.x, previous.y - other.y), after = Math.hypot(point.x - other.x, point.y - other.y);
          if (before > 1) cameraRef.current.zoom = Math.max(0.35, Math.min(5, cameraRef.current.zoom * after / before));
        } else {
          cameraRef.current.yaw += (point.x - previous.x) * 0.009;
          cameraRef.current.pitch += (point.y - previous.y) * 0.009;
        }
        pointers.set(event.pointerId, point);
      } else {
        const next = hit(point.x, point.y);
        if (next !== hover) { hover = next; rendererRef.current?.setFocus(hover ?? current.current.selectedNodeId); }
        canvas.style.cursor = hover ? "pointer" : "grab";
      }
      schedule();
    };
    const up = (event: PointerEvent) => {
      const point = local(event);
      if (!dragged && pointers.size === 1) { const id = hit(point.x, point.y); if (id) current.current.onSelectNode(id); }
      pointers.delete(event.pointerId);
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      if (dragged && pointers.size === 0) rebuildIndex();
    };
    const cancel = (event: PointerEvent) => { pointers.delete(event.pointerId); dragged = true; };
    const wheel = (event: WheelEvent) => { event.preventDefault(); cameraRef.current.zoom = Math.max(0.35, Math.min(5, cameraRef.current.zoom * Math.exp(-event.deltaY * 0.001))); rebuildIndex(); schedule(); };
    const key = (event: KeyboardEvent) => {
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
        event.preventDefault();
        cameraRef.current.yaw += event.key === "ArrowLeft" ? -0.15 : event.key === "ArrowRight" ? 0.15 : 0;
        cameraRef.current.pitch += event.key === "ArrowUp" ? -0.15 : event.key === "ArrowDown" ? 0.15 : 0;
        indexRef.current = null;
        rebuildIndex();
        schedule();
      } else if (event.key === "Enter") {
        const node = current.current.nodes[nodeIndexRef.current.get(current.current.selectedNodeId ?? "") ?? labelIndicesRef.current[0] ?? -1];
        if (node) current.current.onSelectNode(node.id);
      }
    };
    canvas.addEventListener("webglcontextlost", lost);
    canvas.addEventListener("webglcontextrestored", restored);
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", cancel);
    canvas.addEventListener("wheel", wheel, { passive: false });
    canvas.addEventListener("keydown", key);
    const observer = new ResizeObserver(resize); observer.observe(canvas);
    let longTaskObserver: PerformanceObserver | null = null;
    if (new URLSearchParams(window.location.search).has("memoryGraphBench") && PerformanceObserver.supportedEntryTypes.includes("longtask")) {
      let max = 0, count = 0;
      const longest: Array<{ start: number; ms: number }> = [];
      longTaskObserver = new PerformanceObserver(list => {
        const since = performance.getEntriesByName("memoryGraphBenchmarkStart").at(-1)?.startTime ?? 0;
        for (const entry of list.getEntries()) {
          if (entry.startTime < since) continue;
          max = Math.max(max, entry.duration);
          count++;
          longest.push({ start: Math.round(entry.startTime), ms: Math.round(entry.duration) });
        }
        longest.sort((a, b) => b.ms - a.ms);
        if (longest.length > 5) longest.length = 5;
        canvas.dataset.longTaskMaxMs = max.toFixed(2);
        canvas.dataset.longTaskCount = String(count);
        canvas.dataset.longTasks = JSON.stringify(longest);
      });
      longTaskObserver.observe({ type: "longtask", buffered: true });
    }
    initialize(); resize();
    return () => {
      observer.disconnect();
      longTaskObserver?.disconnect();
      cancelAnimationFrame(frameRef.current);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      if (indexTimer !== null) window.clearTimeout(indexTimer);
      redrawRef.current = () => {};
      canvas.removeEventListener("webglcontextlost", lost);
      canvas.removeEventListener("webglcontextrestored", restored);
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", cancel);
      canvas.removeEventListener("wheel", wheel);
      canvas.removeEventListener("keydown", key);
      rendererRef.current?.dispose(); rendererRef.current = null;
    };
  }, []);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    indexRef.current = null;
    renderSamplesRef.current = [];
    frameSamplesRef.current = [];
    lastFrameAtRef.current = null;
    pickSamplesRef.current = [];
    canvasRef.current?.removeAttribute("data-render-p95-ms");
    canvasRef.current?.removeAttribute("data-pick-p95-ms");
    const core: number[] = [], sources: number[] = [], regular: number[] = [];
    nodeIndexRef.current = new Map(props.nodes.map((node, index) => [node.id, index]));
    props.nodes.forEach((node, index) => {
      if (node.type === "SOURCE" && isMemoryCoreLabel(node.label)) core.push(index);
      else if (node.type === "SOURCE" && sources.length < 240) sources.push(index);
      else if (regular.length < 120) regular.push(index);
    });
    labelIndicesRef.current = [...core, ...sources, ...regular];
    const uploaded = uploadedGraphRef.current;
    if (!uploaded || uploaded.renderer !== renderer || uploaded.nodes !== props.nodes || uploaded.edges !== props.edges || uploaded.positions !== props.positions) {
      const started = performance.now();
      canvasRef.current!.dataset.graphUploadStart = started.toFixed(0);
      renderer.setGraph(props.nodes, props.edges, props.positions);
      canvasRef.current!.dataset.graphUploadMs = (performance.now() - started).toFixed(2);
      uploadedGraphRef.current = { renderer, nodes: props.nodes, edges: props.edges, positions: props.positions };
      renderer.setCoordinates(props.coordinates);
      uploadedCoordinatesRef.current = props.coordinates;
    }
    renderer.setFocus(props.selectedNodeId);
    redrawRef.current();
  }, [props.nodes, props.edges, props.positions]);
  useEffect(() => {
    if (rendererRef.current && uploadedCoordinatesRef.current !== props.coordinates) {
      rendererRef.current.setCoordinates(props.coordinates);
      uploadedCoordinatesRef.current = props.coordinates;
    }
    redrawRef.current();
    indexRef.current = props.coordinates.size
      ? indexProjectedMemory(props.nodes, props.coordinates, cameraRef.current, canvasRef.current?.getBoundingClientRect().width ?? 1, canvasRef.current?.getBoundingClientRect().height ?? 1, props.selectedNodeId)
      : null;
  }, [props.coordinates, props.loading]);
  useEffect(() => { rendererRef.current?.setFocus(props.selectedNodeId); redrawRef.current(); }, [props.selectedNodeId, props.showTitles, props.active]);
  useEffect(() => { cameraRef.current = { ...DEFAULT_MEMORY_CAMERA }; indexRef.current = null; redrawRef.current(); }, [props.resetToken]);

  return <div className="memory-3d-surface" hidden={!props.active}>
    <canvas ref={canvasRef} tabIndex={0} role="application" aria-label="3D memory graph. Drag or use arrow keys to rotate 360 degrees. Scroll or pinch to zoom. Click a node to open." aria-busy={props.loading} data-titles-visible={props.showTitles} data-layout-volume={volumeRatio.toFixed(4)} />
    <canvas ref={labelsRef} className="memory-3d-labels" aria-hidden="true" />
    <span className="memory-3d-hint">Drag to rotate 360° · Scroll or pinch to zoom · Click to explore</span>
  </div>;
}
