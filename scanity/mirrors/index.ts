import { BoundingBox } from 'playcanvas';
import type { Entity } from 'playcanvas';

import type { ViewerHandle } from '../../src/index';

import { MirrorPortals, loadMirrors } from './mirror-portals';

// Attaches the mirror portals from mirrors.json to a viewer from the outside: the scene's
// entities are found by the names src/index.ts gives them ('camera', 'gsplat'), and the mirrors
// are posed every frame from the app's own prerender event, after the camera has moved.
const initMirrors = (viewer: ViewerHandle, mirrorsUrl: string) => {
    const { app } = viewer;
    let portals: MirrorPortals | null = null;
    let configs: Awaited<ReturnType<typeof loadMirrors>> | null = null;
    let failed = false;

    loadMirrors(mirrorsUrl)
        .then((result) => {
            configs = result;
        })
        .catch((err: Error) => {
            failed = true;
            console.warn('[mirrors] failed to load mirrors.json:', err);
        });

    // The same bound the viewer frames the scene with: the splat's custom aabb in world space
    const sceneBound = (gsplat: Entity) => {
        const bound = new BoundingBox();
        const aabb = gsplat.gsplat?.customAabb;
        if (aabb) {
            bound.setFromTransformedAabb(aabb, gsplat.getWorldTransform());
        }
        return bound;
    };

    // Created on the first frame where both the mirrors and the splat are there, so the holes
    // are cut from the scene's first visible frame
    const onPrerender = () => {
        if (portals) {
            portals.update();
            return;
        }
        if (failed) {
            app.off('prerender', onPrerender);
            return;
        }
        if (!configs) return;

        const camera = app.root.findByName('camera') as Entity | null;
        const gsplat = app.root.findByName('gsplat') as Entity | null;
        if (!camera?.camera || !gsplat?.gsplat) return;

        if (configs.length === 0) {
            app.off('prerender', onPrerender);
            return;
        }
        portals = new MirrorPortals(app, camera, configs, sceneBound(gsplat));
        portals.update();
    };

    app.on('prerender', onPrerender);

    return () => {
        app.off('prerender', onPrerender);
        portals?.destroy();
        portals = null;
    };
};

export { initMirrors };
