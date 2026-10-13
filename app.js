/* Gītā Companion — offline study app for the Bhagavad Gītā.
 * Plain JavaScript, no dependencies. State lives in localStorage.
 */
'use strict';
(() => {
  // ---------- helpers ----------
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fold = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const COLORS = ['yellow', 'green', 'blue', 'pink', 'purple'];
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const enc = encodeURIComponent;

  // ---------- persistent store ----------
  const KEY = 'gita-companion-v1';
  const Store = {
    s: { highlights: [], notes: [], prefs: { theme: 'auto', size: 1 }, last: null, open: {} },
    load() {
      try {
        const raw = localStorage.getItem(KEY);
        if (!raw) return;
        const d = JSON.parse(raw);
        if (Array.isArray(d.highlights)) this.s.highlights = d.highlights.filter((h) => h && h.id && h.block && COLORS.includes(h.color));
        if (Array.isArray(d.notes)) this.s.notes = d.notes.filter((n) => n && n.id && typeof n.text === 'string');
        if (d.prefs) this.s.prefs = Object.assign(this.s.prefs, d.prefs);
        if (typeof d.last === 'string') this.s.last = d.last;
      } catch (e) { /* corrupted or blocked storage: start fresh */ }
    },
    save() {
      try { localStorage.setItem(KEY, JSON.stringify(this.s)); }
      catch (e) { toast('Could not save: browser storage is unavailable.'); }
    },
  };

  // ---------- data ----------
  let D = null;                 // the whole data file
  const chapterByN = new Map();
  const sectionById = new Map();
  const verseById = new Map();
  const gloss = new Map();      // key -> entry
  const aliasMap = new Map();   // folded alias -> key
  let termRe = null;
  const diagrams = new Map();   // diagram id -> {diag, route, label}

  function indexData() {
    for (const ch of D.chapters) {
      chapterByN.set(ch.n, ch);
      ch.sections.forEach((s, i) => {
        s.ch = ch.n; s.index = i;
        sectionById.set(s.id, s);
        s.argDiagram = argumentDiagram(s);
        diagrams.set(s.argDiagram.id, { diag: s.argDiagram, ch: ch.n, label: `${ch.n}.${s.from}–${s.to} · ${s.title}` });
      });
      for (const v of ch.verses) verseById.set(v.id, v);
      if (ch.map) {
        ch.map.id = 'map-' + ch.n;
        diagrams.set(ch.map.id, { diag: ch.map, ch: ch.n, label: `Chapter ${ch.n} · concept map` });
      }
    }
    if (D.intro.map) { D.intro.map.id = 'map-intro'; diagrams.set('map-intro', { diag: D.intro.map, ch: 0, label: 'Introduction · the shape of the Gītā' }); }
    const aliases = [];
    for (const g of D.glossary) {
      gloss.set(g.key, g);
      for (const a of [g.term, ...(g.aliases || [])]) {
        const f = fold(a);
        if (!aliasMap.has(f)) { aliasMap.set(f, g.key); aliases.push(a); }
      }
    }
    aliases.sort((a, b) => b.length - a.length);
    const alt = aliases.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    try { termRe = new RegExp('(?<![\\p{L}\\p{M}])(?:' + alt + ')(?![\\p{L}\\p{M}])', 'giu'); }
    catch (e) { termRe = new RegExp('\\b(?:' + alt + ')\\b', 'gi'); }
  }

  function sectionOfVerse(c, v) {
    const ch = chapterByN.get(c);
    if (!ch) return null;
    return ch.sections.find((s) => v >= s.from && v <= s.to) || ch.sections[ch.sections.length - 1];
  }

  // ---------- inline markup ----------
  function termKey(k) {
    const f = fold(k.trim());
    return aliasMap.get(f) || (gloss.has(k) ? k : null);
  }
  function md(s) {
    let h = esc(s);
    h = h.replace(/\[\[([^\]|]+?)\|([^\]]+?)\]\]/g, (m, k, t) => termLink(k, t))
      .replace(/\[\[([^\]]+?)\]\]/g, (m, k) => termLink(k, k))
      .replace(/\{(\d{1,2})\.(\d{1,2})(?:[–-](\d{1,2}))?\}/g, (m, c, v, v2) => `<a class="vref" href="#/ch/${c}/b/${enc('v:' + c + '.' + v)}">${c}.${v}${v2 ? '–' + v2 : ''}</a>`)
      .replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+?)\*/g, '<em>$1</em>');
    return h;
  }
  function termLink(k, text) {
    const key = termKey(k.replace(/&#39;/g, "'"));
    if (!key) return text;
    return `<a class="term" data-term="${esc(key)}" href="#/glossary/${enc(key)}">${text}</a>`;
  }
  function autolink(el) {
    if (!termRe) return;
    const seen = new Set($$('a.term', el).map((a) => a.dataset.term));
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement.closest('a, button, .nolink') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const text = node.nodeValue;
      termRe.lastIndex = 0;
      let m, last = 0, frag = null;
      while ((m = termRe.exec(text))) {
        const key = aliasMap.get(fold(m[0]));
        if (!key || seen.has(key)) continue;
        seen.add(key);
        frag = frag || document.createDocumentFragment();
        frag.append(text.slice(last, m.index));
        const a = document.createElement('a');
        a.className = 'term'; a.dataset.term = key; a.href = '#/glossary/' + enc(key); a.textContent = m[0];
        frag.append(a);
        last = m.index + m[0].length;
      }
      if (frag) { frag.append(text.slice(last)); node.replaceWith(frag); }
    }
  }

  // Render a set of paragraphs into a container; each paragraph is a highlightable block.
  const baseHTML = new WeakMap();
  function prepBlocks(root) {
    for (const el of $$('[data-hl]', root)) {
      if (!el.dataset.nolink) autolink(el);
      baseHTML.set(el, el.innerHTML);
      paintBlock(el);
    }
    for (const el of $$('.autolink', root)) autolink(el);
  }
  function paras(list, prefix, cls = '') {
    return (list || []).map((p, i) => `<p class="${cls}" data-hl="${esc(prefix + ':' + i)}">${md(p)}</p>`).join('');
  }

  // ---------- highlights ----------
  function paintBlock(block) {
    const id = block.dataset.hl;
    const base = baseHTML.get(block);
    if (base != null) block.innerHTML = base;
    const full = block.textContent;
    const hls = Store.s.highlights.filter((h) => h.block === id && h.start != null).sort((a, b) => a.start - b.start);
    for (const h of hls) {
      let { start, end } = h;
      if (h.text && full.slice(start, end) !== h.text) {
        const at = full.indexOf(h.text);
        if (at < 0) continue;
        start = at; end = at + h.text.length;
      }
      wrapRange(block, start, end, h);
    }
  }
  function wrapRange(block, start, end, h) {
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let pos = 0;
    const targets = [];
    while (walker.nextNode()) {
      const n = walker.currentNode;
      const len = n.nodeValue.length;
      const s = Math.max(start, pos), e = Math.min(end, pos + len);
      if (s < e) targets.push([n, s - pos, e - pos]);
      pos += len;
      if (pos >= end) break;
    }
    for (const [n, s, e] of targets) {
      let node = n;
      if (s > 0) node = node.splitText(s);
      if (e - s < node.nodeValue.length) node.splitText(e - s);
      const mk = document.createElement('mark');
      mk.className = 'hl hl-' + h.color;
      mk.dataset.hid = h.id;
      node.replaceWith(mk);
      mk.append(node);
    }
  }
  function repaint(blockId) {
    for (const el of $$(`[data-hl="${CSS.escape(blockId)}"]`)) paintBlock(el);
  }
  function addHighlight(p, color) {
    const h = { id: uid(), block: p.block, start: p.start, end: p.end, text: p.text, color, note: '', created: Date.now() };
    Store.s.highlights.push(h);
    Store.save();
    repaint(p.block);
    return h;
  }

  // Selection toolbar
  const selbar = $('#selbar');
  let pendingSel = null;
  function closestBlock(node) {
    const el = node.nodeType === 1 ? node : node.parentElement;
    return el ? el.closest('[data-hl]') : null;
  }
  document.addEventListener('selectionchange', debounce(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) { pendingSel = null; selbar.hidden = true; return; }
    const r = sel.getRangeAt(0);
    const a = closestBlock(r.startContainer), b = closestBlock(r.endContainer);
    const text = r.toString();
    if (!a || a !== b || !text.trim()) { pendingSel = null; selbar.hidden = true; return; }
    const pre = document.createRange();
    pre.selectNodeContents(a);
    pre.setEnd(r.startContainer, r.startOffset);
    const start = pre.toString().length;
    pendingSel = { block: a.dataset.hl, start, end: start + text.length, text };
    selbar.hidden = false;
  }, 180));
  selbar.addEventListener('pointerdown', (e) => e.preventDefault());
  selbar.addEventListener('mousedown', (e) => e.preventDefault());
  selbar.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn || !pendingSel) return;
    const p = pendingSel;
    pendingSel = null;
    selbar.hidden = true;
    try { window.getSelection().removeAllRanges(); } catch (err) { /* ignore */ }
    if (btn.dataset.color) { addHighlight(p, btn.dataset.color); toast('Highlighted'); }
    else if (btn.dataset.action === 'note') { const h = addHighlight(p, 'yellow'); openHighlight(h.id, true); }
  });

  function openHighlight(hid, focusNote) {
    const h = Store.s.highlights.find((x) => x.id === hid);
    if (!h) return;
    const loc = locate(h.block);
    openSheet(`
      <p class="kind">Highlight</p>
      <h2>${esc(loc.title)}</h2>
      <p class="muted small sans">${esc(loc.sub || '')}</p>
      <div class="quote">${esc(h.text || '')}</div>
      <div class="chips" role="group" aria-label="Colour">${COLORS.map((c) => `<button class="dot c-${c}" data-c="${c}" aria-label="${c}" aria-pressed="${h.color === c}"></button>`).join('')}</div>
      <label class="small sans muted" for="hlNote">Note on this passage</label>
      <textarea id="hlNote" placeholder="Write a note…">${esc(h.note || '')}</textarea>
      <div class="btnrow">
        <button class="btn primary" data-act="save">Save</button>
        <a class="btn" href="${loc.route}" data-act="go">Go to passage</a>
        <button class="btn danger" data-act="del">Delete</button>
      </div>`, (body) => {
      if (focusNote) setTimeout(() => $('#hlNote', body).focus(), 60);
      body.addEventListener('click', (e) => {
        const c = e.target.closest('[data-c]');
        if (c) {
          h.color = c.dataset.c; Store.save(); repaint(h.block);
          $$('[data-c]', body).forEach((b) => b.setAttribute('aria-pressed', String(b === c)));
          refreshIfNotes();
          return;
        }
        const act = e.target.closest('[data-act]');
        if (!act) return;
        if (act.dataset.act === 'save') { h.note = $('#hlNote', body).value.trim(); Store.save(); closeSheet(); toast('Saved'); refreshIfNotes(); }
        if (act.dataset.act === 'go') closeSheet();
        if (act.dataset.act === 'del') {
          Store.s.highlights = Store.s.highlights.filter((x) => x.id !== h.id); Store.save();
          repaint(h.block); refreshDiagramHighlights(); closeSheet(); toast('Highlight removed'); refreshIfNotes();
        }
      });
    });
  }

  // ---------- notes ----------
  function openNoteEditor({ id = null, anchor = null }) {
    const n = id ? Store.s.notes.find((x) => x.id === id) : null;
    const a = n ? n.anchor : anchor;
    const loc = locate(a);
    openSheet(`
      <p class="kind">${n ? 'Edit note' : 'New note'}</p>
      <h2>${esc(loc.title)}</h2>
      <p class="muted small sans">${esc(loc.sub || '')}</p>
      <textarea id="noteText" placeholder="Your note…">${esc(n ? n.text : '')}</textarea>
      <div class="btnrow">
        <button class="btn primary" data-act="save">Save note</button>
        ${n ? '<button class="btn danger" data-act="del">Delete</button>' : ''}
      </div>`, (body) => {
      setTimeout(() => $('#noteText', body).focus(), 60);
      body.addEventListener('click', (e) => {
        const act = e.target.closest('[data-act]');
        if (!act) return;
        if (act.dataset.act === 'save') {
          const text = $('#noteText', body).value.trim();
          if (!text) { toast('The note is empty.'); return; }
          if (n) { n.text = text; n.updated = Date.now(); }
          else Store.s.notes.push({ id: uid(), anchor: a, text, created: Date.now(), updated: Date.now() });
          Store.save(); closeSheet(); toast('Note saved'); rerender();
        }
        if (act.dataset.act === 'del') {
          if (!confirm('Delete this note?')) return;
          Store.s.notes = Store.s.notes.filter((x) => x.id !== n.id);
          Store.s.highlights = Store.s.highlights.filter((h) => h.block !== 'n:' + n.id);
          Store.save(); closeSheet(); toast('Note deleted'); rerender();
        }
      });
    });
  }
  function noteHTML(n, withLoc) {
    const loc = locate(n.anchor);
    return `<div class="hlitem" id="note-${esc(n.id)}"><span class="bar none"></span><div>
      ${withLoc ? `<div class="meta"><a href="${loc.route}">${esc(loc.title)}</a>${loc.sub ? ' · ' + esc(loc.sub) : ''}</div>` : ''}
      <p class="notetext" data-hl="n:${esc(n.id)}" data-nolink="1">${esc(n.text)}</p>
      <div class="meta">${new Date(n.updated || n.created).toLocaleDateString()} ·
        <button class="linkbtn" data-editnote="${esc(n.id)}">Edit</button></div></div></div>`;
  }

  // ---------- location of any block ----------
  function locate(block) {
    const fallback = { title: 'Passage', sub: '', route: '#/', order: 9e9, group: 'Other' };
    if (!block) return fallback;
    const type = block[0], rest = block.slice(2);
    try {
      if (type === 'v') {
        const [c, v] = rest.split('.').map(Number);
        const s = sectionOfVerse(c, v);
        return { title: `Bhagavad Gītā ${c}.${v}`, sub: s ? s.title : '', route: `#/ch/${c}/b/${enc(block)}`, order: c * 1e5 + (s ? s.index : 0) * 1e3 + v, group: `Chapter ${c} · ${chapterByN.get(c).title}`, sec: s && s.id };
      }
      if (type === 'a' || type === 's') {
        const [sid, kind] = rest.split(':');
        const s = sectionById.get(sid);
        const KINDS = { notes: 'Footnotes', reconstruction: 'Reconstruction', insight: 'Insight', sources: 'Sources', context: 'In context', matters: 'Why it matters' };
        return { title: `${s.ch}.${s.from}–${s.to} · ${s.title}`, sub: type === 's' ? 'Section note' : (KINDS[kind] || ''), route: `#/ch/${s.ch}/b/${enc(type === 's' ? 'sec:' + sid : block)}`, order: s.ch * 1e5 + s.index * 1e3 + 900, group: `Chapter ${s.ch} · ${chapterByN.get(s.ch).title}`, sec: sid };
      }
      if (type === 'c') {
        const [c, kind] = rest.split(':');
        const ch = chapterByN.get(Number(c));
        const KINDS = { overview: 'Overview', research: 'Current research', summary: 'Summary', ch: 'Chapter note' };
        return { title: `Chapter ${ch.n} · ${ch.title}`, sub: KINDS[kind] || '', route: `#/ch/${ch.n}/b/${enc(kind === 'ch' ? 'top' : block)}`, order: ch.n * 1e5, group: `Chapter ${ch.n} · ${ch.title}` };
      }
      if (type === 'i') {
        const [sid] = rest.split(':');
        const idx = D.intro.sections.findIndex((x) => x.id === sid);
        const sec = D.intro.sections[idx];
        return { title: `Introduction · ${sec ? sec.title : ''}`, sub: '', route: `#/intro/b/${enc(block)}`, order: (idx + 1) * 10, group: 'Introduction' };
      }
      if (type === 'd') {
        const d = diagrams.get(rest);
        if (!d) return fallback;
        const route = d.ch === 0 ? `#/intro/b/${enc(block)}` : `#/ch/${d.ch}/b/${enc(block)}`;
        let order = d.ch * 1e5 + 50;
        let group = d.ch === 0 ? 'Introduction' : `Chapter ${d.ch} · ${chapterByN.get(d.ch).title}`;
        const s = rest.startsWith('arg-') ? sectionById.get(rest.slice(4)) : null;
        if (s) order = s.ch * 1e5 + s.index * 1e3 + 950;
        return { title: d.label, sub: 'Diagram', route, order, group };
      }
      if (type === 'n') {
        const n = Store.s.notes.find((x) => x.id === rest);
        return n ? locate(n.anchor) : fallback;
      }
    } catch (e) { return fallback; }
    return fallback;
  }

  // ---------- diagrams ----------
  function argumentDiagram(s) {
    const a = s.argument || { premises: [], claim: null, implications: [] };
    const nodes = [], edges = [];
    let row = 0;
    const prem = a.premises || [];
    for (let i = 0; i < prem.length; i += 2) {
      prem.slice(i, i + 2).forEach((p, j) => nodes.push(Object.assign({ id: 'p' + (i + j), row, kind: 'premise', tag: 'PREMISE' }, p)));
      row++;
    }
    if (a.claim) {
      nodes.push(Object.assign({ id: 'c', row, kind: 'claim', tag: 'CLAIM' }, a.claim));
      prem.forEach((p, i) => edges.push({ from: 'p' + i, to: 'c' }));
      row++;
    }
    const imp = a.implications || [];
    for (let i = 0; i < imp.length; i += 2) {
      imp.slice(i, i + 2).forEach((p, j) => {
        nodes.push(Object.assign({ id: 'i' + (i + j), row, kind: 'implication', tag: 'IMPLICATION' }, p));
        edges.push({ from: 'c', to: 'i' + (i + j) });
      });
      row++;
    }
    return { id: 'arg-' + s.id, title: 'Argument structure', nodes, edges };
  }

  const DW = 340; // viewBox width, tuned for phones
  function wrapLabel(label, maxChars) {
    const words = String(label).split(/\s+/);
    const lines = [];
    let cur = '';
    for (const w of words) {
      if ((cur + ' ' + w).trim().length > maxChars && cur) { lines.push(cur); cur = w; }
      else cur = (cur + ' ' + w).trim();
    }
    if (cur) lines.push(cur);
    return lines;
  }
  function layout(diag, showDetail) {
    const nodes = diag.nodes.filter((n) => showDetail || !n.detail);
    const ids = new Set(nodes.map((n) => n.id));
    const rows = [];
    for (const n of nodes) (rows[n.row] = rows[n.row] || []).push(n);
    const pos = new Map();
    let y = 10;
    const gapX = 10, padX = 8;
    for (const r of rows) {
      if (!r) continue;
      const k = r.length;
      const w = Math.min(k === 1 ? 230 : 160, (DW - padX * 2 - gapX * (k - 1)) / k);
      let rowH = 0;
      const total = w * k + gapX * (k - 1);
      let x = (DW - total) / 2;
      for (const n of r) {
        // Bold labels (claims, centres) are wider per character than regular ones.
        const charW = n.kind === 'claim' || n.kind === 'center' ? 7.4 : 6.6;
        const lines = wrapLabel(n.label, Math.max(8, Math.floor((w - 16) / charW)));
        const h = 16 + lines.length * 15 + (n.tag ? 11 : 0);
        pos.set(n.id, { x, y, w, h, lines });
        rowH = Math.max(rowH, h);
        x += w + gapX;
      }
      for (const n of r) { const p = pos.get(n.id); p.y += (rowH - p.h) / 2; }
      y += rowH + 44;
    }
    const edges = (diag.edges || []).filter((e) => ids.has(e.from) && ids.has(e.to));
    return { nodes, edges, pos, height: y - 30 };
  }
  function diagramHTML(diag, blockId) {
    const hasDetail = diag.nodes.some((n) => n.detail);
    return `<div class="diagram" data-diagram="${esc(diag.id)}" data-hlblock="${esc(blockId)}" id="${esc(blockId)}">
      <div class="dtools">
        <button class="chip hlmode" aria-pressed="false" data-dt="hl">Highlight</button>
        <span class="dcolors" hidden>${COLORS.map((c, i) => `<button class="dot c-${c}" data-dc="${c}" aria-label="${c}" aria-pressed="${i === 0}"></button>`).join('')}</span>
        ${hasDetail ? '<button class="chip" aria-pressed="false" data-dt="detail">Show detail</button>' : ''}
      </div>
      <p class="dhint">Tap a box to explain it${diag.nodes.some((n) => n.ref) ? ' and jump to its verses' : ''}.</p>
      <div class="dsvgwrap"></div>
      <div class="dinfo" hidden></div>
    </div>`;
  }
  function drawDiagram(wrap) {
    const diag = diagrams.get(wrap.dataset.diagram).diag;
    const showDetail = wrap.dataset.detail === '1';
    const L = layout(diag, showDetail);
    const blockId = wrap.dataset.hlblock;
    const hlFor = (nid) => Store.s.highlights.find((h) => h.block === blockId && h.node === nid);
    let s = `<svg class="dsvg" viewBox="0 0 ${DW} ${Math.max(60, L.height)}" role="img" aria-label="${esc(diag.title || 'Diagram')}">
      <title>${esc(diag.title || 'Diagram')}</title>
      <defs><marker id="ah-${esc(diag.id)}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="arrow" d="M0 0L10 5L0 10z"/></marker></defs>`;
    for (const e of L.edges) {
      const a = L.pos.get(e.from), b = L.pos.get(e.to);
      let d, lx, ly;
      if (Math.abs(a.y - b.y) < 4) {
        const left = a.x < b.x ? a : b, right = a.x < b.x ? b : a;
        const x1 = left.x + left.w, y1 = left.y + left.h / 2, x2 = right.x, y2 = right.y + right.h / 2;
        d = a.x < b.x ? `M${x1} ${y1} L${x2} ${y2}` : `M${x2} ${y2} L${x1} ${y1}`;
        lx = (x1 + x2) / 2; ly = y1 - 4;
      } else {
        const down = b.y > a.y;
        const x1 = a.x + a.w / 2, y1 = down ? a.y + a.h : a.y;
        const x2 = b.x + b.w / 2, y2 = down ? b.y : b.y + b.h;
        const my = (y1 + y2) / 2;
        d = `M${x1} ${y1} C${x1} ${my} ${x2} ${my} ${x2} ${y2}`;
        lx = (x1 + x2) / 2; ly = my + 3;
      }
      s += `<path class="edge${e.dashed ? ' dashed' : ''}" d="${d}" marker-end="url(#ah-${esc(diag.id)})"/>`;
      if (e.label) {
        const tw = e.label.length * 5.4 + 8;
        s += `<rect class="elabel-bg" x="${lx - tw / 2}" y="${ly - 10}" width="${tw}" height="13" rx="3"/><text class="elabel" x="${lx}" y="${ly}" text-anchor="middle">${esc(e.label)}</text>`;
      }
    }
    for (const n of L.nodes) {
      const p = L.pos.get(n.id);
      const h = hlFor(n.id);
      const sel = wrap.dataset.sel === n.id;
      s += `<g class="node k-${esc(n.kind || 'concept')}${h ? ' hl-' + h.color : ''}${sel ? ' selected' : ''}" data-node="${esc(n.id)}" tabindex="0" role="button" aria-label="${esc(n.label)}">
        <rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="10"/>`;
      let ty = p.y + 18;
      if (n.tag) { s += `<text class="ntag" x="${p.x + p.w / 2}" y="${p.y + 13}" text-anchor="middle">${esc(n.tag)}</text>`; ty += 10; }
      for (const line of p.lines) { s += `<text x="${p.x + p.w / 2}" y="${ty}" text-anchor="middle">${esc(line)}</text>`; ty += 15; }
      s += `</g>`;
    }
    s += '</svg>';
    $('.dsvgwrap', wrap).innerHTML = s;
  }
  function refreshDiagramHighlights() { for (const w of $$('.diagram')) drawDiagram(w); }
  function diagramClick(wrap, e) {
    const tool = e.target.closest('[data-dt]');
    if (tool) {
      const on = tool.getAttribute('aria-pressed') !== 'true';
      tool.setAttribute('aria-pressed', String(on));
      if (tool.dataset.dt === 'hl') {
        $('.dcolors', wrap).hidden = !on;
        wrap.dataset.hlmode = on ? '1' : '';
        $('.dhint', wrap).textContent = on ? 'Highlight mode: tap boxes to colour them. Tap again to remove. Tap “Highlight” to finish.' : 'Tap a box to explain it.';
      } else { wrap.dataset.detail = on ? '1' : ''; tool.textContent = on ? 'Hide detail' : 'Show detail'; drawDiagram(wrap); }
      return;
    }
    const dc = e.target.closest('[data-dc]');
    if (dc) { $$('[data-dc]', wrap).forEach((b) => b.setAttribute('aria-pressed', String(b === dc))); return; }
    const g = e.target.closest('[data-node]');
    if (!g) return;
    const diag = diagrams.get(wrap.dataset.diagram).diag;
    const node = diag.nodes.find((n) => n.id === g.dataset.node);
    const blockId = wrap.dataset.hlblock;
    if (wrap.dataset.hlmode === '1') {
      const color = ($('[data-dc][aria-pressed="true"]', wrap) || {}).dataset?.dc || 'yellow';
      const existing = Store.s.highlights.find((h) => h.block === blockId && h.node === node.id);
      if (existing && existing.color === color) Store.s.highlights = Store.s.highlights.filter((h) => h !== existing);
      else if (existing) existing.color = color;
      else Store.s.highlights.push({ id: uid(), block: blockId, node: node.id, text: node.label, color, note: '', created: Date.now() });
      Store.save();
      drawDiagram(wrap);
      return;
    }
    wrap.dataset.sel = node.id;
    drawDiagram(wrap);
    const info = $('.dinfo', wrap);
    const refs = [];
    if (node.ref) for (const r of String(node.ref).split(/\s*,\s*/)) {
      const m = r.match(/^(\d+)\.(\d+)(?:[–-](\d+))?$/);
      if (m) refs.push(`<a class="btn" href="#/ch/${m[1]}/b/${enc('v:' + m[1] + '.' + m[2])}">Go to ${m[1]}.${m[2]}${m[3] ? '–' + m[3] : ''}</a>`);
    }
    const hl = Store.s.highlights.find((h) => h.block === blockId && h.node === node.id);
    info.innerHTML = `<h4>${esc(node.label)}</h4>${node.text ? `<p>${md(node.text)}</p>` : ''}
      <div class="btnrow">${node.term && termKey(node.term) ? `<button class="btn" data-openterm="${esc(termKey(node.term))}">Define “${esc(gloss.get(termKey(node.term)).term)}”</button>` : ''}${refs.join('')}
      ${hl ? `<button class="btn" data-openhl="${esc(hl.id)}">Note on this box</button>` : ''}</div>`;
    info.hidden = false;
    autolink(info);
  }

  // ---------- sheet / toast ----------
  const sheetWrap = $('#sheetWrap');
  let lastFocus = null;
  function openSheet(html, onMount) {
    lastFocus = document.activeElement;
    // Replace the body node so listeners from the previous sheet are dropped.
    const old = $('#sheetBody');
    const fresh = old.cloneNode(false);
    old.replaceWith(fresh);
    fresh.innerHTML = html;
    sheetWrap.hidden = false;
    document.body.style.overflow = 'hidden';
    if (onMount) onMount(fresh);
    setTimeout(() => { const f = $('.sheet-close', sheetWrap); if (f && !fresh.contains(document.activeElement)) f.focus(); }, 30);
  }
  function closeSheet() {
    sheetWrap.hidden = true;
    document.body.style.overflow = '';
    if (lastFocus && lastFocus.focus) try { lastFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }
  sheetWrap.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeSheet(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !sheetWrap.hidden) closeSheet(); });
  let toastT;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 2200);
  }

  function openTerm(key) {
    const g = gloss.get(key);
    if (!g) return;
    openSheet(`
      <p class="kind">Term</p>
      <h2>${esc(g.term)}${g.sanskrit ? ` <span class="muted" style="font-weight:400;font-style:italic">${esc(g.sanskrit)}</span>` : ''}</h2>
      <p class="lede">${md(g.short)}</p>
      <div class="autolink">${(g.body || []).map((p) => `<p>${md(p)}</p>`).join('')}</div>
      ${g.refs && g.refs.length ? `<p class="small sans muted">Key verses: ${g.refs.map((r) => md('{' + r + '}')).join(' · ')}</p>` : ''}
      ${g.related && g.related.length ? `<p class="small sans">Related: ${g.related.filter((r) => gloss.has(r)).map((r) => `<a class="term" data-term="${esc(r)}" href="#/glossary/${enc(r)}">${esc(gloss.get(r).term)}</a>`).join(' · ')}</p>` : ''}
      <div class="btnrow"><a class="btn" href="#/glossary/${enc(key)}" data-close>Open in glossary</a></div>`, (body) => {
      const al = $('.autolink', body);
      if (al) { $$('a.term', al); autolink(al); }
      body.addEventListener('click', (e) => { const a = e.target.closest('a'); if (a && !a.classList.contains('term')) closeSheet(); });
    });
  }

  // ---------- global click delegation ----------
  document.addEventListener('click', (e) => {
    const term = e.target.closest('a.term, [data-openterm]');
    if (term) { e.preventDefault(); openTerm(term.dataset.term || term.dataset.openterm); return; }
    const mk = e.target.closest('mark.hl');
    if (mk && !window.getSelection().toString()) { e.preventDefault(); openHighlight(mk.dataset.hid); return; }
    const ohl = e.target.closest('[data-openhl]');
    if (ohl) { openHighlight(ohl.dataset.openhl, true); return; }
    const dw = e.target.closest('.diagram');
    if (dw) { diagramClick(dw, e); return; }
    const fn = e.target.closest('[data-fn]');
    if (fn) {
      const box = document.getElementById(fn.dataset.fn);
      if (box) { box.hidden = !box.hidden; fn.setAttribute('aria-expanded', String(!box.hidden)); }
      return;
    }
    const vb = e.target.closest('[data-verse]');
    if (vb) { openVerseActions(vb.dataset.verse); return; }
    const addn = e.target.closest('[data-addnote]');
    if (addn) { openNoteEditor({ anchor: addn.dataset.addnote }); return; }
    const ed = e.target.closest('[data-editnote]');
    if (ed) { openNoteEditor({ id: ed.dataset.editnote }); return; }
    const nav = e.target.closest('a[href^="#/"]');
    if (nav && !sheetWrap.hidden && sheetWrap.contains(nav)) closeSheet();
  });
  document.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('.node')) { e.preventDefault(); e.target.dispatchEvent(new MouseEvent('click', { bubbles: true })); }
  });

  function openVerseActions(vid) {
    const v = verseById.get(vid);
    if (!v) return;
    const block = 'v:' + vid;
    const existing = Store.s.highlights.filter((h) => h.block === block);
    openSheet(`
      <p class="kind">Verse ${esc(vid)}</p>
      <h2>${v.speaker ? esc(v.speaker) + ' said' : 'Verse ' + esc(vid)}</h2>
      <div class="quote">${md(v.text)}</div>
      <p class="small sans muted">Highlight the whole verse:</p>
      <div class="chips">${COLORS.map((c) => `<button class="dot c-${c}" data-vc="${c}" aria-label="${c}"></button>`).join('')}</div>
      <p class="small sans muted">Or select any words in the verse to highlight just those.</p>
      <div class="btnrow">
        <button class="btn primary" data-act="note">Add a note to this verse</button>
        <button class="btn" data-act="copy">Copy verse</button>
        ${existing.length ? `<button class="btn danger" data-act="clear">Remove ${existing.length} highlight${existing.length > 1 ? 's' : ''}</button>` : ''}
      </div>`, (body) => {
      body.addEventListener('click', async (e) => {
        const c = e.target.closest('[data-vc]');
        const el = $(`[data-hl="${CSS.escape(block)}"]`);
        if (c && el) {
          const text = baseText(el);
          addHighlight({ block, start: 0, end: text.length, text }, c.dataset.vc);
          closeSheet(); toast('Verse highlighted');
          return;
        }
        const act = e.target.closest('[data-act]');
        if (!act) return;
        if (act.dataset.act === 'note') { closeSheet(); openNoteEditor({ anchor: block }); }
        if (act.dataset.act === 'copy') {
          const plain = `${v.speaker ? v.speaker + ' said: ' : ''}${stripMd(v.text)} (Bhagavad Gītā ${vid})`;
          try { await navigator.clipboard.writeText(plain); toast('Copied'); } catch (err) { toast('Copy is not available here'); }
          closeSheet();
        }
        if (act.dataset.act === 'clear') {
          Store.s.highlights = Store.s.highlights.filter((h) => h.block !== block); Store.save(); repaint(block); closeSheet(); toast('Highlights removed');
        }
      });
    });
  }
  function baseText(el) { const d = document.createElement('div'); d.innerHTML = baseHTML.get(el) || el.innerHTML; return d.textContent; }
  function stripMd(s) { return String(s).replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2').replace(/\[\[([^\]]+)\]\]/g, '$1').replace(/\{(\d+\.\d+(?:[–-]\d+)?)\}/g, '$1').replace(/\*\*?([^*]+)\*\*?/g, '$1'); }

  // ---------- views ----------
  const main = $('#main');
  const titleEl = $('#topTitle');
  const backBtn = $('#backBtn');
  let current = { view: null, args: [] };

  function setChrome(title, tab, back) {
    titleEl.textContent = title;
    document.title = title === 'Gītā Companion' ? title : `${title} · Gītā Companion`;
    $$('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
    backBtn.hidden = !back;
  }
  backBtn.addEventListener('click', () => { if (history.length > 1) history.back(); else location.hash = '#/'; });

  function viewHome() {
    setChrome('Gītā Companion', 'home', false);
    const day = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 864e5);
    const all = Array.from(verseById.values());
    const dv = all[(day * 7) % all.length];
    const last = Store.s.last && Store.s.last.startsWith('#/ch/') ? Store.s.last : null;
    const lastCh = last ? chapterByN.get(Number(last.split('/')[2])) : null;
    const counts = { h: Store.s.highlights.length, n: Store.s.notes.length };
    main.innerHTML = `
      <section class="hero">
        <p class="om">Oṁ · Bhagavad Gītā</p>
        <h1>Gītā Companion</h1>
        <p class="lede">The Song of the Lord, verse by verse, with notes, analysis and diagrams for serious study.</p>
      </section>
      ${lastCh ? `<a class="card" style="display:block;text-decoration:none;color:inherit" href="${esc(last)}"><span class="eyebrow" style="margin:0">Continue reading</span><br><strong>Chapter ${lastCh.n} · ${esc(lastCh.title)}</strong></a>` : ''}
      <section class="card daily">
        <p class="eyebrow" style="margin:0">Verse for today</p>
        <blockquote data-hl="v:${esc(dv.id)}" class="nolink">${md(dv.text)}</blockquote>
        <a class="ref" href="#/ch/${dv.ch}/b/${enc('v:' + dv.id)}">Bhagavad Gītā ${esc(dv.id)} →</a>
      </section>
      <h2>Begin</h2>
      <ul class="list">
        <li><a class="row" href="#/intro"><span class="num">i</span><span><span class="ttl">Introduction</span><span class="sub">Key terms, frameworks and background</span></span><span class="chev">›</span></a></li>
        <li><a class="row" href="#/read"><span class="num">18</span><span><span class="ttl">The eighteen chapters</span><span class="sub">700 verses with study apparatus</span></span><span class="chev">›</span></a></li>
        <li><a class="row" href="#/diagrams"><span class="num">◇</span><span><span class="ttl">Diagrams</span><span class="sub">Concept maps and argument structures</span></span><span class="chev">›</span></a></li>
        <li><a class="row" href="#/glossary"><span class="num">A</span><span><span class="ttl">Glossary</span><span class="sub">${D.glossary.length} terms, each defined in depth</span></span><span class="chev">›</span></a></li>
        <li><a class="row" href="#/notes"><span class="num">✎</span><span><span class="ttl">My highlights &amp; notes</span><span class="sub">${counts.h} highlight${counts.h === 1 ? '' : 's'} · ${counts.n} note${counts.n === 1 ? '' : 's'}</span></span><span class="chev">›</span></a></li>
        <li><a class="row" href="#/about"><span class="num">?</span><span><span class="ttl">How to use &amp; install</span><span class="sub">Highlighting, notes, offline use</span></span><span class="chev">›</span></a></li>
      </ul>`;
    prepBlocks(main);
  }

  function viewRead() {
    setChrome('Chapters', 'read', false);
    main.innerHTML = `<p class="eyebrow">The Bhagavad Gītā</p><h1>Eighteen chapters</h1>
      <p class="lede">Each chapter opens with an overview and a concept map, then moves through its sections: the verses, footnotes, and the study panels.</p>
      <ul class="list">
        <li><a class="row" href="#/intro"><span class="num">i</span><span><span class="ttl">Introduction</span><span class="sub">Read this first</span></span><span class="chev">›</span></a></li>
        ${D.chapters.map((c) => `<li><a class="row" href="#/ch/${c.n}"><span class="num">${c.n}</span><span><span class="ttl">${esc(c.title)}</span><span class="sub">${esc(c.sanskrit)} · ${c.verses.length} verses</span></span><span class="chev">›</span></a></li>`).join('')}
      </ul>`;
  }

  function viewIntro() {
    setChrome('Introduction', 'read', true);
    const I = D.intro;
    main.innerHTML = `<div class="chap-head"><p class="eyebrow">Before the first verse</p><h1>${esc(I.title)}</h1><p class="lede">${md(I.lede)}</p></div>
      <details class="panel"><summary>Contents</summary><div class="pbody"><ol>${I.sections.map((s) => `<li><a href="#/intro/b/${enc('isec:' + s.id)}">${esc(s.title)}</a></li>`).join('')}</ol></div></details>
      ${I.map ? `<details class="panel" open><summary>Diagram: the shape of the Gītā</summary><div class="pbody">${diagramHTML(I.map, 'd:map-intro')}</div></details>` : ''}
      ${I.sections.map((s) => `<section class="section" id="isec:${esc(s.id)}"><h2>${esc(s.title)}</h2>${paras(s.paras, 'i:' + s.id)}</section>`).join('')}
      <div class="pager"><a class="btn" href="#/read">All chapters</a><a class="btn primary" href="#/ch/1">Chapter 1 →</a></div>`;
    prepBlocks(main);
    $$('.diagram', main).forEach(drawDiagram);
  }

  const PANELS = [
    ['reconstruction', 'Reconstruction: the argument in its own voice'],
    ['insight', 'Insight: structure, strengths, tensions'],
    ['sources', 'Sources cited and echoed'],
    ['context', 'In the wider conversation'],
    ['matters', 'Why it matters'],
  ];
  function viewChapter(n) {
    const ch = chapterByN.get(n);
    if (!ch) return viewNotFound();
    setChrome(`Chapter ${n}`, 'read', true);
    const sectionNotes = (sid) => Store.s.notes.filter((x) => x.anchor === 's:' + sid || (x.anchor.startsWith('v:') && sectionById.get(sid) && (() => { const [c, v] = x.anchor.slice(2).split('.').map(Number); const s = sectionOfVerse(c, v); return s && s.id === sid; })()));
    const verseHTML = (v) => {
      const fns = [];
      (v.tnotes || []).forEach((t, i) => fns.push({ id: `tn-${v.id}-${i}`, kind: 'Translator’s note', cls: 'tn', text: t, label: 'Translator’s note' }));
      (v.fnotes || []).forEach((t, i) => fns.push({ id: `fn-${v.id}-${i}`, kind: 'Study footnote', cls: '', text: t, label: v.fnotes.length > 1 ? `Footnote ${i + 1}` : 'Footnote' }));
      return `<div class="verse" id="v:${esc(v.id)}">
        <button class="vnum" data-verse="${esc(v.id)}" aria-label="Verse ${esc(v.id)} options">${esc(v.id)}</button>
        <div class="vbody">
          ${v.speaker ? `<p class="speaker">${esc(v.speaker)}</p>` : ''}
          <p class="vtext" data-hl="v:${esc(v.id)}">${md(v.text)}</p>
          ${fns.map((f) => `<button class="fnbtn" data-fn="${esc(f.id)}" aria-expanded="false" aria-controls="${esc(f.id)}">${f.cls ? '✦ ' : '† '}${esc(f.label)}</button>`).join('')}
          ${fns.map((f) => `<div class="fn ${f.cls}" id="${esc(f.id)}" hidden><span class="fn-kind">${esc(f.kind)}</span><p class="autolink">${md(f.text)}</p></div>`).join('')}
        </div></div>`;
    };
    const sectionHTML = (s, i) => {
      const verses = ch.verses.filter((v) => v.v >= s.from && v.v <= s.to);
      const fnAll = [];
      verses.forEach((v) => {
        (v.tnotes || []).forEach((t) => fnAll.push([v.id, 'Translator’s note', t]));
        (v.fnotes || []).forEach((t) => fnAll.push([v.id, 'Study footnote', t]));
      });
      const notes = sectionNotes(s.id);
      return `<section class="section" id="sec:${esc(s.id)}">
        <h2><span class="section-range">Section ${i + 1} · ${n}.${s.from}–${s.to}</span>${esc(s.title)}</h2>
        ${s.lead ? `<p class="lede autolink">${md(s.lead)}</p>` : ''}
        <div class="verses">${verses.map(verseHTML).join('')}</div>
        <p class="study-label">Study this section</p>
        <details class="panel"><summary>Footnotes <span class="count">(${fnAll.length})</span></summary><div class="pbody">
          ${fnAll.length ? fnAll.map(([vid, kind, t]) => `<div class="fn ${kind.startsWith('Trans') ? 'tn' : ''}"><span class="fn-kind">${md('{' + vid + '}')} · ${esc(kind)}</span><p class="autolink">${md(t)}</p></div>`).join('') : '<p class="muted">No footnotes in this section.</p>'}
        </div></details>
        ${PANELS.filter(([k]) => s[k] && s[k].length).map(([k, label]) => `<details class="panel" id="${esc('a:' + s.id + ':' + k)}"><summary>${esc(label)}</summary><div class="pbody">${paras(s[k], 'a:' + s.id + ':' + k)}</div></details>`).join('')}
        ${s.questions && s.questions.length ? `<details class="panel"><summary>Discussion questions <span class="count">(${s.questions.length})</span></summary><div class="pbody"><ol class="questions autolink">${s.questions.map((q) => `<li>${md(q)}</li>`).join('')}</ol></div></details>` : ''}
        ${s.argDiagram.nodes.length ? `<details class="panel" id="${esc('d:' + s.argDiagram.id)}-p"><summary>Diagram: argument structure</summary><div class="pbody">${diagramHTML(s.argDiagram, 'd:' + s.argDiagram.id)}</div></details>` : ''}
        <details class="panel" id="sec-notes-${esc(s.id)}"${notes.length ? ' open' : ''}><summary>My notes <span class="count">(${notes.length})</span></summary><div class="pbody">
          ${notes.map((x) => noteHTML(x, x.anchor.startsWith('v:'))).join('') || '<p class="muted">No notes yet.</p>'}
          <div class="btnrow"><button class="btn" data-addnote="s:${esc(s.id)}">+ Add a note to this section</button></div>
        </div></details>
      </section>`;
    };
    const prev = chapterByN.get(n - 1), next = chapterByN.get(n + 1);
    main.innerHTML = `
      <div class="chap-head" id="top">
        <p class="eyebrow">Chapter ${n}</p>
        <h1>${esc(ch.title)}</h1>
        <p class="sanskrit-title">${esc(ch.sanskrit)}</p>
      </div>
      <p class="lede" data-hl="c:${n}:summary:0">${md(ch.summary)}</p>
      <details class="panel" id="c:${n}:overview"><summary>Overview of the chapter</summary><div class="pbody">${paras(ch.overview, 'c:' + n + ':overview')}
        <p class="small sans muted">Sections: ${ch.sections.map((s, i) => `<a href="#/ch/${n}/b/${enc('sec:' + s.id)}">${i + 1}. ${esc(s.title)}</a>`).join(' · ')}</p></div></details>
      ${ch.map ? `<details class="panel" open id="d:${esc(ch.map.id)}-p"><summary>Diagram: concept map of chapter ${n}</summary><div class="pbody">${diagramHTML(ch.map, 'd:' + ch.map.id)}</div></details>` : ''}
      ${ch.sections.map(sectionHTML).join('')}
      <hr class="orn">
      ${ch.research && ch.research.length ? `<details class="panel" id="c:${n}:research"><summary>Current research and debates</summary><div class="pbody">${paras(ch.research, 'c:' + n + ':research')}</div></details>` : ''}
      ${ch.questions && ch.questions.length ? `<details class="panel"><summary>Seminar questions for the whole chapter <span class="count">(${ch.questions.length})</span></summary><div class="pbody"><ol class="questions autolink">${ch.questions.map((q) => `<li>${md(q)}</li>`).join('')}</ol></div></details>` : ''}
      ${ch.colophon ? `<p class="muted small" style="text-align:center;font-style:italic">${md(ch.colophon)}</p>` : ''}
      <div class="pager">
        ${prev ? `<a class="btn" href="#/ch/${prev.n}">← Chapter ${prev.n}</a>` : '<a class="btn" href="#/intro">← Introduction</a>'}
        ${next ? `<a class="btn primary" href="#/ch/${next.n}">Chapter ${next.n} →</a>` : '<a class="btn primary" href="#/notes">My notes →</a>'}
      </div>`;
    prepBlocks(main);
    $$('.diagram', main).forEach(drawDiagram);
  }

  function viewGlossary(key) {
    setChrome('Glossary', 'glossary', !!key);
    const letters = Array.from(new Set(D.glossary.map((g) => fold(g.term)[0].toUpperCase()))).sort();
    main.innerHTML = `<p class="eyebrow">Glossary</p><h1>Terms</h1>
      <p class="lede">Every technical term in the app links here. Sanskrit words are listed under their usual transliteration.</p>
      <div class="searchbox"><input type="search" id="gq" placeholder="Filter ${D.glossary.length} terms…" aria-label="Filter glossary" autocomplete="off"></div>
      <nav class="alpha" aria-label="Jump to letter">${letters.map((l) => `<a href="#gl-${l}" data-letter="${l}">${l}</a>`).join('')}</nav>
      <div id="glist">${D.glossary.map((g, i) => {
        const L = fold(g.term)[0].toUpperCase();
        const first = i === 0 || fold(D.glossary[i - 1].term)[0].toUpperCase() !== L;
        return `${first ? `<h3 class="group-title" id="gl-${L}">${L}</h3>` : ''}<div class="gloss-entry" id="g-${esc(g.key)}" data-fold="${esc(fold([g.term, g.sanskrit || '', ...(g.aliases || []), g.short].join(' ')))}">
          <button aria-expanded="false" data-gk="${esc(g.key)}"><span class="gterm">${esc(g.term)}</span>${g.sanskrit ? `<span class="gsk">${esc(g.sanskrit)}</span>` : ''}<span class="gshort">${md(g.short).replace(/<a [^>]*>|<\/a>/g, '')}</span></button>
          <div class="gloss-body autolink" hidden>${(g.body || []).map((p) => `<p>${md(p)}</p>`).join('')}
            ${g.refs && g.refs.length ? `<p class="small sans muted">Key verses: ${g.refs.map((r) => md('{' + r + '}')).join(' · ')}</p>` : ''}
            ${g.related && g.related.length ? `<p class="small sans">Related: ${g.related.filter((r) => gloss.has(r)).map((r) => `<a href="#/glossary/${enc(r)}">${esc(gloss.get(r).term)}</a>`).join(' · ')}</p>` : ''}
          </div></div>`;
      }).join('')}</div>`;
    const toggle = (entry, open) => {
      const b = $('button', entry), body = $('.gloss-body', entry);
      body.hidden = !open; b.setAttribute('aria-expanded', String(open));
      if (open && !body.dataset.linked) { autolink(body); body.dataset.linked = '1'; }
    };
    $('#glist').addEventListener('click', (e) => {
      const b = e.target.closest('[data-gk]');
      if (b) { const entry = b.parentElement; toggle(entry, b.getAttribute('aria-expanded') !== 'true'); }
    });
    $('.alpha', main).addEventListener('click', (e) => {
      const a = e.target.closest('[data-letter]');
      if (!a) return;
      e.preventDefault();
      const t = document.getElementById('gl-' + a.dataset.letter);
      if (t) t.scrollIntoView({ block: 'start' });
    });
    $('#gq').addEventListener('input', (e) => {
      const q = fold(e.target.value.trim());
      for (const ent of $$('.gloss-entry', main)) ent.hidden = q && !ent.dataset.fold.includes(q);
      for (const h of $$('.group-title', main)) h.hidden = !!q;
    });
    if (key) {
      const entry = document.getElementById('g-' + key);
      if (entry) { toggle(entry, true); requestAnimationFrame(() => { entry.scrollIntoView({ block: 'start' }); entry.classList.add('flash'); }); }
    }
  }

  function viewDiagrams() {
    setChrome('Diagrams', 'read', true);
    const items = Array.from(diagrams.entries());
    main.innerHTML = `<p class="eyebrow">Diagrams</p><h1>Maps of the argument</h1>
      <p class="lede">A concept map for the introduction and for each chapter, plus an argument diagram for every section. Tap a box for an explanation, a definition, or a link to its verses. Use <strong>Highlight</strong> to colour boxes; those highlights are saved with your notes.</p>
      <div class="chips" role="group" aria-label="Filter"><button class="chip" aria-pressed="true" data-df="all">All</button><button class="chip" aria-pressed="false" data-df="map">Concept maps</button><button class="chip" aria-pressed="false" data-df="arg">Argument diagrams</button></div>
      <ul class="list" id="dlist">${items.map(([id, d]) => {
        const loc = locate('d:' + id);
        return `<li data-kind="${id.startsWith('map') ? 'map' : 'arg'}"><a class="row" href="${loc.route}"><span class="num">${id.startsWith('map') ? '◇' : '→'}</span><span><span class="ttl">${esc(d.label)}</span><span class="sub">${id.startsWith('map') ? 'Concept map' : 'Argument structure'} · ${d.diag.nodes.length} nodes</span></span><span class="chev">›</span></a></li>`;
      }).join('')}</ul>`;
    $('.chips', main).addEventListener('click', (e) => {
      const b = e.target.closest('[data-df]');
      if (!b) return;
      $$('[data-df]', main).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      for (const li of $$('#dlist li', main)) li.hidden = b.dataset.df !== 'all' && li.dataset.kind !== b.dataset.df;
    });
  }

  let notesFilter = { color: 'all', q: '' };
  function viewNotes() {
    setChrome('My notes', 'notes', false);
    main.innerHTML = `<p class="eyebrow">Your study</p><h1>Highlights &amp; notes</h1>
      <div class="searchbox"><input type="search" id="nq" placeholder="Search your highlights and notes…" aria-label="Search highlights and notes" value="${esc(notesFilter.q)}" autocomplete="off"></div>
      <div class="chips" role="group" aria-label="Filter">
        <button class="chip" data-nf="all" aria-pressed="${notesFilter.color === 'all'}">All</button>
        <button class="chip" data-nf="notes" aria-pressed="${notesFilter.color === 'notes'}">Notes</button>
        ${COLORS.map((c) => `<button class="chip" data-nf="${c}" aria-pressed="${notesFilter.color === c}"><span class="dot c-${c}" style="width:14px;height:14px;border:0"></span>${c}</button>`).join('')}
      </div>
      <div id="nlist"></div>
      <hr class="orn">
      <h3>Back up and restore</h3>
      <p class="small muted">Everything is stored on this device only. Export a file to keep a copy or move it to another device.</p>
      <div class="btnrow"><button class="btn" id="exportBtn">Export</button><label class="btn" for="importFile">Import</label><input type="file" id="importFile" accept="application/json,.json" hidden></div>`;
    renderNotesList();
    $('#nq').addEventListener('input', debounce((e) => { notesFilter.q = e.target.value; renderNotesList(); }, 150));
    $('.chips', main).addEventListener('click', (e) => {
      const b = e.target.closest('[data-nf]');
      if (!b) return;
      notesFilter.color = b.dataset.nf;
      $$('[data-nf]', main).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      renderNotesList();
    });
    $('#exportBtn').addEventListener('click', exportData);
    $('#importFile').addEventListener('change', importData);
  }
  function renderNotesList() {
    const list = $('#nlist');
    if (!list) return;
    const q = fold(notesFilter.q.trim());
    const items = [];
    for (const h of Store.s.highlights) {
      if (h.block.startsWith('n:')) continue; // shown inside their notes
      if (notesFilter.color === 'notes' && !h.note) continue;
      if (COLORS.includes(notesFilter.color) && h.color !== notesFilter.color) continue;
      if (q && !fold((h.text || '') + ' ' + (h.note || '')).includes(q)) continue;
      items.push({ kind: 'h', o: h, loc: locate(h.block) });
    }
    if (notesFilter.color === 'all' || notesFilter.color === 'notes' || COLORS.includes(notesFilter.color)) {
      for (const n of Store.s.notes) {
        const hs = Store.s.highlights.filter((h) => h.block === 'n:' + n.id);
        if (COLORS.includes(notesFilter.color) && !hs.some((h) => h.color === notesFilter.color)) continue;
        if (q && !fold(n.text).includes(q)) continue;
        items.push({ kind: 'n', o: n, loc: locate(n.anchor) });
      }
    }
    if (!items.length) {
      list.innerHTML = Store.s.highlights.length + Store.s.notes.length
        ? '<p class="empty">Nothing matches this filter.</p>'
        : '<div class="empty"><p>No highlights or notes yet.</p><p class="small">Select words in any verse or commentary to highlight them, tap a verse number for more options, or use “+ Add a note” at the end of each section.</p><a class="btn" href="#/ch/1">Start reading</a></div>';
      return;
    }
    items.sort((a, b) => a.loc.order - b.loc.order || (a.o.created - b.o.created));
    let html = '', group = null;
    for (const it of items) {
      if (it.loc.group !== group) { group = it.loc.group; html += `<p class="group-title">${esc(group)}</p>`; }
      if (it.kind === 'h') {
        const h = it.o;
        const isDiag = h.block.startsWith('d:');
        html += `<div class="hlitem"><span class="bar c-${h.color}"></span><div>
          <div class="meta"><a href="${it.loc.route}">${esc(it.loc.title)}</a>${it.loc.sub ? ' · ' + esc(it.loc.sub) : ''}</div>
          <blockquote>${isDiag ? 'Diagram box: ' : ''}${esc(h.text || '')}</blockquote>
          ${h.note ? `<p class="notetext">${esc(h.note)}</p>` : ''}
          <div class="meta"><button class="linkbtn" data-openhl="${esc(h.id)}">${h.note ? 'Edit' : 'Add note / edit'}</button></div></div></div>`;
      } else html += noteHTML(it.o, true);
    }
    list.innerHTML = html;
    prepBlocks(list);
  }
  function refreshIfNotes() { if (current.view === 'notes') renderNotesList(); }

  function exportData() {
    const blob = new Blob([JSON.stringify({ app: 'gita-companion', version: 1, exported: new Date().toISOString(), highlights: Store.s.highlights, notes: Store.s.notes }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `gita-notes-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function importData(e) {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const d = JSON.parse(r.result);
        if (!Array.isArray(d.highlights) || !Array.isArray(d.notes)) throw new Error('bad');
        const hids = new Set(Store.s.highlights.map((h) => h.id)), nids = new Set(Store.s.notes.map((n) => n.id));
        let added = 0;
        for (const h of d.highlights) if (h && h.id && h.block && COLORS.includes(h.color) && !hids.has(h.id)) { Store.s.highlights.push(h); added++; }
        for (const n of d.notes) if (n && n.id && typeof n.text === 'string' && n.anchor && !nids.has(n.id)) { Store.s.notes.push(n); added++; }
        Store.save(); toast(`Imported ${added} item${added === 1 ? '' : 's'}`); rerender();
      } catch (err) { toast('That file is not a Gītā Companion export.'); }
    };
    r.readAsText(f);
  }

  // Search
  let staticIndex = null;
  function buildIndex() {
    const idx = [];
    for (const ch of D.chapters) {
      for (const v of ch.verses) {
        idx.push({ k: 'Verse', t: `${v.id}${v.speaker ? ' · ' + v.speaker : ''}`, x: stripMd(v.text), r: `#/ch/${ch.n}/b/${enc('v:' + v.id)}` });
        (v.tnotes || []).forEach((t) => idx.push({ k: 'Translator’s note', t: v.id, x: stripMd(t), r: `#/ch/${ch.n}/b/${enc('v:' + v.id)}` }));
        (v.fnotes || []).forEach((t) => idx.push({ k: 'Footnote', t: v.id, x: stripMd(t), r: `#/ch/${ch.n}/b/${enc('v:' + v.id)}` }));
      }
      idx.push({ k: 'Chapter', t: `Chapter ${ch.n} · ${ch.title}`, x: stripMd([ch.sanskrit, ch.summary, ...(ch.overview || [])].join(' ')), r: `#/ch/${ch.n}` });
      (ch.research || []).forEach((p, i) => idx.push({ k: 'Research', t: `Chapter ${ch.n}`, x: stripMd(p), r: `#/ch/${ch.n}/b/${enc('c:' + ch.n + ':research:' + i)}` }));
      (ch.questions || []).forEach((p) => idx.push({ k: 'Question', t: `Chapter ${ch.n}`, x: stripMd(p), r: `#/ch/${ch.n}` }));
      for (const s of ch.sections) {
        for (const [k, label] of PANELS) (s[k] || []).forEach((p, i) => idx.push({ k: label.split(':')[0], t: `${ch.n}.${s.from}–${s.to} · ${s.title}`, x: stripMd(p), r: `#/ch/${ch.n}/b/${enc('a:' + s.id + ':' + k + ':' + i)}` }));
        (s.questions || []).forEach((q) => idx.push({ k: 'Question', t: `${ch.n}.${s.from}–${s.to} · ${s.title}`, x: stripMd(q), r: `#/ch/${ch.n}/b/${enc('sec:' + s.id)}` }));
        idx.push({ k: 'Section', t: `${ch.n}.${s.from}–${s.to} · ${s.title}`, x: stripMd(s.lead || s.title), r: `#/ch/${ch.n}/b/${enc('sec:' + s.id)}` });
      }
    }
    for (const s of D.intro.sections) s.paras.forEach((p, i) => idx.push({ k: 'Introduction', t: s.title, x: stripMd(p), r: `#/intro/b/${enc('i:' + s.id + ':' + i)}` }));
    for (const g of D.glossary) idx.push({ k: 'Glossary', t: g.term + (g.sanskrit ? ' · ' + g.sanskrit : ''), x: stripMd([g.short, ...(g.aliases || []), ...(g.body || [])].join(' ')), r: `#/glossary/${enc(g.key)}` });
    for (const d of diagrams.values()) for (const n of d.diag.nodes) idx.push({ k: 'Diagram', t: d.label, x: stripMd(n.label + '. ' + (n.text || '')), r: locate('d:' + d.diag.id).route });
    for (const it of idx) it.f = fold(it.t + ' ' + it.x);
    return idx;
  }
  function viewSearch(q) {
    setChrome('Search', 'search', false);
    main.innerHTML = `<p class="eyebrow">Search</p><h1>Search everything</h1>
      <div class="searchbox"><input type="search" id="sq" placeholder="Verses, footnotes, analysis, glossary, your notes…" aria-label="Search" value="${esc(q || '')}" autocomplete="off" enterkeyhint="search"></div>
      <p class="small muted sans">Diacritics are optional: “krsna” finds “Kṛṣṇa”.</p>
      <div id="sres"></div>`;
    const input = $('#sq');
    const run = () => {
      const raw = input.value.trim();
      history.replaceState(null, '', '#/search' + (raw ? '/' + enc(raw) : ''));
      renderResults(raw);
    };
    input.addEventListener('input', debounce(run, 180));
    renderResults(q || '');
    if (!q) setTimeout(() => input.focus(), 50);
  }
  function renderResults(raw) {
    const box = $('#sres');
    if (!box) return;
    const q = fold(raw);
    if (q.length < 2) { box.innerHTML = '<p class="empty">Type at least two letters.</p>'; return; }
    if (!staticIndex) staticIndex = buildIndex();
    const user = [];
    for (const n of Store.s.notes) user.push({ k: 'My note', t: locate(n.anchor).title, x: n.text, r: locate(n.anchor).route });
    for (const h of Store.s.highlights) if (!h.block.startsWith('n:')) user.push({ k: 'My highlight', t: locate(h.block).title, x: (h.text || '') + (h.note ? ' — ' + h.note : ''), r: locate(h.block).route });
    for (const u of user) u.f = fold(u.t + ' ' + u.x);
    const terms = q.split(/\s+/).filter(Boolean);
    const hits = [...user, ...staticIndex].filter((it) => terms.every((t) => it.f.includes(t)));
    if (!hits.length) { box.innerHTML = `<p class="empty">No results for “${esc(raw)}”.</p>`; return; }
    const shown = hits.slice(0, 150);
    box.innerHTML = `<p class="small muted sans">${hits.length} result${hits.length === 1 ? '' : 's'}${hits.length > shown.length ? ` (showing first ${shown.length})` : ''}</p>` +
      shown.map((it) => `<a class="result" href="${it.r}"><span class="rkind">${esc(it.k)}</span><span class="rtitle">${esc(it.t)}</span><span class="rsnip">${snippet(it.x, terms[0])}</span></a>`).join('');
  }
  function snippet(text, term) {
    const f = fold(text);
    const i = f.indexOf(term);
    if (i < 0) return esc(text.slice(0, 160));
    const s = Math.max(0, i - 60), e = Math.min(text.length, i + term.length + 100);
    return (s > 0 ? '…' : '') + esc(text.slice(s, i)) + '<b>' + esc(text.slice(i, i + term.length)) + '</b>' + esc(text.slice(i + term.length, e)) + (e < text.length ? '…' : '');
  }

  function viewAbout() {
    setChrome('How to use', 'home', true);
    main.innerHTML = `<p class="eyebrow">Guide</p><h1>How to use this companion</h1>
      <h2>Reading</h2>
      <p>Each chapter opens with a summary, an overview and a concept map. It then moves section by section through the verses. Under each section are the study panels: footnotes, a reconstruction of the argument, insight into its structure, sources, its place in the wider conversation, why it matters, discussion questions and an argument diagram. Everything stays folded until you open it.</p>
      <p>Words with a dotted underline are technical terms. Tap one for its definition. The <a href="#/glossary">glossary</a> lists them all.</p>
      <p>A <strong>†</strong> button under a verse opens a study footnote. A <strong>✦</strong> button opens the translator's note on a genuinely ambiguous phrase.</p>
      <h2>Highlighting and notes</h2>
      <p>Select any words in a verse, the commentary or your own notes. A bar appears at the bottom: pick a colour, or tap <strong>+ Note</strong> to highlight and annotate at once. Tap a highlight to recolour it, add a note or delete it.</p>
      <p>Tap a verse number to highlight the whole verse, attach a note, or copy it. Each section ends with <strong>My notes</strong>, where you can write longer notes.</p>
      <p>In diagrams, tap <strong>Highlight</strong>, choose a colour and tap boxes. Tap <strong>Highlight</strong> again to finish.</p>
      <p>All highlights and notes are collected, searchable and filterable by colour in <a href="#/notes">My notes</a>. They are stored on this device only. Use Export there to make a backup.</p>
      <h2>Installing on your phone</h2>
      <p><strong>iPhone / iPad (Safari):</strong> open this site, tap the Share button, then <em>Add to Home Screen</em>.</p>
      <p><strong>Android (Chrome):</strong> open this site, tap the ⋮ menu, then <em>Install app</em> or <em>Add to Home screen</em>.</p>
      ${deferredInstall ? '<div class="btnrow"><button class="btn primary" id="installBtn">Install now</button></div>' : ''}
      <p>After the first visit the whole companion works offline.</p>
      <h2>About the text</h2>
      <p class="autolink">${md(D.meta.about)}</p>`;
    const ib = $('#installBtn');
    if (ib) ib.addEventListener('click', async () => { deferredInstall.prompt(); deferredInstall = null; ib.remove(); });
    prepBlocks(main);
  }
  function viewNotFound() {
    setChrome('Not found', 'home', true);
    main.innerHTML = '<div class="empty"><h1>Page not found</h1><p>That link does not point to anything in the companion.</p><a class="btn primary" href="#/">Go home</a></div>';
  }

  // Settings
  $('#settingsBtn').addEventListener('click', () => {
    const p = Store.s.prefs;
    openSheet(`<p class="kind">Reading settings</p><h2>Appearance</h2>
      <p class="small sans muted">Theme</p>
      <div class="chips">${['auto', 'light', 'dark'].map((t) => `<button class="chip" data-theme="${t}" aria-pressed="${p.theme === t}">${t === 'auto' ? 'Match device' : t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div>
      <p class="small sans muted">Text size</p>
      <div class="chips">${[[0.9, 'Smaller'], [1, 'Normal'], [1.12, 'Larger'], [1.25, 'Largest']].map(([v, l]) => `<button class="chip" data-size="${v}" aria-pressed="${p.size === v}">${l}</button>`).join('')}</div>
      <div class="btnrow"><a class="btn" href="#/about">How to use &amp; install</a></div>`, (body) => {
      body.addEventListener('click', (e) => {
        const t = e.target.closest('[data-theme]');
        if (t) { p.theme = t.dataset.theme; applyPrefs(); Store.save(); $$('[data-theme]', body).forEach((b) => b.setAttribute('aria-pressed', String(b === t))); }
        const s = e.target.closest('[data-size]');
        if (s) { p.size = Number(s.dataset.size); applyPrefs(); Store.save(); $$('[data-size]', body).forEach((b) => b.setAttribute('aria-pressed', String(b === s))); }
      });
    });
  });
  function applyPrefs() {
    const p = Store.s.prefs;
    if (p.theme === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', p.theme);
    document.documentElement.style.setProperty('--size', String(p.size || 1));
  }

  // ---------- router ----------
  function parse() {
    const h = location.hash.replace(/^#/, '') || '/';
    const parts = h.split('/').filter(Boolean).map((p) => { try { return decodeURIComponent(p); } catch (e) { return p; } });
    return parts;
  }
  function render(keepScroll) {
    const parts = parse();
    const [v, a, b, c] = parts;
    let anchor = null;
    sheetWrap.hidden = true; document.body.style.overflow = '';
    selbar.hidden = true; pendingSel = null;
    const y = window.scrollY;
    if (!v) { current = { view: 'home' }; viewHome(); }
    else if (v === 'read') { current = { view: 'read' }; viewRead(); }
    else if (v === 'intro') { current = { view: 'intro' }; viewIntro(); if (a === 'b') anchor = b; }
    else if (v === 'ch') { current = { view: 'ch', n: Number(a) }; viewChapter(Number(a)); if (b === 'b') anchor = c; }
    else if (v === 'glossary') { current = { view: 'glossary' }; viewGlossary(a); }
    else if (v === 'diagrams') { current = { view: 'diagrams' }; viewDiagrams(); }
    else if (v === 'notes') { current = { view: 'notes' }; viewNotes(); }
    else if (v === 'search') { current = { view: 'search' }; viewSearch(a || ''); }
    else if (v === 'about') { current = { view: 'about' }; viewAbout(); }
    else viewNotFound();
    if (v === 'ch' || v === 'intro') { Store.s.last = location.hash; Store.save(); }
    if (keepScroll) window.scrollTo(0, y);
    else if (anchor) requestAnimationFrame(() => goToAnchor(anchor));
    else if (v !== 'glossary' || !a) window.scrollTo(0, 0);
  }
  function goToAnchor(id) {
    let el = document.getElementById(id);
    if (!el) el = $(`[data-hl="${CSS.escape(id)}"]`);
    if (!el && id.startsWith('d:')) el = document.getElementById(id);
    if (!el) { window.scrollTo(0, 0); return; }
    for (let p = el.parentElement; p; p = p.parentElement) if (p.tagName === 'DETAILS') p.open = true;
    if (el.tagName === 'DETAILS') el.open = true;
    el.scrollIntoView({ block: 'start' });
    window.scrollBy(0, -70);
    const target = el.classList.contains('verse') || el.matches('[data-hl]') ? el : (el.querySelector('h2') || el);
    target.classList.remove('flash'); void target.offsetWidth; target.classList.add('flash');
  }
  function rerender() { render(true); }
  window.addEventListener('hashchange', () => render(false));

  // ---------- install & service worker ----------
  let deferredInstall = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; });
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => { /* offline support unavailable */ }); });
  }

  // ---------- boot ----------
  Store.load();
  applyPrefs();
  fetch('data/gita.json')
    .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then((data) => {
      D = data;
      indexData();
      if (!location.hash && Store.s.last) { /* start at home; "continue reading" card offers the last place */ }
      render(false);
    })
    .catch(() => {
      main.innerHTML = '<div class="empty"><h1>Could not load the text</h1><p>Check your connection and reload. After one successful visit, the companion works offline.</p><button class="btn primary" onclick="location.reload()">Reload</button></div>';
    });
})();
