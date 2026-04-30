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

  function setActive(id) {
    links.forEach(function (a) {
      a.classList.toggle('is-active', a.getAttribute('href') === '#' + id);
    });
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
