/* ==========================================================================
   The Amira AI Mirror™ — client-side aesthetic simulation engine
   --------------------------------------------------------------------------
   Design principles, in order of importance:

   1. PRIVACY BY ARCHITECTURE. The photo never leaves the device. There is no
      upload, no fetch(), no third-party model call. Everything below runs on
      a <canvas> in the visitor's own browser and is discarded on page unload.

   2. HONESTY. This is a geometric / optical illustration engine — a soft
      local warp plus selective smoothing. It is deliberately NOT a predictive
      model, and every output is watermarked and captioned as illustration.

   3. RESTRAINT. Maximum magnitudes are intentionally conservative.
      Less is beautiful.
   ========================================================================== */
(function () {
  'use strict';

  var $  = function (s, c) { return (c || document).querySelector(s); };
  var $$ = function (s, c) { return Array.prototype.slice.call((c || document).querySelectorAll(s)); };

  var studio = $('#studio');
  if (!studio) return;

  /* ---------------------------------------------------------------- config */
  var W = 720, H = 960;                 // working resolution
  var OVAL = { cx: 0.500, cy: 0.470, w: 0.600, h: 0.790 }; // face guide, fraction of stage

  /* Region model.
     pos → normalized inside the oval's bounding box (0..1, 0..1)
     r   → radius as a fraction of the oval width
     Amplitudes are multiplied by the chosen intensity (0.35 / 0.62 / 0.88). */
  var REGIONS = [
    { key: 'forehead', en: 'Forehead', he: 'קמטי מצח', kind: 'botox',
      pos: [[0.500, 0.150]], r: 0.34, ry: 0.44, op: 'soften', amp: 1.00,
      copy: 'ריכוך כללי של קווי הבעה אופקיים במצח.' },

    { key: 'frown', en: 'Frown lines', he: 'קמטי הבעה בין הגבות', kind: 'botox',
      pos: [[0.500, 0.300]], r: 0.14, ry: 0.90, op: 'soften', amp: 1.00,
      copy: 'ריכוך הקו האנכי בין הגבות.' },

    { key: 'crows', en: "Crow's feet", he: 'קמטים בצדי העיניים', kind: 'botox',
      pos: [[0.215, 0.372], [0.785, 0.372]], r: 0.135, ry: 0.85, op: 'soften', amp: 0.95,
      copy: 'ריכוך קמטי חיוך בצדי העיניים.' },

    { key: 'nasolabial', en: 'Nasolabial folds', he: 'קמטים סביב הפה', kind: 'filler',
      pos: [[0.352, 0.650], [0.648, 0.650]], r: 0.145, ry: 1.25, op: 'soften-lift', amp: 0.90,
      copy: 'הפחתת בולטות הקפל שבין האף לפה.' },

    { key: 'lips', en: 'Lips', he: 'שפתיים', kind: 'filler', ml: true,
      pos: [[0.500, 0.732]], r: 0.205, ry: 0.56, op: 'bulge', amp: 0.155, vBias: 0.86,
      copy: 'הוספת נפח עדין ושיפור קו השפה.' },

    { key: 'cheeks', en: 'Cheeks', he: 'לחיים', kind: 'filler', ml: true,
      pos: [[0.185, 0.490], [0.815, 0.490]], r: 0.235, ry: 1.00, op: 'bulge-lift', amp: 0.105, lift: 0.030,
      copy: 'החזרת נפח עדין לעצם הלחי והרמה קלה של אזור הלחיים.' },

    { key: 'chin', en: 'Chin', he: 'סנטר', kind: 'filler', ml: true,
      pos: [[0.500, 0.905]], r: 0.185, ry: 0.85, op: 'bulge', amp: 0.100, vBias: 0.92,
      copy: 'איזון פרופורציית הסנטר בפרופיל ובחזית.' },

    { key: 'jawline', en: 'Jawline', he: 'קו לסת', kind: 'filler',
      pos: [[0.130, 0.735], [0.870, 0.735]], r: 0.250, ry: 0.95, op: 'define', amp: 0.030,
      copy: 'הדגשה עדינה של קו הלסת.' },

    { key: 'balance', en: 'Facial balancing', he: 'איזון פרופורציות', kind: 'filler',
      pos: [[0.500, 0.470]], r: 0.52, ry: 1.10, op: 'balance', amp: 0.022,
      copy: 'התבוננות רחבה על היחסים בין שלישי הפנים במקום על אזור בודד.' }
  ];

  var LEVELS = { subtle: 0.35, moderate: 0.62, enhanced: 0.88 };
  var ML     = { '': null, '0.5': 0.34, '1': 0.66 };  // illustrative scenarios only

  /* ------------------------------------------------------------------ state */
  var state = {
    img: null,
    fit: null,                 // {dw, dh}
    tx: 0, ty: 0, zoom: 1,
    active: [],                // region keys
    level: 'subtle',
    ml: '',
    consented: false,
    rendered: false
  };

  /* ------------------------------------------------------------------- DOM */
  var panels   = {
    upload:  $('#panelUpload'),
    align:   $('#panelAlign'),
    explore: $('#panelExplore'),
    result:  $('#panelResult')
  };
  var stepper  = $$('#studioStepper li');
  var file     = $('#mirrorFile');
  var drop     = $('#mirrorDrop');

  var alignStage  = $('#alignStage');
  var alignCanvas = $('#alignCanvas');
  var zoomInput   = $('#alignZoom');

  var faceStage   = $('#faceStage');
  var srcCanvas   = $('#srcCanvas');
  var outCanvas   = $('#outCanvas');
  var pinLayer    = $('#facePins');

  var cmpBefore   = $('#cmpBefore');
  var cmpAfter    = $('#cmpAfter');

  var regionList  = $('#regionList');
  var mlWrap      = $('#mlWrap');
  var mlSelect    = $('#mlScenario');
  var appliedList = $('#appliedList');
  var consentSheet= $('#consentSheet');

  var actx = alignCanvas ? alignCanvas.getContext('2d') : null;
  var sctx = srcCanvas.getContext('2d', { willReadFrequently: true });
  var octx = outCanvas.getContext('2d', { willReadFrequently: true });
  var bctx = cmpBefore.getContext('2d');
  var fctx = cmpAfter.getContext('2d');

  [alignCanvas, srcCanvas, outCanvas, cmpBefore, cmpAfter].forEach(function (c) {
    if (c) { c.width = W; c.height = H; }
  });

  /* ------------------------------------------------------------- navigation */
  function go(name) {
    Object.keys(panels).forEach(function (k) {
      if (panels[k]) panels[k].classList.toggle('is-active', k === name);
    });
    var order = ['upload', 'align', 'explore', 'result'];
    var i = order.indexOf(name);
    stepper.forEach(function (li, n) {
      if (n === i) li.setAttribute('aria-current', 'step');
      else li.removeAttribute('aria-current');
    });
    var head = studio.querySelector('.studio__head');
    if (head) head.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  /* ----------------------------------------------------------------- upload */
  function loadFile(f) {
    if (!f) return;
    if (!/^image\//.test(f.type)) { alert('נא לבחור קובץ תמונה (JPG או PNG).'); return; }
    if (f.size > 20 * 1024 * 1024) { alert('הקובץ גדול מדי. נא לבחור תמונה עד 20MB.'); return; }

    var url = URL.createObjectURL(f);   // stays local to this browser tab
    var img = new Image();
    img.onload = function () {
      URL.revokeObjectURL(url);
      state.img = img;
      /* cover-fit baseline */
      var s = Math.max(W / img.width, H / img.height);
      state.fit = { dw: img.width * s, dh: img.height * s };
      state.tx = 0; state.ty = 0; state.zoom = 1;
      if (zoomInput) zoomInput.value = 1;
      drawAlign();
      go('align');
    };
    img.onerror = function () { alert('לא הצלחנו לקרוא את התמונה. נסי קובץ אחר.'); };
    img.src = url;
  }

  if (file) file.addEventListener('change', function () { loadFile(file.files[0]); });

  if (drop) {
    ['dragenter', 'dragover'].forEach(function (t) {
      drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add('is-over'); });
    });
    ['dragleave', 'drop'].forEach(function (t) {
      drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.remove('is-over'); });
    });
    drop.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files) loadFile(e.dataTransfer.files[0]);
    });
  }

  /* ------------------------------------------------------- alignment canvas */
  function paintImage(ctx) {
    ctx.clearRect(0, 0, W, H);
    if (!state.img) return;
    var dw = state.fit.dw * state.zoom;
    var dh = state.fit.dh * state.zoom;
    var dx = (W - dw) / 2 + state.tx;
    var dy = (H - dh) / 2 + state.ty;
    ctx.drawImage(state.img, dx, dy, dw, dh);
  }

  function drawAlign() {
    if (!actx) return;
    paintImage(actx);
    /* guide oval */
    var o = ovalPx();
    actx.save();
    actx.strokeStyle = 'rgba(255,255,255,.85)';
    actx.lineWidth = 2;
    actx.setLineDash([10, 8]);
    actx.beginPath();
    actx.ellipse(o.cx, o.cy, o.rx, o.ry, 0, 0, Math.PI * 2);
    actx.stroke();
    /* thirds — helps the visitor line up eyes and mouth */
    actx.setLineDash([4, 10]);
    actx.strokeStyle = 'rgba(255,255,255,.55)';
    [0.372, 0.732].forEach(function (t) {
      var y = o.cy - o.ry + o.ry * 2 * t;
      actx.beginPath();
      actx.moveTo(o.cx - o.rx * 0.82, y);
      actx.lineTo(o.cx + o.rx * 0.82, y);
      actx.stroke();
    });
    actx.restore();
  }

  function ovalPx() {
    return {
      cx: OVAL.cx * W, cy: OVAL.cy * H,
      rx: (OVAL.w * W) / 2, ry: (OVAL.h * H) / 2
    };
  }

  /* drag to reposition */
  (function bindDrag() {
    if (!alignStage) return;
    var dragging = false, lastX = 0, lastY = 0;
    alignStage.addEventListener('pointerdown', function (e) {
      dragging = true; lastX = e.clientX; lastY = e.clientY;
      alignStage.setPointerCapture && alignStage.setPointerCapture(e.pointerId);
    });
    alignStage.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var rect = alignStage.getBoundingClientRect();
      state.tx += (e.clientX - lastX) * (W / rect.width);
      state.ty += (e.clientY - lastY) * (H / rect.height);
      lastX = e.clientX; lastY = e.clientY;
      drawAlign();
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (t) {
      alignStage.addEventListener(t, function () { dragging = false; });
    });
    alignStage.addEventListener('keydown', function (e) {
      var step = e.shiftKey ? 24 : 8, used = true;
      if (e.key === 'ArrowUp') state.ty -= step;
      else if (e.key === 'ArrowDown') state.ty += step;
      else if (e.key === 'ArrowLeft') state.tx -= step;
      else if (e.key === 'ArrowRight') state.tx += step;
      else used = false;
      if (used) { e.preventDefault(); drawAlign(); }
    });
  })();

  if (zoomInput) {
    zoomInput.addEventListener('input', function () {
      state.zoom = parseFloat(zoomInput.value);
      drawAlign();
    });
  }

  var alignReset = $('#alignReset');
  if (alignReset) alignReset.addEventListener('click', function () {
    state.tx = 0; state.ty = 0; state.zoom = 1;
    if (zoomInput) zoomInput.value = 1;
    drawAlign();
  });

  /* ------------------------------------------------------------ region pins */
  function regionPoints(r) {
    var o = ovalPx();
    var x0 = o.cx - o.rx, y0 = o.cy - o.ry, bw = o.rx * 2, bh = o.ry * 2;
    return r.pos.map(function (p) {
      return { x: x0 + p[0] * bw, y: y0 + p[1] * bh };
    });
  }

  function buildPins() {
    if (!pinLayer) return;
    pinLayer.innerHTML = '';
    REGIONS.forEach(function (r) {
      regionPoints(r).forEach(function (pt, n) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'pin';
        b.dataset.region = r.key;
        b.setAttribute('aria-pressed', state.active.indexOf(r.key) > -1 ? 'true' : 'false');
        b.setAttribute('aria-label', 'הדמיה באזור ' + r.he);
        b.style.insetInlineStart = (pt.x / W * 100) + '%';
        b.style.top = (pt.y / H * 100) + '%';
        if (n === 0) {
          var lab = document.createElement('span');
          lab.className = 'pin__label';
          lab.textContent = r.en;
          b.appendChild(lab);
        }
        b.addEventListener('click', function () { toggle(r.key); });
        pinLayer.appendChild(b);
      });
    });
  }

  function buildRegionList() {
    if (!regionList) return;
    regionList.innerHTML = REGIONS.map(function (r) {
      return '<li>' +
        '<button type="button" class="region-toggle" data-region="' + r.key + '" aria-pressed="false">' +
          '<span class="region-toggle__dot" aria-hidden="true"></span>' +
          '<span class="region-toggle__txt">' +
            '<span class="region-toggle__en">' + r.en + '</span>' +
            '<span class="region-toggle__he">' + r.he + '</span>' +
          '</span>' +
          '<span class="region-toggle__kind">' + (r.kind === 'botox' ? 'ריכוך קמטים' : 'נפח / מילוי') + '</span>' +
        '</button></li>';
    }).join('');
    $$('.region-toggle', regionList).forEach(function (b) {
      b.addEventListener('click', function () { toggle(b.dataset.region); });
    });
  }

  function toggle(key) {
    var i = state.active.indexOf(key);
    if (i > -1) state.active.splice(i, 1);
    else state.active.push(key);
    syncToggles();
    scheduleRender();
  }

  function syncToggles() {
    $$('[data-region]').forEach(function (el) {
      el.setAttribute('aria-pressed', state.active.indexOf(el.dataset.region) > -1 ? 'true' : 'false');
    });
    var hasFiller = state.active.some(function (k) {
      var r = byKey(k); return r && r.ml;
    });
    if (mlWrap) mlWrap.hidden = !hasFiller;

    var gen = $('#toResult');
    if (gen) gen.disabled = state.active.length === 0;
    var hint = $('#exploreHint');
    if (hint) hint.hidden = state.active.length > 0;
  }

  function byKey(k) {
    for (var i = 0; i < REGIONS.length; i++) if (REGIONS[i].key === k) return REGIONS[i];
    return null;
  }

  /* ---------------------------------------------------- intensity controls */
  $$('input[name="mirrorLevel"]').forEach(function (r) {
    r.addEventListener('change', function () {
      state.level = r.value;
      if (mlSelect) { mlSelect.value = ''; state.ml = ''; }
      scheduleRender();
    });
  });
  if (mlSelect) mlSelect.addEventListener('change', function () {
    state.ml = mlSelect.value;
    scheduleRender();
  });

  /* =======================================================================
     The engine
     ======================================================================= */

  /* Bilinear sample from a source byte buffer. */
  function sample(buf, x, y, out) {
    if (x < 0) x = 0; if (y < 0) y = 0;
    if (x > W - 1) x = W - 1; if (y > H - 1) y = H - 1;
    var x0 = x | 0, y0 = y | 0;
    var x1 = x0 + 1 > W - 1 ? W - 1 : x0 + 1;
    var y1 = y0 + 1 > H - 1 ? H - 1 : y0 + 1;
    var fx = x - x0, fy = y - y0;
    var i00 = (y0 * W + x0) << 2, i10 = (y0 * W + x1) << 2;
    var i01 = (y1 * W + x0) << 2, i11 = (y1 * W + x1) << 2;
    var w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy);
    var w01 = (1 - fx) * fy,       w11 = fx * fy;
    for (var c = 0; c < 3; c++) {
      out[c] = buf[i00 + c] * w00 + buf[i10 + c] * w10 + buf[i01 + c] * w01 + buf[i11 + c] * w11;
    }
  }

  /* Displacement pass: a callback returns the source coordinate for each pixel. */
  function warp(src, dst, cx, cy, rx, ry, fn) {
    var x0 = Math.max(0, Math.floor(cx - rx)), x1 = Math.min(W - 1, Math.ceil(cx + rx));
    var y0 = Math.max(0, Math.floor(cy - ry)), y1 = Math.min(H - 1, Math.ceil(cy + ry));
    var px = [0, 0], rgb = [0, 0, 0];
    for (var y = y0; y <= y1; y++) {
      for (var x = x0; x <= x1; x++) {
        var dx = x - cx, dy = y - cy;
        var u = Math.sqrt((dx / rx) * (dx / rx) + (dy / ry) * (dy / ry));
        if (u >= 1) continue;
        px[0] = x; px[1] = y;
        fn(dx, dy, u, px);
        sample(src, px[0], px[1], rgb);
        var i = (y * W + x) << 2;
        dst[i]     = rgb[0];
        dst[i + 1] = rgb[1];
        dst[i + 2] = rgb[2];
      }
    }
  }

  /* Selective smoothing: soften fine expression lines without flattening skin.
     A feathered blend between the pixel and its local mean — the tell-tale of
     over-processing is a uniform mask, so the blend falls off to zero at the
     region edge. */
  function soften(src, dst, cx, cy, rx, ry, strength) {
    var rad = Math.max(1, Math.round(2 + strength * 6));
    var x0 = Math.max(0, Math.floor(cx - rx)), x1 = Math.min(W - 1, Math.ceil(cx + rx));
    var y0 = Math.max(0, Math.floor(cy - ry)), y1 = Math.min(H - 1, Math.ceil(cy + ry));

    for (var y = y0; y <= y1; y++) {
      for (var x = x0; x <= x1; x++) {
        var dx = (x - cx) / rx, dy = (y - cy) / ry;
        var u = Math.sqrt(dx * dx + dy * dy);
        if (u >= 1) continue;
        var feather = Math.cos(u * Math.PI / 2);       // 1 at centre → 0 at edge
        var a = strength * 0.78 * feather * feather;

        var sr = 0, sg = 0, sb = 0, n = 0;
        var ay0 = y - rad < 0 ? 0 : y - rad, ay1 = y + rad > H - 1 ? H - 1 : y + rad;
        var ax0 = x - rad < 0 ? 0 : x - rad, ax1 = x + rad > W - 1 ? W - 1 : x + rad;
        for (var yy = ay0; yy <= ay1; yy += 2) {
          for (var xx = ax0; xx <= ax1; xx += 2) {
            var j = (yy * W + xx) << 2;
            sr += src[j]; sg += src[j + 1]; sb += src[j + 2]; n++;
          }
        }
        if (!n) continue;
        sr /= n; sg /= n; sb /= n;

        var i = (y * W + x) << 2;
        /* Only pull toward the mean where the pixel deviates from it — this is
           what makes lines soften while pores and edges largely survive. */
        dst[i]     = src[i]     + (sr - src[i])     * a;
        dst[i + 1] = src[i + 1] + (sg - src[i + 1]) * a;
        dst[i + 2] = src[i + 2] + (sb - src[i + 2]) * a;
      }
    }
  }

  function strengthFor(r) {
    var base = LEVELS[state.level] || LEVELS.subtle;
    if (r.ml && state.ml && ML[state.ml] != null) base = ML[state.ml];
    return base;
  }

  function applyRegion(r, src, dst) {
    var s = strengthFor(r);
    regionPoints(r).forEach(function (pt, n) {
      var rx = r.r * (OVAL.w * W);
      var ry = rx * (r.ry || 1);
      var cx = pt.x, cy = pt.y;

      if (r.op === 'soften') {
        soften(src, dst, cx, cy, rx, ry, s);
        return;
      }

      if (r.op === 'soften-lift') {
        soften(src, dst, cx, cy, rx, ry, s * 0.95);
        /* copy the softened result forward, then add a whisper of lift */
        var mid = new Uint8ClampedArray(dst);
        var lift = s * 0.012 * (OVAL.w * W);
        warp(mid, dst, cx, cy, rx, ry, function (dx, dy, u, px) {
          px[1] = cy + dy + lift * (1 - u) * (1 - u);
        });
        return;
      }

      if (r.op === 'bulge' || r.op === 'bulge-lift') {
        var amp = r.amp * s;
        var vb = r.vBias != null ? r.vBias : 1;
        var lift2 = (r.lift || 0) * s * (OVAL.w * W);
        warp(src, dst, cx, cy, rx, ry, function (dx, dy, u, px) {
          var f = Math.pow(u, amp * 2.2);           // <1 inside the region → magnifies
          px[0] = cx + dx * f;
          px[1] = cy + dy * f * vb + lift2 * (1 - u) * (1 - u);
        });
        return;
      }

      if (r.op === 'define') {
        /* Directional definition along the jaw: outward and very slightly up. */
        var side = n === 0 ? -1 : 1;
        var mag = r.amp * s * (OVAL.w * W);
        warp(src, dst, cx, cy, rx, ry, function (dx, dy, u, px) {
          var g = (1 - u) * (1 - u);
          px[0] = cx + dx - side * mag * g;
          px[1] = cy + dy + mag * 0.30 * g;
        });
        return;
      }

      if (r.op === 'balance') {
        /* A whole-face proportional nudge: a touch of vertical harmony only. */
        var m = r.amp * s * (OVAL.w * W);
        warp(src, dst, cx, cy, rx, ry, function (dx, dy, u, px) {
          var g = Math.cos(u * Math.PI / 2);
          px[0] = cx + dx * (1 - 0.006 * s * g);
          px[1] = cy + dy + m * 0.35 * g * (dy > 0 ? -1 : 0.4);
        });
      }
    });
  }

  /* ------------------------------------------------------------- rendering */
  var renderTimer = null;
  function scheduleRender() {
    if (renderTimer) window.clearTimeout(renderTimer);
    renderTimer = window.setTimeout(render, 90);
  }

  function render() {
    if (!state.img) return;

    /* 1. baseline */
    paintImage(sctx);
    var base = sctx.getImageData(0, 0, W, H);

    /* 2. ping-pong buffers so each region reads a settled image */
    var a = new Uint8ClampedArray(base.data);
    var b = new Uint8ClampedArray(base.data);

    var ordered = REGIONS.filter(function (r) { return state.active.indexOf(r.key) > -1; });
    ordered.forEach(function (r) {
      b.set(a);
      applyRegion(r, a, b);
      a.set(b);
    });

    var out = new ImageData(a, W, H);
    octx.putImageData(out, 0, 0);
    bctx.putImageData(base, 0, 0);
    fctx.putImageData(out, 0, 0);

    state.rendered = true;
    paintApplied();
  }

  function paintApplied() {
    if (!appliedList) return;
    var s = strengthFor({ ml: false });
    appliedList.innerHTML = state.active.map(function (k) {
      var r = byKey(k);
      if (!r) return '';
      var lvl = r.ml && state.ml ? state.ml + ' ml (תרחיש המחשה)' :
        (state.level === 'subtle' ? 'Subtle' : state.level === 'moderate' ? 'Moderate' : 'Enhanced');
      return '<li><span>' + r.he + '</span><span>' + lvl + '</span></li>';
    }).join('') || '<li><span class="muted">לא נבחרו אזורים</span><span></span></li>';
  }

  /* ---------------------------------------------------------------- consent */
  var toResult = $('#toResult');
  if (toResult) toResult.addEventListener('click', function () {
    if (!state.active.length) return;
    if (state.consented) { runPreview(); return; }
    if (window.AmiraSheet) window.AmiraSheet.open(consentSheet);
  });

  var consentCheck = $('#consentCheck');
  var consentGo    = $('#consentGo');
  if (consentCheck && consentGo) {
    consentCheck.addEventListener('change', function () { consentGo.disabled = !consentCheck.checked; });
    consentGo.addEventListener('click', function () {
      state.consented = true;
      if (window.AmiraSheet) window.AmiraSheet.close(consentSheet);
      runPreview();
    });
  }

  function runPreview() {
    go('result');
    var wait = $('#resultWait'), view = $('#resultView');
    if (wait) wait.hidden = false;
    if (view) view.hidden = true;
    window.setTimeout(function () {
      render();
      if (wait) wait.hidden = true;
      if (view) view.hidden = false;
      var cmp = $('#resultCompare');
      if (cmp && window.AmiraSite) window.AmiraSite.bindCompare(cmp);
    }, 40);
  }

  /* ---------------------------------------------------------- step buttons */
  var toExplore = $('#toExplore');
  if (toExplore) toExplore.addEventListener('click', function () {
    paintImage(sctx);
    render();
    buildPins();
    syncToggles();
    go('explore');
  });

  $$('[data-goto]').forEach(function (b) {
    b.addEventListener('click', function () { go(b.dataset.goto); });
  });

  /* ------------------------------------------------------------- downloads */
  var dl = $('#mirrorDownload');
  if (dl) dl.addEventListener('click', function () {
    /* Compose a labelled sheet so the illustration can never travel without
       its disclaimer attached. */
    var pad = 28, capH = 132;
    var c = document.createElement('canvas');
    c.width = W * 2 + pad * 3;
    c.height = H + pad * 2 + capH;
    var x = c.getContext('2d');

    x.fillStyle = '#F7F5F2';
    x.fillRect(0, 0, c.width, c.height);
    x.drawImage(cmpBefore, pad, pad, W, H);
    x.drawImage(cmpAfter, pad * 2 + W, pad, W, H);

    x.fillStyle = 'rgba(73,58,67,.72)';
    [['ORIGINAL', pad + 14], ['AI PREVIEW · FOR ILLUSTRATION ONLY', pad * 2 + W + 14]].forEach(function (t) {
      x.font = '500 22px Georgia, serif';
      var w = x.measureText(t[0]).width + 26;
      x.fillStyle = 'rgba(73,58,67,.72)';
      x.beginPath();
      x.roundRect ? x.roundRect(t[1], pad + 14, w, 40, 20) : x.rect(t[1], pad + 14, w, 40);
      x.fill();
      x.fillStyle = '#fff';
      x.fillText(t[0], t[1] + 13, pad + 41);
    });

    var y = H + pad * 2 + 14;
    x.fillStyle = '#493A43';
    x.font = '500 26px Georgia, serif';
    x.fillText('Dr. Amira Dabbagha · Medical Aesthetics', pad, y);
    x.fillStyle = '#6B5F5A';
    x.font = '20px Arial, sans-serif';
    x.direction = 'rtl';
    x.textAlign = 'right';
    var lines = [
      'הדמיה זו נוצרה לצורכי המחשה כללית בלבד ואינה מבטיחה תוצאת טיפול.',
      'התוצאה בפועל תלויה במבנה הפנים, בחומר, בכמות ובטכניקת ההזרקה.',
      'התאמת טיפול תיעשה רק לאחר בדיקה וייעוץ מקצועי. אין לראות בכך המלצה רפואית.'
    ];
    lines.forEach(function (l, i) { x.fillText(l, c.width - pad, y + 32 + i * 28); });

    c.toBlob(function (blob) {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'amira-ai-mirror-preview.jpg';
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
    }, 'image/jpeg', 0.92);
  });

  /* --------------------------------------------- hand-off to consultation */
  var discuss = $('#mirrorDiscuss');
  if (discuss) discuss.addEventListener('click', function (e) {
    try {
      window.sessionStorage.setItem('amira.mirror.handoff', JSON.stringify({
        keys: state.active,
        regions: state.active.map(function (k) { var r = byKey(k); return r ? r.he : k; }),
        level: state.ml ? state.ml + ' ml (תרחיש)' :
          (state.level === 'subtle' ? 'עדין' : state.level === 'moderate' ? 'בינוני' : 'מודגש')
      }));
    } catch (err) { /* private mode — the flow still works, just without prefill */ }
  });

  /* -------------------------------------------------------------- clean up */
  var reset = $('#mirrorReset');
  if (reset) reset.addEventListener('click', function () {
    state.img = null; state.active = []; state.rendered = false; state.consented = false;
    state.level = 'subtle'; state.ml = '';
    if (file) file.value = '';
    [actx, sctx, octx, bctx, fctx].forEach(function (c) { if (c) c.clearRect(0, 0, W, H); });
    var sub = $('input[name="mirrorLevel"][value="subtle"]');
    if (sub) sub.checked = true;
    if (mlSelect) mlSelect.value = '';
    syncToggles();
    go('upload');
  });

  /* Discard image data when the visitor leaves. Nothing is persisted. */
  window.addEventListener('pagehide', function () {
    state.img = null;
    [actx, sctx, octx, bctx, fctx].forEach(function (c) { if (c) c.clearRect(0, 0, W, H); });
  });

  buildRegionList();
  syncToggles();
})();
