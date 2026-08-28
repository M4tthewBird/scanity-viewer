// Shader sources for the mirror portals feature. Ported from the Splat Portal
// Mirror Tool (https://portalmirror.atlux.one, MIT), simplified to mirrors
// only (no window/HDRI portals, no selection rim — this is a runtime viewer,
// not an authoring tool) and written for both GLSL (WebGL) and WGSL (WebGPU),
// since this viewer defaults to WebGPU and the reference tool only ever
// targeted WebGL.
//
// Mirror data texture layout (RGBA32F, MAX_MIRRORS columns x MDATA_ROWS rows,
// packed once per frame in mirror-portals.ts and sampled here to carve a hole
// through the splats around each mirror):
//   rows 0-3: the 4 columns of the mirror's world -> local inverse matrix
//   row 4:    (shape [0=circle,1=rect,2=capsule], radius, capHalfHeight, enabled)
//   row 5:    (cullHalfThickness, cullOffset, unused, unused)
//   row 6:    the mirror's world-space plane (normal.xyz, d)
export const MAX_MIRRORS = 8;
export const MIRROR_DATA_ROWS = 7;

// A thin soft-edged slab is carved out of the splats along each mirror's
// local Z (its normal) between cullFront and cullBack, so the portal mesh has
// a clean hole to sit in instead of splats poking through it.
const CULL_SOFT = 0.01;

export const MIRROR_CULL_GLSL = `
#define MAX_MIRRORS ${MAX_MIRRORS}
#define MIRROR_ROWS ${MIRROR_DATA_ROWS}.0

uniform sampler2D uMirrorData;
uniform float uMirrorCount;
uniform vec3 uMainCamPos;
uniform vec3 view_position;

float gMirrorKeep = 1.0;

vec4 mirrorTexel(float col, float row) {
    return texture2D(uMirrorData, vec2((col + 0.5) / float(MAX_MIRRORS), (row + 0.5) / MIRROR_ROWS));
}

float mirrorHoleKeep(float i, vec3 worldCenter) {
    vec4 shapeParams = mirrorTexel(i, 4.0);
    if (shapeParams.w < 0.5) {
        return 1.0;
    }
    mat4 inv = mat4(mirrorTexel(i, 0.0), mirrorTexel(i, 1.0), mirrorTexel(i, 2.0), mirrorTexel(i, 3.0));
    vec4 slabParams = mirrorTexel(i, 5.0);
    vec3 p = (inv * vec4(worldCenter, 1.0)).xyz;
    float dz = abs(p.z - slabParams.y);
    float slab = 1.0 - smoothstep(slabParams.x, slabParams.x + ${CULL_SOFT}, dz);
    if (slab <= 0.0) {
        return 1.0;
    }
    float shape = shapeParams.x;
    float r = shapeParams.y;
    float capHalf = shapeParams.z;
    float radial;
    if (shape > 0.5 && shape < 1.5) {
        float insideBox = step(abs(p.x), r) * step(abs(p.y), capHalf);
        return 1.0 - slab * insideBox;
    }
    if (shape > 1.5) {
        float qy = clamp(p.y, -capHalf, capHalf);
        radial = length(vec2(p.x, p.y - qy));
    } else {
        radial = length(p.xy);
    }
    float inside = 1.0 - smoothstep(r - ${CULL_SOFT}, r, radial);
    return 1.0 - slab * inside;
}

// During a reflection camera's own render pass (identified below), discard
// anything on the far side of the mirror it's reflecting - otherwise the
// reflected eye position (mirrored across the mirror's plane) can land near
// or inside completely different geometry - another room, the far side of
// the same wall - and that leaks into the reflection instead of whatever's
// actually in front of the mirror.
float reflectionClipKeep(vec3 center) {
    float best = -1.0;
    float bestD = 1e9;
    for (int i = 0; i < MAX_MIRRORS; i++) {
        if (float(i) >= uMirrorCount) {
            break;
        }
        vec4 shapeParams = mirrorTexel(float(i), 4.0);
        if (shapeParams.w < 0.5) {
            continue;
        }
        vec4 plane = mirrorTexel(float(i), 6.0);
        float dMain = dot(plane.xyz, uMainCamPos) + plane.w;
        vec3 reflectedCamPos = uMainCamPos - 2.0 * dMain * plane.xyz;
        float d = distance(reflectedCamPos, view_position);
        if (d < bestD) {
            bestD = d;
            best = float(i);
        }
    }
    // A reflection camera sits exactly at its mirror's reflected-camera
    // position (bestD ~ 0) but far from the main camera; the main camera's
    // own pass matches no mirror's reflected position at all, so it never
    // clips regardless of where it stands relative to any mirror.
    float distToMain = distance(view_position, uMainCamPos);
    if (best < 0.0 || bestD >= distToMain) {
        return 1.0;
    }
    vec4 plane = mirrorTexel(best, 6.0);
    float side = dot(plane.xyz, center) + plane.w;
    return step(0.0, side);
}

void modifySplatCenter(inout vec3 center) {
    float keep = 1.0;
    for (int i = 0; i < MAX_MIRRORS; i++) {
        if (float(i) >= uMirrorCount) {
            break;
        }
        keep *= mirrorHoleKeep(float(i), center);
    }
    keep *= reflectionClipKeep(center);
    gMirrorKeep = keep;
}

void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {
    scale *= gMirrorKeep;
}

void modifySplatColor(vec3 center, inout vec4 color) {
    color.a *= gMirrorKeep;
}
`;

// Same logic as MIRROR_CULL_GLSL, translated to WGSL. Notable differences:
// inout params become ptr<function, T> with (*x) dereference; textures need a
// separate sampler; texture sampling inside a vertex-stage function must use
// textureSampleLevel (textureSample is fragment-stage only in WGSL); and
// gMirrorKeep needs an explicit var<private> declaration for per-invocation
// mutable state (WGSL has no implicit globals).
export const MIRROR_CULL_WGSL = `
const MIRROR_MAX: i32 = ${MAX_MIRRORS};
const MIRROR_ROWS: f32 = ${MIRROR_DATA_ROWS}.0;
const MIRROR_CULL_SOFT: f32 = ${CULL_SOFT};

var uMirrorData: texture_2d<f32>;
var uMirrorDataSampler: sampler;
uniform uMirrorCount: f32;
uniform uMainCamPos: vec3f;
uniform view_position: vec3f;

var<private> gMirrorKeep: f32 = 1.0;

fn mirrorTexel(col: f32, row: f32) -> vec4f {
    let uv = vec2f((col + 0.5) / f32(MIRROR_MAX), (row + 0.5) / MIRROR_ROWS);
    return textureSampleLevel(uMirrorData, uMirrorDataSampler, uv, 0.0);
}

fn mirrorHoleKeep(i: f32, worldCenter: vec3f) -> f32 {
    let shapeParams = mirrorTexel(i, 4.0);
    if (shapeParams.w < 0.5) {
        return 1.0;
    }
    let inv = mat4x4<f32>(mirrorTexel(i, 0.0), mirrorTexel(i, 1.0), mirrorTexel(i, 2.0), mirrorTexel(i, 3.0));
    let slabParams = mirrorTexel(i, 5.0);
    let p = (inv * vec4f(worldCenter, 1.0)).xyz;
    let dz = abs(p.z - slabParams.y);
    let slab = 1.0 - smoothstep(slabParams.x, slabParams.x + MIRROR_CULL_SOFT, dz);
    if (slab <= 0.0) {
        return 1.0;
    }
    let shape = shapeParams.x;
    let r = shapeParams.y;
    let capHalf = shapeParams.z;
    var radial: f32;
    if (shape > 0.5 && shape < 1.5) {
        let insideBox = step(abs(p.x), r) * step(abs(p.y), capHalf);
        return 1.0 - slab * insideBox;
    }
    if (shape > 1.5) {
        let qy = clamp(p.y, -capHalf, capHalf);
        radial = length(vec2f(p.x, p.y - qy));
    } else {
        radial = length(p.xy);
    }
    let inside = 1.0 - smoothstep(r - MIRROR_CULL_SOFT, r, radial);
    return 1.0 - slab * inside;
}

// During a reflection camera's own render pass (identified below), discard
// anything on the far side of the mirror it's reflecting - otherwise the
// reflected eye position (mirrored across the mirror's plane) can land near
// or inside completely different geometry - another room, the far side of
// the same wall - and that leaks into the reflection instead of whatever's
// actually in front of the mirror.
fn reflectionClipKeep(center: vec3f) -> f32 {
    var best: f32 = -1.0;
    var bestD: f32 = 1e9;
    for (var i: i32 = 0; i < MIRROR_MAX; i++) {
        if (f32(i) >= uniform.uMirrorCount) {
            break;
        }
        let shapeParams = mirrorTexel(f32(i), 4.0);
        if (shapeParams.w < 0.5) {
            continue;
        }
        let plane = mirrorTexel(f32(i), 6.0);
        let dMain = dot(plane.xyz, uniform.uMainCamPos) + plane.w;
        let reflectedCamPos = uniform.uMainCamPos - 2.0 * dMain * plane.xyz;
        let d = distance(reflectedCamPos, uniform.view_position);
        if (d < bestD) {
            bestD = d;
            best = f32(i);
        }
    }
    // A reflection camera sits exactly at its mirror's reflected-camera
    // position (bestD ~ 0) but far from the main camera; the main camera's
    // own pass matches no mirror's reflected position at all, so it never
    // clips regardless of where it stands relative to any mirror.
    let distToMain = distance(uniform.view_position, uniform.uMainCamPos);
    if (best < 0.0 || bestD >= distToMain) {
        return 1.0;
    }
    let plane = mirrorTexel(best, 6.0);
    let side = dot(plane.xyz, center) + plane.w;
    return step(0.0, side);
}

fn modifySplatCenter(center: ptr<function, vec3f>) {
    var keep: f32 = 1.0;
    for (var i: i32 = 0; i < MIRROR_MAX; i++) {
        if (f32(i) >= uniform.uMirrorCount) {
            break;
        }
        keep = keep * mirrorHoleKeep(f32(i), *center);
    }
    keep = keep * reflectionClipKeep(*center);
    gMirrorKeep = keep;
}

fn modifySplatRotationScale(originalCenter: vec3f, modifiedCenter: vec3f, rotation: ptr<function, vec4f>, scale: ptr<function, vec3f>) {
    (*scale) = (*scale) * gMirrorKeep;
}

fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>) {
    (*color).a = (*color).a * gMirrorKeep;
}
`;

// The mirror surface itself: samples the reflection render target via a
// projective texture matrix (bias * reflectionProj * reflectionView * model),
// computed per frame in mirror-portals.ts. No lighting, no rim highlight —
// just the reflection, dimmed slightly to sell it as a surface rather than a
// hole into another room.
export const MIRROR_SURFACE_VERTEX_GLSL = `
attribute vec3 aPosition;
uniform mat4 matrix_model;
uniform mat4 matrix_viewProjection;
uniform mat4 uTextureMatrix;
varying vec4 vProjCoord;
void main(void) {
    vec4 worldPos = matrix_model * vec4(aPosition, 1.0);
    vProjCoord = uTextureMatrix * vec4(aPosition, 1.0);
    gl_Position = matrix_viewProjection * worldPos;
}
`;

export const MIRROR_SURFACE_FRAGMENT_GLSL = `
uniform sampler2D uReflectionTex;
uniform float uReflectivity;
varying vec4 vProjCoord;
void main(void) {
    vec4 refl = texture2DProj(uReflectionTex, vProjCoord);
    gl_FragColor = vec4(refl.rgb * uReflectivity, 1.0);
}
`;

export const MIRROR_SURFACE_VERTEX_WGSL = `
attribute aPosition: vec3f;
uniform matrix_model: mat4x4f;
uniform matrix_viewProjection: mat4x4f;
uniform uTextureMatrix: mat4x4f;
varying vProjCoord: vec4f;
@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    let worldPos = uniform.matrix_model * vec4f(input.aPosition, 1.0);
    output.vProjCoord = uniform.uTextureMatrix * vec4f(input.aPosition, 1.0);
    output.position = uniform.matrix_viewProjection * worldPos;
    return output;
}
`;

// WGSL has no texture2DProj equivalent, so the perspective divide is explicit.
export const MIRROR_SURFACE_FRAGMENT_WGSL = `
var uReflectionTex: texture_2d<f32>;
var uReflectionTexSampler: sampler;
uniform uReflectivity: f32;
varying vProjCoord: vec4f;
@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    let proj = input.vProjCoord.xy / input.vProjCoord.w;
    let refl = textureSample(uReflectionTex, uReflectionTexSampler, proj);
    output.color = vec4f(refl.rgb * uniform.uReflectivity, 1.0);
    return output;
}
`;
