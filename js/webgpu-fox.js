// webgpu-fox.js
// Renders a low-poly fox into a full-viewport <canvas id="bg-canvas"> that
// sits behind the page content (see .bg-canvas in style.css). Hovering
// turns the fox to face the cursor; clicking makes it hop.
//
// Browser support (as of 2026): WebGPU now ships by default in current
// Chrome/Edge, Firefox (141+ on Windows, 145+ on macOS), and Safari 26+.
// Coverage still isn't universal (older browsers, some Linux/Android
// configs), so this bails out quietly and leaves the CSS blueprint-grid
// background in place if `navigator.gpu` isn't there or init fails.

import { loadOBJModel } from './obj-loader.js';
import * as mat4 from './mat4.js';

const CLEAR_COLOR = { r: 3 / 255, g: 10 / 255, b: 19 / 255, a: 1 }; // matches --bg

// Point this at your model. If fox.obj has a `mtllib fox.mtl` line, the
// .mtl is picked up automatically from the same folder — no need to
// reference it here. Drop both files in assets/models/ and this just
// works; see the placeholder already sitting there.
const MODEL_URL = 'assets/models/lowpoly_fox.obj';

const shaderSource = /* wgsl */ `
struct Uniforms {
  mvp        : mat4x4<f32>,
  model      : mat4x4<f32>,
  lightDir   : vec3<f32>,
  time       : f32,
};
@group(0) @binding(0) var<uniform> u : Uniforms;

struct VertexOut {
  @builtin(position) position : vec4<f32>,
  @location(0) worldNormal    : vec3<f32>,
  @location(1) color          : vec3<f32>,
};

@vertex
fn vs_main(
  @location(0) position : vec3<f32>,
  @location(1) normal   : vec3<f32>,
  @location(2) color    : vec3<f32>
) -> VertexOut {
  var out : VertexOut;
  out.position = u.mvp * vec4<f32>(position, 1.0);
  // Uniform scale only, so the model matrix's rotation part doubles as
  // the normal matrix.
  out.worldNormal = normalize((u.model * vec4<f32>(normal, 0.0)).xyz);
  out.color = color;
  return out;
}

@fragment
fn fs_main(in : VertexOut) -> @location(0) vec4<f32> {
  let n = normalize(in.worldNormal);
  let diffuse = max(dot(n, normalize(u.lightDir)), 0.0);
  let rim = pow(1.0 - max(n.z, 0.0), 2.0) * 0.15;
  let ambient = 0.42;
  let lit = in.color * (ambient + diffuse * 0.65) + vec3<f32>(0.15, 0.08, 0.2) * rim;
  return vec4<f32>(lit, 1.0);
}
`;

async function init() {
  const canvas = document.getElementById('bg-canvas');
  if (!canvas) return;

  if (!('gpu' in navigator)) {
    console.info('WebGPU not available in this browser — leaving the static background.');
    canvas.remove();
    return;
  }

  let adapter, device;
  try {
    adapter = await navigator.gpu.requestAdapter({ powerPreference: 'low-power' });
    if (!adapter) throw new Error('No WebGPU adapter');
    device = await adapter.requestDevice();
  } catch (err) {
    console.info('WebGPU init failed, leaving the static background:', err);
    canvas.remove();
    return;
  }

  const context = canvas.getContext('webgpu');
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'premultiplied' });

  // --- geometry ---
  let mesh;
  try {
    mesh = await loadOBJModel(MODEL_URL);
  } catch (err) {
    console.warn(
      `Couldn't load "${MODEL_URL}" — leaving the static background. ` +
      `Make sure your modeled fox.obj (and its .mtl, if any) is at that path.`,
      err
    );
    canvas.remove();
    return;
  }

  logMeshStats(mesh);

  const positionBuffer = createBuffer(device, mesh.positions, GPUBufferUsage.VERTEX);
  const normalBuffer = createBuffer(device, mesh.normals, GPUBufferUsage.VERTEX);
  const colorBuffer = createBuffer(device, mesh.colors, GPUBufferUsage.VERTEX);
  const indexBuffer = createBuffer(device, mesh.indices, GPUBufferUsage.INDEX);

  // --- uniform buffer: mat4 mvp(64) + mat4 model(64) + vec3 lightDir(16, padded) ---
  const UNIFORM_FLOATS = 16 + 16 + 4; // last vec3 rounds up to a vec4 slot
  const uniformBuffer = device.createBuffer({
    size: UNIFORM_FLOATS * 4,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const shaderModule = device.createShaderModule({ code: shaderSource });

  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: {
      module: shaderModule,
      entryPoint: 'vs_main',
      buffers: [
        { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
        { arrayStride: 12, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
        { arrayStride: 12, attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x3' }] },
      ],
    },
    fragment: {
      module: shaderModule,
      entryPoint: 'fs_main',
      targets: [{ format }],
    },
    // cullMode: 'none' rather than 'back' — real exported meshes
    // sometimes end up with reversed winding after an axis conversion,
    // which silently culls 100% of triangles (no error, just a blank
    // frame). This mesh is small and decorative, so the perf cost of
    // drawing both sides is negligible; if you confirm winding is
    // correct and want back-face culling back, flip this to 'back'.
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
  });

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
  });

  let depthTexture = null;
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    const height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    // console.log('resize()', { clientWidth: canvas.clientWidth, clientHeight: canvas.clientHeight, dpr, width, height });

    // Guard on depthTexture existing too, not just size — a <canvas>
    // defaults to 300x150 before any sizing is applied, and if that
    // ever coincidentally matches the computed target size, this
    // early-return would skip creating the depth texture on the very
    // first call and leave it null.
    if (canvas.width === width && canvas.height === height && depthTexture) return;
    canvas.width = width;
    canvas.height = height;
    if (depthTexture) depthTexture.destroy();
    depthTexture = device.createTexture({
      size: [width, height],
      format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }
  resize();
  new ResizeObserver(resize).observe(canvas);

  // --- interaction state ---
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let pointerX = 0, pointerY = 0;       // normalized -1..1, updated on move
  let currentYaw = 0, targetYaw = 0;    // fox facing direction (radians)
  let hopStart = -Infinity;             // performance.now() timestamp of last click
  const HOP_DURATION = 650;             // ms

  window.addEventListener('pointermove', (e) => {
    pointerX = (e.clientX / window.innerWidth) * 2 - 1;
    pointerY = (e.clientY / window.innerHeight) * 2 - 1;
    targetYaw = pointerX * 0.6; // radians, capped turn range
  }, { passive: true });

  window.addEventListener('pointerdown', (e) => {
    hopStart = performance.now();
    targetYaw = ((e.clientX / window.innerWidth) * 2 - 1) * 0.9;
  });

  // --- render loop ---
  let lastTime = performance.now();
  let autoAngle = 0;
  let running = true;

  document.addEventListener('visibilitychange', () => {
    running = document.visibilityState === 'visible';
    if (running) {
      lastTime = performance.now();
      requestAnimationFrame(frame);
    }
  });

  function frame(now) {
    if (!running) return;
    const dt = Math.min((now - lastTime) / 1000, 0.1);
    lastTime = now;

    resize();

    // slow ambient orbit of the camera, paused for reduced-motion users
    if (!reducedMotion) autoAngle += dt * 0.12;

    // ease the fox's facing angle toward the cursor
    const turnSpeed = reducedMotion ? 2.5 : 4.5;
    currentYaw += (targetYaw - currentYaw) * Math.min(dt * turnSpeed, 1);

    // hop animation: a squashed sine arc triggered by pointerdown
    const hopT = Math.min((now - hopStart) / HOP_DURATION, 1);
    let hopY = 0, squashX = 1, squashY = 1;
    if (hopT < 1) {
      hopY = Math.sin(hopT * Math.PI) * 0.4;
      squashY = 1 - Math.sin(hopT * Math.PI) * 0.18;
      squashX = 1 + Math.sin(hopT * Math.PI) * 0.1;
    }

    // camera: gentle orbit + tiny parallax toward the pointer
    const camRadius = 4.4;
    const camAngle = autoAngle + pointerX * 0.15;
    const eye = [
      Math.sin(camAngle) * camRadius,
      1.6 - pointerY * 0.2,
      Math.cos(camAngle) * camRadius,
    ];
    const view = mat4.lookAt(eye, [0, 0.6, 0], [0, 1, 0]);
    const aspect = canvas.width / canvas.height;
    const proj = mat4.perspective((45 * Math.PI) / 180, aspect, 0.1, 50);

    const model = mat4.multiply(
      mat4.translation(0, hopY, 0),
      mat4.multiply(mat4.rotationY(currentYaw), mat4.scaling(squashX, squashY, squashX))
    );
    const mvp = mat4.multiply(proj, mat4.multiply(view, model));

    const uniformData = new Float32Array(UNIFORM_FLOATS);
    uniformData.set(mvp, 0);
    uniformData.set(model, 16);
    uniformData.set([0.4, 0.85, 0.35], 32); // light direction
    device.queue.writeBuffer(uniformBuffer, 0, uniformData);

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: context.getCurrentTexture().createView(),
        clearValue: CLEAR_COLOR,
        loadOp: 'clear',
        storeOp: 'store',
      }],
      depthStencilAttachment: {
        view: depthTexture.createView(),
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });
    pass.setPipeline(pipeline);
    pass.setVertexBuffer(0, positionBuffer);
    pass.setVertexBuffer(1, normalBuffer);
    pass.setVertexBuffer(2, colorBuffer);
    pass.setIndexBuffer(indexBuffer, mesh.indexFormat);
    pass.setBindGroup(0, bindGroup);
    pass.drawIndexed(mesh.indices.length);
    pass.end();
    device.queue.submit([encoder.finish()]);

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function logMeshStats(mesh) {
  const vertexCount = mesh.positions.length / 3;
  const triangleCount = mesh.indices.length / 3;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let hasNaN = false;
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const x = mesh.positions[i], y = mesh.positions[i + 1], z = mesh.positions[i + 2];
    if (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(z)) hasNaN = true;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  console.info(
    `[webgpu-fox] loaded ${vertexCount} vertices / ${triangleCount} triangles. ` +
    `Bounding box after normalize: x[${minX.toFixed(2)}, ${maxX.toFixed(2)}] ` +
    `y[${minY.toFixed(2)}, ${maxY.toFixed(2)}] z[${minZ.toFixed(2)}, ${maxZ.toFixed(2)}]` +
    (hasNaN ? ' — WARNING: NaN in positions, mesh will not render correctly.' : '')
  );
  if (triangleCount === 0) {
    console.warn('[webgpu-fox] Mesh has zero triangles — check the .obj has "f" lines the parser understood.');
  }
}

function createBuffer(device, data, usage) {
  const buffer = device.createBuffer({
    size: Math.ceil(data.byteLength / 4) * 4,
    usage: usage | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true,
  });
  new (data.constructor)(buffer.getMappedRange()).set(data);
  buffer.unmap();
  return buffer;
}

init();

// --- modeling notes ---
// - Export as Wavefront .obj + .mtl (Blender: File > Export > Wavefront
//   (.obj), with "Export Materials" on). Triangulate or leave as quads —
//   the loader fan-triangulates either way.
// - Any scale/position works: obj-loader.js centers and rescales the
//   mesh to fit the camera automatically (see normalizeMesh there).
// - Flat shading is used by default (one normal per triangle), which
//   suits a faceted low-poly look regardless of the normals in the
//   file. Pass { shading: 'smooth' } to loadOBJModel() above if you'd
//   rather use the file's own vertex normals.
// - Per-part colors come from material Kd values, so separate material
//   slots per body part (body/ears/paws/etc.) in your modeling tool will
//   carry straight through — no per-vertex color painting needed.
// - This loader has no skinning/animation support — it's a static mesh.
//   If you want a walk cycle or similar later, that's a much bigger
//   jump (skinned vertex buffers + a real glTF pipeline, or a library
//   like three.js's WebGPURenderer), well beyond a drop-in swap.