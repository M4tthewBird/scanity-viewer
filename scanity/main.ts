// Scanity's entry point: creates the upstream viewer through its public createViewer api, then
// adds what Scanity layers on top. Nothing here edits upstream code; every hook goes through the
// returned handle (app, state, events) or the viewer's own markup, so an upstream update only
// needs this layer re-checked, not re-merged. See SCANITY.md.

import { createViewer } from '../src/index';

import { initAnnotationGaze } from './annotation-gaze';
import { initAnnotationList } from './annotation-list';
import { initBrand } from './brand';
import { initDefaults } from './defaults';
import { initJoystickFeedback } from './joystick';
import { initLoadingBar } from './loading-bar';
import { initMirrors } from './mirrors';

declare global {
    // eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- merges into Window
    interface Window {
        sseReady: Promise<{
            options: Omit<Parameters<typeof createViewer>[0], 'container' | 'settings'>;
            settings: Promise<object>;
            mirrorsUrl: string | null;
        }>;
    }
}

const { options, settings, mirrorsUrl } = await window.sseReady;

const viewer = await createViewer({ container: document.body, settings, ...options });

// the instance root createViewer built inside the container
const root = document.body.querySelector<HTMLElement>(':scope > .sse-viewer');

initDefaults(viewer);

if (mirrorsUrl) {
    initMirrors(viewer, mirrorsUrl);
}

if (options.ui !== false) {
    initBrand(root);
    initLoadingBar(viewer, root);
    initJoystickFeedback(root);
    initAnnotationList(viewer, root);
    initAnnotationGaze(viewer, root);
}
