import { scanityOrbit } from '../src/cameras/orbit-controller';
import type { ViewerHandle } from '../src/index';

// the info panel's shortcuts for the modes this takes away
const HIDDEN_SHORTCUTS = [
    'help.action.orbit-mode',
    'help.action.fly-mode',
    'help.action.toggle-walk'
];

// `?orbitonly`: an object seen from around it only, as a product scan. Called before the viewer
// is created, so the orbit is bounded from the start: its focus stays inside the scene's box and
// its distance between close up and a few times the object's size (see `scanityOrbit` in
// src/cameras/orbit-controller.ts), so a visitor can neither zoom into the object nor lose it.
const prepareOrbitOnly = () => {
    scanityOrbit.bounded = true;
};

// After creation: the animation tour stays (a scene whose start mode is the tour plays it first,
// and the play button brings it back); every other way out of orbit (the toolbar, the 2 / 3
// shortcuts, walk) sets the camera mode, so whenever it goes to fly or walk this puts it back in
// orbit. The mode buttons and their shortcuts are hidden (see `.scn-orbitOnly` in theme.scss).
const initOrbitOnly = (viewer: ViewerHandle, root: HTMLElement) => {
    const { state, events } = viewer;
    root.classList.add('scn-orbitOnly');
    for (const key of HIDDEN_SHORTCUTS) {
        root.querySelector(`.sse-infoShortcut [data-i18n="${key}"]`)?.closest('.sse-infoShortcut')?.classList.add('sse-hidden');
    }
    const stayInOrbit = () => {
        if (state.cameraMode === 'fly' || state.cameraMode === 'walk') state.cameraMode = 'orbit';
    };
    const subscriptions = [events.on('cameraMode:changed', stayInOrbit), events.on('loaded:changed', stayInOrbit)];
    stayInOrbit();
    return () => {
        for (const subscription of subscriptions) subscription.off();
        root.classList.remove('scn-orbitOnly');
    };
};

export { prepareOrbitOnly, initOrbitOnly };
