/* Shared synthetic-face builder for the browser tests.
   Drawn in code, so the true position of every feature is known and the
   assertions can be made against ground truth instead of by eye. */
window.__mkFace = function (opts) {
  opts = opts || {};
  var W = 700, H = 900;
  var c = document.createElement('canvas');
  c.width = W; c.height = H;
  var g = c.getContext('2d');
  var GT = {
    eyeL: { x: 268, y: 372 }, eyeR: { x: 432, y: 372 },
    eyeOuterL: 232, eyeOuterR: 468, browY: 330,
    noseTip: { x: 350, y: 470 },
    /* Wider and flatter than a first guess: at halfW 62 / halfH 26 the drawn
       mouth scored mouthPucker 0.77, so the fixture was not a neutral face and
       the expression gate was right to refuse it. */
    mouth: { x: 350, y: 585, halfW: 84, halfH: 19 },
    chinY: 700, faceCx: 350, faceCy: 450, faceRx: 165, faceRy: 250, faceTop: 200
  };

  g.fillStyle = '#d8d2cc'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#e8c4a8';
  g.beginPath(); g.roundRect(298, 660, 104, 190, 40); g.fill();
  var sk = g.createRadialGradient(320, 360, 30, 350, 450, 300);
  sk.addColorStop(0, '#f6dcc4'); sk.addColorStop(1, '#dcb494');
  g.fillStyle = sk;
  g.beginPath(); g.ellipse(350, 450, 165, 250, 0, 0, 7); g.fill();
  g.fillStyle = '#3b2d2a';
  g.beginPath(); g.ellipse(350, 246, 177, 96, 0, Math.PI, 0); g.fill();

  g.strokeStyle = '#4a3730'; g.lineWidth = 11; g.lineCap = 'round';
  [[268, -1], [432, 1]].forEach(function (p) {
    g.beginPath();
    g.moveTo(p[0] - 40 * p[1], 336);
    g.quadraticCurveTo(p[0], 318, p[0] + 38 * p[1], 332);
    g.stroke();
  });
  [GT.eyeL, GT.eyeR].forEach(function (e) {
    g.fillStyle = '#fdfbf8'; g.beginPath(); g.ellipse(e.x, e.y, 40, 20, 0, 0, 7); g.fill();
    g.fillStyle = '#5b4634'; g.beginPath(); g.arc(e.x, e.y, 17, 0, 7); g.fill();
    g.fillStyle = '#140f0d'; g.beginPath(); g.arc(e.x, e.y, 8, 0, 7); g.fill();
    g.fillStyle = '#fff'; g.beginPath(); g.arc(e.x - 6, e.y - 6, 4, 0, 7); g.fill();
    g.strokeStyle = '#2e2320'; g.lineWidth = 4;
    g.beginPath(); g.ellipse(e.x, e.y, 40, 20, 0, Math.PI, 0); g.stroke();
    g.beginPath(); g.ellipse(e.x, e.y, 40, 20, 0, 0, Math.PI); g.stroke();
  });
  g.strokeStyle = 'rgba(150,110,85,.55)'; g.lineWidth = 6;
  g.beginPath(); g.moveTo(346, 396); g.quadraticCurveTo(330, 460, 328, 470); g.stroke();
  g.fillStyle = 'rgba(120,85,65,.5)';
  g.beginPath(); g.ellipse(330, 476, 9, 6, 0, 0, 7); g.fill();
  g.beginPath(); g.ellipse(370, 476, 9, 6, 0, 0, 7); g.fill();

  var m = GT.mouth;
  g.fillStyle = '#b5615e';
  g.beginPath();
  g.moveTo(m.x - m.halfW, m.y);
  g.quadraticCurveTo(m.x - m.halfW / 2, m.y - m.halfH, m.x, m.y - m.halfH * 0.45);
  g.quadraticCurveTo(m.x + m.halfW / 2, m.y - m.halfH, m.x + m.halfW, m.y);
  g.quadraticCurveTo(m.x + m.halfW / 2, m.y + m.halfH, m.x, m.y + m.halfH);
  g.quadraticCurveTo(m.x - m.halfW / 2, m.y + m.halfH, m.x - m.halfW, m.y);
  g.fill();
  g.strokeStyle = 'rgba(90,50,48,.7)'; g.lineWidth = 2.5;
  g.beginPath(); g.moveTo(m.x - m.halfW, m.y); g.lineTo(m.x + m.halfW, m.y); g.stroke();

  g.fillStyle = 'rgba(190,130,110,.22)';
  [-1, 1].forEach(function (s) {
    g.beginPath(); g.ellipse(350 + s * 95, 500, 46, 34, 0, 0, 7); g.fill();
  });

  /* Nasolabial folds, drawn as actual creases: a shadow line with a lighter
     ridge lateral to it. Without them the fold region was a smooth patch of
     blush, so filling it moved almost nothing measurable and the region looked
     like an engine failure when it was a missing feature in the fixture. A real
     fold is a high-gradient line, which is exactly what makes its correction
     visible. */
  [-1, 1].forEach(function (sgn) {
    var ax = 350 + sgn * 23, ay = 482;          /* at the nostril base */
    var mx = 350 + sgn * 55, my = 604;          /* toward the mouth corner */
    var cx = 350 + sgn * 50, cy = 545;
    g.strokeStyle = 'rgba(255,225,205,.30)'; g.lineWidth = 7;
    g.beginPath();
    g.moveTo(ax + sgn * 5, ay); g.quadraticCurveTo(cx + sgn * 6, cy, mx + sgn * 5, my);
    g.stroke();
    g.strokeStyle = 'rgba(112,74,56,.55)'; g.lineWidth = 4.5;
    g.beginPath();
    g.moveTo(ax, ay); g.quadraticCurveTo(cx, cy, mx, my); g.stroke();
    g.strokeStyle = 'rgba(84,52,38,.40)'; g.lineWidth = 1.8;
    g.beginPath();
    g.moveTo(ax, ay); g.quadraticCurveTo(cx, cy, mx, my); g.stroke();
  });

  /* ------------------------------------------------------------------------
     Photographic finish
     ------------------------------------------------------------------------
     The flat-shaded face above was a poor proxy for a photograph, and it hid a
     real engine bug: local contrast was ~1.7 grey levels where a photo has
     5-15, so a 3-pixel warp produced almost no measurable pixel change, and the
     luminance did not correlate with surface orientation at all, so the
     engine's lighting fit correctly refused to run. Neither the visibility of a
     dose step nor the shading pass could be tested on it.

     Two passes fix that, in the physical order:

       1. ALBEDO - multi-scale skin texture (fine grain plus two coarser
          octaves), multiplied into the drawn face. This is what the
          texture-preservation audit should be measuring.
       2. ILLUMINATION - a directional light on an ellipsoid approximation of
          the head, so image luminance genuinely correlates with surface normal.
          This is what lets the engine fit the light from the photograph.

     The RNG is seeded: two runs of the same seed are identical, so a measured
     difference between two doses is a difference in the engine and not in the
     grain. (An unseeded version of this test previously made a change of noise
     look like a change of behaviour.)

     The background is left untouched, so the byte-identical-background audit
     still means what it says.
     ------------------------------------------------------------------------ */

  /* mulberry32 - small, seeded, good enough for texture */
  var seed = opts.seed == null ? 0x9E3779B9 : opts.seed;
  function rnd() {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /* value noise on a coarse grid, bilinearly interpolated */
  function octave(cell, amp) {
    var gw = Math.ceil(W / cell) + 2, gh = Math.ceil(H / cell) + 2;
    var grid = new Float32Array(gw * gh);
    for (var i = 0; i < grid.length; i++) grid[i] = (rnd() * 2 - 1) * amp;
    return function (x, y) {
      var fx = x / cell, fy = y / cell;
      var x0 = Math.floor(fx), y0 = Math.floor(fy);
      var tx = fx - x0, ty = fy - y0;
      var a = grid[y0 * gw + x0], b = grid[y0 * gw + x0 + 1];
      var c2 = grid[(y0 + 1) * gw + x0], d2 = grid[(y0 + 1) * gw + x0 + 1];
      return (a * (1 - tx) + b * tx) * (1 - ty) + (c2 * (1 - tx) + d2 * tx) * ty;
    };
  }

  if (opts.photo !== false) {
    var oct8 = octave(9, 7.5);
    var oct32 = octave(34, 9.0);

    /* ellipsoid depth for the head, in the same units as the drawn ellipse */
    var rz = GT.faceRx * 0.92;
    /* light from the upper left and slightly in front: the ordinary portrait
       key-light position, and the reason a raised cheek picks up a highlight */
    var Lx = -0.52, Ly = -0.46, Lz = 0.72;
    var Ln = Math.sqrt(Lx * Lx + Ly * Ly + Lz * Lz);
    Lx /= Ln; Ly /= Ln; Lz /= Ln;
    var AMBIENT = 0.62, DIFFUSE = 0.55;

    var img = g.getImageData(0, 0, W, H);
    var px = img.data;

    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        var dx = (x - GT.faceCx) / GT.faceRx;
        var dy = (y - GT.faceCy) / GT.faceRy;
        var rr = dx * dx + dy * dy;
        if (rr > 1.06) continue;                 /* leave the background alone */

        /* soft edge, so the finish does not draw a ring of its own */
        var edge = rr <= 0.94 ? 1 : (1.06 - rr) / 0.12;

        var o = (y * W + x) * 4;

        /* 1. albedo */
        var grain = (rnd() * 2 - 1) * 4.5 + oct8(x, y) + oct32(x, y);

        /* 2. illumination from the ellipsoid normal */
        var zz = 1 - Math.min(1, rr);
        var z = rz * Math.sqrt(zz);
        var nx = dx / GT.faceRx, ny = dy / GT.faceRy, nz = z / (rz * rz);
        var nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        var ndl = (nx * Lx + ny * Ly + nz * Lz) / nl;
        if (ndl < 0) ndl = 0;
        var shade = AMBIENT + DIFFUSE * ndl;
        var f = 1 + (shade - 1) * edge;

        for (var ch = 0; ch < 3; ch++) {
          var val = px[o + ch] * f + grain * edge;
          px[o + ch] = val < 0 ? 0 : val > 255 ? 255 : val;
        }
      }
    }
    g.putImageData(img, 0, 0);
  } else {
    /* legacy flat finish, kept so a test can ask for a low-texture image */
    var n = opts.grain == null ? 34000 : opts.grain;
    for (var q = 0; q < n; q++) {
      g.fillStyle = 'rgba(0,0,0,' + (rnd() * 0.06) + ')';
      g.fillRect(rnd() * W, rnd() * H, 2, 2);
    }
  }

  return { canvas: c, GT: GT, W: W, H: H };
};

/* Pushes a canvas through the real file input, so the tested path is the
   production path and not a private helper. */
window.__feed = function (canvas) {
  return new Promise(function (resolve) {
    canvas.toBlob(function (blob) {
      var dt = new DataTransfer();
      dt.items.add(new File([blob], 'face.png', { type: 'image/png' }));
      var inp = document.getElementById('mirrorFile');
      inp.files = dt.files;
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      resolve();
    }, 'image/png');
  });
};

window.__waitPanel = function (ids, tries) {
  tries = tries || 120;
  return new Promise(function (resolve) {
    var n = 0;
    (function tick() {
      var a = document.querySelector('.studio__panel.is-active');
      if (a && ids.indexOf(a.id) > -1) return resolve(a.id);
      if (++n > tries) return resolve(a ? a.id : null);
      setTimeout(tick, 200);
    })();
  });
};
