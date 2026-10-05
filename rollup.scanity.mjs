// Builds the Scanity viewer (viewer.scanity.cz) into site/: scanity/index.html, scanity/main.ts
// (which bundles the upstream viewer from src/) and scanity/index.scss (upstream's styles plus
// the Scanity theme). Separate from upstream's rollup.config.mjs, which keeps building the stock
// viewer into public/ and dist/ untouched, so upstream updates never conflict here. See
// SCANITY.md.
//
//   npm run scanity:build    one build into site/
//   npm run scanity:develop  rebuild on change and serve site/ on http://localhost:3000

import { existsSync, readFileSync } from 'fs';
import path from 'path';

import json from '@rollup/plugin-json';
import resolve from '@rollup/plugin-node-resolve';
import autoprefixer from 'autoprefixer';
import postcss from 'postcss';
import scss from 'rollup-plugin-scss';
import sass from 'sass';
import ts from 'typescript';

const outDir = 'site';

// TypeScript is transpiled file by file, as upstream's watch build does; types are checked by
// `npm run scanity:types` instead, which also covers the upstream sources this bundle pulls in.
function transpileTypescript() {
    const compilerOptions = {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        sourceMap: true,
        inlineSources: true
    };
    return {
        name: 'transpile-typescript',
        resolveId(source, importer) {
            if (!importer || !source.startsWith('.')) return null;
            const base = path.resolve(path.dirname(importer), source);
            return [`${base}.ts`, path.join(base, 'index.ts')].find((candidate) => existsSync(candidate)) ?? null;
        },
        transform(code, id) {
            if (!id.endsWith('.ts') || id.endsWith('.d.ts')) return null;
            const output = ts.transpileModule(code, { compilerOptions, fileName: id });
            return { code: output.outputText, map: JSON.parse(output.sourceMapText) };
        }
    };
}

// src/ui.html imported as a string, its comments dropped: as upstream's htmlTemplatePlugin
function htmlTemplate() {
    return {
        name: 'html-template',
        transform(code, id) {
            if (!id.endsWith('.html')) return null;
            const markup = code.replace(/<!--[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n');
            return { code: `export default ${JSON.stringify(markup)};`, map: { mappings: '' } };
        }
    };
}

// the pages: the viewer itself, and an embed test page
function pages() {
    const files = { 'index.html': 'scanity/index.html', 'tester.html': 'scanity/tester.html' };
    return {
        name: 'scanity-pages',
        buildStart() {
            Object.values(files).forEach((file) => this.addWatchFile(file));
        },
        generateBundle() {
            for (const [fileName, file] of Object.entries(files)) {
                const source = readFileSync(file, 'utf-8').replace(
                    /<base\b[^>]*>/,
                    () => `<base href="${process.env.BASE_HREF ?? ''}" />`
                );
                this.emitFile({ type: 'asset', fileName, source });
            }
        }
    };
}

const buildCss = {
    input: 'scanity/index.scss',
    output: { dir: outDir },
    plugins: [
        scss({
            fileName: 'index.css',
            sourceMap: false,
            runtime: sass,
            watch: ['scanity', 'src'],
            processor: (css) =>
                postcss([autoprefixer])
                    .process(css, { from: undefined })
                    .then((result) => result.css)
        }),
        {
            name: 'suppress-empty-chunks',
            generateBundle(options, bundle) {
                for (const [fileName, chunk] of Object.entries(bundle)) {
                    if (chunk.type === 'chunk' && chunk.code.trim() === '') delete bundle[fileName];
                }
            }
        }
    ]
};

const buildJs = {
    input: 'scanity/main.ts',
    output: { dir: outDir, entryFileNames: 'index.js', format: 'esm', sourcemap: true },
    plugins: [
        resolve(process.env.ENGINE === 'debug' ? { exportConditions: ['development'] } : {}),
        transpileTypescript(),
        json(),
        htmlTemplate(),
        pages()
    ]
};

export default [buildCss, buildJs];
