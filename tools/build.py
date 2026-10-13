#!/usr/bin/env python3
"""Build data/gita.json from the translation and the study content.

    python3 tools/build.py

Inputs
  bhagavad-gita-translation.md   the verse text (speaker lines, verses, translator's notes)
  content/intro.txt              introductory chapter
  content/glossary.txt           glossary entries
  content/chNN.txt               per-chapter study apparatus (sections, footnotes, analysis, diagrams)

The build fails loudly on any broken reference so the app never ships a dead link.
"""
import json
import re
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
COUNTS = [47, 72, 43, 42, 29, 47, 30, 28, 34, 42, 55, 20, 34, 27, 20, 24, 28, 78]
ORD = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth',
       'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth']
errors = []


def err(msg):
    errors.append(msg)


def fold(s):
    return ''.join(c for c in unicodedata.normalize('NFD', s) if unicodedata.category(c) != 'Mn').lower()


# ---------------------------------------------------------------- translation
def parse_translation():
    text = (ROOT / 'bhagavad-gita-translation.md').read_text(encoding='utf-8')
    chapters, cur, speaker, last_verse = [], None, None, None
    for line in text.split('\n'):
        m = re.match(r'^## Chapter (\d+) · \*([^*]+)\* · (.+)$', line)
        if m:
            cur = {'n': int(m.group(1)), 'sanskrit': m.group(2), 'title': m.group(3).strip(), 'verses': []}
            chapters.append(cur)
            speaker, last_verse = None, None
            continue
        if cur is None:
            continue
        m = re.match(r'^\*([^*]+) said:\*\s*$', line)
        if m:
            speaker = m.group(1)
            continue
        m = re.match(r'^\*\*(\d+)\.(\d+)\*\*\s+(.*)$', line)
        if m:
            c, v, body = int(m.group(1)), int(m.group(2)), m.group(3).strip()
            last_verse = {'id': f'{c}.{v}', 'ch': c, 'v': v, 'text': body}
            if speaker:
                last_verse['speaker'] = speaker
                speaker = None
            cur['verses'].append(last_verse)
            continue
        m = re.match(r'^> \*Note:\*\s*(.*)$', line)
        if m and last_verse:
            last_verse.setdefault('tnotes', []).append(m.group(1).strip())
            continue
        if line.strip() and last_verse and not line.startswith(('---', '#', '>', '*Oṁ')):
            # continuation line of a verse (e.g. an embedded speaker change)
            last_verse['text'] += ' ' + line.strip()
    for c in chapters:
        nums = [v['v'] for v in c['verses']]
        if nums != list(range(1, COUNTS[c['n'] - 1] + 1)):
            err(f'chapter {c["n"]}: verse numbering broken')
    if len(chapters) != 18:
        err('expected 18 chapters in translation')
    return chapters


# ---------------------------------------------------------------- content parsing
def kv_fields(parts):
    out = {}
    for p in parts:
        p = p.strip()
        if not p:
            continue
        if '=' in p and re.match(r'^[a-z]+=', p):
            k, v = p.split('=', 1)
            out[k.strip()] = v.strip()
        else:
            err(f'bad field "{p[:60]}"')
    return out


def paragraphs(lines):
    out, buf = [], []
    for l in lines:
        if l.strip():
            buf.append(l.strip())
        elif buf:
            out.append(' '.join(buf)); buf = []
    if buf:
        out.append(' '.join(buf))
    return out


def parse_blocks(lines, where):
    """Split lines into {directive: [lines]} keyed by '@name'."""
    blocks, name, buf, head = {}, None, [], []
    for l in lines:
        m = re.match(r'^@([a-z]+)\s*(.*)$', l)
        if m:
            if name:
                blocks[name] = buf
            name, buf = m.group(1), []
            if m.group(2).strip():
                buf.append(m.group(2).strip())
            continue
        if name is None:
            head.append(l)
        else:
            buf.append(l)
    if name:
        blocks[name] = buf
    meta = {}
    for l in head:
        if l.strip():
            m = re.match(r'^([a-z]+):\s*(.*)$', l)
            if m:
                meta[m.group(1)] = m.group(2).strip()
            else:
                err(f'{where}: unexpected line "{l[:60]}"')
    return meta, blocks


def parse_map(lines, where):
    nodes, edges = [], []
    for l in lines:
        l = l.strip()
        if not l:
            continue
        if l.startswith('node '):
            parts = [p for p in l[5:].split(' | ')]
            if len(parts) < 3:
                err(f'{where}: bad node line {l[:60]}'); continue
            nid, row, label = parts[0].strip(), parts[1].strip(), parts[2].strip()
            f = kv_fields(parts[3:])
            n = {'id': nid, 'row': int(row), 'label': label}
            for k in ('text', 'term', 'ref', 'kind'):
                if k in f:
                    n[k] = f[k]
            if f.get('detail') == '1':
                n['detail'] = True
            nodes.append(n)
        elif l.startswith('edge '):
            parts = l[5:].split(' | ')
            m = re.match(r'^(\S+)\s*>\s*(\S+)$', parts[0].strip())
            if not m:
                err(f'{where}: bad edge {l[:60]}'); continue
            e = {'from': m.group(1), 'to': m.group(2)}
            for p in parts[1:]:
                p = p.strip()
                if p == 'dashed':
                    e['dashed'] = True
                elif p:
                    e['label'] = p
            edges.append(e)
        else:
            err(f'{where}: unexpected map line {l[:60]}')
    ids = {n['id'] for n in nodes}
    if len(ids) != len(nodes):
        err(f'{where}: duplicate node ids')
    for e in edges:
        if e['from'] not in ids or e['to'] not in ids:
            err(f'{where}: edge to unknown node {e}')
    return {'title': 'Concept map', 'nodes': nodes, 'edges': edges}


def parse_argument(lines, where):
    arg = {'premises': [], 'claim': None, 'implications': []}
    for l in lines:
        l = l.strip()
        if not l:
            continue
        parts = l.split(' | ')
        kind, label = parts[0].strip(), parts[1].strip() if len(parts) > 1 else ''
        f = kv_fields(parts[2:])
        node = {'label': label}
        for k in ('text', 'term', 'ref'):
            if k in f:
                node[k] = f[k]
        if kind == 'P':
            arg['premises'].append(node)
        elif kind == 'C':
            arg['claim'] = node
        elif kind == 'I':
            arg['implications'].append(node)
        else:
            err(f'{where}: bad argument line {l[:60]}')
    if not arg['claim']:
        err(f'{where}: argument has no claim')
    return arg


def questions(lines):
    out = []
    for l in lines:
        if l.startswith('- '):
            out.append(l[2:].strip())
        elif l.strip() and out:
            out[-1] += ' ' + l.strip()
    return out


PANEL_KEYS = ('reconstruction', 'insight', 'sources', 'context', 'matters')


def parse_chapter(path, ch):
    lines = path.read_text(encoding='utf-8').split('\n')
    # split at section markers
    chunks, cur = [('head', None, [])], None
    for l in lines:
        m = re.match(r'^# section (\d+)-(\d+) \| (.+)$', l)
        if m:
            chunks.append(('sec', (int(m.group(1)), int(m.group(2)), m.group(3).strip()), []))
            continue
        chunks[-1][2].append(l)
    meta, blocks = parse_blocks(chunks[0][2], path.name)
    ch['summary'] = meta.get('summary', '')
    if not ch['summary']:
        err(f'{path.name}: missing summary')
    ch['overview'] = paragraphs(blocks.get('overview', []))
    ch['research'] = paragraphs(blocks.get('research', []))
    ch['questions'] = questions(blocks.get('questions', []))
    if 'map' in blocks:
        ch['map'] = parse_map(blocks['map'], path.name)
    sections = []
    for kind, (a, b, title), body in chunks[1:]:
        where = f'{path.name} §{a}-{b}'
        smeta, sblocks = parse_blocks(body, where)
        s = {'id': f'{ch["n"]}-{len(sections) + 1}', 'from': a, 'to': b, 'title': title}
        if smeta.get('lead'):
            s['lead'] = smeta['lead']
        for k in PANEL_KEYS:
            if k in sblocks:
                s[k] = paragraphs(sblocks[k])
        if 'questions' in sblocks:
            s['questions'] = questions(sblocks['questions'])
        if 'argument' in sblocks:
            s['argument'] = parse_argument(sblocks['argument'], where)
        for l in sblocks.get('notes', []):
            if not l.strip():
                continue
            m = re.match(r'^(\d+)\.(\d+)\s*\|\s*(.+)$', l.strip())
            if not m:
                err(f'{where}: bad note line {l[:50]}'); continue
            c, v = int(m.group(1)), int(m.group(2))
            if c != ch['n'] or not (a <= v <= b):
                err(f'{where}: note {c}.{v} outside section')
                continue
            ch['verses'][v - 1].setdefault('fnotes', []).append(m.group(3).strip())
        sections.append(s)
    # sections must tile the chapter
    expect = 1
    for s in sections:
        if s['from'] != expect:
            err(f'{path.name}: section starts at {s["from"]}, expected {expect}')
        expect = s['to'] + 1
    if expect != COUNTS[ch['n'] - 1] + 1:
        err(f'{path.name}: sections end at {expect - 1}, expected {COUNTS[ch["n"] - 1]}')
    ch['sections'] = sections


def parse_intro():
    lines = (ROOT / 'content' / 'intro.txt').read_text(encoding='utf-8').split('\n')
    intro = {'title': 'Introduction', 'lede': '', 'sections': []}
    cur, buf = None, []
    map_lines, in_map = [], False

    def flush():
        if cur is not None:
            cur['paras'] = paragraphs(buf)
            intro['sections'].append(cur)

    for l in lines:
        if l.startswith('title: ') and cur is None and not in_map:
            intro['title'] = l[7:].strip(); continue
        if l.startswith('lede: ') and cur is None and not in_map:
            intro['lede'] = l[6:].strip(); continue
        if l.strip() == '@map':
            in_map = True; continue
        m = re.match(r'^# (\S+) \| (.+)$', l)
        if m:
            in_map = False
            flush()
            cur, buf = {'id': m.group(1), 'title': m.group(2).strip()}, []
            continue
        if in_map:
            map_lines.append(l)
        elif cur is not None:
            buf.append(l)
    flush()
    if map_lines:
        intro['map'] = parse_map(map_lines, 'intro')
    return intro


def parse_glossary():
    text = (ROOT / 'content' / 'glossary.txt').read_text(encoding='utf-8')
    entries = []
    for chunk in re.split(r'^@term ', text, flags=re.M)[1:]:
        lines = chunk.split('\n')
        key = lines[0].strip()
        e = {'key': key, 'term': key, 'aliases': [], 'related': [], 'refs': []}
        body = []
        for l in lines[1:]:
            m = re.match(r'^(term|sanskrit|aliases|short|related|refs):\s*(.*)$', l)
            if m:
                k, v = m.group(1), m.group(2).strip()
                if k in ('aliases', 'related', 'refs'):
                    e[k] = [x.strip() for x in v.split(',') if x.strip()]
                else:
                    e[k] = v
            else:
                body.append(l)
        e['body'] = paragraphs(body)
        if not e.get('short'):
            err(f'glossary {key}: missing short definition')
        entries.append(e)
    entries.sort(key=lambda e: fold(e['term']))
    return entries


# ---------------------------------------------------------------- validation
def check_markup(s, where, aliases, verse_ids):
    for m in re.finditer(r'\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]', s):
        if fold(m.group(1).strip()) not in aliases:
            err(f'{where}: unknown term [[{m.group(1)}]]')
    for m in re.finditer(r'\{(\d{1,2})\.(\d{1,2})(?:[–-](\d{1,2}))?\}', s):
        if f'{m.group(1)}.{m.group(2)}' not in verse_ids:
            err(f'{where}: bad verse ref {m.group(0)}')
    if s.count('**') % 2:
        err(f'{where}: unbalanced bold')


def walk_strings(obj, where, fn):
    if isinstance(obj, str):
        fn(obj, where)
    elif isinstance(obj, list):
        for i, x in enumerate(obj):
            walk_strings(x, f'{where}[{i}]', fn)
    elif isinstance(obj, dict):
        for k, v in obj.items():
            if k in ('id', 'key', 'from', 'to', 'kind', 'row'):
                continue
            walk_strings(v, f'{where}.{k}', fn)


def main():
    chapters = parse_translation()
    for ch in chapters:
        p = ROOT / 'content' / f'ch{ch["n"]:02d}.txt'
        if not p.exists():
            err(f'missing {p.name}')
            ch.update(summary='', overview=[], sections=[], research=[], questions=[])
            continue
        parse_chapter(p, ch)
        ch['colophon'] = (f'Thus, in the Upaniṣads of the Bhagavad Gītā, the knowledge of brahman, the scripture of yoga, '
                          f'the dialogue between Śrī Kṛṣṇa and Arjuna, ends the {ORD[ch["n"] - 1]} chapter, '
                          f'called “{ch["title"]}.”')
    intro = parse_intro()
    glossary = parse_glossary()
    aliases = set()
    keys = set()
    for g in glossary:
        keys.add(g['key'])
        for a in [g['key'], g['term'], *g['aliases']]:
            aliases.add(fold(a))
    for g in glossary:
        for r in g['related']:
            if r not in keys:
                err(f'glossary {g["key"]}: unknown related {r}')
    verse_ids = {v['id'] for c in chapters for v in c['verses']}

    def chk(s, where):
        check_markup(s, where, aliases, verse_ids)
    walk_strings(chapters, 'chapters', chk)
    walk_strings(intro, 'intro', chk)
    walk_strings(glossary, 'glossary', chk)
    for g in glossary:
        for r in g['refs']:
            if re.sub(r'[–-]\d+$', '', r) not in verse_ids:
                err(f'glossary {g["key"]}: bad ref {r}')

    def chk_nodes(nodes, where):
        for n in nodes:
            if n.get('term') and fold(n['term']) not in aliases:
                err(f'{where}: node term {n["term"]} unknown')
            for r in re.split(r'\s*,\s*', n.get('ref', '')) if n.get('ref') else []:
                m = re.match(r'^(\d+)\.(\d+)(?:[–-](\d+))?$', r)
                if not m or f'{m.group(1)}.{m.group(2)}' not in verse_ids:
                    err(f'{where}: node ref {r} invalid')
    for c in chapters:
        if c.get('map'):
            chk_nodes(c['map']['nodes'], f'map {c["n"]}')
        for s in c.get('sections', []):
            a = s.get('argument')
            if a:
                chk_nodes(a['premises'] + ([a['claim']] if a['claim'] else []) + a['implications'], f'arg {s["id"]}')
    if intro.get('map'):
        chk_nodes(intro['map']['nodes'], 'intro map')

    meta = {
        'title': 'Gītā Companion',
        'about': ('The verse text is a fresh study translation of the 700-verse standard text of the Bhagavad Gītā '
                  '(Mahābhārata, Bhīṣma Parvan 23–40). Key Sanskrit terms appear in brackets, and translator\'s notes (✦) mark genuine ambiguities in the Sanskrit. '
                  'The introduction, study footnotes (†), analyses, diagrams, questions and glossary were written for this companion. '
                  'They draw on the classical commentators (Śaṅkara, Rāmānuja, Madhva, Abhinavagupta, Jñāneśvara) and on modern scholarship.'),
    }
    data = {'meta': meta, 'intro': intro, 'chapters': chapters, 'glossary': glossary}
    if errors:
        print('\n'.join('ERROR: ' + e for e in errors[:200]))
        print(f'{len(errors)} error(s); data not written.')
        sys.exit(1)
    out = ROOT / 'data' / 'gita.json'
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    stamp_service_worker()
    nsec = sum(len(c['sections']) for c in chapters)
    nfn = sum(len(v.get('fnotes', [])) for c in chapters for v in c['verses'])
    words = len(json.dumps(data, ensure_ascii=False).split())
    print(f'ok: {len(chapters)} chapters, {nsec} sections, {nfn} footnotes, {len(glossary)} terms, ~{words} words -> {out.relative_to(ROOT)} ({out.stat().st_size // 1024} KB)')


def stamp_service_worker():
    """Version the offline cache by content hash so installed apps pick up new builds."""
    import hashlib
    h = hashlib.sha256()
    for name in ('index.html', 'styles.css', 'app.js', 'data/gita.json', 'manifest.webmanifest'):
        h.update((ROOT / name).read_bytes())
    sw = ROOT / 'sw.js'
    text = sw.read_text(encoding='utf-8')
    text = re.sub(r"const VERSION = '[^']*';", f"const VERSION = 'gita-companion-{h.hexdigest()[:10]}';", text)
    sw.write_text(text, encoding='utf-8')


if __name__ == '__main__':
    main()
