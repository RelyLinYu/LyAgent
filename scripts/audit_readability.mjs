import fs from 'node:fs/promises';
import path from 'node:path';

export async function auditReadability(page, out, state) {
  const checks = await page.evaluate(() => {
    const rgb = value => (value.match(/[\d.]+/g) || []).map(Number);
    const blend = (fg, bg, alpha) => fg.map((v, i) => v * alpha + bg[i] * (1 - alpha));
    const lum = color => color.map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((s, v, i) => s + v * [.2126, .7152, .0722][i], 0);
    const results = [];
    for (const el of document.querySelectorAll('button,label,input,textarea,select,p,h1,h2,h3,summary,dt,dd,code,pre,span,small,a,legend')) {
      const box = el.getBoundingClientRect();
      if (!box.width || !box.height || box.bottom <= 0 || box.top >= innerHeight || box.right <= 0 || box.left >= innerWidth || el.matches(':disabled') || el.closest('fieldset:disabled')) continue;
      const style = getComputedStyle(el);
      const directText = [...el.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join('').trim();
      if (!directText && !el.matches('input,textarea,select')) continue;
      const ancestors = []; let transparent = false;
      for (let node = el; node; node = node.parentElement) { ancestors.unshift(node); if (Number(getComputedStyle(node).opacity) < 1) transparent = true; }
      if (transparent || style.visibility !== 'visible') continue;
      let bg = [21, 22, 23];
      for (const node of ancestors) {
        const computed = getComputedStyle(node);
        const color = rgb(computed.backgroundColor);
        if (color.length >= 3) bg = blend(color.slice(0, 3), bg, color[3] ?? 1);
        if (node.classList.contains('app') && computed.backgroundImage !== 'none') {
          // Worst-case white bitmap under the actual authored darkening layer.
          const dim = computed.backgroundImage.match(/rgba?\(15[, ]+16[, ]+17[^)]*?[,/]\s*([\d.]+)\)/);
          if (!dim) throw Error('Unrecognized wallpaper darkening; cannot certify contrast');
          bg = blend([15, 16, 17], [255, 255, 255], Number(dim[1]));
        }
      }
      const color = rgb(style.color), foreground = blend(color.slice(0, 3), bg, color[3] ?? 1);
      const ratio = (Math.max(lum(foreground), lum(bg)) + .05) / (Math.min(lum(foreground), lum(bg)) + .05);
      const large = parseFloat(style.fontSize) >= 24 || (parseFloat(style.fontSize) >= 18.66 && Number(style.fontWeight) >= 700);
      results.push({ tag: el.tagName, text: (directText || el.getAttribute('aria-label') || '').slice(0, 70), ratio, minimum: large ? 3 : 4.5, passed: ratio >= (large ? 3 : 4.5) });
      if (el.matches('input,textarea') && el.getAttribute('placeholder') && !el.value) {
        const placeholder = getComputedStyle(el, '::placeholder');
        const pc = rgb(placeholder.color), fg = blend(pc.slice(0, 3), bg, (pc[3] ?? 1) * Number(placeholder.opacity));
        const pr = (Math.max(lum(fg), lum(bg)) + .05) / (Math.min(lum(fg), lum(bg)) + .05);
        results.push({ tag: 'placeholder', text: el.getAttribute('placeholder'), ratio: pr, minimum: 4.5, passed: pr >= 4.5 });
      }
    }
    return results;
  });
  const filename = path.join(out, 'readability.json');
  let report;
  try { report = JSON.parse(await fs.readFile(filename, 'utf8')); } catch { report = { mode: 'computed-css-worst-white-wallpaper-real-http-ui', limits: 'Visible enabled text and placeholders; default canvas or white bitmap upper bound under verified dim layer. Excludes disabled/ancestor opacity, occlusion, screenshot pixel sampling and WCAG certification. Hover/focus states only where explicitly exercised.', states: [] }; }
  report.states.push({ state, width: page.viewportSize().width, checks, failures: checks.filter(check => !check.passed) });
  await fs.writeFile(filename, JSON.stringify(report, null, 2));
  if (!checks.length || checks.some(check => !check.passed)) throw Error('Readability failed in ' + state + ': ' + JSON.stringify(checks.filter(check => !check.passed)));
}
