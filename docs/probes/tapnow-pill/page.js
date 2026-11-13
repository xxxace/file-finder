(function () {
  var out = { url: location.href, vw: innerWidth, vh: innerHeight, title: document.title };
  out.text = (document.body.innerText || '').replace(/\n{2,}/g, '\n').slice(0, 1200);
  out.links = [].slice.call(document.querySelectorAll('a[href]'), 0, 20).map(function (a) { return a.getAttribute('href'); });
  out.btnCount = document.querySelectorAll('button').length;
  out.imgCount = document.querySelectorAll('img').length;

  function d(el) {
    var cs = getComputedStyle(el), r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(), cls: (el.className || '').toString().slice(0, 120),
      text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40),
      rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      bg: cs.backgroundColor, rad: cs.borderRadius, h: cs.height, fs: cs.fontSize, fw: cs.fontWeight,
      color: cs.color, pad: cs.padding, bd: cs.borderTopWidth + ' ' + cs.borderTopColor,
      bf: cs.backdropFilter, sh: cs.boxShadow === 'none' ? 'none' : cs.boxShadow.slice(0, 80)
    };
  }

  out.buttons = [].slice.call(document.querySelectorAll('button')).map(d).filter(function (b) { return b.rect[2] > 0; }).slice(0, 30);

  var pills = [], seen = [];
  var all = document.querySelectorAll('div,span,button,a,p');
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    if (seen.indexOf(el) >= 0) continue;
    seen.push(el);
    var cs = getComputedStyle(el), r = el.getBoundingClientRect();
    var rad = parseFloat(cs.borderTopLeftRadius) || 0;
    if (r.height > 0 && r.height <= 32 && r.width > 10 && r.width < 240 && rad >= 8) pills.push(d(el));
    if (pills.length > 40) break;
  }
  out.pills = pills;

  function skel(el, dp) {
    if (dp > 5) return '';
    var t = el.tagName.toLowerCase();
    var c = (el.className || '').toString().split(/\s+/).filter(Boolean).slice(0, 6).join('.');
    var own = [].filter.call(el.childNodes, function (n) { return n.nodeType === 3; })
      .map(function (n) { return n.textContent.trim(); }).join(' ').slice(0, 24);
    var kids = [].map.call(el.children, function (k) { return skel(k, dp + 1); }).filter(Boolean).join('\n');
    var self = '  '.repeat(dp) + t + (c ? '.' + c : '') + (own ? ' "' + own + '"' : '');
    return kids ? self + '\n' + kids : self;
  }
  out.skel = skel(document.body, 0).slice(0, 6000);
  return out;
})()
