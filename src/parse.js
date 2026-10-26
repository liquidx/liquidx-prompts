// Parser for Claude Code `/export` text transcripts. Shared by build.mjs and the browser.
//
//   ❯ user prompt      ⏺ assistant text or Tool(args)     ⎿ tool output
//   ✻ turn timing      ※ recap      "Read 3 files (ctrl+o to expand)" collapsed tool summary

const MARK = /^(⏺|✻|※|❯)/;
const SUMMARY = /^  (?![ ⎿…])\S.*\(ctrl\+o to expand\)\s*$/;
const TOOL = /^([A-Z][A-Za-z]+|[\w.-]+ - [\w.-]+ \(MCP\))\((.*)$/;

export function parse(text) {
	const lines = text.replace(/\r/g, '').split('\n');
	const meta = {};
	let i = 0;
	for (; i < Math.min(lines.length, 8); i++) {
		const l = lines[i];
		if (/^\s*▐▛/.test(l)) meta.version = (l.match(/Claude Code v?(\S+)/) || [])[1];
		else if (/^\s*▝▜/.test(l)) meta.model = l.replace(/^\s*▝▜\S*\s*/, '').trim();
		else if (/^\s*▝▝/.test(l)) meta.cwd = l.replace(/^\s*▝▝\s+▝▝\s*/, '').trim();
		else if (l.trim()) break;
	}

	const blocks = [];
	let cur = null;
	for (; i < lines.length; i++) {
		const l = lines[i];
		if (l.startsWith('❯')) {
			// Prompts are padded to the terminal width, so blank lines inside a
			// prompt are spaces; only a truly empty line ends it.
			const b = { type: 'prompt', lines: [l.slice(2)], out: [] };
			while (++i < lines.length && lines[i] !== '' && !MARK.test(lines[i]) && !/^  ⎿/.test(lines[i]))
				b.lines.push(lines[i].startsWith('  ') ? lines[i].slice(2) : lines[i]);
			while (i < lines.length && lines[i] !== '' && !MARK.test(lines[i])) {
				if (/^  ⎿/.test(lines[i]) || b.out.length) b.out.push(lines[i].slice(5));
				else break;
				i++;
			}
			i--;
			blocks.push(b);
			cur = null;
		} else if (l.startsWith('⏺')) blocks.push((cur = { type: 'item', lines: [l.slice(2)] }));
		else if (l.startsWith('✻')) {
			blocks.push({ type: 'stat', text: l.slice(2).trim() });
			cur = null;
		} else if (l.startsWith('※')) blocks.push((cur = { type: 'recap', lines: [l.slice(2)] }));
		else if (SUMMARY.test(l)) {
			blocks.push({ type: 'summary', text: l.trim().replace(/\s*\(ctrl\+o to expand\)$/, '') });
			cur = null;
		} else if (cur) cur.lines.push(l.startsWith('  ') ? l.slice(2) : l);
		else if (l.trim()) blocks.push((cur = { type: 'item', lines: [l] }));
	}

	// A turn is one user prompt. Claude can wake up again without a prompt (a
	// background agent finished), so each turn holds one or more parts, each
	// ending in its own ✻ timing line.
	const turns = [];
	let t = null;
	let part = null;
	const open = (prompt) => turns.push((t = { prompt, parts: [(part = newPart())] }));
	const newPart = () => ({ items: [], stat: null, recap: null });
	const ensure = () => {
		if (!t) open(null);
		else if (part.stat) t.parts.push((part = newPart()));
	};
	let n = 0;
	for (const b of blocks) {
		if (b.type === 'prompt') {
			const p = classifyPrompt(b);
			if (p.kind !== 'command') p.n = ++n;
			open(p);
		} else if (b.type === 'stat') {
			ensure();
			part.stat = parseStat(b.text);
		} else if (b.type === 'recap') {
			if (!t) open(null);
			part.recap = trimLines(b.lines)
				.join(' ')
				.replace(/^recap:\s*/, '')
				.replace(/\s*\(disable recaps in \/config\)\s*$/, '');
		} else {
			ensure();
			part.items.push(b.type === 'summary' ? { kind: 'summary', text: b.text } : classifyItem(b));
		}
	}
	return { meta, turns };
}

// Sidebar metadata for one transcript, written into the manifest at build time.
export function summarize(text, name) {
	const { meta, turns } = parse(text);
	const prompts = turns
		.filter((t) => t.prompt && t.prompt.kind !== 'command')
		.map((t) => t.prompt.lines.join(' ').replace(/\s+/g, ' ').trim());
	const stats = turns.flatMap((t) => t.parts.map((p) => p.stat)).filter(Boolean);
	const days = [...new Set(stats.map((s) => (s.when.match(/,\s*(\w+ \d+)/) || [])[1]).filter(Boolean))];
	const slug = name.replace(/^\d{4}-\d\d-\d\d-\d{6}-/, '').replace(/\.txt$/, '').replace(/-/g, ' ');
	return {
		title: prompts[0] || slug,
		prompts,
		days,
		secs: stats.reduce((s, x) => s + x.secs, 0),
		...meta
	};
}

export function trimLines(ls) {
	ls = ls.map((l) => l.replace(/\s+$/, ''));
	while (ls.length && !ls[ls.length - 1]) ls.pop();
	while (ls.length && !ls[0]) ls.shift();
	return ls;
}

export function dedent(ls) {
	const ind = Math.min(...ls.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length), 99);
	return ls.map((l) => l.slice(ind === 99 ? 0 : ind));
}

function classifyPrompt(b) {
	const lines = trimLines(b.lines);
	const out = trimLines(b.out);
	const m = (lines[0] || '').match(/^\/([\w:-]+)\s*(.*)$/);
	if (m && !(m[1] === 'goal' && m[2])) return { kind: 'command', name: m[1], args: m[2], out };
	if (m) lines[0] = m[2];
	return { kind: m ? 'goal' : 'prompt', lines, out };
}

function classifyItem(b) {
	const lines = trimLines(b.lines);
	const first = lines[0] || '';
	let m;
	if (/^User answered/.test(first)) return { kind: 'answer', qa: parseAnswers(lines.slice(1)) };
	if ((m = first.match(/^Agent "(.*)" (finished|failed|stopped)(.*)$/)))
		return { kind: 'tool', name: 'Agent', arg: m[1], res: m[2] + m[3].replace(/^\s*·\s*/, ' · '), detail: dedent(lines.slice(1)) };
	if ((m = first.match(TOOL))) {
		let head = first;
		let j = 1;
		while (j < lines.length && j < 4 && !lines[j].startsWith('⎿') && !balanced(head)) head += ' ' + lines[j++].trim();
		const hm = head.match(TOOL);
		const close = hm[2].lastIndexOf(')');
		const body = lines
			.slice(j)
			.map((l) => (l.startsWith('⎿  ') || l.startsWith('   ') ? l.slice(3) : l.replace(/^⎿\s?/, '')));
		let k = 0;
		const res = [];
		while (k < body.length && body[k].trim() && !/^\s*\d+\s/.test(body[k]) && res.length < 3) res.push(body[k++].trim());
		return {
			kind: 'tool',
			name: hm[1].replace(/ \(MCP\)$/, ''),
			arg: close >= 0 ? hm[2].slice(0, close) : hm[2],
			suffix: close >= 0 ? hm[2].slice(close + 1).trim() : '',
			res: res.join(' '),
			detail: trimLines(body.slice(k))
		};
	}
	return { kind: 'text', lines };
}

function balanced(s) {
	let d = 0;
	for (const c of s) d += c === '(' ? 1 : c === ')' ? -1 : 0;
	return d <= 0;
}

function parseAnswers(lines) {
	const body = lines.map((l) => l.replace(/^⎿\s+/, '').trim()).join(' ');
	return body
		.split(/\s*·\s+/)
		.filter(Boolean)
		.map((s) => {
			const k = s.lastIndexOf('→');
			return k < 0 ? { q: s, a: '' } : { q: s.slice(0, k).trim(), a: s.slice(k + 1).trim() };
		});
}

function parseStat(s) {
	const m = s.match(/^(\S+) for (.+?) · done (.+)$/);
	return m ? { verb: m[1], dur: m[2], when: m[3], secs: toSecs(m[2]) } : { verb: '', dur: '', when: s, secs: 0 };
}

function toSecs(d) {
	let s = 0;
	for (const [, n, u] of d.matchAll(/(\d+)([hms])/g)) s += n * { h: 3600, m: 60, s: 1 }[u];
	return s;
}
