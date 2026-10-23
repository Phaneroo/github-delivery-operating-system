(function () {
  const STORAGE_KEY = 'delivery-os-theme';
  const toggle = document.getElementById('theme-toggle');
  const label = document.getElementById('theme-label');
  if (!toggle || !label) return;

  function getPreferredTheme() {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return stored;
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }

  function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme === 'light' ? 'light' : '');
    localStorage.setItem(STORAGE_KEY, theme);
    if (theme === 'light') {
      toggle.querySelector('.sun-icon').style.display = 'none';
      toggle.querySelector('.moon-icon').style.display = 'block';
      label.textContent = 'Dark';
    } else {
      toggle.querySelector('.sun-icon').style.display = 'block';
      toggle.querySelector('.moon-icon').style.display = 'none';
      label.textContent = 'Light';
    }
  }

  setTheme(getPreferredTheme());
  toggle.addEventListener('click', function () {
    setTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light');
  });
})();

(function () {
  var toc = document.querySelector('.doc-toc');
  if (!toc) return;
  var links = toc.querySelectorAll('a[href^="#"]');
  if (!links.length) return;
  var ids = Array.prototype.map.call(links, function (a) {
    return a.getAttribute('href').slice(1);
  });
  var sections = ids
    .map(function (id) {
      return document.getElementById(id);
    })
    .filter(Boolean);
  if (!sections.length) return;

  // A section counts as "current" once its top reaches this line. It matches where a
  // jump lands (the sections' scroll margin), so the chip you tapped is the one lit.
  var headroom = 96;
  function measureHeadroom() {
    var margin = parseFloat(window.getComputedStyle(sections[0]).scrollMarginTop);
    headroom = Math.max(96, (isNaN(margin) ? 0 : margin) + 8);
  }
  measureHeadroom();

  // The pinned section row on phones and tablets follows the same logic as the
  // "On this page" list on desktop: mark where you are. The row is only recentered
  // once the page has stopped moving. Moving it while the page is still scrolling
  // can interrupt that scroll in Safari, which makes a tap look like it did nothing.
  var rowLinks = document.querySelectorAll('.doc-sidebar a[href^="#"]');
  var settleTimer = null;

  function markRow(id) {
    rowLinks.forEach(function (a) {
      a.classList.toggle('is-active', a.getAttribute('href') === '#' + id);
    });
  }

  function centerRow() {
    var a = document.querySelector('.doc-sidebar a.is-active');
    var row = a && a.parentNode && a.parentNode.parentNode;
    if (row && row.scrollWidth > row.clientWidth) {
      row.scrollLeft = Math.max(0, a.offsetLeft - (row.clientWidth - a.offsetWidth) / 2);
    }
  }

  // Tapping a chip highlights it straight away.
  rowLinks.forEach(function (a) {
    a.addEventListener('click', function () {
      markRow(a.getAttribute('href').slice(1));
    });
  });

  function setActive(id) {
    links.forEach(function (a) {
      a.classList.toggle('is-active', a.getAttribute('href') === '#' + id);
    });
    markRow(id);
  }

  function onScroll() {
    var current = sections[0].id;
    for (var i = 0; i < sections.length; i++) {
      if (sections[i].getBoundingClientRect().top <= headroom) {
        current = sections[i].id;
      }
    }
    setActive(current);
    clearTimeout(settleTimer);
    settleTimer = setTimeout(centerRow, 160);
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', function () {
    measureHeadroom();
    onScroll();
  }, { passive: true });
  onScroll();
})();

(function () {
  var COPY_ICON =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  var CHECK_ICON =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy') ? resolve() : reject();
      } catch (e) {
        reject(e);
      }
      document.body.removeChild(ta);
    });
  }

  function addButton(block, source) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'copy-btn';
    btn.setAttribute('aria-label', 'Copy to clipboard');
    btn.title = 'Copy';
    btn.innerHTML = COPY_ICON;
    var timer;
    btn.addEventListener('click', function () {
      copyText(source.textContent.trim()).then(function () {
        btn.innerHTML = CHECK_ICON;
        btn.classList.add('is-copied');
        btn.title = 'Copied';
        clearTimeout(timer);
        timer = setTimeout(function () {
          btn.innerHTML = COPY_ICON;
          btn.classList.remove('is-copied');
          btn.title = 'Copy';
        }, 1800);
      }, function () {});
    });
    block.classList.add('has-copy');
    block.appendChild(btn);
  }

  document.querySelectorAll('.install-block:not(.no-copy)').forEach(function (block) {
    var code = block.querySelector('code');
    if (code) addButton(block, code);
  });

  document.querySelectorAll('pre:not(.no-copy)').forEach(function (pre) {
    var code = pre.querySelector('code') || pre;
    var wrap = document.createElement('div');
    wrap.className = 'pre-wrap';
    pre.parentNode.insertBefore(wrap, pre);
    wrap.appendChild(pre);
    addButton(wrap, code);
  });
})();

// Fade sections in as they scroll into view. Content stays visible without
// this script, and for anyone who asks for reduced motion.
(function () {
  if (!('IntersectionObserver' in window)) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  var items = document.querySelectorAll(
    '.doc-main section > h2, .doc-main section > h3, .doc-main section > p, .doc-main .table-wrap, .doc-main .features .feature, .doc-main section > .install-block, .doc-main section > .tabs, .doc-main .example-details'
  );
  if (!items.length) return;

  document.documentElement.classList.add('js-reveal');
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      e.target.classList.add('in');
      io.unobserve(e.target);
    });
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.05 });

  items.forEach(function (el, i) {
    el.classList.add('reveal');
    if (el.classList.contains('feature')) el.style.transitionDelay = (i % 4) * 70 + 'ms';
    io.observe(el);
  });
})();

// Star count on the "Star on GitHub" button. One public GitHub API call;
// if it fails, is rate-limited or the count is still small, the button shows without a number.
(function () {
  var el = document.querySelector('.star-count');
  if (!el || !window.fetch) return;
  fetch('https://api.github.com/repos/Phaneroo/github-delivery-operating-system')
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (repo) {
      if (!repo || typeof repo.stargazers_count !== 'number') return;
      var n = repo.stargazers_count;
      if (n < 10) return; // a small number reads as the opposite of social proof
      el.textContent = n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n);
      el.hidden = false;
    })
    .catch(function () {});
})();
