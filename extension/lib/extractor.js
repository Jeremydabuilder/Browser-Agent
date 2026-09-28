// Functions injected into web pages with chrome.scripting.executeScript({ func }).
// IMPORTANT: each exported function must be fully self-contained (no imports, no outer variables),
// because Chrome serializes the function source into the page. They only READ the page.
// Tests call them directly with { __doc: jsdomDocument }.

export function extractPageContent(opts) {
  const doc = (opts && opts.__doc) || document;
  const maxChars = (opts && opts.maxChars) || 400000;
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED', 'SELECT', 'OPTION', 'BUTTON', 'INPUT', 'TEXTAREA']);
  const BOILERPLATE = 'nav, footer, [role="navigation"], [role="contentinfo"], [aria-hidden="true"], [hidden], .cookie-banner, #cookie-banner, [class*="cookie-consent"]';
  const BLOCK = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|DD|DIV|DL|DT|FIELDSET|FIGCAPTION|FIGURE|FORM|H[1-6]|HEADER|HR|LI|MAIN|OL|P|PRE|SECTION|TABLE|TBODY|THEAD|TFOOT|TR|UL|BR|TD|TH|DETAILS|SUMMARY)$/;
  const win = doc.defaultView;

  function hiddenByStyle(el) {
    if (typeof el.checkVisibility === 'function') {
      try { return !el.checkVisibility(); } catch (e) { /* ignore */ }
    }
    const style = el.getAttribute && el.getAttribute('style');
    if (style && /display\s*:\s*none|visibility\s*:\s*hidden/i.test(style)) return true;
    if (win && win.getComputedStyle) {
      try {
        const cs = win.getComputedStyle(el);
        return cs.display === 'none' || cs.visibility === 'hidden';
      } catch (e) { return false; }
    }
    return false;
  }

  function collect(root) {
    const out = [];
    let length = 0;
    function walk(node) {
      if (length > maxChars) return;
      if (node.nodeType === 3) {
        const t = node.nodeValue.replace(/\s+/g, ' ');
        if (t.trim()) { out.push(t); length += t.length; }
        return;
      }
      if (node.nodeType !== 1) return;
      const el = node;
      if (SKIP.has(el.tagName.toUpperCase())) return;
      if (el.matches && el.matches(BOILERPLATE)) return;
      if (hiddenByStyle(el)) return;
      const block = BLOCK.test(el.tagName.toUpperCase());
      if (block) out.push('\n');
      if (/^H[1-6]$/.test(el.tagName)) out.push('## ');
      if (el.tagName === 'LI') out.push('• ');
      for (const child of el.childNodes) walk(child);
      if (el.tagName === 'TD' || el.tagName === 'TH') out.push(' | ');
      if (block) out.push('\n');
    }
    walk(root);
    return out.join('').replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/ {2,}/g, ' ').trim();
  }

  const body = doc.body;
  let text = body ? collect(body) : '';
  const mainEl = doc.querySelector('main, [role="main"], article');
  if (mainEl) {
    const mainText = collect(mainEl);
    if (mainText.length > text.length * 0.4 && mainText.length > 200) text = mainText;
  }
  if (text.length > maxChars) text = text.slice(0, maxChars);

  const selection = (doc.getSelection && doc.getSelection()) ? String(doc.getSelection()).trim().slice(0, 20000) : '';
  const headings = Array.from(doc.querySelectorAll('h1, h2, h3')).slice(0, 40).map((h) => h.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const hasPasswordField = !!doc.querySelector('input[type="password"]');
  const canvasCount = doc.querySelectorAll('canvas').length;
  return {
    title: (doc.title || '').trim(),
    url: doc.location ? doc.location.href : (opts && opts.url) || '',
    lang: (doc.documentElement && doc.documentElement.lang) || '',
    contentType: doc.contentType || '',
    text,
    textLength: text.length,
    selection,
    headings,
    hasPasswordField,
    likelyCanvasApp: canvasCount > 0 && text.length < 500,
  };
}

export function extractAssignmentCandidates(opts) {
  const doc = (opts && opts.__doc) || document;
  const pageUrl = doc.location && doc.location.href && doc.location.href !== 'about:blank' ? doc.location.href : (opts && opts.url) || '';
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const textOf = (el) => (el ? clean(el.textContent) : '');
  const DATE_HINT = /\b(due|deadline)\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|\b\d{1,2}[\/.-]\d{1,2}([\/.-]\d{2,4})?\b|\b\d{4}-\d{2}-\d{2}\b|\b(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
  const GENERIC_HEADING = /^(assignments?|upcoming|to ?do|due( soon)?|this week|next week|today|tomorrow|homework|tasks?|overdue|coursework|calendar|dashboard|my work|work|past due|later|no due date)\b/i;
  function absUrl(href) {
    if (!href) return '';
    try {
      const u = new URL(href, pageUrl || undefined);
      return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : '';
    } catch (e) { return ''; }
  }
  function nearestHeading(el) {
    let node = el;
    for (let depth = 0; node && depth < 8; depth++) {
      let sib = node.previousElementSibling;
      while (sib) {
        if (/^H[1-4]$/.test(sib.tagName)) return textOf(sib);
        const inner = sib.querySelector && sib.querySelectorAll('h1,h2,h3,h4');
        if (inner && inner.length) return textOf(inner[inner.length - 1]);
        sib = sib.previousElementSibling;
      }
      node = node.parentElement;
    }
    return '';
  }
  function classFromHeading(el) {
    const h = nearestHeading(el);
    if (!h || GENERIC_HEADING.test(h) || h.length > 80) return '';
    return h;
  }
  const results = [];
  const seenEls = new Set();

  // 1) Tables with an assignment/title column and a due/date column.
  for (const table of Array.from(doc.querySelectorAll('table'))) {
    let headerCells = Array.from(table.querySelectorAll('thead th, thead td'));
    let rows = Array.from(table.querySelectorAll('tbody tr'));
    if (!headerCells.length) {
      const first = table.querySelector('tr');
      if (!first) continue;
      headerCells = Array.from(first.children);
      rows = Array.from(table.querySelectorAll('tr')).slice(1);
    }
    const headers = headerCells.map((c) => textOf(c).toLowerCase());
    const find = (re) => headers.findIndex((h) => re.test(h));
    const col = {
      title: find(/assignment|title|task|homework|name|activity|item|work|description of/),
      due: find(/due|deadline|date/),
      cls: find(/class|course|subject|section|period/),
      desc: find(/instruction|description|details|notes|summary|directions/),
    };
    if (col.title < 0 || col.due < 0 || col.title === col.due) continue;
    const tableClass = classFromHeading(table);
    for (const tr of rows) {
      const cells = Array.from(tr.children);
      if (cells.length < 2) continue;
      const titleCell = cells[col.title];
      const title = textOf(titleCell);
      if (!title) continue;
      const dueCell = cells[col.due];
      const timeEl = dueCell && dueCell.querySelector('time[datetime]');
      const link = titleCell && titleCell.querySelector('a[href]');
      results.push({
        title,
        className: col.cls >= 0 ? textOf(cells[col.cls]) : tableClass,
        classGuessed: col.cls < 0 && !!tableClass,
        instructions: col.desc >= 0 ? textOf(cells[col.desc]) : '',
        dueText: textOf(dueCell),
        dueAttr: timeEl ? timeEl.getAttribute('datetime') : '',
        url: link ? absUrl(link.getAttribute('href')) : '',
        pageUrl,
        method: 'table',
      });
      seenEls.add(tr);
    }
  }

  // 2) Repeated "assignment-like" elements (cards, list items) identified by class/id/data attributes.
  const ITEM_RE = /(^|[_-])(assignment|homework|task|todo|to-do|coursework|deliverable|stream-item|planner-item)s?([_-]|$)/i;
  const FIELD_RE = /(^|[_-])(title|name|heading|due|date|deadline|desc|description|details?|meta|course|class-?name|subject|status|points|grade|icon|link|actions?|button|instructions?|body|summary)([_-]|$)/i;
  const CONTAINER_RE = /(^|[_-])(list|container|wrapper|group|section|header|panel|column|feed|board|filters?)s?([_-]|$)/i;
  const ITEM_HINT = /(^|[_-])(item|card|row|entry|tile)([_-]|$)/i;
  const isItemToken = (t) => ITEM_RE.test(t) && (ITEM_HINT.test(t) || (!FIELD_RE.test(t) && !CONTAINER_RE.test(t)));
  const candidates = Array.from(doc.querySelectorAll('[class], [id], [data-type]')).filter((el) => {
    if (el.tagName === 'TABLE' || el.closest('table')) return false;
    const tokens = `${el.getAttribute('class') || ''} ${el.id || ''} ${el.getAttribute('data-type') || ''}`.split(/\s+/).filter(Boolean);
    return tokens.some(isItemToken);
  });
  // Keep innermost items only.
  const items = candidates.filter((el) => !candidates.some((other) => other !== el && el.contains(other)));
  const field = (el, re) => {
    for (const c of Array.from(el.querySelectorAll('[class], [id], [data-field]'))) {
      const sig = `${c.getAttribute('class') || ''} ${c.id || ''} ${c.getAttribute('data-field') || ''}`;
      if (re.test(sig)) return c;
    }
    return null;
  };
  for (const el of items) {
    if (seenEls.has(el)) continue;
    const titleEl = field(el, /title|name|heading/i) || el.querySelector('h1,h2,h3,h4,h5,h6,a[href],strong,b');
    const title = textOf(titleEl);
    if (!title || title.length > 250) continue;
    const dueEl = field(el, /due|deadline|date/i) || el.querySelector('time');
    const timeEl = el.querySelector('time[datetime]');
    let dueText = textOf(dueEl);
    if (!dueText) {
      const m = textOf(el).match(/\b(due|deadline)\b[^|•\n]{0,60}/i);
      dueText = m ? m[0] : '';
    }
    const clsEl = field(el, /course|class-?name|subject|section-?name|period/i);
    const descEl = field(el, /desc|instruction|detail|summary|body|directions/i) || el.querySelector('p');
    const link = (titleEl && titleEl.closest('a[href]')) || (titleEl && titleEl.querySelector && titleEl.querySelector('a[href]')) || el.querySelector('a[href]');
    const heading = clsEl ? '' : classFromHeading(el);
    results.push({
      title,
      className: clsEl ? textOf(clsEl) : heading,
      classGuessed: !clsEl && !!heading,
      instructions: descEl && descEl !== titleEl ? textOf(descEl).slice(0, 2000) : '',
      dueText,
      dueAttr: timeEl ? timeEl.getAttribute('datetime') : '',
      url: link ? absUrl(link.getAttribute('href')) : '',
      pageUrl,
      method: 'card',
    });
    seenEls.add(el);
  }

  // 3) Fallback: list items / paragraphs that mention "due".
  if (!results.length) {
    for (const el of Array.from(doc.querySelectorAll('li, p, div'))) {
      if (el.querySelector('li, p, div')) continue;
      const t = textOf(el);
      if (t.length < 6 || t.length > 400 || !/\bdue\b/i.test(t) || !DATE_HINT.test(t)) continue;
      const strong = el.querySelector('strong, b, a[href]');
      let title = strong ? textOf(strong) : t.split(/\s*[-–—:|(]\s*due\b|\s+due\b/i)[0];
      title = clean(title).replace(/[-–—:|,]+$/, '').trim();
      if (!title || title.length > 200) continue;
      const m = t.match(/\bdue\b[\s\S]*/i);
      const link = el.querySelector('a[href]');
      const heading = classFromHeading(el);
      results.push({
        title,
        className: heading,
        classGuessed: !!heading,
        instructions: '',
        dueText: m ? clean(m[0]).slice(0, 120) : '',
        dueAttr: '',
        url: link ? absUrl(link.getAttribute('href')) : '',
        pageUrl,
        method: 'text',
      });
    }
  }

  // De-duplicate within the page.
  const seen = new Set();
  const unique = [];
  for (const r of results) {
    const key = `${r.title.toLowerCase()}|${r.dueText.toLowerCase()}|${r.className.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(r);
  }
  const h1 = doc.querySelector('h1');
  return { pageUrl, pageTitle: clean(doc.title), pageHeading: textOf(h1), candidates: unique.slice(0, 300) };
}
