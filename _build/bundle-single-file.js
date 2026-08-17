/* ---------------------------------------------------------------------------
   Bundles the 19-page site into ONE self-contained file for an Artifact
   preview link. Nothing about the design changes — the stylesheet, scripts
   and markup are the shipped ones. Only three things are transformed:

     1. Google Fonts  -> @font-face with woff2 embedded as data URIs
        (the Artifact CSP blocks font CDNs, and a silent fallback to Times
        would misrepresent the Editorial-Fashion + Medical-UI type pairing).
     2. <img src>      -> SVG data URIs.
     3. Multi-page nav -> a router that re-renders the whole page body and
        re-runs the scripts, so no stale listeners survive a navigation.
   ------------------------------------------------------------------------- */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT  = path.join(__dirname, 'amira-site.bundle.html');

const PAGE_LIST = [
  'index.html', 'dr-amira.html', 'treatments.html',
  'treatments/botox.html', 'treatments/fillers.html', 'treatments/lips.html',
  'treatments/cheeks.html', 'treatments/chin.html', 'treatments/jawline.html',
  'treatments/facial-balancing.html',
  'ai-studio.html', 'results.html', 'faq.html', 'articles.html',
  'contact.html', 'privacy.html', 'ai-privacy.html', 'accessibility.html', 'terms.html'
];

const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

/* ------------------------------------------------------------------ fonts */
const FONT_CSS_URL =
  'https://fonts.googleapis.com/css2?family=Heebo:wght@200;300;400;500' +
  '&family=Cormorant+Garamond:wght@300;400;500&display=swap';
const KEEP_SUBSETS = new Set(['hebrew', 'latin', 'latin-ext']);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function buildFonts() {
  const res = await fetch(FONT_CSS_URL, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error('font css HTTP ' + res.status);
  const css = await res.text();

  const blocks = css.split('/*').slice(1).map(b => '/*' + b);
  let out = '';
  let embedded = 0, bytes = 0;

  for (const block of blocks) {
    const subset = (block.match(/^\/\*\s*([a-z-]+)\s*\*\//i) || [])[1];
    if (!subset || !KEEP_SUBSETS.has(subset)) continue;
    const url = (block.match(/url\((https:[^)]+\.woff2)\)/) || [])[1];
    if (!url) continue;

    const buf = Buffer.from(await (await fetch(url, { headers: { 'User-Agent': UA } })).arrayBuffer());
    bytes += buf.length;
    embedded++;
    out += block
      .replace(/^\/\*[^*]*\*\/\s*/, '')
      .replace(url, 'data:font/woff2;base64,' + buf.toString('base64'))
      .trim() + '\n';
  }
  console.log(`fonts: embedded ${embedded} woff2 files, ${(bytes / 1024).toFixed(0)} KB raw`);
  return out;
}

/* ------------------------------------------------------------------ images */
function buildImageMap() {
  const dir = path.join(ROOT, 'assets/img');
  const map = {};
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.svg')) continue;
    const b64 = fs.readFileSync(path.join(dir, f)).toString('base64');
    map['assets/img/' + f] = 'data:image/svg+xml;base64,' + b64;
  }
  console.log(`images: inlined ${Object.keys(map).length} svg files`);
  return map;
}

function inlineImages(text, map) {
  // normalise the ../ used by pages inside treatments/ first
  let t = text.replace(/\.\.\/assets\//g, 'assets/');
  for (const [p, uri] of Object.entries(map)) t = t.split(p).join(uri);
  return t;
}

/* ------------------------------------------------------------------ scripts */
function buildScripts(imgMap) {
  const data = inlineImages(read('assets/js/data.js'), imgMap);

  let site = read('assets/js/site.js');
  // The boot block waits for DOMContentLoaded, which has long fired by the
  // time the router re-injects this file. Turn it into a direct call.
  const before = site;
  site = site
    .replace("document.addEventListener('DOMContentLoaded', function () {", '(function () {')
    .replace(/    initYear\(\);\r?\n  \}\);/, '    initYear();\n  })();');
  if (site === before) throw new Error('site.js boot patch did not apply');
  if (site.includes("addEventListener('DOMContentLoaded'")) throw new Error('DOMContentLoaded still present');

  // The shipped site saves the comparison image with an <a download>. The
  // Artifact viewer never grants a page download permission, so that anchor
  // is inert there. Route the save through a shim instead: the shim prefers
  // the `downloads` capability and keeps the anchor as the fallback, so the
  // same patched call works in both places.
  let mirror = read('assets/js/mirror.js');
  const anchorSave = `    c.toBlob(function (blob) {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'amira-ai-mirror-preview.jpg';
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
    }, 'image/jpeg', 0.92);`;
  if (!mirror.includes(anchorSave)) throw new Error('mirror.js download block not found');
  mirror = mirror.replace(anchorSave, () =>
`    c.toBlob(function (blob) {
      window.__amiraSaveImage(blob, 'amira-ai-mirror-preview.jpg');
    }, 'image/jpeg', 0.92);`);

  return { data, site, mirror };
}

/* The shim. Lives only in the bundle, never in the shipped site. */
function saveShim() {
  const busy = jsonAscii('שומרת…');            // "saving..."
  const fail = jsonAscii('השמירה אינה זמינה כאן'); // "saving is not available here"
  return `
window.__amiraSaveImage = function (blob, filename) {
  var btn = document.getElementById('mirrorDownload');
  var label = btn ? btn.textContent : '';
  function say(text) {
    if (!btn) return;
    btn.textContent = text;
    window.setTimeout(function () { btn.textContent = label; }, 3500);
  }
  function anchor() {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
  }
  if (!window.claude || typeof window.claude.use !== 'function') { anchor(); return; }
  say(${busy});
  window.claude.use('downloads').then(function (downloads) {
    if (!downloads) { anchor(); return; }
    return downloads.save({ filename: filename, data: blob }).then(function () {
      if (btn) btn.textContent = label;
    }, function (err) {
      var code = err && err.code;
      // The viewer declining is a valid answer, not a failure to report.
      if (code === 'declined' || code === 'rate_limited') { if (btn) btn.textContent = label; return; }
      say(${fail});
    });
  }, function () { anchor(); });
};`;
}

/* ------------------------------------------------------------------ pages */
function buildPages(imgMap) {
  const pages = {};
  for (const key of PAGE_LIST) {
    const raw = read(key);
    const title = (raw.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || 'Dr. Amira Dabbagha';

    let body = (raw.match(/<body[^>]*>([\s\S]*)<\/body>/) || [])[1];
    if (!body) throw new Error('no body in ' + key);

    // pull out page-specific inline scripts, drop the external ones
    const inline = [];
    body = body.replace(/<script\b[^>]*\bsrc=[^>]*><\/script>/g, '');
    body = body.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/g, (_, code) => {
      if (code.trim()) inline.push(code);
      return '';
    });

    body = inlineImages(body, imgMap).trim();
    pages[key] = { title: title.trim(), html: body, inline };
  }
  const n = Object.values(pages).reduce((a, p) => a + p.inline.length, 0);
  console.log(`pages: ${Object.keys(pages).length} bodies, ${n} page-specific inline scripts kept`);
  return pages;
}

/* --------------------------------------------------------------- encoding
   The Artifact wrapper supplies the <head>, so this file cannot declare its
   own charset. Rather than trust the wrapper, emit pure ASCII: every
   non-ASCII codepoint becomes a CSS escape in the stylesheet and a \uXXXX
   escape in the JSON. The file is then byte-identical under any charset.
   ------------------------------------------------------------------------- */
function cssAscii(css) {
  return Array.from(css).map(ch => ch.codePointAt(0) < 128
    ? ch
    : '\\' + ch.codePointAt(0).toString(16).padStart(6, '0')).join('');
}

function jsonAscii(value) {
  // Escape, per UTF-16 code unit:
  //   >= 0x7F        all non-ASCII (Hebrew copy, punctuation, symbols)
  //   < > &          so no "</script>" can terminate the host <script> element
  const json = JSON.stringify(value);
  let out = "";
  for (let i = 0; i < json.length; i++) {
    const code = json.charCodeAt(i);
    const ch = json[i];
    const unsafe = code >= 0x7F || ch === "<" || ch === ">" || ch === "&";
    out += unsafe ? "\\u" + code.toString(16).padStart(4, "0") : ch;
  }
  return out;
}

function assertAscii(text, label) {
  const bad = Array.from(text).find(c => c.codePointAt(0) > 127);
  if (bad) throw new Error(`${label} still contains non-ASCII: U+${bad.codePointAt(0).toString(16)}`);
}

/* ------------------------------------------------------------------ emit */
(async () => {
  const imgMap  = buildImageMap();
  const fontCss = await buildFonts();
  const mainCss = read('assets/css/main.css');
  const scripts = buildScripts(imgMap);
  const pages   = buildPages(imgMap);

  const router = `
(function () {
  'use strict';
  var PAGES   = __PAGES__;
  var SCRIPTS = __SCRIPTS__;
  var ORDER   = ['data', 'site', 'mirror'];

  var root = document.documentElement;
  root.lang = 'he';
  root.dir  = 'rtl';

  var app = document.getElementById('app');
  var runtime = document.getElementById('runtime');
  var current = 'index.html';

  function resolve(from, href) {
    try { return new URL(href, 'http://a/' + from).pathname.replace(/^\\//, '') +
                 (new URL(href, 'http://a/' + from).hash || ''); }
    catch (e) { return href; }
  }

  function run(code) {
    var s = document.createElement('script');
    s.textContent = code;
    runtime.appendChild(s);
  }

  function go(key, hash) {
    var page = PAGES[key];
    if (!page) return;
    current = key;

    // Replacing the entire body content means every listener bound to the
    // old chrome dies with its elements: nothing to unbind by hand.
    app.innerHTML = page.html;
    runtime.textContent = '';
    ORDER.forEach(function (k) { run(SCRIPTS[k]); });
    page.inline.forEach(run);

    document.title = page.title;

    if (hash) {
      var t = document.getElementById(hash.replace('#', ''));
      if (t) { t.scrollIntoView({ block: 'start' }); return; }
    }
    window.scrollTo(0, 0);
  }

  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    var href = a.getAttribute('href');
    if (!href || href.charAt(0) === '#') return;                  // native anchor
    if (/^(https?:|mailto:|tel:|data:)/i.test(href)) return;      // leave external alone
    e.preventDefault();
    var r = resolve(current, href);
    var i = r.indexOf('#');
    var key  = i > -1 ? r.slice(0, i) : r;
    var hash = i > -1 ? r.slice(i) : '';
    if (PAGES[key]) go(key, hash);
  });

  go('index.html', '');
})();`
    // Function replacers, NOT strings. The payload contains `$$` (site.js's
    // querySelectorAll helper) and `$&`/`$'` can occur in the page copy, and
    // String.replace would interpret all of those as substitution patterns --
    // `$$` collapses to `$`, quietly rewriting `var $$ = ...` into `var $ =
    // ...` so every single-element lookup starts returning an array.
    .replace('__PAGES__', () => jsonAscii(pages))
    .replace('__SCRIPTS__', () => jsonAscii(scripts));

  const styles = cssAscii(fontCss + '\n' + mainCss);

  const html =
`<title>Dr. Amira Dabbagha</title>

<style>
/* ===== embedded typefaces (Heebo + Cormorant Garamond, OFL) ==============
   Inlined as woff2 data URIs: the Artifact CSP blocks font CDNs, and a
   silent fallback to Times would misrepresent the type pairing.
   ===== the site stylesheet follows, unmodified ==========================
   Non-ASCII is written as CSS escapes so the file needs no charset
   declaration of its own. The Artifact wrapper owns the <head>.
   The Artifact composites over a ground the viewer paints in its own theme,
   so html carries an explicit background; this design commits to a single
   light visual world by client direction. */
html { background: #F7F5F2; }

${styles}
</style>

<div id="app"></div>
<div id="runtime" hidden></div>

<script>${saveShim()}</script>
<script>${router}</script>
`;

  assertAscii(html, 'bundle');
  fs.writeFileSync(OUT, html, 'latin1');
  console.log(`\nwrote ${OUT}`);
  console.log(`total ${(Buffer.byteLength(html) / 1024 / 1024).toFixed(2)} MB (limit 16 MB)`);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
