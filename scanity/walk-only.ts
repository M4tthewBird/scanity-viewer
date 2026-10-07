import { Mat4 } from 'playcanvas';
import type { Entity, Vec3 } from 'playcanvas';

import type { ViewerHandle } from '../src/index';

// the info panel's shortcuts for the modes this takes away
const HIDDEN_SHORTCUTS = [
    'help.action.orbit-mode',
    'help.action.fly-mode',
    'help.action.toggle-walk',
    'help.action.play-pause'
];

// an annotation move has arrived once the camera has held still this long
const SETTLE_MS = 250;

// after arriving, walking this far (on the floor plane, scene units) from where the move ended
// closes the annotation's panel, so it does not stay pinned to the edge of the view; looking at
// an annotation up close opens it again (scanity/annotation-gaze.ts)
const LEAVE_DISTANCE = 1.5;

// `?walkonly`: a scene explored on foot only. Applies once the scene's collision has loaded and
// allows walking; a scene without walkable collision is left as it is, since there is no walk
// mode to keep it in.
//
// Every way into another mode (the toolbar, the 1 / 2 / 3 shortcuts, Esc out of walk, the
// animation tour, a scene whose start mode is orbit, fly or the tour) sets the camera mode, so
// whenever it leaves walk this puts it back. The one exception is selecting an annotation (its
// hotspot, the navigator, the list): upstream flies there in orbit, and that move is let run;
// once the camera has arrived and come to rest it goes back to walk, which stands on the floor
// nearest the annotation's view, so the visitor walks on from there. The mode toggle, playback
// and the shortcuts for them are hidden (see `.scn-walkOnly` in theme.scss).
const initWalkOnly = (viewer: ViewerHandle, root: HTMLElement) => {
    const { app, state, events } = viewer;
    const camera = app.root.findByName('camera') as Entity | null;

    const shortcuts = HIDDEN_SHORTCUTS.map((key) =>
        root.querySelector(`.sse-infoShortcut [data-i18n="${key}"]`)?.closest('.sse-infoShortcut')
    ).filter((row): row is Element => !!row);

    // an annotation move in progress: orbit is allowed until the camera has arrived
    let travelling = false;
    let stillSince = 0;
    const lastWorld = new Mat4();

    // where the last annotation move ended, while its annotation is still selected
    let arrivedAt: Vec3 | null = null;

    const backToWalk = () => {
        if (travelling && camera) arrivedAt = camera.getPosition().clone();
        travelling = false;
        if (state.walkAllowed && state.cameraMode !== 'walk') state.cameraMode = 'walk';
    };

    const stayInWalk = () => {
        if (!state.walkAllowed) return;
        root.classList.add('scn-walkOnly');
        shortcuts.forEach((row) => row.classList.add('sse-hidden'));
        if (state.cameraMode === 'walk' || travelling) return;

        // An annotation selection sets the mode first and the selection right after, in the
        // same call, so wait for that before deciding
        queueMicrotask(() => {
            if (state.cameraMode === 'walk') return;
            if (state.cameraMode === 'orbit' && state.selectedAnnotation !== null && camera) {
                travelling = true;
                arrivedAt = null;
                stillSince = performance.now();
                lastWorld.copy(camera.getWorldTransform());
            } else {
                backToWalk();
            }
        });
    };

    // follows the annotation move to its end
    const onUpdate = () => {
        if (!camera) return;
        if (arrivedAt) {
            const pos = camera.getPosition();
            if (state.selectedAnnotation === null) {
                arrivedAt = null;
            } else if (Math.hypot(pos.x - arrivedAt.x, pos.z - arrivedAt.z) > LEAVE_DISTANCE) {
                arrivedAt = null;
                viewer.selectAnnotation(null);
            }
        }
        if (!travelling) return;
        if (state.cameraMode !== 'orbit') {
            travelling = false;
            stayInWalk();
            return;
        }
        const world = camera.getWorldTransform();
        const now = performance.now();
        if (!world.equals(lastWorld)) {
            lastWorld.copy(world);
            stillSince = now;
        } else if (now - stillSince >= SETTLE_MS) {
            backToWalk();
        }
    };

    const subscriptions = [events.on('walkAllowed:changed', stayInWalk), events.on('cameraMode:changed', stayInWalk)];
    app.on('update', onUpdate);
    stayInWalk();

    return () => {
        for (const subscription of subscriptions) subscription.off();
        app.off('update', onUpdate);
        root.classList.remove('scn-walkOnly');
    };
};

export { initWalkOnly };
