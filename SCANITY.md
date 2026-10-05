# Scanity Viewer

The viewer behind `viewer.scanity.cz` is the [PlayCanvas SuperSplat viewer](https://github.com/playcanvas/supersplat-viewer) (MIT) with a Scanity layer on top. The repository keeps upstream's code as it is and adds Scanity in its own folder, so a new upstream release is a merge rather than a port.

Current base: **SuperSplat Viewer 1.37.0** (PlayCanvas engine 2.23.0).

## Layout

| Path | What it is |
| ---- | ---------- |
| `src/`, `rollup.config.mjs`, `README.md`, … | Upstream, unchanged apart from the marked lines below |
| `scanity/` | Everything Scanity: the page, the entry script, the theme, mirrors |
| `rollup.scanity.mjs` | Builds the Scanity viewer into `site/` |
| `netlify.toml`, `.github/workflows/pages.yml` | Deploy `site/` (Netlify, GitHub Pages) |
| `splat-portal-mirror-tool/` | Tool for placing mirrors and exporting `mirrors.json` |
| `PRODUCT.md` | What the viewer is for and who uses it |

### The Scanity layer (`scanity/`)

| File | Does |
| ---- | ---- |
| `index.html` | The page. Resolves `?id=` to the scene folder in R2 (splat, `settings.json`, `poster.jpg`, `collision.glb`, `mirrors.json`); picks WebGL for scenes with mirrors; loads Manrope |
| `main.ts` | Calls upstream's `createViewer()`, then attaches the modules below to the handle it returns |
| `theme.scss` | The Scanity look over upstream's markup: tokens, glass pills and panels, hotspots, joystick |
| `brand.ts` | Scanity logo (always visible, links to scanity.cz); info panel says "Scanity Viewer" and credits SuperSplat and PlayCanvas |
| `annotation-list.ts` | Clicking the annotation title opens a list of all annotations; on touch the navigator sits in the bottom row |
| `mirrors/` | Live mirror reflections from `mirrors.json` |
| `defaults.ts` | Gaming controls (joystick) on by default on touch when the scene is walkable |
| `joystick.ts` | Marks the held joystick so the theme can brighten it |
| `loading-bar.ts` | Repaints upstream's orange loading bar in Scanity blue |
| `tester.html` | Embed test page: `/tester.html?id=ikka_gym` |

### Edits inside upstream files

Kept to a minimum and marked `SCANITY`:

- `src/localization.ts`: two lines registering Czech
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
| `lang=cs` | Czech, also detected from the browser |

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
