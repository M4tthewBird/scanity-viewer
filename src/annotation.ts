import {
    CULLFACE_NONE,
    FILTER_LINEAR,
    PIXELFORMAT_SRGBA8,
    BlendState,
    Color,
    Entity,
    Layer,
    Mesh,
    MeshInstance,
    PlaneGeometry,
    Script,
    StandardMaterial,
    Texture,
    Vec3,
    BLENDEQUATION_ADD,
    BLENDMODE_ONE,
    BLENDMODE_ONE_MINUS_SRC_ALPHA,
    BLENDMODE_SRC_ALPHA
} from 'playcanvas';
import type { AppBase, Quat } from 'playcanvas';

// clamp the vertices of the hotspot so it is never clipped by the near or far plane
const depthClampGlsl = `
    float f = gl_Position.z / gl_Position.w;
    if (f > 1.0) {
        gl_Position.z = gl_Position.w;
    } else if (f < -1.0) {
        gl_Position.z = -gl_Position.w;
    }
`;

const depthClampWgsl = `
    let f = output.position.z / output.position.w;
    if (f > 1.0) {
        output.position.z = output.position.w;
    } else if (f < -1.0) {
        output.position.z = -output.position.w;
    }
`;

const vec = new Vec3();

// Hotspot texture: canvas size, and the disc's diameter within it (a small
// transparent margin around it). Scanity ink and muted grey, as in
// index.scss's $clr-ink and $clr-muted.
const HOTSPOT_TEXTURE = 128;
const HOTSPOT_DISC = 100;
const INK = '#101112';
const MUTED = '#6e7479';
// The light tone the frosted control pills read as over a scan
const GLASS = '#eef0f1';

/**
 * A script for creating interactive 3D annotations in a scene. Each annotation consists of:
 *
 * - A 3D hotspot that maintains constant screen-space size. The hotspot is rendered with muted
 * appearance when obstructed by geometry but is still clickable. The hotspot relies on an
 * invisible DOM element that matches the hotspot's size and position to detect clicks.
 * - An annotation panel that shows title and description text.
 */
export class Annotation extends Script {
    static scriptName = 'annotation';

    // Screen size of the hotspot quad in CSS px. The drawn disc fills
    // HOTSPOT_DISC / HOTSPOT_TEXTURE of it (~28px); the rest is room for its
    // drop shadow.
    static hotspotSize = 36;

    // Emissive multiplier over the hotspot texture. White: the texture
    // carries the real colours (see _createHotspotTexture), and the hover /
    // selected look is a texture swap rather than a tint.
    static hotspotColor = new Color(1, 1, 1);

    static parentDom: HTMLElement | null = null;

    static styleSheet: HTMLStyleElement | null = null;

    static camera: Entity | null = null;

    static tooltipDom: HTMLDivElement | null = null;

    static titleDom: HTMLDivElement | null = null;

    static textDom: HTMLDivElement | null = null;

    static layers: Layer[] = [];

    static mesh: Mesh | null = null;

    static activeAnnotation: Annotation | null = null;

    static hoverAnnotation: Annotation | null = null;

    static opacity = 1.0;

    /**
     * @attribute
     */
    label: string;

    /**
     * @attribute
     */
    title: string;

    /**
     * @attribute
     */
    text: string;

    /**
     * @private
     */
    hotspotDom: HTMLDivElement | null = null;

    /**
     * Resting and selected (hovered or open) hotspot textures.
     * @private
     */
    textures: { rest: Texture; selected: Texture } | null = null;

    /**
     * @private
     */
    hovered = false;

    /**
     * @private
     */
    materials: StandardMaterial[] = [];

    /**
     * Injects required CSS styles into the document.
     * @param {number} size - The size of the hotspot in screen pixels.
     * @private
     */
    static _injectStyles(size: number) {
        // Scanity: the tooltip is the viewer's white panel (settings panel,
        // annotation list): near-opaque white, hairline white rim, soft
        // shadow, Manrope inherited from the page, ink title, muted body.
        const css = `
            .pc-annotation {
                display: block;
                position: absolute;
                box-sizing: border-box;
                background-color: rgba(255, 255, 255, 0.94);
                border: 1px solid rgba(255, 255, 255, 0.9);
                box-shadow: 0 12px 36px rgba(16, 17, 18, 0.16);
                backdrop-filter: blur(20px);
                -webkit-backdrop-filter: blur(20px);
                color: #6e7479;
                padding: 10px 14px 12px;
                border-radius: 14px;
                font-family: inherit;
                font-size: 13px;
                line-height: 1.45;
                pointer-events: none;
                max-width: 240px;
                word-wrap: break-word;
                overflow-x: visible;
                white-space: normal;
                width: fit-content;
                opacity: 0;
                transition: opacity 0.2s ease-in-out;
                visibility: hidden;
            }

            .pc-annotation-title {
                font-size: 14px;
                font-weight: 700;
                letter-spacing: -0.01em;
                color: #101112;
            }

            .pc-annotation-text:not(:empty) {
                margin-top: 3px;
            }

            /* Tooltip arrow */
            .pc-annotation.arrow-right::before,
            .pc-annotation.arrow-left::before {
                content: "";
                position: absolute;
                top: var(--arrow-top, 50%);
                transform: translateY(-50%);
                border-top: 8px solid transparent;
                border-bottom: 8px solid transparent;
            }

            .pc-annotation.arrow-right::before {
                left: -8px;
                border-right: 8px solid rgba(255, 255, 255, 0.94);
            }

            .pc-annotation.arrow-left::before {
                right: -8px;
                border-left: 8px solid rgba(255, 255, 255, 0.94);
            }

            .pc-annotation-hotspot {
                display: none;
                position: absolute;
                width: ${size + 5}px;
                height: ${size + 5}px;
                opacity: 0;
                cursor: pointer;
                transform: translate(-50%, -50%);
            }
        `;

        const style = document.createElement('style');
        style.textContent = css;
        document.head.appendChild(style);
        Annotation.styleSheet = style;
    }

    /**
     * Initialize static resources.
     * @param {AppBase} app - The application instance
     * @private
     */
    static _initializeStatic(app: AppBase) {
        if (Annotation.styleSheet) {
            return;
        }

        Annotation._injectStyles(Annotation.hotspotSize);

        if (Annotation.parentDom === null) {
            Annotation.parentDom = document.body;
        }

        const { layers } = app.scene;
        const worldLayer = layers.getLayerByName('World');

        const createLayer = (name: string, semitrans: boolean) => {
            const layer = new Layer({ name: name });
            const idx = semitrans ? layers.getTransparentIndex(worldLayer) : layers.getOpaqueIndex(worldLayer);
            layers.insert(layer, idx + 1);
            return layer;
        };

        Annotation.layers = [createLayer('HotspotBase', false), createLayer('HotspotOverlay', true)];

        if (Annotation.camera === null) {
            Annotation.camera = app.root.findComponent('camera').entity;
        }

        Annotation.camera.camera.layers = [
            ...Annotation.camera.camera.layers,
            ...Annotation.layers.map((layer) => layer.id)
        ];

        Annotation.mesh = Mesh.fromGeometry(
            app.graphicsDevice,
            new PlaneGeometry({
                widthSegments: 1,
                lengthSegments: 1
            })
        );

        // Initialize tooltip dom
        Annotation.tooltipDom = document.createElement('div');
        Annotation.tooltipDom.className = 'pc-annotation';

        Annotation.titleDom = document.createElement('div');
        Annotation.titleDom.className = 'pc-annotation-title';
        Annotation.tooltipDom.appendChild(Annotation.titleDom);

        Annotation.textDom = document.createElement('div');
        Annotation.textDom.className = 'pc-annotation-text';
        Annotation.tooltipDom.appendChild(Annotation.textDom);

        Annotation.parentDom.appendChild(Annotation.tooltipDom);
    }

    /**
     * Creates a circular hotspot texture in the controls' own language: the
     * light glass tone of a control pill with a thin white rim and a grey
     * Manrope number at rest; filled ink with a white
     * number when selected, like an active camera toggle. Drawn at 128px so
     * it stays crisp on high-density screens at its ~28px display size.
     * @param {AppBase} app - The PlayCanvas AppBase
     * @param {string} label - Label text to draw on the hotspot
     * @param {boolean} selected - Draw the selected (hovered / open) look
     * @returns {Texture} The hotspot texture
     * @private
     */
    static _createHotspotTexture(app: AppBase, label: string, selected: boolean) {
        const size = HOTSPOT_TEXTURE;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');

        const center = size / 2;
        const radius = HOTSPOT_DISC / 2;
        const disc = () => {
            ctx.beginPath();
            ctx.arc(center, center, radius, 0, Math.PI * 2);
        };

        // Everything here is opaque on purpose. The hotspot draws before the
        // splats and writes depth, so any semi-transparent texel (a
        // translucent body, a soft drop shadow) blends with the empty
        // background instead of the scan and shows as a dark patch or halo.

        // Thin white rim, as on every control pill, as the outer edge
        disc();
        ctx.fillStyle = '#ffffff';
        ctx.fill();

        // Body: the controls' glass tone at rest, ink when selected (the
        // active camera toggle)
        ctx.beginPath();
        ctx.arc(center, center, radius - 3.5, 0, Math.PI * 2);
        ctx.fillStyle = selected ? INK : GLASS;
        ctx.fill();

        // Number, Manrope bold, optically centred: the control icons' grey
        // at rest, white when selected
        ctx.font = `700 ${label.length > 1 ? 46 : 54}px Manrope, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = selected ? '#ffffff' : MUTED;
        ctx.fillText(label, center, center + 3);

        const { data } = ctx.getImageData(0, 0, size, size);

        // sRGB format: canvas colours are sRGB, so the ink stays ink instead
        // of being lifted to grey by the output gamma
        return new Texture(app.graphicsDevice, {
            width: size,
            height: size,
            format: PIXELFORMAT_SRGBA8,
            magFilter: FILTER_LINEAR,
            minFilter: FILTER_LINEAR,
            mipmaps: false,
            levels: [new Uint8Array(data.buffer)]
        });
    }

    /**
     * (Re)draws this hotspot's textures and points its materials at the one
     * matching the current state.
     * @private
     */
    _buildTextures() {
        this.textures?.rest.destroy();
        this.textures?.selected.destroy();
        this.textures = {
            rest: Annotation._createHotspotTexture(this.app, this.label, false),
            selected: Annotation._createHotspotTexture(this.app, this.label, true)
        };
        this._applyTexture();
    }

    /**
     * @private
     */
    _applyTexture() {
        const selected = this.hovered || Annotation.activeAnnotation === this;
        const texture = selected ? this.textures.selected : this.textures.rest;
        this.materials.forEach((material) => {
            if (material.emissiveMap !== texture) {
                material.emissiveMap = texture;
                material.opacityMap = texture;
                material.update();
            }
        });
        this.app.renderNextFrame = true;
    }

    /**
     * Creates a material for hotspot rendering.
     * @param {Texture} texture - The texture to use for emissive and opacity
     * @param {object} [options] - Material options
     * @param {number} [options.opacity] - Base opacity multiplier
     * @param {boolean} [options.depthTest] - Whether to perform depth testing
     * @param {boolean} [options.depthWrite] - Whether to write to depth buffer
     * @returns {StandardMaterial} The configured material
     * @private
     */
    static _createHotspotMaterial(texture: Texture, { opacity = 1, depthTest = true, depthWrite = true } = {}) {
        const material = new StandardMaterial();

        // Base properties
        material.diffuse = Color.BLACK;
        material.emissive.copy(Annotation.hotspotColor);
        material.emissiveMap = texture;
        material.opacityMap = texture;

        // Alpha properties. The depth-tested base pass drops half-transparent
        // edge texels (they would blend with the empty background, as the
        // splats draw after it); the overlay pass, drawn after the splats,
        // keeps them for a smooth edge.
        material.opacity = opacity;
        material.alphaTest = depthWrite ? 0.5 : 0.01;
        material.blendState = new BlendState(
            true,
            BLENDEQUATION_ADD,
            BLENDMODE_SRC_ALPHA,
            BLENDMODE_ONE_MINUS_SRC_ALPHA,
            BLENDEQUATION_ADD,
            BLENDMODE_ONE,
            BLENDMODE_ONE
        );

        // Depth properties
        material.depthTest = depthTest;
        material.depthWrite = depthWrite;

        // Rendering properties
        material.cull = CULLFACE_NONE;
        material.useLighting = false;

        material.shaderChunks.glsl.add({
            litUserMainEndVS: depthClampGlsl
        });
        material.shaderChunks.wgsl.add({
            litUserMainEndVS: depthClampWgsl
        });

        material.update();
        return material;
    }

    initialize() {
        // Ensure static resources are initialized
        Annotation._initializeStatic(this.app);

        // Create textures
        this.textures = {
            rest: Annotation._createHotspotTexture(this.app, this.label, false),
            selected: Annotation._createHotspotTexture(this.app, this.label, true)
        };

        // Create material the base and overlay material
        this.materials = [
            Annotation._createHotspotMaterial(this.textures.rest, {
                opacity: 1,
                depthTest: true,
                depthWrite: true
            }),
            Annotation._createHotspotMaterial(this.textures.rest, {
                opacity: 0.25,
                depthTest: false,
                depthWrite: false
            })
        ];

        // The numbers are drawn in Manrope, which the page loads from Google
        // Fonts; if it isn't ready yet the first draw fell back, so redraw
        // once it arrives.
        const hotspotFont = '700 54px Manrope';
        if (!document.fonts.check(hotspotFont)) {
            document.fonts
                .load(hotspotFont)
                .then(() => {
                    if (this.textures) {
                        this._buildTextures();
                    }
                })
                .catch(() => {
                    // keep the fallback-font textures
                });
        }

        const base = new Entity('base');
        const baseMi = new MeshInstance(Annotation.mesh, this.materials[0]);
        baseMi.cull = false;
        base.addComponent('render', {
            layers: [Annotation.layers[0].id],
            meshInstances: [baseMi]
        });

        const overlay = new Entity('overlay');
        const overlayMi = new MeshInstance(Annotation.mesh, this.materials[1]);
        overlayMi.cull = false;
        overlay.addComponent('render', {
            layers: [Annotation.layers[1].id],
            meshInstances: [overlayMi]
        });

        this.entity.addChild(base);
        this.entity.addChild(overlay);

        // Create hotspot dom
        this.hotspotDom = document.createElement('div');
        this.hotspotDom.className = 'pc-annotation-hotspot';

        // Add click handlers
        this.hotspotDom.addEventListener('click', (e) => {
            e.stopPropagation();
            this.showTooltip();
        });

        const leave = () => {
            if (Annotation.hoverAnnotation === this) {
                Annotation.hoverAnnotation = null;
                this.setHover(false);
            }
        };

        const enter = () => {
            if (Annotation.hoverAnnotation !== null) {
                Annotation.hoverAnnotation.setHover(false);
            }
            Annotation.hoverAnnotation = this;
            this.setHover(true);
        };

        this.hotspotDom.addEventListener('pointerenter', enter);
        this.hotspotDom.addEventListener('pointerleave', leave);

        document.addEventListener('click', () => {
            if (Annotation.activeAnnotation === this) {
                this.hideTooltip();
            }
        });

        Annotation.parentDom.appendChild(this.hotspotDom);

        // Clean up on entity destruction
        this.on('destroy', () => {
            this.hotspotDom.remove();
            if (Annotation.activeAnnotation === this) {
                this.hideTooltip();
            }

            this.materials.forEach((mat) => mat.destroy());
            this.materials = [];

            this.textures.rest.destroy();
            this.textures.selected.destroy();
            this.textures = null;
        });

        this.app.on('prerender', () => {
            this._update();
        });
    }

    /**
     * Update screen-space elements and materials for this annotation. Called each frame from the
     * prerender callback, and also directly from showTooltip to ensure the tooltip is positioned
     * correctly even when the camera hasn't moved (e.g. annotations sharing the same camera pose).
     * @private
     */
    _update() {
        if (!Annotation.camera) return;

        const position = this.entity.getPosition();
        const screenPos = Annotation.camera.camera.worldToScreen(position);

        const { viewMatrix } = Annotation.camera.camera;
        viewMatrix.transformPoint(position, vec);
        if (vec.z >= 0) {
            this._hideElements();
            return;
        }

        this._updatePositions(screenPos);
        this._updateRotationAndScale(-vec.z);

        // update material opacity and also directly on the uniform so we
        // can avoid a full material update
        this.materials[0].opacity = Annotation.opacity;
        this.materials[1].opacity = 0.25 * Annotation.opacity;
        this.materials[0].setParameter('material_opacity', Annotation.opacity);
        this.materials[1].setParameter('material_opacity', 0.25 * Annotation.opacity);
    }

    /**
     * Set the hover state of the annotation.
     * @param hover - Whether the annotation is hovered
     * @private
     */
    setHover(hover: boolean) {
        this.hovered = hover;
        this._applyTexture();
        this.fire('hover', hover);
    }

    /**
     * @private
     */
    showTooltip() {
        const previous = Annotation.activeAnnotation;
        Annotation.activeAnnotation = this;
        if (previous && previous !== this) {
            previous._applyTexture();
        }
        this._applyTexture();
        Annotation.tooltipDom.style.visibility = 'visible';
        Annotation.tooltipDom.style.opacity = '1';
        Annotation.titleDom.textContent = this.title;
        Annotation.textDom.textContent = this.text;

        // Immediately update incase the camera doesn't move
        this._update();

        this.fire('show', this);
    }

    /**
     * @private
     */
    hideTooltip() {
        Annotation.activeAnnotation = null;
        this._applyTexture();
        Annotation.tooltipDom.style.opacity = '0';

        // Wait for fade out before hiding
        setTimeout(() => {
            if (Annotation.tooltipDom.style.opacity === '0') {
                Annotation.tooltipDom.style.visibility = 'hidden';
                this.fire('hide');
            }
        }, 200); // Match the transition duration
    }

    /**
     * Hide all elements when annotation is behind camera.
     * @private
     */
    _hideElements() {
        this.hotspotDom.style.display = 'none';
        if (Annotation.activeAnnotation === this) {
            Annotation.tooltipDom.style.visibility = 'hidden';
            Annotation.tooltipDom.style.opacity = '0';
        }
    }

    /**
     * Update screen-space positions of HTML elements.
     * @param {Vec3} screenPos - Screen coordinate
     * @private
     */
    _updatePositions(screenPos: Vec3) {
        // Show and position hotspot
        this.hotspotDom.style.display = 'block';
        this.hotspotDom.style.left = `${screenPos.x}px`;
        this.hotspotDom.style.top = `${screenPos.y}px`;

        // Re-show tooltip if it was hidden while behind camera
        if (Annotation.activeAnnotation === this) {
            Annotation.tooltipDom.style.visibility = 'visible';
            Annotation.tooltipDom.style.opacity = '1';
        }

        // Position tooltip, clamped to viewport
        if (Annotation.activeAnnotation === this) {
            const tooltip = Annotation.tooltipDom;
            const margin = 8;
            const arrowOffset = 25;
            const tw = tooltip.offsetWidth;
            const th = tooltip.offsetHeight;
            const vw = window.innerWidth;
            const vh = window.innerHeight;

            // Default position: to the right of hotspot, vertically centered
            let left = screenPos.x + arrowOffset;
            let top = screenPos.y - th / 2;
            let flipped = false;

            // If tooltip overflows right edge, flip to left side of hotspot
            if (left + tw > vw - margin) {
                left = screenPos.x - arrowOffset - tw;
                flipped = true;
            }

            // Clamp horizontal
            left = Math.max(margin, Math.min(left, vw - tw - margin));

            // Clamp vertical
            top = Math.max(margin, Math.min(top, vh - th - margin));

            // Position arrow to point at the hotspot, clamped within the tooltip
            const arrowY = Math.max(16, Math.min(screenPos.y - top, th - 16));
            tooltip.style.setProperty('--arrow-top', `${arrowY}px`);

            tooltip.classList.toggle('arrow-right', !flipped);
            tooltip.classList.toggle('arrow-left', flipped);
            tooltip.style.transform = 'none';
            tooltip.style.left = `${left}px`;
            tooltip.style.top = `${top}px`;
        }
    }

    /**
     * Update 3D rotation and scale of hotspot planes.
     * @param {number} viewDepth - The view-space depth (positive distance along the camera's forward direction)
     * @private
     */
    _updateRotationAndScale(viewDepth: number) {
        // Copy camera rotation to align with view plane
        const cameraRotation = Annotation.camera.getRotation();
        this._updateHotspotTransform(this.entity, cameraRotation);

        // Calculate scale based on view depth to maintain constant screen size
        const scale = this._calculateScreenSpaceScale(viewDepth);
        this.entity.setLocalScale(scale, scale, scale);
    }

    /**
     * Update rotation of a single hotspot entity.
     * @param {Entity} hotspot - The hotspot entity to update
     * @param {Quat} cameraRotation - The camera's current rotation
     * @private
     */
    _updateHotspotTransform(hotspot: Entity, cameraRotation: Quat) {
        hotspot.setRotation(cameraRotation);
        hotspot.rotateLocal(90, 0, 0);
    }

    /**
     * Calculate scale factor to maintain constant screen-space size.
     * @param {number} viewDepth - The view-space depth (positive distance along the camera's forward direction)
     * @returns {number} The scale to apply to hotspot entities
     * @private
     */
    _calculateScreenSpaceScale(viewDepth: number) {
        // Use the canvas's CSS/client height instead of graphics device height
        const canvas = this.app.graphicsDevice.canvas;
        const screenHeight = canvas.clientHeight;

        // Use view-space depth (not Euclidean distance) to match the projection matrix
        const projMatrix = Annotation.camera.camera.projectionMatrix;
        const worldSize = (Annotation.hotspotSize / screenHeight) * ((2 * viewDepth) / projMatrix.data[5]);

        return worldSize;
    }
}
