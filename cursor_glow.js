/**
 * 滑鼠游標光暈拖曳效果（首頁與系統頁共用）。
 *
 * 兩層光暈以不同的追隨速度跟著游標：外層慢、內層快，兩者的落差就是「拖曳」感。
 * 光暈固定在 z-index:-1，只會出現在頁面底色上，不會蓋住卡片內容或影響文字可讀性；
 * 元素一律 pointer-events:none，不攔截任何點擊。
 *
 * 觸控裝置（pointer:coarse）與 prefers-reduced-motion 不啟用，由 CSS 隱藏並在此提早返回。
 */
(function () {
  'use strict';

  var fine = window.matchMedia('(pointer:fine)').matches;
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!fine || reduce) return;

  var layers = [
    { el: null, cls: 'cursor-glow', x: 0, y: 0, ease: 0.075 },   // 外層：大、慢，拖尾
    { el: null, cls: 'cursor-glow sm', x: 0, y: 0, ease: 0.22 }  // 內層：小、快，跟手
  ];

  layers.forEach(function (l) {
    var d = document.createElement('div');
    d.className = l.cls;
    d.setAttribute('aria-hidden', 'true');
    document.body.appendChild(d);
    l.el = d;
  });

  var tx = window.innerWidth / 2, ty = window.innerHeight / 2;
  var started = false, raf = null;

  function onMove(e) {
    tx = e.clientX;
    ty = e.clientY;
    if (started) return;
    started = true;
    // 首次進場直接定位到游標，避免光暈從畫面中央飛過來
    layers.forEach(function (l) { l.x = tx; l.y = ty; l.el.classList.add('on'); });
    raf = requestAnimationFrame(tick);
  }

  function tick() {
    for (var i = 0; i < layers.length; i++) {
      var l = layers[i];
      l.x += (tx - l.x) * l.ease;
      l.y += (ty - l.y) * l.ease;
      l.el.style.transform = 'translate3d(' + l.x.toFixed(1) + 'px,' + l.y.toFixed(1) + 'px,0)';
    }
    raf = requestAnimationFrame(tick);
  }

  window.addEventListener('mousemove', onMove, { passive: true });
  // 游標離開視窗就淡出，回來再淡入
  document.addEventListener('mouseleave', function () {
    layers.forEach(function (l) { l.el.classList.remove('on'); });
  });
  document.addEventListener('mouseenter', function () {
    if (started) layers.forEach(function (l) { l.el.classList.add('on'); });
  });
  // 分頁切到背景時停掉 rAF，不浪費資源
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      if (raf) { cancelAnimationFrame(raf); raf = null; }
    } else if (started && !raf) {
      raf = requestAnimationFrame(tick);
    }
  });
})();
