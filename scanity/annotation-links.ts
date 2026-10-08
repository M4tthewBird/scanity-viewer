import type { ViewerHandle } from '../src/index';

// A button at the bottom of an annotation's panel that opens a page in a new tab, such as a
// booking page beside the reception. Set per annotation in the scene's settings.json:
//
//   "extras": { "link": { "url": "https://www.ikkagym.cz/rezervace", "label": "Rezervovat" } }
//
// The label is optional. Only http(s) urls are taken. Covers both panels an annotation opens
// in: upstream's, when it is selected, and the one annotation-gaze.ts opens when it is looked at.

type Link = { url: string; label: string | null };

const linkOf = (extras: unknown): Link | null => {
    const link = (extras as { link?: { url?: unknown; label?: unknown } } | null)?.link;
    if (typeof link?.url !== 'string') return null;
    try {
        const url = new URL(link.url);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
        return { url: url.href, label: typeof link.label === 'string' ? link.label : null };
    } catch {
        return null;
    }
};

// puts the annotation's link into a panel, or takes the panel's link out when it has none
const setPanelLink = (panel: HTMLElement, extras: unknown, lang: string) => {
    let anchor = panel.querySelector<HTMLAnchorElement>(':scope > .scn-annotationLink');
    const link = linkOf(extras);
    if (!link) {
        anchor?.remove();
        return;
    }
    if (!anchor) {
        anchor = document.createElement('a');
        anchor.className = 'scn-annotationLink';
        anchor.target = '_blank';
        anchor.rel = 'noopener';
        // the panel's own clicks (and the canvas beneath) stay out of it
        anchor.addEventListener('click', (event) => event.stopPropagation());
        panel.appendChild(anchor);
    }
    anchor.href = link.url;
    anchor.textContent = link.label ?? (lang === 'cs' ? 'Otevřít' : 'Open');
};

// upstream's panel, filled for the selected annotation before it is revealed (and measured)
const initAnnotationLinks = (viewer: ViewerHandle, root: HTMLElement) => {
    const { state, events, annotations } = viewer;
    const panel = root.querySelector<HTMLElement>('.sse-annotations > .sse-annotation:not(.scn-gazePanel)');
    if (!panel || !annotations.some(({ extras }) => linkOf(extras))) return;

    const update = () => {
        const selected = state.selectedAnnotation;
        setPanelLink(panel, selected === null ? null : annotations[selected]?.extras, root.lang);
    };
    events.on('selectedAnnotation:changed', update);
    update();
};

export { initAnnotationLinks, setPanelLink };
