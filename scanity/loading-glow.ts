import type { ViewerHandle } from '../src/index';

import { MARK_HEIGHT, MARK_PATHS, MARK_WIDTH } from './brand';

// "Sunlight Surprise": while the scene loads, the Scanity mark stands over the grey, lit from
// behind by a sun that circles slowly; with the loading progress the light grows and the mark
// comes into focus. Our own WebGL2 shader on a canvas of its own (over the hidden viewer canvas,
// under all of the ui); the mark's distance field and two blurs of it are made once and packed
// into one texture.
// Once the scene has loaded it fades out into the scene and its GL context is released.

const TEXTURE = 1024;
const FADE_MS = 700;
/** The light rises no faster than from dark to full in this long, so even a scene that loads at
 * once (from the cache) gets the whole sunrise. */
const RISE_S = 0.9;
/** Once loaded, the light still rises to full before the mark fades into the scene, but no longer than this. */
const FINISH_MS = 1500;

/** How far from the mark's edge its distance field reaches, texels. */
const RANGE = 48;

/** Squared distance transform along one line (Felzenszwalb and Huttenlocher), in place. */
const transformLine = (f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array) => {
    let k = 0;
    v[0] = 0;
    z[0] = -Infinity;
    z[1] = Infinity;
    for (let q = 1; q < n; q++) {
        let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        while (s <= z[k]) {
            k--;
            s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        }
        k++;
        v[k] = q;
        z[k] = s;
        z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
        while (z[k + 1] < q) k++;
        d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
    }
    f.set(d.subarray(0, n));
};

/** Squared distance from every texel to the nearest texel where `inside` equals `target`. */
const distances = (inside: Uint8Array, size: number, target: number) => {
    const grid = new Float64Array(size * size);
    for (let i = 0; i < grid.length; i++) grid[i] = inside[i] === target ? 0 : 1e20;
    const f = new Float64Array(size);
    const d = new Float64Array(size);
    const v = new Int32Array(size);
    const z = new Float64Array(size + 1);
    for (let x = 0; x < size; x++) {
        for (let y = 0; y < size; y++) f[y] = grid[y * size + x];
        transformLine(f, size, d, v, z);
        for (let y = 0; y < size; y++) grid[y * size + x] = f[y];
    }
    for (let y = 0; y < size; y++) {
        const row = grid.subarray(y * size, (y + 1) * size);
        f.set(row);
        transformLine(f, size, d, v, z);
        row.set(f);
    }
    return grid;
};

/** The mark's signed distance field (R: 0.5 on the edge, more inside, RANGE texels to either end)
 * and two blurs of it (G, B) for the light around it. The mark takes 40% of the texture, so the
 * widest blur fades out well inside it. The distance field keeps the corners sharp at any
 * softness, where a blurred mask would round them. */
const maskTexture = (size: number) => {
    const paths = MARK_PATHS.map((d) => new Path2D(d));
    const draw = (blur: number) => {
        const c = document.createElement('canvas');
        c.width = c.height = size;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.filter = blur ? `blur(${blur}px)` : 'none';
        const s = (size * 0.4) / MARK_HEIGHT;
        g.translate((size - MARK_WIDTH * s) / 2, (size - MARK_HEIGHT * s) / 2);
        g.scale(s, s);
        g.fillStyle = '#fff';
        for (const p of paths) g.fill(p);
        return g.getImageData(0, 0, size, size).data;
    };
    const mask = draw(0);
    const inside = new Uint8Array(size * size);
    for (let i = 0; i < inside.length; i++) inside[i] = mask[i * 4 + 3] >= 128 ? 1 : 0;
    const toOutside = distances(inside, size, 0);
    const toInside = distances(inside, size, 1);
    const glows = [draw(size / 42), draw(size / 13)];
    const out = new Uint8Array(size * size * 4);
    for (let i = 0; i < size * size; i++) {
        const signed = inside[i] ? Math.sqrt(toOutside[i]) - 0.5 : 0.5 - Math.sqrt(toInside[i]);
        out[i * 4] = Math.round(Math.max(0, Math.min(1, 0.5 + signed / (2 * RANGE))) * 255);
        out[i * 4 + 1] = glows[0][i * 4 + 3];
        out[i * 4 + 2] = glows[1][i * 4 + 3];
        out[i * 4 + 3] = 255;
    }
    return out;
};

const VERT = `#version 300 es
in vec2 pos;
void main() { gl_Position = vec4(pos, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
uniform sampler2D mark;
uniform vec2 res;
uniform float time;
uniform vec2 light;
uniform float reveal;
uniform float focus;
uniform float size;
uniform float lift;
uniform float range;
out vec4 color;

vec4 at(vec2 uv) {
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec4(0.0);
    return texture(mark, uv);
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
    vec2 p = (gl_FragCoord.xy - vec2(0.5, 0.5 + lift) * res) / res.y;
    vec2 uv = vec2(p.x / size + 0.5, 0.5 - p.y / size);
    vec4 m = at(uv);
    // texels from the mark's edge, positive inside (outside the texture: far outside)
    float edge = uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0 ? -range : (m.r - 0.5) * 2.0 * range;

    // ---- behind the mark: the sky and the sun ----
    // scanity.cz's grey: a diagonal from cool grey to near white
    float diag = clamp(0.5 + dot(p, normalize(vec2(1.0, -1.0))) * 0.6, 0.0, 1.0);
    vec3 col = mix(vec3(0.76, 0.79, 0.82), vec3(0.91, 0.92, 0.94), diag);
    float dl = length(p - light);
    col += vec3(1.0, 0.99, 0.97) * exp(-dl * 3.2) * 0.14 * reveal;

    // the sun spilling round the mark's edges, strongest on the side it is on
    float px = 6.0 / 1024.0;
    vec2 grad = vec2(at(uv + vec2(px, 0.0)).b - at(uv - vec2(px, 0.0)).b, at(uv - vec2(0.0, px)).b - at(uv + vec2(0.0, px)).b);
    vec2 normal = length(grad) > 1e-5 ? -normalize(grad) : vec2(0.0);
    float facing = 0.35 + 0.95 * max(0.0, dot(normal, normalize(light - p + 1e-4)));
    float outside = 1.0 - smoothstep(-2.0, 2.0, edge);
    col += vec3(1.0, 0.99, 0.98) * (m.g * 0.55 * facing * outside + m.b * 0.14) * reveal;

    // the glare, quiet: a soft glint, a faint streak and a barely-there halo
    col += vec3(1.0) * exp(-dl * 26.0) * 0.08 * reveal;
    float dy = abs(p.y - light.y);
    float dx = abs(p.x - light.x);
    col += vec3(0.97, 0.98, 1.0) * exp(-dy * 22.0) * exp(-dx * 3.0) * 0.06 * reveal;
    float ring = exp(-pow((dl - 0.6) / 0.025, 2.0));
    float hue = atan(p.y - light.y, p.x - light.x);
    col += (0.5 + 0.5 * cos(hue * 1.5 + vec3(0.0, 2.1, 4.2))) * ring * 0.02 * reveal;

    // ---- the mark, in front of it all ----
    // a cool, darker silhouette against the sun, coming into focus as the scene loads: from a
    // soft blur, still plainly the mark, to a crisp edge, reached at 95% of the way; measured from
    // the true edge, so the corners stay sharp throughout. The falloff is a logistic curve, long
    // and gentle at its ends as a lens's defocus is, and the blur clears quicker at first
    float sharp = clamp(focus / 0.95, 0.0, 1.0);
    float soft = mix(0.7, 14.0, pow(1.0 - sharp, 1.6));
    float sil = 1.0 / (1.0 + exp(-edge * 1.8 / soft));
    vec3 shade = vec3(0.45, 0.5, 0.57) + 0.04 * p.y;
    col = mix(col, shade, sil * (0.8 + 0.15 * reveal));

    // a soft shoulder for the brightest light, then grain
    vec3 over = max(col - 0.92, 0.0);
    col = min(col, vec3(0.92)) + 0.08 * (1.0 - exp(-over * 8.0));
    col += (hash(gl_FragCoord.xy + fract(time) * 97.0) - 0.5) * 0.022;
    color = vec4(col, 1.0);
}`;

const initLoadingGlow = (viewer: ViewerHandle, root: HTMLElement) => {
    if (viewer.state.loaded) return;

    // above the (hidden) viewer canvas, under all of the ui
    const canvas = document.createElement('canvas');
    canvas.className = 'scn-loadingGlow';
    canvas.setAttribute('aria-hidden', 'true');
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'low-power' });
    if (!gl) return;

    const compile = (type: number, source: string) => {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        return shader;
    };
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
    gl.useProgram(program);

    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const pos = gl.getAttribLocation(program, 'pos');
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);

    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, TEXTURE, TEXTURE, 0, gl.RGBA, gl.UNSIGNED_BYTE, maskTexture(TEXTURE));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const uniform = (name: string) => gl.getUniformLocation(program, name);
    const uRes = uniform('res');
    const uTime = uniform('time');
    const uLight = uniform('light');
    const uReveal = uniform('reveal');
    const uFocus = uniform('focus');
    gl.uniform1i(uniform('mark'), 0);
    // the mark about a quarter of the height, raised clear of the loading bar
    gl.uniform1f(uniform('size'), 0.7);
    gl.uniform1f(uniform('lift'), 0.07);
    gl.uniform1f(uniform('range'), RANGE);

    const viewerCanvas = root.querySelector(':scope > canvas');
    root.insertBefore(canvas, viewerCanvas ? viewerCanvas.nextSibling : root.firstChild);

    const resize = () => {
        const dpr = Math.min(devicePixelRatio, 2);
        canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
        canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
        gl.viewport(0, 0, canvas.width, canvas.height);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    // the light follows the loading progress, at a capped pace, eased so it swells rather than jumps
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let target = viewer.state.progress / 100;
    let shown = 0;
    // set once the scene has loaded: the light hurries to full, then the fade begins
    let finishing: (() => void) | null = null;
    const progressSubscription = viewer.events.on('progress:changed', (value: number) => {
        target = value / 100;
    });

    const start = performance.now();
    let last = start;
    let frame = 0;
    const draw = (now: number) => {
        const t = still ? 6 : (now - start) / 1000;
        const dt = Math.min(0.1, (now - last) / 1000);
        last = now;
        shown = still ? target : Math.min(target, shown + dt / RISE_S);
        if (finishing && shown >= 0.999) finishing();
        const reveal = shown * shown * (3 - 2 * shown);
        // the sun circles slowly behind the mark
        gl.uniform2f(uRes, canvas.width, canvas.height);
        gl.uniform1f(uTime, t);
        gl.uniform2f(uLight, 0.16 * Math.sin(t * 0.35), 0.05 + 0.11 * Math.cos(t * 0.27));
        gl.uniform1f(uReveal, reveal * (0.92 + 0.08 * Math.sin(t * 0.9)));
        gl.uniform1f(uFocus, reveal);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    requestAnimationFrame(() => canvas.classList.add('scn-shown'));

    const loadedSubscription = viewer.events.on('loaded:changed', (loaded: boolean) => {
        if (!loaded) return;
        loadedSubscription.off();
        progressSubscription.off();
        target = 1;
        const fallback = setTimeout(() => finishing?.(), FINISH_MS);
        finishing = () => {
            finishing = null;
            clearTimeout(fallback);
            canvas.classList.remove('scn-shown');
            setTimeout(() => {
                cancelAnimationFrame(frame);
                observer.disconnect();
                gl.getExtension('WEBGL_lose_context')?.loseContext();
                canvas.remove();
            }, FADE_MS);
        };
    });
};

export { initLoadingGlow };
