(function () {
  // reading progress bar
  var bar = document.getElementById('progress');
  if (bar) {
    var upd = function () {
      var h = document.documentElement;
      var max = h.scrollHeight - h.clientHeight;
      bar.style.width = (max > 0 ? (h.scrollTop / max) * 100 : 0) + '%';
    };
    document.addEventListener('scroll', upd, { passive: true });
    window.addEventListener('resize', upd); upd();
  }

  // color-code callouts by their leading emoji
  var map = [
    ['🐛', 'cl-bug'], ['✅', 'cl-ok'], ['⚠', 'cl-warn'],
    ['📖', 'cl-note'], ['📋', 'cl-note'], ['💡', 'cl-note'], ['📝', 'cl-note'], ['ℹ', 'cl-note']
  ];
  document.querySelectorAll('.prose blockquote').forEach(function (bq) {
    var t = (bq.textContent || '').trim();
    for (var i = 0; i < map.length; i++) {
      if (t.indexOf(map[i][0]) === 0) { bq.classList.add(map[i][1]); break; }
    }
  });

  // copy buttons on code blocks
  document.querySelectorAll('.prose pre, .prose .highlight').forEach(function (block) {
    var btn = document.createElement('button');
    btn.className = 'copy-btn'; btn.type = 'button'; btn.textContent = 'Copy';
    btn.addEventListener('click', function () {
      var code = block.querySelector('code') || block;
      navigator.clipboard.writeText(code.innerText.replace(/\n$/, '')).then(function () {
        btn.textContent = 'Copied'; btn.classList.add('done');
        setTimeout(function () { btn.textContent = 'Copy'; btn.classList.remove('done'); }, 1600);
      });
    });
    block.appendChild(btn);
  });
})();
