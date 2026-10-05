// Shader sources for the mirror portals feature, copied from the Splat Portal
// Mirror Tool (https://portalmirror.atlux.one, MIT - see
// /splat-portal-mirror-tool): the splat cull chunk (CULL_GLSL) and the mirror
// surface material (mirrorMaterial) with the same uniforms, data layout and
// maths. Removed only what is editor UI (selection highlight, gold rim) or
// window-portal specific. Each shader also has a WGSL translation, since this
// viewer defaults to WebGPU and the tool only ever targeted WebGL.
//
// Mirror data texture layout (RGBA32F, MAX_MIRRORS columns x MIRROR_DATA_ROWS
// rows, packed once per frame in mirror-portals.ts), identical to the tool's:
//   rows 0-3: the 4 columns of the mirror's world -> local inverse matrix
//   row 4:    the mirror's world-space plane (normal.xyz, d)
//   row 5:    (shape [0=circle,1=rect,2=capsule], r, capHalf, enabled)
//   row 6:    (halfT, offset, -, -)
export const MAX_MIRRORS = 8;
export const MIRROR_DATA_ROWS = 7;
export const CULL_SOFT = 0.01;

// Multi-mirror via the mirror data texture. Every enabled mirror carves its
// hole in every pass; during a reflection pass we clip splats behind whichever
// mirror this camera reflects. The reflecting mirror is identified by matching
// reflect(uMainCamPos, plane_i) against the engine-set per-camera view_position
// (nearest match), gated by the camera-side sign so the main view (in front of
// every mirror) never clips.
export const MIRROR_CULL_GLSL = `
#define MAXM ${MAX_MIRRORS}
#define MROWS ${MIRROR_DATA_ROWS}.0
uniform sampler2D uMirrorData;
uniform float uMirrorCount;
uniform float uCullEnabled;
uniform float uCullSoft;
uniform float uReflClipEnabled;
uniform vec3  uMainCamPos;   // main camera world position
uniform vec3  view_position; // engine-set per-camera world position

float gKeep = 1.0;

vec4 fetchM(float col, float row) {
    return texture2D(uMirrorData, vec2((col + 0.5) / float(MAXM), (row + 0.5) / MROWS));
}
mat4 mInv(float i)  { return mat4(fetchM(i, 0.0), fetchM(i, 1.0), fetchM(i, 2.0), fetchM(i, 3.0)); }
vec4 mPlane(float i){ return fetchM(i, 4.0); }
vec4 mParA(float i) { return fetchM(i, 5.0); }   // shape, r, capHalf, enabled
vec4 mParB(float i) { return fetchM(i, 6.0); }   // halfT, offset, -, -

// keep factor for one mirror's hole (1 = keep, 0 = removed)
float holeKeep(float i, vec3 worldCenter) {
    vec4 pa = mParA(i);
    if (pa.w < 0.5) { return 1.0; }               // disabled
    vec4 pb = mParB(i);
    vec3 p = (mInv(i) * vec4(worldCenter, 1.0)).xyz;
    float dz = abs(p.z - pb.y);                   // offset
    float slab = 1.0 - smoothstep(pb.x, pb.x + uCullSoft + 1e-5, dz);   // halfT
    if (slab <= 0.0) { return 1.0; }
    float shape = pa.x, r = pa.y, capHalf = pa.z;
    if (shape > 0.5 && shape < 1.5) {             // rect: box test in local XY
        float insideBox = step(abs(p.x), r) * step(abs(p.y), capHalf);
        return 1.0 - slab * insideBox;
    }
    float radial;
    if (shape > 1.5) {                            // capsule (stadium)
        float qy = clamp(p.y, -capHalf, capHalf);
        radial = length(vec2(p.x, p.y - qy));
    } else {                                      // circle
        radial = length(p.xy);
    }
    float inside = 1.0 - smoothstep(r - uCullSoft - 1e-5, r, radial);
    return 1.0 - slab * inside;
}

void modifySplatCenter(inout vec3 center) {
    float k = 1.0;
    if (uCullEnabled > 0.5) {
        for (int i = 0; i < MAXM; i++) {
            if (float(i) >= uMirrorCount) { break; }
            k *= holeKeep(float(i), center);
        }
    }
    if (uReflClipEnabled > 0.5) {
        // nearest reflected-cam match picks this pass's mirror; the side sign gates it
        float best = -1.0;
        float bestD = 1e9;
        for (int i = 0; i < MAXM; i++) {
            if (float(i) >= uMirrorCount) { break; }
            float fi = float(i);
            vec4 pa = mParA(fi);
            if (pa.w < 0.5) { continue; }
            vec4 pl = mPlane(fi);
            float dM = dot(pl.xyz, uMainCamPos) + pl.w;
            vec3 reflCam = uMainCamPos - 2.0 * dM * pl.xyz;
            float d = distance(reflCam, view_position);
            if (d < bestD) { bestD = d; best = fi; }
        }
        // Distinguish a reflection pass from the main view: a reflection camera sits
        // exactly at reflect(mainCam, its plane), so its view_position matches a
        // reflected-cam (bestD ~ 0) yet is far from the main camera. The main camera's
        // view_position equals uMainCamPos (distToMain ~ 0) and matches no reflected-cam,
        // so it never clips - no matter where it roams relative to the mirrors.
        float distToMain = distance(view_position, uMainCamPos);
        if (best >= 0.0 && bestD < distToMain) {
            vec4 pl = mPlane(best);
            float sd = dot(pl.xyz, center) + pl.w;   // < 0 -> splat behind this mirror
            k *= step(0.0, sd);
        }
    }
    gKeep = k;
}
void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {
    scale *= gKeep;
}
void modifySplatColor(vec3 center, inout vec4 color) {
    color.a *= gKeep;
}
`;

// Same logic as MIRROR_CULL_GLSL, translated to WGSL. Notable differences:
// inout params become ptr<function, T> with (*x) dereference; textures need a
// separate sampler; texture sampling inside a vertex-stage function must use
// textureSampleLevel (textureSample is fragment-stage only in WGSL); and gKeep
// needs an explicit var<private> declaration for per-invocation mutable state.
export const MIRROR_CULL_WGSL = `
const MAXM: i32 = ${MAX_MIRRORS};
const MROWS: f32 = ${MIRROR_DATA_ROWS}.0;

var uMirrorData: texture_2d<f32>;
var uMirrorDataSampler: sampler;
uniform uMirrorCount: f32;
uniform uCullEnabled: f32;
uniform uCullSoft: f32;
uniform uReflClipEnabled: f32;
uniform uMainCamPos: vec3f;   // main camera world position
uniform view_position: vec3f; // engine-set per-camera world position

var<private> gKeep: f32 = 1.0;

fn fetchM(col: f32, row: f32) -> vec4f {
    let uv = vec2f((col + 0.5) / f32(MAXM), (row + 0.5) / MROWS);
    return textureSampleLevel(uMirrorData, uMirrorDataSampler, uv, 0.0);
}
fn mInv(i: f32) -> mat4x4f { return mat4x4f(fetchM(i, 0.0), fetchM(i, 1.0), fetchM(i, 2.0), fetchM(i, 3.0)); }
fn mPlane(i: f32) -> vec4f { return fetchM(i, 4.0); }
fn mParA(i: f32) -> vec4f { return fetchM(i, 5.0); }   // shape, r, capHalf, enabled
fn mParB(i: f32) -> vec4f { return fetchM(i, 6.0); }   // halfT, offset, -, -

// keep factor for one mirror's hole (1 = keep, 0 = removed)
fn holeKeep(i: f32, worldCenter: vec3f) -> f32 {
    let pa = mParA(i);
    if (pa.w < 0.5) { return 1.0; }               // disabled
    let pb = mParB(i);
    let p = (mInv(i) * vec4f(worldCenter, 1.0)).xyz;
    let dz = abs(p.z - pb.y);                     // offset
    let slab = 1.0 - smoothstep(pb.x, pb.x + uniform.uCullSoft + 1e-5, dz);   // halfT
    if (slab <= 0.0) { return 1.0; }
    let shape = pa.x;
    let r = pa.y;
    let capHalf = pa.z;
    if (shape > 0.5 && shape < 1.5) {             // rect: box test in local XY
        let insideBox = step(abs(p.x), r) * step(abs(p.y), capHalf);
        return 1.0 - slab * insideBox;
    }
    var radial: f32;
    if (shape > 1.5) {                            // capsule (stadium)
        let qy = clamp(p.y, -capHalf, capHalf);
        radial = length(vec2f(p.x, p.y - qy));
    } else {                                      // circle
        radial = length(p.xy);
    }
    let inside = 1.0 - smoothstep(r - uniform.uCullSoft - 1e-5, r, radial);
    return 1.0 - slab * inside;
}

fn modifySplatCenter(center: ptr<function, vec3f>) {
    var k: f32 = 1.0;
    if (uniform.uCullEnabled > 0.5) {
        for (var i: i32 = 0; i < MAXM; i++) {
            if (f32(i) >= uniform.uMirrorCount) { break; }
            k = k * holeKeep(f32(i), *center);
        }
    }
    if (uniform.uReflClipEnabled > 0.5) {
        // nearest reflected-cam match picks this pass's mirror; the side sign gates it
        var best: f32 = -1.0;
        var bestD: f32 = 1e9;
        for (var i: i32 = 0; i < MAXM; i++) {
            if (f32(i) >= uniform.uMirrorCount) { break; }
            let fi = f32(i);
            let pa = mParA(fi);
            if (pa.w < 0.5) { continue; }
            let pl = mPlane(fi);
            let dM = dot(pl.xyz, uniform.uMainCamPos) + pl.w;
            let reflCam = uniform.uMainCamPos - 2.0 * dM * pl.xyz;
            let d = distance(reflCam, uniform.view_position);
            if (d < bestD) { bestD = d; best = fi; }
        }
        // see the GLSL version for why this tells a reflection pass from the main view
        let distToMain = distance(uniform.view_position, uniform.uMainCamPos);
        if (best >= 0.0 && bestD < distToMain) {
            let pl = mPlane(best);
            let sd = dot(pl.xyz, *center) + pl.w;   // < 0 -> splat behind this mirror
            k = k * step(0.0, sd);
        }
    }
    gKeep = k;
}
fn modifySplatRotationScale(originalCenter: vec3f, modifiedCenter: vec3f, rotation: ptr<function, vec4f>, scale: ptr<function, vec3f>) {
    (*scale) = (*scale) * gKeep;
}
fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>) {
    (*color).a = (*color).a * gKeep;
}
`;

// The mirror surface: samples its reflection render target through a
// projective texture matrix (bias * reflectionProj * reflectionView * model,
// computed per frame in mirror-portals.ts) and composites it over the
// environment by the target's alpha (= splat coverage). The tool's environment
// is its HDRI, which defaults to off = black; this viewer has no HDRI, so
// uEnvColor stands in for it and stays black, matching that default. A mirror
// that is not reflecting this frame shows a dim flat tint so it still reads.
export const MIRROR_SURFACE_VERTEX_GLSL = `
attribute vec3 aPosition;
uniform mat4 matrix_model;
uniform mat4 matrix_viewProjection;
uniform mat4 textureMatrix;
varying vec4 vProj;
void main() {
    vec4 wp = matrix_model * vec4(aPosition, 1.0);
    vProj = textureMatrix * vec4(aPosition, 1.0);
    gl_Position = matrix_viewProjection * wp;
}
`;

export const MIRROR_SURFACE_FRAGMENT_GLSL = `
uniform sampler2D tReflect;
uniform float reflectivity;
uniform vec3 tint;
uniform float reflectOn;   // 1 = live reflection, 0 = flat placeholder
uniform vec3 uEnvColor;
varying vec4 vProj;
void main() {
    vec3 col;
    if (reflectOn > 0.5) {
        vec4 refl = texture2DProj(tReflect, vProj);
        col = mix(uEnvColor, refl.rgb, clamp(refl.a, 0.0, 1.0)) * reflectivity * tint;
    } else {
        col = tint * 0.14;                       // dim flat so an inactive mirror still reads
    }
    gl_FragColor = vec4(col, 1.0);
}
`;

export const MIRROR_SURFACE_VERTEX_WGSL = `
attribute aPosition: vec3f;
uniform matrix_model: mat4x4f;
uniform matrix_viewProjection: mat4x4f;
uniform textureMatrix: mat4x4f;
varying vProj: vec4f;
@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    let wp = uniform.matrix_model * vec4f(input.aPosition, 1.0);
    output.vProj = uniform.textureMatrix * vec4f(input.aPosition, 1.0);
    output.position = uniform.matrix_viewProjection * wp;
    return output;
}
`;

// WGSL has no texture2DProj, so the perspective divide is explicit. WebGPU
// also stores a render target with row 0 at the top where WebGL has it at the
// bottom, so the same texture matrix lands upside down unless V is flipped
// here. The flip belongs at this sampling step, not on the render target
// (RenderTarget flipY): that option also flips the reflection camera's own
// projection, which the gsplat renderer feeds into its sorting and splat
// footprint maths, and it distorted the reflected splats.
export const MIRROR_SURFACE_FRAGMENT_WGSL = `
var tReflect: texture_2d<f32>;
var tReflectSampler: sampler;
uniform reflectivity: f32;
uniform tint: vec3f;
uniform reflectOn: f32;   // 1 = live reflection, 0 = flat placeholder
uniform uEnvColor: vec3f;
varying vProj: vec4f;
@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    let uv = input.vProj.xy / input.vProj.w;
    let refl = textureSample(tReflect, tReflectSampler, vec2f(uv.x, 1.0 - uv.y));
    var col: vec3f;
    if (uniform.reflectOn > 0.5) {
        col = mix(uniform.uEnvColor, refl.rgb, clamp(refl.a, 0.0, 1.0)) * uniform.reflectivity * uniform.tint;
    } else {
        col = uniform.tint * 0.14;               // dim flat so an inactive mirror still reads
    }
    output.color = vec4f(col, 1.0);
    return output;
}
`;
