// The Scanity joystick ("Joystick 2a") is upstream's joystick restyled in theme.scss: faint
// until touched, full strength while held. Upstream does not mark the held state, so this does,
// as `scn-held` on the base, following the same pointer the base captures.
const initJoystickFeedback = (root: HTMLElement) => {
    const base = root.querySelector<HTMLElement>('.sse-joystickBase');

    const hold = () => base.classList.add('scn-held');
    const release = () => base.classList.remove('scn-held');

    base.addEventListener('pointerdown', hold);
    base.addEventListener('pointerup', release);
    base.addEventListener('pointercancel', release);
    base.addEventListener('lostpointercapture', release);

    return () => {
        base.removeEventListener('pointerdown', hold);
        base.removeEventListener('pointerup', release);
        base.removeEventListener('pointercancel', release);
        base.removeEventListener('lostpointercapture', release);
    };
};

export { initJoystickFeedback };
