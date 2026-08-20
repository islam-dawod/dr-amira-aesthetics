# -*- coding: utf-8 -*-
"""
Prepare a photograph for one of the site's 4:5 portrait frames.

    python _build/prep-photo.py <input> <output-basename> [--unmirror] [--anchor 0.0-1.0]

Produces <output-basename>.webp and <output-basename>.jpg at 720x900, plus a
2x pair for high-density screens.

Why each step is here:

  --unmirror   A front-camera photo is saved mirrored unless the camera app
               un-mirrors it. On a clinic wall of certificates that is not a
               cosmetic detail: the credentials read backwards. Flipping is
               lossless and it is the only honest way to show them.

  crop         The frames are 4:5 and CSS `object-fit: cover` crops from the
               CENTRE, which on a 9:16 phone photo cuts the head off and shows
               mid-torso. Cropping here instead keeps the framing deliberate and
               avoids shipping pixels the page never displays. `--anchor` is
               where the kept window sits vertically: 0 is the top of the frame,
               1 the bottom. Default 0.06 keeps a little headroom.

  two formats  WebP for the browsers that take it, JPEG as the fallback, both
               referenced from one <picture>. No CDN, no external request - the
               same rule the rest of this site follows.
"""
import sys, os
from PIL import Image, ImageOps

W, H = 720, 900          # the frame's own pixel size
RATIO = W / H            # 0.8


def prep(src, out_base, unmirror=False, anchor=0.06):
    im = Image.open(src)
    im = ImageOps.exif_transpose(im)          # honour the camera's rotation flag
    if im.mode not in ('RGB', 'L'):
        im = im.convert('RGB')

    if unmirror:
        im = ImageOps.mirror(im)

    w, h = im.size
    print('source: %dx%d  (aspect %.3f)' % (w, h, w / h))

    # ---- crop to 4:5, keeping as much width as possible ----------------
    if w / h > RATIO:
        # too wide: trim the sides, centred
        new_w = int(round(h * RATIO))
        left = (w - new_w) // 2
        box = (left, 0, left + new_w, h)
    else:
        # too tall: trim the height, anchored near the top so the face stays
        new_h = int(round(w / RATIO))
        top = int(round((h - new_h) * anchor))
        box = (0, top, w, top + new_h)
    im = im.crop(box)
    print('cropped to %dx%d  (box %s)' % (im.size[0], im.size[1], box))

    # ---- sizes, never larger than the source ---------------------------
    # Upscaling invents detail that is not in the file. If the source cannot
    # fill the frame we ship it at its own size and let CSS scale it, which at
    # least keeps the softness honest instead of baking it in.
    cw = im.size[0]
    wanted = [W * 2, W]
    sizes = [s for s in wanted if s <= cw]
    if not sizes:
        sizes = [cw]
        print('note: source is only %dpx wide, under the %dpx frame - shipping '
              'at native size rather than upscaling' % (cw, W))

    results = []
    for out_w in sizes:
        out_h = int(round(out_w / RATIO))
        suffix = '@2x' if out_w == W * 2 else ''
        target = (out_w, out_h)
        r = im.resize(target, Image.LANCZOS) if target != im.size else im
        for ext, kw in (('webp', dict(quality=82, method=6)),
                        ('jpg',  dict(quality=86, optimize=True, progressive=True))):
            path = '%s%s.%s' % (out_base, suffix, ext)
            r.save(path, **kw)
            results.append((path, os.path.getsize(path)))

    print()
    for path, size in sorted(results):
        print('  %-44s %6.1f KB' % (path.replace('\\', '/'), size / 1024))
    return results


if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    if len(args) < 2:
        sys.exit(__doc__)
    unmirror = '--unmirror' in sys.argv
    anchor = 0.06
    if '--anchor' in sys.argv:
        anchor = float(sys.argv[sys.argv.index('--anchor') + 1])
    prep(args[0], args[1], unmirror=unmirror, anchor=anchor)
