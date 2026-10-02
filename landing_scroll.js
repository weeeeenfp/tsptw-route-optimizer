/**
 * 首頁捲動進場動畫。
 *
 * 第一屏是 Hero，往下捲時「使用流程」的四個步驟依序進場：
 * 文字與示意圖從相反方向滑入，主路線描繪出來，站點節點隨後浮現。
 *
 * 樣式全部寫在 index.html，這支只負責在適當時機切換 class：
 *   - 啟動時在 <html> 掛 .reveal-on，才開始套用「先隱藏」的初始狀態。
 *     沒有 JS、或瀏覽器不支援 IntersectionObserver 時完全不掛，內容維持可見。
 *   - 元素進入視窗時掛 .in。只進場一次，捲回去不會重播。
 */
(function () {
  'use strict';

  var root = document.documentElement;
  var targets = document.querySelectorAll('.reveal, .lp-step');
  if (!targets.length) return;

  // 不支援 IntersectionObserver 就維持原樣（內容照常顯示），不做降級動畫
  if (!('IntersectionObserver' in window)) return;

  // 先隱藏的初始狀態要等 JS 確定會接手才套用，避免 JS 失效時內容永遠看不到
  root.classList.add('reveal-on');

  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      e.target.classList.add('in');
      io.unobserve(e.target);          // 只進場一次
    });
  }, {
    // 元素露出約 18% 才觸發，並讓底部提早一點，捲到時動畫剛好開始
    threshold: 0.18,
    rootMargin: '0px 0px -8% 0px'
  });

  Array.prototype.forEach.call(targets, function (el) { io.observe(el); });

  // 載入時已經在視窗內的（例如直接開在中段或視窗很高）立即顯示，不必等捲動
  requestAnimationFrame(function () {
    Array.prototype.forEach.call(targets, function (el) {
      var r = el.getBoundingClientRect();
      if (r.top < window.innerHeight * 0.9 && r.bottom > 0) {
        el.classList.add('in');
        io.unobserve(el);
      }
    });
  });
})();
