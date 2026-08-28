// Live-reflecting mirror portals, driven by a static mirrors.json (see
// /splat-portal-mirror-tool's "Export mirrors.json" button). No editing, no
// placement UI — this is the runtime playback half only; portals are placed
// offline in that tool and simply reproduced here at the exact saved
// transform.
//
// Technique ported from the Splat Portal Mirror Tool (https://portalmirror.atlux.one,
// MIT licensed): each mirror gets a hidden reflection camera + render target,
// posed every frame by reflecting the main camera across the mirror's plane,
// and a custom gsplatModifyVS shader chunk carves a hole through the splats
// around every mirror using a packed "mirror data texture" (so N mirrors cost
// one texture upload, not N uniform arrays — uniform arrays don't reach the
// unified gsplat draw on this engine).
//
// Adapted from the original in two real ways: mirrors only (no window/HDRI
// portals, no selection UI — this is a viewer, not an editor), and every
// shader is written for both GLSL and WGSL, since this viewer defaults to
// WebGPU and the reference tool only ever targeted WebGL.
import {
    Color,
    Entity,
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
import type { AppBase, GraphicsDevice } from 'playcanvas';

import {
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
// schema validator (unlike settings.json) — this file is written by our own
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

// Local-plane half-extents: r (radius / rect half-width / cap radius) and
// extent (rect half-height / capsule straight half-height; 0 for circle).
// cfg.radius is the FULL width for a rect, cfg.height the FULL height.
const shapeDims = (cfg: MirrorConfig) => {
    if (cfg.shape === 'rect') {
        return { r: cfg.radius / 2, extent: (cfg.height ?? cfg.radius) / 2 };
    }
    if (cfg.shape === 'capsule') {
        return { r: cfg.radius, extent: Math.max((cfg.height ?? cfg.radius * 2) / 2 - cfg.radius, 0) };
    }
    return { r: cfg.radius, extent: 0 };
};

// Flat outline mesh on the portal's local XY plane (z=0); local +Z becomes
// the mirror's normal once the entity's rotation is applied.
const outlineMesh = (device: GraphicsDevice, cfg: MirrorConfig): Mesh => {
    const { r, extent } = shapeDims(cfg);
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
            pts.push([Math.cos(a) * r, extent + Math.sin(a) * r]);
        }
        for (let i = 0; i <= seg; i++) {
            const a = Math.PI + (i / seg) * Math.PI;
            pts.push([Math.cos(a) * r, -extent + Math.sin(a) * r]);
        }
    } else {
        const seg = 96;
        for (let i = 0; i < seg; i++) {
            const a = (i / seg) * Math.PI * 2;
            pts.push([Math.cos(a) * r, Math.sin(a) * r]);
        }
    }
    const positions = [0, 0, 0];
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

const createSurfaceMaterial = (): ShaderMaterial => {
    const mat = new ShaderMaterial({
        uniqueName: `mirrorSurface_${Math.random().toString(36).slice(2)}`,
        attributes: { aPosition: SEMANTIC_POSITION },
        vertexGLSL: MIRROR_SURFACE_VERTEX_GLSL,
        fragmentGLSL: MIRROR_SURFACE_FRAGMENT_GLSL,
        vertexWGSL: MIRROR_SURFACE_VERTEX_WGSL,
        fragmentWGSL: MIRROR_SURFACE_FRAGMENT_WGSL
    });
    mat.cull = CULLFACE_NONE;
    mat.setParameter('uReflectivity', 0.95);
    return mat;
};

type MirrorInstance = {
    config: MirrorConfig;
    entity: Entity;
    material: ShaderMaterial;
    reflectionCamera: Entity;
    renderTarget: RenderTarget;
    inverseWorld: Mat4;
};

const makeRenderTarget = (device: GraphicsDevice): RenderTarget => {
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
    // WebGPU and WebGL disagree on which end of a render target is row 0. The
    // engine's own renderer already knows this and will pre-flip the
    // rendering camera's projection matrix (Camera.applyShaderProjectionTransform)
    // whenever a target is marked flipY - that corrects the content at the
    // point it's rasterized, upstream of our own hand-built projective
    // texMatrix, so the mirror-surface shader's sampling code (matched to the
    // original WebGL-only tool) doesn't need to know about it at all.
    return new RenderTarget({ colorBuffer, depth: true, samples: 1, flipY: device.isWebGPU });
};

// r = v - 2(v.n)n
const reflectVec = (out: Vec3, v: Vec3, n: Vec3) => {
    const d = 2 * v.dot(n);
    out.set(v.x - d * n.x, v.y - d * n.y, v.z - d * n.z);
    return out;
};

const bias = new Mat4().set([0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0.5, 0, 0.5, 0.5, 0.5, 1]);

// mirrors.json stores world-space position/rotation from the authoring tool,
// whose scene flips the loaded splat 180° about X (`setEulerAngles(180, 0, 0)`
// in portal-mirror.html) to right it. This viewer instead flips the same raw
// splat 180° about Z (index.ts's `setLocalEulerAngles(0, 0, 180)`) — a
// different orientation of the identical source data. The two flips differ by
// a 180° rotation about Y (Rz180 = Ry180 * Rx180, verified numerically against
// playcanvas's own Quat/Mat4 math), so every mirror transform needs that same
// Y-180 correction applied on load to line back up with the splat geometry.
// Scale is untouched: a Y-180 flip only negates the X/Z axes, it never swaps
// them, so per-axis scale stays paired with the same local axis either way.
const ORIENTATION_CORRECTION = new Quat(0, 1, 0, 0);

// Reflection cameras clear to transparent so a mirror seen from an angle
// where nothing reflects (or before the first pose) shows black, not garbage
// from a previous frame's render target contents.
const TRANSPARENT_BLACK = new Color(0, 0, 0, 0);

class MirrorPortals {
    private app: AppBase;

    private camera: Entity;

    private mirrorLayer: Layer;

    private instances: MirrorInstance[] = [];

    // Mirror data texture: packs every mirror's world->local inverse matrix,
    // shape/cull params into an RGBA32F texture the gsplat modify chunk
    // samples (see shaders.ts for the row layout).
    private dataTexture: Texture;

    private dataArray: Float32Array;

    private cullInstallTries = 0;

    private cullReady = false;

    private resizeHandler = () => this.handleResize();

    constructor(app: AppBase, camera: Entity, configs: MirrorConfig[]) {
        this.app = app;
        this.camera = camera;

        const { graphicsDevice } = app;

        this.dataTexture = new Texture(graphicsDevice, {
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
        this.dataArray = new Float32Array(MAX_MIRRORS * MIRROR_DATA_ROWS * 4);
        (this.dataTexture as unknown as { _levels: Float32Array[] })._levels[0] = this.dataArray;

        // Dedicated layer for mirror surfaces, registered before World so
        // their opaque quads write depth first — the transparent splats then
        // depth-test against them and get occluded when a mirror sits in
        // front of them. A mirror must never render into its own reflection
        // (feedback), so reflection cameras exclude this layer.
        this.mirrorLayer = new Layer({ name: 'Mirrors' });
        const worldLayer = app.scene.layers.getLayerByName('World');
        const worldIndex = worldLayer ? app.scene.layers.layerList.indexOf(worldLayer) : -1;
        if (worldIndex >= 0) {
            app.scene.layers.insert(this.mirrorLayer, worldIndex);
        } else {
            app.scene.layers.push(this.mirrorLayer);
        }
        camera.camera.layers = [...camera.camera.layers, this.mirrorLayer.id];

        for (const config of configs.filter((c) => c.enabled !== false)) {
            this.instances.push(this.createMirror(config));
        }

        this.installCullChunk();
        window.addEventListener('resize', this.resizeHandler);
    }

    private createMirror(config: MirrorConfig): MirrorInstance {
        const { app } = this;
        const material = createSurfaceMaterial();
        const mesh = outlineMesh(app.graphicsDevice, config);
        const meshInstance = new MeshInstance(mesh, material);

        const entity = new Entity(`mirror_${config.shape}`);
        entity.addComponent('render', { meshInstances: [meshInstance], layers: [this.mirrorLayer.id] });

        const position = new Vec3(config.position[0], config.position[1], config.position[2]);
        ORIENTATION_CORRECTION.transformVector(position, position);
        const rotation = new Quat(config.rotation[0], config.rotation[1], config.rotation[2], config.rotation[3]);
        rotation.mul2(ORIENTATION_CORRECTION, rotation);

        entity.setPosition(position);
        entity.setRotation(rotation);
        entity.setLocalScale(config.scale[0], config.scale[1], config.scale[2]);
        app.root.addChild(entity);

        const renderTarget = makeRenderTarget(app.graphicsDevice);
        const reflectionCamera = new Entity('mirrorReflectionCamera');
        const worldLayer = app.scene.layers.getLayerByName('World');
        reflectionCamera.addComponent('camera', {
            fov: this.camera.camera.fov,
            nearClip: this.camera.camera.nearClip,
            farClip: this.camera.camera.farClip,
            clearColor: TRANSPARENT_BLACK,
            priority: -1,
            layers: worldLayer ? [worldLayer.id] : []
        });
        reflectionCamera.enabled = false;
        reflectionCamera.camera.renderTarget = renderTarget;
        app.root.addChild(reflectionCamera);

        material.setParameter('uReflectionTex', renderTarget.colorBuffer);

        return { config, entity, material, reflectionCamera, renderTarget, inverseWorld: new Mat4() };
    }

    // Installs the splat-culling chunk on the shared unified gsplat material.
    // The material doesn't exist until the gsplat asset has loaded, so this
    // polls across frames rather than assuming it's ready — mirroring how the
    // reference tool handles the same race.
    private installCullChunk() {
        const mat = (this.app.scene.gsplat as unknown as { material?: ShaderMaterial })?.material;
        if (!mat) {
            if (++this.cullInstallTries > 600) {
                console.warn('[mirrors] app.scene.gsplat.material never appeared - splat culling disabled');
                return;
            }
            requestAnimationFrame(() => this.installCullChunk());
            return;
        }
        try {
            mat.getShaderChunks('glsl').set('gsplatModifyVS', MIRROR_CULL_GLSL);
            mat.getShaderChunks('wgsl').set('gsplatModifyVS', MIRROR_CULL_WGSL);
            mat.update();
            this.cullReady = true;
        } catch (err) {
            console.warn('[mirrors] failed to install splat cull chunk:', err);
        }
    }

    private handleResize() {
        for (const instance of this.instances) {
            const old = instance.renderTarget;
            instance.renderTarget = makeRenderTarget(this.app.graphicsDevice);
            instance.reflectionCamera.camera.renderTarget = instance.renderTarget;
            instance.material.setParameter('uReflectionTex', instance.renderTarget.colorBuffer);
            old.destroy();
        }
        this.app.renderNextFrame = true;
    }

    // Called once per frame (see viewer.ts's prerender hook): pose every
    // mirror's reflection camera and repack the mirror data texture the
    // splat-cull shader chunk reads.
    update() {
        const camPos = this.camera.getPosition();
        const view = new Vec3();
        const reflectedEye = new Vec3();
        const look = new Vec3();
        const target = new Vec3();
        const reflectedTarget = new Vec3();
        const up = new Vec3();
        const normal = new Vec3();
        const worldPos = new Vec3();

        for (const instance of this.instances) {
            const world = instance.entity.getWorldTransform();
            world.getTranslation(worldPos);
            normal.set(world.data[8], world.data[9], world.data[10]).normalize();

            view.sub2(worldPos, camPos);
            const facing = view.dot(normal) <= 0;

            if (facing) {
                reflectVec(reflectedEye, view, normal);
                reflectedEye.set(worldPos.x - reflectedEye.x, worldPos.y - reflectedEye.y, worldPos.z - reflectedEye.z);

                look.copy(this.camera.forward).add(camPos);
                target.sub2(worldPos, look);
                reflectVec(reflectedTarget, target, normal);
                reflectedTarget.set(
                    worldPos.x - reflectedTarget.x,
                    worldPos.y - reflectedTarget.y,
                    worldPos.z - reflectedTarget.z
                );

                reflectVec(up, this.camera.up, normal);

                instance.reflectionCamera.setPosition(reflectedEye);
                instance.reflectionCamera.lookAt(reflectedTarget, up);

                const proj = new Mat4();
                const aspect = instance.renderTarget.width / instance.renderTarget.height;
                proj.setPerspective(
                    this.camera.camera.fov,
                    aspect,
                    this.camera.camera.nearClip,
                    this.camera.camera.farClip,
                    this.camera.camera.horizontalFov
                );

                const viewMat = new Mat4().copy(instance.reflectionCamera.getWorldTransform()).invert();
                const texMatrix = new Mat4().copy(bias).mul(proj).mul(viewMat).mul(world);
                instance.material.setParameter('uTextureMatrix', texMatrix.data as unknown as Float32Array);
            }

            instance.reflectionCamera.enabled = facing;

            // Pack this mirror into its data-texture column.
            const idx = this.instances.indexOf(instance);
            instance.inverseWorld.copy(world).invert();
            const inv = instance.inverseWorld.data;
            for (let c = 0; c < 4; c++) {
                const base = (c * MAX_MIRRORS + idx) * 4;
                this.dataArray[base] = inv[c * 4];
                this.dataArray[base + 1] = inv[c * 4 + 1];
                this.dataArray[base + 2] = inv[c * 4 + 2];
                this.dataArray[base + 3] = inv[c * 4 + 3];
            }
            const { r, extent } = shapeDims(instance.config);
            const shapeCode = instance.config.shape === 'rect' ? 1 : instance.config.shape === 'capsule' ? 2 : 0;
            const b4 = (4 * MAX_MIRRORS + idx) * 4;
            this.dataArray[b4] = shapeCode;
            this.dataArray[b4 + 1] = r;
            this.dataArray[b4 + 2] = extent;
            this.dataArray[b4 + 3] = 1;
            const halfT = Math.max((instance.config.cullFront + instance.config.cullBack) / 2, 1e-4);
            const offset = (instance.config.cullFront - instance.config.cullBack) / 2;
            const b5 = (5 * MAX_MIRRORS + idx) * 4;
            this.dataArray[b5] = halfT;
            this.dataArray[b5 + 1] = offset;
        }

        if (this.cullReady) {
            (this.dataTexture as unknown as { _levelsUpdated?: boolean[] })._levelsUpdated = [true];
            this.dataTexture.upload();
            const scope = this.app.graphicsDevice.scope;
            scope.resolve('uMirrorData').setValue(this.dataTexture);
            scope.resolve('uMirrorCount').setValue(this.instances.length);
        }

        this.app.renderNextFrame = true;
    }

    destroy() {
        window.removeEventListener('resize', this.resizeHandler);
        for (const instance of this.instances) {
            instance.reflectionCamera.destroy();
            instance.renderTarget.destroy();
            instance.entity.destroy();
        }
        this.instances = [];
    }
}

export { MirrorPortals, loadMirrors };
