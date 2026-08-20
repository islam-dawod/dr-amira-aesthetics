/* Site-wide audit runner. Loads each page into a hidden iframe at a given
   width, runs the a11y checks inside it, and collects the failures.
   Same-origin, so the iframe's document is reachable. */
window.__sweep = function (pages, width, a11ySrc) {
  return new Promise(function (resolve) {
    var results = [];
    var frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;left:-99999px;top:0;border:0;' +
                          'width:' + width + 'px;height:1400px;';
    document.body.appendChild(frame);

    var i = 0;
    function next() {
      if (i >= pages.length) {
        frame.remove();
        return resolve(results);
      }
      var page = pages[i++];
      frame.onload = function () {
        setTimeout(function () {
          var out = { page: page, width: width };
          try {
            var w = frame.contentWindow, d = frame.contentDocument;
            /* inject the audit into the frame and run it there */
            var sc = d.createElement('script');
            sc.textContent = a11ySrc;
            d.body.appendChild(sc);
            var a = w.__a11y();
            out.contrast = a.contrastFailures;
            out.targets = a.targetFailures;
            out.overflowX = a.overflowX;

            /* structural checks */
            var ids = {}, dup = [];
            d.querySelectorAll('[id]').forEach(function (e) {
              if (ids[e.id]) dup.push(e.id); ids[e.id] = 1;
            });
            out.duplicateIds = dup;
            out.h1count = d.querySelectorAll('h1').length;
            out.emptyLinks = Array.prototype.filter.call(
              d.querySelectorAll('a'),
              function (x) { return !x.textContent.trim() && !x.getAttribute('aria-label'); }
            ).length;
            out.title = d.title;
            /* internal link targets, for a broken-link pass */
            out.links = Array.prototype.map.call(
              d.querySelectorAll('a[href]'),
              function (x) { return x.getAttribute('href'); }
            ).filter(function (h) {
              return h && h.indexOf('http') !== 0 && h.indexOf('mailto:') !== 0 &&
                     h.indexOf('tel:') !== 0 && h.charAt(0) !== '#';
            });
          } catch (e) {
            out.error = String(e);
          }
          results.push(out);
          next();
        }, 260);
      };
      frame.src = page;
    }
    next();
  });
};
