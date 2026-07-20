/* 自定义搜索结果渲染：标题 + 摘要片段
   基于 PaperMod 的 fastsearch.js 修改（仅 renderResults 部分有改动），
   通过 Hugo assets 合并机制覆盖主题同名文件。主题升级时注意同步。 */
import * as params from '@params';

const resList = document.getElementById('searchResults');
const sInput = document.getElementById('searchInput');
const searchBox = document.getElementById('searchbox');

let fuse;
let currentElement = null;
let firstResult = null;
let lastResult = null;

const defaultFuseOptions = {
    distance: 100,
    threshold: 0.4,
    ignoreLocation: true,
    keys: ['title', 'permalink', 'summary', 'content']
};

const buildFuseOptions = () => {
    if (!params.fuseOpts) {
        return defaultFuseOptions;
    }

    return {
        isCaseSensitive: params.fuseOpts.iscasesensitive ?? false,
        includeScore: params.fuseOpts.includescore ?? false,
        includeMatches: params.fuseOpts.includematches ?? false,
        minMatchCharLength: params.fuseOpts.minmatchcharlength ?? 1,
        shouldSort: params.fuseOpts.shouldsort ?? true,
        findAllMatches: params.fuseOpts.findallmatches ?? false,
        keys: params.fuseOpts.keys ?? defaultFuseOptions.keys,
        location: params.fuseOpts.location ?? 0,
        threshold: params.fuseOpts.threshold ?? defaultFuseOptions.threshold,
        distance: params.fuseOpts.distance ?? defaultFuseOptions.distance,
        ignoreLocation: params.fuseOpts.ignorelocation ?? defaultFuseOptions.ignoreLocation
    };
};

const debounce = (fn, delay) => {
    let timeout;
    return (...args) => {
        clearTimeout(timeout);
        timeout = window.setTimeout(() => fn(...args), delay);
    };
};

const reset = () => {
    currentElement = null;
    firstResult = null;
    lastResult = null;
    resList.innerHTML = '';
    sInput.value = '';
    sInput.focus();
};

const setActiveResult = (element) => {
    document.querySelectorAll('.focus').forEach((item) => item.classList.remove('focus'));

    if (!element) {
        return;
    }

    element.focus();
    element.parentElement?.classList.add('focus');
    currentElement = element;
};

/* 把 text 中 indices 命中的区间包上 <mark>，返回文档片段 */
const highlightText = (text, indices) => {
    const frag = document.createDocumentFragment();
    let pos = 0;
    const sorted = [...indices].sort((a, b) => a[0] - b[0]);
    for (const [s, e] of sorted) {
        if (s > pos) {
            frag.appendChild(document.createTextNode(text.slice(pos, s)));
        }
        const mark = document.createElement('mark');
        mark.textContent = text.slice(s, e + 1); // fuse 区间右端是闭区间
        frag.appendChild(mark);
        pos = e + 1;
    }
    if (pos < text.length) {
        frag.appendChild(document.createTextNode(text.slice(pos)));
    }
    return frag;
};

/* 围绕首个命中区间截取上下文（前后各 radius 字符），命中处高亮 */
const contextFragment = (text, range, radius = 40) => {
    const [s, e] = range;
    const from = Math.max(0, s - radius);
    const to = Math.min(text.length, e + 1 + radius);
    const frag = document.createDocumentFragment();
    if (from > 0) {
        frag.appendChild(document.createTextNode('…'));
    }
    frag.appendChild(document.createTextNode(text.slice(from, s)));
    const mark = document.createElement('mark');
    mark.textContent = text.slice(s, e + 1);
    frag.appendChild(mark);
    frag.appendChild(document.createTextNode(text.slice(e + 1, to)));
    if (to < text.length) {
        frag.appendChild(document.createTextNode('…'));
    }
    return frag;
};

/* 摘要截断：去 HTML 标签 + 限长（无命中时的兜底） */
const makeSnippet = (summary, maxLen = 90) => {
    const text = (summary || '').replace(/<[^>]*>/g, '').trim();
    return text.length > maxLen ? text.slice(0, maxLen) + '…' : text;
};

const renderResults = (results) => {
    if (!Array.isArray(results) || results.length === 0) {
        resList.innerHTML = '';
        firstResult = lastResult = currentElement = null;
        return;
    }

    const fragment = document.createDocumentFragment();

    for (const result of results) {
        const li = document.createElement('li');
        const matches = result.matches || [];
        const matchOf = (key) => matches.find((m) => m.key === key);

        /* 标题 + 摘要的文本块 */
        const main = document.createElement('div');
        main.className = 'res-main';

        const title = document.createElement('div');
        title.className = 'res-title';
        const titleMatch = matchOf('title');
        title.appendChild(
            titleMatch
                ? highlightText(result.item.title, titleMatch.indices)
                : document.createTextNode(result.item.title)
        );
        main.appendChild(title);

        /* 片段优先级：正文命中上下文 > 摘要命中上下文 > 摘要开头 */
        const snippet = document.createElement('div');
        snippet.className = 'res-snippet';
        const contentMatch = matchOf('content');
        const summaryMatch = matchOf('summary');
        if (contentMatch) {
            snippet.appendChild(
                contextFragment(result.item.content || '', contentMatch.indices[0])
            );
        } else if (summaryMatch) {
            snippet.appendChild(
                contextFragment(result.item.summary || '', summaryMatch.indices[0])
            );
        } else {
            const fallback = makeSnippet(result.item.summary);
            if (fallback) {
                snippet.appendChild(document.createTextNode(fallback));
            }
        }
        if (snippet.childNodes.length) {
            main.appendChild(snippet);
        }

        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', '24');
        svg.setAttribute('height', '24');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
        svg.classList.add('feather', 'feather-chevrons-right');

        svg.innerHTML = '<polyline points="13 17 18 12 13 7"></polyline><polyline points="6 17 11 12 6 7"></polyline>';

        const link = document.createElement('a');
        link.className = 'entry-link';
        link.href = result.item.permalink;
        link.setAttribute('aria-label', result.item.title);

        li.appendChild(main);
        li.appendChild(svg);
        li.appendChild(link);
        fragment.appendChild(li);
    }

    resList.innerHTML = '';
    resList.appendChild(fragment);
    firstResult = resList.firstElementChild;
    lastResult = resList.lastElementChild;
};

const performSearch = () => {
    if (!fuse) {
        return;
    }

    const query = sInput.value.trim();
    if (!query) {
        renderResults([]);
        return;
    }

    const searchOptions = params.fuseOpts?.limit ? { limit: params.fuseOpts.limit } : undefined;
    const results = searchOptions ? fuse.search(query, searchOptions) : fuse.search(query);
    renderResults(results);
};

const initSearch = async () => {
    if (!sInput || !resList) {
        return;
    }

    sInput.disabled = false;
    sInput.focus();

    try {
        const response = await fetch('../index.json');
        if (!response.ok) {
            throw new Error(`Search index load failed: ${response.status}`);
        }

        const data = await response.json();
        if (data) {
            fuse = new Fuse(data, buildFuseOptions());
        }
    } catch (error) {
        console.error(error);
    }
};

window.addEventListener('load', initSearch);

sInput?.addEventListener('input', debounce(performSearch, 150));

sInput?.addEventListener('search', () => {
    if (!sInput.value) {
        reset();
    }
});

document.addEventListener('keydown', (event) => {
    const { key } = event;
    const active = document.activeElement;
    const isInSearchBox = searchBox?.contains(active);

    if (key === 'Escape') {
        reset();
        return;
    }

    if (!firstResult || !isInSearchBox) {
        return;
    }

    if (key === 'ArrowDown') {
        event.preventDefault();

        if (active === sInput) {
            setActiveResult(firstResult.querySelector('.entry-link'));
        } else if (active?.parentElement !== lastResult) {
            setActiveResult(active?.parentElement?.nextElementSibling?.querySelector('.entry-link'));
        }
    } else if (key === 'ArrowUp') {
        event.preventDefault();

        if (active?.parentElement === firstResult) {
            setActiveResult(sInput);
        } else if (active !== sInput) {
            setActiveResult(active?.parentElement?.previousElementSibling?.querySelector('.entry-link'));
        }
    } else if (key === 'ArrowRight') {
        if (active?.matches?.('.entry-link')) {
            active.click();
        }
    }
});
