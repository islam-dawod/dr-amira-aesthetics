/* ==========================================================================
   AMEERA DABAJA — AI Visual Simulation
   Natural. Anatomical. Product-aware.
   --------------------------------------------------------------------------
   PRIVACY BY ARCHITECTURE. The photo never leaves the device. No fetch, no
   upload, no third-party model call — the detection engine is vendored locally.
   Everything runs on canvases here and is discarded on page unload.

   ONE COORDINATE SYSTEM. A single work canvas; landmarks normalised to it;
   overlays carry exactly its aspect ratio and never meet object-fit. Selfie
   mirroring is resolved once, at capture, so nothing downstream needs to know
   a camera was involved and the mirror state cannot disagree with the mapping.

   NO MASKS. Deformation is a 3D mesh warp (see face-warp.js): vertices move
   along surface normals, reproject through a weak-perspective camera, and the
   original pixels are resampled triangle by triangle. There is no region
   boundary to see, and the texture is carried rather than averaged.

   FAIL CLOSED, TWICE. Once on the photo (pose, framing, resolution), once on
   the simulation itself (mesh folds, displacement ceiling, identity drift,
   background movement, texture loss). Either refusal means no preview at all.
   ========================================================================== */
(function () {
  'use strict';

  var $  = function (s, c) { return (c || document).querySelector(s); };
  var $$ = function (s, c) { return Array.prototype.slice.call((c || document).querySelectorAll(s)); };

  var studio = $('#studio');
  if (!studio) return;

  var WORK_MAX = 1100;
  var DEBUG = /[?&]debugFace=1/.test(location.search);
  var CLINICIAN = /[?&]clinician=1/.test(location.search);

  /* ONE control per area: the amount.
     There used to be a presentation-level multiplier as well, which meant two
     parameters scaled the same effect and the same preview could be reached two
     ways. The amount now carries it alone, through a per-region dose-response
     curve (face-regions.js), so a given millilitre value means one thing. */
  var DOSE_STEPS = null;      // filled from the catalogue once it is loaded

  /* ------------------------------------------------------------- products
     The neutral profile is the only one shipped. The branded table is
     deliberately EMPTY: those multipliers would be physical claims about named
     prescription medical devices, and inventing them would mean fabricating
     manufacturer data. Populate from IFU figures, then it enables itself. */
  var NEUTRAL = {
    id: 'neutral', brand: '', name: 'פרופיל נייטרלי', family: 'HA',
    profile: { projection: 1, spread: 1, firmness: null }, source: 'neutral default'
  };
  var BRANDED = [];
  var PRODUCTS_READY = BRANDED.length > 0;

  /* ------------------------------------------------------------------ state */
  var S = {
    work: null, base: null, baseData: null,
    landmarks: null, frame: null, regions: null, mesh: null,
    sets: null, gate: null, calib: null,
    active: [], amounts: {}, sides: {},
    product: NEUTRAL,
    consented: false, stream: null, rafId: 0, camReady: 0,
    lastAudit: null
  };

  /* -------------------------------------------------------------------- DOM */
  var panels = {
    start: $('#panelStart'), camera: $('#panelCamera'), analyze: $('#panelAnalyze'),
    reject: $('#panelReject'), explore: $('#panelExplore'), result: $('#panelResult')
  };
  var stepper    = $$('#studioStepper li');
  var faceStage  = $('#faceStage');
  var outCanvas  = $('#outCanvas');
  var overlay    = $('#overlayCanvas');
  var cmpBefore  = $('#cmpBefore');
  var cmpAfter   = $('#cmpAfter');
  var regionList = $('#regionList');
  var consentSheet = $('#consentSheet');

  var octx = outCanvas.getContext('2d', { willReadFrequently: true });
  var vctx = overlay.getContext('2d');
  var bctx = cmpBefore.getContext('2d');
  var fctx = cmpAfter.getContext('2d', { willReadFrequently: true });

  function go(name) {
    Object.keys(panels).forEach(function (k) {
      if (panels[k]) panels[k].classList.toggle('is-active', k === name);
    });
    var order = { start: 0, camera: 0, analyze: 1, reject: 1, explore: 2, result: 3 };
    stepper.forEach(function (li, n) {
      if (n === order[name]) li.setAttribute('aria-current', 'step');
      else li.removeAttribute('aria-current');
    });
    var head = $('.studio__head', studio);
    if (head) head.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  function setStatus(el, t) { if (el) el.textContent = t; }

  /* =======================================================================
     Work canvas
     ======================================================================= */
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
  /* putImageData ignores the transform, so pixel canvases stay 1:1 with the
     work canvas and CSS does the scaling. */
  function sizeExact(c, w, h) { c.width = w; c.height = h; c.style.aspectRatio = w + ' / ' + h; }
  function sizeCrisp(c, w, h) {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    c.style.aspectRatio = w + ' / ' + h;
  }

  /* =======================================================================
     Engine
     ======================================================================= */
  var ENGINE_STEPS = {
    engine: 'טוענת את מנוע זיהוי הפנים…',
    wasm:   'מכינה את המנוע במכשיר שלך…',
    model:  'טוענת את מודל 478 הנקודות…',
    ready:  'המנוע מוכן.'
  };
  var ENGINE_ERRORS = {
    engine_unavailable: 'מנוע זיהוי הפנים אינו זמין בגרסה הזו של העמוד.',
    no_simd: 'הדפדפן הזה אינו תומך בטכנולוגיה הנדרשת (WebAssembly SIMD). נסי דפדפן מעודכן.',
    no_sets: 'המנוע נטען אך לא הצלחנו לקרוא את מפת הנקודות.',
    engine_error: 'לא הצלחנו לטעון את מנוע זיהוי הפנים.'
  };

  function ensureEngine(statusEl) {
    setStatus(statusEl, ENGINE_STEPS.engine);
    return window.AmiraFaceMesh.load({
      vendorBase: studio.dataset.vendorBase || 'assets/vendor/mediapipe',
      onProgress: function (s) { setStatus(statusEl, ENGINE_STEPS[s] || ''); }
    }).then(function (lib) {
      S.sets = window.AmiraFaceRegions.buildSets(lib.FaceLandmarker);
      if (!S.sets) throw { code: 'no_sets' };
      return lib;
    });
  }

  /* =======================================================================
     Analysis, calibration and the photo gate
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
    too_close:      'הפנים קרובות מדי לעדשה. כדאי להתרחק מעט מהמצלמה — ממרחק קצר '
                  + 'העדשה מגדילה את האף ואת הלחי הקרובה, ואיננו יכולות להפריד '
                  + 'בין העיוות הזה לבין מבנה הפנים עצמו.',
    expression:     'יש הבעה פעילה בפנים — חיוך, כיווץ או פה פתוח. '
                  + 'נדרשת הבעה רגועה וניטרלית, אחרת ההדמיה תציג את ההבעה '
                  + 'ולא את השינוי.',
    blurred:        'התמונה מטושטשת מדי באזור הפנים.',
    exposure:       'חלק מהפנים שרוף או כבוי לגמרי בתמונה.',
    too_dark:       'התמונה כהה מדי באזור הפנים.',
    too_bright:     'התמונה בהירה מדי באזור הפנים.',
    cropped:        'הפנים חתוכות בקצה התמונה. נדרשות פנים שלמות, כולל סנטר ומצח.',
    no_frame:       'לא הצלחנו למפות את מבנה הפנים בצורה אמינה.',
    low_detail:     'התמונה ברזולוציה נמוכה מדי לאזור הפנים.',
    no_mesh:        'לא הצלחנו לבנות את מודל הפנים התלת־ממדי.',
    /* simulation-side refusals */
    mesh_fold:      'ההדמיה יצרה עיוות לא תקין במודל הפנים.',
    displacement:   'השינוי המבוקש גדול מדי להדמיה אמינה.',
    anchor_moved:   'ההדמיה חרגה מאזור הפנים.',
    identity_eyes:  'ההדמיה הזיזה את אזור העיניים.',
    identity_nose:  'ההדמיה הזיזה את אזור האף.',
    identity_brows: 'ההדמיה הזיזה את אזור הגבות.',
    background_changed: 'ההדמיה שינתה את הרקע.',
    texture_lost:   'ההדמיה פגעה במרקם העור.',
    leaked_outside_region: 'ההדמיה השפיעה מחוץ לאזור שנבחר.',
    disturbed_other_region: 'ההדמיה השפיעה על אזור אחר בפנים שלא נבחר.'
  };

  /**
   * Face calibration. Every figure comes from the detected landmarks and is
   * expressed in millimetres through the scenario interocular scale, so it is
   * comparable between photos instead of being a pixel count. The asterisk in
   * the UI marks that the scale is assumed, not measured on the visitor.
   */
  function calibrate(frame, size) {
    var a = frame.anchors;
    var iodPx = frame.scale * size.w;
    var mm = function (u) { return +(u * window.AmiraFaceWarp.IOD_MM).toFixed(1); };
    var wEye = frame.widthAt(0);
    var wMouth = frame.widthAt(a.vMouth);
    return {
      interocularPx: Math.round(iodPx),
      faceWidth: wEye ? mm(Math.abs(wEye.hi - wEye.lo)) : null,
      faceHeight: mm(a.vChin - a.vTop),
      lipWidth: mm(a.uMouthR - a.uMouthL),
      lipHeight: mm(a.vMouthBottom - a.vMouthTop),
      chinProjection: mm(a.vChin - a.vMouthBottom),
      midfaceWidth: wMouth ? mm(Math.abs(wMouth.hi - wMouth.lo)) : null,
      symmetry: frame.asymmetry != null ? +(1 - frame.asymmetry).toFixed(3) : null,
      rollDeg: null, offAxisDeg: null
    };
  }

  function analyse() {
    S.landmarks = null; S.frame = null; S.regions = null; S.mesh = null; S.calib = null;

    var result;
    try { result = window.AmiraFaceMesh.detectImage(S.work.canvas); }
    catch (e) { return { ok: false, problems: [{ code: 'engine_error' }], metrics: {} }; }

    var size = { w: S.work.w, h: S.work.h };
    var gate = window.AmiraFaceMesh.assess(result, size);
    if (!gate.ok && gate.problems.some(function (p) {
      return p.code === 'no_face' || p.code === 'multiple_faces';
    })) return gate;

    var frame = window.AmiraFaceRegions.buildFrame(gate.landmarks, S.sets, S.work.w / S.work.h);
    window.AmiraFaceMesh.assessFrame(frame, size, gate.problems, gate.metrics);
    /* Sharpness and exposure, measured over the face only. Runs here rather
       than in assess() because it needs the pixels, and assess() is also used
       on the live camera frame where a per-frame Laplacian would be wasted
       work. */
    if (S.baseData && gate.landmarks) {
      var fb = { x0: 1, y0: 1, x1: 0, y1: 0 };
      gate.landmarks.forEach(function (p) {
        if (p.x < fb.x0) fb.x0 = p.x;
        if (p.y < fb.y0) fb.y0 = p.y;
        if (p.x > fb.x1) fb.x1 = p.x;
        if (p.y > fb.y1) fb.y1 = p.y;
      });
      window.AmiraFaceMesh.assessImage(S.baseData, S.work.w, S.work.h, fb,
                                       gate.problems, gate.metrics);
    }
    gate.ok = gate.problems.length === 0;
    if (!gate.ok) return gate;

    var regions = window.AmiraFaceRegions.build(frame);
    /* Eyes, brows and the nose line are guarded: the deformation field is
       attenuated to zero around them so identity cannot drift. */
    var guard = (S.sets.eyeA || []).concat(S.sets.eyeB || [],
                                          S.sets.browA || [], S.sets.browB || [],
                                          [1, 4, 5, 6, 195, 197]);
    var mesh = window.AmiraFaceWarp.buildMesh(gate.landmarks, frame, S.work.w, S.work.h, guard);
    if (!regions || !mesh) {
      gate.ok = false;
      gate.problems.push({ code: 'no_mesh' });
      return gate;
    }

    S.landmarks = gate.landmarks;
    S.frame = frame;
    S.regions = regions;
    S.mesh = mesh;
    S.calib = calibrate(frame, size);
    S.calib.rollDeg = gate.metrics.rollDeg;
    S.calib.offAxisDeg = gate.metrics.offAxisDeg;
    return gate;
  }

  function listProblems(el, problems) {
    if (!el) return;
    var seen = {};
    el.innerHTML = (problems || []).filter(function (p) {
      if (seen[p.code]) return false; seen[p.code] = 1; return true;
    }).map(function (p) {
      return '<li>' + (PROBLEM_TEXT[p.code] || p.message || p.code) + '</li>';
    }).join('');
  }

  function showRejection(problems, metrics) {
    listProblems($('#rejectList'), problems);
    var dbg = $('#rejectDebug');
    if (dbg) { dbg.hidden = !DEBUG; if (DEBUG) dbg.textContent = JSON.stringify(metrics || {}, null, 1); }
    go('reject');
  }

  /* =======================================================================
     Plan: area + product + amount
     ======================================================================= */
  function defOf(key) {
    var c = window.AmiraFaceRegions.CATALOGUE;
    for (var i = 0; i < c.length; i++) if (c[i].key === key) return c[i];
    return null;
  }

  /**
   * Turns the chosen amounts into a plan.
   *
   * Amount -> millimetres of surface projection runs through a NON-LINEAR
   * dose-response curve per region, not a multiplication of one generic
   * effect. Tissue does not respond linearly, and a linear map is also what
   * made consecutive amounts hard to tell apart.
   */
  function buildPlan(opts) {
    opts = opts || {};
    var R = window.AmiraFaceRegions;
    var plan = [];
    S.active.forEach(function (key) {
      var def = defOf(key);
      if (!def || def.op !== 'volume') return;
      var ml = opts.ml != null ? opts.ml : (S.amounts[key] != null ? S.amounts[key] : 0.5);
      var factor = R.doseFactor(ml, def.dose);
      plan.push({
        regionKey: key,
        ml: ml,
        factor: +factor.toFixed(4),
        mm: factor * (def.mmMax || 3),
        side: opts.side || S.sides[key] || 'both',
        profile: S.product.profile
      });
    });
    return plan;
  }

  function softenDefs() {
    return S.active.map(defOf).filter(function (d) { return d && d.op === 'soften'; });
  }

  /* =======================================================================
     Expression-area softening — analytic field, no mask
     ======================================================================= */
  function applySoften(ctx, defs) {
    if (!defs.length) return;
    var mesh0 = S.mesh;
    var W = S.work.w, H = S.work.h;
    var img = ctx.getImageData(0, 0, W, H);
    var out = img.data;
    var src = new Uint8ClampedArray(out);
    var f = S.frame;
    var iodPx = f.scale * W;
    var warp = window.AmiraFaceWarp;

    defs.forEach(function (def) {
      var region = S.regions[def.key];
      if (!region) return;
      var coreF = def.coreFalloff || 0.18;
      var edgeF = def.edgeFalloff || coreF;
      var pad = (coreF + edgeF) * iodPx * 1.3;
      var x0 = W, y0 = H, x1 = 0, y1 = 0;
      region.parts.forEach(function (p) {
        p.image.forEach(function (q) {
          x0 = Math.min(x0, q.x * W); x1 = Math.max(x1, q.x * W);
          y0 = Math.min(y0, q.y * H); y1 = Math.max(y1, q.y * H);
        });
      });
      x0 = Math.max(0, Math.floor(x0 - pad)); x1 = Math.min(W - 1, Math.ceil(x1 + pad));
      y0 = Math.max(0, Math.floor(y0 - pad)); y1 = Math.min(H - 1, Math.ceil(y1 + pad));

      var rad = Math.max(1, Math.round(iodPx * 0.030));
      /* Capped: this is line softening, not skin smoothing. The texture audit
         rejects the result if detail collapses anyway. */
      var maxBlend = 0.42 * (def.soften || 1);

      for (var y = y0; y <= y1; y++) {
        for (var x = x0; x <= x1; x++) {
          var local = f.toLocal({ x: (x / W) * f.aspect, y: y / H });
          /* Same territory lock as the volume path, so softening cannot creep
             onto the brows or the eyes either. */
          var w = 0;
          for (var pi = 0; pi < region.parts.length; pi++) {
            var prt = region.parts[pi];
            var wp = warp.regionWeight(local, [prt.local], coreF, prt.territory, edgeF);
            if (wp > w) w = wp;
          }
          if (mesh0 && mesh0.protect) { /* protection is per-vertex, not per-pixel */ }
          if (w <= 0.004) continue;
          var alpha = maxBlend * w;

          var i = (y * W + x) << 2;
          var sr = 0, sg = 0, sb = 0, n = 0;
          var ay0 = Math.max(0, y - rad), ay1 = Math.min(H - 1, y + rad);
          var ax0 = Math.max(0, x - rad), ax1 = Math.min(W - 1, x + rad);
          for (var yy = ay0; yy <= ay1; yy += 2) {
            for (var xx = ax0; xx <= ax1; xx += 2) {
              var j = (yy * W + xx) << 2;
              sr += src[j]; sg += src[j + 1]; sb += src[j + 2]; n++;
            }
          }
          if (!n) continue;
          out[i]     = src[i]     + (sr / n - src[i])     * alpha;
          out[i + 1] = src[i + 1] + (sg / n - src[i + 1]) * alpha;
          out[i + 2] = src[i + 2] + (sb / n - src[i + 2]) * alpha;
        }
      }
    });
    ctx.putImageData(img, 0, 0);
  }

  /* =======================================================================
     Simulate — the one path that produces every preview
     ======================================================================= */
  function simulate(targetCtx, opts) {
    opts = opts || {};
    var warp = window.AmiraFaceWarp;
    var plan = buildPlan(opts);
    var softens = softenDefs();
    var audit = { ok: true, problems: [], metrics: {} };

    if (plan.length) {
      var detail = {};
      var dst = warp.deform(S.mesh, S.regions, plan, detail);
      audit = warp.audit(S.mesh, dst, S.regions, plan);
      if (!audit.ok) return { ok: false, audit: audit };
      warp.render(S.work.canvas, targetCtx, S.mesh, dst);

      /* Volume that projects toward the camera cannot appear as pixel motion -
         only 14-50% of the planned projection did. What makes it read as volume
         is the light meeting the raised surface at a new angle, so we draw that
         too: the shading function is fitted to THIS photograph, re-evaluated on
         the deformed normals, and masked by the same weight field that moved
         the mesh. If the photograph does not support the fit, we shade nothing
         and say so rather than paint a highlight it contradicts. */
      if (S.lighting === undefined) {
        S.lighting = warp.estimateLighting(S.baseData, S.mesh, S.work.w, S.work.h);
      }
      audit.metrics.lightFit = S.lighting && S.lighting.ok
        ? 'r2 ' + S.lighting.r2
        : 'unavailable (' + ((S.lighting && S.lighting.reason) || 'none') + ')';
      if (S.lighting && S.lighting.ok) {
        var nDef = warp.normalsFrom(S.mesh, detail.camera);
        var ratios = warp.shadeRatios(S.mesh, S.mesh.normals, nDef,
                                      S.lighting, detail.weight);
        audit.metrics.shadedPx = warp.applyShading(targetCtx, S.mesh, dst, ratios,
                                                   S.work.w, S.work.h);
      }
    } else {
      targetCtx.setTransform(1, 0, 0, 1, 0, 0);
      targetCtx.clearRect(0, 0, S.work.w, S.work.h);
      targetCtx.drawImage(S.work.canvas, 0, 0);
    }

    if (softens.length) applySoften(targetCtx, softens);

    var outData = targetCtx.getImageData(0, 0, S.work.w, S.work.h).data;
    var px = warp.auditPixels(S.baseData, outData, S.mesh, S.work.w, S.work.h);
    if (!px.ok) { audit.ok = false; audit.problems = audit.problems.concat(px.problems); }
    Object.keys(px.metrics).forEach(function (k) { audit.metrics[k] = px.metrics[k]; });

    /* Where did the change actually land? Runs for softening-only plans too. */
    if (plan.length || softens.length) {
      var softKeys = softens.map(function (d) { return d.key; });
      var cont = warp.auditContainment(S.baseData, outData, S.mesh, S.regions, plan,
                                       S.work.w, S.work.h, audit.metrics.maxShiftPx || 0,
                                       softKeys);
      if (!cont.ok) { audit.ok = false; audit.problems = audit.problems.concat(cont.problems); }
      Object.keys(cont.metrics).forEach(function (k) { audit.metrics[k] = cont.metrics[k]; });
    }
    return { ok: audit.ok, audit: audit };
  }

  /**
   * Volume Difference Test — does the preview actually show the amount?
   *
   * The complaint that started this rebuild was that 1 ml and 2 ml looked too
   * similar, so "the amounts differ" is not something this engine gets to
   * assert. It has to be measured, per region, on the photograph in front of
   * us, and the answer has to be allowed to be no.
   *
   * The measure is deliberately self-normalising. For a pair of amounts (a, b)
   * the dose curve prescribes a difference of
   *
   *     expected = (f(b) - f(a)) / f(b)
   *
   * as a share of the whole effect at b. We render three frames - untreated, a,
   * and b - and compute the same share from the pixels:
   *
   *     shown = energy(a, b) / energy(untreated, b)
   *
   * `fidelity = shown / expected` is then 1.0 when the picture reproduces
   * exactly the difference the model asked for. Because both terms are measured
   * on the same photograph, the result does not depend on how much texture or
   * contrast that photograph happens to have - which an earlier absolute
   * pixel-count threshold did, badly enough to report a working engine as
   * broken on a flat test image.
   *
   * A pair passes when fidelity >= MIN_FIDELITY and the change covers at least
   * MIN_PIXELS. MIN_FIDELITY is 0.5 because below it the preview is
   * understating the visitor's choice of amount by more than half, which makes
   * the ladder of amounts misleading rather than merely subtle.
   *
   * Returns per-pair numbers, and a refused simulation counts as a gap, never
   * as a pass.
   */
  var MIN_FIDELITY = 0.5;
  var MIN_PIXELS = 400;

  function doseEnergy(a, b) {
    if (!a || !b) return null;
    var n = 0, sum = 0;
    for (var i = 0; i < a.length; i += 4) {
      var d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) +
              Math.abs(a[i + 2] - b[i + 2]);
      if (d > 9) { n++; sum += d; }     // above bilinear resampling noise
    }
    return { px: n, energy: sum };
  }

  /* One region at a time: composing several would let a big area's change hide
     a small area's failure to move. */
  function testRegionDoses(key, pairs) {
    var W = S.work.w, H = S.work.h;
    var scratch = document.createElement('canvas');
    scratch.width = W; scratch.height = H;
    var sctx = scratch.getContext('2d', { willReadFrequently: true });

    var savedActive = S.active.slice();
    var savedAmount = S.amounts[key];
    var savedSide = S.sides[key];
    S.active = [key];
    S.sides[key] = 'both';

    var cache = {};
    function frameAt(ml) {
      if (cache[ml] !== undefined) return cache[ml];
      S.amounts[key] = ml;
      var r = simulate(sctx, { ml: ml });
      cache[ml] = r.ok ? sctx.getImageData(0, 0, W, H).data : null;
      return cache[ml];
    }

    /* A dose of effectively zero, taken through the same code path, so the
       reference frame carries the same resampling as the ones it is compared
       against. */
    var untreated = frameAt(0.0001);
    var results = [];
    pairs.forEach(function (p) {
      var fa = frameAt(p[0]), fb = frameAt(p[1]);
      if (!fa || !fb) {
        results.push({ from: p[0], to: p[1], refused: true, separated: false });
        return;
      }
      var pair = doseEnergy(fa, fb), full = doseEnergy(untreated, fb);
      var expected = (doseFactorOf(p[1]) - doseFactorOf(p[0])) / (doseFactorOf(p[1]) || 1);
      var shown = full && full.energy ? pair.energy / full.energy : 0;
      var fidelity = expected > 0 ? shown / expected : 0;
      results.push({
        from: p[0], to: p[1],
        changedPx: pair.px,
        fidelity: +fidelity.toFixed(2),
        separated: fidelity >= MIN_FIDELITY && pair.px >= MIN_PIXELS
      });
    });

    S.active = savedActive;
    S.amounts[key] = savedAmount;
    S.sides[key] = savedSide;
    return results;
  }

  function doseFactorOf(ml) {
    return window.AmiraFaceRegions.doseFactor(ml);
  }

  /**
   * Runs the test over every volume region on the loaded photograph.
   *
   * `headline` is the pair the reviewer named explicitly: 1 ml against 2 ml.
   * If that pair fails for a region, the region's amounts are not honestly
   * distinguishable on this photo and the caller is expected to act on it
   * rather than show a ladder it cannot back.
   *
   * `resolution` reports the finest step that survives the same test, so the
   * interface can say what it actually resolves instead of implying that every
   * offered amount looks different from its neighbour.
   */
  function testDoseSeparation() {
    if (!S.mesh || !S.regions) return null;
    var perRegion = {}, failed = [], coarse = [];

    Object.keys(S.regions).forEach(function (key) {
      var def = S.regions[key].def;
      if (!def.volume) return;                 // softening areas carry no amount
      var res = testRegionDoses(key, [[1.0, 2.0], [0.5, 1.0], [1.0, 1.25]]);
      var headline = res[0], halfStep = res[1], quarterStep = res[2];
      var resolution = quarterStep.separated ? 0.25 : (halfStep.separated ? 0.5 : null);
      perRegion[key] = { headline: headline, halfStep: halfStep,
                         quarterStep: quarterStep, resolution: resolution };
      if (!headline.separated) failed.push(key);
      if (resolution === 0.5) coarse.push(key);
      if (resolution === null) failed.push(key);
    });

    return {
      ok: failed.length === 0,
      failed: failed,
      /* The honest headline for the interface: the finest amount difference the
         preview reliably shows on THIS photograph. */
      resolutionMl: Object.keys(perRegion).every(function (k) {
                      return perRegion[k].resolution === 0.25; }) ? 0.25 : 0.5,
      coarseRegions: coarse,
      perRegion: perRegion,
      thresholds: { fidelity: MIN_FIDELITY, pixels: MIN_PIXELS }
    };
  }

  var renderTimer = null;
  function scheduleRender() { clearTimeout(renderTimer); renderTimer = setTimeout(render, 90); }

  function render() {
    if (!S.mesh) return;
    var r = simulate(octx);
    S.lastAudit = r.audit;
    /* On a failed audit the working canvas is reset to the original, so a
       simulation that did not pass is never on screen. */
    if (!r.ok) {
      octx.setTransform(1, 0, 0, 1, 0, 0);
      octx.clearRect(0, 0, S.work.w, S.work.h);
      octx.drawImage(S.work.canvas, 0, 0);
    }
    paintOverlay();
    paintPlanSummary();
    paintQuality();
  }

  /* --------------------------------------------------- region highlights */
  var hoverKey = null;
  function pathPolygon(ctx, poly, w, h) {
    ctx.beginPath();
    for (var i = 0; i < poly.length; i++) {
      var x = poly[i].x * w, y = poly[i].y * h;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  function paintOverlay() {
    if (!overlay || !S.frame) return;
    var W = S.work.w, H = S.work.h;
    vctx.setTransform(overlay.width / W, 0, 0, overlay.height / H, 0, 0);
    vctx.clearRect(0, 0, W, H);
    var iod = S.frame.scale * W;

    /* Shown only while choosing. The result view carries no overlay at all, so
       the only line over the face there is the comparison handle. */
    window.AmiraFaceRegions.CATALOGUE.forEach(function (def) {
      var region = S.regions[def.key];
      if (!region) return;
      var on = S.active.indexOf(def.key) > -1;
      if (!on && def.key !== hoverKey) return;
      region.parts.forEach(function (part) {
        pathPolygon(vctx, part.image, W, H);
        vctx.fillStyle = on ? 'rgba(220,228,222,0.26)' : 'rgba(220,228,222,0.14)';
        vctx.fill();
        vctx.lineWidth = Math.max(1, iod * (on ? 0.014 : 0.010));
        vctx.strokeStyle = on ? 'rgba(73,58,67,0.50)' : 'rgba(73,58,67,0.28)';
        vctx.setLineDash(on ? [] : [iod * 0.06, iod * 0.05]);
        vctx.stroke();
        vctx.setLineDash([]);
      });
    });
    if (DEBUG) paintDebug();
  }

  function paintDebug() {
    var W = S.work.w, H = S.work.h, f = S.frame, iod = f.scale * W;
    vctx.fillStyle = 'rgba(255,255,255,0.7)';
    for (var i = 0; i < S.landmarks.length; i++) {
      var p = S.landmarks[i];
      vctx.fillRect(p.x * W - 0.6, p.y * H - 0.6, 1.4, 1.4);
    }
    vctx.strokeStyle = 'rgba(0,255,255,0.16)';
    vctx.lineWidth = Math.max(0.4, iod * 0.002);
    S.mesh.tris.forEach(function (t) {
      var a = S.mesh.verts[t[0]], b = S.mesh.verts[t[1]], c = S.mesh.verts[t[2]];
      vctx.beginPath(); vctx.moveTo(a.x, a.y); vctx.lineTo(b.x, b.y); vctx.lineTo(c.x, c.y);
      vctx.closePath(); vctx.stroke();
    });
    var box = window.AmiraFaceMesh.bboxOf(S.landmarks);
    vctx.strokeStyle = 'rgba(255,0,80,0.8)';
    vctx.lineWidth = Math.max(1, iod * 0.008);
    vctx.strokeRect(box.x0 * W, box.y0 * H, box.w * W, box.h * H);
    function line(a, b, col) {
      var p = f.toImage(a), q = f.toImage(b);
      vctx.strokeStyle = col; vctx.beginPath();
      vctx.moveTo(p.x * W, p.y * H); vctx.lineTo(q.x * W, q.y * H); vctx.stroke();
    }
    var A = f.anchors;
    line({ u: 0, v: A.vTop }, { u: 0, v: A.vChin }, 'rgba(0,180,255,0.85)');
    line({ u: -1.2, v: 0 }, { u: 1.2, v: 0 }, 'rgba(0,255,140,0.85)');
    line({ u: -1, v: A.vMouth }, { u: 1, v: A.vMouth }, 'rgba(255,210,0,0.8)');
    line({ u: -1, v: A.vNose }, { u: 1, v: A.vNose }, 'rgba(255,120,0,0.8)');

    var dbg = $('#debugReadout');
    if (dbg) {
      dbg.hidden = false;
      dbg.textContent = JSON.stringify({
        work: W + 'x' + H, triangles: S.mesh.tris.length,
        gate: S.gate && S.gate.metrics, calibration: S.calib,
        plan: buildPlan(),
        audit: S.lastAudit && {
          ok: S.lastAudit.ok, metrics: S.lastAudit.metrics,
          problems: (S.lastAudit.problems || []).map(function (p) { return p.code; })
        }
      }, null, 1);
    }
  }

  /* =======================================================================
     Region / amount / product controls
     ======================================================================= */
  function buildRegionList() {
    if (!regionList) return;
    regionList.innerHTML = window.AmiraFaceRegions.CATALOGUE.map(function (r) {
      var isVol = r.op === 'volume';
      return '<li>' +
        '<button type="button" class="region-toggle" data-region="' + r.key + '" aria-pressed="false">' +
          '<span class="region-toggle__dot" aria-hidden="true"></span>' +
          '<span class="region-toggle__txt">' +
            '<span class="region-toggle__en">' + r.en + '</span>' +
            '<span class="region-toggle__he">' + r.he + '</span>' +
          '</span>' +
          '<span class="region-toggle__kind">' + (isVol ? 'נפח / מילוי' : 'ריכוך קמטים') + '</span>' +
        '</button>' +
        (isVol
          ? '<div class="amount" data-amount-for="' + r.key + '" hidden>' +
              '<span class="amount__label">Amount</span>' +
              '<div class="dose" role="radiogroup" aria-label="Amount for ' + r.en + '">' +
                (DOSE_STEPS || []).map(function (ml) {
                  return '<label class="dose__opt">' +
                    '<input type="radio" name="dose-' + r.key + '" value="' + ml + '"' +
                      (ml === 0.5 ? ' checked' : '') + ' data-dose-for="' + r.key + '">' +
                    '<span>' + ml.toFixed(2).replace(/0$/, '') + '</span></label>';
                }).join('') +
              '</div>' +
              (r.sided
                ? '<div class="sides" role="radiogroup" aria-label="Side for ' + r.en + '">' +
                    ['both', 'left', 'right'].map(function (sd) {
                      var lbl = sd === 'both' ? 'Both' : (sd === 'left' ? 'Left' : 'Right');
                      return '<label class="sides__opt">' +
                        '<input type="radio" name="side-' + r.key + '" value="' + sd + '"' +
                          (sd === 'both' ? ' checked' : '') + ' data-side-for="' + r.key + '">' +
                        '<span>' + lbl + '</span></label>';
                    }).join('') +
                  '</div>'
                : '') +
              '<p class="micro amount__note">ml · Approximate visual simulation based on the ' +
                'selected amount and product.</p>' +
            '</div>'
          : '') +
        '</li>';
    }).join('');

    $$('.region-toggle', regionList).forEach(function (b) {
      b.addEventListener('click', function () { toggle(b.dataset.region); });
      b.addEventListener('mouseenter', function () { hoverKey = b.dataset.region; paintOverlay(); });
      b.addEventListener('mouseleave', function () { hoverKey = null; paintOverlay(); });
      b.addEventListener('focus', function () { hoverKey = b.dataset.region; paintOverlay(); });
      b.addEventListener('blur', function () { hoverKey = null; paintOverlay(); });
    });
    $$('[data-dose-for]', regionList).forEach(function (r) {
      r.addEventListener('change', function () {
        S.amounts[r.dataset.doseFor] = parseFloat(r.value);
        scheduleRender();
      });
    });
    $$('[data-side-for]', regionList).forEach(function (r) {
      r.addEventListener('change', function () {
        S.sides[r.dataset.sideFor] = r.value;
        scheduleRender();
      });
    });
  }

  function toggle(key) {
    var i = S.active.indexOf(key);
    if (i > -1) S.active.splice(i, 1);
    else {
      S.active.push(key);
      if (S.amounts[key] == null) S.amounts[key] = 0.5;
    }
    syncControls();
    scheduleRender();
  }

  function syncControls() {
    $$('[data-region]').forEach(function (el) {
      el.setAttribute('aria-pressed', S.active.indexOf(el.dataset.region) > -1 ? 'true' : 'false');
    });
    $$('[data-amount-for]').forEach(function (box) {
      box.hidden = S.active.indexOf(box.dataset.amountFor) < 0;
    });
    var anyVolume = S.active.some(function (k) { var d = defOf(k); return d && d.op === 'volume'; });
    var ps = $('#productStep');
    if (ps) ps.hidden = !anyVolume;
    var gen = $('#toResult');
    if (gen) gen.disabled = S.active.length === 0;
    var hint = $('#exploreHint');
    if (hint) hint.hidden = S.active.length > 0;
  }

  function paintPlanSummary() {
    var list = $('#appliedList');
    if (!list) return;
    var rows = S.active.map(function (k) {
      var d = defOf(k);
      if (!d) return '';
      if (d.op !== 'volume') {
        return '<li><span>' + d.he + '</span><span>ריכוך</span></li>';
      }
      var ml = (S.amounts[k] != null ? S.amounts[k] : 0.5);
      var sd = S.sides[k] || 'both';
      var sdTxt = sd === 'both' ? '' : (sd === 'left' ? ' · שמאל' : ' · ימין');
      return '<li><span>' + d.he + '</span><span>' + ml + ' ml' + sdTxt + '</span></li>';
    }).join('');
    var prod = '<li><span>מוצר</span><span>' +
      (S.product !== NEUTRAL ? S.product.brand + ' ' + S.product.name : 'פרופיל נייטרלי') + '</span></li>';
    list.innerHTML = (rows || '<li><span class="muted">לא נבחרו אזורים</span><span></span></li>') + prod;
  }

  /* ---------------------------------------------------- simulation quality */
  function grade(v, good, ok) {
    if (v == null) return { t: '—', c: 'na' };
    if (v >= good) return { t: 'Excellent', c: 'good' };
    if (v >= ok) return { t: 'Good', c: 'ok' };
    return { t: 'Limited', c: 'low' };
  }

  function paintQuality() {
    var boxes = $$('#qualityPanel, #qualityPanelResult');
    if (!boxes.length || !S.gate) return;
    var m = S.gate.metrics, c = S.calib || {};
    var rows = [
      ['Face mapping', grade(m.landmarkCount === 478 ? 1 : 0.4, 0.9, 0.6)],
      ['Camera angle', grade(1 - Math.min(1, Math.max(Math.abs(m.rollDeg || 0) / 14,
                        (m.offAxisDeg || 0) / 20)), 0.6, 0.3)],
      ['Image detail', grade(Math.min(1, (m.interocularPx || 0) / 140), 0.75, 0.45)],
      ['Facial symmetry', grade(c.symmetry, 0.93, 0.86)]
    ];
    var auditOk = !S.lastAudit || S.lastAudit.ok;
    var sep = S.lastSeparation;
    if (sep) {
      /* Two separate facts, because they answer different questions. Whether
         1 ml and 2 ml are distinguishable is pass/fail. How fine a difference
         the preview resolves is a number, and stating it is more honest than
         implying every offered amount looks different from its neighbour. */
      rows.push(['Amount separation', sep.ok
        ? { t: 'Distinct', c: 'good' } : { t: 'Too close', c: 'low' }]);
      rows.push(['Preview resolves', sep.resolutionMl === 0.25
        ? { t: '0.25 ml steps', c: 'good' }
        : { t: '0.5 ml steps', c: 'ok' }]);
    }
    var html = rows.map(function (r) {
      return '<li><span>' + r[0] + '</span><span class="q q--' + r[1].c + '">' + r[1].t + '</span></li>';
    }).join('') +
      '<li><span>Simulation checks</span><span class="q q--' + (auditOk ? 'good' : 'low') + '">' +
      (auditOk ? 'Passed' : 'Failed') + '</span></li>';
    boxes.forEach(function (b) { b.innerHTML = html; });
  }

  /* ------------------------------------------------------------- product UI */
  function buildProductStep() {
    var wrap = $('#productChoices');
    if (!wrap) return;
    if (!PRODUCTS_READY) {
      wrap.innerHTML =
        '<div class="notice">' +
          '<span class="notice__title">בחירת מוצר אינה פעילה בגרסה הזו</span>' +
          'הדמיה שמשתנה לפי מוצר מסחרי מסוים מחייבת נתוני יצרן (IFU) לכל מוצר, ' +
          'ובדיקה רגולטורית של הצגת מוצרי מרשם לקהל. הארכיטקטורה מוכנה והטבלה ' +
          'ריקה בכוונה — לא המצאנו מקדמים. עד אז ההדמיה פועלת בפרופיל נייטרלי.' +
        '</div>';
      return;
    }
    wrap.innerHTML = [NEUTRAL].concat(BRANDED).map(function (p, i) {
      return '<label class="option">' +
        '<input type="radio" name="product" value="' + p.id + '"' + (i === 0 ? ' checked' : '') + '>' +
        '<span class="option__box"><span>' + (p.brand ? p.brand + ' ' : '') + p.name + '</span>' +
        '<small>' + (p.family || '') + '</small></span></label>';
    }).join('');
    $$('input[name="product"]', wrap).forEach(function (r) {
      r.addEventListener('change', function () {
        var all = [NEUTRAL].concat(BRANDED);
        for (var i = 0; i < all.length; i++) if (all[i].id === r.value) S.product = all[i];
        scheduleRender();
      });
    });
  }



  /* =======================================================================
     Compare amounts
     ======================================================================= */
  function buildCompare() {
    var strip = $('#compareStrip');
    if (!strip || !S.mesh) return;
    var hasVolume = S.active.some(function (k) { var d = defOf(k); return d && d.op === 'volume'; });
    if (!hasVolume) { strip.innerHTML = ''; strip.hidden = true; return; }
    strip.hidden = false;

    var options = [0.5, 1.0, 1.5, 2.0];
    strip.innerHTML = options.map(function (ml) {
      return '<button type="button" class="cmp-amt" data-ml="' + ml + '">' +
        '<canvas data-cmp="' + ml + '"></canvas><span>' + ml.toFixed(1) + ' ml</span></button>';
    }).join('');

    var W = S.work.w, H = S.work.h;
    var tw = 190, th = Math.round(tw * H / W);
    var scratch = document.createElement('canvas');
    scratch.width = W; scratch.height = H;
    var sctx = scratch.getContext('2d', { willReadFrequently: true });

    options.forEach(function (ml) {
      var target = $('[data-cmp="' + ml + '"]', strip);
      target.width = tw; target.height = th;
      var r = simulate(sctx, { ml: ml });
      var tctx = target.getContext('2d');
      if (r.ok) tctx.drawImage(scratch, 0, 0, tw, th);
      else {
        tctx.drawImage(S.work.canvas, 0, 0, tw, th);
        target.parentNode.classList.add('is-rejected');
      }
    });

    $$('.cmp-amt', strip).forEach(function (b) {
      b.addEventListener('click', function () {
        var ml = parseFloat(b.dataset.ml);
        S.active.forEach(function (k) {
          var d = defOf(k);
          if (d && d.op === 'volume') S.amounts[k] = ml;
        });
        $$('[data-amount-range]').forEach(function (r) {
          var key = r.dataset.amountRange;
          if (S.amounts[key] != null) {
            r.value = String(S.amounts[key]);
            var o = $('[data-amount-out="' + key + '"]');
            if (o) o.textContent = S.amounts[key].toFixed(1) + ' ml';
          }
        });
        runPreview();
      });
    });
  }

  /* =======================================================================
     Upload / camera
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
      /* A stored file is used as decoded: browsers already apply EXIF
         orientation, and an upload is not a mirrored preview. */
      startAnalysis(img, img.naturalWidth, img.naturalHeight, false);
    };
    img.onerror = function () { URL.revokeObjectURL(url); alert('לא הצלחנו לקרוא את התמונה.'); };
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

  function startAnalysis(source, sw, sh, mirror) {
    go('analyze');
    var status = $('#analyzeStatus');
    setStatus(status, 'מכינה את התמונה…');

    ensureEngine(status).then(function () {
      setStatus(status, 'מזהה את מבנה הפנים ובונה מודל תלת־ממדי…');
      S.work = makeWork(source, sw, sh, mirror);
      sizeExact(outCanvas, S.work.w, S.work.h);
      sizeCrisp(overlay, S.work.w, S.work.h);
      sizeExact(cmpBefore, S.work.w, S.work.h);
      sizeExact(cmpAfter, S.work.w, S.work.h);
      var cmp = $('#resultCompare');
      if (cmp) cmp.style.aspectRatio = S.work.w + ' / ' + S.work.h;
      if (faceStage) faceStage.style.aspectRatio = S.work.w + ' / ' + S.work.h;
      S.base = S.work.ctx.getImageData(0, 0, S.work.w, S.work.h);
      S.baseData = S.base.data;
      S.lighting = undefined;      // refit the light for each new photograph
      return new Promise(function (res) { setTimeout(function () { res(analyse()); }, 30); });
    }).then(function (gate) {
      S.gate = gate;
      if (!gate.ok) { showRejection(gate.problems, gate.metrics); return; }
      S.active = []; S.amounts = {}; S.lastAudit = null;
      paintCalibration();
      syncControls();
      render();
      go('explore');
    }).catch(function (err) {
      go('reject');
      var list = $('#rejectList');
      if (list) list.innerHTML = '<li>' +
        (ENGINE_ERRORS[err && err.code] || ENGINE_ERRORS.engine_error) + '</li>';
      var dbg = $('#rejectDebug');
      if (dbg) { dbg.hidden = !DEBUG; if (DEBUG) dbg.textContent = String(err && (err.message || err.code)); }
    });
  }

  function paintCalibration() {
    var box = $('#calibList');
    if (!box || !S.calib) return;
    var c = S.calib;
    var rows = [
      ['Interpupillary distance', c.interocularPx + ' px'],
      ['Facial width', c.faceWidth != null ? c.faceWidth + ' mm*' : '—'],
      ['Facial height', c.faceHeight + ' mm*'],
      ['Lip width', c.lipWidth + ' mm*'],
      ['Lip height', c.lipHeight + ' mm*'],
      ['Chin projection', c.chinProjection + ' mm*'],
      ['Facial symmetry', c.symmetry != null ? (c.symmetry * 100).toFixed(1) + '%' : '—'],
      ['Head pose', 'roll ' + (c.rollDeg != null ? c.rollDeg : '—') + '° · off-axis ' +
        (c.offAxisDeg != null ? c.offAxisDeg : '—') + '°']
    ];
    box.innerHTML = rows.map(function (r) {
      return '<li><span>' + r[0] + '</span><span>' + r[1] + '</span></li>';
    }).join('');
  }

  /* ------------------------------------------------------------- camera */
  var camVideo = $('#camVideo');
  var camOverlay = $('#camOverlay');
  var camCtx = camOverlay ? camOverlay.getContext('2d') : null;
  var camCapture = document.createElement('canvas');
  var camCapCtx = camCapture.getContext('2d', { willReadFrequently: true });

  var HINTS = {
    none: 'מחפשת פנים…', many: 'יש יותר מאדם אחד בתמונה',
    closer: 'להתקרב מעט', back: 'להתרחק מעט',
    left: 'למרכז את הפנים ←', right: 'למרכז את הפנים →',
    straight: 'להביט ישר למצלמה', level: 'ליישר את הראש',
    centre: 'למרכז את הפנים במסגרת', ready: 'מושלם ✓',
    relax: 'להרפות את הפנים, הבעה ניטרלית', light: 'נדרשת תאורה אחידה יותר',
    steady: 'להחזיק את המצלמה יציבה'
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
        setStatus(status, ENGINE_ERRORS[err && err.code] ||
          'לא הצלחנו לפתוח את המצלמה. אפשר להעלות תמונה מהגלריה במקום.');
      });
  }

  function stopCamera() {
    if (S.rafId) cancelAnimationFrame(S.rafId);
    S.rafId = 0;
    if (S.stream) { S.stream.getTracks().forEach(function (t) { t.stop(); }); S.stream = null; }
    if (camVideo) camVideo.srcObject = null;
  }

  function camLoop() {
    S.rafId = requestAnimationFrame(camLoop);
    if (!camVideo || camVideo.readyState < 2) return;
    var vw = camVideo.videoWidth, vh = camVideo.videoHeight;
    if (!vw || !vh) return;

    /* Mirror here, once. The captured pixels are what gets analysed, so the
       preview, the guidance and the stored photo share one geometry. */
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
      var by = {};
      gate.problems.forEach(function (p) { by[p.code] = p; });

      if (by.cropped || by.too_close) hint = HINTS.back;
      else if (by.too_small || by.low_detail) hint = HINTS.closer;
      else if (by.exposure || by.too_dark || by.too_bright) hint = HINTS.light;
      else if (by.blurred) hint = HINTS.steady;
      else if (by.expression) hint = HINTS.relax;
      else if (by.roll) hint = HINTS.level;
      /* Rotation gets "look straight", never a left/right arrow: the preview is
         mirrored, so a rotation arrow is ambiguous. Arrows are for POSITION,
         where a mirrored view is intuitive. */
      else if (by.turned || by.off_axis) hint = HINTS.straight;
      else if (gate.ok) {
        var box = window.AmiraFaceMesh.bboxOf(pts);
        var cxn = (box.x0 + box.x1) / 2, cyn = (box.y0 + box.y1) / 2;
        if (Math.abs(cxn - 0.5) > 0.12) hint = cxn < 0.5 ? HINTS.right : HINTS.left;
        else if (Math.abs(cyn - 0.48) > 0.14) hint = HINTS.centre;
        else { hint = HINTS.ready; ok = true; }
      }
    }

    S.camReady = ok ? S.camReady + 1 : 0;
    var stable = S.camReady >= 5;
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
      fx.translate(vw, 0); fx.scale(-1, 1);       // same mirroring as the loop
      fx.drawImage(camVideo, 0, 0, vw, vh);
      stopCamera();
      startAnalysis(full, vw, vh, false);         // already mirrored
    });
  }

  /* =======================================================================
     Consent -> preview
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
    var clearConsent = function () {
      if (S.consented) return;
      consentCheck.checked = false;
      consentGo.disabled = true;
    };
    $$('.sheet__scrim, .sheet__close, [data-sheet-close]', consentSheet)
      .forEach(function (el) { el.addEventListener('click', clearConsent); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') clearConsent(); });
  }

  function runPreview() {
    go('result');
    var wait = $('#resultWait'), view = $('#resultView'), fail = $('#resultFail');
    if (wait) wait.hidden = false;
    if (view) view.hidden = true;
    if (fail) fail.hidden = true;

    setTimeout(function () {
      var r = simulate(fctx);
      S.lastAudit = r.audit;
      if (wait) wait.hidden = true;

      if (!r.ok) {
        if (fail) {
          fail.hidden = false;
          listProblems($('#resultFailList'), r.audit.problems);
          var dbg = $('#resultFailDebug');
          if (dbg) { dbg.hidden = !DEBUG; if (DEBUG) dbg.textContent = JSON.stringify(r.audit.metrics, null, 1); }
        }
        paintQuality();
        return;
      }

      bctx.putImageData(S.base, 0, 0);
      if (view) view.hidden = false;
      /* Prove the amounts are actually distinguishable on THIS face. */
      S.lastSeparation = testDoseSeparation();
      paintPlanSummary();
      paintQuality();
      buildCompare();
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
     Download / hand-off / reset
     ======================================================================= */
  var dl = $('#mirrorDownload');
  if (dl) {
    dl.addEventListener('click', function () {
      var w = S.work.w, h = S.work.h, pad = 28, capH = 152;
      var c = document.createElement('canvas');
      c.width = w * 2 + pad * 3; c.height = h + pad * 2 + capH;
      var x = c.getContext('2d');
      x.fillStyle = '#F7F5F2'; x.fillRect(0, 0, c.width, c.height);
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
      x.fillText('AMEERA DABAJA · Medical Aesthetics', pad, y);
      x.fillStyle = '#645954';
      x.font = '19px Arial, sans-serif';
      x.direction = 'rtl'; x.textAlign = 'right';
      [
        'הדמיה חזותית משוערת בלבד. אינה חוזה את תוצאת הטיפול ואינה קובעת',
        'את סוג הטיפול או כמות החומר. התוצאה בפועל נקבעת בהתאם לאנטומיה,',
        'לחומר, לטכניקת הטיפול ולבדיקה רפואית של ד״ר אמירה.'
      ].forEach(function (l, i) { x.fillText(l, c.width - pad, y + 30 + i * 27); });

      c.toBlob(function (blob) {
        if (window.__amiraSaveImage) { window.__amiraSaveImage(blob, 'ameera-dabaja-simulation.jpg'); return; }
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'ameera-dabaja-simulation.jpg';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
      }, 'image/jpeg', 0.92);
    });
  }

  var discuss = $('#mirrorDiscuss');
  if (discuss) {
    discuss.addEventListener('click', function () {
      try {
        var vol = S.active.filter(function (k) { var d = defOf(k); return d && d.op === 'volume'; })
          .map(function (k) {
            var sd = S.sides[k] || 'both';
            return defOf(k).he + ' ' + (S.amounts[k] != null ? S.amounts[k] : 0.5) + ' ml' +
              (sd === 'both' ? '' : (sd === 'left' ? ' (שמאל)' : ' (ימין)'));
          });
        sessionStorage.setItem('amira.mirror.handoff', JSON.stringify({
          keys: S.active,
          regions: S.active.map(function (k) { var d = defOf(k); return d ? d.he : k; }),
          level: vol.length ? vol.join(', ') : 'ריכוך קמטים'
        }));
      } catch (e) { /* private mode: the flow still works, just without prefill */ }
    });
  }

  function reset() {
    stopCamera();
    S.work = null; S.base = null; S.baseData = null; S.lighting = undefined;
    S.landmarks = null; S.frame = null; S.regions = null; S.mesh = null;
    S.gate = null; S.calib = null; S.lastAudit = null;
    S.active = []; S.amounts = {}; S.sides = {}; S.consented = false;
    S.product = NEUTRAL; S.lastSeparation = null;
    if (fileInput) fileInput.value = '';
    [octx, bctx, fctx, vctx].forEach(function (c) {
      if (c) { c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, 4000, 4000); }
    });
    var strip = $('#compareStrip');
    if (strip) { strip.innerHTML = ''; strip.hidden = true; }
    syncControls();
    go('start');
  }
  $$('.js-reset').forEach(function (b) { b.addEventListener('click', reset); });

  window.addEventListener('pagehide', function () {
    stopCamera();
    S.work = null; S.base = null; S.baseData = null; S.lighting = undefined;
    S.landmarks = null; S.mesh = null;
    [octx, bctx, fctx, vctx].forEach(function (c) {
      if (c) { c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, 4000, 4000); }
    });
  });

  /* --------------------------------------------------------------- startup */
  if (DEBUG) studio.classList.add('is-debug');
  if (CLINICIAN) studio.classList.add('is-clinician');
  DOSE_STEPS = window.AmiraFaceRegions.DOSE_STEPS;
  buildRegionList();
  buildProductStep();
  syncControls();

  window.AmiraMirror = {
    state: S, render: render, reset: reset, analyse: analyse, go: go,
    simulate: simulate, buildPlan: buildPlan, defOf: defOf,
    testDoseSeparation: testDoseSeparation,
    products: { neutral: NEUTRAL, branded: BRANDED, ready: PRODUCTS_READY }
  };
})();
