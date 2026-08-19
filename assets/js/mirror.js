/* ==========================================================================
   The Amira AI Mirror — aesthetic simulation, v2 (landmark driven)
   --------------------------------------------------------------------------
   PRIVACY BY ARCHITECTURE. The photo never leaves the device. No fetch, no
   upload, no third-party model call — the detection engine itself is vendored
   locally under assets/vendor/mediapipe/. Everything below runs on canvases in
   the visitor's browser and is discarded on page unload.

   ONE COORDINATE SYSTEM. Every pixel operation happens on a single "work
   canvas" built once from the source. Landmarks are normalised to that canvas;
   every overlay canvas has exactly its aspect ratio and is never subject to
   object-fit. There is no second geometry to keep in sync, so the class of bug
   where an overlay drifts from the image cannot occur:

       source image / video frame
            -> work canvas  (fixed max edge, aspect preserved)
            -> landmarks    (normalised to the work canvas)
            -> frame        (origin between the eyes, unit = interocular)
            -> regions      (polygons in that frame)
            -> masks        (feathered rasterisation of those polygons)
            -> deformation  (weighted by the mask alpha, nothing outside it)

   SELFIE MIRRORING is resolved once, at capture: the frame is written into the
   work canvas already mirrored, so what the visitor saw is what gets analysed.
   Nothing downstream needs to know a camera was involved.

   FAIL CLOSED. If the quality gate rejects the photo there is no preview at
   all — not a degraded one. A plausible-looking wrong mapping is worse than a
   refusal, because the visitor cannot tell it is wrong.

   HONESTY. The deformation is a geometric/optical model, deliberately not a
   predictive one, and its magnitude is capped. Less is beautiful.
   ========================================================================== */
(function () {
  'use strict';

  var $  = function (s, c) { return (c || document).querySelector(s); };
  var $$ = function (s, c) { return Array.prototype.slice.call((c || document).querySelectorAll(s)); };

  var studio = $('#studio');
  if (!studio) return;

  var WORK_MAX = 1100;          // longest edge of the work canvas
  /* Blur sigma as a fraction of interocular distance. Chosen so the mask
     fades out within ~0.1 interocular of the polygon edge: a canvas blur
     spreads about 2.5 sigma, and anything wider let one region's effect
     reach the neighbouring feature. */
  var FEATHER_K = 0.04;
  var DEBUG = /[?&]debugFace=1/.test(location.search);

  /* Volume scenarios offered in "Explore by volume". Illustration only. */
  var VOLUMES = [0, 0.5, 1, 1.5, 2, 2.5, 3, 4];

  /* ------------------------------------------------------------------ state */
  var S = {
    work: null,          // {canvas, ctx, w, h}
    base: null,          // ImageData of the untouched work canvas
    landmarks: null,
    frame: null,
    regions: null,
    sets: null,
    gate: null,
    active: [],
    intensity: 0.35,     // primary control, 0..1
    volumeMode: false,
    volumeMl: 1,
    consented: false,
    stream: null,
    rafId: 0,
    camReady: 0
  };

  /* -------------------------------------------------------------------- DOM */
  var panels = {
    start:   $('#panelStart'),
    camera:  $('#panelCamera'),
    analyze: $('#panelAnalyze'),
    reject:  $('#panelReject'),
    explore: $('#panelExplore'),
    result:  $('#panelResult')
  };
  var stepper = $$('#studioStepper li');

  var faceStage   = $('#faceStage');
  var outCanvas   = $('#outCanvas');
  var overlay     = $('#overlayCanvas');
  var cmpBefore   = $('#cmpBefore');
  var cmpAfter    = $('#cmpAfter');
  var regionList  = $('#regionList');
  var consentSheet = $('#consentSheet');

  var octx = outCanvas.getContext('2d', { willReadFrequently: true });
  var vctx = overlay.getContext('2d');
  var bctx = cmpBefore.getContext('2d');
  var fctx = cmpAfter.getContext('2d');

  /* ---------------------------------------------------------------- panels */
  function go(name) {
    Object.keys(panels).forEach(function (k) {
      if (panels[k]) panels[k].classList.toggle('is-active', k === name);
    });
    var order = { start: 0, camera: 0, analyze: 1, reject: 1, explore: 2, result: 3 };
    var at = order[name];
    stepper.forEach(function (li, n) {
      if (n === at) li.setAttribute('aria-current', 'step');
      else li.removeAttribute('aria-current');
    });
    var head = $('.studio__head', studio);
    if (head) head.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function setStatus(el, text) { if (el) el.textContent = text; }

  /* =======================================================================
     1. Work canvas — the single coordinate system
     ======================================================================= */

  /**
   * Draws `source` into a fresh work canvas, aspect preserved, longest edge
   * clamped to WORK_MAX. `mirror` flips horizontally at write time so that
   * downstream code never has to know about it.
   */
  function makeWork(source, sw, sh, mirror) {
    var scale = Math.min(1, WORK_MAX / Math.max(sw, sh));
    var w = Math.max(1, Math.round(sw * scale));
    var h = Math.max(1, Math.round(sh * scale));
    var canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.save();
    if (mirror) { ctx.translate(w, 0); ctx.scale(-1, 1); }
    ctx.drawImage(source, 0, 0, w, h);
    ctx.restore();
    return { canvas: canvas, ctx: ctx, w: w, h: h };
  }

  /**
   * Pixel canvases are sized to EXACTLY the work canvas. putImageData ignores
   * the context transform and writes device pixels, so a DPR-scaled backing
   * store would leave the image in the top-left corner. CSS scales it instead.
   */
  function sizeExact(canvas, w, h) {
    canvas.width = w;
    canvas.height = h;
    canvas.style.aspectRatio = w + ' / ' + h;
  }

  /**
   * Vector overlays DO want the device resolution, so strokes stay crisp. The
   * transform lets us keep drawing in work-canvas units.
   */
  function sizeCrisp(canvas, w, h) {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.aspectRatio = w + ' / ' + h;
  }

  /* =======================================================================
     2. Engine loading (lazy, explicit intent only)
     ======================================================================= */
  var ENGINE_STEPS = {
    engine: 'טוענת את מנוע זיהוי הפנים…',
    wasm:   'מכינה את המנוע במכשיר שלך…',
    model:  'טוענת את מודל 478 הנקודות…',
    ready:  'המנוע מוכן.'
  };

  function ensureEngine(statusEl) {
    setStatus(statusEl, ENGINE_STEPS.engine);
    return window.AmiraFaceMesh.load({
      vendorBase: studio.dataset.vendorBase || 'assets/vendor/mediapipe',
      onProgress: function (step) { setStatus(statusEl, ENGINE_STEPS[step] || ''); }
    }).then(function (lib) {
      S.sets = window.AmiraFaceRegions.buildSets(lib.FaceLandmarker);
      if (!S.sets) throw { code: 'no_sets', message: 'landmark index sets unavailable' };
      return lib;
    });
  }

  var ENGINE_ERRORS = {
    engine_unavailable: 'מנוע זיהוי הפנים אינו זמין בגרסה הזו של העמוד.',
    no_simd: 'הדפדפן הזה אינו תומך בטכנולוגיה הנדרשת (WebAssembly SIMD). נסי דפדפן מעודכן.',
    no_sets: 'המנוע נטען אך לא הצלחנו לקרוא את מפת הנקודות.',
    engine_error: 'לא הצלחנו לטעון את מנוע זיהוי הפנים.'
  };

  /* =======================================================================
     3. Analysis + the quality gate
     ======================================================================= */

  var PROBLEM_TEXT = {
    no_face:        'לא זיהינו פנים בתמונה.',
    multiple_faces: 'זיהינו יותר מפנים אחת. נדרשת תמונה של אדם אחד בלבד.',
    sparse_mesh:    'זיהוי הפנים לא היה שלם.',
    no_pose:        'לא הצלחנו לחשב את זווית הפנים.',
    off_axis:       'הראש מוטה בזווית. נדרש מבט ישר למצלמה.',
    turned:         'הפנים מופנות הצידה. נדרש מבט ישר למצלמה.',
    roll:           'הראש נטוי. כדאי ליישר את הראש.',
    too_small:      'הפנים קטנות מדי בתמונה. כדאי להתקרב.',
    cropped:        'הפנים חתוכות בקצה התמונה. נדרשות פנים שלמות, כולל סנטר ומצח.',
    no_frame:       'לא הצלחנו למפות את מבנה הפנים בצורה אמינה.',
    low_detail:     'התמונה ברזולוציה נמוכה מדי לאזור הפנים.',
    no_pose_alt:    'לא הצלחנו לחשב את זווית הפנים.'
  };

  /**
   * Runs detection + both halves of the gate on the current work canvas.
   * Returns {ok, problems, metrics}. On success, S.landmarks/frame/regions are
   * populated; on failure they are cleared, so no stale mapping can be drawn.
   */
  function analyse() {
    S.landmarks = null; S.frame = null; S.regions = null;

    var result;
    try {
      result = window.AmiraFaceMesh.detectImage(S.work.canvas);
    } catch (e) {
      return { ok: false, problems: [{ code: 'engine_error', message: String(e) }], metrics: {} };
    }

    var size = { w: S.work.w, h: S.work.h };
    var gate = window.AmiraFaceMesh.assess(result, size);
    if (!gate.ok && gate.problems.some(function (p) {
      return p.code === 'no_face' || p.code === 'multiple_faces';
    })) return gate;

    var aspect = S.work.w / S.work.h;
    var frame = window.AmiraFaceRegions.buildFrame(gate.landmarks, S.sets, aspect);
    window.AmiraFaceMesh.assessFrame(frame, size, gate.problems, gate.metrics);
    gate.ok = gate.problems.length === 0;

    if (!gate.ok) return gate;

    S.landmarks = gate.landmarks;
    S.frame = frame;
    S.regions = window.AmiraFaceRegions.build(frame);
    if (!S.regions || !Object.keys(S.regions).length) {
      gate.ok = false;
      gate.problems.push({ code: 'no_frame', message: 'no regions could be built' });
      S.landmarks = null; S.frame = null; S.regions = null;
    }
    return gate;
  }

  function showRejection(gate) {
    var list = $('#rejectList');
    if (list) {
      var seen = {};
      list.innerHTML = gate.problems.filter(function (p) {
        if (seen[p.code]) return false;
        seen[p.code] = 1; return true;
      }).map(function (p) {
        return '<li>' + (PROBLEM_TEXT[p.code] || p.message) + '</li>';
      }).join('');
    }
    var dbg = $('#rejectDebug');
    if (dbg) {
      dbg.hidden = !DEBUG;
      if (DEBUG) dbg.textContent = JSON.stringify(gate.metrics, null, 1);
    }
    go('reject');
  }

  /* =======================================================================
     4. Masks — feathered rasterisation of a region polygon
     ======================================================================= */

  function pathPolygon(ctx, poly, w, h) {
    ctx.beginPath();
    for (var i = 0; i < poly.length; i++) {
      var x = poly[i].x * w, y = poly[i].y * h;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  var maskCanvas = document.createElement('canvas');
  var maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true });

  /**
   * Rasterises one region part into a feathered alpha mask, clipped to the
   * detected face oval so the effect can never spill outside the face.
   *
   * The mask depends only on the geometry, never on the chosen strength, so it
   * is built ONCE per detection and reused for every slider move. The alpha is
   * stored for the polygon's bounding box only — the pixel loops that consume
   * it then touch a few hundred thousand pixels instead of the whole image.
   *
   * Returns {alpha, bbox, bw} or null if the polygon rasterised to nothing.
   */
  function buildMask(part, featherPx) {
    var w = S.work.w, h = S.work.h;

    /* bbox straight from the polygon, padded for the blur — no full-frame scan */
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (var i = 0; i < part.image.length; i++) {
      var p = part.image[i];
      if (p.x < x0) x0 = p.x;
      if (p.x > x1) x1 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.y > y1) y1 = p.y;
    }
    var pad = Math.ceil(featherPx * 2.5) + 2;
    var bx0 = Math.max(0, Math.floor(x0 * w) - pad);
    var by0 = Math.max(0, Math.floor(y0 * h) - pad);
    var bx1 = Math.min(w - 1, Math.ceil(x1 * w) + pad);
    var by1 = Math.min(h - 1, Math.ceil(y1 * h) + pad);
    var bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
    if (bw < 2 || bh < 2) return null;

    if (maskCanvas.width !== bw || maskCanvas.height !== bh) {
      maskCanvas.width = bw; maskCanvas.height = bh;
    }
    maskCtx.setTransform(1, 0, 0, 1, 0, 0);
    maskCtx.clearRect(0, 0, bw, bh);
    maskCtx.translate(-bx0, -by0);

    maskCtx.save();
    /* Hard containment: the detected face silhouette is the clip path. */
    var ovalImage = S.frame.ovalLocal.map(S.frame.toImage);
    pathPolygon(maskCtx, ovalImage, w, h);
    maskCtx.clip();

    maskCtx.filter = featherPx > 0.4 ? 'blur(' + featherPx.toFixed(1) + 'px)' : 'none';
    maskCtx.fillStyle = '#fff';
    pathPolygon(maskCtx, part.image, w, h);
    maskCtx.fill();
    maskCtx.restore();

    /* Optional anatomical cut-off. The forehead uses it so that softening
       cannot creep down onto the eyebrows, which are high-contrast and would
       look obviously wrong if blurred. */
    if (part.clipBelowV != null) {
      var cut = S.frame.toImage({ u: 0, v: part.clipBelowV });
      maskCtx.setTransform(1, 0, 0, 1, 0, 0);
      maskCtx.translate(-bx0, -by0);
      maskCtx.globalCompositeOperation = 'destination-out';
      maskCtx.filter = 'blur(' + Math.max(1, featherPx * 0.6).toFixed(1) + 'px)';
      maskCtx.fillStyle = '#000';
      maskCtx.fillRect(-w, cut.y * h, w * 3, h * 2);
      maskCtx.globalCompositeOperation = 'source-over';
      maskCtx.filter = 'none';
    }

    var data = maskCtx.getImageData(0, 0, bw, bh).data;
    /* keep only the alpha channel: a quarter of the memory, simpler indexing */
    var alpha = new Uint8Array(bw * bh);
    var any = false;
    for (var k = 0, n = bw * bh; k < n; k++) {
      var a = data[(k << 2) + 3];
      alpha[k] = a;
      if (a > 2) any = true;
    }
    if (!any) return null;

    return { alpha: alpha, bw: bw, bbox: { x0: bx0, y0: by0, x1: bx1, y1: by1 } };
  }

  /** Builds and caches every active region's mask for the current detection. */
  function buildAllMasks() {
    if (!S.frame || !S.regions) return;
    var w = S.work.w;
    Object.keys(S.regions).forEach(function (key) {
      var region = S.regions[key];
      var featherPx = (region.def.feather || 0.6) * S.frame.scale * w * FEATHER_K;
      region.parts.forEach(function (part) {
        part.mask = buildMask(part, featherPx);
      });
    });
  }

  /* =======================================================================
     5. Deformation
     ======================================================================= */

  function sample(buf, w, h, x, y, out) {
    if (x < 0) x = 0; if (y < 0) y = 0;
    if (x > w - 1) x = w - 1; if (y > h - 1) y = h - 1;
    var x0 = x | 0, y0 = y | 0;
    var x1 = x0 + 1 > w - 1 ? w - 1 : x0 + 1;
    var y1 = y0 + 1 > h - 1 ? h - 1 : y0 + 1;
    var fx = x - x0, fy = y - y0;
    var i00 = (y0 * w + x0) << 2, i10 = (y0 * w + x1) << 2;
    var i01 = (y1 * w + x0) << 2, i11 = (y1 * w + x1) << 2;
    var w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy);
    var w01 = (1 - fx) * fy,       w11 = fx * fy;
    for (var c = 0; c < 3; c++) {
      out[c] = buf[i00 + c] * w00 + buf[i10 + c] * w10 + buf[i01 + c] * w01 + buf[i11 + c] * w11;
    }
  }

  /**
   * Displacement pass. The mask alpha IS the falloff, so the region's own
   * detected outline decides where the effect exists and how strongly.
   */
  function warpPart(src, dst, mask, part, def, strength) {
    var w = S.work.w, h = S.work.h;
    var b = mask.bbox, alpha = mask.alpha, bw = mask.bw;
    var rgb = [0, 0, 0];

    /* The frame axes were built in "square" space (x scaled by aspect). Square
       space is a UNIFORM scale of pixel space — x_px = x_sq * h and
       y_px = y_sq * h — so a unit direction is identical in both, and the axes
       can be used here as they are. Anisotropy therefore follows the head's
       own tilt rather than the image axes. */
    var f = S.frame;
    var sx = f.scale * w;                 // interocular distance in pixels
    var ex = f.ex, ey = f.ey;

    var cx = part.centroidImage.x * w, cy = part.centroidImage.y * h;
    var amp = def.amp * strength;
    var biasV = def.biasV || 1;
    var liftPx = (def.lift || 0) * strength * sx;
    var outSign = part.sign;

    for (var y = b.y0; y <= b.y1; y++) {
      for (var x = b.x0; x <= b.x1; x++) {
        var i = (y * w + x) << 2;
        var wgt = alpha[(y - b.y0) * bw + (x - b.x0)] / 255;
        if (wgt <= 0.004) continue;

        var sxp = x, syp = y;

        if (def.op === 'expand' || def.op === 'lift') {
          var dx = x - cx, dy = y - cy;
          /* decompose onto the head's own axes */
          var du = dx * ex.x + dy * ex.y;
          var dv = dx * ey.x + dy * ey.y;
          var k = 1 - amp * wgt;
          var ku = k;
          var kv = 1 - amp * wgt * biasV;
          du *= ku; dv *= kv;
          if (def.op === 'lift') dv += liftPx * wgt;   // sample from below => moves up
          sxp = cx + du * ex.x + dv * ey.x;
          syp = cy + du * ex.y + dv * ey.y;
        } else if (def.op === 'define') {
          var shift = amp * wgt * sx;
          sxp = x - outSign * shift * ex.x - shift * 0.28 * ey.x;
          syp = y - outSign * shift * ex.y - shift * 0.28 * ey.y;
        }

        sample(src, w, h, sxp, syp, rgb);
        dst[i]     = rgb[0];
        dst[i + 1] = rgb[1];
        dst[i + 2] = rgb[2];
      }
    }
  }

  /**
   * Selective softening for expression areas. Pulls each pixel toward its local
   * mean in proportion to how far it deviates, weighted by the mask — so lines
   * soften while pores and edges largely survive.
   */
  function softenPart(src, dst, mask, def, strength) {
    var w = S.work.w, h = S.work.h;
    var b = mask.bbox, alpha = mask.alpha, bw = mask.bw;
    var sx = S.frame.scale * w;
    var rad = Math.max(1, Math.round(sx * 0.035 * (0.5 + strength)));

    for (var y = b.y0; y <= b.y1; y++) {
      for (var x = b.x0; x <= b.x1; x++) {
        var i = (y * w + x) << 2;
        var wgt = alpha[(y - b.y0) * bw + (x - b.x0)] / 255;
        if (wgt <= 0.004) continue;
        var a = strength * def.amp * 0.8 * wgt;

        var sr = 0, sg = 0, sb = 0, n = 0;
        var y0 = y - rad < 0 ? 0 : y - rad, y1 = y + rad > h - 1 ? h - 1 : y + rad;
        var x0 = x - rad < 0 ? 0 : x - rad, x1 = x + rad > w - 1 ? w - 1 : x + rad;
        for (var yy = y0; yy <= y1; yy += 2) {
          for (var xx = x0; xx <= x1; xx += 2) {
            var j = (yy * w + xx) << 2;
            sr += src[j]; sg += src[j + 1]; sb += src[j + 2]; n++;
          }
        }
        if (!n) continue;
        sr /= n; sg /= n; sb /= n;
        dst[i]     = src[i]     + (sr - src[i])     * a;
        dst[i + 1] = src[i + 1] + (sg - src[i + 1]) * a;
        dst[i + 2] = src[i + 2] + (sb - src[i + 2]) * a;
      }
    }
  }

  /* --------------------------------------------------------------- rendering */

  function effectiveStrength() {
    if (!S.volumeMode) return S.intensity;
    /* ml -> simulation intensity. Illustration only: deliberately sub-linear
       so a bigger number does not read as a proportionally bigger promise. */
    return Math.min(1, Math.pow(S.volumeMl / 4, 0.8));
  }

  var renderTimer = null;
  function scheduleRender() {
    if (renderTimer) clearTimeout(renderTimer);
    renderTimer = setTimeout(render, 70);
  }

  function render() {
    if (!S.base || !S.frame) return;
    var w = S.work.w, h = S.work.h;
    var strength = effectiveStrength();

    var a = new Uint8ClampedArray(S.base.data);
    var b = new Uint8ClampedArray(S.base.data);

    var order = window.AmiraFaceRegions.CATALOGUE.filter(function (d) {
      return S.active.indexOf(d.key) > -1;
    });

    order.forEach(function (def) {
      var region = S.regions[def.key];
      if (!region) return;
      region.parts.forEach(function (part) {
        if (!part.mask) return;               // masks are cached per detection
        b.set(a);
        if (def.op === 'smooth') softenPart(a, b, part.mask, def, strength);
        else warpPart(a, b, part.mask, part, def, strength);
        a.set(b);
      });
    });

    var out = new ImageData(a, w, h);
    octx.putImageData(out, 0, 0);
    bctx.putImageData(S.base, 0, 0);
    fctx.putImageData(out, 0, 0);
    paintOverlay();
    paintApplied();
  }

  /* ------------------------------------------------- region highlight overlay */

  function paintOverlay() {
    if (!overlay || !S.frame) return;
    var w = S.work.w, h = S.work.h;
    vctx.setTransform(overlay.width / w, 0, 0, overlay.height / h, 0, 0);
    vctx.clearRect(0, 0, w, h);

    var iod = S.frame.scale * w;

    window.AmiraFaceRegions.CATALOGUE.forEach(function (def) {
      var region = S.regions[def.key];
      if (!region) return;
      var on = S.active.indexOf(def.key) > -1;
      var hot = def.key === hoverKey;
      if (!on && !hot) return;

      region.parts.forEach(function (part) {
        pathPolygon(vctx, part.image, w, h);
        vctx.fillStyle = on ? 'rgba(220,228,222,0.30)' : 'rgba(220,228,222,0.16)';
        vctx.fill();
        vctx.lineWidth = Math.max(1, iod * (on ? 0.018 : 0.012));
        vctx.strokeStyle = on ? 'rgba(73,58,67,0.62)' : 'rgba(73,58,67,0.34)';
        vctx.setLineDash(on ? [] : [iod * 0.06, iod * 0.05]);
        vctx.stroke();
        vctx.setLineDash([]);
      });
    });

    if (DEBUG) paintDebug();
  }

  /* ------------------------------------------------------------ debug layer */

  function paintDebug() {
    var w = S.work.w, h = S.work.h, f = S.frame;
    var iod = f.scale * w;

    /* all 478 landmarks */
    vctx.fillStyle = 'rgba(255,255,255,0.75)';
    for (var i = 0; i < S.landmarks.length; i++) {
      var p = S.landmarks[i];
      vctx.fillRect(p.x * w - 0.6, p.y * h - 0.6, 1.4, 1.4);
    }

    var box = window.AmiraFaceMesh.bboxOf(S.landmarks);
    vctx.strokeStyle = 'rgba(255,0,80,0.8)';
    vctx.lineWidth = Math.max(1, iod * 0.008);
    vctx.strokeRect(box.x0 * w, box.y0 * h, box.w * w, box.h * h);

    function line(a, b, color) {
      var p = f.toImage(a), q = f.toImage(b);
      vctx.strokeStyle = color;
      vctx.beginPath();
      vctx.moveTo(p.x * w, p.y * h);
      vctx.lineTo(q.x * w, q.y * h);
      vctx.stroke();
    }
    var A = f.anchors;
    line({ u: 0, v: A.vTop }, { u: 0, v: A.vChin }, 'rgba(0,180,255,0.85)');       // centre line
    line({ u: -1.2, v: 0 }, { u: 1.2, v: 0 }, 'rgba(0,255,140,0.85)');            // eye line
    line({ u: -1.0, v: A.vMouth }, { u: 1.0, v: A.vMouth }, 'rgba(255,210,0,0.8)'); // mouth line
    line({ u: -1.0, v: A.vNose }, { u: 1.0, v: A.vNose }, 'rgba(255,120,0,0.8)');  // nose line

    /* contours */
    function contour(list, color) {
      vctx.strokeStyle = color;
      vctx.beginPath();
      list.forEach(function (l, n) {
        var q = f.toImage(l);
        if (n === 0) vctx.moveTo(q.x * w, q.y * h); else vctx.lineTo(q.x * w, q.y * h);
      });
      vctx.closePath(); vctx.stroke();
    }
    contour(f.ovalLocal, 'rgba(255,255,255,0.9)');
    contour(f.lipsLocal, 'rgba(255,0,200,0.9)');

    /* every region polygon, whether selected or not */
    Object.keys(S.regions).forEach(function (k) {
      S.regions[k].parts.forEach(function (part) {
        pathPolygon(vctx, part.image, w, h);
        vctx.strokeStyle = 'rgba(0,255,255,0.55)';
        vctx.lineWidth = Math.max(1, iod * 0.006);
        vctx.stroke();
      });
    });

    var dbg = $('#debugReadout');
    if (dbg) {
      dbg.hidden = false;
      dbg.textContent = JSON.stringify({
        work: S.work.w + 'x' + S.work.h,
        metrics: S.gate && S.gate.metrics,
        anchors: Object.keys(A).reduce(function (o, k) {
          var v = A[k];
          o[k] = (typeof v === 'number') ? +v.toFixed(3) : v;
          return o;
        }, {})
      }, null, 1);
    }
  }

  /* =======================================================================
     6. Region selection UI
     ======================================================================= */
  var hoverKey = null;

  function buildRegionList() {
    if (!regionList) return;
    regionList.innerHTML = window.AmiraFaceRegions.CATALOGUE.map(function (r) {
      return '<li>' +
        '<button type="button" class="region-toggle" data-region="' + r.key + '" aria-pressed="false">' +
          '<span class="region-toggle__dot" aria-hidden="true"></span>' +
          '<span class="region-toggle__txt">' +
            '<span class="region-toggle__en">' + r.en + '</span>' +
            '<span class="region-toggle__he">' + r.he + '</span>' +
          '</span>' +
          '<span class="region-toggle__kind">' +
            (r.kind === 'botox' ? 'ריכוך קמטים' : 'נפח / מילוי') +
          '</span>' +
        '</button></li>';
    }).join('');

    $$('.region-toggle', regionList).forEach(function (b) {
      b.addEventListener('click', function () { toggle(b.dataset.region); });
      b.addEventListener('mouseenter', function () { hoverKey = b.dataset.region; paintOverlay(); });
      b.addEventListener('mouseleave', function () { hoverKey = null; paintOverlay(); });
      b.addEventListener('focus', function () { hoverKey = b.dataset.region; paintOverlay(); });
      b.addEventListener('blur', function () { hoverKey = null; paintOverlay(); });
    });
  }

  function defOf(key) {
    var list = window.AmiraFaceRegions.CATALOGUE;
    for (var i = 0; i < list.length; i++) if (list[i].key === key) return list[i];
    return null;
  }

  function toggle(key) {
    var i = S.active.indexOf(key);
    if (i > -1) S.active.splice(i, 1); else S.active.push(key);
    syncToggles();
    scheduleRender();
  }

  function syncToggles() {
    $$('[data-region]').forEach(function (el) {
      el.setAttribute('aria-pressed', S.active.indexOf(el.dataset.region) > -1 ? 'true' : 'false');
    });
    var anyVolume = S.active.some(function (k) { var d = defOf(k); return d && d.volume; });
    var vw = $('#volumeWrap');
    if (vw) vw.hidden = !anyVolume;
    if (!anyVolume && S.volumeMode) { S.volumeMode = false; syncVolumeMode(); }

    var gen = $('#toResult');
    if (gen) gen.disabled = S.active.length === 0;
    var hint = $('#exploreHint');
    if (hint) hint.hidden = S.active.length > 0;
  }

  function paintApplied() {
    var list = $('#appliedList');
    if (!list) return;
    var label = S.volumeMode
      ? S.volumeMl + ' ml (תרחיש המחשה)'
      : intensityLabel(S.intensity);
    list.innerHTML = S.active.map(function (k) {
      var d = defOf(k);
      if (!d) return '';
      return '<li><span>' + d.he + '</span><span>' +
        (d.volume ? label : intensityLabel(S.intensity)) + '</span></li>';
    }).join('') || '<li><span class="muted">לא נבחרו אזורים</span><span></span></li>';
  }

  function intensityLabel(v) {
    if (v < 0.28) return 'עדין';
    if (v < 0.6) return 'בינוני';
    return 'מודגש';
  }

  /* ------------------------------------------------------------- controls */
  var intensityRange = $('#intensityRange');
  if (intensityRange) {
    intensityRange.addEventListener('input', function () {
      S.intensity = parseInt(intensityRange.value, 10) / 100;
      var out = $('#intensityOut');
      if (out) out.textContent = intensityLabel(S.intensity);
      scheduleRender();
    });
  }

  var volumeToggle = $('#volumeToggle');
  var volumeRange = $('#volumeRange');
  function syncVolumeMode() {
    var box = $('#volumeControls');
    if (box) box.hidden = !S.volumeMode;
    if (volumeToggle) volumeToggle.setAttribute('aria-pressed', String(S.volumeMode));
    var pri = $('#intensityControls');
    if (pri) pri.classList.toggle('is-secondary', S.volumeMode);
  }
  if (volumeToggle) {
    volumeToggle.addEventListener('click', function () {
      S.volumeMode = !S.volumeMode;
      syncVolumeMode();
      scheduleRender();
    });
  }
  if (volumeRange) {
    volumeRange.max = String(VOLUMES.length - 1);
    volumeRange.addEventListener('input', function () {
      S.volumeMl = VOLUMES[parseInt(volumeRange.value, 10)] || 0;
      var out = $('#volumeOut');
      if (out) out.textContent = S.volumeMl + ' ml';
      scheduleRender();
    });
  }

  /* =======================================================================
     7. Upload path
     ======================================================================= */
  var fileInput = $('#mirrorFile');
  var drop = $('#mirrorDrop');

  function handleFile(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) { alert('נא לבחור קובץ תמונה (JPG או PNG).'); return; }
    if (file.size > 25 * 1024 * 1024) { alert('הקובץ גדול מדי. נא לבחור תמונה עד 25MB.'); return; }

    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      URL.revokeObjectURL(url);
      startAnalysis(img, img.naturalWidth, img.naturalHeight, false);
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      alert('לא הצלחנו לקרוא את התמונה. נסי קובץ אחר.');
    };
    img.src = url;
  }

  if (fileInput) fileInput.addEventListener('change', function () { handleFile(fileInput.files[0]); });
  if (drop) {
    ['dragenter', 'dragover'].forEach(function (t) {
      drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add('is-over'); });
    });
    ['dragleave', 'drop'].forEach(function (t) {
      drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.remove('is-over'); });
    });
    drop.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files) handleFile(e.dataTransfer.files[0]);
    });
  }

  /* =======================================================================
     8. Analysis entry point
     ======================================================================= */
  function startAnalysis(source, sw, sh, mirror) {
    go('analyze');
    var status = $('#analyzeStatus');
    setStatus(status, 'מכינה את התמונה…');

    ensureEngine(status).then(function () {
      setStatus(status, 'מזהה את מבנה הפנים…');
      S.work = makeWork(source, sw, sh, mirror);
      sizeExact(outCanvas, S.work.w, S.work.h);
      sizeCrisp(overlay, S.work.w, S.work.h);
      sizeExact(cmpBefore, S.work.w, S.work.h);
      sizeExact(cmpAfter, S.work.w, S.work.h);
      var cmp = $('#resultCompare');
      if (cmp) cmp.style.aspectRatio = S.work.w + ' / ' + S.work.h;
      if (faceStage) faceStage.style.aspectRatio = S.work.w + ' / ' + S.work.h;

      S.base = S.work.ctx.getImageData(0, 0, S.work.w, S.work.h);

      return new Promise(function (resolve) {
        setTimeout(function () { resolve(analyse()); }, 30);
      });
    }).then(function (gate) {
      S.gate = gate;
      if (!gate.ok) { showRejection(gate); return; }
      S.active = [];
      buildAllMasks();     // once per detection; slider moves reuse them
      syncToggles();
      render();
      go('explore');
    }).catch(function (err) {
      var code = err && err.code;
      var list = $('#rejectList');
      if (list) list.innerHTML = '<li>' + (ENGINE_ERRORS[code] || ENGINE_ERRORS.engine_error) + '</li>';
      var dbg = $('#rejectDebug');
      if (dbg) { dbg.hidden = !DEBUG; if (DEBUG) dbg.textContent = String(err && err.message || err); }
      go('reject');
    });
  }

  /* =======================================================================
     9. Camera with live guidance
     ======================================================================= */
  var camVideo = $('#camVideo');
  var camOverlay = $('#camOverlay');
  var camCtx = camOverlay ? camOverlay.getContext('2d') : null;
  var camCapture = document.createElement('canvas');
  var camCapCtx = camCapture.getContext('2d', { willReadFrequently: true });

  var HINTS = {
    none:      'מחפשת פנים…',
    many:      'יש יותר מאדם אחד בתמונה',
    closer:    'להתקרב מעט',
    back:      'להתרחק מעט',
    left:      'להזיז את הראש קצת שמאלה ←',
    right:     'להזיז את הראש קצת ימינה →',
    straight:  'להביט ישר למצלמה',
    level:     'ליישר את הראש',
    centre:    'למרכז את הפנים במסגרת',
    ready:     'מושלם ✓'
  };

  function openCamera() {
    var status = $('#camStatus');
    setStatus(status, 'מבקשת הרשאה למצלמה…');
    go('camera');

    ensureEngine(status)
      .then(function () { return window.AmiraFaceMesh.loadVideo(); })
      .then(function () {
        return navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 1280 } },
          audio: false
        });
      })
      .then(function (stream) {
        S.stream = stream;
        camVideo.srcObject = stream;
        camVideo.play();
        setStatus(status, '');
        S.camReady = 0;
        camLoop();
      })
      .catch(function (err) {
        var code = err && err.code;
        setStatus(status, ENGINE_ERRORS[code] ||
          'לא הצלחנו לפתוח את המצלמה. אפשר להעלות תמונה מהגלריה במקום.');
      });
  }

  function stopCamera() {
    if (S.rafId) cancelAnimationFrame(S.rafId);
    S.rafId = 0;
    if (S.stream) {
      S.stream.getTracks().forEach(function (t) { t.stop(); });
      S.stream = null;
    }
    if (camVideo) camVideo.srcObject = null;
  }

  function camLoop() {
    S.rafId = requestAnimationFrame(camLoop);
    if (!camVideo || camVideo.readyState < 2) return;

    var vw = camVideo.videoWidth, vh = camVideo.videoHeight;
    if (!vw || !vh) return;

    /* Mirror here, once. The captured pixels are what gets analysed, so the
       overlay, the guidance and the final photo all share one geometry. */
    var scale = Math.min(1, 640 / Math.max(vw, vh));
    var cw = Math.round(vw * scale), ch = Math.round(vh * scale);
    if (camCapture.width !== cw) { camCapture.width = cw; camCapture.height = ch; }
    camCapCtx.save();
    camCapCtx.translate(cw, 0); camCapCtx.scale(-1, 1);
    camCapCtx.drawImage(camVideo, 0, 0, cw, ch);
    camCapCtx.restore();

    var res;
    try { res = window.AmiraFaceMesh.detectVideo(camCapture, performance.now()); }
    catch (e) { return; }

    var gate = window.AmiraFaceMesh.assess(res, { w: cw, h: ch });
    var hint = HINTS.none, ok = false, pts = null;

    if (gate.metrics.faces > 1) hint = HINTS.many;
    else if (gate.metrics.faces === 1) {
      pts = gate.landmarks;
      var frame = window.AmiraFaceRegions.buildFrame(pts, S.sets, cw / ch);
      window.AmiraFaceMesh.assessFrame(frame, { w: cw, h: ch }, gate.problems, gate.metrics);
      gate.ok = gate.problems.length === 0;

      var byCode = {};
      gate.problems.forEach(function (p) { byCode[p.code] = p; });

      if (byCode.cropped) hint = HINTS.back;
      else if (byCode.too_small || byCode.low_detail) hint = HINTS.closer;
      else if (byCode.roll) hint = HINTS.level;
      /* Rotation gets "look straight", never a left/right arrow: the preview
         is mirrored, so a rotation arrow is genuinely ambiguous to the viewer.
         Arrows are reserved for POSITION, where a mirrored view is intuitive. */
      else if (byCode.turned || byCode.off_axis) hint = HINTS.straight;
      else if (gate.ok) {
        var box = window.AmiraFaceMesh.bboxOf(pts);
        var cxn = (box.x0 + box.x1) / 2, cyn = (box.y0 + box.y1) / 2;
        if (Math.abs(cxn - 0.5) > 0.12) hint = cxn < 0.5 ? HINTS.right : HINTS.left;
        else if (Math.abs(cyn - 0.48) > 0.14) hint = HINTS.centre;
        else { hint = HINTS.ready; ok = true; }
      }
    }

    S.camReady = ok ? S.camReady + 1 : 0;
    var stable = S.camReady >= 5;      // ~5 frames, so it cannot flicker green

    var hintEl = $('#camHint');
    if (hintEl) {
      hintEl.textContent = stable ? HINTS.ready : hint;
      hintEl.classList.toggle('is-ready', stable);
    }
    var shutter = $('#camShutter');
    if (shutter) shutter.disabled = !stable;

    drawCamOverlay(cw, ch, pts, stable);
  }

  function drawCamOverlay(cw, ch, pts, ready) {
    if (!camCtx) return;
    if (camOverlay.width !== cw) { camOverlay.width = cw; camOverlay.height = ch; }
    camOverlay.style.aspectRatio = cw + ' / ' + ch;
    camCtx.clearRect(0, 0, cw, ch);

    /* Target frame the visitor should fill. Guidance only — it is never used
       to position anything, unlike the old fixed oval. */
    camCtx.strokeStyle = ready ? 'rgba(120,200,150,0.95)' : 'rgba(255,255,255,0.75)';
    camCtx.lineWidth = Math.max(2, cw * 0.006);
    camCtx.setLineDash([cw * 0.03, cw * 0.025]);
    camCtx.beginPath();
    camCtx.ellipse(cw * 0.5, ch * 0.47, cw * 0.30, ch * 0.38, 0, 0, Math.PI * 2);
    camCtx.stroke();
    camCtx.setLineDash([]);

    if (pts) {
      camCtx.fillStyle = ready ? 'rgba(120,200,150,0.85)' : 'rgba(255,255,255,0.5)';
      for (var i = 0; i < pts.length; i += 3) {
        camCtx.fillRect(pts[i].x * cw - 1, pts[i].y * ch - 1, 2, 2);
      }
    }
  }

  var btnCamera = $('#btnCamera');
  if (btnCamera) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) btnCamera.hidden = true;
    else btnCamera.addEventListener('click', openCamera);
  }
  var camCancel = $('#camCancel');
  if (camCancel) camCancel.addEventListener('click', function () { stopCamera(); go('start'); });

  var camShutter = $('#camShutter');
  if (camShutter) {
    camShutter.addEventListener('click', function () {
      if (camShutter.disabled) return;
      var vw = camVideo.videoWidth, vh = camVideo.videoHeight;
      var full = document.createElement('canvas');
      full.width = vw; full.height = vh;
      var fx = full.getContext('2d');
      fx.translate(vw, 0); fx.scale(-1, 1);          // same mirroring as the loop
      fx.drawImage(camVideo, 0, 0, vw, vh);
      stopCamera();
      startAnalysis(full, vw, vh, false);            // already mirrored
    });
  }

  /* =======================================================================
     10. Consent gate -> preview
     ======================================================================= */
  var toResult = $('#toResult');
  if (toResult) {
    toResult.addEventListener('click', function () {
      if (!S.active.length) return;
      if (S.consented) { runPreview(); return; }
      if (window.AmiraSheet) window.AmiraSheet.open(consentSheet);
    });
  }

  var consentCheck = $('#consentCheck');
  var consentGo = $('#consentGo');
  if (consentCheck && consentGo) {
    consentCheck.addEventListener('change', function () { consentGo.disabled = !consentCheck.checked; });
    consentGo.addEventListener('click', function () {
      S.consented = true;
      if (window.AmiraSheet) window.AmiraSheet.close(consentSheet);
      runPreview();
    });

    /* Cancelling clears the tick. Re-opening the gate then asks again instead
       of arriving pre-accepted from an attempt the visitor backed out of. */
    var clearConsent = function () {
      if (S.consented) return;
      consentCheck.checked = false;
      consentGo.disabled = true;
    };
    $$('.sheet__scrim, .sheet__close, [data-sheet-close]', consentSheet)
      .forEach(function (el) { el.addEventListener('click', clearConsent); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') clearConsent();
    });
  }

  function runPreview() {
    go('result');
    var wait = $('#resultWait'), view = $('#resultView');
    if (wait) wait.hidden = false;
    if (view) view.hidden = true;
    setTimeout(function () {
      render();
      if (wait) wait.hidden = true;
      if (view) view.hidden = false;
      var cmp = $('#resultCompare');
      if (cmp && window.AmiraSite) window.AmiraSite.bindCompare(cmp);
    }, 40);
  }

  $$('[data-goto]').forEach(function (b) {
    b.addEventListener('click', function () {
      if (b.dataset.goto !== 'camera') stopCamera();
      go(b.dataset.goto);
    });
  });

  var rejectRetry = $('#rejectRetry');
  if (rejectRetry) rejectRetry.addEventListener('click', function () { reset(); });

  /* =======================================================================
     11. Download / hand-off / reset
     ======================================================================= */
  var dl = $('#mirrorDownload');
  if (dl) {
    dl.addEventListener('click', function () {
      var w = S.work.w, h = S.work.h;
      var pad = 28, capH = 150;
      var c = document.createElement('canvas');
      c.width = w * 2 + pad * 3;
      c.height = h + pad * 2 + capH;
      var x = c.getContext('2d');

      x.fillStyle = '#F7F5F2';
      x.fillRect(0, 0, c.width, c.height);
      x.drawImage(cmpBefore, pad, pad, w, h);
      x.drawImage(cmpAfter, pad * 2 + w, pad, w, h);

      [['ORIGINAL', pad + 14], ['AI VISUAL SIMULATION', pad * 2 + w + 14]].forEach(function (t) {
        x.font = '500 22px Georgia, serif';
        var tw = x.measureText(t[0]).width + 26;
        x.fillStyle = 'rgba(73,58,67,.78)';
        x.beginPath();
        if (x.roundRect) x.roundRect(t[1], pad + 14, tw, 40, 20); else x.rect(t[1], pad + 14, tw, 40);
        x.fill();
        x.fillStyle = '#fff';
        x.fillText(t[0], t[1] + 13, pad + 41);
      });

      var y = h + pad * 2 + 16;
      x.fillStyle = '#493A43';
      x.font = '500 26px Georgia, serif';
      x.fillText('Dr. Amira Dabbagha · Medical Aesthetics', pad, y);
      x.fillStyle = '#645954';
      x.font = '19px Arial, sans-serif';
      x.direction = 'rtl';
      x.textAlign = 'right';
      [
        'ההדמיה היא המחשה משוערת בלבד. היא אינה חוזה את תוצאת הטיפול',
        'ואינה קובעת את סוג הטיפול או כמות החומר. התוצאה בפועל נקבעת בהתאם',
        'לאנטומיה, לחומר, לטכניקת הטיפול ולבדיקה רפואית של ד״ר אמירה.'
      ].forEach(function (l, i) { x.fillText(l, c.width - pad, y + 30 + i * 27); });

      c.toBlob(function (blob) {
        window.__amiraSaveImage
          ? window.__amiraSaveImage(blob, 'amira-ai-mirror-preview.jpg')
          : (function () {
              var a = document.createElement('a');
              a.href = URL.createObjectURL(blob);
              a.download = 'amira-ai-mirror-preview.jpg';
              document.body.appendChild(a); a.click(); a.remove();
              setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
            })();
      }, 'image/jpeg', 0.92);
    });
  }

  var discuss = $('#mirrorDiscuss');
  if (discuss) {
    discuss.addEventListener('click', function () {
      try {
        sessionStorage.setItem('amira.mirror.handoff', JSON.stringify({
          keys: S.active,
          regions: S.active.map(function (k) { var d = defOf(k); return d ? d.he : k; }),
          level: S.volumeMode ? S.volumeMl + ' ml (תרחיש)' : intensityLabel(S.intensity)
        }));
      } catch (e) { /* private mode: the flow still works, just without prefill */ }
    });
  }

  function reset() {
    stopCamera();
    S.work = null; S.base = null; S.landmarks = null; S.frame = null;
    S.regions = null; S.gate = null; S.active = []; S.consented = false;
    S.intensity = 0.35; S.volumeMode = false; S.volumeMl = 1;
    if (fileInput) fileInput.value = '';
    if (intensityRange) intensityRange.value = 35;
    var io = $('#intensityOut'); if (io) io.textContent = intensityLabel(0.35);
    if (volumeRange) volumeRange.value = String(VOLUMES.indexOf(1));
    var vo = $('#volumeOut'); if (vo) vo.textContent = '1 ml';
    syncVolumeMode();
    [octx, bctx, fctx].forEach(function (c) { if (c) c.clearRect(0, 0, 4000, 4000); });
    if (vctx) vctx.clearRect(0, 0, 4000, 4000);
    syncToggles();
    go('start');
  }
  var resetBtn = $('#mirrorReset');
  if (resetBtn) resetBtn.addEventListener('click', reset);

  /* Nothing is persisted; drop the pixels when the visitor leaves. */
  window.addEventListener('pagehide', function () {
    stopCamera();
    S.work = null; S.base = null; S.landmarks = null;
    [octx, bctx, fctx, vctx].forEach(function (c) { if (c) c.clearRect(0, 0, 4000, 4000); });
  });

  /* --------------------------------------------------------------- startup */
  if (DEBUG) studio.classList.add('is-debug');
  buildRegionList();
  syncToggles();
  syncVolumeMode();
  var io0 = $('#intensityOut');
  if (io0) io0.textContent = intensityLabel(S.intensity);

  window.AmiraMirror = { state: S, render: render, reset: reset, analyse: analyse, go: go };
})();
