window.__a11y = function () {
  function srgb(c) { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  function lum(rgb) { return 0.2126 * srgb(rgb[0]) + 0.7152 * srgb(rgb[1]) + 0.0722 * srgb(rgb[2]); }
  function parse(s) {
    var m = /rgba?\(([^)]+)\)/.exec(s || '');
    if (!m) return null;
    var p = m[1].split(',').map(function (x) { return parseFloat(x); });
    return { rgb: [p[0], p[1], p[2]], a: p.length > 3 ? p[3] : 1 };
  }
  /* Composite the stack of backgrounds rather than skipping translucent ones.
     Skipping them read a label on a 74%-opaque pill as if it sat on the section
     colour, and reported a legible white-on-plum tag as a contrast failure. */
  function bgOf(el) {
    var layers = [], e = el;
    while (e && e !== document.documentElement) {
      var c = parse(getComputedStyle(e).backgroundColor);
      if (c && c.a > 0.001) {
        layers.push(c);
        if (c.a > 0.95) break;
      }
      e = e.parentElement;
    }
    var base = [255, 255, 255];
    var last = layers.length ? layers[layers.length - 1] : null;
    if (last && last.a > 0.95) { base = last.rgb; layers.pop(); }
    else {
      var b = parse(getComputedStyle(document.body).backgroundColor);
      if (b && b.a > 0.95) base = b.rgb;
    }
    /* paint from the furthest ancestor inward */
    for (var i = layers.length - 1; i >= 0; i--) {
      var L = layers[i];
      base = [base[0] + (L.rgb[0] - base[0]) * L.a,
              base[1] + (L.rgb[1] - base[1]) * L.a,
              base[2] + (L.rgb[2] - base[2]) * L.a];
    }
    return base;
  }
  function ratio(a, b) {
    var l1 = lum(a), l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }

  var contrast = [], targets = [];

  document.querySelectorAll('*').forEach(function (el) {
    var cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.1) return;
    var r = el.getBoundingClientRect();

    /* --- text contrast: only elements with their own visible text ------- */
    var own = '';
    for (var i = 0; i < el.childNodes.length; i++) {
      if (el.childNodes[i].nodeType === 3) own += el.childNodes[i].textContent;
    }
    if (own.trim() && r.width > 0 && r.height > 0) {
      var fg = parse(cs.color);
      if (fg && fg.a > 0.5) {
        var px = parseFloat(cs.fontSize);
        var bold = parseInt(cs.fontWeight, 10) >= 700;
        var large = px >= 24 || (px >= 18.66 && bold);
        var need = large ? 3.0 : 4.5;
        var got = ratio(fg.rgb, bgOf(el));
        if (got < need - 0.01) {
          contrast.push({ tag: el.tagName + (el.className ? '.' + String(el.className).split(' ')[0] : ''),
                          text: own.trim().slice(0, 40), size: px, need: need,
                          got: Math.round(got * 100) / 100 });
        }
      }
    }

    /* --- target size (WCAG 2.2 SC 2.5.8, 24x24 minimum) ---------------- */
    if (el.matches('a[href], button, input:not([type=hidden]), select, textarea, [role=button], summary')) {
      if (r.width > 0 && r.height > 0) {
        /* SC 2.5.8 exempts a target whose function is inline in a sentence or
           block of text. Keying that off the parent's TAG was too narrow: the
           same inline link inside a styled <div> instead of a <p> was reported
           as a failure. What matters is that the link sits in a run of text, so
           that is what we test. */
        var inline = false;
        if (el.tagName === 'A' && getComputedStyle(el).display.indexOf('inline') === 0) {
          var p = el.parentElement, sib = '';
          if (p) {
            for (var q = 0; q < p.childNodes.length; q++) {
              var nd = p.childNodes[q];
              if (nd !== el && nd.nodeType === 3) sib += nd.textContent;
            }
          }
          inline = sib.trim().length > 0 || !!el.closest('p, li');
        }
        /* A visually-hidden control operated through a <label for> is not the
           target; the label is. This is the standard sr-only file-input
           pattern, and measuring the hidden 1x1 input reported a full-size
           button as a failure. Measure the label instead. */
        var proxied = false;
        if (el.id && (r.width < 3 || r.height < 3)) {
          var lab = document.querySelector('label[for="' + el.id + '"]');
          if (lab) {
            var lr = lab.getBoundingClientRect();
            proxied = lr.width >= 23.5 && lr.height >= 23.5;
          }
        }

        if (!inline && !proxied && (r.width < 23.5 || r.height < 23.5)) {
          targets.push({ tag: el.tagName + (el.className ? '.' + String(el.className).split(' ')[0] : ''),
                         label: (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30),
                         w: Math.round(r.width), h: Math.round(r.height) });
        }
      }
    }
  });

  return {
    width: window.innerWidth,
    overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
    scrollW: document.documentElement.scrollWidth,
    contrastFailures: contrast,
    targetFailures: targets
  };
};
