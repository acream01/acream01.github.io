// obj-loader.js
// A small, dependency-free Wavefront .obj (+ .mtl) loader. Good enough for
// a static low-poly model with a handful of materials — not a general
// OBJ implementation (no smoothing groups, no texture coords used, no
// free-form surfaces).
//
// Usage:
//   const mesh = await loadOBJModel('assets/models/fox.obj');
//
// If your .obj has a `mtllib some.mtl` line, that file is fetched
// automatically from the same folder. Each `usemtl <name>` face group is
// colored using that material's `Kd r g b` line (falls back to a default
// color if no material/mtl is found), so per-part colors from Blender
// (body/ears/paws as separate material slots, say) carry straight through.

const DEFAULT_COLOR = [0.8, 0.8, 0.8];

export async function loadOBJModel(objUrl, options = {}) {
  const objText = await fetchText(objUrl);
  const baseUrl = objUrl.slice(0, objUrl.lastIndexOf('/') + 1);

  const materials = {};
  const mtlUrl = options.mtlUrl
    || (() => {
      const match = objText.match(/^mtllib\s+(.+)$/m);
      return match ? baseUrl + match[1].trim() : null;
    })();

  if (mtlUrl) {
    try {
      parseMTL(await fetchText(mtlUrl), materials);
    } catch (err) {
      console.warn(`Could not load "${mtlUrl}" — using a default color instead.`, err);
    }
  }

  const mesh = parseOBJ(objText, materials, {
    shading: options.shading || 'flat',
    defaultColor: options.defaultColor || DEFAULT_COLOR,
  });

  normalizeMesh(mesh.positions, options.targetHeight ?? 1.6);

  return mesh;
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed for ${url}: ${res.status} ${res.statusText}`);
  return res.text();
}

function parseMTL(text, materials) {
  let current = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    switch (parts[0]) {
      case 'newmtl':
        current = parts[1];
        materials[current] = DEFAULT_COLOR.slice();
        break;
      case 'Kd':
        if (current) {
          materials[current] = [parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3])];
        }
        break;
    }
  }
}

function parseOBJ(text, materials, { shading, defaultColor }) {
  const positions = [];
  const normalsIn = [];
  let currentColor = defaultColor;

  const outPositions = [];
  const outNormals = [];
  const outColors = [];
  const outIndices = [];

  function emitVertex(p, n, color) {
    const idx = outPositions.length / 3;
    outPositions.push(p[0], p[1], p[2]);
    outNormals.push(n[0], n[1], n[2]);
    outColors.push(color[0], color[1], color[2]);
    return idx;
  }

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    const kw = parts[0];

    if (kw === 'v') {
      positions.push([parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3])]);
    } else if (kw === 'vn') {
      normalsIn.push([parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3])]);
    } else if (kw === 'usemtl') {
      currentColor = materials[parts[1]] || defaultColor;
    } else if (kw === 'f') {
      const corners = parts.slice(1).map((token) => {
        const [vTok, , vnTok] = token.split('/'); // texcoord (middle) unused
        return {
          vi: resolveIndex(vTok, positions.length),
          ni: vnTok ? resolveIndex(vnTok, normalsIn.length) : null,
        };
      });

      // Fan-triangulate n-gons (assumes convex/planar faces, true for
      // anything a modeling tool triangulates or exports as quads).
      for (let i = 1; i < corners.length - 1; i++) {
        const tri = [corners[0], corners[i], corners[i + 1]];
        const p0 = positions[tri[0].vi];
        const p1 = positions[tri[1].vi];
        const p2 = positions[tri[2].vi];

        const useFileNormals = shading === 'smooth' && tri.every((c) => c.ni !== null);
        if (useFileNormals) {
          for (const c of tri) {
            outIndices.push(emitVertex(positions[c.vi], normalsIn[c.ni], currentColor));
          }
        } else {
          // Flat shading: one normal for the whole triangle, matching a
          // faceted low-poly look regardless of what the file provides.
          const n = faceNormal(p0, p1, p2);
          for (const p of [p0, p1, p2]) {
            outIndices.push(emitVertex(p, n, currentColor));
          }
        }
      }
    }
  }

  if (outPositions.length === 0) {
    throw new Error('Parsed .obj had no triangles — check the file has "v" and "f" lines.');
  }

  const useUint32 = outPositions.length / 3 > 65535;
  return {
    positions: new Float32Array(outPositions),
    normals: new Float32Array(outNormals),
    colors: new Float32Array(outColors),
    indices: useUint32 ? new Uint32Array(outIndices) : new Uint16Array(outIndices),
    indexFormat: useUint32 ? 'uint32' : 'uint16',
  };
}

function resolveIndex(token, count) {
  const n = parseInt(token, 10);
  return n > 0 ? n - 1 : count + n; // OBJ indices are 1-based; negative = relative
}

function faceNormal(p0, p1, p2) {
  const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
  const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

// Centers the mesh on X/Z, sits it on y=0, and scales it so it's
// `targetHeight` units tall — so it doesn't matter whether you modeled
// it at centimeter or meter scale, or off-center from the origin, it'll
// land in the same spot the camera in webgpu-fox.js is already framed for.
function normalizeMesh(positions, targetHeight) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const height = maxY - minY || 1;
  const scale = targetHeight / height;
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;

  for (let i = 0; i < positions.length; i += 3) {
    positions[i] = (positions[i] - cx) * scale;
    positions[i + 1] = (positions[i + 1] - minY) * scale;
    positions[i + 2] = (positions[i + 2] - cz) * scale;
  }
}