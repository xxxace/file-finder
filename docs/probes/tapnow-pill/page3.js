(function () {
  function full(el) {
    if (!el) return null;
    var cs = getComputedStyle(el), r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      cls: (el.getAttribute('class') || '').slice(0, 300),
      html: el.outerHTML.slice(0, 400),
      text: (el.innerText || '').trim(),
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
      bg: cs.backgroundColor,
      bgVarBlack: getComputedStyle(document.documentElement).getPropertyValue('--black'),
      color: cs.color,
      radius: cs.borderRadius,
      backdrop: cs.backdropFilter,
      shadow: cs.boxShadow,
      padding: cs.padding,
      fontSize: cs.fontSize,
      fontWeight: cs.fontWeight,
      fontFamily: cs.fontFamily,
      letterSpacing: cs.letterSpacing,
      lineHeight: cs.lineHeight,
      border: cs.border,
      gap: cs.gap,
      display: cs.display,
      alignItems: cs.alignItems,
      opacity: cs.opacity,
      filter: cs.filter,
      willChange: cs.willChange,
      isWebkitBackdrop: cs.webkitBackdropFilter
    };
  }

  var out = {};
  // 1) 用户给的 XPath（原样）
  var XP = '/html/body/div[2]/div/div/main/div/div[3]/div/div/div/div/div/div/div/div[1]/div/div[2]/div[1]/div[2]/div[1]/div[2]/button';
  var hit = null;
  try { hit = document.evaluate(XP, document, null, 9, null).singleNodeValue; } catch (e) { }
  out.byXPath = full(hit);

  // 2) 卡片上「查看创作过程」胶囊（同款，按文本兜底）
  var btns = [].slice.call(document.querySelectorAll('button')).filter(function (b) {
    return (b.innerText || '').trim() === '查看创作过程';
  });
  out.pillButton = full(btns[0]);
  out.pillButtonCount = btns.length;

  // 3) 时长胶囊
  var dur = [].slice.call(document.querySelectorAll('div')).filter(function (d) {
    return /^\d{2}:\d{2}$/.test((d.innerText || '').trim()) && d.getBoundingClientRect().height < 30;
  });
  out.duration = full(dur[0]);

  // 4) 卡片整体 + 卡片内所有子元素（看一眼层级与间距）
  var card = document.querySelector('[data-testid], a[href*="/home/taptv/"]');
  var cardEl = btns[0] ? btns[0].closest('div[class*="relative"]') : null;
  out.cardBox = full(cardEl);
  out.cardChildren = cardEl ? [].slice.call(cardEl.querySelectorAll('*')).slice(0, 14).map(function (e) {
    var cs = getComputedStyle(e), r = e.getBoundingClientRect();
    return {
      tag: e.tagName.toLowerCase(), cls: (e.getAttribute('class') || '').slice(0, 120),
      rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      pos: cs.position, bg: cs.backgroundColor, rad: cs.borderRadius,
      bf: cs.backdropFilter, fs: cs.fontSize
    };
  }) : null;

  // 截图区域：拿卡片按钮所在卡的封面盒
  out.clip = cardEl ? (function () {
    var r = cardEl.getBoundingClientRect();
    return { x: Math.max(0, r.x - 4), y: Math.max(0, r.y - 4), width: Math.min(390, r.width + 8), height: Math.min(844, r.height + 8) };
  })() : null;

  return out;
})()
