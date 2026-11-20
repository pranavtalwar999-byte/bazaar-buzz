/* Bazaar Buzz page transitions: a curtain slides up, the next page loads, the curtain slides away.
   Works on every page (Home, Reels, Profile). Uses the Web Animations API, no library needed. */
(function () {
  if (window.__bbTx) return; window.__bbTx = true;
  var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  var css = '#bbTx{position:fixed;inset:0;z-index:2147483000;pointer-events:none;display:grid;place-items:center;visibility:hidden}' +
    '#bbTx .p{position:absolute;inset:0;background:#A84E2C;transform:translateY(100%)}' +
    '#bbTx .p2{background:#1F1E1B}' +
    '#bbTx .m{position:relative;display:flex;align-items:center;gap:12px;color:#fff;font:700 clamp(1.4rem,4vw,2rem)/1 Fraunces,Georgia,serif;opacity:0}' +
    '#bbTx .m i{width:42px;height:42px;border-radius:13px;background:rgba(255,255,255,.16);display:grid;place-items:center}' +
    '#bbTx .m svg{width:22px;height:22px}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  var el = document.createElement('div'); el.id = 'bbTx'; el.setAttribute('aria-hidden', 'true');
  el.innerHTML = '<div class="p p2"></div><div class="p"></div><div class="m"><i><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/></svg></i>Bazaar Buzz</div>';
  var mount = function () { document.body.appendChild(el); };
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
  var ease = 'cubic-bezier(.76,0,.24,1)', P = function () { return el.querySelectorAll('.p'); }, M = function () { return el.querySelector('.m'); };

  function cover(done) {
    if (reduce || !el.animate) return done();
    el.style.visibility = 'visible'; el.style.pointerEvents = 'auto';
    var ps = P(), last;
    ps.forEach(function (p, i) { last = p.animate([{ transform: 'translateY(100%)' }, { transform: 'translateY(0)' }], { duration: 520, delay: i * 90, easing: ease, fill: 'forwards' }); });
    M().animate([{ opacity: 0, transform: 'translateY(16px)' }, { opacity: 1, transform: 'none' }], { duration: 300, delay: 330, easing: 'ease-out', fill: 'forwards' });
    try { sessionStorage.setItem('bb_tx', '1'); } catch (e) {}
    last.onfinish = function () { setTimeout(done, 60); };
  }
  function reveal() {
    var on = false; try { on = sessionStorage.getItem('bb_tx') === '1'; sessionStorage.removeItem('bb_tx'); } catch (e) {}
    if (!on || reduce || !el.animate) return;
    el.style.visibility = 'visible';
    var ps = P(); ps.forEach(function (p) { p.style.transform = 'translateY(0)'; });
    M().style.opacity = 1;
    M().animate([{ opacity: 1 }, { opacity: 0, transform: 'translateY(-12px)' }], { duration: 220, easing: 'ease-in', fill: 'forwards' });
    var last;
    [].slice.call(ps).reverse().forEach(function (p, i) { last = p.animate([{ transform: 'translateY(0)' }, { transform: 'translateY(-100%)' }], { duration: 620, delay: 120 + i * 90, easing: ease, fill: 'forwards' }); });
    last.onfinish = function () { el.style.visibility = 'hidden'; el.style.pointerEvents = 'none'; ps.forEach(function (p) { p.getAnimations().forEach(function (a) { a.cancel(); }); p.style.transform = ''; }); };
  }
  function go(url) { cover(function () { location.href = url; }); }
  window.bbGo = go;

  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target.closest && e.target.closest('a[href]'); if (!a) return;
    if (a.target && a.target !== '_self') return;
    if (a.hasAttribute('download') || a.dataset.noTx !== undefined) return;
    var u; try { u = new URL(a.href, location.href); } catch (err) { return; }
    if (u.origin !== location.origin) return;
    if (u.pathname === location.pathname) return; // same page: hash links, filters, etc.
    if (/^\/(api|admin|uploads)\//.test(u.pathname) || /\.(mp4|jpg|png|webp|pdf|zip)$/i.test(u.pathname)) return;
    e.preventDefault(); go(u.href);
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', reveal); else reveal();
  addEventListener('pageshow', function (e) { if (e.persisted) { el.style.visibility = 'hidden'; el.style.pointerEvents = 'none'; P().forEach(function (p) { p.getAnimations().forEach(function (a) { a.cancel(); }); }); } });
})();
