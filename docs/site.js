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

  var headroom = 96;

  // The pinned section row on phones and tablets follows the same logic as the
  // "On this page" list on desktop: mark where you are, and keep that chip in view.
  var rowLinks = document.querySelectorAll('.doc-sidebar a[href^="#"]');
  var lastId = null;

  function setActive(id) {
    links.forEach(function (a) {
      a.classList.toggle('is-active', a.getAttribute('href') === '#' + id);
    });
    rowLinks.forEach(function (a) {
      var on = a.getAttribute('href') === '#' + id;
      a.classList.toggle('is-active', on);
      var row = a.parentNode && a.parentNode.parentNode;
      // Recenter the chip only when the section changes, so it never fights your finger.
      if (on && id !== lastId && row && row.scrollWidth > row.clientWidth) {
        var left = a.offsetLeft - (row.clientWidth - a.offsetWidth) / 2;
        row.scrollLeft = Math.max(0, left);
      }
    });
    lastId = id;
  }

  function onScroll() {
    var current = sections[0].id;
    for (var i = 0; i < sections.length; i++) {
      if (sections[i].getBoundingClientRect().top <= headroom) {
        current = sections[i].id;
      }
    }
    setActive(current);
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll, { passive: true });
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
