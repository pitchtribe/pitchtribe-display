'use strict';
/* FA Full-Time league tables, fixtures and results.
 *
 * Grassroots leagues live on Full-Time (fulltime.thefa.com), and a club wanting
 * its county league on a screen has exactly one supported way in: the embed
 * snippets Full-Time generates under Media → Code Snippets. There is no public
 * API and no feed. The site answers a plain HTTP client with 403 — scraping it
 * needs a headless browser, which is not something to put on a club Pi, and the
 * FA moved these snippets behind their admin login precisely to stop products
 * harvesting every league's data. So the club pastes its own snippet and we
 * render it.
 *
 * A pasted snippet is a lump of someone else's HTML, and the volunteer pasting
 * it is trusting us with the Pi. Two things keep that honest:
 *
 *   1. `parseSnippet` throws away everything it does not recognise. What
 *      survives is a placeholder element, a <script src> or an <iframe src> on
 *      a thefa.com host, and attribution text. Inline script bodies, event
 *      handlers and any other origin are refused with a message a volunteer can
 *      act on — a paste can never turn into arbitrary code on the Pi.
 *   2. `embedDocument` wraps what is left in its own document, served with a
 *      CSP that names Full-Time and nothing else and that applies `sandbox`.
 *      The FA's script therefore runs in an opaque origin: it renders a table
 *      and it cannot read the dashboard's session cookie or storage.
 *
 * Parsing runs twice on purpose — once when the dashboard saves, so the
 * volunteer sees the error, and again when the panel is served, so what reaches
 * a screen has been through the allowlist even if db.json was edited by hand.
 */

const { bad, str } = require('./validate');

/* Full-Time's insert is a fixed 350px wide whichever snippet you pick. That is
   a column on a club website and unreadable across the room on a 1080p TV, so
   the embed document measures itself and scales to fill the panel. */
const NATURAL_WIDTH = 350;
const MAX_PANELS = 3;
const MAX_SNIPPET = 4000;

/** Hosts a snippet may load from. Full-Time has used several over the years. */
function allowedHost(host) {
  const h = String(host || '').toLowerCase();
  return h === 'thefa.com' || h.endsWith('.thefa.com');
}

/** Elements a snippet may contain. Anything else is a paste we do not understand. */
const ELEMENTS = {
  script: { attrs: ['src'], needs: 'src' },
  iframe: { attrs: ['src', 'width', 'height', 'title'], needs: 'src' },
  div: { attrs: ['id', 'class'] },
  span: { attrs: ['id', 'class'] },
  p: { attrs: ['id', 'class'] },
  a: { attrs: ['href'], needs: 'href' },
  br: { attrs: [], void: true },
};
const VOID = new Set(['br', 'img', 'input', 'meta', 'link', 'hr']);

/* The attribute run excludes quotes from its unquoted branch on purpose. With
   `[^>]` there, a quote could be consumed either as a quoted value or as one
   more ordinary character, so a tag that never closes gave the engine two ways
   to read every `"` and it backtracked exponentially — 24 characters of `""`
   wedged the parser for a minute. The branches here are mutually exclusive, so
   each character has one reading and the scan is linear. A tag left with an
   unbalanced quote now simply fails to match and is escaped as text. */
const TAG_RE = /<!--[\s\S]*?-->|<\/?([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)\/?>/g;
const ATTR_RE = /([a-zA-Z_:][\w:.-]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const ID_RE = /^[A-Za-z][\w:.-]{0,63}$/;

function attributes(raw) {
  const out = new Map();
  for (const m of String(raw || '').matchAll(ATTR_RE)) {
    const name = m[1].toLowerCase();
    if (!out.has(name)) out.set(name, m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

/**
 * Resolve a snippet's src/href to an https URL on a Full-Time host.
 * Protocol-relative ("//fulltime.thefa.com/…") is how Full-Time wrote these for
 * years, so it is accepted and upgraded rather than refused.
 */
function embedUrl(value, { tag, attr }) {
  const raw = String(value || '').trim();
  if (!raw) throw bad(`A Full-Time snippet's <${tag}> has no ${attr} — copy the whole code snippet, not part of it`);
  const candidate = raw.startsWith('//') ? `https:${raw}` : raw;
  let u;
  try {
    u = new URL(candidate);
  } catch {
    throw bad(`"${raw.slice(0, 60)}" is not a full web address — copy the Full-Time code snippet exactly as it is shown`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw bad(`Only https addresses can be embedded, not ${u.protocol}`);
  if (!allowedHost(u.hostname)) {
    throw bad(`This snippet loads from ${u.hostname}. Only Full-Time (thefa.com) snippets can be used here.`);
  }
  u.protocol = 'https:'; // the club's screens should not fetch league data in the clear
  return u.toString();
}

/**
 * A pasted Full-Time snippet (or a bare Full-Time address) reduced to the nodes
 * we are willing to serve. Throws HttpError(400) with a plain-English message.
 */
function parseSnippet(input, { field = 'Full-Time code snippet' } = {}) {
  const text = str(input, { max: MAX_SNIPPET, required: true, field });

  // Someone who pastes just the address of a generated feed gets the obvious
  // reading of that rather than an error.
  if (!text.includes('<')) {
    return [{ kind: 'iframe', src: embedUrl(text, { tag: 'iframe', attr: 'src' }), width: 0, height: 0, title: '' }];
  }

  const nodes = [];
  const open = [];
  let cursor = 0;
  let loads = 0;

  const addText = (raw) => {
    const value = raw.replace(/\s+/g, ' ');
    if (!value.trim()) return;
    // Text inside <script> is code, not content: that is the one thing this
    // allowlist exists to keep off the Pi.
    if (open.includes('script')) throw bad(`${field}: inline script is not allowed. Paste the snippet Full-Time generated, unchanged.`);
    nodes.push({ kind: 'text', value });
  };

  for (const m of text.matchAll(TAG_RE)) {
    addText(text.slice(cursor, m.index));
    cursor = m.index + m[0].length;
    if (m[0].startsWith('<!--')) continue;

    const tag = (m[1] || '').toLowerCase();
    const closing = m[0].startsWith('</');
    const spec = ELEMENTS[tag];
    if (!spec) {
      throw bad(`${field}: <${tag}> is not something we can embed. Paste the code snippet from Full-Time → Media → Code Snippets.`);
    }
    if (closing) {
      const at = open.lastIndexOf(tag);
      if (at >= 0) open.splice(at, 1);
      // <script> and <iframe> are emitted whole by nodeHtml, so their closing
      // tag is already accounted for.
      if (tag !== 'script' && tag !== 'iframe') nodes.push({ kind: 'close', tag });
      continue;
    }

    const attrs = attributes(m[2]);
    for (const name of attrs.keys()) {
      if (name.startsWith('on')) {
        throw bad(`${field}: the "${name}" handler is not allowed. Paste the snippet Full-Time generated, unchanged.`);
      }
    }

    const node = { kind: tag };
    if (spec.needs && !attrs.get(spec.needs)) {
      throw bad(`${field}: <${tag}> has no ${spec.needs}. Copy the whole snippet.`);
    }
    if (tag === 'script' || tag === 'iframe') {
      node.src = embedUrl(attrs.get('src'), { tag, attr: 'src' });
      loads += 1;
      if (tag === 'iframe') {
        node.width = Number(attrs.get('width')) || 0;
        node.height = Number(attrs.get('height')) || 0;
        node.title = str(attrs.get('title'), { max: 120, field: 'Title' });
      }
    } else if (tag === 'a') {
      node.href = embedUrl(attrs.get('href'), { tag, attr: 'href' });
    } else {
      const id = str(attrs.get('id'), { max: 64, field: 'id' });
      if (id && !ID_RE.test(id)) throw bad(`${field}: "${id}" is not a usable element id.`);
      node.id = id;
      node.class = /^[\w\s-]{0,120}$/.test(attrs.get('class') || '') ? (attrs.get('class') || '') : '';
    }
    nodes.push(node);
    // <script> is tracked as open even though it is emitted whole, so that a
    // body smuggled in after an allowed src is seen as inline script.
    const selfClosing = m[0].endsWith('/>') || VOID.has(tag) || spec.void;
    if (!selfClosing) open.push(tag);
  }
  addText(text.slice(cursor));

  if (!loads) {
    throw bad(`${field}: no Full-Time table, fixtures or results were found in that paste. It should contain a <script> or <iframe> from thefa.com.`);
  }
  return nodes;
}

const escapeText = (s) => String(s).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
const escapeAttr = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

function nodeHtml(node) {
  switch (node.kind) {
    case 'text':
      return escapeText(node.value);
    case 'close':
      return `</${node.tag}>`;
    case 'script':
      // No defer/async: Full-Time's older inserts document.write into the page,
      // which only works while the document is still parsing.
      return `<script src="${escapeAttr(node.src)}"></script>`;
    case 'iframe': {
      const size = [node.width ? ` width="${node.width}"` : '', node.height ? ` height="${node.height}"` : ''].join('');
      const title = node.title ? ` title="${escapeAttr(node.title)}"` : '';
      return `<iframe src="${escapeAttr(node.src)}"${size}${title} frameborder="0" scrolling="no"></iframe>`;
    }
    case 'a':
      return `<a href="${escapeAttr(node.href)}" rel="noreferrer nofollow">`;
    case 'br':
      return '<br>';
    default: {
      const id = node.id ? ` id="${escapeAttr(node.id)}"` : '';
      const cls = node.class ? ` class="${escapeAttr(node.class)}"` : '';
      return `<${node.kind}${id}${cls}>`;
    }
  }
}

/** The CSP for a panel document: Full-Time, nothing else, in an opaque origin.
 *
 * `sandbox` without `allow-same-origin` is what makes this safe to serve from
 * the Pi's own origin — the FA's script cannot reach the dashboard cookie or
 * storage. `'unsafe-inline'` scripts stay allowed inside that box because the
 * older Full-Time inserts document.write further script, and a nonce would
 * leave the club with a blank panel and no clue why.
 */
const EMBED_CSP = [
  "default-src 'none'",
  "script-src https://thefa.com https://*.thefa.com 'unsafe-inline'",
  "style-src https://thefa.com https://*.thefa.com 'unsafe-inline'",
  "img-src https://thefa.com https://*.thefa.com data:",
  "font-src https://thefa.com https://*.thefa.com data:",
  "connect-src https://thefa.com https://*.thefa.com",
  "frame-src https://thefa.com https://*.thefa.com",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
  'sandbox allow-scripts',
].join('; ');

/**
 * One panel as a standalone document. It measures the Full-Time insert once it
 * has rendered and scales it to fill the panel, because a 350px-wide table is
 * not readable from the bar.
 */
function embedDocument(nodes, { zoom = 0, dark = true } = {}) {
  const body = nodes.map(nodeHtml).join('');
  const fixed = Number(zoom) > 0 ? Number(zoom) : 0;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Full-Time</title>
<style>
  html,body{margin:0;padding:0;height:100%;overflow:hidden;background:${dark ? '#11161d' : '#fff'}}
  #ft-fit{position:absolute;inset:0;display:flex;justify-content:center;align-items:flex-start}
  #ft-scale{width:${NATURAL_WIDTH}px;transform-origin:top center;background:#fff;color:#111}
  #ft-scale table{width:100%}
  #ft-scale iframe{border:0;width:100%}
</style></head>
<body><div id="ft-fit"><div id="ft-scale">${body}</div></div>
<script>
(function(){
  var fit=document.getElementById('ft-fit'),box=document.getElementById('ft-scale'),fixed=${fixed};
  function apply(){
    box.style.transform='none';
    var w=box.offsetWidth||${NATURAL_WIDTH},h=box.offsetHeight||1;
    // Contain, not cover: a league table that overflows the panel loses the
    // bottom of the division, which is the half the club cares about.
    var s=fixed||Math.min(fit.clientWidth/w,fit.clientHeight/h);
    box.style.transform='scale('+Math.max(0.3,Math.min(6,s))+')';
  }
  // Full-Time renders asynchronously, so measure again as it fills in.
  new MutationObserver(apply).observe(box,{childList:true,subtree:true,characterData:true});
  addEventListener('resize',apply);
  addEventListener('load',apply);
  [100,500,1500,4000,10000].forEach(function(ms){setTimeout(apply,ms)});
  apply();
})();
</script></body></html>`;
}

module.exports = { parseSnippet, embedDocument, EMBED_CSP, NATURAL_WIDTH, MAX_PANELS, MAX_SNIPPET, allowedHost };
