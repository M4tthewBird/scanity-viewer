import { OrbitController as OrbitControllerPC, Pose, Vec2 } from 'playcanvas';
import type { BoundingBox } from 'playcanvas';

import type { Camera, CameraFrame, CameraController } from './camera';
import { DEFAULT_CONTROLLER_DAMPING } from './camera-utils';

const p = new Pose();

// SCANITY: set by ?orbitonly (scanity/orbit-only.ts) before the viewer is created: the orbit stays on
// the object, its focus near the middle of the scene's box (within FOCUS of its half size each way) and
// its distance between NEAR and FAR times the box's half diagonal, so a visitor can neither zoom into the
// object nor drift away from it
const scanityOrbit = { bounded: false };
const SCANITY_FOCUS = 0.3;
const SCANITY_NEAR = 0.75;
const SCANITY_FAR = 5;

class OrbitController implements CameraController {
    controller: OrbitControllerPC;

    fov = 90;

    // SCANITY: the nearest distance the orbit allows, see bound()
    private minDistance = 0.01;

    constructor() {
        this.controller = new OrbitControllerPC();
        this.controller.zoomRange = new Vec2(0.01, Infinity);
        this.controller.pitchRange = new Vec2(-90, 90);
        this.controller.rotateDamping = DEFAULT_CONTROLLER_DAMPING;
        this.controller.moveDamping = DEFAULT_CONTROLLER_DAMPING;
        this.controller.zoomDamping = DEFAULT_CONTROLLER_DAMPING;
    }

    onEnter(camera: Camera): void {
        this._attach(camera);
    }

    update(deltaTime: number, inputFrame: CameraFrame, camera: Camera) {
        const pose = this.controller.update(inputFrame, deltaTime);

        camera.position.copy(pose.position);
        camera.angles.copy(pose.angles);
        camera.distance = pose.distance;
        camera.fov = this.fov;
    }

    onExit(_camera: Camera) {
        // no cleanup needed
    }

    goto(camera: Camera) {
        this.fov = camera.fov;
        this._attach(camera);
    }

    // SCANITY: keeps the orbit on the object in the box (see scanityOrbit)
    bound(box: BoundingBox) {
        const { center: c, halfExtents: h } = box;
        const root = (this.controller as unknown as { _targetRootPose: Pose })._targetRootPose;
        const f = SCANITY_FOCUS;
        root.xRange.set(c.x - h.x * f, c.x + h.x * f);
        root.yRange.set(c.y - h.y * f, c.y + h.y * f);
        root.zRange.set(c.z - h.z * f, c.z + h.z * f);
        const radius = h.length();
        this.minDistance = radius * SCANITY_NEAR;
        this.controller.zoomRange = new Vec2(this.minDistance, radius * SCANITY_FAR);
    }

    private _attach(camera: Camera) {
        p.position.copy(camera.position);
        p.angles.copy(camera.angles);
        p.distance = Math.max(camera.distance, this.minDistance);
        this.controller.attach(p, false);
    }
}

export { OrbitController, scanityOrbit };
