// Live-reflecting mirror portals, driven by a static mirrors.json (see
// /splat-portal-mirror-tool's "Export mirrors.json" button). No editing, no
// placement UI - this is the runtime playback half only; portals are placed
// offline in that tool and simply reproduced here at the exact saved
// transform.
//
// The mirror code is copied from the Splat Portal Mirror Tool
// (https://portalmirror.atlux.one, MIT): makeRT, createMirror,
// updateMirrorCamera, mirrorInView and the per-frame "prerender" packing of the
// mirror data texture, with the same maths and the same order of operations.
// Each mirror gets a hidden reflection camera + render target, posed every
// frame by reflecting the main camera across the mirror's plane, and a custom
// gsplatModifyVS chunk carves a hole through the splats around every mirror.
//
// What differs from the tool, and why:
//   - Loaded from mirrors.json, and moved into this viewer's world frame (see
//     ORIENTATION_CORRECTION).
//   - The reflection cameras copy the main camera's lens settings every frame,
//     not once at creation. The tool's camera never changes them; this
//     viewer's does (fov, horizontalFov on landscape screens), and a
//     reflection camera left on stale values renders with a different lens
//     than the texture matrix projects with, which shifts, scales and smears
//     the reflection on the mirror.
//   - Clip planes are the one lens setting NOT copied: see fitReflectionClip.
//   - Shaders also have WGSL versions for WebGPU (see shaders.ts).
//   - Mirrors only: no window portals, HDRI, selection or gizmo.
import {
    BoundingSphere,
    Color,
    Entity,
    Frustum,
    Layer,
    Mat4,
    Mesh,
    MeshInstance,
    Quat,
    RenderTarget,
    ShaderMaterial,
    Texture,
    Vec3,
    ADDRESS_CLAMP_TO_EDGE,
    CULLFACE_NONE,
    FILTER_LINEAR,
    FILTER_NEAREST,
    PIXELFORMAT_RGBA32F,
    PIXELFORMAT_RGBA8,
    PRIMITIVE_TRIANGLES,
    SEMANTIC_POSITION
} from 'playcanvas';
import type { AppBase, BoundingBox, CameraComponent, GraphicsDevice } from 'playcanvas';

import {
    CULL_SOFT,
    MAX_MIRRORS,
    MIRROR_DATA_ROWS,
    MIRROR_CULL_GLSL,
    MIRROR_CULL_WGSL,
    MIRROR_SURFACE_VERTEX_GLSL,
    MIRROR_SURFACE_FRAGMENT_GLSL,
    MIRROR_SURFACE_VERTEX_WGSL,
    MIRROR_SURFACE_FRAGMENT_WGSL
} from './shaders';
import type { MirrorConfig } from './types';

// Fetches and lightly validates a mirrors.json. Deliberately not a full
// schema validator (unlike settings.json) - this file is written by our own
// export tool, not authored by hand, so a coarse shape check is enough to
// avoid crashing on a stale/malformed export rather than to guard against
// arbitrary input.
const loadMirrors = async (url: string): Promise<MirrorConfig[]> => {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch mirrors.json: ${response.status}`);
    }
    const data = await response.json();
    const mirrors = Array.isArray(data?.mirrors) ? data.mirrors : [];
    return mirrors.filter(
        (m: unknown): m is MirrorConfig =>
            !!m &&
            typeof m === 'object' &&
            Array.isArray((m as MirrorConfig).position) &&
            Array.isArray((m as MirrorConfig).rotation) &&
            typeof (m as MirrorConfig).radius === 'number'
    );
};

// Tool defaults for every mirror (its MIRRORS table / buildPortalsFromData).
const REFLECTIVITY = 0.95;
const TINT = [0.97, 0.98, 1.0];

// Shape codes shared by JS and the cull shader.
const SHAPE: Record<string, number> = { circle: 0, rect: 1, capsule: 2 };

// The tool's reflection clear colour: its background, fully transparent, so
// splat coverage ends up in alpha and the surface shader can composite it
// over the environment.
const BG0 = new Color(0x0a / 255, 0x0b / 255, 0x0e / 255, 0);

// The tool's environment behind reflected splats: its HDRI, off by default,
// which reads as black.
const ENV_COLOR = [0, 0, 0];

const BIAS = new Mat4().set([0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0.5, 0, 0.5, 0.5, 0.5, 1]);

// mirrors.json stores world-space position/rotation from the authoring tool,
// whose scene flips the loaded splat 180° about X (`setEulerAngles(180, 0, 0)`
// in portal-mirror.html) to right it. This viewer instead flips the same raw
// splat 180° about Z (index.ts's `setLocalEulerAngles(0, 0, 180)`) - a
// different orientation of the identical source data. The two flips differ by
// a 180° rotation about Y (Rz180 = Ry180 * Rx180), so every mirror transform
// needs that same Y-180 correction applied on load to line back up with the
// splat geometry. Scale is untouched: a Y-180 flip only negates the X/Z axes,
// it never swaps them, so per-axis scale stays paired with the same local axis.
const ORIENTATION_CORRECTION = new Quat(0, 1, 0, 0);

// Local-plane half-extents for a shape: r (radius / rect half-width / cap radius)
// and extent (rect half-height / capsule straight half-height; 0 for circle).
// Note: for a rect, cfg.radius is the FULL width and cfg.height the FULL height.
const mirrorDims = (cfg: MirrorConfig) => {
    if (cfg.shape === 'rect') {
        return { r: cfg.radius / 2, extent: (cfg.height ?? cfg.radius) / 2 };
    }
    if (cfg.shape === 'capsule') {
        return { r: cfg.radius, extent: Math.max((cfg.height ?? cfg.radius * 2) / 2 - cfg.radius, 0) };
    }
    return { r: cfg.radius, extent: 0 };
};

// Build a flat mesh from a 2D outline on the mirror's local XY plane (z=0).
const outlineMesh = (device: GraphicsDevice, cfg: MirrorConfig): Mesh => {
    const { r, extent } = mirrorDims(cfg);
    const mesh = new Mesh(device);

    if (cfg.shape === 'rect') {
        mesh.setPositions([-r, -extent, 0, r, -extent, 0, r, extent, 0, -r, extent, 0]);
        mesh.setIndices([0, 1, 2, 0, 2, 3]);
        mesh.update(PRIMITIVE_TRIANGLES);
        return mesh;
    }

    const pts: [number, number][] = [];
    if (cfg.shape === 'capsule') {
        const seg = 24;
        for (let i = 0; i <= seg; i++) {
            const a = (i / seg) * Math.PI;
            pts.push([Math.cos(a) * r, extent + Math.sin(a) * r]); // top cap
        }
        for (let i = 0; i <= seg; i++) {
            const a = Math.PI + (i / seg) * Math.PI;
            pts.push([Math.cos(a) * r, -extent + Math.sin(a) * r]); // bottom cap
        }
    } else {
        const seg = 96;
        for (let i = 0; i < seg; i++) {
            const a = (i / seg) * Math.PI * 2;
            pts.push([Math.cos(a) * r, Math.sin(a) * r]);
        }
    }
    const positions = [0, 0, 0]; // center vertex for the fan
    for (const [x, y] of pts) {
        positions.push(x, y, 0);
    }
    const indices: number[] = [];
    for (let i = 0; i < pts.length; i++) {
        indices.push(0, 1 + i, 1 + ((i + 1) % pts.length));
    }
    mesh.setPositions(positions);
    mesh.setIndices(indices);
    mesh.update(PRIMITIVE_TRIANGLES);
    return mesh;
};

const mirrorMaterial = (): ShaderMaterial => {
    const mat = new ShaderMaterial({
        uniqueName: `mirrorProjective_${Math.random().toString(36).slice(2)}`,
        attributes: { aPosition: SEMANTIC_POSITION },
        vertexGLSL: MIRROR_SURFACE_VERTEX_GLSL,
        fragmentGLSL: MIRROR_SURFACE_FRAGMENT_GLSL,
        vertexWGSL: MIRROR_SURFACE_VERTEX_WGSL,
        fragmentWGSL: MIRROR_SURFACE_FRAGMENT_WGSL
    });
    mat.cull = CULLFACE_NONE;
    mat.setParameter('reflectivity', REFLECTIVITY);
    mat.setParameter('tint', TINT);
    mat.setParameter('reflectOn', 0);
    mat.setParameter('uEnvColor', ENV_COLOR);
    return mat;
};

// Reflection render target at canvas size (the tool's REFLECTION_SCALE = 1).
// No flipY - see MIRROR_SURFACE_FRAGMENT_WGSL for how WebGPU is handled.
const makeRT = (device: GraphicsDevice): RenderTarget => {
    const colorBuffer = new Texture(device, {
        width: Math.max(1, Math.floor(device.width)),
        height: Math.max(1, Math.floor(device.height)),
        format: PIXELFORMAT_RGBA8,
        mipmaps: false,
        minFilter: FILTER_LINEAR,
        magFilter: FILTER_LINEAR,
        addressU: ADDRESS_CLAMP_TO_EDGE,
        addressV: ADDRESS_CLAMP_TO_EDGE
    });
    return new RenderTarget({ colorBuffer, depth: true, samples: 1 });
};

// r = v - 2(v.n)n
const reflectVec = (out: Vec3, v: Vec3, n: Vec3) => {
    const d = 2 * v.dot(n);
    out.set(v.x - d * n.x, v.y - d * n.y, v.z - d * n.z);
    return out;
};

type Mirror = {
    config: MirrorConfig;
    ent: Entity;
    mi: MeshInstance;
    mat: ShaderMaterial;
    rt: RenderTarget;
    reflCam: Entity;
    texMatrix: Mat4;
    facing: boolean;
    cullFront: number;
    cullBack: number;
};

// Scratch objects, shared across frames like the tool's module-level ones.
const _rPos = new Vec3();
const _cPos = new Vec3();
const _n = new Vec3();
const _view = new Vec3();
const _look = new Vec3();
const _tgt = new Vec3();
const _up = new Vec3();
const _r = new Vec3();
const _fit = new Vec3();
const _proj = new Mat4();
const _viewMat = new Mat4();
const _inv = new Mat4();
const _frCamInv = new Mat4();
const _frVP = new Mat4();
const _frustum = new Frustum();
const _frSphere = new BoundingSphere();

class MirrorPortals {
    private app: AppBase;

    private camEnt: Entity;

    // The scene's bounds, which the reflection cameras fit their clip planes to.
    private sceneBound: BoundingBox;

    private mirrorLayer: Layer;

    private mirrors: Mirror[] = [];

    // Mirror data texture: packs every mirror's world->local inverse matrix,
    // world plane, shape and cull params into an RGBA32F texture the gsplat
    // modify chunk samples. Uniform arrays do not reach the unified gsplat
    // draw, but textures do, so this is how N mirrors are fed at once.
    private mirrorDataTex: Texture;

    private mdataArr: Float32Array;

    private cullInstallTries = 0;

    private cullReady = false;

    private resizeHandler = () => this.rebuildReflectionRTs();

    constructor(app: AppBase, camera: Entity, configs: MirrorConfig[], sceneBound: BoundingBox) {
        this.app = app;
        this.camEnt = camera;
        this.sceneBound = sceneBound;

        const { graphicsDevice } = app;

        this.mirrorDataTex = new Texture(graphicsDevice, {
            name: 'mirrorData',
            width: MAX_MIRRORS,
            height: MIRROR_DATA_ROWS,
            format: PIXELFORMAT_RGBA32F,
            mipmaps: false,
            minFilter: FILTER_NEAREST,
            magFilter: FILTER_NEAREST,
            addressU: ADDRESS_CLAMP_TO_EDGE,
            addressV: ADDRESS_CLAMP_TO_EDGE
        });
        this.mdataArr = new Float32Array(MAX_MIRRORS * MIRROR_DATA_ROWS * 4);
        // write into mdataArr, then upload()
        (this.mirrorDataTex as unknown as { _levels: Float32Array[] })._levels[0] = this.mdataArr;

        // Dedicated layer for the mirror surfaces so the reflection cameras can
        // exclude them (a mirror must never sample its own render target -
        // feedback). Registered BEFORE World so its opaque mirror meshes write
        // depth first; the (transparent) splats then depth-test against them and
        // get occluded when a mirror sits in front of them.
        this.mirrorLayer = new Layer({ name: 'Mirrors' });
        const worldLayer = app.scene.layers.getLayerByName('World');
        const worldIndex = worldLayer ? app.scene.layers.layerList.indexOf(worldLayer) : -1;
        if (worldIndex >= 0) {
            app.scene.layers.insert(this.mirrorLayer, worldIndex);
        } else {
            app.scene.layers.push(this.mirrorLayer);
        }
        camera.camera.layers = [...camera.camera.layers, this.mirrorLayer.id];

        for (const config of configs.slice(0, MAX_MIRRORS)) {
            this.mirrors.push(this.createMirror(config));
        }

        this.installCullChunk();
        window.addEventListener('resize', this.resizeHandler);
    }

    private createMirror(config: MirrorConfig): Mirror {
        const { app } = this;
        const camera = this.camEnt.camera;
        const mat = mirrorMaterial();
        const mi = new MeshInstance(outlineMesh(app.graphicsDevice, config), mat);
        const ent = new Entity(`mirror_${config.shape}`);
        ent.addComponent('render', { meshInstances: [mi], layers: [this.mirrorLayer.id] });

        const position = new Vec3(config.position[0], config.position[1], config.position[2]);
        ORIENTATION_CORRECTION.transformVector(position, position);
        const rotation = new Quat(config.rotation[0], config.rotation[1], config.rotation[2], config.rotation[3]);
        rotation.mul2(ORIENTATION_CORRECTION, rotation);

        ent.setPosition(position);
        ent.setRotation(rotation);
        ent.setLocalScale(config.scale[0], config.scale[1], config.scale[2]);
        app.root.addChild(ent);

        // Per-portal reflection camera + render target.
        const rt = makeRT(app.graphicsDevice);
        const reflCam = new Entity('reflCam');
        const worldLayer = app.scene.layers.getLayerByName('World');
        reflCam.addComponent('camera', {
            fov: camera.fov,
            nearClip: camera.nearClip,
            farClip: camera.farClip,
            clearColor: BG0,
            priority: -1,
            layers: worldLayer ? [worldLayer.id] : []
        });
        reflCam.enabled = false;
        reflCam.camera.renderTarget = rt;
        app.root.addChild(reflCam);

        mat.setParameter('tReflect', rt.colorBuffer);

        return {
            config,
            ent,
            mi,
            mat,
            rt,
            reflCam,
            texMatrix: new Mat4(),
            facing: true,
            cullFront: config.cullFront,
            cullBack: config.cullBack
        };
    }

    // Installs the splat cull chunk on the shared unified gsplat material. The
    // material doesn't exist until the gsplat asset has loaded, so this retries
    // across frames rather than assuming it's ready.
    private installCullChunk() {
        const mat = (this.app.scene.gsplat as unknown as { material?: ShaderMaterial })?.material;
        if (!mat) {
            if (++this.cullInstallTries === 180) {
                console.warn(
                    '[mirrors] app.scene.gsplat.material never appeared after 180 frames - cull/clip disabled. Is unified rendering active on the splat?'
                );
            }
            requestAnimationFrame(() => this.installCullChunk());
            return;
        }
        try {
            mat.getShaderChunks('glsl').set('gsplatModifyVS', MIRROR_CULL_GLSL);
            mat.getShaderChunks('wgsl').set('gsplatModifyVS', MIRROR_CULL_WGSL);
            mat.update();
            this.setU('uMirrorData', this.mirrorDataTex);
            this.setU('uMirrorCount', 0);
            this.setU('uCullEnabled', 0);
            this.setU('uReflClipEnabled', 0);
            this.setU('uCullSoft', CULL_SOFT);
            this.setU('uMainCamPos', [0, 0, 0]);
            this.cullReady = true;
        } catch (err) {
            console.warn('[mirrors] failed to install splat cull chunk:', err);
        }
    }

    // Device-global scope uniforms. Unified gsplat renders through
    // per-camera/layer material clones, so material.setParameter on
    // app.scene.gsplat.material does not reach the draw; global scope uniforms
    // bind to any shader that declares them.
    private setU(name: string, value: number | number[] | Texture) {
        this.app.graphicsDevice.scope.resolve(name).setValue(value);
    }

    // Rebuild every mirror's reflection RT at the current canvas size.
    private rebuildReflectionRTs() {
        for (const m of this.mirrors) {
            const old = m.rt;
            m.rt = makeRT(this.app.graphicsDevice);
            m.reflCam.camera.renderTarget = m.rt;
            m.mat.setParameter('tReflect', m.rt.colorBuffer);
            old.destroy();
        }
        this.app.renderNextFrame = true;
    }

    // The tool's camera keeps one lens for its whole life; this viewer's
    // changes fov and horizontalFov as you move. Mirror them onto the
    // reflection camera before it renders, so the lens it renders with is the
    // one the texture matrix below projects with.
    private syncReflectionLens(reflCam: CameraComponent) {
        const camera = this.camEnt.camera;
        reflCam.fov = camera.fov;
        reflCam.horizontalFov = camera.horizontalFov;
        reflCam.toneMapping = camera.toneMapping;
        reflCam.gammaCorrection = camera.gammaCorrection;
    }

    // Clip planes are fitted to the scene every frame by viewer.ts's
    // applyCamera, but for the MAIN camera's position. The reflection camera
    // stands on the far side of the mirror, so the room reaches further from it
    // - by twice your distance to the mirror - and the main camera's far plane
    // cut off whatever is behind you (a door frame you stand in), more so the
    // further back you stood. So fit them the same way, from the reflection
    // camera's own pose. Only depth depends on these; the texture matrix's
    // x/y (where the reflection lands on the mirror) do not.
    //
    // The near plane is also kept in front of the mirror: nothing visible in
    // the reflection is closer than the mirror plane (splats behind it are
    // clipped), and the viewer's up-to-1m near would cut into the room right
    // in front of the glass when you stand close.
    private fitReflectionClip(reflCam: Entity, planeDist: number) {
        const { center, halfExtents } = this.sceneBound;
        const boundRadius = halfExtents.length();
        const dist = _fit.sub2(center, reflCam.getPosition()).dot(reflCam.forward);
        const far = Math.max(dist + boundRadius, 1e-2);
        const near = Math.max(Math.min(dist - boundRadius, planeDist * 0.5, 1.0), far / (1024 * 16));
        reflCam.camera.farClip = far;
        reflCam.camera.nearClip = near;
    }

    // Reflected virtual camera + projective texture matrix.
    private updateMirrorCamera(m: Mirror) {
        const { camEnt } = this;
        const camera = camEnt.camera;
        const reflCam = m.reflCam;
        const world = m.ent.getWorldTransform();
        world.getTranslation(_rPos);
        _cPos.copy(camEnt.getPosition());
        _n.set(world.data[8], world.data[9], world.data[10]).normalize(); // local +Z in world

        _view.sub2(_rPos, _cPos);
        const planeDot = _view.dot(_n);
        m.facing = planeDot <= 0; // camera must be in front
        if (!m.facing) {
            return false;
        }

        // reflected camera position: reflect the (mirror->camera) vector across n
        reflectVec(_r, _view, _n); // _view is (mirror - cam)
        _view.copy(_rPos).sub(_r); // reflected eye position

        // reflected look target
        _look.copy(camEnt.forward).add(_cPos); // a point the main cam looks at
        _tgt.sub2(_rPos, _look);
        reflectVec(_r, _tgt, _n);
        _tgt.copy(_rPos).sub(_r);

        // reflected up
        reflectVec(_up, camEnt.up, _n);

        reflCam.setPosition(_view);
        reflCam.lookAt(_tgt, _up);

        this.syncReflectionLens(reflCam.camera);
        this.fitReflectionClip(reflCam, -planeDot); // -planeDot = camera's distance to the mirror plane

        // projection: the main camera's, with the aspect taken from the render
        // target rather than the device, so the pass stays self-consistent
        // even for the frame before a resize rebuild lands.
        const aspect = m.rt.width / m.rt.height;
        _proj.setPerspective(camera.fov, aspect, camera.nearClip, camera.farClip, camera.horizontalFov);

        // texMatrix = bias * proj * viewInverse(=camView) * mirrorWorld
        _viewMat.copy(reflCam.getWorldTransform()).invert();
        m.texMatrix.copy(BIAS).mul(_proj).mul(_viewMat).mul(world);
        m.mat.setParameter('textureMatrix', m.texMatrix.data as unknown as number[]);
        m.mat.setParameter('tReflect', m.rt.colorBuffer);
        return true;
    }

    // Main-camera frustum for viewport-visibility culling of mirrors.
    private updateMainFrustum() {
        _frCamInv.copy(this.camEnt.getWorldTransform()).invert();
        _frVP.mul2(this.camEnt.camera.projectionMatrix, _frCamInv);
        _frustum.setFromMat4(_frVP);
    }

    // True if the mirror's world bounds are at least partially inside the viewport.
    private mirrorInView(m: Mirror) {
        const aabb = m.mi.aabb; // world-space, includes transform/scale
        _frSphere.center.copy(aabb.center);
        _frSphere.radius = aabb.halfExtents.length();
        return _frustum.containsSphere(_frSphere) > 0;
    }

    // Called once per frame from the viewer's prerender hook - the tool's
    // app.on("prerender") handler, minus its skydome and master toggle.
    update() {
        const { mirrors, mdataArr } = this;
        const camPos = this.camEnt.getPosition();

        // Pose every mirror's reflection camera + refresh its facing flag.
        for (const m of mirrors) {
            this.updateMirrorCamera(m);
        }

        // Main-camera frustum for viewport-visibility culling this frame.
        this.updateMainFrustum();

        // Enable reflection cameras per mirror and pack the data texture. Holes +
        // clip apply to every enabled mirror.
        const count = Math.min(mirrors.length, MAX_MIRRORS);
        for (let i = 0; i < count; i++) {
            const m = mirrors[i];
            const cfg = m.config;
            const on = cfg.enabled !== false;

            // Only reflect when on, front-facing, and at least partly on-screen.
            // This set must stay stable between frames for a stationary camera:
            // disabling a camera makes the gsplat director drop its per-camera
            // data, and rebuilding it requests another frame.
            const reflects = on && m.facing && this.mirrorInView(m);
            m.ent.enabled = on;
            m.reflCam.enabled = reflects;
            m.mat.setParameter('reflectOn', reflects ? 1 : 0);

            // pack this mirror into texture column i
            const { r, extent } = mirrorDims(cfg);
            const halfT = Math.max((m.cullFront + m.cullBack) / 2, 1e-4);
            const offset = (m.cullFront - m.cullBack) / 2;
            const world = m.ent.getWorldTransform();
            const inv = _inv.copy(world).invert().data;
            world.getTranslation(_rPos);
            _n.set(world.data[8], world.data[9], world.data[10]).normalize();
            for (let c = 0; c < 4; c++) {
                const b = this.texelBase(c, i);
                mdataArr[b] = inv[c * 4];
                mdataArr[b + 1] = inv[c * 4 + 1];
                mdataArr[b + 2] = inv[c * 4 + 2];
                mdataArr[b + 3] = inv[c * 4 + 3];
            }
            const b4 = this.texelBase(4, i);
            mdataArr[b4] = _n.x;
            mdataArr[b4 + 1] = _n.y;
            mdataArr[b4 + 2] = _n.z;
            mdataArr[b4 + 3] = -(_n.x * _rPos.x + _n.y * _rPos.y + _n.z * _rPos.z);
            const b5 = this.texelBase(5, i);
            mdataArr[b5] = SHAPE[cfg.shape] ?? 0;
            mdataArr[b5 + 1] = r;
            mdataArr[b5 + 2] = extent;
            mdataArr[b5 + 3] = on ? 1 : 0;
            const b6 = this.texelBase(6, i);
            mdataArr[b6] = halfT;
            mdataArr[b6 + 1] = offset;
            mdataArr[b6 + 2] = 0;
            mdataArr[b6 + 3] = 0;
        }

        if (this.cullReady) {
            const levelsUpdated = (this.mirrorDataTex as unknown as { _levelsUpdated?: boolean[] })._levelsUpdated;
            if (levelsUpdated) {
                levelsUpdated[0] = true;
            }
            this.mirrorDataTex.upload();
            this.setU('uMirrorData', this.mirrorDataTex);
            this.setU('uMirrorCount', count);
            this.setU('uMainCamPos', [camPos.x, camPos.y, camPos.z]);
            this.setU('uCullSoft', CULL_SOFT);
            this.setU('uCullEnabled', count > 0 ? 1 : 0);
            this.setU('uReflClipEnabled', count > 0 ? 1 : 0);
        }

        this.app.renderNextFrame = true;
    }

    private texelBase(row: number, col: number) {
        return (row * MAX_MIRRORS + col) * 4;
    }

    destroy() {
        window.removeEventListener('resize', this.resizeHandler);
        for (const m of this.mirrors) {
            m.reflCam.destroy();
            m.rt.destroy();
            m.ent.destroy();
        }
        this.mirrors = [];
    }
}

export { MirrorPortals, loadMirrors };
