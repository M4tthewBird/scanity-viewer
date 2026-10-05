import { version as upstreamVersion } from '../package.json';

// The Scanity mark from scanity.cz's header (assets/scanity_logo.svg), inlined so the viewer
// needs no extra request. Constant markup: nothing external reaches innerHTML.
const logoSvg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 31.28 54.07" role="img" aria-label="Scanity">' +
    '<path fill="currentColor" d="M30.43,6.03L12.82,15.83l-1.92,1.07v16.69l-2.21,1.1L.48,29.97l-.09-.05-.1-.05c-.2-.1-.26-.2-.29-.35V12.56c.12-.87.44-1.33.66-1.56L20.03.08l.03-.02.03-.02s.08-.03.09-.04c.01,0,.02,0,.05.03l.16.1,10.04,5.9Z"/>' +
    '<path fill="currentColor" d="M.85,48.04l17.61-9.8,1.92-1.07v-16.69s2.21-1.1,2.21-1.1l8.21,4.72.09.05.1.05c.2.1.26.2.29.35v16.96c-.12.87-.44,1.33-.66,1.56l-19.37,10.92-.03.02-.03.02s-.08.03-.09.04c-.01,0-.02,0-.05-.03l-.16-.1L.85,48.04Z"/>' +
    '</svg>';

const createLink = (className: string, href: string) => {
    const link = document.createElement('a');
    link.className = className;
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    return link;
};

// The Scanity logo, always visible at the top left and linking to scanity.cz, including inside
// customers' embeds (upstream's SuperSplat badge, shown in third-party embeds, is hidden by the
// theme). The info panel names this viewer and credits what it is built on.
const initBrand = (root: HTMLElement) => {
    const ui = root.querySelector<HTMLElement>('.sse-ui');

    const logo = createLink('scn-brandLogo', 'https://scanity.cz');
    logo.innerHTML = `${logoSvg}<span>Scanity</span>`;
    // after the poster, before the loading indicator and the panels, so the modals cover it
    ui.querySelector('.sse-poster').after(logo);

    // info panel: "Scanity Viewer" at the top, then SuperSplat Viewer beside the PlayCanvas engine
    const title = root.querySelector<HTMLAnchorElement>('.sse-viewerTitle');
    if (title) {
        title.href = 'https://scanity.cz';
        const mark = document.createElement('span');
        mark.className = 'scn-viewerLogo';
        mark.innerHTML = logoSvg;
        title.querySelector('.sse-viewerLogo')?.replaceWith(mark);
        title.querySelector('.sse-title-name').textContent = 'Scanity Viewer';
        title.querySelector('.sse-title-version')?.remove();
    }

    const links = root.querySelector('.sse-infoLinks');
    if (links) {
        const credit = createLink('sse-infoLink', 'https://github.com/playcanvas/supersplat-viewer');
        const name = document.createElement('span');
        name.textContent = 'SuperSplat Viewer';
        const version = document.createElement('span');
        version.className = 'sse-infoLinkVersion';
        version.textContent = `v${upstreamVersion}`;
        credit.append(name, version);
        links.prepend(credit);
    }
};

export { initBrand };
