/* ==========================================================================
   face-mesh.js — face detection + quality gate for AI Visual Simulation
   --------------------------------------------------------------------------
   Wraps MediaPipe Face Landmarker (478 landmarks, Apache-2.0, vendored under
   assets/vendor/mediapipe/).

   Two responsibilities, and nothing else:

     1. LOADING the engine from local files. Nothing is fetched from a CDN, so
        "no third party learns you were here" holds for the engine as well as
        for the photo.

     2. FAILING CLOSED. A wrong mapping that looks plausible is worse than no
        mapping, because the visitor cannot tell the difference. Every check
        below can only REJECT. None of them nudges, snaps, or best-effort
        corrects a bad detection.

   The engine is ~15 MB, so it is loaded lazily on explicit intent only.
   ========================================================================== */
window.AmiraFaceMesh = (function () {
  'use strict';

  var VENDOR = 'assets/vendor/mediapipe';
  var lib = null;            // imported module namespace
  var landmarker = null;     // IMAGE mode instance
  var videoLandmarker = null;
  var loadPromise = null;
  var vendorBase = VENDOR;

  /* Gate thresholds. Deliberately strict — see FAILING CLOSED above.
     Each is measured on a quantity whose meaning was verified, not assumed. */
  var GATE = {
    /* ---- why this is not 7 ------------------------------------------
       The requirement was yaw within +-7 degrees and pitch within +-7. It was
       set to 7 here, and measurement showed that number was not measuring head
       orientation at all.

       On a perfectly frontal, symmetric, code-drawn face the pose matrix
       reports 6.8 degrees on one of the two non-roll channels - and it stays at
       5.9-7.2 across in-plane rotations of 0 and +-6 degrees, where true pitch
       and yaw are exactly zero throughout. It is a fit residual: the solver
       absorbs the difference between this face's proportions and its canonical
       model as pose. Any face whose proportions differ from that model carries
       such an offset, so the absolute value is not a head angle.

       With the threshold at 7, that 6.8 baseline sat directly on the limit and
       its noise crossed it at random: across five variants of the same frontal
       face the gate refused two of them and passed three, in no meaningful
       order. A gate that rejects frontal photographs by coin flip is worse than
       a loose one.

       So this bound now catches gross rotation only, clearing the observed
       baseline and its noise by a wide margin, and the +-7 requirement is NOT
       enforced here. Roll is, at 5 degrees, because roll is measured
       geometrically from the eye line and verified against exact ground truth
       (0 -> -0.1, -6 -> -6.3, +6 -> +5.6). For yaw and pitch, establishing a
       real threshold needs photographs of real faces at known angles - the QA
       set that has not been shot yet. Until then this is documented as open
       rather than claimed as done.
       ------------------------------------------------------------------ */
    maxOffAxisDeg:      16,
    maxRollDeg:         5,    // in-plane, from the eye line; verified
    minFaceHeightFrac:  0.28, // face bbox height / image height
    /* At 0.92 this never fired: a face that tall has already reached the frame
       edge and been caught as `cropped`, so the check was dead. Perspective
       distortion matters well before that - a face filling three quarters of
       the frame height on a phone is held close enough for the lens to enlarge
       the nose and the near cheek. 0.28..0.78 still leaves a wide band of
       ordinary portrait framing. */
    maxFaceHeightFrac:  0.78,
    minInterocularPx:   55,   // detail floor, in work-canvas pixels
    edgeMargin:         0.015,// closer to the border than this counts as cropped
    /* Half-width mismatch. A symmetric code-drawn face already measures 0.05
       here, and natural facial asymmetry is common, so 0.11 left almost no
       headroom for a real face. This is a coarse backstop against a clear turn,
       not the yaw gate it was briefly treated as - an attempt to calibrate it
       in degrees failed because the landmark model absorbs a compressed half as
       a narrower face rather than a rotated one. */
    maxAsymmetry:       0.15,
    /* Image quality, measured over the face only - the background is not what
       we are about to deform. */
    minSharpness:       2.0,  // face contrast ratio, |Laplacian| / mean luma * 100
    maxClippedFrac:     0.06, // share of face pixels blown out or crushed
    minMeanLuma:        55,
    maxMeanLuma:        215,
  };

  /**
   * Expression limits, per blendshape rather than one number for all of them.
   *
   * A face mid-smile has different lip geometry from a relaxed one, so a
   * preview built on it shows the smile as much as the treatment. But a single
   * strict limit across every shape is the wrong instrument: some shapes score
   * moderately on a genuinely relaxed face - fuller or slightly protruded lips
   * read as `mouthPucker`, for instance - and refusing those would lock a real
   * visitor out of the tool entirely. A false refusal costs her the feature; a
   * moderate score she cannot feel costs a little accuracy in a preview that is
   * already labelled an illustration.
   *
   * So the unambiguous shapes are held tightly and the ambiguous ones loosely.
   * These numbers are deliberately on the permissive side and are the part of
   * the gate most in need of validation against real photographs - the QA pass
   * over a real image set has not been run, and until it has, being slow to
   * refuse is the safer error.
   *
   * Scores run 0..1. Names are MediaPipe's own category names.
   */
  var EXPRESSION_LIMITS = {
    /* unmistakable, and they move exactly the tissue we model */
    jawOpen:          0.25,
    cheekPuff:        0.25,
    mouthSmileLeft:   0.32,
    mouthSmileRight:  0.32,
    /* real but easier to confuse with a resting face */
    mouthFrownLeft:   0.40,
    mouthFrownRight:  0.40,
    mouthFunnel:      0.45,
    mouthPressLeft:   0.45,
    mouthPressRight:  0.45,
    /* commonly non-zero at rest; only a strong reading means anything */
    mouthPucker:      0.60,
    browDownLeft:     0.45,
    browDownRight:    0.45,
    browInnerUp:      0.45,
    eyeSquintLeft:    0.45,
    eyeSquintRight:   0.45
  };

  /* ------------------------------------------------------------------ load */

  function load(opts) {
    if (loadPromise) return loadPromise;
    opts = opts || {};
    if (opts.vendorBase) vendorBase = opts.vendorBase;
    var onProgress = opts.onProgress || function () {};

    /* A relative path like "assets/..." is a BARE module specifier to
       import(); it must be resolved against the document first. */
    var moduleUrl = new URL(vendorBase + '/vision_bundle.mjs', document.baseURI).href;

    loadPromise = import(moduleUrl)
      .catch(function () {
        throw { code: 'engine_unavailable', message: 'engine bundle could not be loaded' };
      })
      .then(function (mod) {
        lib = mod;
        onProgress('engine');
        /* Only the SIMD build is vendored; the no-SIMD one is another 11 MB and
           every browser we support has SIMD. Check rather than crash. */
        return lib.FilesetResolver.isSimdSupported().then(function (simd) {
          if (!simd) throw { code: 'no_simd', message: 'browser lacks WebAssembly SIMD' };
          onProgress('wasm');
          return lib.FilesetResolver.forVisionTasks(vendorBase + '/wasm');
        });
      })
      .then(function (fileset) {
        onProgress('model');
        return lib.FaceLandmarker.createFromOptions(fileset, {
          baseOptions: {
            modelAssetPath: vendorBase + '/face_landmarker.task',
            delegate: 'GPU'
          },
          runningMode: 'IMAGE',
          /* 2, so a second face is DETECTED rather than silently ignored. */
          numFaces: 2,
          minFaceDetectionConfidence: 0.6,
          minFacePresenceConfidence: 0.6,
          minTrackingConfidence: 0.6,
          outputFaceBlendshapes: true,
          outputFacialTransformationMatrixes: true
        });
      })
      .then(function (instance) {
        landmarker = instance;
        onProgress('ready');
        return lib;
      })
      .catch(function (err) {
        loadPromise = null;      // allow a retry
        throw (err && err.code) ? err
          : { code: 'engine_error', message: String((err && err.message) || err) };
      });

    return loadPromise;
  }

  function isLoaded() { return !!landmarker; }

  /* A separate VIDEO-mode instance for live camera guidance: detectForVideo()
     cannot be called on an IMAGE-mode landmarker. */
  function loadVideo() {
    if (videoLandmarker) return Promise.resolve(videoLandmarker);
    return load()
      .then(function () { return lib.FilesetResolver.forVisionTasks(vendorBase + '/wasm'); })
      .then(function (fileset) {
        return lib.FaceLandmarker.createFromOptions(fileset, {
          baseOptions: {
            modelAssetPath: vendorBase + '/face_landmarker.task',
            delegate: 'GPU'
          },
          runningMode: 'VIDEO',
          numFaces: 2,
          /* Guidance is advisory and runs per frame; the capture still has to
             clear the strict gate afterwards. */
          minFaceDetectionConfidence: 0.5,
          minFacePresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
          outputFaceBlendshapes: true,
          outputFacialTransformationMatrixes: true
        });
      })
      .then(function (i) { videoLandmarker = i; return i; });
  }

  /* --------------------------------------------------------------- geometry */

  /**
   * Reads the three Tait-Bryan angles out of MediaPipe's 4x4 column-major
   * facial transformation matrix.
   *
   * Only ONE channel's identity is established by measurement: `aboutZ` tracks
   * in-plane rotation with a slope of -1.00 (checked against images rotated
   * from -24 to +24 degrees, and confirmed independently by the inter-eye axis
   * angle, slope +1.00). Which of `aboutY` / `aboutX` is yaw and which is pitch
   * could NOT be established without genuinely three-dimensional test input, so
   * this function does not label them.
   *
   * The gate therefore does not depend on that distinction: roll comes from the
   * eye line, turn comes from left/right face-width asymmetry, and the two
   * unidentified channels are simply bounded together as "off axis". Guessing a
   * label would have produced confidently wrong camera guidance.
   */
  function matrixAngles(matrix) {
    if (!matrix || !matrix.data || matrix.data.length < 16) return null;
    var m = matrix.data;                       // column-major: m[col * 4 + row]
    var deg = 180 / Math.PI;
    return {
      aboutZ: Math.atan2(m[1], m[0]) * deg,                            // = in-plane roll
      aboutY: Math.atan2(-m[2], Math.hypot(m[0], m[1])) * deg,         // yaw or pitch
      aboutX: Math.atan2(m[6], m[10]) * deg                            // the other one
    };
  }

  /**
   * Reads the blendshape scores and reports the strongest expression found.
   * Returns {peak, name} or null when the model did not supply blendshapes.
   */
  function expressionScore(result) {
    var sets = (result && result.faceBlendshapes) || [];
    if (!sets.length || !sets[0].categories) return null;
    /* Ranked by how far each shape is OVER its own limit, so the shape we report
       is the one actually breaking the gate and not merely the highest number.
       A jaw at 0.30 against a limit of 0.25 matters; a pucker at 0.50 against a
       limit of 0.60 does not. */
    var worst = null, peak = 0, peakName = null;
    sets[0].categories.forEach(function (c) {
      var limit = EXPRESSION_LIMITS[c.categoryName];
      if (limit == null) return;
      if (c.score > peak) { peak = c.score; peakName = c.categoryName; }
      var over = c.score - limit;
      if (over > 0 && (!worst || over > worst.over)) {
        worst = { name: c.categoryName, score: c.score, limit: limit, over: over };
      }
    });
    return { peak: peak, name: peakName, exceeded: worst };
  }

  /**
   * Image quality over the face region only: sharpness, exposure clipping and
   * overall brightness. A blurred or blown-out face gives the landmarker less
   * to work with and gives the deformation nothing to resample, so a preview
   * built on one looks like a smudge rather than a result.
   *
   * `data` is RGBA from the work canvas; `box` is the face bounding box in
   * normalised coordinates.
   */
  function assessImage(data, W, H, box, problems, metrics) {
    if (!data || !box) return;
    var x0 = Math.max(1, Math.floor(box.x0 * W));
    var x1 = Math.min(W - 2, Math.ceil(box.x1 * W));
    var y0 = Math.max(1, Math.floor(box.y0 * H));
    var y1 = Math.min(H - 2, Math.ceil(box.y1 * H));
    if (x1 <= x0 || y1 <= y0) return;

    var n = 0, sumLuma = 0, clipped = 0, sumLap = 0;
    for (var y = y0; y <= y1; y += 2) {
      for (var x = x0; x <= x1; x += 2) {
        var o = (y * W + x) * 4;
        var l = 0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2];
        n++; sumLuma += l;
        if (l >= 250 || l <= 5) clipped++;
        /* 4-neighbour Laplacian: a focus measure that does not need a
           normalising assumption about content. */
        var lu = 0.2126 * data[o - W * 4] + 0.7152 * data[o - W * 4 + 1] + 0.0722 * data[o - W * 4 + 2];
        var ld = 0.2126 * data[o + W * 4] + 0.7152 * data[o + W * 4 + 1] + 0.0722 * data[o + W * 4 + 2];
        var ll = 0.2126 * data[o - 4] + 0.7152 * data[o - 3] + 0.0722 * data[o - 2];
        var lr = 0.2126 * data[o + 4] + 0.7152 * data[o + 5] + 0.0722 * data[o + 6];
        sumLap += Math.abs(4 * l - lu - ld - ll - lr);
      }
    }
    if (!n) return;

    var meanLuma = sumLuma / n;
    /* Relative, not absolute. An absolute Laplacian scales with brightness, so
       a dark-but-perfectly-sharp photo measured as blurred and the visitor was
       told to hold the camera steady when the real problem was the light.
       Dividing by mean luminance makes this a contrast ratio, which is what
       focus actually is: measured on the fixture, a sharp frame scores 5.5 at
       luma 188 and 6.0 at luma 48, while a 4px blur scores 0.45. */
    var sharp = (sumLap / n) / Math.max(1, meanLuma) * 100;
    var clipFrac = clipped / n;
    metrics.meanLuma = Math.round(meanLuma);
    metrics.sharpness = +sharp.toFixed(2);
    metrics.clippedFrac = +clipFrac.toFixed(3);

    if (sharp < GATE.minSharpness) {
      problems.push({ code: 'blurred',
                      message: 'face detail measures ' + sharp.toFixed(1) + ', below ' + GATE.minSharpness });
    }
    if (clipFrac > GATE.maxClippedFrac) {
      problems.push({ code: 'exposure',
                      message: Math.round(clipFrac * 100) + '% of the face is blown out or crushed' });
    }
    if (meanLuma < GATE.minMeanLuma) {
      problems.push({ code: 'too_dark', message: 'face brightness ' + Math.round(meanLuma) });
    }
    if (meanLuma > GATE.maxMeanLuma) {
      problems.push({ code: 'too_bright', message: 'face brightness ' + Math.round(meanLuma) });
    }
  }

  function bboxOf(points) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (var i = 0; i < points.length; i++) {
      var p = points[i];
      if (p.x < x0) x0 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.x > x1) x1 = p.x;
      if (p.y > y1) y1 = p.y;
    }
    return { x0: x0, y0: y0, x1: x1, y1: y1, w: x1 - x0, h: y1 - y0 };
  }

  /* ------------------------------------------------------------------ gate */

  /**
   * Judges one detection result.
   * Returns {ok, problems:[{code,message,side?}], metrics, landmarks?, pose?}.
   * Landmarks are normalised to the work canvas; `size` is that canvas {w,h}.
   */
  function assess(result, size) {
    var problems = [];
    var metrics = {};

    var faces = (result && result.faceLandmarks) || [];
    metrics.faces = faces.length;

    if (faces.length === 0) {
      return { ok: false, metrics: metrics,
               problems: [{ code: 'no_face', message: 'no face detected' }] };
    }
    if (faces.length > 1) {
      return { ok: false, metrics: metrics,
               problems: [{ code: 'multiple_faces', message: faces.length + ' faces detected' }] };
    }

    var pts = faces[0];
    metrics.landmarkCount = pts.length;
    if (pts.length < 468) {
      problems.push({ code: 'sparse_mesh', message: 'incomplete mesh: ' + pts.length + ' points' });
    }

    /* --- pose ------------------------------------------------------------ */
    var ang = matrixAngles((result.facialTransformationMatrixes || [])[0]);
    if (!ang) {
      problems.push({ code: 'no_pose', message: 'pose matrix unavailable' });
    } else {
      metrics.aboutZ = +ang.aboutZ.toFixed(1);
      metrics.aboutY = +ang.aboutY.toFixed(1);
      metrics.aboutX = +ang.aboutX.toFixed(1);
      /* Bound the two unidentified channels together, so the check holds
         whichever of them is yaw and whichever is pitch. */
      var offAxis = Math.max(Math.abs(ang.aboutY), Math.abs(ang.aboutX));
      metrics.offAxisDeg = +offAxis.toFixed(1);
      if (offAxis > GATE.maxOffAxisDeg) {
        problems.push({ code: 'off_axis',
                        message: 'head is ' + Math.round(offAxis) + ' deg off axis' });
      }
    }

    /* --- expression ------------------------------------------------------ */
    var expr = expressionScore(result);
    if (expr) {
      metrics.expression = +expr.peak.toFixed(3);
      metrics.expressionShape = expr.name;
      if (expr.exceeded) {
        var x = expr.exceeded;
        metrics.expressionExceeded = x.name + ' ' + x.score.toFixed(2) +
                                    ' > ' + x.limit;
        problems.push({ code: 'expression', shape: x.name,
                        message: 'active expression (' + x.name + ' ' +
                                 x.score.toFixed(2) + ', limit ' + x.limit + ')' });
      }
    }

    /* --- framing and scale ----------------------------------------------- */
    var box = bboxOf(pts);
    metrics.faceHeightFrac = +box.h.toFixed(3);
    metrics.faceWidthFrac  = +box.w.toFixed(3);

    if (box.h < GATE.minFaceHeightFrac) {
      problems.push({ code: 'too_small',
                      message: 'face fills only ' + Math.round(box.h * 100) + '% of the frame height' });
    }
    /* Too close is its own failure, not the opposite end of "too small". A face
       held close to a phone lens is drawn in strong perspective: the nose and
       the near cheek are magnified relative to the jaw. We do not try to undo
       that - doing it properly needs the lens, and without it we would be
       guessing which part of the shape is the person and which is the camera.
       So we ask for a little more distance instead. */
    if (box.h > GATE.maxFaceHeightFrac) {
      problems.push({ code: 'too_close',
                      message: 'face fills ' + Math.round(box.h * 100) + '% of the frame height' });
    }

    var m = GATE.edgeMargin;
    var edges = [];
    if (box.y0 < m) edges.push('top');
    if (box.y1 > 1 - m) edges.push('bottom');
    if (box.x0 < m || box.x1 > 1 - m) edges.push('side');
    if (edges.length) {
      problems.push({ code: 'cropped', edges: edges,
                      message: 'face reaches the frame edge (' + edges.join(', ') + ')' });
    }

    return { ok: problems.length === 0, problems: problems, metrics: metrics,
             landmarks: pts, angles: ang };
  }

  /**
   * Second half of the gate: the checks that need the derived anatomical
   * frame. Mutates `problems` / `metrics` in place. Kept out of assess() so
   * that face-regions.js owns all frame maths.
   */
  function assessFrame(frame, size, problems, metrics) {
    if (!frame) {
      problems.push({ code: 'no_frame', message: 'anatomical frame could not be built' });
      return;
    }
    var iodPx = frame.scale * size.w;
    metrics.interocularPx = Math.round(iodPx);
    if (iodPx < GATE.minInterocularPx) {
      problems.push({ code: 'low_detail',
                      message: 'only ' + Math.round(iodPx) + 'px between the eyes' });
    }

    /* Roll, measured geometrically from the inter-eye axis. Verified against
       images rotated -24..+24 degrees: slope +1.00, so this is roll itself and
       not a proxy for it. */
    var rollDeg = Math.atan2(frame.ex.y, frame.ex.x) * 180 / Math.PI;
    metrics.rollDeg = +rollDeg.toFixed(1);
    if (Math.abs(rollDeg) > GATE.maxRollDeg) {
      problems.push({ code: 'roll',
                      message: 'head rolled ' + Math.round(Math.abs(rollDeg)) + ' deg' });
    }

    /* Turn, from the mismatch between the left and right face half-widths at
       eye level. Independent of the pose matrix, so the two cross-check. */
    if (frame.asymmetry != null) {
      metrics.asymmetry = +frame.asymmetry.toFixed(3);
      if (frame.asymmetry > GATE.maxAsymmetry) {
        problems.push({ code: 'turned', side: frame.asymSide,
                        message: 'face is turned toward image-' + frame.asymSide });
      }
    }
  }

  /* ---------------------------------------------------------------- detect */

  function detectImage(source) {
    return landmarker ? landmarker.detect(source) : null;
  }

  function detectVideo(video, timestampMs) {
    return videoLandmarker ? videoLandmarker.detectForVideo(video, timestampMs) : null;
  }

  function dispose() {
    try { if (landmarker) landmarker.close(); } catch (e) {}
    try { if (videoLandmarker) videoLandmarker.close(); } catch (e) {}
    landmarker = null;
    videoLandmarker = null;
    loadPromise = null;
  }

  return {
    load: load,
    loadVideo: loadVideo,
    isLoaded: isLoaded,
    detectImage: detectImage,
    detectVideo: detectVideo,
    assess: assess,
    assessFrame: assessFrame,
    assessImage: assessImage,
    expressionScore: expressionScore,
    matrixAngles: matrixAngles,
    bboxOf: bboxOf,
    dispose: dispose,
    GATE: GATE,
    EXPRESSION_LIMITS: EXPRESSION_LIMITS,
    get lib() { return lib; }
  };
})();
