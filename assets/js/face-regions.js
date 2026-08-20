/* ==========================================================================
   face-regions.js — turns 478 detected landmarks into treatment preview areas
   --------------------------------------------------------------------------
   This module is what replaced the old fixed-proportion overlay. Nothing here
   is a constant fraction of the IMAGE; every region is expressed in a frame
   derived from the face that was actually found.

   Three deliberate choices:

   1. CONTOURS COME FROM THE LIBRARY. The index sets (lips, face oval, eyes,
      eyebrows) are read from FaceLandmarker.FACE_LANDMARKS_* at runtime rather
      than hand-copied into this file, so they cannot drift from the model.

   2. NO LEFT/RIGHT SEMANTICS. Sides are decided by image x coordinate, never
      by the model's anatomical naming. A mirrored selfie therefore cannot swap
      anything: "outward" is always "away from the face centre line, in image
      space".

   3. ONE ANATOMICAL FRAME. Origin at the midpoint between the eyes, +u along
      the inter-eye axis, +v perpendicular and downward, unit = interocular
      distance. Because the axes rotate with the eyes, head roll is handled for
      free; because the unit is interocular distance, face size is too.

   Only one raw landmark index is used by number (NOSE_TIP), and it is
   validated against the contours before use. If it fails, the frame is
   rejected rather than trusted.
   ========================================================================== */
window.AmiraFaceRegions = (function () {
  'use strict';

  var NOSE_TIP = 1;

  /**
   * Smooth odd ramp, replacing Math.sign() wherever a direction has to reverse
   * across an anatomical midline. sign() is discontinuous: two adjacent
   * vertices either side of the line receive opposite displacement, and the
   * thin triangle between them folds. tanh reverses smoothly and is zero ON the
   * line, which is also the anatomically correct behaviour — the wet line and
   * the facial midline should not move.
   */
  function ramp(x, softness) {
    return Math.tanh(x / (softness || 0.08));
  }

  /* ----------------------------------------------------------------- helpers */

  function uniqueIndices(connections) {
    var seen = Object.create(null);
    var out = [];
    for (var i = 0; i < connections.length; i++) {
      var c = connections[i];
      if (!(c.start in seen)) { seen[c.start] = 1; out.push(c.start); }
      if (!(c.end in seen))   { seen[c.end] = 1;   out.push(c.end); }
    }
    return out;
  }

  function centroid(pts) {
    var x = 0, y = 0;
    for (var i = 0; i < pts.length; i++) { x += pts[i].x; y += pts[i].y; }
    return { x: x / pts.length, y: y / pts.length };
  }

  /**
   * Walks the connection list into ordered closed rings.
   *
   * The MediaPipe contour lists are clean cycle graphs — every vertex has
   * degree exactly 2 — so this recovers the true traversal order: the lips list
   * yields two disjoint 20-point rings (outer + inner) and the face oval yields
   * one 36-point ring.
   *
   * This replaced an angular-bucketing approach that sampled the farthest point
   * per angle around the centroid. That works for round shapes but fails on
   * flat ones: for lips, the buckets near +/-90 degrees are often empty, so the
   * polygon jumped straight across the centroid and collapsed into a sliver
   * that excluded the mouth. Ordered rings have no such failure mode.
   */
  function ringsFromConnections(connections) {
    var adj = Object.create(null);
    for (var i = 0; i < connections.length; i++) {
      var c = connections[i];
      (adj[c.start] || (adj[c.start] = [])).push(c.end);
      (adj[c.end] || (adj[c.end] = [])).push(c.start);
    }
    var seen = Object.create(null);
    var rings = [];
    Object.keys(adj).forEach(function (key) {
      var start = +key;
      if (seen[start]) return;
      var ring = [];
      var cur = start, prev = -1;
      while (cur !== undefined && !seen[cur]) {
        seen[cur] = 1;
        ring.push(cur);
        var nbrs = adj[cur] || [];
        var next;
        for (var n = 0; n < nbrs.length; n++) {
          if (nbrs[n] !== prev && !seen[nbrs[n]]) { next = nbrs[n]; break; }
        }
        prev = cur;
        cur = next;
      }
      if (ring.length >= 3) rings.push(ring);
    });
    return rings;
  }

  /** Signed area of a closed polygon; used to pick the outer of two rings. */
  function area(poly, kx, ky) {
    var s = 0;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      s += (poly[j][kx] + poly[i][kx]) * (poly[j][ky] - poly[i][ky]);
    }
    return Math.abs(s / 2);
  }

  /**
   * Fallback only, for a contour whose ring could not be recovered: bucket
   * points by angle around the centroid and keep the farthest in each bucket.
   */
  function outerBoundary(pts, buckets) {
    var c = centroid(pts);
    var best = new Array(buckets);
    var bestR = new Array(buckets);
    for (var i = 0; i < pts.length; i++) {
      var dx = pts[i].x - c.x, dy = pts[i].y - c.y;
      var r = dx * dx + dy * dy;
      var a = Math.atan2(dy, dx);
      var b = Math.floor(((a + Math.PI) / (2 * Math.PI)) * buckets) % buckets;
      if (bestR[b] === undefined || r > bestR[b]) { bestR[b] = r; best[b] = pts[i]; }
    }
    var loop = [];
    for (var k = 0; k < buckets; k++) if (best[k]) loop.push(best[k]);
    return loop;
  }

  function ellipse(cu, cv, ru, rv, steps) {
    var out = [];
    steps = steps || 28;
    for (var i = 0; i < steps; i++) {
      var t = (i / steps) * Math.PI * 2;
      out.push({ u: cu + Math.cos(t) * ru, v: cv + Math.sin(t) * rv });
    }
    return out;
  }

  /* ------------------------------------------------------------------- frame */

  /**
   * Builds the anatomical frame. Returns null when the geometry is not
   * trustworthy, which the caller must treat as a hard failure.
   *
   * `landmarks` are normalised [0..1] against the work canvas.
   * `aspect` is workCanvas.width / workCanvas.height, needed so that angles
   * and distances are measured in square units rather than stretched ones.
   */
  function buildFrame(landmarks, sets, aspect) {
    if (!landmarks || landmarks.length < 468 || !sets) return null;

    /* Work in "square" space: x scaled by aspect so a circle stays a circle. */
    function sq(p) { return { x: p.x * aspect, y: p.y }; }
    function pick(idx) {
      var out = [];
      for (var i = 0; i < idx.length; i++) {
        var p = landmarks[idx[i]];
        if (!p) return null;
        out.push(sq(p));
      }
      return out;
    }

    var eyeA = pick(sets.eyeA), eyeB = pick(sets.eyeB);
    var browA = pick(sets.browA), browB = pick(sets.browB);
    if (!eyeA || !eyeB || !browA || !browB) return null;

    /* Ordered contour rings, straight from the model's own connection lists. */
    var ovalPts = pick(sets.ovalRing);
    var lipsRingPts = (sets.lipsRings || []).map(pick);
    if (!ovalPts || lipsRingPts.some(function (r) { return !r; })) return null;
    if (!lipsRingPts.length) return null;

    var cA = centroid(eyeA), cB = centroid(eyeB);

    /* Sides by image x only — never by the model's anatomical naming. */
    var left = cA.x <= cB.x ? cA : cB;
    var right = cA.x <= cB.x ? cB : cA;
    var browLeft = cA.x <= cB.x ? centroid(browA) : centroid(browB);
    var browRight = cA.x <= cB.x ? centroid(browB) : centroid(browA);

    var dx = right.x - left.x, dy = right.y - left.y;
    var scaleSq = Math.sqrt(dx * dx + dy * dy);
    if (!(scaleSq > 1e-6)) return null;

    var ex = { x: dx / scaleSq, y: dy / scaleSq };   // +u : image-right
    var ey = { x: -ex.y, y: ex.x };                  // +v : downward
    var origin = { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 };

    function toLocal(p) {
      var vx = p.x - origin.x, vy = p.y - origin.y;
      return { u: (vx * ex.x + vy * ex.y) / scaleSq,
               v: (vx * ey.x + vy * ey.y) / scaleSq };
    }
    /* Back to normalised image coordinates (undoing the aspect scaling). */
    function toImage(l) {
      var x = origin.x + (l.u * ex.x + l.v * ey.x) * scaleSq;
      var y = origin.y + (l.u * ex.y + l.v * ey.y) * scaleSq;
      return { x: x / aspect, y: y };
    }

    /* Ordered rings need no resampling — traversal order IS the outline. */
    var ovalLocal = ovalPts.map(toLocal);
    /* Of the two lip rings, the one enclosing more area is the outer one. */
    var lipsCandidates = lipsRingPts
      .map(function (r) { return r.map(toLocal); })
      .sort(function (p, q) { return area(q, 'u', 'v') - area(p, 'u', 'v'); });
    var lipsLocal = lipsCandidates[0];
    if (!lipsLocal || ovalLocal.length < 12 || lipsLocal.length < 8) return null;

    function extent(list, key) {
      var lo = Infinity, hi = -Infinity;
      for (var i = 0; i < list.length; i++) {
        if (list[i][key] < lo) lo = list[i][key];
        if (list[i][key] > hi) hi = list[i][key];
      }
      return { lo: lo, hi: hi };
    }

    var ovalV = extent(ovalLocal, 'v');
    var lipsV = extent(lipsLocal, 'v');
    var lipsU = extent(lipsLocal, 'u');
    var lipsC = (function () {
      var s = { x: 0, y: 0 };
      for (var i = 0; i < lipsLocal.length; i++) { s.x += lipsLocal[i].u; s.y += lipsLocal[i].v; }
      return { u: s.x / lipsLocal.length, v: s.y / lipsLocal.length };
    })();

    var vBrow = (toLocal(browLeft).v + toLocal(browRight).v) / 2;

    /* Eye outer corners: the point of each eye farthest from the centre line. */
    function outerCorner(pts) {
      var best = null, bestAbs = -1;
      for (var i = 0; i < pts.length; i++) {
        var l = toLocal(pts[i]);
        if (Math.abs(l.u) > bestAbs) { bestAbs = Math.abs(l.u); best = l; }
      }
      return best;
    }
    var cornerA = outerCorner(eyeA), cornerB = outerCorner(eyeB);
    var uEyeL = Math.min(cornerA.u, cornerB.u);
    var uEyeR = Math.max(cornerA.u, cornerB.u);

    /* --- the single index used by number, validated before trusting it ---- */
    var noseRaw = landmarks[NOSE_TIP];
    if (!noseRaw) return null;
    var nose = toLocal(sq(noseRaw));
    var noseSane = Math.abs(nose.u) < 0.40 && nose.v > vBrow + 0.15 && nose.v < lipsV.lo;
    if (!noseSane) return null;   // fail closed rather than mis-anchor the mid-face

    /* Face width at a given v, by ray-casting the oval polygon. */
    function widthAt(v) {
      var lo = Infinity, hi = -Infinity;
      for (var i = 0; i < ovalLocal.length; i++) {
        var a = ovalLocal[i], b = ovalLocal[(i + 1) % ovalLocal.length];
        if ((a.v - v) * (b.v - v) > 0) continue;         // segment does not cross v
        if (Math.abs(b.v - a.v) < 1e-9) continue;
        var t = (v - a.v) / (b.v - a.v);
        var u = a.u + t * (b.u - a.u);
        if (u < lo) lo = u;
        if (u > hi) hi = u;
      }
      if (lo === Infinity) return null;
      return { lo: lo, hi: hi };
    }

    /* Independent yaw check: face half-widths at eye level should match. */
    var wEye = widthAt(0);
    var asymmetry = null, asymSide = null;
    if (wEye) {
      var l = Math.abs(wEye.lo), r = Math.abs(wEye.hi);
      if (l + r > 1e-6) {
        asymmetry = Math.abs(l - r) / (l + r);
        /* The narrower half is the side the face is turned toward. */
        asymSide = l < r ? "left" : "right";
      }
    }

    return {
      scale: scaleSq / aspect,   // interocular distance as a fraction of image WIDTH
      origin: origin, ex: ex, ey: ey, aspect: aspect,
      toLocal: toLocal, toImage: toImage,
      ovalLocal: ovalLocal, lipsLocal: lipsLocal,
      widthAt: widthAt,
      asymmetry: asymmetry, asymSide: asymSide,
      anchors: {
        vTop: ovalV.lo, vChin: ovalV.hi, vBrow: vBrow, vNose: nose.v,
        vMouth: lipsC.v, vMouthTop: lipsV.lo, vMouthBottom: lipsV.hi,
        uMouthL: lipsU.lo, uMouthR: lipsU.hi,
        uEyeL: uEyeL, uEyeR: uEyeR,
        eyeLeft: toLocal(left), eyeRight: toLocal(right)
      }
    };
  }

  /* ----------------------------------------------------------------- sets */

  /**
   * Reads the authoritative index sets off the FaceLandmarker class.
   * eyeA/browA and eyeB/browB are the model's two sides; which one is which in
   * image space is decided later, from coordinates.
   */
  function buildSets(FaceLandmarker) {
    if (!FaceLandmarker) return null;
    try {
      var lipsRings = ringsFromConnections(FaceLandmarker.FACE_LANDMARKS_LIPS);
      var ovalRings = ringsFromConnections(FaceLandmarker.FACE_LANDMARKS_FACE_OVAL);
      /* Longest recovered ring is the face outline; if ring recovery ever fails
         we fall back to the unordered index list plus outerBoundary(). */
      ovalRings.sort(function (a, b) { return b.length - a.length; });
      var ovalRing = ovalRings[0];
      if (!ovalRing || ovalRing.length < 12) {
        ovalRing = uniqueIndices(FaceLandmarker.FACE_LANDMARKS_FACE_OVAL);
      }
      if (!lipsRings.length) lipsRings = [uniqueIndices(FaceLandmarker.FACE_LANDMARKS_LIPS)];

      return {
        lipsRings: lipsRings,
        ovalRing:  ovalRing,
        /* Eyes and brows are only used for centroids and extremes, so the
           unordered index list is enough. */
        eyeA:      uniqueIndices(FaceLandmarker.FACE_LANDMARKS_LEFT_EYE),
        eyeB:      uniqueIndices(FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE),
        browA:     uniqueIndices(FaceLandmarker.FACE_LANDMARKS_LEFT_EYEBROW),
        browB:     uniqueIndices(FaceLandmarker.FACE_LANDMARKS_RIGHT_EYEBROW)
      };
    } catch (e) { return null; }
  }

  /* --------------------------------------------------------------- regions */

  /* ==========================================================================
     Region catalogue — territory-locked, dose-curved
     --------------------------------------------------------------------------
     Two things changed here after a reviewer saw volume leak toward the nose
     and could not tell 1 ml from 2 ml.

     1. TERRITORY LOCKING. Every region declares a `territory` box in face-local
        units. The displacement field is ZERO on and outside that boundary, and
        the falloff happens INSIDE it. That reconciles two requirements that
        look contradictory: the region is hard-locked (nothing outside its
        territory can move, so lips can never reach the nose) and yet there is
        no visible edge (the field is already zero where the boundary is, so
        there is no step to see). The old design put the falloff OUTSIDE the
        region polygon, which is exactly how it reached neighbouring features.

     2. DOSE RESPONSE. `dose` maps millilitres to a factor on a non-linear
        curve, and `mmMax` is the surface projection in millimetres at factor
        1.0. Tissue does not respond linearly, and — more practically — a
        linear map made consecutive amounts visually indistinguishable. The
        curve shape below follows the reviewer's specification; per-region
        shapes should be tuned from clinical judgement, which is why `dose` is
        overridable per region rather than hard-coded once.

     `vol` still distributes the volume anatomically inside the territory, and
     `shape` still supplies the tangential vector. Both are unchanged in kind.
     ========================================================================== */

  /* Shared dose-response curve. Interpolated over an explicit table rather
     than a formula, so the numbers can be reviewed and argued with. */
  var DOSE_TABLE = [
    [0.00, 0.00],
    [0.25, 0.20],
    [0.50, 0.35],
    [0.75, 0.48],
    [1.00, 0.60],
    [1.25, 0.70],
    [1.50, 0.80],
    [2.00, 1.00]
  ];

  function doseFactor(ml, table) {
    var t = table || DOSE_TABLE;
    if (ml <= t[0][0]) return t[0][1];
    for (var i = 1; i < t.length; i++) {
      if (ml <= t[i][0]) {
        var a = t[i - 1], b = t[i];
        var k = (ml - a[0]) / (b[0] - a[0] || 1);
        return a[1] + (b[1] - a[1]) * k;
      }
    }
    return t[t.length - 1][1];
  }

  /* The discrete amounts offered in the UI. Each one is a distinct point on
     the curve, not a multiplier applied to one generic effect. */
  var DOSE_STEPS = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0];

  var CATALOGUE = [

    /* ---------------------------------------------------------------- lips */
    { key: 'lips', en: 'Lips', he: 'שפתיים', kind: 'filler', volume: true,
      mmMax: 4.2, op: 'volume', coreFalloff: 0.16, edgeFalloff: 0.20,
      /* Bounded below the nose and above the chin base: the perioral unit and
         nothing else. */
      territory: function (a) {
        return { uMin: -0.70, uMax: 0.70,
                 vMin: a.vNose + 0.26,
                 vMax: Math.min(a.vChin - 0.18, a.vMouthBottom + 0.40) };
      },
      vol: function (l, a) {
        var dv = l.v - a.vMouth;
        var upper = dv < 0;
        var band = 1 - Math.min(1, Math.abs(dv) / 0.22);
        var base = (upper ? 0.82 : 1.0) * (0.45 + 0.55 * band);
        var tub = Math.exp(-Math.pow((Math.abs(l.u) - 0.06) / 0.07, 2));
        if (!upper) base += 0.30 * tub;
        var bow = Math.exp(-Math.pow((Math.abs(l.u) - 0.09) / 0.06, 2));
        if (upper) base += 0.26 * bow;
        var corner = 1 - Math.min(1, Math.pow(Math.abs(l.u) / 0.46, 3));
        return base * (0.35 + 0.65 * corner);
      },
      shape: function (l, a) {
        var dv = l.v - a.vMouth;
        var fall = 1 - Math.min(1, Math.abs(dv) / 0.26);
        var vert = ramp(dv, 0.055) * fall * 0.85;
        var lat = ramp(l.u, 0.10) * Math.max(0, 1 - Math.abs(l.u) / 0.40) * 0.18;
        return { u: lat, v: vert };
      } },

    /* -------------------------------------------------------------- cheeks */
    { key: 'cheeks', en: 'Cheeks', he: 'לחיים', kind: 'filler', volume: true,
      pair: true, sided: true,
      mmMax: 3.4, op: 'volume', coreFalloff: 0.30, edgeFalloff: 0.34,
      /* Lateral midface only: starts clear of the nose and stops above the
         mouth line, so it cannot pull the perioral area or the nasal base. */
      territory: function (a, sign) {
        var lo = 0.26 * sign, hi = 1.45 * sign;
        /* Starts well BELOW the eye line: the malar region does not extend up
           to the orbit, and letting it do so put change on the eyelid. */
        return { uMin: Math.min(lo, hi), uMax: Math.max(lo, hi),
                 vMin: 0.20, vMax: a.vMouth - 0.02 };
      },
      vol: function (l, a) {
        var side = ramp(l.u, 0.14);
        var du = (l.u - 0.62 * side) / 0.46;
        var dv = (l.v - 0.42) / 0.40;
        var arch = Math.exp(-(du * du + dv * dv));
        var du2 = (l.u - 0.34 * side) / 0.34;
        var dv2 = (l.v - 0.74) / 0.34;
        var ant = 0.45 * Math.exp(-(du2 * du2 + dv2 * dv2));
        return Math.min(1.4, arch + ant);
      },
      shape: function (l, a) {
        var up = -0.55 * Math.max(0, 1 - Math.abs(l.v - 0.55) / 0.75);
        return { u: -ramp(l.u, 0.14) * 0.10, v: up };
      } },

    /* ---------------------------------------------------------------- chin */
    { key: 'chin', en: 'Chin', he: 'סנטר', kind: 'filler', volume: true,
      mmMax: 3.8, op: 'volume', coreFalloff: 0.20, edgeFalloff: 0.24,
      /* Mental region: below the lower lip, never up into the mouth. */
      territory: function (a) {
        /* The lower bound is generous on purpose: the chin vector points DOWN,
           so the territory has to contain where the warp sends the pixels, not
           just where the field is non-zero. */
        return { uMin: -0.62, uMax: 0.62,
                 vMin: a.vMouthBottom + 0.10,
                 vMax: a.vChin + 0.16 };
      },
      vol: function (l, a) {
        var dv = (l.v - (a.vChin - 0.18)) / 0.34;
        var du = l.u / 0.40;
        return Math.exp(-(du * du * 0.9 + dv * dv));
      },
      shape: function (l, a) {
        return { u: 0, v: Math.max(0, 1 - Math.abs(l.u) / 0.5) * 0.45 };
      } },

    /* ------------------------------------------------------------- jawline */
    { key: 'jawline', en: 'Jawline', he: 'קו לסת', kind: 'filler', volume: true,
      pair: true, sided: true,
      mmMax: 2.8, op: 'volume', coreFalloff: 0.18, edgeFalloff: 0.22,
      /* Mandibular border only: lateral, below the mouth line, stopping at the
         jaw so the neck and the midface stay out of it. */
      territory: function (a, sign) {
        var lo = 0.28 * sign, hi = 1.35 * sign;
        return { uMin: Math.min(lo, hi), uMax: Math.max(lo, hi),
                 vMin: a.vMouth + 0.04, vMax: a.vChin + 0.16 };
      },
      vol: function (l, a) {
        var along = Math.max(0, 1 - Math.abs(l.v - (a.vMouth + 0.42)) / 0.60);
        var lateral = Math.min(1, Math.abs(l.u) / 0.55);
        return along * (0.35 + 0.65 * lateral);
      },
      shape: function (l, a) {
        return { u: ramp(l.u, 0.16) * 0.75, v: 0.22 };
      } },

    /* ---------------------------------------------------------- nasolabial */
    { key: 'nasolabial', en: 'Nasolabial folds', he: 'קמטים סביב הפה',
      kind: 'filler', volume: true, pair: true, sided: true,
      mmMax: 2.0, op: 'volume', coreFalloff: 0.16, edgeFalloff: 0.18,
      territory: function (a, sign) {
        var lo = 0.16 * sign, hi = 0.78 * sign;
        return { uMin: Math.min(lo, hi), uMax: Math.max(lo, hi),
                 vMin: a.vNose - 0.16, vMax: a.vMouth + 0.22 };
      },
      vol: function (l, a) {
        var dv = (l.v - (a.vNose + a.vMouth) / 2) / 0.34;
        var du = (Math.abs(l.u) - 0.40) / 0.20;
        return Math.exp(-(du * du + dv * dv));
      },
      shape: function (l, a) {
        return { u: -ramp(l.u, 0.12) * 0.25, v: -0.45 };
      } },

    /* -------------------------------------------------- expression areas */
    { key: 'forehead', en: 'Forehead', he: 'קמטי מצח', kind: 'botox',
      op: 'soften', soften: 1.0, coreFalloff: 0.22, edgeFalloff: 0.26,
      territory: function (a) {
        return { uMin: -1.20, uMax: 1.20, vMin: a.vTop - 0.20, vMax: a.vBrow - 0.06 };
      } },

    { key: 'glabella', en: 'Glabella', he: 'קמטים בין הגבות', kind: 'botox',
      op: 'soften', soften: 1.0, coreFalloff: 0.14, edgeFalloff: 0.16,
      territory: function (a) {
        return { uMin: -0.40, uMax: 0.40, vMin: a.vBrow - 0.42, vMax: a.vBrow + 0.16 };
      } },

    { key: 'crowsFeet', en: "Crow's feet", he: 'קמטים בצדי העיניים', kind: 'botox',
      op: 'soften', soften: 0.9, coreFalloff: 0.14, edgeFalloff: 0.16, pair: true,
      /* Lateral to the orbit: never medial, so the eye itself is outside. */
      territory: function (a, sign) {
        var inner = (sign < 0 ? a.uEyeL : a.uEyeR);
        var outer = 1.30 * sign;
        return { uMin: Math.min(inner, outer), uMax: Math.max(inner, outer),
                 vMin: -0.40, vMax: 0.50 };
      } }
  ];

  /**
   * Builds the polygon(s) for one region, in LOCAL coordinates.
   * Every number below is a multiple of interocular distance, positioned
   * against anchors measured on this face — never against the image.
   */
  function polygonsFor(key, frame) {
    var a = frame.anchors;
    var wAt = frame.widthAt;
    var out = [];

    function sideWidth(v, sign) {
      var w = wAt(v);
      if (!w) return sign < 0 ? -1.0 : 1.0;
      return sign < 0 ? w.lo : w.hi;
    }

    if (key === 'lips') {
      /* The detected lip outline, grown slightly so the feather has somewhere
         to fall off without eating into the vermillion border. */
      var c = { u: (a.uMouthL + a.uMouthR) / 2, v: a.vMouth };
      out.push(frame.lipsLocal.map(function (p) {
        return { u: c.u + (p.u - c.u) * 1.14, v: c.v + (p.v - c.v) * 1.20 };
      }));
      return out;
    }

    if (key === 'chin') {
      var top = a.vMouthBottom + 0.10;
      var bottom = a.vChin;
      out.push(ellipse(0, (top + bottom) / 2, 0.44, Math.max(0.12, (bottom - top) / 2 * 1.02)));
      return out;
    }

    if (key === 'forehead') {
      var lo = a.vTop;
      var hi = a.vBrow - 0.14;
      if (hi <= lo) hi = lo + 0.2;
      var poly = [];
      var steps = 14;
      for (var i = 0; i <= steps; i++) {              // along the top arc
        var v = lo + (hi - lo) * (i / steps);
        poly.push({ u: sideWidth(v, -1) * 0.94, v: v });
      }
      for (var j = steps; j >= 0; j--) {              // back along the other side
        var v2 = lo + (hi - lo) * (j / steps);
        poly.push({ u: sideWidth(v2, 1) * 0.94, v: v2 });
      }
      out.push(poly);
      return out;
    }

    if (key === 'glabella') {
      out.push(ellipse(0, a.vBrow - 0.02, 0.22, 0.30));
      return out;
    }

    if (key === 'crowsFeet') {
      [-1, 1].forEach(function (s) {
        var u = s < 0 ? a.uEyeL : a.uEyeR;
        out.push(ellipse(u + 0.20 * s, 0.04, 0.24, 0.22));
      });
      return out;
    }

    if (key === 'cheeks') {
      [-1, 1].forEach(function (s) {
        var uEye = s < 0 ? a.uEyeL : a.uEyeR;
        var uMouth = s < 0 ? a.uMouthL : a.uMouthR;
        var vHi = a.vMouth - 0.10;
        out.push([
          { u: uEye * 0.92,                  v: 0.30 },
          { u: sideWidth(0.42, s) * 0.96,    v: 0.42 },
          { u: sideWidth(vHi, s) * 0.94,     v: vHi },
          { u: uMouth * 1.02,                v: a.vMouth - 0.14 },
          { u: (a.vNose ? 0.30 : 0.30) * s,  v: a.vNose - 0.02 },
          { u: 0.34 * s,                     v: 0.24 }
        ]);
      });
      return out;
    }

    if (key === 'nasolabial') {
      [-1, 1].forEach(function (s) {
        var uMouth = s < 0 ? a.uMouthL : a.uMouthR;
        var vMid = (a.vNose + a.vMouth) / 2;
        out.push([
          { u: 0.22 * s,            v: a.vNose - 0.04 },
          { u: 0.40 * s,            v: vMid },
          { u: uMouth * 1.10,       v: a.vMouth + 0.06 },
          { u: uMouth * 1.24,       v: a.vMouth + 0.02 },
          { u: 0.52 * s,            v: vMid - 0.04 },
          { u: 0.34 * s,            v: a.vNose - 0.10 }
        ]);
      });
      return out;
    }

    if (key === 'jawline') {
      /* A ribbon that follows the detected lower face oval, offset inward.
         Split at the chin so each side can be shifted along its own normal. */
      var lower = frame.ovalLocal.filter(function (p) { return p.v > a.vMouth + 0.02; });
      if (lower.length < 6) return out;
      [-1, 1].forEach(function (s) {
        var arc = lower.filter(function (p) { return s < 0 ? p.u <= 0.02 : p.u >= -0.02; });
        if (arc.length < 3) return;
        arc.sort(function (p, q) { return p.v - q.v; });
        var inner = arc.map(function (p) {
          var k = 1 - 0.17 / Math.max(0.35, Math.abs(p.u) + Math.abs(p.v));
          return { u: p.u * k, v: p.v - 0.05 };
        }).reverse();
        out.push(arc.concat(inner));
      });
      return out;
    }

    return out;
  }

  /**
   * Full region set for a face: polygons in local AND image space, plus the
   * outward direction used by the deformation.
   */
  function build(frame) {
    if (!frame) return null;
    var regions = {};
    CATALOGUE.forEach(function (def) {
      var polysLocal = polygonsFor(def.key, frame);
      if (!polysLocal.length) return;
      var parts = polysLocal.map(function (poly) {
        var image = poly.map(frame.toImage);
        var cu = 0, cv = 0;
        poly.forEach(function (p) { cu += p.u; cv += p.v; });
        cu /= poly.length; cv /= poly.length;
        /* Outward = away from the face centre line, in image space. */
        var sign = cu >= 0 ? 1 : -1;
        /* Sign is decided from the part's own centroid, so a paired region
           gets the correct mirrored territory without any left/right naming. */
        var sideSign = cu >= 0 ? 1 : -1;
        var terr = def.territory ? def.territory(frame.anchors, sideSign) : null;
        return {
          local: poly,
          image: image,
          territory: terr,
          sideSign: sideSign,
          /* absolute local-v line past which this part's mask is erased */
          clipBelowV: def.clipBelowBrow != null
            ? frame.anchors.vBrow - def.clipBelowBrow
            : null,
          centroidLocal: { u: cu, v: cv },
          centroidImage: frame.toImage({ u: cu, v: cv }),
          outward: { u: sign, v: 0 },
          sign: sign
        };
      });
      regions[def.key] = { def: def, parts: parts };
    });
    return regions;
  }

  return {
    buildSets: buildSets,
    buildFrame: buildFrame,
    build: build,
    CATALOGUE: CATALOGUE,
    DOSE_TABLE: DOSE_TABLE,
    DOSE_STEPS: DOSE_STEPS,
    doseFactor: doseFactor,
    NOSE_TIP: NOSE_TIP,
    ramp: ramp,
    ringsFromConnections: ringsFromConnections,
    outerBoundary: outerBoundary,
    centroid: centroid
  };
})();
