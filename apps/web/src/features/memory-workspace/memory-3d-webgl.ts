import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import type { MemoryAtlasPosition } from "./memory-atlas.js";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
import type { MemoryCamera3D, MemoryPoint3D } from "./memory-3d.js";

const TEXTURE_WIDTH = 256;

const commonVertex = `
precision highp float;
uniform sampler2D uPositions;
uniform float uYaw;
uniform float uPitch;
uniform float uScale;
uniform float uZoom;
uniform float uExtent;
uniform vec2 uSize;
vec3 positionAt(int index) {
  return texelFetch(uPositions, ivec2(index % ${TEXTURE_WIDTH}, index / ${TEXTURE_WIDTH}), 0).xyz;
}
vec4 projectPoint(vec3 world) {
  float cy = cos(uYaw), sy = sin(uYaw);
  float cp = cos(uPitch), sp = sin(uPitch);
  float x = world.x * cy + world.z * sy;
  float depth = -world.x * sy + world.z * cy;
  float y = world.y * cp - depth * sp;
  float z = world.y * sp + depth * cp;
  float perspective = 650.0 / max(120.0, 650.0 + z * uScale);
  return vec4(2.0 * x * uScale * uZoom * perspective / uSize.x,
              2.0 * y * uScale * uZoom * perspective / uSize.y,
              clamp(z / uExtent, -0.99, 0.99), perspective);
}
`;

const edgeVertex = `#version 300 es
${commonVertex}
layout(location=0) in float aIndex;
layout(location=1) in float aPeer;
layout(location=2) in float aKind;
uniform float uFocus;
out vec4 vColor;
void main() {
  vec4 projected = projectPoint(positionAt(int(aIndex)));
  gl_Position = vec4(projected.xyz, 1.0);
  bool incident = aIndex == uFocus || aPeer == uFocus;
  vec3 ordinary = aKind > 0.5 ? vec3(0.22, 0.31, 0.41) : vec3(0.125, 0.20, 0.26);
  vColor = vec4(incident ? vec3(0.60, 0.85, 0.98) : ordinary,
                incident ? 0.95 : uFocus >= 0.0 ? 0.25 : 0.60);
}`;

const nodeVertex = `#version 300 es
${commonVertex}
layout(location=0) in vec2 aCorner;
layout(location=1) in vec4 aStyle;
layout(location=2) in float aFlag;
uniform float uFocus;
uniform bool uPicking;
out vec2 vCorner;
out vec4 vColor;
flat out int vIndex;
void main() {
  vec4 projected = projectPoint(positionAt(gl_InstanceID));
  float radius = max(1.0, aStyle.x * projected.w * sqrt(uZoom));
  if (aFlag > 1.5) radius *= 1.5;
  if (uPicking) radius = max(7.0, radius + 3.0);
  gl_Position = vec4(projected.x + aCorner.x * radius * 2.0 / uSize.x,
                     projected.y + aCorner.y * radius * 2.0 / uSize.y,
                     projected.z, 1.0);
  vCorner = aCorner;
  vIndex = gl_InstanceID + 1;
  vec3 color = aFlag > 1.5 ? vec3(1.0) : aStyle.yzw;
  float alpha = uFocus >= 0.0 && aFlag < 0.5 ? 0.2 : clamp(projected.w, 0.4, 1.0);
  vColor = vec4(color, alpha);
}`;

const edgeFragment = `#version 300 es
precision highp float;
in vec4 vColor;
out vec4 color;
void main() { color = vColor; }`;

const nodeFragment = `#version 300 es
precision highp float;
in vec2 vCorner;
in vec4 vColor;
out vec4 color;
void main() {
  float d = dot(vCorner, vCorner);
  if (d > 1.0) discard;
  color = vec4(vColor.rgb, vColor.a * smoothstep(1.0, 0.75, d));
}`;

const pickFragment = `#version 300 es
precision highp float;
in vec2 vCorner;
flat in int vIndex;
out vec4 color;
void main() {
  if (dot(vCorner, vCorner) > 1.0) discard;
  color = vec4(float(vIndex & 255), float((vIndex >> 8) & 255), float((vIndex >> 16) & 255), 255.0) / 255.0;
}`;

function makeProgram(gl: WebGL2RenderingContext, vertexSource: string, fragmentSource: string): WebGLProgram {
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type);
    if (!shader) throw new Error("WebGL shader allocation failed");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`WebGL shader compilation failed: ${message}`);
    }
    return shader;
  };
  const vertex = compile(gl.VERTEX_SHADER, vertexSource);
  const fragment = compile(gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  if (!program) throw new Error("WebGL program allocation failed");
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`WebGL program linking failed: ${message}`);
  }
  return program;
}

function colorTriplet(value: string): [number, number, number] {
  const normalized = /^#[0-9a-f]{6}$/i.test(value) ? value.slice(1) : "7395ad";
  return [0, 2, 4].map(offset => Number.parseInt(normalized.slice(offset, offset + 2), 16) / 255) as [number, number, number];
}

function buffer(gl: WebGL2RenderingContext): WebGLBuffer {
  const value = gl.createBuffer();
  if (!value) throw new Error("WebGL buffer allocation failed");
  return value;
}

export class MemoryWebGLRenderer {
  readonly gl: WebGL2RenderingContext;
  private readonly nodesProgram: WebGLProgram;
  private readonly edgesProgram: WebGLProgram;
  private readonly pickProgram: WebGLProgram;
  private readonly nodesVao: WebGLVertexArrayObject;
  private readonly edgesVao: WebGLVertexArrayObject;
  private readonly cornerBuffer: WebGLBuffer;
  private readonly styleBuffer: WebGLBuffer;
  private readonly flagBuffer: WebGLBuffer;
  private readonly edgeBuffer: WebGLBuffer;
  private readonly positionTexture: WebGLTexture;
  private readonly pickFramebuffer: WebGLFramebuffer;
  private readonly pickTexture: WebGLTexture;
  private readonly pickDepth: WebGLRenderbuffer;
  private pickWidth = 0;
  private pickHeight = 0;
  private nodes: MemoryGraphNode[] = [];
  private coordinates = new Map<string, MemoryPoint3D>();
  private positions = new Map<string, MemoryAtlasPosition>();
  private nodeIndex = new Map<string, number>();
  private neighbors = new Map<string, number[]>();
  private flags = new Uint8Array();
  private edgeVertices = 0;
  private focusIndex = -1;
  private extent = 60;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { antialias: true, alpha: true });
    if (!gl) throw new Error("WebGL2 is unavailable");
    this.gl = gl;
    this.nodesProgram = makeProgram(gl, nodeVertex, nodeFragment);
    this.edgesProgram = makeProgram(gl, edgeVertex, edgeFragment);
    this.pickProgram = makeProgram(gl, nodeVertex, pickFragment);
    const nodesVao = gl.createVertexArray(), edgesVao = gl.createVertexArray(), positionTexture = gl.createTexture();
    const pickFramebuffer = gl.createFramebuffer(), pickTexture = gl.createTexture(), pickDepth = gl.createRenderbuffer();
    if (!nodesVao || !edgesVao || !positionTexture || !pickFramebuffer || !pickTexture || !pickDepth) throw new Error("WebGL vertex storage allocation failed");
    this.nodesVao = nodesVao;
    this.edgesVao = edgesVao;
    this.positionTexture = positionTexture;
    this.pickFramebuffer = pickFramebuffer;
    this.pickTexture = pickTexture;
    this.pickDepth = pickDepth;
    this.cornerBuffer = buffer(gl);
    this.styleBuffer = buffer(gl);
    this.flagBuffer = buffer(gl);
    this.edgeBuffer = buffer(gl);
    gl.bindTexture(gl.TEXTURE_2D, positionTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindVertexArray(nodesVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.styleBuffer);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.flagBuffer);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.UNSIGNED_BYTE, false, 0, 0);
    gl.vertexAttribDivisor(2, 1);
    gl.bindVertexArray(edgesVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeBuffer);
    for (let index = 0; index < 3; index++) {
      gl.enableVertexAttribArray(index);
      gl.vertexAttribPointer(index, 1, gl.FLOAT, false, 12, index * 4);
    }
    gl.bindVertexArray(null);
  }

  setGraph(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[], positions: Map<string, MemoryAtlasPosition>): void {
    const gl = this.gl;
    this.nodes = nodes;
    this.positions = positions;
    this.nodeIndex = new Map();
    for (let index = 0; index < nodes.length; index++) this.nodeIndex.set(nodes[index]!.id, index);
    this.neighbors = new Map();
    const styles = new Float32Array(nodes.length * 4);
    const colors = new Map<string, [number, number, number]>();
    nodes.forEach((node, index) => {
      const core = node.type === "SOURCE" && isMemoryCoreLabel(node.label);
      const hex = positions.get(node.id)?.color ?? "#7395ad";
      if (!colors.has(hex)) colors.set(hex, colorTriplet(hex));
      const color = colors.get(hex)!;
      const offset = index * 4;
      styles[offset] = core ? 10 : node.type === "SOURCE" ? 4.6 : 2.1;
      styles[offset + 1] = color[0]; styles[offset + 2] = color[1]; styles[offset + 3] = color[2];
    });
    gl.bindBuffer(gl.ARRAY_BUFFER, this.styleBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, styles, gl.STATIC_DRAW);
    this.flags = new Uint8Array(nodes.length);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.flagBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.flags, gl.DYNAMIC_DRAW);
    const vertices = new Float32Array(edges.length * 6);
    let vertexFloats = 0;
    for (const edge of edges) {
      const source = this.nodeIndex.get(edge.source), target = this.nodeIndex.get(edge.target);
      if (source === undefined || target === undefined) continue;
      const kind = edge.type === "DERIVED_FROM" ? 1 : 0;
      vertices[vertexFloats++] = source;
      vertices[vertexFloats++] = target;
      vertices[vertexFloats++] = kind;
      vertices[vertexFloats++] = target;
      vertices[vertexFloats++] = source;
      vertices[vertexFloats++] = kind;
      if (!this.neighbors.has(edge.source)) this.neighbors.set(edge.source, []);
      if (!this.neighbors.has(edge.target)) this.neighbors.set(edge.target, []);
      this.neighbors.get(edge.source)!.push(target);
      this.neighbors.get(edge.target)!.push(source);
    }
    this.edgeVertices = vertexFloats / 3;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices.subarray(0, vertexFloats), gl.STATIC_DRAW);
    this.focusIndex = -1;
  }

  setCoordinates(coordinates: Map<string, MemoryPoint3D>): void {
    this.coordinates = coordinates;
    const gl = this.gl;
    const textureHeight = Math.max(1, Math.ceil(this.nodes.length / TEXTURE_WIDTH));
    const data = new Float32Array(TEXTURE_WIDTH * textureHeight * 4);
    let extent = 60;
    this.nodes.forEach((node, index) => {
      const point = coordinates.get(node.id);
      if (!point) return;
      const offset = index * 4;
      data[offset] = point.x; data[offset + 1] = point.y; data[offset + 2] = point.z; data[offset + 3] = 1;
      extent = Math.max(extent, Math.hypot(point.x, point.y, point.z));
    });
    this.extent = extent;
    gl.bindTexture(gl.TEXTURE_2D, this.positionTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, TEXTURE_WIDTH, textureHeight, 0, gl.RGBA, gl.FLOAT, data);
  }

  setFocus(id: string | null): void {
    this.flags.fill(0);
    this.focusIndex = id === null ? -1 : this.nodeIndex.get(id) ?? -1;
    if (id !== null && this.focusIndex >= 0) {
      for (const neighbor of this.neighbors.get(id) ?? []) this.flags[neighbor] = 1;
      this.flags[this.focusIndex] = 2;
    }
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.flagBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.flags);
  }

  private configure(program: WebGLProgram, camera: MemoryCamera3D, width: number, height: number, picking = false): void {
    const gl = this.gl;
    gl.useProgram(program);
    gl.uniform1i(gl.getUniformLocation(program, "uPositions"), 0);
    gl.uniform1f(gl.getUniformLocation(program, "uYaw"), camera.yaw);
    gl.uniform1f(gl.getUniformLocation(program, "uPitch"), camera.pitch);
    gl.uniform1f(gl.getUniformLocation(program, "uScale"), Math.min(width, height) * 0.4 / this.extent);
    gl.uniform1f(gl.getUniformLocation(program, "uZoom"), camera.zoom);
    gl.uniform1f(gl.getUniformLocation(program, "uExtent"), this.extent);
    gl.uniform2f(gl.getUniformLocation(program, "uSize"), width, height);
    gl.uniform1f(gl.getUniformLocation(program, "uFocus"), this.focusIndex);
    gl.uniform1i(gl.getUniformLocation(program, "uPicking"), picking ? 1 : 0);
  }

  getExtent(): number { return this.extent; }

  private resizePickBuffer(width: number, height: number): void {
    if (this.pickWidth === width && this.pickHeight === height) return;
    const gl = this.gl;
    this.pickWidth = width; this.pickHeight = height;
    gl.bindTexture(gl.TEXTURE_2D, this.pickTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.pickDepth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, width, height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFramebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.pickTexture, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.pickDepth);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error("WebGL picking framebuffer is incomplete");
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  pick(camera: MemoryCamera3D, width: number, height: number, dpr: number, x: number, y: number): string | null {
    if (!this.nodes.length || x < 0 || y < 0 || x >= width || y >= height) return null;
    const gl = this.gl;
    const pixelWidth = Math.max(1, Math.round(width * dpr)), pixelHeight = Math.max(1, Math.round(height * dpr));
    this.resizePickBuffer(pixelWidth, pixelHeight);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFramebuffer);
    gl.viewport(0, 0, pixelWidth, pixelHeight);
    gl.enable(gl.SCISSOR_TEST);
    const pixelX = Math.min(pixelWidth - 1, Math.floor(x * dpr));
    const pixelY = Math.max(0, pixelHeight - 1 - Math.floor(y * dpr));
    gl.scissor(pixelX, pixelY, 1, 1);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.positionTexture);
    this.configure(this.pickProgram, camera, width, height, true);
    gl.bindVertexArray(this.nodesVao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.nodes.length);
    const pixel = new Uint8Array(4);
    gl.readPixels(pixelX, pixelY, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    gl.bindVertexArray(null);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const index = pixel[0]! + pixel[1]! * 256 + pixel[2]! * 65536 - 1;
    return this.nodes[index]?.id ?? null;
  }

  draw(camera: MemoryCamera3D, width: number, height: number, dpr: number): void {
    const gl = this.gl;
    if (!width || !height) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.SCISSOR_TEST);
    gl.viewport(0, 0, Math.round(width * dpr), Math.round(height * dpr));
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.positionTexture);
    gl.depthMask(false);
    this.configure(this.edgesProgram, camera, width, height);
    gl.bindVertexArray(this.edgesVao);
    gl.drawArrays(gl.LINES, 0, this.edgeVertices);
    gl.depthMask(true);
    this.configure(this.nodesProgram, camera, width, height);
    gl.bindVertexArray(this.nodesVao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.nodes.length);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteBuffer(this.cornerBuffer);
    gl.deleteBuffer(this.styleBuffer);
    gl.deleteBuffer(this.flagBuffer);
    gl.deleteBuffer(this.edgeBuffer);
    gl.deleteTexture(this.positionTexture);
    gl.deleteTexture(this.pickTexture);
    gl.deleteRenderbuffer(this.pickDepth);
    gl.deleteFramebuffer(this.pickFramebuffer);
    gl.deleteVertexArray(this.nodesVao);
    gl.deleteVertexArray(this.edgesVao);
    gl.deleteProgram(this.nodesProgram);
    gl.deleteProgram(this.edgesProgram);
    gl.deleteProgram(this.pickProgram);
  }
}
