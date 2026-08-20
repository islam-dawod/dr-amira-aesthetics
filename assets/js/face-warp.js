/* ==========================================================================
   face-warp.js — 3D mesh deformation for the AMEERA DABAJA AI Visual Simulation
   --------------------------------------------------------------------------
   WHY THIS REPLACED THE MASK-AND-BLUR APPROACH

   The previous engine rasterised a feathered mask per region and displaced
   pixels inside it. That reads as a layer sitting on the photo, for three
   reasons that are inherent to the method and cannot be tuned away:

     1. a mask has a boundary, and a boundary is visible;
     2. displacing pixels in the image plane adds area, not volume — there is
        no cue that a surface came toward the viewer;
     3. blur-based softening destroys the pores and micro-shadows that make
        skin read as skin.

   This module does something structurally different. It builds a real 3D
   surface from the 478 landmarks (MediaPipe returns relative depth per
   point), moves VERTICES along their surface normals, reprojects them through
   a weak-perspective camera, and warps the original pixels triangle by
   triangle. Consequences, by construction rather than by tuning:

     * No mask and no boundary. Displacement is a smooth field evaluated at
       every vertex and interpolated linearly across triangles, so it decays
       continuously to zero. There is nowhere for an edge to appear.
     * Volume, not area. Moving a vertex along its normal changes its depth as
       well as its position. Reprojection then magnifies it slightly — which
       is the actual optical signature of a surface coming forward. Where the
       surface faces the camera the change is mostly depth, so pixels barely
       move; where it is oblique they slide. That asymmetry is what the eye
       reads as volume.
     * Texture survives untouched. A geometric warp resamples the original
       pixels. Pores, freckles, stubble, make-up and specular highlights are
       carried along instead of being averaged away.
     * The background cannot move. Anchor vertices ringing the face and the
       image border carry zero displacement, so every triangle out there has
       an identity transform.

   The amounts are expressed in millimetres of surface projection, converted
   through an assumed interocular distance, and remain a visual SCENARIO. No
   claim is made that a given millilitre of a given product produces this.
   ========================================================================== */
window.AmiraFaceWarp = (function () {
  'use strict';

  /* Assumed adult interocular distance, used only to turn millimetres of
     projection into image units. Individual variation is real; this is a
     scenario scale, not a measurement of the visitor. */
  var IOD_MM = 63;

  /* Weak-perspective focal length in image-width units. Governs how much
     forward projection converts into local magnification. */
  var FOCAL = 2.0;

  /* ------------------------------------------------------------ geometry */

  function sub(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
  function cross(a, b) {
    return { x: a.y * b.z - a.z * b.y,
             y: a.z * b.x - a.x * b.z,
             z: a.x * b.y - a.y * b.x };
  }
  function norm(v) {
    var m = Math.hypot(v.x, v.y, v.z) || 1;
    return { x: v.x / m, y: v.y / m, z: v.z / m };
  }
  function dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }

  /* ------------------------------------------------- Delaunay (Bowyer-Watson)
     Triangulates the landmark cloud plus the anchor ring plus the image
     border, so the mesh covers the whole frame in one connected surface. */
  function triangulate(pts) {
    var n = pts.length;
    if (n < 3) return [];

    /* super-triangle large enough to contain everything */
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < n; i++) {
      if (pts[i].x < minX) minX = pts[i].x;
      if (pts[i].x > maxX) maxX = pts[i].x;
      if (pts[i].y < minY) minY = pts[i].y;
      if (pts[i].y > maxY) maxY = pts[i].y;
    }
    var dx = maxX - minX, dy = maxY - minY;
    var dmax = Math.max(dx, dy) * 12 + 100;
    var midx = (minX + maxX) / 2, midy = (minY + maxY) / 2;
    var verts = pts.slice();
    verts.push({ x: midx - dmax, y: midy - dmax },
               { x: midx + dmax, y: midy - dmax },
               { x: midx, y: midy + dmax });

    var tris = [[n, n + 1, n + 2]];

    function circum(t) {
      var a = verts[t[0]], b = verts[t[1]], c = verts[t[2]];
      var ax = a.x, ay = a.y, bx = b.x, by = b.y, cx = c.x, cy = c.y;
      var d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
      if (Math.abs(d) < 1e-12) return null;
      var ux = ((ax * ax + ay * ay) * (by - cy) +
                (bx * bx + by * by) * (cy - ay) +
                (cx * cx + cy * cy) * (ay - by)) / d;
      var uy = ((ax * ax + ay * ay) * (cx - bx) +
                (bx * bx + by * by) * (ax - cx) +
                (cx * cx + cy * cy) * (bx - ax)) / d;
      var r2 = (ax - ux) * (ax - ux) + (ay - uy) * (ay - uy);
      return { x: ux, y: uy, r2: r2 };
    }

    for (var p = 0; p < n; p++) {
      var bad = [], keep = [];
      for (var t = 0; t < tris.length; t++) {
        var cc = circum(tris[t]);
        if (cc && (verts[p].x - cc.x) * (verts[p].x - cc.x) +
                  (verts[p].y - cc.y) * (verts[p].y - cc.y) < cc.r2 - 1e-9) {
          bad.push(tris[t]);
        } else keep.push(tris[t]);
      }
      /* boundary edges of the bad set */
      var edges = [];
      bad.forEach(function (tr) {
        edges.push([tr[0], tr[1]], [tr[1], tr[2]], [tr[2], tr[0]]);
      });
      var boundary = [];
      for (var e = 0; e < edges.length; e++) {
        var shared = false;
        for (var f = 0; f < edges.length; f++) {
          if (e === f) continue;
          if ((edges[e][0] === edges[f][1] && edges[e][1] === edges[f][0]) ||
              (edges[e][0] === edges[f][0] && edges[e][1] === edges[f][1])) { shared = true; break; }
        }
        if (!shared) boundary.push(edges[e]);
      }
      boundary.forEach(function (ed) { keep.push([ed[0], ed[1], p]); });
      tris = keep;
    }

    /* drop anything still touching the super-triangle */
    return tris.filter(function (t) {
      return t[0] < n && t[1] < n && t[2] < n;
    });
  }

  /* ------------------------------------------------------------ the mesh */

  /**
   * Builds the deformable mesh.
   *
   * Vertex layout:
   *   [0 .. 477]        the landmarks
   *   [478 .. +ring]    an anchor ring around the face, displacement pinned to 0
   *   [.. +border]      image corners and edge midpoints, also pinned
   *
   * Because the pinned vertices surround the face and the weight field has
   * already decayed to zero before reaching them, every triangle outside the
   * ring maps identically and the background is provably untouched.
   */
  /**
   * Per-vertex protection multiplier, 0 at a guarded landmark and rising
   * smoothly to 1 further away.
   *
   * The eyes, nose and brows define who the person is. Relying on the identity
   * audit to CATCH them moving means the visitor gets a refusal instead of a
   * preview; attenuating the field around them means they simply do not move.
   * The multiplier is a smooth function of distance, so folding the protection
   * into the weight keeps the field smooth.
   */
  function buildProtection(mesh, frame, guardIdx, radius) {
    var n = mesh.verts.length;
    var out = new Float32Array(n);
    for (var i = 0; i < n; i++) out[i] = 1;
    if (!guardIdx || !guardIdx.length) return out;

    var W = mesh.W, H = mesh.H, aspect = frame.aspect;
    function localOf(idx) {
      return frame.toLocal({ x: (mesh.verts[idx].x / W) * aspect, y: mesh.verts[idx].y / H });
    }
    var guards = [];
    for (var g = 0; g < guardIdx.length; g++) {
      if (guardIdx[g] < mesh.landmarkCount) guards.push(localOf(guardIdx[g]));
    }
    if (!guards.length) return out;

    var r = radius || 0.22;
    for (var v = 0; v < n; v++) {
      var lv = localOf(v);
      var best = Infinity;
      for (var k = 0; k < guards.length; k++) {
        var du = lv.u - guards[k].u, dv = lv.v - guards[k].v;
        var d = du * du + dv * dv;
        if (d < best) best = d;
      }
      out[v] = smoothstep(0, r, Math.sqrt(best));
    }
    return out;
  }

  function buildMesh(landmarks, frame, W, H, guardIdx) {
    if (!landmarks || !frame) return null;

    var verts = [];       // {x, y} in pixels — the 2D projection
    var depth = [];       // z in pixels (image-width units * W)
    var pinned = [];

    for (var i = 0; i < landmarks.length; i++) {
      var p = landmarks[i];
      verts.push({ x: p.x * W, y: p.y * H });
      depth.push(p.z * W);
      pinned.push(false);
    }
    var landmarkCount = landmarks.length;

    /* anchor ring: the detected face oval pushed outward, at the oval's own
       mean depth so it does not distort the surface normals near the rim */
    var meanRimZ = 0, rimN = 0;
    frame.ovalLocal.forEach(function (l) {
      var img = frame.toImage(l);
      /* nearest landmark depth is a good enough rim depth */
      meanRimZ += 0; rimN++;
    });
    var ringZ = 0;
    for (var k = 0; k < landmarks.length; k++) ringZ += landmarks[k].z * W;
    ringZ /= Math.max(1, landmarks.length);

    /* Two pinned rings, not one.
       The far ring alone left very large triangles bridging the face to it, and
       a single moved vertex smears its displacement across the whole triangle
       it belongs to. Measured on the chin: the field was perfectly locked (zero
       moved vertices outside the territory) yet pixel change still reached far
       past it, purely through those big triangles. A ring hugging the face
       bounds that smear to the gap between the face and the ring. */
    [1.06, 1.30, 1.70].forEach(function (scale) {
      frame.ovalLocal.forEach(function (l) {
        var out = frame.toImage({ u: l.u * scale, v: l.v * scale });
        verts.push({ x: out.x * W, y: out.y * H });
        depth.push(ringZ);
        pinned.push(true);
      });
    });

    /* image border, so the triangulation covers the whole frame */
    var border = [];
    for (var s = 0; s <= 6; s++) {
      var t = s / 6;
      border.push({ x: t * W, y: 0 }, { x: t * W, y: H },
                  { x: 0, y: t * H }, { x: W, y: t * H });
    }
    border.forEach(function (b) {
      verts.push({ x: b.x, y: b.y });
      depth.push(ringZ);
      pinned.push(true);
    });

    var tris = triangulate(verts);
    if (!tris.length) return null;

    /* Drop degenerate slivers.
       MediaPipe's landmark cloud contains near-coincident points (the iris ring
       especially), and Delaunay turns those into needle triangles — one
       measured case had edges of 8.3, 8.7 and 0.44 pixels. Such a triangle
       covers no visible area, but a sub-pixel differential displacement flips
       its orientation, which the fold audit then reports and the whole preview
       is refused over a triangle nobody could see. Removing them is safe: the
       renderer draws the undeformed image first, so a sub-pixel gap is simply
       the original pixels. */
    var iodPx = frame.scale * W;
    var minEdge = Math.max(1.2, iodPx * 0.008);
    var minArea = minEdge * minEdge;
    var before = tris.length;
    tris = tris.filter(function (t) {
      var a = verts[t[0]], b = verts[t[1]], c = verts[t[2]];
      var e1 = Math.hypot(b.x - a.x, b.y - a.y);
      var e2 = Math.hypot(c.x - b.x, c.y - b.y);
      var e3 = Math.hypot(a.x - c.x, a.y - c.y);
      if (Math.min(e1, e2, e3) < minEdge) return false;
      var ar = Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
      return ar >= minArea;
    });
    if (!tris.length) return null;

    var mesh = {
      verts: verts, depth: depth, pinned: pinned, tris: tris,
      landmarkCount: landmarkCount, W: W, H: H, frame: frame,
      minEdge: minEdge, minArea: minArea,
      trianglesDropped: before - tris.length
    };
    mesh.normals = computeNormals(mesh);
    mesh.adjacency = buildAdjacency(tris, verts.length);
    mesh.protect = buildProtection(mesh, frame, guardIdx, 0.20);
    return mesh;
  }

  /** Neighbour lists, used to smooth the displacement field. */
  function buildAdjacency(tris, n) {
    var adj = new Array(n);
    for (var i = 0; i < n; i++) adj[i] = [];
    function link(a, b) { if (adj[a].indexOf(b) < 0) adj[a].push(b); }
    tris.forEach(function (t) {
      link(t[0], t[1]); link(t[1], t[0]);
      link(t[1], t[2]); link(t[2], t[1]);
      link(t[2], t[0]); link(t[0], t[2]);
    });
    return adj;
  }

  /**
   * Laplacian smoothing of the offset field.
   *
   * The landmark cloud contains very thin triangles (the lip rings sit close
   * together, the iris points closer still). If neighbouring vertices receive
   * noticeably different offsets, such a sliver can invert — which the audit
   * catches as a mesh fold and refuses to display. Averaging each offset toward
   * its neighbours removes exactly that high-frequency variation while leaving
   * the overall shape intact. Pinned vertices stay at zero, so the field still
   * decays to nothing at the rim.
   */
  function smoothOffsets(mesh, offs, iterations, lambda, frozen) {
    var n = offs.length;
    var adj = mesh.adjacency;
    if (!adj) return;
    for (var it = 0; it < iterations; it++) {
      var next = new Array(n);
      for (var i = 0; i < n; i++) {
        /* Pinned anchors, and anything outside every active territory, are
           held at zero. Without this the smoothing pass walks offsets back
           across the territory boundary and quietly defeats the lock — which
           is measurable: it put ~5% of the change outside the treated area. */
        if (mesh.pinned[i] || (frozen && frozen[i])) { next[i] = { x: 0, y: 0, z: 0 }; continue; }
        var nb = adj[i];
        if (!nb || !nb.length) { next[i] = offs[i]; continue; }
        var ax = 0, ay = 0, az = 0;
        for (var k = 0; k < nb.length; k++) {
          ax += offs[nb[k]].x; ay += offs[nb[k]].y; az += offs[nb[k]].z;
        }
        ax /= nb.length; ay /= nb.length; az /= nb.length;
        next[i] = {
          x: offs[i].x * (1 - lambda) + ax * lambda,
          y: offs[i].y * (1 - lambda) + ay * lambda,
          z: offs[i].z * (1 - lambda) + az * lambda
        };
      }
      for (var m = 0; m < n; m++) offs[m] = next[m];
    }
  }

  /** Un-projects a vertex to camera space (units of image width). */
  function unproject(mesh, i) {
    var W = mesh.W;
    var u = mesh.verts[i].x / W - 0.5;
    var v = (mesh.verts[i].y - mesh.H / 2) / W;
    var d = mesh.depth[i] / W;
    var Z = FOCAL + d;
    return { x: u * Z / FOCAL, y: v * Z / FOCAL, z: Z };
  }

  /** Projects a camera-space point back to pixels. */
  function project(mesh, P) {
    var W = mesh.W;
    var u = P.x * FOCAL / P.z;
    var v = P.y * FOCAL / P.z;
    return { x: (u + 0.5) * W, y: v * W + mesh.H / 2 };
  }

  /**
   * Per-vertex surface normals, from the triangulation in 3D. Oriented
   * outward using the head centroid as the interior reference.
   */
  function computeNormals(mesh) {
    var n = mesh.verts.length;
    var P = new Array(n);
    for (var i = 0; i < n; i++) P[i] = unproject(mesh, i);
    mesh.cameraSpace = P;
    /* normalsFrom() carries the construction, so the deformed surface and the
       original surface are measured by exactly the same rule */
    return normalsFrom(mesh, P);
  }

  /* ------------------------------------------------------- weight field */

  /** Signed distance from a point to a polygon; negative inside. */
  function sdPolygon(pt, poly) {
    var d = Infinity, inside = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var a = poly[j], b = poly[i];
      var ex = b.u - a.u, ey = b.v - a.v;
      var wx = pt.u - a.u, wy = pt.v - a.v;
      var t = Math.max(0, Math.min(1, (wx * ex + wy * ey) / (ex * ex + ey * ey || 1e-9)));
      var cx = wx - ex * t, cy = wy - ey * t;
      d = Math.min(d, cx * cx + cy * cy);
      if (((b.v > pt.v) !== (a.v > pt.v)) &&
          (pt.u < (a.u - b.u) * (pt.v - b.v) / (a.v - b.v) + b.u)) inside = !inside;
    }
    return (inside ? -1 : 1) * Math.sqrt(d);
  }

  function smoothstep(edge0, edge1, x) {
    var t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0 || 1e-9)));
    return t * t * (3 - 2 * t);
  }

  /** Depth inside an axis-aligned territory box; negative outside. */
  function insideBox(local, box) {
    return Math.min(local.u - box.uMin, box.uMax - local.u,
                    local.v - box.vMin, box.vMax - local.v);
  }

  /**
   * Weight in [0,1] for one vertex, against one region's core polygons AND its
   * territory box.
   *
   * The territory is a hard lock: the weight is exactly zero on and outside its
   * boundary, so a lips plan cannot move the nose no matter what the falloff
   * does. The falloff then happens INSIDE the territory, which is what keeps
   * the field edgeless — the value is already zero where the boundary is, so
   * there is no step to see.
   *
   * That combination is the point. The previous version faded outward FROM the
   * core polygon with no outer limit, which is precisely how volume reached
   * neighbouring features.
   */
  function regionWeight(local, polys, coreFalloff, territory, edgeFalloff) {
    var wEdge = 1;
    if (territory) {
      var depth = insideBox(local, territory);
      if (depth <= 0) return 0;                       // hard lock
      wEdge = smoothstep(0, edgeFalloff || coreFalloff, depth);
      if (wEdge <= 0) return 0;
    }
    var best = Infinity;
    for (var i = 0; i < polys.length; i++) {
      var d = sdPolygon(local, polys[i]);
      if (d < best) best = d;
    }
    var wCore = 1 - smoothstep(0, coreFalloff, best);
    return wCore * wEdge;
  }

  /* --------------------------------------------------------- deformation */

  /**
   * Computes displaced 2D vertex positions.
   *
   * `plan` is a list of {regionKey, mm, profile} where mm is the intended
   * surface projection in millimetres and profile carries the product-derived
   * shape multipliers (or the neutral defaults).
   */
  /* ==========================================================================
     deform — one independent field per region, composed at the end
     --------------------------------------------------------------------------
     Each selected region is solved on its own: its own weight field, its own
     territory freeze, its own smoothing pass, and its own calibration. Only
     then are the fields added together. Two reasons this matters:

       * ISOLATION. A region's field is built and smoothed without any other
         region in the array, so adding a second area cannot change the first
         one's shape. Composing at the end is the only place they interact, and
         there they simply sum.

       * CALIBRATION. Laplacian smoothing flattens a peak - measured at about
         half - so before this change a region whose model asked for 3.4 mm of
         projection delivered 1.5 mm, and consecutive amounts landed closer
         together than the dose curve said they should. Each field is now
         rescaled so its PEAK DISPLACEMENT equals the millimetres the dose curve
         asked for. `mmMax` therefore means what it claims: peak tissue
         displacement at dose factor 1.0.

     Rescaling cannot break containment: the field is already exactly zero on
     and outside the territory boundary, and multiplying zero by anything is
     still zero.
     ========================================================================== */
  function deform(mesh, regions, plan, detail) {
    var W = mesh.W;
    var iodPx = mesh.frame.scale * W;
    var pxPerMm = iodPx / IOD_MM;

    var n = mesh.verts.length;
    var moved = new Array(n);
    /* Peak region weight per vertex, across every region in the plan. The
       shading pass reuses it, so shading is masked by exactly the field that
       moved the geometry - it can never reach a pixel the displacement was not
       allowed to touch. */
    var wMax = new Float32Array(n);
    var total = new Array(n);
    for (var i = 0; i < n; i++) total[i] = { x: 0, y: 0, z: 0 };

    /* local coordinates once per vertex */
    var local = new Array(n);
    for (var v = 0; v < n; v++) {
      local[v] = mesh.frame.toLocal({
        x: (mesh.verts[v].x / W) * mesh.frame.aspect,
        y: mesh.verts[v].y / mesh.H
      });
    }

    var activeBoxes = [];
    var calib = {};

    plan.forEach(function (item) {
      var region = regions[item.regionKey];
      if (!region) return;
      var def = region.def;
      var prof = item.profile || {};
      var mmProj = item.mm * (prof.projection || 1);
      var coreF = (def.coreFalloff || 0.18) * (prof.spread || 1);
      var edgeF = (def.edgeFalloff || coreF);

      /* ---- this region's own field, in isolation ---------------------- */
      var offs = new Array(n);
      for (var z = 0; z < n; z++) offs[z] = { x: 0, y: 0, z: 0 };
      var touched = new Array(n);
      var boxes = [];

      /* Each part carries its own territory, so a paired region locks each side
         separately and a side-specific plan can skip one of them entirely. */
      region.parts.forEach(function (part) {
        if (item.side === 'left' && part.sideSign > 0) return;
        if (item.side === 'right' && part.sideSign < 0) return;
        var polys = [part.local];
        var terr = part.territory;
        if (terr) { boxes.push(terr); activeBoxes.push(terr); }

        for (var k = 0; k < n; k++) {
          if (mesh.pinned[k]) continue;
          var w = regionWeight(local[k], polys, coreF, terr, edgeF);
          /* Identity by construction: the field is zero at the eyes, nose and
             brows, so they cannot be dragged even when several regions
             overlap. */
          if (mesh.protect) w *= mesh.protect[k];
          if (w <= 0.002) continue;
          if (w > wMax[k]) wMax[k] = w;

          var lp = local[k];
          var nrm = mesh.normals[k];

          /* Anatomical distribution of the volume. A cheek filler does not add
             an even shell over the cheek: it peaks at the zygomatic arch and
             thins out. `vol` puts the peak where the anatomy puts it. */
          var volMul = def.vol ? def.vol(lp, mesh.frame.anchors, prof) : 1;
          if (volMul <= 0) continue;

          /* Shape of the field only. The millimetre scale is applied after
             smoothing, by calibration, so smoothing losses cannot silently
             shrink the dose. */
          var amp = w * volMul;

          /* 1. volume: along the surface normal. This is the part that reads as
                projection rather than as a wider patch. */
          offs[k].x += nrm.x * amp;
          offs[k].y += nrm.y * amp;
          offs[k].z += nrm.z * amp;

          /* 2. anatomical shaping, per region, in the face's own frame */
          var shape = def.shape ? def.shape(lp, mesh.frame.anchors, w, prof) : null;
          if (shape) {
            var t = amp * (def.shapeGain == null ? 1 : def.shapeGain);
            offs[k].x += shape.u * t;
            offs[k].y += shape.v * t;
          }
          touched[k] = true;
          moved[k] = true;
        }
      });

      /* Smoothing spreads offsets to immediate neighbours, so anything adjacent
         to a moved vertex must be reprojected too. */
      for (var q = 0; q < n; q++) {
        if (!touched[q] || mesh.pinned[q]) continue;
        var nb = mesh.adjacency ? mesh.adjacency[q] : null;
        if (nb) for (var r = 0; r < nb.length; r++) {
          if (!mesh.pinned[nb[r]]) { touched[nb[r]] = true; moved[nb[r]] = true; }
        }
      }

      /* Vertices outside THIS region's territory stay at zero through the
         smoothing pass. The field has already tapered to zero at the boundary,
         so clamping there is continuous and does not reintroduce a step. */
      var frozen = null;
      if (boxes.length) {
        frozen = new Uint8Array(n);
        for (var fz = 0; fz < n; fz++) {
          var insideAny = false;
          for (var b = 0; b < boxes.length; b++) {
            if (insideBox(local[fz], boxes[b]) > 0) { insideAny = true; break; }
          }
          if (!insideAny) frozen[fz] = 1;
        }
      }

      smoothOffsets(mesh, offs, 4, 0.60, frozen);

      /* ---- calibration: peak displacement == the millimetres asked for ---- */
      var peak = 0;
      for (var pk = 0; pk < n; pk++) {
        var o = offs[pk];
        var mag = Math.sqrt(o.x * o.x + o.y * o.y + o.z * o.z);
        if (mag > peak) peak = mag;
      }
      var targetUnits = mmProj * pxPerMm / W;      // camera-space units
      var scale = peak > 1e-7 ? targetUnits / peak : 0;
      calib[item.regionKey] = { targetMm: +mmProj.toFixed(2),
                                fieldPeak: +peak.toFixed(5),
                                scale: +scale.toFixed(3) };
      if (scale > 0) {
        for (var sc = 0; sc < n; sc++) {
          total[sc].x += offs[sc].x * scale;
          total[sc].y += offs[sc].y * scale;
          total[sc].z += offs[sc].z * scale;
        }
      }
    });

    /* Ceiling on the composed offset. Several regions at once can superpose
       into a displacement no anatomy would support; clamping keeps the mesh
       valid instead of leaving the audit to reject the whole preview. */
    var maxOff = 0.085;                    // camera-space units, ~5.4mm at IOD 63
    for (var cl = 0; cl < n; cl++) {
      var oc = total[cl];
      var magc = Math.sqrt(oc.x * oc.x + oc.y * oc.y + oc.z * oc.z);
      if (magc > maxOff) {
        var f2 = maxOff / magc;
        oc.x *= f2; oc.y *= f2; oc.z *= f2;
      }
    }

    /* ---- fold relief -------------------------------------------------
       Two neighbouring vertices can be pushed past each other and invert a
       triangle, which renders as a crease. The audit rejects that, and
       rejecting is the right default - but a single inverted sliver out of a
       thousand triangles should not cost the visitor the whole preview when
       easing that one neighbourhood fixes it. So we look for inversions and
       damp the offsets of the vertices involved, repeatedly, keeping every
       other vertex at full strength. Only local displacement is reduced, never
       the field elsewhere, and the audit still has the last word. */
    var areaFloor2 = (mesh.minArea || 1) * 2;
    function projectAll() {
      var pj = new Array(n);
      for (var pi = 0; pi < n; pi++) {
        var Pp = mesh.cameraSpace[pi];
        if (!moved[pi]) { pj[pi] = mesh.verts[pi]; continue; }
        pj[pi] = project(mesh, { x: Pp.x + total[pi].x,
                                 y: Pp.y + total[pi].y,
                                 z: Pp.z + total[pi].z });
      }
      return pj;
    }
    for (var pass = 0; pass < 6; pass++) {
      var proj = projectAll();
      var bad = null;
      for (var ti = 0; ti < mesh.tris.length; ti++) {
        var tt = mesh.tris[ti];
        var sa = signedArea(mesh.verts[tt[0]], mesh.verts[tt[1]], mesh.verts[tt[2]]);
        if (Math.abs(sa) < areaFloor2) continue;
        var da = signedArea(proj[tt[0]], proj[tt[1]], proj[tt[2]]);
        if (sa !== 0 && da !== 0 && (sa > 0) !== (da > 0)) {
          if (!bad) bad = new Uint8Array(n);
          bad[tt[0]] = 1; bad[tt[1]] = 1; bad[tt[2]] = 1;
        }
      }
      if (!bad) break;
      for (var bi = 0; bi < n; bi++) {
        if (!bad[bi]) continue;
        total[bi].x *= 0.5; total[bi].y *= 0.5; total[bi].z *= 0.5;
      }
    }

    /* reproject */
    var out = new Array(n);
    var cam = new Array(n);
    for (var m = 0; m < n; m++) {
      var P = mesh.cameraSpace[m];
      if (!moved[m]) { out[m] = mesh.verts[m]; cam[m] = P; continue; }
      cam[m] = { x: P.x + total[m].x, y: P.y + total[m].y, z: P.z + total[m].z };
      out[m] = project(mesh, cam[m]);
    }
    if (detail) {
      detail.camera = cam;
      detail.weight = wMax;
      detail.offsets = total;
      detail.calibration = calib;
    }
    return out;
  }

  /* ------------------------------------------------------------ rendering */

  /**
   * Warps the source image triangle by triangle. Each destination triangle is
   * filled by the affine map that carries its source triangle onto it, so the
   * original pixels are resampled and the texture is preserved exactly.
   */
  /* ==========================================================================
     Shading — the other half of the geometry
     --------------------------------------------------------------------------
     A mesh warp can only show displacement that happens ACROSS the image. When
     filler adds projection, most of the movement is TOWARD THE CAMERA, and a
     pure texture warp cannot draw that at all: measured on this engine, only
     14-50% of the planned projection appeared as pixel motion, and on smooth
     skin such as a cheek the remainder was invisible. That is why two amounts
     could look alike even though the meshes genuinely differed.

     Real tissue reads as volume because light meets the raised surface at a new
     angle: a soft highlight on the projection, a soft falloff under it. So the
     honest fix is not to exaggerate the warp - it is to draw the shading the
     new surface normals already imply.

     Three properties make this a geometric result rather than a cosmetic layer:

       1. The light is MEASURED, not chosen. We fit the photograph's own
          luminance against the ORIGINAL surface normals, and re-evaluate that
          same fitted function on the deformed normals. Nothing is invented; if
          the fit does not hold, shading is skipped and reported.
       2. It is MULTIPLICATIVE. Scaling a neighbourhood preserves the ratios
          inside it, so pores, hair and make-up survive - which is what the
          texture audit checks.
       3. It is MASKED BY THE SAME WEIGHT FIELD as the displacement. Where the
          region weight is zero the ratio is exactly 1.0, so shading cannot
          reach one pixel further than the warp is already allowed to: the
          background stays byte-identical and protected anatomy stays untouched.

     The change is also bounded (SHADE_MAX), so it can never turn into a
     whitening or blurring pass no matter what a caller asks for.
     ========================================================================== */

  var SHADE_MAX = 0.16;         /* hard ceiling on |ratio - 1| */

  /* Rec.709 luminance: the channel a change in incident light acts on. */
  function lum(r, g, b) { return 0.2126 * r + 0.7152 * g + 0.0722 * b; }

  /* Normals for an arbitrary set of camera-space points, using the mesh's own
     topology. Same construction as computeNormals, which now delegates here. */
  function normalsFrom(mesh, P) {
    var n = P.length;
    var c = { x: 0, y: 0, z: 0 };
    for (var j = 0; j < mesh.landmarkCount; j++) {
      c.x += P[j].x; c.y += P[j].y; c.z += P[j].z;
    }
    c.x /= mesh.landmarkCount; c.y /= mesh.landmarkCount; c.z /= mesh.landmarkCount;
    c.z += 0.35;

    var acc = new Array(n);
    for (var a = 0; a < n; a++) acc[a] = { x: 0, y: 0, z: 0 };
    mesh.tris.forEach(function (t) {
      var nv = cross(sub(P[t[1]], P[t[0]]), sub(P[t[2]], P[t[0]]));
      for (var q = 0; q < 3; q++) {
        acc[t[q]].x += nv.x; acc[t[q]].y += nv.y; acc[t[q]].z += nv.z;
      }
    });

    var out = new Array(n);
    for (var v = 0; v < n; v++) {
      var nn = norm(acc[v]);
      if (dot(nn, sub(P[v], c)) < 0) { nn.x = -nn.x; nn.y = -nn.y; nn.z = -nn.z; }
      out[v] = nn;
    }
    return out;
  }

  /* Solve a small dense system by Gaussian elimination with partial pivoting.
     Returns null when the matrix is too ill-conditioned to trust. */
  function solveDense(A, b, size) {
    var i, j, k;
    var M = [];
    for (i = 0; i < size; i++) {
      M.push(A[i].slice());
      M[i].push(b[i]);
    }
    for (i = 0; i < size; i++) {
      var piv = i;
      for (k = i + 1; k < size; k++) if (Math.abs(M[k][i]) > Math.abs(M[piv][i])) piv = k;
      if (Math.abs(M[piv][i]) < 1e-9) return null;
      var tmp = M[i]; M[i] = M[piv]; M[piv] = tmp;
      for (k = i + 1; k < size; k++) {
        var f = M[k][i] / M[i][i];
        for (j = i; j <= size; j++) M[k][j] -= f * M[i][j];
      }
    }
    var x = new Array(size);
    for (i = size - 1; i >= 0; i--) {
      var s = M[i][size];
      for (j = i + 1; j < size; j++) s -= M[i][j] * x[j];
      x[i] = s / M[i][i];
    }
    return x;
  }

  /* Fit the photograph's shading: L(p) ~ c0 + c . n(p), sampled at the face
     landmarks using their ORIGINAL normals. This is the standard first-order
     (Lambertian-plus-ambient) form, and every coefficient comes out of the
     image. Returns a not-ok result - meaning "do not shade" - if the model does
     not actually explain this photograph. */
  function estimateLighting(baseData, mesh, W, H) {
    var A = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
    var rhs = [0, 0, 0, 0];
    var samples = [];

    for (var i = 0; i < mesh.landmarkCount; i++) {
      var px = Math.round(mesh.verts[i].x), py = Math.round(mesh.verts[i].y);
      if (px < 0 || py < 0 || px >= W || py >= H) continue;
      var o = (py * W + px) * 4;
      var Lv = lum(baseData[o], baseData[o + 1], baseData[o + 2]);
      var nn = mesh.normals[i];
      var row = [1, nn.x, nn.y, nn.z];
      samples.push({ row: row, L: Lv });
      for (var r = 0; r < 4; r++) {
        for (var c2 = 0; c2 < 4; c2++) A[r][c2] += row[r] * row[c2];
        rhs[r] += row[r] * Lv;
      }
    }
    if (samples.length < 80) return { ok: false, reason: 'too_few_samples' };

    /* light ridge term: keeps the system solvable on near-degenerate normal
       distributions without biasing a well-conditioned fit */
    for (var d = 0; d < 4; d++) A[d][d] += 1e-3 * samples.length;

    var x = solveDense(A, rhs, 4);
    if (!x) return { ok: false, reason: 'singular' };

    var c0 = x[0], cx = x[1], cy = x[2], cz = x[3];
    if (!isFinite(c0) || !isFinite(cx) || !isFinite(cy) || !isFinite(cz)) {
      return { ok: false, reason: 'non_finite' };
    }

    /* how much of the image's variation the fit explains */
    var mean = 0, n2 = samples.length;
    for (var m = 0; m < n2; m++) mean += samples[m].L;
    mean /= n2;
    var ssTot = 0, ssRes = 0;
    for (var s2 = 0; s2 < n2; s2++) {
      var rw = samples[s2].row;
      var pred = c0 * rw[0] + cx * rw[1] + cy * rw[2] + cz * rw[3];
      ssRes += (samples[s2].L - pred) * (samples[s2].L - pred);
      ssTot += (samples[s2].L - mean) * (samples[s2].L - mean);
    }
    var r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
    var dirMag = Math.sqrt(cx * cx + cy * cy + cz * cz);

    /* Refuse to shade an image whose luminance the surface orientation does not
       explain (flat studio light, heavy blow-out, or a bad normal field). Better
       to show geometry only than to paint a highlight the photograph
       contradicts. */
    if (!(c0 > 1) || dirMag < 0.5 || r2 < 0.05) {
      return { ok: false, reason: 'weak_fit', r2: +r2.toFixed(3),
               dirMag: +dirMag.toFixed(2) };
    }
    return { ok: true, c0: c0, c: { x: cx, y: cy, z: cz },
             r2: +r2.toFixed(3), dirMag: +dirMag.toFixed(2), samples: n2 };
  }

  /* Per-vertex multiplicative shading ratio: the fitted shading function
     re-evaluated on the deformed normal, divided by its value on the original
     normal, faded by the region weight and clamped. */
  function shadeRatios(mesh, n0, n1, light, weight) {
    var n = n0.length;
    var out = new Float32Array(n);
    for (var i = 0; i < n; i++) out[i] = 1;
    if (!light || !light.ok) return out;

    var c0 = light.c0, c = light.c;
    for (var v = 0; v < n; v++) {
      var w = weight ? weight[v] : 1;
      if (w <= 0.002) continue;
      var a = c0 + c.x * n0[v].x + c.y * n0[v].y + c.z * n0[v].z;
      var b = c0 + c.x * n1[v].x + c.y * n1[v].y + c.z * n1[v].z;
      if (!(a > 1)) continue;                       /* nothing to scale */
      var ratio = b / a;
      if (!isFinite(ratio)) continue;
      var delta = (ratio - 1) * w;
      if (delta > SHADE_MAX) delta = SHADE_MAX;
      if (delta < -SHADE_MAX) delta = -SHADE_MAX;
      out[v] = 1 + delta;
    }
    return out;
  }

  /* Rasterise the ratio over the DEFORMED triangles with barycentric
     interpolation and multiply it into the pixels. Vertices shared between
     triangles carry one ratio each, so the interpolated field is continuous
     across every internal edge: no faceting and no seams. Where the ratio is
     1.0 the pixel is left exactly as it was. */
  function applyShading(ctx, mesh, dstVerts, ratios, W, H) {
    var changed = 0;
    var img = ctx.getImageData(0, 0, W, H);
    var px = img.data;
    var tris = mesh.tris;

    for (var i = 0; i < tris.length; i++) {
      var t = tris[i];
      var r0 = ratios[t[0]], r1 = ratios[t[1]], r2 = ratios[t[2]];
      if (r0 === 1 && r1 === 1 && r2 === 1) continue;

      var p0 = dstVerts[t[0]], p1 = dstVerts[t[1]], p2 = dstVerts[t[2]];
      var minX = Math.max(0, Math.floor(Math.min(p0.x, p1.x, p2.x)));
      var maxX = Math.min(W - 1, Math.ceil(Math.max(p0.x, p1.x, p2.x)));
      var minY = Math.max(0, Math.floor(Math.min(p0.y, p1.y, p2.y)));
      var maxY = Math.min(H - 1, Math.ceil(Math.max(p0.y, p1.y, p2.y)));
      if (maxX < minX || maxY < minY) continue;

      var det = (p1.x - p0.x) * (p2.y - p0.y) - (p2.x - p0.x) * (p1.y - p0.y);
      if (Math.abs(det) < 1e-9) continue;

      for (var y = minY; y <= maxY; y++) {
        for (var x = minX; x <= maxX; x++) {
          var dx = x + 0.5 - p0.x, dy = y + 0.5 - p0.y;
          var l1 = (dx * (p2.y - p0.y) - dy * (p2.x - p0.x)) / det;
          if (l1 < 0 || l1 > 1) continue;
          var l2 = (dy * (p1.x - p0.x) - dx * (p1.y - p0.y)) / det;
          if (l2 < 0 || l2 > 1) continue;
          var l0 = 1 - l1 - l2;
          if (l0 < 0) continue;

          var f = r0 * l0 + r1 * l1 + r2 * l2;
          if (f === 1) continue;

          var o = (y * W + x) * 4;
          var nr = px[o] * f, ng = px[o + 1] * f, nb = px[o + 2] * f;
          px[o]     = nr < 0 ? 0 : nr > 255 ? 255 : nr;
          px[o + 1] = ng < 0 ? 0 : ng > 255 ? 255 : ng;
          px[o + 2] = nb < 0 ? 0 : nb > 255 ? 255 : nb;
          changed++;
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    return changed;
  }

  function render(srcCanvas, ctx, mesh, dstVerts) {
    var W = mesh.W, H = mesh.H;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(srcCanvas, 0, 0);      // undeformed base, so gaps cannot show

    var src = mesh.verts;
    var tris = mesh.tris;

    for (var i = 0; i < tris.length; i++) {
      var t = tris[i];
      var s0 = src[t[0]], s1 = src[t[1]], s2 = src[t[2]];
      var d0 = dstVerts[t[0]], d1 = dstVerts[t[1]], d2 = dstVerts[t[2]];

      /* skip triangles that did not move at all */
      if (d0 === s0 && d1 === s1 && d2 === s2) continue;

      /* expand by a hair so neighbouring triangles overlap instead of
         leaving hairline seams from anti-aliasing */
      var cx = (d0.x + d1.x + d2.x) / 3, cy = (d0.y + d1.y + d2.y) / 3;
      var g = 0.6;
      var e0 = grow(d0, cx, cy, g), e1 = grow(d1, cx, cy, g), e2 = grow(d2, cx, cy, g);

      var denom = (s1.x - s0.x) * (s2.y - s0.y) - (s2.x - s0.x) * (s1.y - s0.y);
      if (Math.abs(denom) < 1e-8) continue;

      var a = ((d1.x - d0.x) * (s2.y - s0.y) - (d2.x - d0.x) * (s1.y - s0.y)) / denom;
      var b = ((d1.y - d0.y) * (s2.y - s0.y) - (d2.y - d0.y) * (s1.y - s0.y)) / denom;
      var c = ((d2.x - d0.x) * (s1.x - s0.x) - (d1.x - d0.x) * (s2.x - s0.x)) / denom;
      var d = ((d2.y - d0.y) * (s1.x - s0.x) - (d1.y - d0.y) * (s2.x - s0.x)) / denom;
      var e = d0.x - a * s0.x - c * s0.y;
      var f = d0.y - b * s0.x - d * s0.y;

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(e0.x, e0.y);
      ctx.lineTo(e1.x, e1.y);
      ctx.lineTo(e2.x, e2.y);
      ctx.closePath();
      ctx.clip();
      ctx.setTransform(a, b, c, d, e, f);
      ctx.drawImage(srcCanvas, 0, 0);
      ctx.restore();
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  function grow(p, cx, cy, g) {
    var dx = p.x - cx, dy = p.y - cy;
    var m = Math.hypot(dx, dy) || 1;
    return { x: p.x + dx / m * g, y: p.y + dy / m * g };
  }

  /* ------------------------------------------------------------- auditing */

  /**
   * Pre-display checks. Any failure means no preview at all — a plausible
   * looking artefact is worse than a refusal, because the visitor cannot tell.
   */
  function audit(mesh, dstVerts, regions, plan) {
    var problems = [];
    var W = mesh.W, H = mesh.H;
    var iodPx = mesh.frame.scale * W;

    /* --- geometry: no triangle may fold over itself --------------------- */
    var flipped = 0, maxShift = 0;
    var src = mesh.verts;
    var areaFloor = (mesh.minArea || 1) * 2;   // signedArea is twice the area
    mesh.tris.forEach(function (t) {
      var s = signedArea(src[t[0]], src[t[1]], src[t[2]]);
      var d = signedArea(dstVerts[t[0]], dstVerts[t[1]], dstVerts[t[2]]);
      /* Below the mesh's own degeneracy floor an orientation change cannot
         produce a visible artefact; the same threshold is used at build time so
         the two stay consistent. */
      if (Math.abs(s) < areaFloor) return;
      if (s !== 0 && d !== 0 && (s > 0) !== (d > 0)) flipped++;
    });
    for (var i = 0; i < src.length; i++) {
      var sh = Math.hypot(dstVerts[i].x - src[i].x, dstVerts[i].y - src[i].y);
      if (sh > maxShift) maxShift = sh;
    }
    if (flipped > 0) {
      problems.push({ code: 'mesh_fold', message: flipped + ' triangles inverted' });
    }
    /* a displacement larger than a quarter of the interocular distance is not
       a subtle simulation any more, whatever the slider says */
    if (maxShift > iodPx * 0.25) {
      problems.push({ code: 'displacement',
                      message: 'peak shift ' + Math.round(maxShift) + 'px exceeds limit' });
    }

    /* --- pinned vertices must be exactly pinned ------------------------ */
    var leaked = 0;
    for (var p = 0; p < src.length; p++) {
      if (!mesh.pinned[p]) continue;
      if (dstVerts[p] !== src[p]) leaked++;
    }
    if (leaked) problems.push({ code: 'anchor_moved', message: leaked + ' anchors displaced' });

    /* --- identity: features that were not selected must not move -------- */
    var guarded = { eyes: [33, 133, 263, 362], nose: [1, 6, 197], brows: [70, 105, 300, 334] };
    /* The reviewer's acceptance criterion is under one pixel of drift at the
       nose and eyes. The protection field makes the field exactly zero at these
       landmarks, so measured drift is 0.000 px and this limit has headroom to
       spare - which is the reason to set it at the criterion rather than above
       it. If a future change starts moving them at all, this fails. */
    var identityLimit = 1.0;
    Object.keys(guarded).forEach(function (feature) {
      guarded[feature].forEach(function (idx) {
        if (idx >= mesh.landmarkCount) return;
        var sh = Math.hypot(dstVerts[idx].x - src[idx].x, dstVerts[idx].y - src[idx].y);
        if (sh > identityLimit) {
          problems.push({ code: 'identity_' + feature,
                          message: feature + ' moved ' + sh.toFixed(1) + 'px' });
        }
      });
    });

    return { ok: problems.length === 0, problems: problems,
             metrics: { triangles: mesh.tris.length, flipped: flipped,
                        maxShiftPx: +maxShift.toFixed(1),
                        maxShiftMm: +(maxShift / (iodPx / IOD_MM)).toFixed(2) } };
  }

  function signedArea(a, b, c) {
    return (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
  }

  /**
   * Post-render checks that need pixels: the background must be byte-identical
   * and the texture must not have been smoothed away.
   */
  function auditPixels(baseData, outData, mesh, W, H) {
    var problems = [];

    /* background: sample outside the anchor ring */
    var f = mesh.frame;
    var outside = 0, checked = 0;
    for (var y = 2; y < H; y += 7) {
      for (var x = 2; x < W; x += 7) {
        var l = f.toLocal({ x: (x / W) * f.aspect, y: y / H });
        var r = Math.hypot(l.u, l.v * 0.75);
        if (r < 2.6) continue;                 // inside the face neighbourhood
        checked++;
        var i = (y * W + x) << 2;
        if (Math.abs(baseData[i] - outData[i]) > 1 ||
            Math.abs(baseData[i + 1] - outData[i + 1]) > 1 ||
            Math.abs(baseData[i + 2] - outData[i + 2]) > 1) outside++;
      }
    }
    if (checked > 0 && outside / checked > 0.002) {
      problems.push({ code: 'background_changed',
                      message: outside + '/' + checked + ' background samples differ' });
    }

    /* texture: local variance inside the face must not collapse */
    var vBase = localVariance(baseData, W, H, f);
    var vOut = localVariance(outData, W, H, f);
    if (vBase > 4 && vOut < vBase * 0.55) {
      problems.push({ code: 'texture_lost',
                      message: 'detail dropped from ' + vBase.toFixed(1) + ' to ' + vOut.toFixed(1) });
    }

    return { ok: problems.length === 0, problems: problems,
             metrics: { backgroundDiff: outside + '/' + checked,
                        textureBefore: +vBase.toFixed(1), textureAfter: +vOut.toFixed(1) } };
  }

  /**
   * Difference-map containment audit.
   *
   * Builds the per-pixel change between original and preview and checks WHERE
   * it landed. The territory lock should make this vacuous — the field is zero
   * outside the selected territories by construction — which is exactly why it
   * is worth asserting: it turns the design claim into a regression test. If a
   * future change to the weight function lets volume escape toward the nose,
   * this fails instead of shipping.
   */
  function auditContainment(baseData, outData, mesh, regions, plan, W, H, maxShiftPx, softenKeys) {
    var f = mesh.frame;
    var problems = [], metrics = {};
    var iodPx = f.scale * W;

    /* Union of every TREATED territory, honouring side selection. Softening
       regions count too — they are treated areas as well, just by a different
       operation, and leaving them out made their legitimate change register as
       an escape. */
    var boxes = [];
    plan.forEach(function (item) {
      var region = regions[item.regionKey];
      if (!region) return;
      region.parts.forEach(function (part) {
        if (item.side === 'left' && part.sideSign > 0) return;
        if (item.side === 'right' && part.sideSign < 0) return;
        if (part.territory) boxes.push(part.territory);
      });
    });
    (softenKeys || []).forEach(function (key) {
      var region = regions[key];
      if (!region) return;
      region.parts.forEach(function (part) {
        if (part.territory) boxes.push(part.territory);
      });
    });
    if (!boxes.length) return { ok: true, problems: [], metrics: {} };

    /* Tolerance has to account for the warp itself. A displacement of d moves
       content by up to d, so change can legitimately appear up to d beyond the
       boundary of the region whose field produced it. Measuring without this
       would flag the geometry of warping rather than an escape of the field. */
    var tol = 0.05 + (maxShiftPx || 0) / Math.max(1, iodPx);
    function inAnyBox(l) {
      for (var i = 0; i < boxes.length; i++) {
        var b = boxes[i];
        if (l.u >= b.uMin - tol && l.u <= b.uMax + tol &&
            l.v >= b.vMin - tol && l.v <= b.vMax + tol) return true;
      }
      return false;
    }

    var inside = 0, outside = 0, worstOutside = 0, worstAt = null;
    for (var y = 1; y < H; y += 3) {
      for (var x = 1; x < W; x += 3) {
        var i = (y * W + x) << 2;
        var d = Math.abs(baseData[i] - outData[i]) +
                Math.abs(baseData[i + 1] - outData[i + 1]) +
                Math.abs(baseData[i + 2] - outData[i + 2]);
        if (d <= 9) continue;                       // resampling noise floor
        var l = f.toLocal({ x: (x / W) * f.aspect, y: y / H });
        if (inAnyBox(l)) inside++;
        else {
          outside++;
          if (d > worstOutside) { worstOutside = d; worstAt = { x: x, y: y }; }
        }
      }
    }
    var total = inside + outside;
    metrics.changedSamples = total;
    metrics.outsideTerritory = outside;
    metrics.outsidePct = total ? +(outside / total * 100).toFixed(2) : 0;
    metrics.worstOutsideDelta = worstOutside;
    if (worstAt) metrics.worstOutsideAt = worstAt;

    /* A couple of stray samples can come from bilinear resampling on the
       territory edge; a real leak is not a couple of samples. */
    if (total > 40 && metrics.outsidePct > 2.0) {
      problems.push({ code: 'leaked_outside_region',
                      message: metrics.outsidePct + '% of the change fell outside the treated territory' });
    }
    /* ------------------------------------------------------------------
       Cross-region isolation.

       The box test above answers "did the field stay home". This answers the
       question that was actually asked: does treating one area disturb a
       DIFFERENT named area? For every region not in the plan, sample inside its
       core and compare. This is the check that a lips plan touching the nose,
       or a chin plan inflating the cheeks, would fail.
       ------------------------------------------------------------------ */
    var selected = {};
    plan.forEach(function (it) { selected[it.regionKey] = true; });
    (softenKeys || []).forEach(function (k) { selected[k] = true; });
    var intruded = [], unmeasured = [];
    Object.keys(regions).forEach(function (key) {
      if (selected[key]) return;
      var parts = regions[key].parts;
      var hits = 0, samples = 0, peak = 0, overlapped = 0;
      parts.forEach(function (part) {
        /* sample the interior of this region's own core polygon */
        var c = part.centroidImage;
        var rad = Math.max(4, Math.round(iodPx * 0.10));
        var cx = Math.round(c.x * W), cy = Math.round(c.y * H);
        for (var y = cy - rad; y <= cy + rad; y += 2) {
          for (var x = cx - rad; x <= cx + rad; x += 2) {
            if (x < 0 || y < 0 || x >= W || y >= H) continue;
            /* Adjacent areas share ground: the chin's territory and the
               jawline's overlap along the anterior mandible. A sample that lies
               inside a TREATED territory is inside the treated area by
               definition, so counting it as an intrusion would make the audit
               contradict the catalogue and no adjacent pair could ever pass.
               What must stay untouched is the part of this region that no
               treated territory covers, and that is what we measure. */
            var lp = f.toLocal({ x: (x / W) * f.aspect, y: y / H });
            if (inAnyBox(lp)) { overlapped++; continue; }
            samples++;
            var i = (y * W + x) << 2;
            var d = Math.abs(baseData[i] - outData[i]) +
                    Math.abs(baseData[i + 1] - outData[i + 1]) +
                    Math.abs(baseData[i + 2] - outData[i + 2]);
            if (d > peak) peak = d;
            if (d > 24) hits++;
          }
        }
      });
      /* A region whose whole core sits inside a treated territory cannot be
         judged. Say so rather than record a pass nobody measured. */
      if (!samples) {
        if (overlapped) unmeasured.push(key);
        return;
      }
      var pct = hits / samples * 100;
      if (pct > 6) intruded.push(key + ' (' + pct.toFixed(1) + '% of its core, peak ' + peak + ')');
    });
    metrics.untreatedRegionsDisturbed = intruded.length ? intruded : 'none';
    if (unmeasured.length) metrics.untreatedRegionsUnmeasurable = unmeasured;
    if (intruded.length) {
      problems.push({ code: 'disturbed_other_region',
                      message: 'change reached untreated areas: ' + intruded.join('; ') });
    }

    return { ok: problems.length === 0, problems: problems, metrics: metrics };
  }

  function localVariance(data, W, H, f) {
    var sum = 0, n = 0;
    for (var y = 4; y < H - 4; y += 5) {
      for (var x = 4; x < W - 4; x += 5) {
        var l = f.toLocal({ x: (x / W) * f.aspect, y: y / H });
        if (Math.hypot(l.u, l.v * 0.75) > 1.1) continue;   // face interior only
        var i = (y * W + x) << 2;
        var c = data[i];
        var d1 = data[i + 4] - c;
        var d2 = data[i + (W << 2)] - c;
        sum += Math.abs(d1) + Math.abs(d2);
        n += 2;
      }
    }
    return n ? sum / n : 0;
  }

  return {
    IOD_MM: IOD_MM,
    FOCAL: FOCAL,
    triangulate: triangulate,
    smoothOffsets: smoothOffsets,
    buildMesh: buildMesh,
    buildProtection: buildProtection,
    computeNormals: computeNormals,
    normalsFrom: normalsFrom,
    estimateLighting: estimateLighting,
    shadeRatios: shadeRatios,
    applyShading: applyShading,
    SHADE_MAX: SHADE_MAX,
    deform: deform,
    render: render,
    audit: audit,
    auditPixels: auditPixels,
    auditContainment: auditContainment,
    insideBox: insideBox,
    regionWeight: regionWeight,
    sdPolygon: sdPolygon
  };
})();
