import type { ViewerHandle } from '../src/index';

// keep in step with theme.scss: $scan-blue (the fill) and the track's ink at low opacity
const FILL = '#246bfd';
const TRACK = 'rgba(16, 17, 18, 0.08)';

// Upstream paints the loading bar's progress inline in its own orange. This handler is
// subscribed after upstream's, so on every progress event it paints over it in Scanity blue.
const initLoadingBar = (viewer: ViewerHandle, root: HTMLElement) => {
    const bar = root.querySelector<HTMLElement>('.sse-loadingBar');

    const paint = (progress: number) => {
        bar.style.backgroundImage = `linear-gradient(90deg, ${FILL} 0%, ${FILL} ${progress}%, ${TRACK} ${progress}%, ${TRACK} 100%)`;
    };

    const subscription = viewer.events.on('progress:changed', paint);
    paint(viewer.state.progress);

    return () => subscription.off();
};

export { initLoadingBar };
