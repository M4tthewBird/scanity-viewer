# Splat Portal Mirror Tool

Real-time mirrors, windows and portals inside Gaussian Splat scenes, in the
browser. Built on PlayCanvas — the same engine behind SuperSplat.

Live version: https://portalmirror.atlux.one
By Jorge Valle Hurtado — https://atlux.one

---

## What you have

One file: `portal-mirror.html`. That is the entire tool — markup, CSS, shaders
and application code. There is no build step, no bundler and no dependency
install. PlayCanvas is pulled at runtime from a CDN via an import map:

    "playcanvas": "https://cdn.jsdelivr.net/npm/playcanvas@2.20.6/+esm"

Pin a different version there if you need one.

## Running it

It must be served over http:// or https:// — **not** opened as a `file://`
path. It is an ES module and it uses `fetch`, both of which browsers block on
the file protocol. Any static host works: Apache, nginx, GitHub Pages, Netlify,
or for a quick local look:

    python -m http.server 8080
    # then open http://localhost:8080/portal-mirror.html

## Pointing it at your own splats

Two constants near the top of the script block:

    const SPLAT_URL      = "";    // load a scene automatically on page open
    const DEMO_SPLAT_URL = "...";  // what the demo thumbnail button loads

**Your splat host must send CORS headers.** The tool fetches splat data with
`fetch(url, { mode: "cors" })` so it can report byte progress, which means the
server holding your `.ply`/`.sog` must return:

    Access-Control-Allow-Origin: https://your-site.example
    Access-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges

Serving the splat from the same origin as the HTML avoids the issue entirely,
and is the simplest setup.

The failure signature is worth knowing in advance, because it is misleading:
the page, the panels and all the icons load perfectly and only the splat fails.
Icons are `<img>` and CSS backgrounds, which need no CORS — so a CORS problem
looks like a broken splat loader. Check the browser console first.

## Assets that will not load for you

The bundled URLs point at `atlux.one`, and that host only allows
`portalmirror.atlux.one` as an origin. So on your server:

- **The demo splat** will fail. Replace `DEMO_SPLAT_URL` with your own scene,
  or delete the thumbnail button.
- **The default "Atlux Standard" HDRI** will fail. The other entries in
  `HDRI_OPTIONS` come from public GitHub raw URLs and work anywhere, so switch
  `HDRI_DEFAULT` to one of those, or host your own.
- **Toolbar icons and the footer logo** will load fine (no CORS needed), but
  they hotlink to `atlux.one`. Copy them locally if you would rather not depend
  on someone else's uptime.

## Formats

`.ply`, `.sog`, `.splat`, `.ksplat`, `.spz` — via drag-and-drop, the file
picker, or a URL. The extension matters: it is how the loader picks a parser,
so a URL without one falls through to the PLY path and fails with
"Invalid ply header".

## URL parameters

- `?embed=1&s=<base64url JSON>` — renders a scene with no UI, for `<iframe>`
  embedding. The JSON shape is whatever `serializeScene()` produces; `publish()`
  in the source builds these links and is left intact if you want to wire it to
  an upload endpoint of your own.
- `?always` — disables render-on-demand and draws every frame. Diagnostic: if a
  visual artefact disappears under `?always`, something is changing the scene
  without asking for a redraw.
- `?webgl` — force the WebGL backend instead of WebGPU.

## Two things to know before you modify it

**Render-on-demand.** The tool only draws when something changed, because a
frame costs a full splat pass plus one reflection pass per portal. Camera and
portal movement are detected automatically by a matrix diff. Anything else that
changes the image — a material uniform, a mesh swap, toggling visibility — must
call `requestRender()` itself. If you add a control and its effect only appears
once you nudge the camera, that is the missing call. Confirm with `?always`.

**Reflection cameras are gated on visibility alone, never a dirty flag.**
Disabling a camera drops it from the layer composition, which makes the engine
destroy its per-camera sorter and rebuild it on re-enable, which reports as
"streaming advanced", which requests another frame — a loop that never settles.
There is a long comment at that spot in the source. Believe it.

## License

MIT. In short: use it, change it, ship it, sell what you build with it — just
keep the copyright and permission notice, and understand there is no warranty.
Full text in `LICENSE`.

Attribution beyond the notice is not required, but a link back to
https://portalmirror.atlux.one is appreciated.

**Not covered by this license:** the Evermotion Archinteriors demo scene, the
Atlux logo and wordmark, and the HDRIs referenced from third-party URLs. Those
belong to their respective owners and are not yours to redistribute — which is
another reason to point the tool at your own assets.