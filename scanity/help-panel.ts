import type { ViewerHandle } from '../src/index';
import csJson from '../src/locales/cs.json';
import deJson from '../src/locales/de.json';
import enJson from '../src/locales/en.json';
import esJson from '../src/locales/es.json';
import frJson from '../src/locales/fr.json';
import jaJson from '../src/locales/ja.json';
import koJson from '../src/locales/ko.json';
import ptBRJson from '../src/locales/pt-BR.json';
import ruJson from '../src/locales/ru.json';
import zhCNJson from '../src/locales/zh-CN.json';

import helpStrings from './help-strings.json';

type Dictionary = Record<string, string>;

// upstream's strings (actions, modes, gestures) and this panel's own (scanity/help-strings.json)
const upstreamStrings: Record<string, Dictionary> = {
    cs: csJson,
    de: deJson,
    en: enJson,
    es: esJson,
    fr: frJson,
    ja: jaJson,
    ko: koJson,
    'pt-BR': ptBRJson,
    ru: ruJson,
    'zh-CN': zhCNJson
};
const ownStrings: Record<string, Dictionary> = helpStrings;

// shown once per browser, unless the visitor unticks "don't show this again". The same key the
// panel used before the upstream update, so visitors who already dismissed it are not asked again
const SEEN_KEY = 'hasSeenHelp';

const readSeen = () => {
    try {
        return localStorage.getItem(SEEN_KEY) !== null;
    } catch {
        return false;
    }
};

const writeSeen = (seen: boolean) => {
    try {
        if (seen) localStorage.setItem(SEEN_KEY, 'true');
        else localStorage.removeItem(SEEN_KEY);
    } catch {
        // storage denied: the panel just shows again next time
    }
};

// ---- content ----------------------------------------------------------------------------------

type Mouse = 'drag' | 'left' | 'right' | 'wheel';

// an input shown on the right of a desktop row: a mouse chip (icon and label key) or keycaps
// (a label, or a help.key.* string for a named key); '/' between keys separates alternatives
type DesktopInput = { mouse: Mouse; label: string } | { keys: string[] };
type DesktopRow = [action: string, input: DesktopInput];

type Gesture = 'orbit' | 'touchOrbit' | 'pan' | 'pinch' | 'tap';
// a touch card or row: icon, action, gesture string; or a row whose input is a chip
type TouchItem = { icon: Gesture; action: string; gesture: string } | { action: string; chip: string };

type Mode = 'orbit' | 'flyClick' | 'flyGaming' | 'walkClick' | 'walkGaming';

const wasd: DesktopInput = { keys: ['W', 'A', 'S', 'D'] };
const runSlow: DesktopRow = ['run-slow', { keys: ['Shift', '/', 'Ctrl'] }];
const reset: DesktopRow = ['reset-camera', { keys: ['R'] }];
const toggleControls: DesktopRow = ['toggle-controls', { keys: ['H'] }];
const releaseMouse: DesktopRow = ['release-mouse', { keys: ['help.key.esc'] }];
const jump: DesktopRow = ['jump', { keys: ['help.key.space'] }];

// Only the controls of the mode and variant (gaming controls or click to move) the viewer is in,
// not every mode: a quick start, while the controls panel at the bottom right is the reference
const desktop: Record<Mode, DesktopRow[]> = {
    orbit: [
        ['orbit', { mouse: 'drag', label: 'help.key.left-click-drag' }],
        ['pan', { mouse: 'right', label: 'help.key.right-click-drag' }],
        ['zoom', { mouse: 'wheel', label: 'help.key.mouse-wheel' }],
        ['set-focus', { mouse: 'left', label: 'help.key.left-click' }],
        ['fly-to-point', { mouse: 'left', label: 'help.key.double-click' }],
        ['frame-scene', { keys: ['F'] }],
        reset,
        toggleControls
    ],
    flyClick: [
        ['fly-to', { mouse: 'left', label: 'help.key.left-click' }],
        ['look-around', { mouse: 'drag', label: 'help.key.left-click-drag' }],
        ['pan', { mouse: 'right', label: 'help.key.right-click-drag' }],
        ['focus-point', { mouse: 'left', label: 'help.key.double-click' }],
        ['move', wasd],
        runSlow,
        reset,
        toggleControls
    ],
    flyGaming: [
        ['look-around', { mouse: 'drag', label: 'help.key.mouse' }],
        ['move', wasd],
        ['vertical', { keys: ['Q', 'E'] }],
        runSlow,
        reset,
        releaseMouse
    ],
    walkClick: [
        ['walk-to', { mouse: 'left', label: 'help.key.left-click' }],
        ['look-around', { mouse: 'drag', label: 'help.key.left-click-drag' }],
        ['move', wasd],
        runSlow,
        jump,
        reset,
        toggleControls
    ],
    walkGaming: [
        ['look-around', { mouse: 'drag', label: 'help.key.mouse' }],
        ['move', wasd],
        runSlow,
        jump,
        reset,
        releaseMouse
    ]
};

// cards for the click modes, rows for the gaming ones
const touch: Record<Mode, { cards: boolean; items: TouchItem[] }> = {
    orbit: {
        cards: true,
        items: [
            { icon: 'orbit', action: 'orbit', gesture: 'one-finger-drag' },
            { icon: 'pan', action: 'pan', gesture: 'two-finger-drag' },
            { icon: 'pinch', action: 'zoom', gesture: 'pinch' },
            { icon: 'tap', action: 'fly-to-point', gesture: 'double-tap' }
        ]
    },
    flyClick: {
        cards: true,
        items: [
            { icon: 'tap', action: 'fly-to', gesture: 'tap' },
            { icon: 'touchOrbit', action: 'look-around', gesture: 'touch-drag' },
            { icon: 'pinch', action: 'move', gesture: 'pinch-two-finger' }
        ]
    },
    flyGaming: {
        cards: false,
        items: [
            { icon: 'touchOrbit', action: 'look-around', gesture: 'touch-drag' },
            { action: 'move', chip: 'joystick' }
        ]
    },
    walkClick: {
        cards: false,
        items: [
            { icon: 'tap', action: 'walk-to', gesture: 'tap' },
            { icon: 'touchOrbit', action: 'look-around', gesture: 'touch-drag' }
        ]
    },
    walkGaming: {
        cards: false,
        items: [
            { icon: 'touchOrbit', action: 'look-around', gesture: 'touch-drag' },
            { action: 'move', chip: 'joystick' },
            { action: 'jump', chip: 'tap' }
        ]
    }
};

const sectionTitle: Record<Mode, string> = {
    orbit: 'help.section.orbit',
    flyClick: 'help.section.fly',
    flyGaming: 'help.section.fly',
    walkClick: 'help.section.walk',
    walkGaming: 'help.section.walk'
};

// ---- icons ------------------------------------------------------------------------------------

// Constant markup: nothing localized or external reaches innerHTML

// an icon drawn on a 48 grid, scaled into the 24 grid the others use
const grid48 = (body: string) =>
    '<svg width="24" height="24" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">' +
    body +
    '</svg>';

const icons: Record<Mouse | Gesture | 'close', string> = {
    drag:
        '<rect x="7" y="2.5" width="10" height="19" rx="5" fill="none" stroke="currentColor" stroke-width="1.7"/>' +
        '<path d="M12 7.5v3M2.5 12h2M19.5 12h2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
    wheel:
        '<rect x="7" y="2.5" width="10" height="19" rx="5" fill="none" stroke="currentColor" stroke-width="1.7"/>' +
        '<path d="M12 6.5v4M12 3.2 10.4 5M12 3.2 13.6 5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
    left:
        '<rect x="7" y="2.5" width="10" height="19" rx="5" fill="none" stroke="currentColor" stroke-width="1.7"/>' +
        '<path d="M12 2.5v9.5M7 12h10M9.4 2.6A5 5 0 0 0 7 6.9V12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
    right:
        '<rect x="7" y="2.5" width="10" height="19" rx="5" fill="none" stroke="currentColor" stroke-width="1.7"/>' +
        '<path d="M12 2.5v9.5M17 12H7M14.6 2.6a5 5 0 0 1 2.4 4.3V12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
    // The four touch gestures on a 48 grid of their own, in a nested svg that sets their stroke
    // orbit: a dot with two orbits around it, each brightening towards its end
    orbit: grid48(
        '<defs>' +
            '<linearGradient id="scnOrbitH" gradientUnits="userSpaceOnUse" x1="8" y1="24" x2="40" y2="24"><stop offset="0" stop-color="currentColor" stop-opacity=".22"/><stop offset="1" stop-color="currentColor"/></linearGradient>' +
            '<linearGradient id="scnOrbitV" gradientUnits="userSpaceOnUse" x1="24" y1="8" x2="24" y2="40"><stop offset="0" stop-color="currentColor" stop-opacity=".22"/><stop offset="1" stop-color="currentColor"/></linearGradient>' +
            '</defs>' +
            '<g transform="rotate(45 24 24)">' +
            '<ellipse cx="24" cy="24" rx="16" ry="6" stroke-opacity=".22"/>' +
            '<ellipse cx="24" cy="24" rx="6" ry="16" stroke-opacity=".22"/>' +
            '<path d="M8 24 A16 6 0 0 0 40 24" stroke="url(#scnOrbitH)"/>' +
            '<path d="M24 8 A6 16 0 0 1 24 40" stroke="url(#scnOrbitV)"/>' +
            '</g>' +
            '<circle cx="24" cy="24" r="4.5" fill="currentColor" stroke="#fff" stroke-width="2"/>'
    ),
    // look around: a finger dragged along a curve
    touchOrbit:
        '<circle cx="5" cy="18" r="2.2" fill="currentColor"/>' +
        '<path d="M8 16 Q14 4 21 8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>' +
        '<path d="M21 8 l-4 -1 M21 8 l-1.5 3.8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
    // pan: two fingers with arrows out in four directions
    pan: grid48(
        '<path d="M24 16 V6 M20 10 L24 6 L28 10"/>' +
            '<path d="M24 32 V42 M20 38 L24 42 L28 38"/>' +
            '<path d="M14 24 H6 M10 20 L6 24 L10 28"/>' +
            '<path d="M34 24 H42 M38 20 L42 24 L38 28"/>' +
            '<circle cx="20" cy="24" r="3.4" fill="currentColor" stroke="none"/>' +
            '<circle cx="28" cy="24" r="3.4" fill="currentColor" stroke="none"/>'
    ),
    // zoom (pinch): two fingers moving apart, arrows out to the corners
    pinch: grid48(
        '<path d="M21.5 26.5 L26.5 21.5" stroke-opacity=".3" stroke-dasharray="1 4"/>' +
            '<path d="M15 33 L8 40 M8 34.5 L8 40 L13.5 40"/>' +
            '<path d="M33 15 L40 8 M34.5 8 L40 8 L40 13.5"/>' +
            '<circle cx="19" cy="29" r="3.4" fill="currentColor" stroke="none"/>' +
            '<circle cx="29" cy="19" r="3.4" fill="currentColor" stroke="none"/>'
    ),
    // tap (fly to point): a target, the point in the middle
    tap: grid48(
        '<circle cx="24" cy="24" r="17" stroke-opacity=".3"/>' +
            '<circle cx="24" cy="24" r="10.5"/>' +
            '<circle cx="24" cy="24" r="4" fill="currentColor" stroke="none"/>'
    ),
    close: '<path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
};

const svg = (icon: keyof typeof icons, size: number) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${icons[icon]}</svg>`;

// ---- panel ------------------------------------------------------------------------------------

// Scanity's quick-start guide: a centred panel that opens by itself on a browser's first visit,
// already while the scene downloads, with the controls of the mode the viewer starts in, for the
// visitor's own input (a tab switches between desktop and touch). It closes with its button, the
// cross, a press outside it or Esc, and is not shown again unless "don't show this again" is
// unticked. Upstream's controls panel at the bottom right stays as it is, the reference for the
// current mode; the info panel ("i") gets a button that opens this guide again.
const initHelpPanel = (viewer: ViewerHandle, root: HTMLElement) => {
    const { state, events } = viewer;
    const ui = root.querySelector<HTMLElement>('.sse-ui');

    // upstream records the locale it picked as the root's lang
    const lang = root.lang in upstreamStrings ? root.lang : 'en';
    const t = (key: string) =>
        ownStrings[lang]?.[key] ?? upstreamStrings[lang]?.[key] ?? ownStrings.en[key] ?? upstreamStrings.en[key] ?? key;

    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
        const element = document.createElement(tag);
        if (className) element.className = className;
        if (text !== undefined) element.textContent = text;
        return element;
    };

    // structure
    const panel = el('div', 'scn-help sse-hidden');
    const content = el('div', 'scn-helpContent');
    content.setAttribute('role', 'dialog');
    content.setAttribute('aria-modal', 'true');

    const head = el('div', 'scn-helpHead');
    const headCopy = el('div', 'scn-helpHeadCopy');
    const title = el('h2', 'scn-helpTitle', t('help.title'));
    headCopy.append(el('span', 'scn-helpEyebrow', t('help.eyebrow')), title);
    content.setAttribute('aria-label', t('help.title'));
    const close = el('button', 'scn-helpClose');
    close.type = 'button';
    close.setAttribute('aria-label', t('help.close'));
    close.innerHTML = svg('close', 15);
    head.append(headCopy, close);

    const tabs = el('div', 'scn-helpTabs');
    const desktopTab = el('button', 'scn-helpTab', t('help.tab.desktop'));
    const touchTab = el('button', 'scn-helpTab', t('help.tab.touch'));
    desktopTab.type = touchTab.type = 'button';
    tabs.append(desktopTab, touchTab);

    const body = el('div', 'scn-helpBody');

    const foot = el('div', 'scn-helpFoot');
    const remember = el('label', 'scn-helpRemember');
    const rememberInput = el('input');
    rememberInput.type = 'checkbox';
    rememberInput.checked = true;
    remember.append(rememberInput, el('span', undefined, t('help.remember')));
    const cta = el('button', 'scn-helpCta', t('help.cta'));
    cta.type = 'button';
    foot.append(remember, cta);

    content.append(head, tabs, body, foot);
    panel.append(content);
    // after the loading indicator, before upstream's info panel and modals
    ui.querySelector('.sse-infoPanel').before(panel);

    // content for the current mode
    let tab: 'desktop' | 'touch' = state.inputMode === 'touch' ? 'touch' : 'desktop';

    const currentMode = (): Mode => {
        const gaming = state.gamingControls;
        if (state.cameraMode === 'fly') return gaming ? 'flyGaming' : 'flyClick';
        if (state.cameraMode === 'walk') return gaming ? 'walkGaming' : 'walkClick';
        return 'orbit';
    };

    const renderDesktop = (mode: Mode) => {
        const list = el('div', 'scn-helpList');
        for (const [action, input] of desktop[mode]) {
            const line = el('div', 'scn-helpLine');
            line.append(el('span', 'scn-helpLineTitle', t(`help.action.${action}`)));
            if ('mouse' in input) {
                const chip = el('span', 'scn-helpChip scn-helpChip--mouse');
                chip.innerHTML = svg(input.mouse, 16);
                chip.append(el('span', undefined, t(input.label)));
                line.append(chip);
            } else {
                const keys = el('span', 'scn-helpKeys');
                for (const key of input.keys) {
                    if (key === '/') keys.append(el('span', 'scn-helpKeySep', '/'));
                    else keys.append(el('kbd', undefined, key.startsWith('help.') ? t(key) : key));
                }
                line.append(keys);
            }
            list.append(line);
        }
        return [el('div', 'scn-helpModeTitle', t(sectionTitle[mode])), list];
    };

    const renderTouch = (mode: Mode) => {
        const { cards, items } = touch[mode];
        const block = el('div', cards ? 'scn-helpCards' : 'scn-helpRows');
        for (const item of items) {
            if ('chip' in item) {
                const row = el('div', 'scn-helpChipRow');
                row.append(
                    el('span', 'scn-helpRowTitle', t(`help.action.${item.action}`)),
                    el('span', 'scn-helpChip', t(`help.key.${item.chip}`))
                );
                block.append(row);
                continue;
            }
            const element = el('div', cards ? 'scn-helpCard' : 'scn-helpRow');
            const glyph = el('span', cards ? 'scn-helpGlyph' : 'scn-helpBadge');
            glyph.innerHTML = svg(item.icon, cards ? 40 : 18);
            const text = el('span', cards ? undefined : 'scn-helpRowText');
            text.append(
                el('span', 'scn-helpRowTitle', t(`help.action.${item.action}`)),
                el('span', 'scn-helpRowBody', t(`help.key.${item.gesture}`))
            );
            if (cards) element.append(glyph, ...Array.from(text.childNodes));
            else element.append(glyph, text);
            block.append(element);
        }
        return [el('div', 'scn-helpModeTitle', t(sectionTitle[mode])), block];
    };

    const render = () => {
        const mode = currentMode();
        body.replaceChildren(...(tab === 'desktop' ? renderDesktop(mode) : renderTouch(mode)));
        desktopTab.classList.toggle('scn-active', tab === 'desktop');
        touchTab.classList.toggle('scn-active', tab === 'touch');
    };

    const isOpen = () => !panel.classList.contains('sse-hidden');

    const open = () => {
        tab = state.inputMode === 'touch' ? 'touch' : 'desktop';
        rememberInput.checked = true;
        render();
        panel.classList.remove('sse-hidden');
    };

    // every way of closing records the choice in the checkbox
    const dismiss = () => {
        if (!isOpen()) return;
        panel.classList.add('sse-hidden');
        writeSeen(rememberInput.checked);
    };

    desktopTab.addEventListener('click', () => {
        tab = 'desktop';
        render();
    });
    touchTab.addEventListener('click', () => {
        tab = 'touch';
        render();
    });
    close.addEventListener('click', dismiss);
    cta.addEventListener('click', dismiss);
    // a press outside the box closes it; inside, it stays with the panel
    panel.addEventListener('pointerdown', (event) => {
        if (!content.contains(event.target as Node)) dismiss();
    });
    // scroll the body itself rather than zoom the camera
    content.addEventListener('wheel', (event) => event.stopPropagation());

    const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Escape' && isOpen()) dismiss();
    };
    document.addEventListener('keydown', onKeyDown);

    // follows the mode, which may change after the panel opened (the scene's real start mode is
    // known only once collision has loaded)
    const subscriptions = [
        events.on('cameraMode:changed', () => isOpen() && render()),
        events.on('gamingControls:changed', () => isOpen() && render())
    ];

    // reopened from the info panel
    const infoContent = root.querySelector('.sse-infoPanelContent');
    if (infoContent) {
        const guide = el('button', 'scn-helpReopen', t('help.guide'));
        guide.type = 'button';
        guide.addEventListener('click', () => {
            root.querySelector<HTMLButtonElement>('.sse-infoClose')?.click();
            open();
        });
        infoContent.querySelector('.sse-infoLinks')?.after(guide);
    }

    // first visit
    if (!readSeen()) open();

    return () => {
        for (const subscription of subscriptions) subscription.off();
        document.removeEventListener('keydown', onKeyDown);
        panel.remove();
    };
};

export { initHelpPanel };
