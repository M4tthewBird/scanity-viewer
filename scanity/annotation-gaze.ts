import { Vec3 } from 'playcanvas';
import type { Entity } from 'playcanvas';

import type { ViewerHandle } from '../src/index';
import type { ScenePicker } from '../src/picker';

import { setPanelLink } from './annotation-links';

// Within this distance of the camera (scene units, metres in Scanity's captures) a hotspot
// shows its number instead of a dot, and can open by being looked at
const NEAR_DISTANCE = 3;

// "Looked at": the annotation is at most this many degrees from the centre of the view
const GAZE_ANGLE = 12;

// Once open, the panel stays while the annotation is this near and this close to the centre,
// so it does not flicker at the edge of the thresholds above
const HOLD_DISTANCE = NEAR_DISTANCE * 1.25;
const HOLD_ANGLE = 22;

// The gaze has to rest this long before the panel opens, and leave for this long before it
// closes, so sweeping the view across a hotspot does not flash its panel
const OPEN_DELAY_MS = 350;
const CLOSE_DELAY_MS = 500;

// How often the annotation being looked at is tested against the scene, and how long a result
// counts. The same test upstream's occlusion fading uses (the picker), with its thresholds: the
// scene in front must be at least half opaque to cover, and only content more than 10% nearer
// than the annotation counts as in front, since the annotation sits on the surface it describes
const TEST_INTERVAL_MS = 250;
const RESULT_TTL_MS = 800;
const OCCLUDING_OPACITY = 0.5;
const OCCLUSION_TOLERANCE = 0.1;
const TEST_RADIUS_PX = 13;

// A test's answer counts only if the camera, while the test ran, moved less than this share of
// the annotation's depth (half the occlusion tolerance) and turned less than a degree
const MAX_MOVE_SHARE = OCCLUSION_TOLERANCE / 2;
const MIN_TURN_COS = Math.cos((1 * Math.PI) / 180);

// the panel beside its hotspot, as upstream places the selected annotation's panel
const PANEL_MARGIN = 8;
const PANEL_OFFSET = 24;

// Annotations that open by looking at them. Upstream opens an annotation's panel only when it is
// selected, which flies the camera to it. Here, walking up to an annotation and looking at it
// opens a panel of the same look beside its hotspot, without moving the camera; looking away or
// walking off closes it. Selecting an annotation (its hotspot, the navigator, the list) still
// flies there and shows upstream's own panel, and this one stands aside meanwhile.
//
// Whether the scene covers the annotation is tested here, for the one being looked at, while
// the camera moves too. Upstream's own test (its `sse-occluded` fading) runs only once the
// camera has come to a stop, so it cannot be waited on while walking.
//
// Also marks each hotspot for the theme: `scn-near` within NEAR_DISTANCE (number shown instead
// of a dot) and `scn-gazed` for the one whose panel is open.
const initAnnotationGaze = (viewer: ViewerHandle, root: HTMLElement) => {
    const { app, state, events, annotations } = viewer;
    const layer = root.querySelector<HTMLElement>('.sse-annotations');
    const camera = app.root.findByName('camera') as Entity | null;
    if (!layer || !camera?.camera || annotations.length === 0) return null;

    // upstream adds one hotspot per annotation, in order
    const hotspots = Array.from(layer.querySelectorAll<HTMLElement>('.sse-annotation-hotspot'));
    const canvas = app.graphicsDevice.canvas as HTMLCanvasElement;
    const positions = annotations.map(({ position }) => new Vec3(position[0], position[1], position[2]));

    // the viewer's picker, published once the scene has loaded
    let picker: ScenePicker | null = null;
    const pickerSubscription = events.on('picker:ready', (value: ScenePicker) => {
        picker = value;
    });

    // the panel: upstream's annotation panel markup, so the theme styles it the same
    const panel = document.createElement('div');
    panel.className = 'sse-annotation scn-gazePanel';
    const titleDom = document.createElement('div');
    titleDom.className = 'sse-annotation-title';
    const textDom = document.createElement('div');
    textDom.className = 'sse-annotation-text';
    panel.append(titleDom, textDom);
    layer.appendChild(panel);

    let open = -1;
    let candidate = -1;
    let candidateSince = 0;
    let lostSince = 0;

    // the latest scene test per annotation: whether it was in view, and when
    const visibility = new Map<number, { visible: boolean; at: number }>();
    let testing = false;

    const toTarget = new Vec3();
    const screen = new Vec3();
    const viewPos = new Vec3();
    const requestPos = new Vec3();
    const requestForward = new Vec3();

    const measure = (index: number) => {
        toTarget.sub2(positions[index], camera.getPosition());
        const distance = toTarget.length();
        const cos = distance > 0 ? toTarget.dot(camera.forward) / distance : 1;
        const angle = (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI;
        return { distance, angle };
    };

    // true or false from a recent test; null when there is none yet
    const isVisible = (index: number, now: number) => {
        const result = visibility.get(index);
        return result && now - result.at <= RESULT_TTL_MS ? result.visible : null;
    };

    const hasContent = (index: number) => !!(annotations[index].title || annotations[index].text);

    const enabled = () =>
        state.loaded &&
        state.showAnnotations &&
        state.selectedAnnotation === null &&
        state.cameraMode !== 'anim' &&
        state.xrMode === null;

    // Test one annotation against the scene. Run between frames, from a timer: the picker's
    // render can come out empty when it is asked for during a frame
    const test = async (index: number) => {
        if (!picker || testing) return;
        // the view depth from the entity's own transform: the camera's view matrix is refreshed
        // only for frames that render
        viewPos.sub2(positions[index], camera.getPosition());
        const depth = viewPos.dot(camera.forward);
        if (depth <= 0) return;
        camera.camera.worldToScreen(positions[index], screen);
        const width = canvas.clientWidth;
        const height = canvas.clientHeight;
        if (screen.x < 0 || screen.x >= width || screen.y < 0 || screen.y >= height) return;

        // The picker renders when the request reaches the front of its queue, not now, and the
        // point and depth are this pose's. A camera that moved on meanwhile makes the answer
        // one about a different pose, so it is dropped and the next tick asks again
        requestPos.copy(camera.getPosition());
        requestForward.copy(camera.forward);

        testing = true;
        try {
            const [opacity] = await picker.pickVisibility(
                [{ x: screen.x / width, y: screen.y / height, depth: depth * (1 - OCCLUSION_TOLERANCE) }],
                TEST_RADIUS_PX / height
            );
            const moved = requestPos.distance(camera.getPosition()) > depth * MAX_MOVE_SHARE;
            const turned = requestForward.dot(camera.forward) < MIN_TURN_COS;
            if (!moved && !turned) {
                visibility.set(index, { visible: (opacity ?? 0) < OCCLUDING_OPACITY, at: performance.now() });
            }
        } catch {
            // a failed read-back (a lost device, say): the next tick tests again
        } finally {
            testing = false;
        }
    };

    // the annotation that needs a test: the open one, else the one being looked at, once its last
    // result is about to run out. Each test may render the scene for the picker, so no more often
    const testTimer = setInterval(() => {
        const index = open >= 0 ? open : candidate;
        const last = visibility.get(index);
        if (index >= 0 && (!last || performance.now() - last.at >= RESULT_TTL_MS - TEST_INTERVAL_MS)) {
            test(index);
        }
    }, TEST_INTERVAL_MS);

    const place = () => {
        camera.camera.worldToScreen(positions[open], screen);
        const vw = canvas.clientWidth;
        const vh = canvas.clientHeight;
        const tw = panel.offsetWidth;
        const th = panel.offsetHeight;

        // to the right of the hotspot, or the left when it does not fit there
        let flipped = screen.x + PANEL_OFFSET + tw > vw - PANEL_MARGIN;
        if (flipped && screen.x - PANEL_OFFSET - tw < PANEL_MARGIN) flipped = false;
        let left = flipped ? screen.x - PANEL_OFFSET - tw : screen.x + PANEL_OFFSET;
        let top = screen.y - th / 2;
        left = Math.max(PANEL_MARGIN, Math.min(left, vw - tw - PANEL_MARGIN));
        top = Math.max(PANEL_MARGIN, Math.min(top, vh - th - PANEL_MARGIN));

        panel.style.setProperty('--arrow-top', `${Math.max(16, Math.min(screen.y - top, th - 16))}px`);
        panel.classList.toggle('sse-arrow-right', !flipped);
        panel.classList.toggle('sse-arrow-left', flipped);
        panel.style.transform = `translate(${left}px, ${top}px)`;
    };

    const setOpen = (index: number) => {
        if (open === index) return;
        if (open >= 0) hotspots[open]?.classList.remove('scn-gazed');
        open = index;
        if (open < 0) {
            panel.classList.remove('sse-visible');
            return;
        }
        titleDom.textContent = annotations[open].title ?? '';
        textDom.textContent = annotations[open].text ?? '';
        setPanelLink(panel, annotations[open].extras, root.lang);
        hotspots[open]?.classList.add('scn-gazed');
        place();
        panel.classList.add('sse-visible');
    };

    // every app tick, after the viewer's own update has moved the camera
    const onUpdate = () => {
        const now = performance.now();
        const active = enabled();

        // the one most nearly at the centre of the view, among those near enough; not one a
        // test has found covered
        let best = -1;
        let bestAngle = Infinity;
        for (let i = 0; i < positions.length; i++) {
            const { distance, angle } = measure(i);
            hotspots[i]?.classList.toggle('scn-near', distance <= NEAR_DISTANCE);
            if (
                active &&
                distance <= NEAR_DISTANCE &&
                angle <= GAZE_ANGLE &&
                angle < bestAngle &&
                isVisible(i, now) !== false &&
                hasContent(i)
            ) {
                best = i;
                bestAngle = angle;
            }
        }

        if (!active) {
            candidate = -1;
            setOpen(-1);
            return;
        }

        if (open >= 0) {
            const { distance, angle } = measure(open);
            const holds = distance <= HOLD_DISTANCE && angle <= HOLD_ANGLE && isVisible(open, now) !== false;
            if (holds) {
                lostSince = 0;
            } else if (!lostSince) {
                lostSince = now;
            } else if (now - lostSince >= CLOSE_DELAY_MS) {
                lostSince = 0;
                setOpen(-1);
            }
            if (open >= 0) {
                place();
                return;
            }
        }

        // opens once the gaze has rested and a test since then has found it in view
        if (best !== candidate) {
            candidate = best;
            candidateSince = now;
        } else if (candidate >= 0 && now - candidateSince >= OPEN_DELAY_MS && isVisible(candidate, now) === true) {
            setOpen(candidate);
        }
    };

    app.on('update', onUpdate);

    return () => {
        app.off('update', onUpdate);
        clearInterval(testTimer);
        pickerSubscription.off();
        setOpen(-1);
        hotspots.forEach((hotspot) => hotspot.classList.remove('scn-near', 'scn-gazed'));
        panel.remove();
    };
};

export { initAnnotationGaze };
