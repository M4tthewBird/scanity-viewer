// Converts a voxel collision (splat-transform's .voxel.json + .voxel.bin) into a collision mesh
// (.glb) for the viewer's collision.glb: the surface between solid and empty voxels, with the
// faces of each slice merged into rectangles so the mesh stays light.
//
//   node scanity/tools/voxel-to-glb.mjs <scene.voxel.json> [<scene.voxel.bin>] <collision.glb>
//
// The .bin defaults to the .json's name with .voxel.bin. Version 1.1 voxels are in the scene's
// world space, as the viewer's GLB collision reads vertex positions; version 1.0 files had X and
// Y negated (see FlippedVoxelCollision in src/collision/voxel-collision.ts), which is undone here.

import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args.length < 2) {
    console.error('usage: node voxel-to-glb.mjs <scene.voxel.json> [<scene.voxel.bin>] <collision.glb>');
    process.exit(1);
}
const jsonPath = args[0];
const binPath = args.length > 2 ? args[1] : jsonPath.replace(/\.voxel\.json$/, '.voxel.bin');
const outPath = args[args.length - 1];

const meta = JSON.parse(readFileSync(jsonPath, 'utf8'));
const bin = readFileSync(binPath);
const words = new Uint32Array(bin.buffer, bin.byteOffset, bin.byteLength / 4);
if (words.length !== meta.nodeCount + meta.leafDataCount) {
    throw new Error(`${binPath} holds ${words.length} words, the metadata expects ${meta.nodeCount + meta.leafDataCount}`);
}
const nodes = words.slice(0, meta.nodeCount);
const leafData = words.slice(meta.nodeCount);
const flipXY = !meta.version || parseFloat(meta.version) < 1.1;

const res = meta.voxelResolution;
const [minX, minY, minZ] = meta.gridBounds.min;
const nx = Math.round((meta.gridBounds.max[0] - minX) / res);
const ny = Math.round((meta.gridBounds.max[1] - minY) / res);
const nz = Math.round((meta.gridBounds.max[2] - minZ) / res);
const SOLID_LEAF = 0xff000000 >>> 0;

const popcount = (n) => {
    let c = 0;
    for (; n; n &= n - 1) c++;
    return c;
};

// as VoxelCollision.isVoxelSolid: down the sparse octree to a solid or a mixed 4×4×4 leaf
const solidAt = (ix, iy, iz) => {
    if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz || nodes.length === 0) return false;
    const leaf = (node) => {
        const index = node & 0x00ffffff;
        const bit = (iz & 3) * 16 + (iy & 3) * 4 + (ix & 3);
        const word = leafData[index * 2 + (bit < 32 ? 0 : 1)] >>> 0;
        return ((word >>> (bit & 31)) & 1) === 1;
    };
    const bx = Math.floor(ix / meta.leafSize);
    const by = Math.floor(iy / meta.leafSize);
    const bz = Math.floor(iz / meta.leafSize);
    let at = 0;
    for (let level = meta.treeDepth - 1; level >= 0; level--) {
        const node = nodes[at] >>> 0;
        if (node === SOLID_LEAF) return true;
        const mask = (node >>> 24) & 0xff;
        if (mask === 0) return leaf(node);
        const octant = (((bz >>> level) & 1) << 2) | (((by >>> level) & 1) << 1) | ((bx >>> level) & 1);
        if ((mask & (1 << octant)) === 0) return false;
        at = (node & 0x00ffffff) + popcount(mask & ((1 << octant) - 1));
    }
    const node = nodes[at] >>> 0;
    return node === SOLID_LEAF || leaf(node);
};

// the grid, unpacked once
const grid = new Uint8Array(nx * ny * nz);
let solidCount = 0;
for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
            if (solidAt(x, y, z)) {
                grid[(z * ny + y) * nx + x] = 1;
                solidCount++;
            }
        }
    }
}
const solid = (c) => c[0] >= 0 && c[1] >= 0 && c[2] >= 0 && c[0] < nx && c[1] < ny && c[2] < nz && grid[(c[2] * ny + c[1]) * nx + c[0]] === 1;

// greedy meshing: for each axis and direction, each slice's exposed faces merged into rectangles
const positions = [];
const indices = [];
const dims = [nx, ny, nz];
const toWorld = (c) => {
    const x = minX + c[0] * res;
    const y = minY + c[1] * res;
    const z = minZ + c[2] * res;
    return flipXY ? [-x, -y, z] : [x, y, z];
};
for (let axis = 0; axis < 3; axis++) {
    const u = (axis + 1) % 3;
    const v = (axis + 2) % 3;
    for (const dir of [1, -1]) {
        const mask = new Uint8Array(dims[u] * dims[v]);
        for (let d = 0; d < dims[axis]; d++) {
            // faces on the side of slice d facing `dir`: solid here, empty beyond
            for (let j = 0; j < dims[v]; j++) {
                for (let i = 0; i < dims[u]; i++) {
                    const c = [0, 0, 0];
                    c[axis] = d;
                    c[u] = i;
                    c[v] = j;
                    const beyond = [...c];
                    beyond[axis] += dir;
                    mask[j * dims[u] + i] = solid(c) && !solid(beyond) ? 1 : 0;
                }
            }
            for (let j = 0; j < dims[v]; j++) {
                for (let i = 0; i < dims[u]; ) {
                    if (!mask[j * dims[u] + i]) {
                        i++;
                        continue;
                    }
                    let w = 1;
                    while (i + w < dims[u] && mask[j * dims[u] + i + w]) w++;
                    let h = 1;
                    grow: while (j + h < dims[v]) {
                        for (let k = 0; k < w; k++) if (!mask[(j + h) * dims[u] + i + k]) break grow;
                        h++;
                    }
                    for (let jj = 0; jj < h; jj++) for (let k = 0; k < w; k++) mask[(j + jj) * dims[u] + i + k] = 0;
                    // the rectangle's corners, on the face plane
                    const plane = dir > 0 ? d + 1 : d;
                    const corner = (a, b) => {
                        const c = [0, 0, 0];
                        c[axis] = plane;
                        c[u] = a;
                        c[v] = b;
                        return toWorld(c);
                    };
                    const base = positions.length / 3;
                    positions.push(...corner(i, j), ...corner(i + w, j), ...corner(i + w, j + h), ...corner(i, j + h));
                    // wound to face outward: counter-clockwise seen from `dir` (u × v is the axis);
                    // negating X and Y together is a turn, not a mirror, so it keeps the winding
                    if (dir > 0) indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
                    else indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
                    i += w;
                }
            }
        }
    }
}

// a minimal glTF 2.0 binary: one mesh, positions and 32-bit indices
const pos = new Float32Array(positions);
const idx = new Uint32Array(indices);
const lo = [Infinity, Infinity, Infinity];
const hi = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < pos.length; i += 3) {
    for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], pos[i + k]);
        hi[k] = Math.max(hi[k], pos[i + k]);
    }
}
const align4 = (n) => (n + 3) & ~3;
const posBytes = pos.byteLength;
const idxOffset = align4(posBytes);
const binLength = align4(idxOffset + idx.byteLength);
const gltf = {
    asset: { version: '2.0', generator: 'scanity voxel-to-glb' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'collision' }],
    meshes: [{ name: 'collision', primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 4 }] }],
    buffers: [{ byteLength: binLength }],
    bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: posBytes, target: 34962 },
        { buffer: 0, byteOffset: idxOffset, byteLength: idx.byteLength, target: 34963 }
    ],
    accessors: [
        { bufferView: 0, componentType: 5126, count: pos.length / 3, type: 'VEC3', min: lo, max: hi },
        { bufferView: 1, componentType: 5125, count: idx.length, type: 'SCALAR' }
    ]
};
const jsonChunk = Buffer.from(JSON.stringify(gltf));
const jsonPadded = Buffer.concat([jsonChunk, Buffer.alloc(align4(jsonChunk.length) - jsonChunk.length, 0x20)]);
const binChunk = Buffer.alloc(binLength);
Buffer.from(pos.buffer).copy(binChunk, 0);
Buffer.from(idx.buffer).copy(binChunk, idxOffset);
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonPadded.length + 8 + binChunk.length, 8);
const chunkHeader = (length, type) => {
    const h = Buffer.alloc(8);
    h.writeUInt32LE(length, 0);
    h.writeUInt32LE(type, 4);
    return h;
};
writeFileSync(outPath, Buffer.concat([header, chunkHeader(jsonPadded.length, 0x4e4f534a), jsonPadded, chunkHeader(binChunk.length, 0x004e4942), binChunk]));

console.log(
    `${nx}×${ny}×${nz} voxels of ${res} m, ${solidCount} solid → ${idx.length / 3} triangles` +
        ` (${(12 + 8 + jsonPadded.length + 8 + binChunk.length) / 1024 | 0} kB), bounds` +
        ` [${lo.map((n) => n.toFixed(2))}] – [${hi.map((n) => n.toFixed(2))}]${flipXY ? ', X/Y un-negated (v1.0)' : ''}`
);
