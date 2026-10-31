// interactions.js — purely cosmetic micro-interactions layered on top of app.js.
// Safe by design: only adds a transient <span class="ripple"> and toggles a
// "ripple-host" class (position:relative; overflow:hidden) on the clicked
// element. Never touches app state, never intercepts/cancels a click.

(function () {
  'use strict';

  var RIPPLE_SELECTOR = [
    'button',
    '.tab-btn',
    '.list-item .sym',
    '.pick-row',
    '.golden-row',
    '.golden-opp-row',
    '.swing-row',
    'a.daily-breakdown-toggle',
    'a.timeline-toggle',
    'tr[style*="cursor:pointer"]'
  ].join(', ');

  function spawnRipple(host, x, y) {
    if (!host || host.disabled) return;

    var wasStatic = getComputedStyle(host).position === 'static';
    host.classList.add('ripple-host');
    host.classList.add('is-pressed');
    setTimeout(function(){ host.classList.remove('is-pressed'); }, 140);
    if (wasStatic) host.dataset.rippleStatic = '1';

    var rect = host.getBoundingClientRect();
    var size = Math.max(rect.width, rect.height) * 1.15;
    var relX = (typeof x === 'number' ? x - rect.left : rect.width / 2) - size / 2;
    var relY = (typeof y === 'number' ? y - rect.top : rect.height / 2) - size / 2;

    var ripple = document.createElement('span');
    ripple.className = 'ripple';
    ripple.style.width = size + 'px';
    ripple.style.height = size + 'px';
    ripple.style.left = relX + 'px';
    ripple.style.top = relY + 'px';
    host.appendChild(ripple);
    if (window.__RIPPLE_DEBUG) console.log('ripple appended, host now has ripple child?', !!host.querySelector('.ripple'), host.outerHTML.slice(0,150));

    window.setTimeout(function () {
      ripple.remove();
      // Only clean up the host if nothing else is animating on it.
      if (!host.querySelector('.ripple')) {
        host.classList.remove('ripple-host');
      }
    }, 600);
  }

  document.addEventListener('click', function (e) {
    var target = e.target.closest(RIPPLE_SELECTOR);
    if (window.__RIPPLE_DEBUG) console.log('ripple-listener fired, target found:', !!target, e.target.id);
    if (!target) return;
    // Note: don't gate on target.disabled here — some handlers (app.js)
    // disable the button synchronously as part of handling this same click,
    // so by the time we run, an about-to-be-disabled button would already
    // read as disabled. Real disabled buttons never dispatch click at all.
    if (target.classList.contains('no-ripple')) return;
    spawnRipple(target, e.clientX, e.clientY);
  }, { passive: true });

  // Small, non-intrusive touch: when switching main sections, ease the
  // viewport back to the top so the new view doesn't open mid-scroll.
  document.addEventListener('click', function (e) {
    var tab = e.target.closest('.main-tabs .tab-btn');
    if (!tab) return;
    window.requestAnimationFrame(function () {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }, { passive: true });

  // Cosmetic-only: colour the toast dot green/red based on its message text,
  // purely by watching the DOM — never touches app.js's toast() function.
  var ERROR_WORDS = /fail|error|expired|invalid|wrong|not found|unable|could not|denied/i;
  var SUCCESS_WORDS = /added|updated|saved|created|logged|analyzed|success|connected/i;
  var toastEl = document.getElementById('toast');
  if (toastEl && window.MutationObserver) {
    var mo = new MutationObserver(function () {
      var txt = toastEl.textContent || '';
      toastEl.classList.remove('toast-error', 'toast-success');
      if (ERROR_WORDS.test(txt)) toastEl.classList.add('toast-error');
      else if (SUCCESS_WORDS.test(txt)) toastEl.classList.add('toast-success');
    });
    mo.observe(toastEl, { childList: true, characterData: true, subtree: true });
  }

  // Cosmetic-only: replay the fade/slide-in animation each time the toast
  // reappears (classList.remove('hidden') alone won't restart a CSS
  // animation if the element never left the DOM's animation timeline).
  if (toastEl) {
    var toastObserverAttr = new MutationObserver(function () {
      if (!toastEl.classList.contains('hidden')) {
        toastEl.style.animation = 'none';
        // Force reflow so the browser re-applies the animation from scratch.
        void toastEl.offsetWidth;
        toastEl.style.animation = '';
      }
    });
    toastObserverAttr.observe(toastEl, { attributes: true, attributeFilter: ['class'] });
  }

  // Cosmetic-only: briefly flash the live price when it changes (WS ticks or
  // a fresh symbol load), so an updating number visibly "does something"
  // instead of silently swapping text. Direction is read from #symChange's
  // existing up/down class, which app.js already maintains.
  var priceEl = document.getElementById('symPrice');
  if (priceEl && window.MutationObserver) {
    var lastPriceText = priceEl.textContent;
    var priceMo = new MutationObserver(function () {
      var now = priceEl.textContent;
      if (now === lastPriceText || !now || now === '-') { lastPriceText = now; return; }
      var changeEl = document.getElementById('symChange');
      var dir = changeEl && changeEl.classList.contains('down') ? 'flash-down' : 'flash-up';
      priceEl.classList.remove('flash-up', 'flash-down');
      void priceEl.offsetWidth;
      priceEl.classList.add(dir);
      lastPriceText = now;
    });
    priceMo.observe(priceEl, { childList: true, characterData: true, subtree: true });
  }

  // ---------- Theme toggle (dark / light) ----------
  var THEME_KEY = 'stocklens-theme';
  var root = document.documentElement;
  var toggleBtn = document.getElementById('themeToggleBtn');
  var iconEl = toggleBtn ? toggleBtn.querySelector('.tt-icon') : null;

  function applyTheme(theme, opts) {
    opts = opts || {};
    if (theme === 'light') {
      root.setAttribute('data-theme', 'light');
      if (iconEl) iconEl.textContent = '☀️';
      if (toggleBtn) toggleBtn.title = 'Switch to dark mode';
    } else {
      root.removeAttribute('data-theme');
      if (iconEl) iconEl.textContent = '🌙';
      if (toggleBtn) toggleBtn.title = 'Switch to light mode';
    }
    if (!opts.silent) {
      try { localStorage.setItem(THEME_KEY, theme); } catch (err) { /* private mode / storage full — ignore */ }
    }
  }

  // Pick the starting theme: whatever the person chose before, else follow
  // the OS/browser preference, else default to the original dark look.
  var savedTheme = null;
  try { savedTheme = localStorage.getItem(THEME_KEY); } catch (err) { /* ignore */ }
  if (!savedTheme && window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
    savedTheme = 'light';
  }
  applyTheme(savedTheme === 'light' ? 'light' : 'dark', { silent: true });

  if (toggleBtn) {
    toggleBtn.addEventListener('click', function () {
      var next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      toggleBtn.classList.add('spinning');
      applyTheme(next);
      window.setTimeout(function () { toggleBtn.classList.remove('spinning'); }, 400);
    });
  }

  // ---------- Card spotlight (mouse-follow glow) ----------
  // Purely visual: sets --mx/--my custom properties that .card::after in
  // style.css reads to position a soft radial highlight under the cursor.
  document.addEventListener('mousemove', function (e) {
    var card = e.target.closest ? e.target.closest('.card') : null;
    if (!card) return;
    var rect = card.getBoundingClientRect();
    card.style.setProperty('--mx', ((e.clientX - rect.left) / rect.width * 100) + '%');
    card.style.setProperty('--my', ((e.clientY - rect.top) / rect.height * 100) + '%');
  }, { passive: true });
})();
