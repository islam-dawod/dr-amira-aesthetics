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

    frame.ovalLocal.forEach(function (l) {
      var out = frame.toImage({ u: l.u * 1.55, v: l.v * 1.55 });
      verts.push({ x: out.x * W, y: out.y * H });
      depth.push(ringZ);
      pinned.push(true);
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
  function smoothOffsets(mesh, offs, iterations, lambda) {
    var n = offs.length;
    var adj = mesh.adjacency;
    if (!adj) return;
    for (var it = 0; it < iterations; it++) {
      var next = new Array(n);
      for (var i = 0; i < n; i++) {
        if (mesh.pinned[i]) { next[i] = { x: 0, y: 0, z: 0 }; continue; }
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

    /* centroid of the landmarks only — the anchors would drag it outward */
    var c = { x: 0, y: 0, z: 0 };
    for (var j = 0; j < mesh.landmarkCount; j++) {
      c.x += P[j].x; c.y += P[j].y; c.z += P[j].z;
    }
    c.x /= mesh.landmarkCount; c.y /= mesh.landmarkCount; c.z /= mesh.landmarkCount;
    /* push the reference behind the surface so normals face outward */
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
    mesh.cameraSpace = P;
    return out;
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

  /**
   * Weight in [0,1] for one vertex against one region, in face-local units.
   * `feather` is wide on purpose: the transition has to be longer than the eye
   * can resolve as an edge, which is exactly what a mask could never give us.
   */
  function regionWeight(local, polys, feather) {
    var best = Infinity;
    for (var i = 0; i < polys.length; i++) {
      var d = sdPolygon(local, polys[i]);
      if (d < best) best = d;
    }
    return 1 - smoothstep(0, feather, best);
  }

  /* --------------------------------------------------------- deformation */

  /**
   * Computes displaced 2D vertex positions.
   *
   * `plan` is a list of {regionKey, mm, profile} where mm is the intended
   * surface projection in millimetres and profile carries the product-derived
   * shape multipliers (or the neutral defaults).
   */
  function deform(mesh, regions, plan) {
    var W = mesh.W;
    var iodPx = mesh.frame.scale * W;
    var pxPerMm = iodPx / IOD_MM;

    var n = mesh.verts.length;
    var moved = new Array(n);
    var offs = new Array(n);
    for (var i = 0; i < n; i++) offs[i] = { x: 0, y: 0, z: 0 };

    /* local coordinates once per vertex */
    var local = new Array(n);
    for (var v = 0; v < n; v++) {
      local[v] = mesh.frame.toLocal({
        x: (mesh.verts[v].x / W) * mesh.frame.aspect,
        y: mesh.verts[v].y / mesh.H
      });
    }

    plan.forEach(function (item) {
      var region = regions[item.regionKey];
      if (!region) return;
      var def = region.def;
      var prof = item.profile || {};
      var polys = region.parts.map(function (p) { return p.local; });
      var feather = (def.transition || 0.40) * (prof.spread || 1);
      var mmProj = item.mm * (prof.projection || 1);

      for (var k = 0; k < n; k++) {
        if (mesh.pinned[k]) continue;
        var w = regionWeight(local[k], polys, feather);
        /* Identity by construction: the field is zero at the eyes, nose and
           brows, so they cannot be dragged even when several regions overlap. */
        if (mesh.protect) w *= mesh.protect[k];
        if (w <= 0.002) continue;

        var lp = local[k];
        var nrm = mesh.normals[k];

        /* Anatomical distribution of the volume. A cheek filler does not add an
           even shell over the cheek: it peaks at the zygomatic arch and thins
           out. `vol` puts the peak where the anatomy puts it. */
        var volMul = def.vol ? def.vol(lp, mesh.frame.anchors, prof) : 1;
        if (volMul <= 0) continue;

        var amp = mmProj * pxPerMm * w * volMul / W;   // camera-space units

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
        moved[k] = true;
      }
    });

    /* Smoothing spreads offsets to immediate neighbours, so anything adjacent
       to a moved vertex must be reprojected too. */
    for (var q = 0; q < n; q++) {
      if (!moved[q] || mesh.pinned[q]) continue;
      var nb = mesh.adjacency ? mesh.adjacency[q] : null;
      if (nb) for (var r = 0; r < nb.length; r++) if (!mesh.pinned[nb[r]]) moved[nb[r]] = true;
    }
    smoothOffsets(mesh, offs, 4, 0.60);

    /* Ceiling on the total offset. Several regions at once can superpose into a
       displacement no anatomy would support; clamping keeps the mesh valid
       instead of leaving the audit to reject the whole preview. */
    var maxOff = 0.085;                    // camera-space units, ~5.4mm at IOD 63
    for (var cl = 0; cl < n; cl++) {
      var o = offs[cl];
      var mag = Math.sqrt(o.x * o.x + o.y * o.y + o.z * o.z);
      if (mag > maxOff) {
        var f2 = maxOff / mag;
        o.x *= f2; o.y *= f2; o.z *= f2;
      }
    }

    /* reproject */
    var out = new Array(n);
    for (var m = 0; m < n; m++) {
      if (!moved[m]) { out[m] = mesh.verts[m]; continue; }
      var P = mesh.cameraSpace[m];
      out[m] = project(mesh, {
        x: P.x + offs[m].x,
        y: P.y + offs[m].y,
        z: P.z + offs[m].z
      });
    }
    return out;
  }

  /* ------------------------------------------------------------ rendering */

  /**
   * Warps the source image triangle by triangle. Each destination triangle is
   * filled by the affine map that carries its source triangle onto it, so the
   * original pixels are resampled and the texture is preserved exactly.
   */
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
    var selected = {};
    plan.forEach(function (it) { selected[it.regionKey] = true; });
    var identityLimit = iodPx * 0.012;
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
    deform: deform,
    render: render,
    audit: audit,
    auditPixels: auditPixels,
    regionWeight: regionWeight,
    sdPolygon: sdPolygon
  };
})();
