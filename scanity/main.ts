// Scanity's entry point: creates the upstream viewer through its public createViewer api, then
// adds what Scanity layers on top. Nothing here edits upstream code; every hook goes through the
// returned handle (app, state, events) or the viewer's own markup, so an upstream update only
// needs this layer re-checked, not re-merged. See SCANITY.md.

import { createViewer } from '../src/index';
import { defaultSettings, validateSettings } from '../src/settings';

import { initAnnotationGaze } from './annotation-gaze';
import { initAnnotationLinks } from './annotation-links';
import { initAnnotationList } from './annotation-list';
import { initBrand } from './brand';
import { initDefaults } from './defaults';
import { initHelpPanel } from './help-panel';
import { initJoystickFeedback } from './joystick';
import { initLoadingBar, initLoadingCover } from './loading-bar';
import { initLoadingGlow } from './loading-glow';
import { initMirrors } from './mirrors';
import { initWalkOnly } from './walk-only';

declare global {
    // eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- merges into Window
    interface Window {
        sseReady: Promise<{
            options: Omit<Parameters<typeof createViewer>[0], 'container' | 'settings'>;
            /** The scene's settings file as found by index.html, or null when there was none */
            settings: Promise<object | null>;
            mirrorsUrl: string | null;
        }>;
    }
}

const { options, settings, mirrorsUrl } = await window.sseReady;

// Settings that are missing or not settings at all would stop the viewer before it shows
// anything; the scene still loads with the viewer's defaults instead (its background colour and
// a camera framing the whole scene)
const sceneSettings = settings.then((json) => {
    if (json) {
        try {
            validateSettings(json);
            return json;
        } catch (err) {
            console.warn('[scanity] the scene settings are not valid, using defaults:', err);
        }
    } else {
        console.warn('[scanity] no scene settings found (settings.json), using defaults');
    }
    return defaultSettings();
});

const viewer = await createViewer({ container: document.body, settings: sceneSettings, ...options });

// the instance root createViewer built inside the container
const root = document.body.querySelector<HTMLElement>(':scope > .sse-viewer');

initDefaults(viewer);
initLoadingCover(viewer, root);
initLoadingGlow(viewer, root);

if (new URL(location.href).searchParams.has('walkonly')) {
    initWalkOnly(viewer, root);
}

if (mirrorsUrl) {
    initMirrors(viewer, mirrorsUrl);
}

if (options.ui !== false) {
    initBrand(root);
    initLoadingBar(viewer, root);
    initJoystickFeedback(root);
    initAnnotationList(viewer, root);
    initAnnotationGaze(viewer, root);
    initAnnotationLinks(viewer, root);
    initHelpPanel(viewer, root);
}
