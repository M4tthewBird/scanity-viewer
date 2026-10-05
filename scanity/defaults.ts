import type { ViewerHandle } from '../src/index';

// A scene with walkable collision is meant to be walked through, so on touch it starts with
// gaming controls (the joystick) rather than leaving the visitor to find the setting. Upstream
// already starts such a scene in walk mode. Desktop is left alone: gaming controls there capture
// the mouse, which a browser only allows after a click, and click-to-walk works without it.
const initDefaults = (viewer: ViewerHandle) => {
    const { state, events } = viewer;

    const apply = () => {
        if (state.walkAllowed && state.inputMode === 'touch' && !state.gamingControls) {
            state.gamingControls = true;
        }
    };

    // walkAllowed turns true once the collision data has arrived, which can be after the reveal
    const subscription = events.on('walkAllowed:changed', apply);
    apply();

    return () => subscription.off();
};

export { initDefaults };
