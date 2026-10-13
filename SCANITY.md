# Scanity Viewer

The viewer behind `viewer.scanity.cz` is the [PlayCanvas SuperSplat viewer](https://github.com/playcanvas/supersplat-viewer) (MIT) with a Scanity layer on top. The repository keeps upstream's code as it is and adds Scanity in its own folder, so a new upstream release is a merge rather than a port.

Current base: **SuperSplat Viewer 1.37.0** (PlayCanvas engine 2.23.0).

## Layout

| Path | What it is |
| ---- | ---------- |
| `src/`, `rollup.config.mjs`, `README.md`, … | Upstream, unchanged apart from the marked lines below |
| `scanity/` | Everything Scanity: the page, the entry script, the theme, mirrors |
| `rollup.scanity.mjs` | Builds the Scanity viewer into `site/` |
| `netlify-upload.cmd` | Builds `site/` and opens it, ready to drag onto Netlify (see Deploying) |
| `.github/workflows/pages.yml`, `netlify.toml` | GitHub Pages deploys `site/` on every push to `main`; `netlify.toml` only matters if Netlify builds from the repo again |
| `splat-portal-mirror-tool/` | Tool for placing mirrors and exporting `mirrors.json` |
| `PRODUCT.md` | What the viewer is for and who uses it |

### The Scanity layer (`scanity/`)

| File | Does |
| ---- | ---- |
| `index.html` | The page. Resolves `?id=` to the scene folder in R2 (splat, `settings.json` or `<id>.json`, else the viewer's default settings, `poster.jpg`, `collision.glb`, `mirrors.json`, background `skybox.webp` or `background.webp`, else the colour from `settings.json`); picks WebGL for scenes with mirrors; loads Manrope |
| `main.ts` | Calls upstream's `createViewer()`, then attaches the modules below to the handle it returns |
| `theme.scss` | The Scanity look over upstream's markup: tokens, glass pills and panels, hotspots, joystick |
| `brand.ts` | Scanity logo (always visible, links to scanity.cz; its paths are shared with `loading-glow.ts`); info panel says "Scanity Viewer" and credits SuperSplat and PlayCanvas |
| `annotation-gaze.ts` | Annotations stay quietly visible (a dot from afar, the number up close); walking up to one and looking at it opens its detail without moving the camera |
| `help-panel.ts`, `help-strings.json` | The quick-start guide: opens by itself on the first visit (already while loading) with the controls of the current mode, desktop / touch tabs, "don't show again"; reopened from the info panel. Upstream's controls panel at the bottom right stays as it is |
| `annotation-links.ts` | A button in an annotation's panel that opens a page in a new tab (e.g. booking), from `"extras": { "link": { "url": …, "label": … } }` on that annotation in the scene's `settings.json` |
| `annotation-list.ts` | Clicking the annotation title opens a list of all annotations; on touch the navigator sits in the bottom row |
| `mirrors/` | Live mirror reflections from `mirrors.json`, at the quality its `quality` section asks for (see Mirror quality) |
| `defaults.ts` | Gaming controls (joystick) on by default on touch when the scene is walkable |
| `joystick.ts` | Marks the held joystick so the theme can brighten it |
| `walk-only.ts` | `?walkonly`: keeps the viewer in walk mode |
| `loading-bar.ts` | Repaints upstream's orange loading bar in Scanity blue; keeps the canvas hidden over the grey gradient until the scene has loaded (no black screen) |
| `loading-glow.ts` | "Sunlight Surprise" while loading: the Scanity mark on the grey, lit from behind by a slowly circling sun that brightens with the progress, the mark coming from a blur into focus; fades into the scene once loaded. Own WebGL2 shader, released afterwards |
| `tester.html` | Embed test page: `/tester.html?id=ikka_gym` |

### Edits inside upstream files

Kept to a minimum and marked `SCANITY`:

- `src/localization.ts`: two lines registering Czech
- `src/ui/annotations.ts`: the hotspots are hidden only by the settings toggle, not while walking with gaming controls or while the toolbar is faded out
- `src/viewer.ts`: the splat budget on phones, 1.5M in performance mode and 3M otherwise (upstream: 1M and 2M)
- `src/locales/cs.json`: Czech strings (new file)
- `package.json`: the `scanity:*` scripts
- `.gitignore`: `site`

Czech could be offered to upstream as a pull request. Once it is accepted, the first two items go away.

## Commands

```sh
npm ci                    # once
npm run scanity:develop   # rebuild on change, serve on http://localhost:3000/?id=living_room
npm run scanity:build     # build site/
npm run scanity:types     # type-check the Scanity layer together with upstream
```

The scene bucket's CORS rules allow `http://localhost:3000`, so `scanity:develop` loads the real scenes. Any other local origin or port has to be added to the bucket's CORS allowed origins in Cloudflare first.

## Scanity URL parameters

These are on top of upstream's, which are listed in `README.md`:

| Parameter | Meaning |
| --------- | ------- |
| `id` | Scene folder in the R2 bucket, e.g. `?id=living_room` |
| `mirrors` | URL of a `mirrors.json`, overriding the one in the scene folder (`?mirrors=` turns mirrors off) |
| `webgpu` | Force WebGPU even for a scene with mirrors (the reflections then show what is behind the mirror wall) |
| `walkonly` | Walk mode only, in a scene with walkable collision: no orbit, fly or animation tour, and their buttons and shortcuts are hidden; selecting an annotation still flies there, then walks on from that spot. Ignored in a scene without collision |
| `lang=cs` | Czech, also detected from the browser |

## Mirror quality (`mirrors.json`)

Every reflecting mirror renders the scene a second time, so mirrors cost frame rate. The viewer already renders each reflection only over the part of the screen the mirror covers. A `quality` section next to `mirrors` in the scene's `mirrors.json` (added by hand after exporting from the tool) tunes that per scene, without a new viewer build:

```json
{
  "quality": {
    "resolution": 0.5,
    "minOpacity": 0.2,
    "lod": 1,
    "mobile": { "resolution": 0.35, "minOpacity": 0.3, "lod": 3 }
  },
  "mirrors": [ … ]
}
```

| Key | Meaning | Without it |
| --- | ------- | ---------- |
| `resolution` | Size of the reflection as a fraction of the canvas, `0`–`1`. `0.5` renders a quarter of the pixels | `1` (full) |
| `minOpacity` | Splats fainter than this (`0`–`1`) are left out of the reflections, which saves drawing them; they still count in ministats' splat number and are still sorted | `0` (none left out) |
| `lod` | The finest LOD level reflections draw, in a LOD scene (`lod-meta.json`). The engine fills each camera's splat budget, so without it a reflection draws and sorts as many splats as the main view; at `2` it draws the third level instead (e.g. 750k of 3M). Reflections then draw a copy of the scene limited to those levels, which streams from the same files. Ignored for a single-file scene | `0` (the main view's detail) |
| `mobile` | Any of the above, used instead on phones and tablets | the values above |

## Deploying

- **GitHub Pages** (testing): every push to `main` builds and deploys automatically.
- **Netlify** (`viewer.scanity.cz`, production): manual, so that pushes do not use Netlify credits. Double-click `netlify-upload.cmd`; it builds `site/` and opens the folder. Drag that folder onto the site's **Deploys** page in Netlify. Automatic builds from GitHub are stopped in the Netlify site settings.
- The website (`scanity-website`) works the same way: its `netlify-upload.cmd` prepares `netlify-upload/` (the `deploy/` folder without editor files) to drag onto the website's Deploys page.

## Updating to a new upstream release

```sh
git fetch upstream --tags
git checkout -b upstream-X.Y.Z main
git merge vX.Y.Z                 # conflicts can only be in the marked lines above
npm ci
npm run scanity:types && npm run scanity:build
```

Then check the places where Scanity relies on upstream behaving a certain way:

1. **The page.** Run `git diff vOLD vNEW -- src/index.html`. Copy any change in its option block (`sseOptions`, new URL parameters) into `scanity/index.html`.
2. **Czech.** Compare the keys in `src/locales/en.json` with `src/locales/cs.json` and translate any new ones. A missing key shows in English.
3. **Markup the layer hooks into.** The theme and modules use upstream's class names (`sse-*`). Run `git diff vOLD vNEW -- src/ui.html src/index.scss src/ui/`. A renamed class makes an element lose the Scanity look: nothing breaks, it just looks like upstream again.
4. **Mirrors.** They plug into the engine's splat shader (`gsplatModifyVS`) and the scene's `camera` and `gsplat` entities, which are engine internals rather than a public API. After every engine update, open `?id=ikka_gym` and look at a mirror from a few angles.
5. **In the browser:** `living_room`, `sanctuaire` and `ikka_gym`, each on desktop and on a phone in portrait and landscape. Check the logo, Czech, the annotation list, the joystick in walk mode and the info panel.

Merge into `main` only after these pass; `main` deploys.
