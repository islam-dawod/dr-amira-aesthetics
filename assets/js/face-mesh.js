/* ==========================================================================
   face-mesh.js — face detection + quality gate for The Amira AI Mirror
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
    maxOffAxisDeg:     20,    // the two unidentified matrix channels, bounded together
    maxRollDeg:        14,    // in-plane, from the inter-eye axis angle
    minFaceHeightFrac: 0.28,  // face bbox height / image height
    minInterocularPx:  55,    // detail floor, in work-canvas pixels
    edgeMargin:        0.015, // closer to the border than this counts as cropped
    maxAsymmetry:      0.16   // left/right face half-width mismatch => turned
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
          outputFaceBlendshapes: false,
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
          outputFaceBlendshapes: false,
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

    /* --- framing and scale ----------------------------------------------- */
    var box = bboxOf(pts);
    metrics.faceHeightFrac = +box.h.toFixed(3);
    metrics.faceWidthFrac  = +box.w.toFixed(3);

    if (box.h < GATE.minFaceHeightFrac) {
      problems.push({ code: 'too_small',
                      message: 'face fills only ' + Math.round(box.h * 100) + '% of the frame height' });
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
    matrixAngles: matrixAngles,
    bboxOf: bboxOf,
    dispose: dispose,
    GATE: GATE,
    get lib() { return lib; }
  };
})();
