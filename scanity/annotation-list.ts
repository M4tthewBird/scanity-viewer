import type { ViewerHandle } from '../src/index';

const chevronSvg =
    '<svg class="scn-annotationChevron" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">' +
    '<path d="m6 9 6 6 6-6"/></svg>';

// Two Scanity additions to upstream's annotation navigator:
//   - Clicking its title opens a list of every annotation to jump to directly: dropping down
//     under the bar on desktop, opening upward from it on touch. Upstream's own title click
//     (re-selecting the last annotation after its panel closed) is replaced by the list.
//   - On touch the navigator is one more pill in the bottom controls row, in place of the row's
//     spacer, instead of upstream's two arrows on the screen edges; on desktop it goes back to
//     its own place at the top.
// Upstream's annotation-controls.ts keeps driving the bar itself (number, title, arrows,
// visibility, fading), whichever parent it is in.
const initAnnotationList = (viewer: ViewerHandle, root: HTMLElement) => {
    const { state, events, annotations } = viewer;
    if (annotations.length < 2) return null;

    const ui = root.querySelector<HTMLElement>('.sse-ui');
    const nav = root.querySelector<HTMLElement>('.sse-annotationNav');
    const info = nav.querySelector<HTMLElement>('.sse-annotationInfo');
    const spacer = root.querySelector<HTMLElement>('.sse-buttonsContainer > .sse-spacer');

    // the title opens the list
    info.setAttribute('role', 'button');
    info.tabIndex = 0;
    info.setAttribute('aria-haspopup', 'listbox');
    info.setAttribute('aria-expanded', 'false');
    info.insertAdjacentHTML('beforeend', chevronSvg);

    // outside the bar, so the bar's rounded clipping does not cut it off
    const list = document.createElement('div');
    list.className = 'scn-annotationList sse-hidden';
    list.setAttribute('role', 'listbox');
    ui.appendChild(list);

    let currentIndex = state.selectedAnnotation ?? 0;

    const items = annotations.map((annotation, index) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.setAttribute('role', 'option');

        const number = document.createElement('span');
        number.className = 'scn-annotationListIndex';
        number.textContent = String(index + 1);

        const title = document.createElement('span');
        title.className = 'scn-annotationListTitle';
        title.textContent = annotation.title ?? '';

        item.append(number, title);
        item.addEventListener('click', (event) => {
            event.stopPropagation();
            setOpen(false);
            viewer.selectAnnotation(index);
        });
        return item;
    });
    list.append(...items);

    // scroll the list itself, rather than the ui's wheel forwarding zooming the camera
    list.addEventListener('wheel', (event) => event.stopPropagation());

    const isOpen = () => !list.classList.contains('sse-hidden');

    const setOpen = (open: boolean) => {
        list.classList.toggle('sse-hidden', !open);
        info.setAttribute('aria-expanded', String(open));
        if (open) items[currentIndex]?.scrollIntoView({ block: 'nearest' });
    };

    const updateSelection = () => {
        currentIndex = state.selectedAnnotation ?? currentIndex;
        items.forEach((item, index) => {
            item.classList.toggle('scn-active', index === currentIndex);
            item.setAttribute('aria-selected', String(index === currentIndex));
        });
    };

    // the bar's place: in the controls row on touch, at the top on desktop
    const home = { parent: nav.parentElement, next: nav.nextSibling };
    const updatePlacement = () => {
        const touch = state.inputMode === 'touch';
        if (touch && spacer) {
            if (nav.nextSibling !== spacer) spacer.before(nav);
        } else if (nav.parentElement !== home.parent) {
            home.parent.insertBefore(nav, home.next);
        }
        list.classList.toggle('scn-touch', touch);
        list.classList.toggle('scn-desktop', !touch);
    };

    const updateVisibility = () => {
        if (state.controlsHidden || !state.showAnnotations || !state.loaded) setOpen(false);
    };

    // Capture phase on the bar, so this runs before upstream's own listener on the title and
    // stops the click from reaching it
    const onTitleClick = (event: MouseEvent) => {
        if (!info.contains(event.target as Node)) return;
        event.stopPropagation();
        setOpen(!isOpen());
    };
    const onTitleKey = (event: KeyboardEvent) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            event.stopPropagation();
            setOpen(!isOpen());
        }
    };
    // any press outside the title and the list closes it, the scene included
    const onPointerDown = (event: PointerEvent) => {
        const target = event.target as Node;
        if (isOpen() && !info.contains(target) && !list.contains(target)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Escape' && isOpen()) setOpen(false);
    };

    nav.addEventListener('click', onTitleClick, true);
    info.addEventListener('keydown', onTitleKey);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);

    const subscriptions = [
        events.on('selectedAnnotation:changed', updateSelection),
        events.on('inputMode:changed', updatePlacement),
        events.on('controlsHidden:changed', updateVisibility),
        events.on('showAnnotations:changed', updateVisibility),
        events.on('loaded:changed', updateVisibility)
    ];
    updateSelection();
    updatePlacement();

    return () => {
        for (const subscription of subscriptions) subscription.off();
        nav.removeEventListener('click', onTitleClick, true);
        info.removeEventListener('keydown', onTitleKey);
        document.removeEventListener('pointerdown', onPointerDown, true);
        document.removeEventListener('keydown', onKeyDown);
        list.remove();
    };
};

export { initAnnotationList };
