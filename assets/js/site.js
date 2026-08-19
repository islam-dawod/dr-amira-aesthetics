/* ==========================================================================
   AMEERA DABAJA — site behaviour
   Quiet interactions only: fade, soft reveal, smooth compare sliders.
   Every module is optional — a page loads whatever markup it has.
   ========================================================================== */
(function () {
  'use strict';

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var $  = function (s, c) { return (c || document).querySelector(s); };
  var $$ = function (s, c) { return Array.prototype.slice.call((c || document).querySelectorAll(s)); };

  /* ---------------------------------------------------------------- header */
  function initHeader() {
    var header = $('.site-header');
    if (!header) return;
    var onScroll = function () {
      header.classList.toggle('is-scrolled', window.scrollY > 8);
      var bar = $('.book-bar');
      if (bar) bar.classList.toggle('is-visible', window.scrollY > 520);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  /* ---------------------------------------------------------------- drawer */
  function initDrawer() {
    var burger = $('.burger');
    var drawer = $('#drawer');
    if (!burger || !drawer) return;

    var lastFocus = null;

    function open() {
      lastFocus = document.activeElement;
      drawer.classList.add('is-open');
      drawer.removeAttribute('aria-hidden');
      burger.setAttribute('aria-expanded', 'true');
      document.body.classList.add('is-locked');
      var close = $('.drawer__close', drawer);
      if (close) close.focus();
    }
    function close() {
      drawer.classList.remove('is-open');
      drawer.setAttribute('aria-hidden', 'true');
      burger.setAttribute('aria-expanded', 'false');
      document.body.classList.remove('is-locked');
      if (lastFocus) lastFocus.focus();
    }

    burger.addEventListener('click', function () {
      burger.getAttribute('aria-expanded') === 'true' ? close() : open();
    });
    $$('.drawer__close, .drawer a', drawer).forEach(function (el) {
      el.addEventListener('click', function (e) {
        if (el.tagName === 'A' && el.getAttribute('href') && el.getAttribute('href').charAt(0) !== '#') return;
        close();
      });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && drawer.classList.contains('is-open')) close();
    });
  }

  /* --------------------------------------------------------------- reveals */
  function initReveal() {
    var items = $$('.reveal, .reveal-img');
    if (!items.length) return;
    if (reduceMotion || !('IntersectionObserver' in window)) {
      items.forEach(function (el) { el.classList.add('is-in'); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-in');
          io.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    items.forEach(function (el) { io.observe(el); });
  }

  /* --------------------------------------------------- compare (B/A) slider */
  function bindCompare(root) {
    var range  = $('.compare__range', root);
    var handle = $('.compare__handle', root);
    var after  = $('.compare__layer--after', root);
    if (!range) return;

    function paint(v) {
      root.style.setProperty('--pos', v + '%');
      range.setAttribute('aria-valuetext', Math.round(v) + '% AI preview');
      if (after) after.style.setProperty('--pos', v + '%');
      if (handle) handle.style.setProperty('--pos', v + '%');
    }
    paint(range.value);
    range.addEventListener('input', function () { paint(range.value); });

    /* drag anywhere on the frame */
    var dragging = false;
    function fromEvent(e) {
      var rect = root.getBoundingClientRect();
      var x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
      var pct = Math.max(0, Math.min(100, (x / rect.width) * 100));
      if (document.documentElement.dir === 'rtl') pct = 100 - pct;
      range.value = pct;
      paint(pct);
    }
    root.addEventListener('pointerdown', function (e) {
      if (e.target.closest('a, button')) return;
      dragging = true; fromEvent(e); root.setPointerCapture && root.setPointerCapture(e.pointerId);
    });
    root.addEventListener('pointermove', function (e) { if (dragging) fromEvent(e); });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (t) {
      root.addEventListener(t, function () { dragging = false; });
    });
  }
  function initCompare() { $$('.compare').forEach(bindCompare); }

  /* ------------------------------------------------------------- accordion */
  function initAccordion() {
    $$('.acc__btn').forEach(function (btn) {
      var panel = document.getElementById(btn.getAttribute('aria-controls'));
      if (!panel) return;
      btn.addEventListener('click', function () {
        var open = btn.getAttribute('aria-expanded') === 'true';
        btn.setAttribute('aria-expanded', String(!open));
        panel.dataset.open = String(!open);
      });
    });
  }

  /* ------------------------------------------------------------ sheet/modal */
  var sheetState = { last: null };

  function openSheet(sheet) {
    if (!sheet) return;
    sheetState.last = document.activeElement;
    sheet.classList.add('is-open');
    sheet.removeAttribute('aria-hidden');
    document.body.classList.add('is-locked');
    var close = $('.sheet__close', sheet);
    if (close) close.focus();
  }
  function closeSheet(sheet) {
    if (!sheet) return;
    sheet.classList.remove('is-open');
    sheet.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('is-locked');
    if (sheetState.last) sheetState.last.focus();
  }
  function initSheets() {
    $$('.sheet').forEach(function (sheet) {
      $$('.sheet__scrim, .sheet__close, [data-sheet-close]', sheet).forEach(function (el) {
        el.addEventListener('click', function () { closeSheet(sheet); });
      });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      var open = $('.sheet.is-open');
      if (open) closeSheet(open);
    });
  }
  window.AmiraSheet = { open: openSheet, close: closeSheet };

  /* --------------------------------------------------- concerns ("what bothers you") */
  function initConcerns() {
    var sheet = $('#concernSheet');
    if (!sheet || !window.AMIRA_CONCERNS) return;
    var body = $('#concernSheetBody', sheet);

    $$('[data-concern]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var data = window.AMIRA_CONCERNS[btn.dataset.concern];
        if (!data || !body) return;
        body.innerHTML = renderConcern(data);
        initAccordion();
        openSheet(sheet);
        body.scrollTop = 0;
      });
    });

    function li(arr) { return arr.map(function (t) { return '<li>' + t + '</li>'; }).join(''); }

    function renderConcern(d) {
      var faqId = 'cf' + Math.random().toString(36).slice(2, 7);
      return '' +
        '<span class="eyebrow">' + d.en + '</span>' +
        '<h2 id="concernSheetTitle">' + d.he + '</h2>' +
        '<div class="rule"></div>' +
        '<p class="lead">' + d.intro + '</p>' +

        '<h3 class="mt-4">מה אפשר לשפר</h3>' +
        '<ul>' + li(d.improve) + '</ul>' +

        '<h3 class="mt-4">טיפולים שעשויים להתאים</h3>' +
        '<ul>' + li(d.options) + '</ul>' +

        '<dl class="detail-grid">' +
          '<div class="detail"><dt>משך הטיפול</dt><dd>' + d.duration + '</dd></div>' +
          '<div class="detail"><dt>זמן החלמה משוער</dt><dd>' + d.recovery + '</dd></div>' +
          '<div class="detail"><dt>מתי רואים תוצאה</dt><dd>' + d.onset + '</dd></div>' +
          '<div class="detail"><dt>משך התוצאה</dt><dd>' + d.lasts + '</dd></div>' +
        '</dl>' +

        '<div class="notice notice--sage">' +
          '<span class="notice__title">אין כאן המלצה רפואית</span>' +
          'המידע הזה כללי בלבד ואינו קובע שאת "צריכה" טיפול כלשהו או כמות מסוימת. ' +
          'התאמת טיפול, בחירת החומר והכמות נקבעות אך ורק בבדיקה וייעוץ אישי עם ד״ר אמירה.' +
        '</div>' +

        '<h3 class="mt-4">שאלות נפוצות</h3>' +
        '<div class="acc">' + d.faq.map(function (f, i) {
          var id = faqId + '-' + i;
          return '<div class="acc__item">' +
            '<button class="acc__btn" type="button" aria-expanded="false" aria-controls="' + id + '">' +
              '<span>' + f.q + '</span><span class="acc__ico" aria-hidden="true"></span>' +
            '</button>' +
            '<div class="acc__panel" id="' + id + '" data-open="false"><div><p>' + f.a + '</p></div></div>' +
          '</div>';
        }).join('') + '</div>' +

        '<div class="btn-row">' +
          '<a class="btn btn--primary" href="contact.html">קביעת ייעוץ</a>' +
          '<a class="btn btn--ghost" href="ai-studio.html">נסי הדמיית AI</a>' +
        '</div>';
    }
  }

  /* ------------------------------------------------------ before/after gallery */
  function initGallery() {
    var stage = $('#galleryStage');
    if (!stage || !window.AMIRA_RESULTS) return;

    var all = window.AMIRA_RESULTS;
    var view = all.slice();
    var idx = 0;

    var elBefore = $('#gBefore');
    var elAfter  = $('#gAfter');
    var elTitle  = $('#gTitle');
    var elMeta   = $('#gMeta');
    var elCount  = $('#gCount');

    function paint() {
      if (!view.length) return;
      var it = view[idx];
      elBefore.src = it.before;
      elAfter.src  = it.after;
      elBefore.alt = 'לפני הטיפול — ' + it.title;
      elAfter.alt  = 'אחרי הטיפול — ' + it.title;
      elTitle.textContent = it.title;
      elMeta.innerHTML =
        '<dt>טיפול</dt><dd>' + it.treatment + '</dd>' +
        '<dt>אזור</dt><dd>' + it.area + '</dd>' +
        '<dt>מספר מפגשים</dt><dd>' + it.sessions + '</dd>' +
        '<dt>צילום אחרי</dt><dd>' + it.timing + '</dd>' +
        '<dt>הערות</dt><dd>' + it.note + '</dd>';
      elCount.textContent = (idx + 1) + ' / ' + view.length;
    }

    $$('[data-filter]').forEach(function (chip) {
      chip.addEventListener('click', function () {
        $$('[data-filter]').forEach(function (c) { c.setAttribute('aria-pressed', 'false'); });
        chip.setAttribute('aria-pressed', 'true');
        var f = chip.dataset.filter;
        view = f === 'all' ? all.slice() : all.filter(function (x) { return x.tags.indexOf(f) > -1; });
        idx = 0;
        paint();
      });
    });

    var prev = $('#gPrev'), next = $('#gNext');
    if (prev) prev.addEventListener('click', function () { idx = (idx - 1 + view.length) % view.length; paint(); });
    if (next) next.addEventListener('click', function () { idx = (idx + 1) % view.length; paint(); });

    paint();
  }

  /* ------------------------------------------------- smart consultation flow */
  function initFlow() {
    var flow = $('#consultFlow');
    if (!flow) return;

    var steps = $$('.flow__step', flow);
    var bars  = $$('.flow__bar', flow);
    var at = 0;

    function show(i) {
      at = Math.max(0, Math.min(steps.length - 1, i));
      steps.forEach(function (s, n) { s.classList.toggle('is-active', n === at); });
      bars.forEach(function (b, n) {
        b.classList.toggle('is-done', n < at);
        b.classList.toggle('is-active', n === at);
      });
      var h = steps[at].querySelector('h2, h3');
      if (h) h.setAttribute('tabindex', '-1'), h.focus({ preventScroll: true });
      flow.scrollIntoView({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
      if (at === steps.length - 1) summarise();
    }

    $$('[data-flow-next]', flow).forEach(function (b) {
      b.addEventListener('click', function () { show(at + 1); });
    });
    $$('[data-flow-prev]', flow).forEach(function (b) {
      b.addEventListener('click', function () { show(at - 1); });
    });

    /* auto-advance on single-choice questions, gently */
    $$('input[type="radio"][data-advance]', flow).forEach(function (r) {
      r.addEventListener('change', function () {
        window.setTimeout(function () { show(at + 1); }, 260);
      });
    });

    function labelsOf(name) {
      return $$('input[name="' + name + '"]:checked', flow).map(function (i) {
        var box = i.nextElementSibling;
        var strong = box && box.querySelector('span');
        return (strong ? strong.textContent : box ? box.textContent : i.value).trim();
      });
    }

    function summarise() {
      var out = $('#flowSummary', flow);
      if (!out) return;
      var areas = labelsOf('area');
      var goal  = labelsOf('goal');
      var hist  = labelsOf('history');
      var rows = [
        ['אזורים שמעניינים אותך', areas.length ? areas.join(', ') : '—'],
        ['הכיוון שאת מחפשת', goal.length ? goal[0] : '—'],
        ['ניסיון קודם בטיפולים', hist.length ? hist[0] : '—']
      ];
      var mirror = readMirrorHandoff();
      if (mirror) rows.push(['הדמיה שנשמרה ב־AI Mirror', mirror]);
      out.innerHTML = rows.map(function (r) {
        return '<div><dt>' + r[0] + '</dt><dd>' + r[1] + '</dd></div>';
      }).join('');

      /* prefill hidden field so the clinic's CRM/WhatsApp gets structured context */
      var hidden = $('#flowContext', flow);
      if (hidden) hidden.value = rows.map(function (r) { return r[0] + ': ' + r[1]; }).join(' | ');

      var wa = $('#flowWhatsapp', flow);
      if (wa) {
        var msg = 'שלום, אני מעוניינת בייעוץ.\n' +
          rows.map(function (r) { return r[0] + ': ' + r[1]; }).join('\n') +
          '\n(נשלח מהאתר)';
        wa.href = wa.dataset.base + '?text=' + encodeURIComponent(msg);
      }
    }

    function readMirrorHandoff() {
      try {
        var raw = window.sessionStorage.getItem('amira.mirror.handoff');
        if (!raw) return null;
        var d = JSON.parse(raw);
        if (!d || !d.regions || !d.regions.length) return null;
        return d.regions.join(', ') + ' · רמה: ' + d.level;
      } catch (e) { return null; }
    }

    /* If the user arrived from the AI Mirror, pre-select those areas. */
    (function prefillFromMirror() {
      try {
        var raw = window.sessionStorage.getItem('amira.mirror.handoff');
        if (!raw) return;
        var d = JSON.parse(raw);
        if (!d || !d.keys) return;
        d.keys.forEach(function (k) {
          var input = $('input[name="area"][value="' + k + '"]', flow);
          if (input) input.checked = true;
        });
        var banner = $('#mirrorBanner');
        if (banner) banner.hidden = false;
      } catch (e) { /* ignore */ }
    })();

    show(0);
  }

  /* ------------------------------------------------------------ year stamp */
  function initYear() {
    $$('[data-year]').forEach(function (el) { el.textContent = new Date().getFullYear(); });
  }

  /* ------------------------------------------------------------------- boot */
  document.addEventListener('DOMContentLoaded', function () {
    document.body.classList.add('has-bottom-nav');
    initHeader();
    initDrawer();
    initReveal();
    initCompare();
    initAccordion();
    initSheets();
    initConcerns();
    initGallery();
    initFlow();
    initYear();
  });

  window.AmiraSite = { bindCompare: bindCompare, initReveal: initReveal, initAccordion: initAccordion };
})();
