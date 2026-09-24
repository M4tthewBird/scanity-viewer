# Product

<!-- impeccable:product-schema 1 -->

Company-wide truth (who Scanity is, the capture and reconstruction model, the pre-launch stage, what must not be fabricated) lives in the website's record: `../scanity-website/_do-not-deploy/PRODUCT.md`. This file covers the viewer only and does not repeat it.

## Platform

web

## Users

Three audiences open a scan, all of them viewers rather than authors:

- **Visitors on scanity.cz** trying the demo embed while deciding whether Scanity is right for them.
- **Customers' own audiences** meeting the viewer embedded in a customer's page (for example a property listing) as an `<iframe>` of `viewer.scanity.cz/?id=…`. They did not choose Scanity and may not know the name; they came for the space.
- **People with a direct link**: a customer or their client opening `viewer.scanity.cz/?id=…` straight from an email, chat, or listing portal, full screen, with no surrounding page.

The job is the same for all three: explore a real space as if standing in it, on whatever device they happen to hold, without instructions from anyone.

## Product Purpose

The viewer is where a Scanity capture is actually experienced. It streams a reconstructed Gaussian-splat scene into an ordinary browser and lets the visitor look around, move through it and learn its points of interest. Success is a visitor who feels present in the space within seconds and never has to think about the software.

## Positioning

A standard splat viewer shows a model; Scanity's viewer is tuned to feel like being inside a real place: walk mode with collision against the scanned geometry, live-reflecting mirrors that behave like the real ones, curated annotation stops, and a first-run guide to the controls. Every capture is served under one Scanity address by id, so a customer embeds or shares a single link and never handles files.

## Operating Context

- Fork of the PlayCanvas SuperSplat viewer (v1.29.2, MIT). Upstream behaviour is the baseline; Scanity changes are marked in code.
- Hosted at `viewer.scanity.cz` (Netlify) and on GitHub Pages; scenes live in a Cloudflare R2 bucket, one folder per scene id, holding the splat, `settings.json`, and optional `collision.glb`, `mirrors.json` and `poster.jpg`, each detected automatically.
- Reached three ways: the scanity.cz demo embed, customer-page iframes, and direct links.
- Scenes are prepared by the Scanity team before delivery: camera start, annotations and post-effects in `settings.json`; mirrors placed in the Splat Portal Mirror Tool (`splat-portal-mirror-tool/`) and exported as `mirrors.json`; collision exported separately.
- Used on desktop (mouse and keyboard, including WASD) and on phones and tablets (touch, on-screen joystick), in portrait and landscape.

## Capabilities and Constraints

- Camera modes: orbit, fly and walk; walk and gaming controls (WASD / joystick) turn on by default when a scene has collision and is large enough to walk through.
- Annotations with a navigator (step through, or pick from the full list); how annotations should work is due to be reworked, so treat the current interaction as provisional.
- Mirrors: planar reflections from `mirrors.json`. Scenes with mirrors render on WebGL because the mirror clipping does not work in WebGPU's compute splat path; other scenes use WebGPU where available.
- AR/VR is available on WebGL only.
- UI languages: Czech, English, German, Spanish, French, Japanese, Korean, Brazilian Portuguese, Russian, Simplified Chinese; auto-detected, overridable with `?lang=`.
- The Scanity logo is always visible and links to scanity.cz, including inside customer embeds. Whether customers can get an unbranded viewer is undecided.

## Brand Commitments

Inherits the website's commitments (name, logo, Manrope, contact). The viewer's controls are meant to feel like the same brand as scanity.cz, not like a third-party player.

## Evidence on Hand

- Demo scenes currently served: `sanctuaire` (Cathedral, aerial view), `living_room` (Living room) and `ikka_gym` (Private Gym).
- `ikka_gym` is Scanity's own demo capture, not a client project: it must not be presented as a customer, reference or case study.
- No customer scenes, usage figures or performance numbers are on hand; none may be invented.

## Product Principles

1. The space leads. The interface stays out of the way of the scan and appears when it is needed.
2. Nobody arrives trained. A visitor from a listing or a shared link has no one explaining the controls, so the viewer must teach itself.
3. Any device, no install. Touch and mouse are equal citizens; nothing requires an app, a plugin or particular hardware.
4. Presence over spectacle. Features earn their place by making the capture feel more like the real place (walking, collision, true reflections), not by adding effects.
5. One Scanity. Embedded on someone else's page or opened alone, the viewer should read as the same brand as scanity.cz.
