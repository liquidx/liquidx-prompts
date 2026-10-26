import { parse, dedent } from './parse.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

let sessions = [];
let current = null;
const texts = new Map();

// ── prose: un-wrap the terminal's 80-column hard wraps ───────────
const WRAP = 72;

function prose(lines) {
	const out = [];
	let para = [];
	let fence = null;
	const flush = () => {
		if (para.length) out.push(renderPara(para));
		para = [];
	};
	for (const l of lines) {
		if (/^\s*```/.test(l)) {
			if (fence) {
				out.push(`<pre><code>${esc(dedent(fence).join('\n'))}</code></pre>`);
				fence = null;
			} else {
				flush();
				fence = [];
			}
		} else if (fence) fence.push(l);
		else if (!l.trim()) flush();
		else para.push(l.replace(/\s+$/, ''));
	}
	if (fence) out.push(`<pre><code>${esc(dedent(fence).join('\n'))}</code></pre>`);
	flush();
	return out.join('');
}

function renderPara(p) {
	if (p.some((l) => /[│┌└├┼]/.test(l))) return `<pre>${esc(dedent(p).join('\n'))}</pre>`;
	const items = [];
	const base = Math.min(...p.map((l) => l.match(/^ */)[0].length));
	let prev = '';
	for (const l of p) {
		const s = l.trimStart();
		const ind = l.length - s.length - base;
		const li = s.match(/^([-*•]|\d+[.)])\s+(.*)$/);
		const h = s.match(/^#{1,4}\s+(.*)$/);
		const last = items[items.length - 1];
		if (li) items.push({ kind: 'li', mark: /\d/.test(li[1]) ? li[1] : '–', ind: Math.round(ind / 2), text: li[2] });
		else if (h) items.push({ kind: 'h', text: h[1] });
		else if (!last || last.kind === 'h') items.push({ kind: 'p', text: s });
		else {
			// A line was hard-wrapped if its next word wouldn't have fit on it.
			const wrapped = prev.length + 1 + s.split(' ')[0].length > WRAP;
			last.text += wrapped ? (/\S[-/]$/.test(last.text) ? '' : ' ') + s : '\n' + s;
		}
		prev = l;
	}
	const only = items.length === 1 && items[0];
	if (only && only.kind === 'p' && only.text.length < 56 && !/[.:,;?!)`'"]$/.test(only.text) && !only.text.includes('\n'))
		only.kind = 'h';
	return items
		.map((it) => {
			const html = inline(it.text).replace(/\n/g, '<br>');
			if (it.kind === 'h') return `<h4>${html}</h4>`;
			if (it.kind === 'li') return `<div class="li" style="--ind:${it.ind}"><span>${esc(it.mark)}</span><span>${html}</span></div>`;
			return `<p>${html}</p>`;
		})
		.join('');
}

function inline(s) {
	return esc(s)
		.replace(/`([^`]+)`/g, '<code>$1</code>')
		.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
		.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1')
		.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
}

function diffPre(lines) {
	let last = '';
	const rows = lines.map((l) => {
		let cls = '';
		const m = l.match(/^\s*\d+\s([-+])/);
		if (m) cls = m[1] === '+' ? 'add' : 'del';
		else if (/^\s{4,}[-+]\S/.test(l) && last) cls = last;
		else if (/^\s*… \+\d+ lines/.test(l)) cls = 'more';
		last = cls === 'more' ? '' : cls;
		return cls ? `<span class="${cls}">${esc(l)}</span>` : esc(l);
	});
	return `<pre>${rows.join('\n')}</pre>`;
}

function fmtSecs(s) {
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	return h ? `${h}h ${m}m` : m ? `${m}m` : `${s}s`;
}

function dayRange(d) {
	if (!d.length) return '';
	if (d.length === 1) return d[0];
	const [a, b] = [d[0], d[d.length - 1]];
	return a.split(' ')[0] === b.split(' ')[0] ? `${a}–${b.split(' ')[1]}` : `${a} – ${b}`;
}

const pad = (n) => String(n).padStart(2, '0');

// ── turns ────────────────────────────────────────────────────
const UNIT = { reads: 'read', searches: 'search', commands: 'command', edits: 'edit', writes: 'write', agents: 'agent', other: 'tool' };
const SUMMARY_VERB = { read: 'reads', ran: 'commands', 'searched for': 'searches', listed: 'reads', recalled: 'reads', fetched: 'reads', wrote: 'writes', edited: 'edits' };
const TOOL_KIND = { Update: 'edits', Edit: 'edits', Write: 'writes', Agent: 'agents', Explore: 'agents', Bash: 'commands', Read: 'reads' };

function traceStats(items) {
	const c = { reads: 0, searches: 0, commands: 0, edits: 0, writes: 0, agents: 0, other: 0 };
	for (const it of items) {
		if (it.kind === 'summary')
			for (const [, verb, n] of it.text.toLowerCase().matchAll(/(read|ran|searched for|listed|recalled|fetched|wrote|edited)\s+(\d+)/g))
				c[SUMMARY_VERB[verb]] += +n;
		else if (it.kind === 'tool') c[TOOL_KIND[it.name] || 'other']++;
	}
	return Object.entries(c)
		.filter(([, n]) => n)
		.map(([k, n]) => `${n} ${UNIT[k]}${n > 1 ? (k === 'searches' ? 'es' : 's') : ''}`);
}

function renderStep(it) {
	if (it.kind === 'text') return `<div class="step-text prose">${prose(it.lines)}</div>`;
	if (it.kind === 'summary') return `<div class="step-sum">${esc(it.text)}</div>`;
	const res = [it.suffix, it.res].filter(Boolean).join(' · ');
	const head = `<span class="name">${esc(it.name)}</span><span class="arg" title="${esc(it.arg)}">${esc(it.arg)}</span><span class="res">${esc(res)}</span>`;
	if (!it.detail || !it.detail.length) return `<div class="tool"><div class="row">${head}</div></div>`;
	const isCode = /^(Update|Edit|Write|Read|Bash)$/.test(it.name) || it.detail.some((l) => /^\s*\d+\s/.test(l));
	const body = isCode ? diffPre(it.detail) : `<div class="prose step-text">${prose(it.detail)}</div>`;
	return `<details class="tool"><summary>${head}</summary><div class="detail">${body}</div></details>`;
}

function renderTrace(items) {
	if (!items.length) return '';
	const steps = items.filter((i) => i.kind !== 'text').length || items.length;
	const label = [`${steps} step${steps > 1 ? 's' : ''}`, ...traceStats(items)].join(' · ');
	return `<details class="trace"><summary>${esc(label)}</summary><div class="steps">${items.map(renderStep).join('')}</div></details>`;
}

function renderTurn(t, idx) {
	const p = t.prompt;
	const empty = t.parts.every((x) => !x.items.length);
	if (p && p.kind === 'command' && empty) {
		if (p.name === 'clear') return `<div class="divider">context cleared</div>`;
		if (p.name === 'compact') return `<div class="divider">compacted</div>`;
		const out = p.out.join(' ').trim();
		return `<div class="cmd"><code>/${esc(p.name)}${p.args ? ' ' + esc(p.args) : ''}</code>${out ? ' — ' + esc(out) : ''}</div>`;
	}

	let html = `<section class="turn"${p && p.n ? ` id="p${p.n}"` : ''}>`;
	if (p && p.kind !== 'command') {
		const out = p.out.length ? `<div class="out">${esc(p.out.join(' '))}</div>` : '';
		html += `<div class="prompt"><div class="label"><span class="n">${pad(p.n)}</span><span>${p.kind === 'goal' ? 'goal' : 'you'}</span></div><div class="body prose">${prose(p.lines)}</div>${out}</div>`;
	} else if (p) {
		html += `<div class="prompt cont"><div class="label"><span>/${esc(p.name)}</span></div><div class="body">${esc(p.args || p.out.join(' '))}</div></div>`;
	} else {
		html += `<div class="prompt cont"><div class="label"><span>${idx === 0 ? 'session start' : 'continued'}</span></div><div class="body">Carried over from a previous session</div></div>`;
	}
	t.parts.forEach((part, k) => {
		if (k) html += `<div class="wake label">background work finished · claude picked up</div>`;
		html += renderPart(part);
	});
	return html + `</section>`;
}

function renderPart(part) {
	let html = '';
	// The text after the last tool call is the reply and everything before it is
	// trace, except questions Claude asked and the answers the user picked.
	const items = part.items;
	let lastWork = -1;
	items.forEach((it, k) => {
		if (it.kind !== 'text') lastWork = k;
	});
	const work = items.slice(0, lastWork + 1);
	const reply = items.slice(lastWork + 1);

	let group = [];
	const flush = () => {
		html += renderTrace(group);
		group = [];
	};
	work.forEach((it, k) => {
		if (it.kind === 'text' && work[k + 1] && work[k + 1].kind === 'answer') {
			flush();
			html += `<div class="response mid"><div class="label">claude asked</div><div class="prose">${prose(it.lines)}</div></div>`;
		} else if (it.kind === 'answer') {
			flush();
			const qa = it.qa.map((x) => `<div class="qa"><div class="q">${inline(x.q)}</div>${x.a ? `<div class="a">${inline(x.a)}</div>` : ''}</div>`);
			html += `<div class="answer">${qa.join('')}</div>`;
		} else group.push(it);
	});
	flush();

	if (reply.length) html += `<div class="response"><div class="label">claude</div><div class="prose">${reply.map((r) => prose(r.lines)).join('')}</div></div>`;
	if (part.stat) html += `<div class="foot">${esc([part.stat.dur, part.stat.when].filter(Boolean).join(' · '))}</div>`;
	if (part.recap) html += `<div class="recap"><span class="label">recap</span>${inline(part.recap)}</div>`;
	return html;
}

// ── sidebar ──────────────────────────────────────────────────
function renderList() {
	const q = $('#filter').value.trim().toLowerCase();
	const match = (s) => !q || [s.dir, s.name, s.title, ...s.prompts].some((x) => x.toLowerCase().includes(q));
	const html = [];
	let dir = null;
	for (const s of sessions.filter(match)) {
		if (s.dir !== dir) {
			dir = s.dir;
			html.push(`<li class="group label">${esc(dir)}</li>`);
		}
		const on = current && s.id === current.id;
		const meta = [dayRange(s.days), `${s.prompts.length} prompt${s.prompts.length === 1 ? '' : 's'}`, s.model && s.model.split(' · ')[0]];
		const outline = on
			? `<ol class="outline">${s.prompts.map((p, i) => `<li><button data-jump="${i + 1}"><span>${pad(i + 1)}</span><span>${esc(p)}</span></button></li>`).join('')}</ol>`
			: '';
		html.push(
			`<li class="file${on ? ' active' : ''}"><a href="#${esc(encodeURI(s.id))}" title="${esc(s.name)}"><div class="t">${esc(s.title)}</div><div class="m">${esc(meta.filter(Boolean).join(' · '))}</div></a>${outline}</li>`
		);
	}
	$('#files').innerHTML = html.join('') || `<li class="file m">${q ? 'no matches' : 'no sessions'}</li>`;
}

async function show(id) {
	current = sessions.find((s) => s.id === id) || null;
	document.body.classList.toggle('viewing', !!current);
	renderList();
	if (!current) {
		$('#view').innerHTML = `<div class="empty"><p>${sessions.length} sessions in ${new Set(sessions.map((s) => s.dir)).size} folders.</p><p>Pick one.</p></div>`;
		return;
	}
	const s = current;
	if (!texts.has(s.id)) {
		$('#view').innerHTML = `<div class="empty">loading…</div>`;
		texts.set(s.id, await (await fetch(s.path)).text());
		if (current !== s) return;
	}
	const { turns } = parse(texts.get(s.id));
	const facts = [
		['model', s.model],
		['dir', s.cwd],
		['when', dayRange(s.days)],
		['prompts', s.prompts.length],
		['working', s.secs ? fmtSecs(s.secs) : ''],
		['cc', s.version]
	].filter(([, v]) => v);
	const title = s.title.length > 140 ? s.title.slice(0, 140) + '…' : s.title;
	$('#view').innerHTML = `
		<a class="back" href="#">← sessions</a>
		<header class="head">
			<div class="label">${esc(s.dir)} / ${esc(s.name)} · <a href="${esc(s.path)}">raw</a></div>
			<h1>${esc(title)}</h1>
			<div class="facts">${facts.map(([k, v]) => `<span><b>${k}</b>${esc(v)}</span>`).join('')}</div>
			<div class="controls">
				<button data-act="expand">expand traces</button>
				<button data-act="collapse">collapse</button>
				<button data-act="prompts" aria-pressed="${document.body.classList.contains('prompts-only')}">prompts only</button>
			</div>
		</header>
		${turns.map(renderTurn).join('')}`;
	window.scrollTo(0, 0);
	watchOutline();
}

let observer;
function watchOutline() {
	if (observer) observer.disconnect();
	observer = new IntersectionObserver(
		(entries) => {
			for (const e of entries) {
				if (!e.isIntersecting) continue;
				const n = e.target.id.slice(1);
				document.querySelectorAll('.outline button').forEach((b) => b.classList.toggle('on', b.dataset.jump === n));
			}
		},
		{ rootMargin: '0px 0px -70% 0px' }
	);
	document.querySelectorAll('.turn[id]').forEach((el) => observer.observe(el));
}

// ── events ───────────────────────────────────────────────────
document.addEventListener('click', (e) => {
	const j = e.target.closest('[data-jump]');
	if (j) return document.getElementById('p' + j.dataset.jump)?.scrollIntoView({ behavior: 'smooth' });
	const a = e.target.closest('[data-act]');
	if (!a) return;
	if (a.dataset.act === 'prompts') a.setAttribute('aria-pressed', document.body.classList.toggle('prompts-only'));
	else document.querySelectorAll('.trace').forEach((d) => (d.open = a.dataset.act === 'expand'));
});
$('#filter').addEventListener('input', renderList);
const route = () => show(decodeURI(location.hash.slice(1)));
window.addEventListener('hashchange', route);

try {
	const manifest = await (await fetch('manifest.json')).json();
	sessions = manifest.sessions;
	$('#dir').textContent = `${sessions.length} sessions · built ${manifest.built.slice(0, 10)}`;
	route();
} catch (err) {
	$('#dir').textContent = 'no manifest';
	$('#view').innerHTML = `<div class="empty"><p>Couldn't load <code>manifest.json</code>.</p><p>Run <code>node build.mjs</code>, then serve <code>dist/</code> over HTTP (e.g. <code>python3 -m http.server -d dist</code>).</p></div>`;
}
