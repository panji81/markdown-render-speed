// parse.js — a fast, dependency-free CommonMark 0.31.2 + GFM 0.29 renderer
// whose parse(markdown) returns exactly the HTML marked 18.1.3 renders with
// default options. Written from the CommonMark/GFM specifications and from
// marked's observable behaviour on the practice cases; no code is copied
// from marked or any other renderer.

const RE_PUNCT = /[\p{P}\p{S}]/u;

function isAsciiPunct(code) {
  return (code >= 33 && code <= 47) || (code >= 58 && code <= 64) ||
    (code >= 91 && code <= 96) || (code >= 123 && code <= 126);
}
function isSpace(code) { return code === 32 || code === 9 || code === 10 || code === 11 || code === 12 || code === 13; }
function isUnicodeWs(code) {
  return code === 32 || code === 9 || code === 10 || code === 11 || code === 12 || code === 13 ||
    code === 0xA0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200A) ||
    code === 0x2028 || code === 0x2029 || code === 0x202F || code === 0x205F || code === 0x3000;
}
function isPunctChar(ch) { return RE_PUNCT.test(ch); }
function isDigit(code) { return code >= 48 && code <= 57; }

// ---------- entity handling ----------
// marked's observable behaviour: a numeric reference &#...; / &#x...; is
// decoded (0 -> U+FFFD, surrogates -> U+FFFD, out of range -> left escaped);
// a named reference &[A-Za-z0-9]+; passes through verbatim, real or not;
// anything else leaves the & escaped.
function matchEntity(s, i) {
  // s[i] === '&'. Returns {len, text} or null.
  const n = s.length;
  if (i + 1 >= n) return null;
  if (s.charCodeAt(i + 1) === 35) { // #
    let j = i + 2, hex = false;
    if (j < n && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) { hex = true; j++; }
    const ds = j;
    if (hex) { while (j < n && ((s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57) || (s.charCodeAt(j) >= 97 && s.charCodeAt(j) <= 102) || (s.charCodeAt(j) >= 65 && s.charCodeAt(j) <= 70))) j++; }
    else { while (j < n && s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57) j++; }
    if (j === ds || j >= n || s.charCodeAt(j) !== 59) return null; // no digits / no ';'
    const num = parseInt(s.slice(ds, j), hex ? 16 : 10);
    if (!isFinite(num) || num > 0x10FFFF) return null;
    let ch;
    if (num === 0 || (num >= 0xD800 && num <= 0xDFFF)) ch = '\uFFFD';
    else ch = String.fromCodePoint(num);
    const len = j - i + 1;
    if (ch === '&') return { len, text: '&amp;' };
    if (ch === '<') return { len, text: '&lt;' };
    if (ch === '>') return { len, text: '&gt;' };
    if (ch === '"') return { len, text: '&quot;' };
    if (ch === "'") return { len, text: '&#39;' };
    return { len, text: ch };
  }
  let j = i + 1;
  while (j < n) {
    const c = s.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57)) j++;
    else break;
  }
  if (j === i + 1 || j >= n || s.charCodeAt(j) !== 59) return null;
  return { len: j - i + 1, text: s.slice(i, j + 1) };
}

// Escape text for HTML output, with marked's entity passthrough.
function escText(s, out) {
  // Plain escaping only: entities are resolved at parse time (parseInline),
  // so a & here is always literal and must become &amp;.
  let start = 0;
  const n = s.length;
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) { if (i > start) out.push(s.slice(start, i)); out.push('&amp;'); start = i + 1; }
    else if (c === 60) { if (i > start) out.push(s.slice(start, i)); out.push('&lt;'); start = i + 1; }
    else if (c === 62) { if (i > start) out.push(s.slice(start, i)); out.push('&gt;'); start = i + 1; }
    else if (c === 34) { if (i > start) out.push(s.slice(start, i)); out.push('&quot;'); start = i + 1; }
    else if (c === 39) { if (i > start) out.push(s.slice(start, i)); out.push('&#39;'); start = i + 1; }
  }
  if (start < n) out.push(s.slice(start));
}

// Escape for attribute values (href, title, code info): valid entities pass
// through verbatim, a bare & becomes &amp;. Used where the value was not
// already entity-resolved by the inline parser.
function escAttr(s, out) {
  let start = 0;
  const n = s.length;
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) { // &
      const e = matchEntity(s, i);
      if (e) {
        if (i > start) out.push(s.slice(start, i));
        out.push(e.text);
        i += e.len - 1; start = i + 1;
      } else {
        if (i > start) out.push(s.slice(start, i));
        out.push('&amp;'); start = i + 1;
      }
    } else if (c === 60) { if (i > start) out.push(s.slice(start, i)); out.push('&lt;'); start = i + 1; }
    else if (c === 62) { if (i > start) out.push(s.slice(start, i)); out.push('&gt;'); start = i + 1; }
    else if (c === 34) { if (i > start) out.push(s.slice(start, i)); out.push('&quot;'); start = i + 1; }
    else if (c === 39) { if (i > start) out.push(s.slice(start, i)); out.push('&#39;'); start = i + 1; }
  }
  if (start < n) out.push(s.slice(start));
}

// Percent-encode a URL the way marked's cleanUrl does: space, ", <, >,
// control chars and non-ASCII become UTF-8 percent sequences.
function cleanUrl(url) {
  let need = false;
  for (let i = 0; i < url.length; i++) {
    const c = url.charCodeAt(i);
    if (c === 32 || c === 34 || c === 60 || c === 62 || c === 92 || c < 32 || c >= 0x80) { need = true; break; }
  }
  if (!need) return url;
  let out = '';
  for (let i = 0; i < url.length; i++) {
    const c = url.charCodeAt(i);
    if (c === 32 || c === 34 || c === 60 || c === 62 || c === 92 || c < 32 || c >= 0x80) {
      const ch = url[i];
      const bytes = new TextEncoder().encode(ch);
      for (const b of bytes) out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
    } else out += url[i];
  }
  return out;
}

// Resolve backslash escapes (before ASCII punctuation) in a string.
function unescapeStr(s) {
  if (s.indexOf('\\') === -1) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 92 && i + 1 < s.length && isAsciiPunct(s.charCodeAt(i + 1))) { out += s[i + 1]; i++; }
    else out += s[i];
  }
  return out;
}

function normalizeLabel(s) {
  return unescapeStr(s).replace(/\s+/g, ' ').trim().toLowerCase();
}

// ---------- inline parsing ----------
// Node types: text, em, strong, del, code, link, image, html, br, delim (marker)

function flanking(str, i, j) {
  // delimiter run is str[i..j); returns [leftFlanking, rightFlanking]
  const prev = i > 0 ? str[i - 1] : '';
  const next = j < str.length ? str[j] : '';
  const prevWs = prev === '' ? true : isUnicodeWs(prev.charCodeAt(0));
  const nextWs = next === '' ? true : isUnicodeWs(next.charCodeAt(0));
  const prevPunct = prev !== '' && isPunctChar(prev);
  const nextPunct = next !== '' && isPunctChar(next);
  const left = !nextWs && (!nextPunct || prevWs || prevPunct);
  const right = !prevWs && (!prevPunct || nextWs || nextPunct);
  return [left, right];
}

const EMAIL_LOCAL = /[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]/;
function isEmailLocalChar(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) ||
    c === 46 || c === 33 || c === 35 || c === 36 || c === 37 || c === 38 || c === 39 ||
    c === 42 || c === 43 || c === 47 || c === 61 || c === 63 || c === 94 || c === 95 ||
    c === 96 || c === 123 || c === 124 || c === 125 || c === 126 || c === 45;
}
function isDomainChar(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45;
}

// Parse a link label starting at str[j] === '['. Returns {label, end} or null.
// Label: balanced brackets, backslash escapes, max 999 chars.
function parseLabel(str, j) {
  const n = str.length;
  let depth = 0, k = j;
  while (k < n) {
    const c = str.charCodeAt(k);
    if (c === 92 && k + 1 < n && isAsciiPunct(str.charCodeAt(k + 1))) { k += 2; continue; }
    if (c === 91) { depth++; if (depth > 1 && k - j > 999) return null; k++; continue; }
    if (c === 93) { depth--; if (depth === 0) return { label: str.slice(j + 1, k), end: k + 1 }; k++; continue; }
    k++;
    if (k - j > 1000) return null;
  }
  return null;
}

// Parse an inline link destination + optional title starting at str[j].
// Returns {href, title, end} or null. j points at '(' content (after the '(').
function parseLinkDestTitle(str, j) {
  const n = str.length;
  let k = j;
  while (k < n && isSpace(str.charCodeAt(k))) k++;
  if (k >= n) return null;
  let href = null;
  if (str.charCodeAt(k) === 60) { // <...>
    let m = k + 1;
    let ok = false;
    while (m < n) {
      const c = str.charCodeAt(m);
      if (c === 10 || c === 60) break;
      if (c === 62) { ok = true; break; }
      m++;
    }
    if (!ok) return null;
    href = unescapeStr(str.slice(k + 1, m));
    k = m + 1;
  } else {
    // bare destination: no spaces/controls, balanced parens, backslash escapes
    let m = k, depth = 0;
    let dest = '';
    while (m < n) {
      const c = str.charCodeAt(m);
      if (c === 32 || c === 10 || c === 9 || c < 32) break;
      if (c === 92 && m + 1 < n && isAsciiPunct(str.charCodeAt(m + 1))) { dest += str[m + 1]; m += 2; continue; }
      if (c === 40) { depth++; dest += '('; m++; continue; }
      if (c === 41) {
        if (depth === 0) break;
        depth--; dest += ')'; m++; continue;
      }
      dest += str[m]; m++;
    }
    if (m === k) return null;
    if (depth !== 0) return null;
    href = dest;
    k = m;
  }
  // optional title
  let title = null;
  let k2 = k;
  while (k2 < n && isSpace(str.charCodeAt(k2))) k2++;
  if (k2 < n) {
    const tc = str.charCodeAt(k2);
    if (tc === 34 || tc === 39 || tc === 40) { // " ' (
      const close = tc === 40 ? 41 : tc;
      let m = k2 + 1, t = '';
      let ok = false;
      while (m < n) {
        const c = str.charCodeAt(m);
        if (c === 92 && m + 1 < n && isAsciiPunct(str.charCodeAt(m + 1))) { t += str[m + 1]; m += 2; continue; }
        if (c === close) { ok = true; break; }
        if (tc === 40 && c === 40) break; // no nested ( in ( title
        t += str[m]; m++;
      }
      if (ok) { title = t; k = m + 1; k2 = k; while (k2 < n && isSpace(str.charCodeAt(k2))) k2++; }
      else if (tc !== 40) { /* unterminated title: not a link unless next is ) */ }
    }
  }
  if (k2 >= n || str.charCodeAt(k2) !== 41) return null;
  return { href, title, end: k2 + 1 };
}

// Try to parse the tail after ']' at position j (index just past ']').
// Returns {href, title, end} or null.
function parseLinkTail(str, j, bracket, refs) {
  const n = str.length;
  let k = j;
  while (k < n && isSpace(str.charCodeAt(k))) k++;
  if (k < n && str.charCodeAt(k) === 40) { // (...
    return parseLinkDestTitle(str, k + 1);
  }
  if (k < n && str.charCodeAt(k) === 91) { // [label]
    const lab = parseLabel(str, k);
    if (lab) {
      const key = lab.label === '' ? normalizeLabel(str.slice(bracket.strIdx + 1, bracket.closeIdx)) : normalizeLabel(lab.label);
      const ref = refs.get(key);
      if (ref) return { href: ref.dest, title: ref.title, end: lab.end };
    }
    return null;
  }
  // shortcut reference: label is the bracket's own text
  const key = normalizeLabel(str.slice(bracket.strIdx + 1, bracket.closeIdx));
  const ref = refs.get(key);
  if (ref) return { href: ref.dest, title: ref.title, end: j };
  return null;
}

// Process emphasis delimiters on a nodes array with its delims list.
function processEmphasis(nodes, delims) {
  const bottom = { '*': -1, '_': -1, '~': -1 };
  let ci = 0;
  while (ci < delims.length) {
    const closer = delims[ci];
    if (!closer.canClose || closer.len === 0) { ci++; continue; }
    let oi = -1;
    for (let j = ci - 1; j > bottom[closer.ch]; j--) {
      const opener = delims[j];
      if (opener.ch !== closer.ch || !opener.canOpen || opener.len === 0) continue;
      if ((opener.canClose || closer.canOpen) && ((opener.len + closer.len) % 3 === 0) && (opener.len % 3 !== 0 || closer.len % 3 !== 0)) continue;
      oi = j; break;
    }
    if (oi === -1) { bottom[closer.ch] = ci; ci++; continue; }
    const opener = delims[oi];
    const use = (opener.len >= 2 && closer.len >= 2) ? 2 : 1;
    const tag = closer.ch === '~' ? 'del' : (use === 2 ? 'strong' : 'em');
    const oiNode = nodes.indexOf(opener);
    const ciNode = nodes.indexOf(closer);
    if (oiNode === -1 || ciNode === -1 || ciNode <= oiNode) { ci++; continue; }
    const children = nodes.slice(oiNode + 1, ciNode);
    const newNode = { t: tag, c: children };
    opener.len -= use; closer.len -= use;
    const rep = [];
    if (opener.len > 0) rep.push(opener);
    rep.push(newNode);
    if (closer.len > 0) rep.push(closer);
    nodes.splice(oiNode, ciNode - oiNode + 1, ...rep);
    if (closer.len === 0) ci++;
    // else reprocess the same closer (do not advance ci)
  }
}

// Render inline nodes into out[].
function renderInline(nodes, out) {
  for (const node of nodes) {
    switch (node.t) {
      case 'text': escText(node.s, out); break;
      case 'delim': out.push(node.ch.repeat(node.len)); break;
      case 'em': out.push('<em>'); renderInline(node.c, out); out.push('</em>'); break;
      case 'strong': out.push('<strong>'); renderInline(node.c, out); out.push('</strong>'); break;
      case 'del': out.push('<del>'); renderInline(node.c, out); out.push('</del>'); break;
      case 'code': out.push('<code>'); escText(node.s, out); out.push('</code>'); break;
      case 'br': out.push('<br>'); break;
      case 'raw': out.push(node.s); break;
      case 'html': out.push(node.s); break;
      case 'link': {
        out.push('<a href="');
        escAttr(cleanUrl(node.href), out);
        out.push('"');
        if (node.title !== null && node.title !== undefined) { out.push(' title="'); escAttr(node.title, out); out.push('"'); }
        out.push('>');
        renderInline(node.c, out);
        out.push('</a>');
        break;
      }
      case 'image': {
        out.push('<img src="');
        escAttr(cleanUrl(node.href), out);
        out.push('" alt="');
        escAttr(node.alt, out);
        out.push('"');
        if (node.title !== null && node.title !== undefined) { out.push(' title="'); escAttr(node.title, out); out.push('"'); }
        out.push('>');
        break;
      }
    }
  }
}

// Strip tags from rendered HTML (for image alt text).
function stripTags(html) {
  let out = '';
  let i = 0;
  while (i < html.length) {
    if (html.charCodeAt(i) === 60) {
      const j = html.indexOf('>', i);
      if (j === -1) { out += html.slice(i); break; }
      i = j + 1;
    } else { out += html[i]; i++; }
  }
  return out;
}

// ---------- inline HTML tags ----------
function parseHtmlTag(str, i) {
  const n = str.length;
  if (str.charCodeAt(i) !== 60) return null; // <
  if (i + 1 >= n) return null;
  const c1 = str.charCodeAt(i + 1);
  // comment <!-- ... -->
  if (c1 === 33 && str.startsWith('!--', i + 1)) {
    const e = str.indexOf('-->', i + 4);
    if (e === -1) return null;
    return { end: e + 3 };
  }
  // processing instruction <? ... ?>
  if (c1 === 63) {
    const e = str.indexOf('?>', i + 2);
    if (e === -1) return null;
    return { end: e + 2 };
  }
  // declaration <!A ... > or CDATA <![CDATA[ ... ]]>
  if (c1 === 33) {
    if (str.startsWith('[CDATA[', i + 2)) {
      const e = str.indexOf(']]>', i + 9);
      if (e === -1) return null;
      return { end: e + 3 };
    }
    const c2 = i + 2 < n ? str.charCodeAt(i + 2) : 0;
    if ((c2 >= 65 && c2 <= 90) || (c2 >= 97 && c2 <= 122)) {
      const e = str.indexOf('>', i + 2);
      if (e === -1) return null;
      return { end: e + 1 };
    }
    return null;
  }
  // closing tag </name ...>
  if (c1 === 47) {
    let j = i + 2;
    if (j >= n || !((str.charCodeAt(j) >= 65 && str.charCodeAt(j) <= 90) || (str.charCodeAt(j) >= 97 && str.charCodeAt(j) <= 122))) return null;
    while (j < n && ((str.charCodeAt(j) >= 65 && str.charCodeAt(j) <= 90) || (str.charCodeAt(j) >= 97 && str.charCodeAt(j) <= 122) || (str.charCodeAt(j) >= 48 && str.charCodeAt(j) <= 57) || str.charCodeAt(j) === 45)) j++;
    while (j < n && isSpace(str.charCodeAt(j))) j++;
    if (j >= n || str.charCodeAt(j) !== 62) return null;
    return { end: j + 1 };
  }
  // open tag <name attrs...>
  if (!((c1 >= 65 && c1 <= 90) || (c1 >= 97 && c1 <= 122))) return null;
  let j = i + 1;
  while (j < n && ((str.charCodeAt(j) >= 65 && str.charCodeAt(j) <= 90) || (str.charCodeAt(j) >= 97 && str.charCodeAt(j) <= 122) || (str.charCodeAt(j) >= 48 && str.charCodeAt(j) <= 57) || str.charCodeAt(j) === 45)) j++;
  while (true) {
    while (j < n && isSpace(str.charCodeAt(j))) j++;
    if (j >= n) return null;
    const c = str.charCodeAt(j);
    if (c === 62) return { end: j + 1 }; // >
    if (c === 47) { // /
      if (j + 1 < n && str.charCodeAt(j + 1) === 62) return { end: j + 2 };
      return null;
    }
    // attribute name
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 58)) return null;
    j++;
    while (j < n) {
      const d = str.charCodeAt(j);
      if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57) || d === 95 || d === 58 || d === 46 || d === 45) j++;
      else break;
    }
    while (j < n && isSpace(str.charCodeAt(j))) j++;
    if (j < n && str.charCodeAt(j) === 61) { // =
      j++;
      while (j < n && isSpace(str.charCodeAt(j))) j++;
      if (j >= n) return null;
      const q = str.charCodeAt(j);
      if (q === 34 || q === 39) { // quoted
        const e = str.indexOf(String.fromCharCode(q), j + 1);
        if (e === -1) return null;
        j = e + 1;
      } else { // unquoted
        while (j < n) {
          const d = str.charCodeAt(j);
          if (isSpace(d) || d === 34 || d === 39 || d === 61 || d === 60 || d === 62 || d === 96) break;
          j++;
        }
        if (j === n) return null;
      }
    }
  }
}

// ---------- extended autolinks (GFM) ----------
// Parse a www. autolink starting at str[i] ('w'). Returns {end, text} or null.
function parseWwwAutolink(str, i) {
  const n = str.length;
  let j = i + 4; // past 'www.'
  // domain: labels separated by '.', ending in a TLD of 2+ letters
  let labels = 0, lastLabelStart = j, lastLabelIsTld = false, domainEnd = -1;
  let k = j;
  while (k < n) {
    const c = str.charCodeAt(k);
    if (isDomainChar(c) || c === 46) { k++; continue; }
    break;
  }
  // validate the domain substring str[j..k)
  const dom = str.slice(j, k);
  if (!dom) return null;
  const parts = dom.split('.');
  // the first label starts right after 'www.'; the whole domain is 'www.' + dom
  const allParts = ['www', ...parts];
  for (let p = 0; p < allParts.length; p++) {
    const lab = allParts[p];
    if (!lab) return null;
    if (lab[0] === '-' || lab[lab.length - 1] === '-') return null;
    for (let q = 0; q < lab.length; q++) if (!isDomainChar(lab.charCodeAt(q))) return null;
  }
  const tld = allParts[allParts.length - 1];
  if (tld.length < 2) return null;
  for (let q = 0; q < tld.length; q++) {
    const c = tld.charCodeAt(q);
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122))) return null;
  }
  domainEnd = k;
  // optional path: starts with '/'
  let end = domainEnd;
  if (end < n && str.charCodeAt(end) === 47) {
    let p = end;
    let depth = 0;
    while (p < n) {
      const c = str.charCodeAt(p);
      if (c === 32 || c === 10 || c === 60) break;
      if (c === 38) { // &entity; terminates the path
        let m = p + 1;
        while (m < n && ((str.charCodeAt(m) >= 65 && str.charCodeAt(m) <= 90) || (str.charCodeAt(m) >= 97 && str.charCodeAt(m) <= 122) || (str.charCodeAt(m) >= 48 && str.charCodeAt(m) <= 57))) m++;
        if (m > p + 1 && m < n && str.charCodeAt(m) === 59) break;
      }
      if (c === 40) depth++;
      else if (c === 41) { if (depth === 0) break; depth--; }
      p++;
    }
    end = p;
    // strip trailing punctuation
    while (end > domainEnd) {
      const c = str.charCodeAt(end - 1);
      if (c === 46 || c === 44 || c === 59 || c === 58 || c === 33 || c === 63 || c === 42 || c === 95 || c === 126 || c === 39 || c === 34) end--;
      else if (c === 41 && depth === 0) end--; // unbalanced ) — depth is 0 here only if no open parens; recompute below
      else break;
    }
    // fix unbalanced trailing parens: count parens in the path
    let d2 = 0;
    for (let q = domainEnd; q < end; q++) {
      if (str.charCodeAt(q) === 40) d2++;
      else if (str.charCodeAt(q) === 41) d2--;
    }
    while (d2 < 0 && end > domainEnd && str.charCodeAt(end - 1) === 41) { end--; d2++; }
  }
  if (end === i + 4) return null;
  return { end, text: str.slice(i, end) };
}

// Parse an extended email autolink ending at '@' at position atIdx, with the
// local part being the maximal email-local run ending at atIdx. Returns
// {start, end, text} or null. `before` is the char before the local part.
function parseEmailAutolink(str, atIdx) {
  const n = str.length;
  let ls = atIdx;
  while (ls > 0 && isEmailLocalChar(str.charCodeAt(ls - 1))) ls--;
  if (ls === atIdx) return null;
  const local = str.slice(ls, atIdx);
  if (local[0] === '.' || local[local.length - 1] === '.') return null;
  // domain after @
  let k = atIdx + 1;
  let ds = k;
  while (k < n && (isDomainChar(str.charCodeAt(k)) || str.charCodeAt(k) === 46)) k++;
  const dom = str.slice(ds, k);
  if (!dom) return null;
  const parts = dom.split('.');
  if (parts.length < 2) return null;
  for (const lab of parts) {
    if (!lab) return null;
    if (lab[0] === '-' || lab[lab.length - 1] === '-') return null;
    for (let q = 0; q < lab.length; q++) if (!isDomainChar(lab.charCodeAt(q))) return null;
  }
  const tld = parts[parts.length - 1];
  if (tld.length < 2) return null;
  for (let q = 0; q < tld.length; q++) {
    const c = tld.charCodeAt(q);
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122))) return null;
  }
  return { start: ls, end: k, text: str.slice(ls, k) };
}

// ---------- the inline scanner ----------
export function parseInline(str, refs) {
  const nodes = [];
  const delims = [];
  const brackets = [];
  let buf = '';
  const flush = () => { if (buf) { nodes.push({ t: 'text', s: buf }); buf = ''; } };
  const n = str.length;
  let i = 0;
  while (i < n) {
    const c = str.charCodeAt(i);
    if (c === 92) { // backslash
      const nc = i + 1 < n ? str.charCodeAt(i + 1) : 0;
      if (nc === 10) { flush(); nodes.push({ t: 'br' }); i += 2; continue; }
      if (isAsciiPunct(nc)) { buf += str[i + 1]; i += 2; continue; }
      buf += '\\'; i++; continue;
    }
    if (c === 96) { // backtick run -> code span
      let j = i; while (j < n && str.charCodeAt(j) === 96) j++;
      const run = j - i;
      const pat = '`'.repeat(run);
      let found = -1, k = str.indexOf(pat, j);
      while (k !== -1) {
        const before = k > 0 && str.charCodeAt(k - 1) === 96;
        const after = k + run < n && str.charCodeAt(k + run) === 96;
        if (!before && !after) { found = k; break; }
        k = str.indexOf(pat, k + 1);
      }
      if (found !== -1) {
        let content = str.slice(j, found).replace(/\n/g, ' ');
        if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && /[^ ]/.test(content)) content = content.slice(1, -1);
        flush(); nodes.push({ t: 'code', s: content }); i = found + run; continue;
      }
      buf += pat; i = j; continue;
    }
    if (c === 42 || c === 95 || c === 126) { // * _ ~
      let j = i; while (j < n && str.charCodeAt(j) === c) j++;
      const run = j - i;
      if (c === 126 && run > 2) { buf += str.slice(i, j); i = j; continue; }
      const [left, right] = flanking(str, i, j);
      const prevCh = i > 0 ? str[i - 1] : '';
      const nextCh = j < n ? str[j] : '';
      let canOpen, canClose;
      if (c === 95) {
        canOpen = left && (!right || (prevCh !== '' && isPunctChar(prevCh)));
        canClose = right && (!left || (nextCh !== '' && isPunctChar(nextCh)));
      } else {
        canOpen = left; canClose = right;
      }
      if (!canOpen && !canClose) { buf += str.slice(i, j); i = j; continue; }
      flush();
      const marker = { t: 'delim', ch: String.fromCharCode(c), len: run, canOpen, canClose };
      nodes.push(marker); delims.push(marker);
      i = j; continue;
    }
    if (c === 91) { // [
      flush();
      const tn = { t: 'text', s: '[' };
      nodes.push(tn);
      brackets.push({ node: tn, bang: null, strIdx: i, closeIdx: -1, image: false, active: true });
      i++; continue;
    }
    if (c === 33 && i + 1 < n && str.charCodeAt(i + 1) === 91) { // ![
      flush();
      const bang = { t: 'text', s: '!' };
      nodes.push(bang);
      const tn = { t: 'text', s: '[' };
      nodes.push(tn);
      brackets.push({ node: tn, bang, strIdx: i + 1, closeIdx: -1, image: true, active: true });
      i += 2; continue;
    }
    if (c === 93) { // ]
      let bi = brackets.length - 1;
      while (bi >= 0 && !brackets[bi].active) bi--;
      if (bi < 0) { buf += ']'; i++; continue; }
      const br = brackets[bi];
      br.closeIdx = i;
      const link = parseLinkTail(str, i + 1, br, refs);
      if (link) {
        // flush buffered text first so the link text is a node in `nodes`
        flush();
        // extract children (nodes after the '[' text node)
        const startIdx = br.image ? nodes.indexOf(br.bang) : nodes.indexOf(br.node);
        const childNodes = nodes.slice(nodes.indexOf(br.node) + 1);
        // resolve emphasis inside the link text now
        const childSet = new Set(childNodes);
        const childDelims = delims.filter(d => childSet.has(d));
        for (const d of childDelims) { const gi = delims.indexOf(d); if (gi !== -1) delims.splice(gi, 1); }
        processEmphasis(childNodes, childDelims);
        let linkNode;
        if (br.image) {
          const tmp = [];
          renderInline(childNodes, tmp);
          linkNode = { t: 'image', href: link.href, title: link.title, alt: stripTags(tmp.join('')) };
        } else {
          linkNode = { t: 'link', href: link.href, title: link.title, c: childNodes };
        }
        flush();
        nodes.splice(startIdx, nodes.length - startIdx, linkNode);
        brackets.splice(bi, 1);
        for (const b of brackets) b.active = false;
        i = link.end; continue;
      }
      brackets.splice(bi, 1);
      buf += ']'; i++; continue;
    }
    if (c === 60) { // < autolink or html tag
      // autolink <scheme:...> or <email>
      let matched = false;
      const gt = str.indexOf('>', i + 1);
      if (gt !== -1 && gt - i < 200) {
        const inner = str.slice(i + 1, gt);
        if (/^[A-Za-z][A-Za-z0-9+.-]{1,31}:/.test(inner) && !inner.includes(' ') && !inner.includes('<') && !inner.includes('\n')) {
          flush(); nodes.push({ t: 'link', href: inner, title: null, c: [{ t: 'text', s: inner }] });
          i = gt + 1; matched = true;
        } else if (/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/.test(inner)) {
          flush(); nodes.push({ t: 'link', href: 'mailto:' + inner, title: null, c: [{ t: 'text', s: inner }] });
          i = gt + 1; matched = true;
        }
      }
      if (matched) continue;
      const tag = parseHtmlTag(str, i);
      if (tag) { flush(); nodes.push({ t: 'html', s: str.slice(i, tag.end) }); i = tag.end; continue; }
      buf += '<'; i++; continue;
    }
    if (c === 38) { // & entity
      const e = matchEntity(str, i);
      if (e) { flush(); nodes.push({ t: 'raw', s: e.text }); i += e.len; continue; }
      buf += '&'; i++; continue;
    }
    if (c === 10) { // newline: soft break, or hard break if 2+ trailing spaces
      let sp = 0, k = buf.length - 1;
      while (k >= 0 && buf.charCodeAt(k) === 32) { sp++; k--; }
      if (sp >= 2) {
        buf = buf.slice(0, buf.length - sp);
        flush(); nodes.push({ t: 'br' });
      } else {
        buf += '\n';
      }
      i++; continue;
    }
    if (c === 119 || c === 87) { // w/W — possible www. autolink
      if ((i === 0 || !((str.charCodeAt(i - 1) >= 65 && str.charCodeAt(i - 1) <= 90) || (str.charCodeAt(i - 1) >= 97 && str.charCodeAt(i - 1) <= 122) || (str.charCodeAt(i - 1) >= 48 && str.charCodeAt(i - 1) <= 57))) &&
        str.slice(i, i + 4).toLowerCase() === 'www.') {
        const w = parseWwwAutolink(str, i);
        if (w) {
          flush(); nodes.push({ t: 'link', href: 'http://' + w.text, title: null, c: [{ t: 'text', s: w.text }] });
          i = w.end; continue;
        }
      }
      buf += str[i]; i++; continue;
    }
    if (c === 64) { // @ — possible extended email autolink
      const em = parseEmailAutolink(str, i);
      if (em && em.start < i) {
        // local part is the tail of buf
        const localLen = i - em.start;
        if (buf.length >= localLen && buf.slice(buf.length - localLen) === str.slice(em.start, i)) {
          buf = buf.slice(0, buf.length - localLen);
          flush();
          const text = str.slice(em.start, em.end);
          nodes.push({ t: 'link', href: 'mailto:' + text, title: null, c: [{ t: 'text', s: text }] });
          i = em.end; continue;
        }
      }
      buf += '@'; i++; continue;
    }
    buf += str[i]; i++;
  }
  flush();
  processEmphasis(nodes, delims);
  return nodes;
}

export function inlineToHtml(str, refs, out) {
  renderInline(parseInline(str, refs), out);
}

// ---------- block parsing ----------
const BLOCK_TAGS = new Set(['address','article','aside','base','basefont','blockquote','body','caption','center','col','colgroup','dd','details','dialog','dir','div','dl','dt','fieldset','figcaption','figure','footer','form','frame','frameset','h1','h2','h3','h4','h5','h6','head','header','hr','html','iframe','legend','li','link','main','menu','menuitem','nav','noframes','ol','optgroup','option','p','param','search','section','summary','table','tbody','td','tfoot','th','thead','title','tr','track','ul']);
const TYPE1_TAGS = ['script','pre','style','textarea'];

function LC(s) { return { s, pos: 0, col: 0, tabRem: 0 }; }
function curCh(L) { return L.tabRem > 0 ? 32 : (L.pos < L.s.length ? L.s.charCodeAt(L.pos) : 10); }
function advCh(L) {
  if (L.tabRem > 0) { L.tabRem--; L.col++; if (L.tabRem === 0) L.pos++; return; }
  const c = L.pos < L.s.length ? L.s.charCodeAt(L.pos) : 10;
  if (c === 9) { L.col += 4 - (L.col & 3); L.pos++; }
  else { L.col++; L.pos++; }
}
function advCols(L, n) {
  // Advance by n columns (not n characters): a tab that would overshoot is
  // consumed only partially, leaving the rest as spaces via tabRem.
  let remaining = n;
  while (remaining > 0) {
    if (L.tabRem > 0) {
      const take = Math.min(L.tabRem, remaining);
      L.tabRem -= take; L.col += take; remaining -= take;
      if (L.tabRem === 0) L.pos++;
      continue;
    }
    const c = L.pos < L.s.length ? L.s.charCodeAt(L.pos) : 10;
    if (c === 9) {
      const span = 4 - (L.col & 3);
      if (span > remaining) { L.tabRem = span - remaining; L.col += remaining; remaining = 0; }
      else { L.col += span; L.pos++; remaining -= span; }
    } else { L.col++; L.pos++; remaining--; }
  }
}
function saveL(L) { return { pos: L.pos, col: L.col, tabRem: L.tabRem }; }
function restL(L, st) { L.pos = st.pos; L.col = st.col; L.tabRem = st.tabRem; }
function remStr(L) {
  if (L.tabRem > 0) {
    // The tab at L.pos is partially consumed: its remainder is tabRem spaces,
    // and the tab character itself must not appear in the output.
    return ' '.repeat(L.tabRem) + L.s.slice(L.pos + 1);
  }
  return L.s.slice(L.pos);
}
function isBlankL(L) {
  let p = L.pos;
  while (p < L.s.length) { const c = L.s.charCodeAt(p); if (c !== 32 && c !== 9) return false; p++; }
  return true;
}
function indentCols(L) {
  let col = L.col, p = L.pos, tr = L.tabRem, cols = 0;
  while (true) {
    const c = tr > 0 ? 32 : (p < L.s.length ? L.s.charCodeAt(p) : 10);
    if (c === 32) { cols++; col++; if (tr > 0) { tr--; if (tr === 0) p++; } else p++; }
    else if (c === 9) { const span = 4 - (col & 3); cols += span; col += span; p++; }
    else break;
  }
  return cols;
}

// Split a table row into cells, honouring backslash escapes and code spans.
function splitTableRow(line) {
  const cells = [];
  let cur = '', i = 0, codeRun = 0;
  const n = line.length;
  let s = 0; while (s < n && line.charCodeAt(s) === 32) s++;
  const startsPipe = s < n && line.charCodeAt(s) === 124;
  let e = n - 1; while (e >= 0 && line.charCodeAt(e) === 32) e--;
  const endsPipe = e >= 0 && line.charCodeAt(e) === 124;
  while (i < n) {
    const c = line.charCodeAt(i);
    if (c === 92 && i + 1 < n && isAsciiPunct(line.charCodeAt(i + 1))) { cur += line[i] + line[i + 1]; i += 2; continue; }
    if (c === 96) {
      let j = i; while (j < n && line.charCodeAt(j) === 96) j++;
      const run = j - i;
      if (codeRun === 0) codeRun = run;
      else if (run === codeRun) codeRun = 0;
      cur += line.slice(i, j); i = j; continue;
    }
    if (c === 124 && codeRun === 0) { cells.push(cur.trim()); cur = ''; i++; continue; }
    cur += line[i]; i++;
  }
  cells.push(cur.trim());
  if (startsPipe) cells.shift();
  if (endsPipe) cells.pop();
  return cells;
}

function tryTable(lines) {
  // the delimiter row must not be indented 4+ spaces
  let lead = 0;
  for (let k = 0; k < lines[1].length && lines[1].charCodeAt(k) === 32; k++) lead++;
  if (lead >= 4) return null;
  const header = splitTableRow(lines[0]);
  if (header.length === 0) return null;
  const delim = splitTableRow(lines[1]);
  if (delim.length !== header.length) return null;
  const align = [];
  for (const cell of delim) {
    const t = cell.trim();
    if (!/^:?-+:?$/.test(t)) return null;
    align.push(t[0] === ':' && t[t.length - 1] === ':' ? 'center' : t[t.length - 1] === ':' ? 'right' : t[0] === ':' ? 'left' : null);
  }
  const rows = [];
  for (let k = 2; k < lines.length; k++) {
    const r = splitTableRow(lines[k]);
    while (r.length < header.length) r.push('');
    rows.push(r.slice(0, header.length));
  }
  return { align, header, rows };
}

function skipWs1(text, k) {
  const n = text.length;
  while (k < n && (text.charCodeAt(k) === 32 || text.charCodeAt(k) === 9)) k++;
  if (k < n && text.charCodeAt(k) === 10) {
    k++;
    while (k < n && (text.charCodeAt(k) === 32 || text.charCodeAt(k) === 9)) k++;
  }
  return k;
}

// Parse link reference definitions from the start of text. Returns the
// remaining text after them, or null if none parsed. Mutates refs.
function parseRefdefs(text, refs) {
  const n = text.length;
  let pos = 0, any = false;
  while (pos < n) {
    // skip leading whitespace (up to 3 spaces indent, then newlines)
    let p = pos;
    while (p < n && (text.charCodeAt(p) === 32 || text.charCodeAt(p) === 9)) p++;
    if (p < n && text.charCodeAt(p) === 10) { pos = p + 1; continue; }
    if (p - pos > 3) break;
    pos = p;
    if (text.charCodeAt(pos) !== 91) break; // [
    const lab = parseLabel(text, pos);
    if (!lab) break;
    let k = lab.end;
    if (k >= n || text.charCodeAt(k) !== 58) break; // :
    k = skipWs1(text, k + 1);
    if (k >= n) break;
    let dest = null;
    if (text.charCodeAt(k) === 60) {
      let m = k + 1, ok = false;
      while (m < n) {
        const c = text.charCodeAt(m);
        if (c === 10 || c === 60) break;
        if (c === 62) { ok = true; break; }
        m++;
      }
      if (!ok) break;
      dest = unescapeStr(text.slice(k + 1, m));
      k = m + 1;
    } else {
      let m = k, d = '', depth = 0;
      while (m < n) {
        const c = text.charCodeAt(m);
        if (c === 32 || c === 10 || c === 9 || c < 32) break;
        if (c === 92 && m + 1 < n && isAsciiPunct(text.charCodeAt(m + 1))) { d += text[m + 1]; m += 2; continue; }
        if (c === 40) { depth++; d += '('; m++; continue; }
        if (c === 41) { if (depth === 0) break; depth--; d += ')'; m++; continue; }
        d += text[m]; m++;
      }
      if (m === k || depth !== 0) break;
      dest = d; k = m;
    }
    let title = null;
    const kDest = k;
    let k2 = skipWs1(text, k);
    if (k2 < n && k2 > k) {
      const tc = text.charCodeAt(k2);
      if (tc === 34 || tc === 39 || tc === 40) {
        const close = tc === 40 ? 41 : tc;
        let m = k2 + 1, t = '', ok = false;
        while (m < n) {
          const c = text.charCodeAt(m);
          if (c === 92 && m + 1 < n && isAsciiPunct(text.charCodeAt(m + 1))) { t += text[m + 1]; m += 2; continue; }
          if (c === close) { ok = true; break; }
          if (tc === 40 && c === 40) break;
          t += text[m]; m++;
        }
        if (ok) { title = t; k = m + 1; }
      }
    }
    // must end the line here (only spaces/tabs, then \n or end)
    let k3 = k;
    while (k3 < n && (text.charCodeAt(k3) === 32 || text.charCodeAt(k3) === 9)) k3++;
    if (k3 < n && text.charCodeAt(k3) !== 10) {
      // a bad title must not kill the refdef: retry without the title
      if (title !== null) {
        k3 = kDest;
        while (k3 < n && (text.charCodeAt(k3) === 32 || text.charCodeAt(k3) === 9)) k3++;
        if (k3 < n && text.charCodeAt(k3) !== 10) break;
        title = null; k = kDest;
      } else break;
    }
    if (k3 < n) k3++;
    const key = normalizeLabel(lab.label);
    if (key && !refs.has(key)) refs.set(key, { dest, title });
    pos = k3; any = true;
  }
  return any ? text.slice(pos) : null;
}

// ---------- rendering ----------
function renderBlocks(node, out, refs, inTightList) {
  switch (node.t) {
    case 'doc': for (const c of node.children) renderBlocks(c, out, refs, false); break;
    case 'para': {
      let content = node.content;
      // task list checkbox on the first paragraph of an item
      out.push('<p>');
      inlineToHtml(content, refs, out);
      out.push('</p>\n');
      break;
    }
    case 'heading': {
      out.push('<h' + node.level + '>');
      inlineToHtml(node.content, refs, out);
      out.push('</h' + node.level + '>\n');
      break;
    }
    case 'code': {
      out.push('<pre><code');
      if (node.info) { out.push(' class="language-'); escAttr(node.info, out); out.push('"'); }
      out.push('>');
      escText(node.content, out);
      out.push('</code></pre>\n');
      break;
    }
    case 'html': out.push(node.content); break;
    case 'hr': out.push('<hr>\n'); break;
    case 'quote': {
      out.push('<blockquote>\n');
      for (const c of node.children) renderBlocks(c, out, refs, false);
      out.push('</blockquote>\n');
      break;
    }
    case 'list': {
      out.push(node.ordered ? '<ol' : '<ul');
      if (node.ordered && node.start !== 1) out.push(' start="' + node.start + '"');
      out.push('>\n');
      for (const item of node.children) renderBlocks(item, out, refs, node.tight);
      out.push(node.ordered ? '</ol>\n' : '</ul>\n');
      break;
    }
    case 'item': {
      out.push('<li>');
      const kids = node.children;
      for (let k = 0; k < kids.length; k++) {
        const ch = kids[k];
        if (ch.t === 'para') {
          if (inTightList) {
            // tight: paragraph renders as bare inline content
            if (k === 0 && node.task !== undefined) out.push(node.task);
            inlineToHtml(ch.content, refs, out);
            // in a tight item, paragraphs are separated by \n only when the
            // next sibling is also a paragraph (not a nested list/block)
            if (k < kids.length - 1 && kids[k + 1].t === 'para') out.push('\n');
          } else {
            if (k === 0 && node.task !== undefined) {
              out.push('<p>');
              out.push(node.task);
              inlineToHtml(ch.content, refs, out);
              out.push('</p>\n');
            } else {
              out.push('<p>');
              inlineToHtml(ch.content, refs, out);
              out.push('</p>\n');
            }
          }
        } else {
          renderBlocks(ch, out, refs, false);
        }
      }
      out.push('</li>\n');
      break;
    }
    case 'table': {
      out.push('<table>\n<thead>\n<tr>\n');
      for (let k = 0; k < node.header.length; k++) {
        out.push('<th');
        const a = node.align[k];
        if (a) out.push(' align="' + a + '"');
        out.push('>');
        inlineToHtml(node.header[k], refs, out);
        out.push('</th>\n');
      }
      out.push('</tr>\n</thead>\n');
      if (node.rows.length) {
        out.push('<tbody>');
        for (let r = 0; r < node.rows.length; r++) {
          out.push(r === 0 ? '<tr>\n' : '<tr>\n');
          for (let k = 0; k < node.rows[r].length; k++) {
            out.push('<td');
            const a = node.align[k];
            if (a) out.push(' align="' + a + '"');
            out.push('>');
            inlineToHtml(node.rows[r][k], refs, out);
            out.push('</td>\n');
          }
          out.push('</tr>\n');
        }
        out.push('</tbody>');
      }
      out.push('</table>\n');
      break;
    }
  }
}

// The task checkbox is attached to the item at parse time (node.task) and the
// first paragraph's leading "[ ] "/"[x] " is stripped at render time above.

// ---------- main block parser ----------
function parseBlocks(src, refs) {
  src = src.replace(/\r\n?/g, '\n');
  let lines = src.split('\n');
  let trailingNL = false;
  if (lines.length && lines[lines.length - 1] === '') { lines.pop(); trailingNL = true; }
  const doc = { t: 'doc', children: [] };
  const stack = [doc];
  const tip = () => stack[stack.length - 1];
  const addChild = (node) => { const p = tip(); p.children.push(node); node._parent = p; node._lastLineBlank = false; return node; };
  const openBlock = (node) => { addChild(node); stack.push(node); return node; };

  function finalize(node) {
    if (node.t === 'html') {
      node.content = node.lines.join('\n');
      if (node.htmlType >= 1 && node.htmlType <= 5) {
        // ends at a line containing the end tag: that line's newline is kept
        // unless the block is followed by a blank line
        if (!node._noTrailNL && !(node._eof && !trailingNL)) node.content += '\n';
      } else {
        // ends at a blank line (or EOF): no trailing newline except at EOF
        if (node._eof && trailingNL) node.content += '\n';
      }
      delete node.lines; delete node._eof; delete node._complete; delete node._noTrailNL;
      return;
    }
    if (node.t === 'para') {
      let content = node.lines.join('\n');
      const rest = parseRefdefs(content, refs);
      if (rest !== null) content = rest;
      if (content === '') {
        const p = node._parent;
        if (p) { const idx = p.children.indexOf(node); if (idx >= 0) p.children.splice(idx, 1); }
        node.t = 'dead';
        return;
      }
      const ls = content.split('\n');
      if (ls.length >= 2) {
        const tbl = tryTable(ls);
        if (tbl) { node.t = 'table'; node.align = tbl.align; node.header = tbl.header; node.rows = tbl.rows; delete node.lines; return; }
      }
      node.content = content;
      delete node.lines;
      const par = node._parent;
      if (par && par.t === 'item' && par.children[0] === node && par.task === undefined) {
        if (content.startsWith('[ ] ')) { par.task = '<input disabled="" type="checkbox">'; node.content = content.slice(4); }
        else if (content.startsWith('[x] ') || content.startsWith('[X] ')) { par.task = '<input checked="" disabled="" type="checkbox">'; node.content = content.slice(4); }
      }
    } else if (node.t === 'list') {
      let loose = false;
      const items = node.children;
      for (let k = 0; k < items.length; k++) {
        const it = items[k];
        if (it._lastLineBlank && k < items.length - 1) loose = true;
        for (let m = 0; m < it.children.length; m++) {
          const ch = it.children[m];
          if (ch._lastLineBlank && m < it.children.length - 1) loose = true;
        }
      }
      node.tight = !loose;
    } else if (node.t === 'code' && !node.fenced) {
      let c = node.content;
      while (c.length >= 2 && c.endsWith('\n\n')) c = c.slice(0, -1);
      node.content = c;
    }
  }

  function advIndent(L, n) {
    let cols = 0;
    while (cols < n) {
      const c = curCh(L);
      if (c === 32) { advCh(L); cols++; }
      else if (c === 9) { const span = 4 - (L.col & 3); if (cols + span > n) break; advCh(L); cols += span; }
      else break;
    }
  }

  function matchQuote(line) {
    const ind = indentCols(line);
    if (ind > 3) return false;
    const st = saveL(line);
    advCols(line, ind);
    if (curCh(line) !== 62) { restL(line, st); return false; }
    advCh(line);
    if (curCh(line) === 32 || curCh(line) === 9) advCols(line, 1);
    return true;
  }
  function matchItem(line, blk) {
    if (isBlankL(line)) {
      // an empty item (no children yet) is closed by a blank line
      if (blk.children.length === 0) return false;
      return true; // blank line: item continues
    }
    const ind = indentCols(line);
    if (ind < blk.contentIndent) return false;
    advCols(line, blk.contentIndent);
    return true;
  }
  // leaf match: 0 = no match, 1 = match (content line), 2 = closing fence (line consumed), 3 = html end line (line is content, then close)
  function matchLeaf(line, blk, blank) {
    if (blk.t === 'para') return curCh(line) === 10 ? 0 : 1;
    if (blk.t === 'code') {
      if (blk.fenced) {
        const st = saveL(line);
        const ind = indentCols(line);
        if (ind <= 3) {
          advCols(line, ind);
          const c = curCh(line);
          if (c === blk.fenceChar) {
            let j = 0; while (curCh(line) === blk.fenceChar) { advCh(line); j++; }
            if (j >= blk.fenceLen) {
              let ok = true;
              while (curCh(line) === 32 || curCh(line) === 9) advCh(line);
              if (curCh(line) !== 10) ok = false;
              if (ok) return 2;
            }
          }
        }
        restL(line, st);
        return 1;
      }
      if (blank) return 1;
      return indentCols(line) >= 4 ? 1 : 0;
    }
    if (blk.t === 'html') {
      if (blk._complete) return 0;
      const r = remStr(line);
      if (blk.htmlType === 1) { if (r.toLowerCase().indexOf('</' + blk.htmlTag) >= 0) { blk._complete = true; return 1; } return 1; }
      if (blk.htmlType === 2) { if (r.indexOf('-->') >= 0) { blk._complete = true; return 1; } return 1; }
      if (blk.htmlType === 3) { if (r.indexOf('?>') >= 0) { blk._complete = true; return 1; } return 1; }
      if (blk.htmlType === 4) { if (r.indexOf('>') >= 0) { blk._complete = true; return 1; } return 1; }
      if (blk.htmlType === 5) { if (r.indexOf(']]>') >= 0) { blk._complete = true; return 1; } return 1; }
      return blank ? 0 : 1;
    }
    return 0;
  }

  function htmlStart(r) {
    const m1 = r.match(/^<(script|pre|style|textarea)([\s>]|\/>|$)/i);
    if (m1) return { type: 1, tag: m1[1].toLowerCase() };
    if (r.startsWith('<!--')) return { type: 2 };
    if (r.startsWith('<?')) return { type: 3 };
    if (r.length >= 3 && r[0] === '<' && r[1] === '!' && /[A-Za-z]/.test(r[2])) return { type: 4 };
    if (r.startsWith('<![CDATA[')) return { type: 5 };
    const m6 = r.match(/^<\/?([A-Za-z][A-Za-z0-9-]*)([\s>]|\/>|$)/);
    if (m6 && BLOCK_TAGS.has(m6[1].toLowerCase())) return { type: 6 };
    return null;
  }
  function htmlStart7(r) {
    // condition 7: complete open/close tag, followed only by whitespace/EOL
    const tag = parseHtmlTag(r);
    if (!tag) return null;
    if (BLOCK_TAGS.has(tag.name)) return null;
    if (tag.name === 'script' || tag.name === 'pre' || tag.name === 'style' || tag.name === 'textarea') return null;
    const rest = r.slice(tag.end);
    if (/^[ \t]*$/.test(rest)) return { type: 7 };
    return null;
  }
  function parseHtmlTag(r) {
    if (r.length < 2) return null;
    let i = 1, isClose = false;
    if (r[i] === '/') { isClose = true; i++; }
    let name = '';
    while (i < r.length && /[A-Za-z0-9-]/.test(r[i])) { name += r[i]; i++; }
    if (!name) return null;
    if (isClose) {
      let j = i;
      while (j < r.length && (r[j] === ' ' || r[j] === '\t')) j++;
      if (j < r.length && r[j] === '>') return { name: name.toLowerCase(), isClose: true, end: j + 1 };
      return null;
    }
    // after the tag name, only whitespace, '/' or '>' may follow
    if (i < r.length && r[i] !== ' ' && r[i] !== '\t' && r[i] !== '/' && r[i] !== '>') return null;
    let j = i;
    while (j < r.length) {
      const c = r[j];
      if (c === '>') return { name: name.toLowerCase(), isClose: false, end: j + 1 };
      if (c === '"' || c === "'") {
        const q = c; j++;
        while (j < r.length && r[j] !== q) j++;
        if (j >= r.length) return null;
        j++; continue;
      }
      j++;
    }
    return null;
  }
  function htmlEndMet(node, r) {
    if (node.htmlType === 1) return r.toLowerCase().indexOf('</' + node.htmlTag) >= 0;
    if (node.htmlType === 2) return r.indexOf('-->') >= 0;
    if (node.htmlType === 3) return r.indexOf('?>') >= 0;
    if (node.htmlType === 4) return r.indexOf('>') >= 0;
    if (node.htmlType === 5) return r.indexOf(']]>') >= 0;
    return false;
  }
  function isThematicBreak(line) {
    const r = remStr(line);
    let s = '';
    for (let k = 0; k < r.length; k++) { const c = r.charCodeAt(k); if (c !== 32 && c !== 9) s += r[k]; }
    if (s.length < 3) return false;
    const c = s[0];
    if (c !== '-' && c !== '_' && c !== '*') return false;
    for (let k = 1; k < s.length; k++) if (s[k] !== c) return false;
    return true;
  }
  function tryListItem(line) {
    const st = saveL(line);
    const ind = indentCols(line);
    if (ind >= 4) return null;
    advCols(line, ind);
    const c = curCh(line);
    let type = null, start = 0, delim = '', markerLen = 0, bullet = '';
    if (c === 45 || c === 43 || c === 42) { type = 'bullet'; markerLen = 1; bullet = String.fromCharCode(c); }
    else if (c >= 48 && c <= 57) {
      let j = 0, num = 0;
      while (j < 9) {
        const d = curCh(line);
        if (d < 48 || d > 57) break;
        num = num * 10 + (d - 48); advCh(line); j++;
      }
      const d = curCh(line);
      if (j === 0 || (d !== 46 && d !== 41)) { restL(line, st); return null; }
      type = 'ordered'; start = num; delim = d === 46 ? '.' : ')'; markerLen = j + 1;
    } else { restL(line, st); return null; }
    restL(line, st);
    advCols(line, ind);
    for (let k = 0; k < markerLen; k++) advCh(line);
    const col0 = line.col;
    let spaces = 0;
    while (true) {
      const ch = curCh(line);
      if (ch !== 32 && ch !== 9) break;
      advCh(line);
      spaces = line.col - col0;
      if (spaces >= 5) break;
    }
    if (curCh(line) === 10) return { type, start, delim, bullet, contentIndent: ind + markerLen + 1, empty: true };
    if (spaces === 0) { restL(line, st); return null; }
    if (spaces >= 5) {
      restL(line, st);
      advCols(line, ind);
      for (let k = 0; k < markerLen; k++) advCh(line);
      advCols(line, 1);
      return { type, start, delim, bullet, contentIndent: ind + markerLen + 1, empty: false };
    }
    return { type, start, delim, bullet, contentIndent: ind + markerLen + spaces, empty: false };
  }

  function addCodeLine(node, line) {
    if (node.fenced) {
      advIndent(line, node.fenceIndent);
      node.content += remStr(line) + '\n';
    } else {
      advCols(line, 4);
      node.content += remStr(line) + '\n';
    }
  }
  function addHtmlLine(node, line, isLast) {
    node.lines.push(remStr(line));
    if (isLast) node._eof = true;
  }
  function addParaLine(node, line) {
    // Paragraph content keeps the line's leading spaces (up to 3); the
    // container indent was already consumed by phase-1 matching.
    node.lines.push(remStr(line));
  }

  // Try to open a new block at the current line position. Returns the node
  // opened (leaf: already filled with this line; container: pushed), or null
  // if nothing opens. `interruptPara` = only blocks that can interrupt a
  // paragraph (no indented code, no html type 7, no new paragraph).
  function tryOpenBlock(line, blank, isLast, interruptPara) {
    if (blank) return null;
    // A list only contains list items. Close it before creating any other
    // kind of block (the list-item branch below handles list items itself).
    const closeListIfNeeded = () => { if (tip().t === 'list') finalize(stack.pop()); };
    const ind = indentCols(line);
    // blockquote
    if (ind <= 3) {
      const st = saveL(line);
      advCols(line, ind);
      if (curCh(line) === 62) {
        advCh(line);
        if (curCh(line) === 32 || curCh(line) === 9) advCols(line, 1);
        closeListIfNeeded();
        return openBlock({ t: 'quote', children: [] });
      }
      restL(line, st);
    }
    // ATX heading
    if (ind <= 3) {
      const st = saveL(line);
      advCols(line, ind);
      let h = 0; while (curCh(line) === 35) { advCh(line); h++; }
      if (h >= 1 && h <= 6) {
        const c = curCh(line);
        if (c === 10 || c === 32 || c === 9) {
          let content = remStr(line);
          content = content.replace(/[ \t]+$/, '');
          const m = content.match(/[ \t]+#+$/);
          if (m) content = content.slice(0, content.length - m[0].length);
          content = content.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
          const node = { t: 'heading', level: h, content };
          closeListIfNeeded();
          addChild(node); finalize(node);
          return node;
        }
      }
      restL(line, st);
    }
    // fenced code
    if (ind <= 3) {
      const st = saveL(line);
      advCols(line, ind);
      const c = curCh(line);
      if (c === 96 || c === 126) {
        let j = 0; while (curCh(line) === c) { advCh(line); j++; }
        if (j >= 3) {
          let info = remStr(line);
          if (c === 96 && info.indexOf('`') >= 0) { restL(line, st); }
          else {
            info = info.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
            const sp = info.search(/[ \t]/);
            if (sp >= 0) info = info.slice(0, sp);
            info = unescapeStr(info);
            const node = { t: 'code', fenced: true, fenceChar: c, fenceLen: j, fenceIndent: ind, info, content: '' };
            closeListIfNeeded();
            openBlock(node);
            return node;
          }
        } else restL(line, st);
      } else restL(line, st);
    }
    // html block (types 1-6 always; type 7 only when not interrupting a para)
    if (ind <= 3) {
      const st = saveL(line);
      advCols(line, ind);
      const r = remStr(line);
      let hs = htmlStart(r);
      if (!hs && !interruptPara) hs = htmlStart7(r);
      if (hs) {
        const node = { t: 'html', htmlType: hs.type, htmlTag: hs.tag, lines: [] };
        closeListIfNeeded();
        addChild(node);
        // HTML block content keeps the line's leading spaces.
        restL(line, st);
        addHtmlLine(node, line, isLast);
        if (hs.type >= 1 && hs.type <= 5 && htmlEndMet(node, r)) node._complete = true;
        stack.push(node);
        return node;
      }
      restL(line, st);
    }
    // thematic break
    if (ind <= 3) {
      const st = saveL(line);
      advCols(line, ind);
      if (isThematicBreak(line)) {
        const node = { t: 'hr' };
        closeListIfNeeded();
        addChild(node); finalize(node);
        return node;
      }
      restL(line, st);
    }
    // list item
    {
      const info = tryListItem(line);
      if (info) {
        let lst = tip();
        if (lst.t === 'list') {
          const same = lst.ordered === (info.type === 'ordered')
            && (!lst.ordered ? lst.bullet === info.bullet : lst.delim === info.delim);
          if (same) {
            // same list
          } else {
            finalize(stack.pop());
            lst = openBlock({ t: 'list', ordered: info.type === 'ordered', start: info.start, delim: info.delim, bullet: info.bullet, children: [] });
          }
        } else {
          lst = openBlock({ t: 'list', ordered: info.type === 'ordered', start: info.start, delim: info.delim, bullet: info.bullet, children: [] });
        }
        const item = openBlock({ t: 'item', contentIndent: info.contentIndent, children: [] });
        return item;
      }
    }
    // indented code (not when interrupting a paragraph)
    if (!interruptPara && ind >= 4) {
      const node = { t: 'code', fenced: false, content: '' };
      closeListIfNeeded();
      openBlock(node);
      addCodeLine(node, line);
      return node;
    }
    // paragraph (not when interrupting a paragraph)
    if (!interruptPara) {
      const node = { t: 'para', lines: [] };
      closeListIfNeeded();
      openBlock(node);
      addParaLine(node, line);
      return node;
    }
    return null;
  }

  // Setext heading check for a paragraph tip. Returns true if converted.
  function trySetext(t, line) {
    const ind = indentCols(line);
    if (ind > 3) return false;
    const st = saveL(line);
    advCols(line, ind);
    const c = curCh(line);
    if (c !== 61 && c !== 45) { restL(line, st); return false; }
    // a run of = or -, then only spaces/tabs to end of line
    let j = 0;
    while (curCh(line) === c) { advCh(line); j++; }
    while (curCh(line) === 32 || curCh(line) === 9) advCh(line);
    if (curCh(line) !== 10 || j === 0) { restL(line, st); return false; }
    // strip any link reference definitions first; if nothing is left the
    // paragraph is gone and this line is not a setext underline
    let content = t.lines.join('\n');
    const rest = parseRefdefs(content, refs);
    if (rest !== null) content = rest;
    content = content.replace(/^[ \t]+/, '').replace(/[ \t]+$/g, '').replace(/[ \t]+\n/g, '\n');
    if (content.replace(/^[ \t\n]+/, '') === '') {
      // nothing left but refdefs: this line is not a setext underline,
      // it is a plain paragraph line; leave the paragraph in place
      restL(line, st); return false;
    }
    t.t = 'heading'; t.level = c === 61 ? 1 : 2; t.content = content;
    delete t.lines;
    stack.pop();
    finalize(t);
    return true;
  }

  // Peek: does this line start a block that can interrupt a paragraph?
  // Only inspects the line cursor (save/restore); never touches the tree.
  function wouldInterrupt(line, inList) {
    if (isBlankL(line)) return false;
    const ind = indentCols(line);
    if (ind > 3) return false;
    const st = saveL(line);
    advCols(line, ind);
    { // ATX
      const s2 = saveL(line);
      let h = 0; while (curCh(line) === 35) { advCh(line); h++; }
      if (h >= 1 && h <= 6) {
        const c = curCh(line);
        if (c === 10 || c === 32 || c === 9) { restL(line, st); return true; }
      }
      restL(line, s2);
    }
    { // fence
      const s2 = saveL(line);
      const c = curCh(line);
      if (c === 96 || c === 126) {
        let j = 0; while (curCh(line) === c) { advCh(line); j++; }
        if (j >= 3 && (c === 126 || remStr(line).indexOf('`') < 0)) { restL(line, st); return true; }
      }
      restL(line, s2);
    }
    if (htmlStart(remStr(line))) { restL(line, st); return true; }
    if (isThematicBreak(line)) { restL(line, st); return true; }
    if (curCh(line) === 62) { restL(line, st); return true; } // blockquote
    restL(line, st);
    const li = tryListItem(line);
    restL(line, st);
    if (!li) return false;
    // an empty item cannot interrupt a paragraph unless it is a sibling
    // in an already-open list; an ordered list must start with 1 to
    // interrupt a paragraph that is not itself inside a list
    if (li.empty && !inList) return false;
    if (li.type === 'ordered' && li.start !== 1 && !inList) return false;
    return true;
  }

  // is the tip paragraph inside a list item (any ancestor is an item)?
  function tipInList() {
    let n = tip();
    while (n) { if (n.t === 'item') return true; n = n._parent; }
    return false;
  }

  // ---------- main line loop ----------
  for (let li = 0; li < lines.length; li++) {
    const isLast = li === lines.length - 1;
    const line = LC(lines[li]);
    const blank = isBlankL(line);
    if (blank) { for (let k = 1; k < stack.length; k++) stack[k]._lastLineBlank = true; }
    // Phase 1: match open containers
    let lastMatched = 0;
    let consumed = false;
    let lazy = false;
    let blankHit = false; // a container matched this blank line (no marker)
    let markerConsumed = false; // a container marker was consumed this line
    let i = 1;
    while (i < stack.length) {
      const blk = stack[i];
      if (blk.t === 'quote') {
        if (isBlankL(line)) blankHit = true;
        if (!matchQuote(line)) {
          // Lazy continuation only if the line does NOT start a new block
          // that can interrupt the paragraph.
          if (tip().t === 'para' && !blank && !wouldInterrupt(line, tipInList())) { lazy = true; lastMatched = stack.length - 1; }
          break;
        }
        markerConsumed = true;
        lastMatched = i; i++; continue;
      }
      if (blk.t === 'list') { lastMatched = i; i++; continue; }
      if (blk.t === 'item') {
        if (isBlankL(line)) blankHit = true;
        if (!matchItem(line, blk)) {
          if (tip().t === 'para' && !blank && !wouldInterrupt(line, tipInList())) { lazy = true; lastMatched = stack.length - 1; }
          break;
        }
        markerConsumed = true;
        lastMatched = i; i++; continue;
      }
      // A spaces-only remainder is paragraph content when a container
      // marker was consumed (the spaces follow the marker); otherwise
      // the line is blank and closes the paragraph.
      if (blk.t === 'para' && isBlankL(line) && !markerConsumed) { break; }
      const res = matchLeaf(line, blk, blank);
      if (res === 1) { lastMatched = i; }
      else if (res === 2) { consumed = true; lastMatched = i - 1; }
      else if (res === 3) { addHtmlLine(blk, line, isLast); consumed = true; lastMatched = i - 1; }
      break;
    }
    // close unmatched blocks
    while (stack.length - 1 > lastMatched) {
      const b = stack.pop();
      if (b.t === 'html' && blank) b._noTrailNL = true;
      if (isBlankL(line)) b._lastLineBlank = true;
      finalize(b);
    }
    if (consumed) continue;
    // Phase 2
    const t = tip();
    if (t.t === 'code') { addCodeLine(t, line); continue; }
    if (t.t === 'html') { addHtmlLine(t, line, isLast); continue; }
    if (t.t === 'para') {
      if (lazy) {
        // A lazy continuation line that looks like a setext underline is
        // paragraph text, not an underline: neutralize it with 4 spaces.
        const st = saveL(line);
        const raw = remStr(line);
        const ind = indentCols(line);
        if (ind <= 3) {
          advCols(line, ind);
          const c = curCh(line);
          if (c === 61 || c === 45) {
            let j = 0;
            while (curCh(line) === c) { advCh(line); j++; }
            while (curCh(line) === 32 || curCh(line) === 9) advCh(line);
            if (curCh(line) === 10 && j > 0) { t.lines.push('    ' + raw); restL(line, st); continue; }
          }
        }
        restL(line, st);
      }
      if (trySetext(t, line)) continue;
      if (wouldInterrupt(line, tipInList())) {
        // close the paragraph first; the new block opens under its parent
        stack.pop();
        finalize(t);
        let guard = 0;
        while (guard++ < 60) {
          const tt = tip();
          if (tt.t === 'para' || tt.t === 'code' || tt.t === 'html' || tt.t === 'heading' || tt.t === 'hr') break;
          const opened = tryOpenBlock(line, blank, isLast, false);
          if (!opened) break;
          if (opened.t === 'quote' || opened.t === 'list' || opened.t === 'item') continue;
          break;
        }
        continue;
      }
      // lazy continuation: leading whitespace is stripped
      if (lazy) { while (curCh(line) === 32 || curCh(line) === 9) advCh(line); }
      addParaLine(t, line);
      continue;
    }
    // container or doc: open new blocks (loop for nested containers)
    let guard = 0;
    while (guard++ < 60) {
      const tt = tip();
      if (tt.t === 'para' || tt.t === 'code' || tt.t === 'html' || tt.t === 'heading' || tt.t === 'hr') break;
      if (isBlankL(line)) break; // blank remainder: no new block
      const opened = tryOpenBlock(line, blank, isLast, false);
      if (!opened) break;
      if (opened.t === 'quote' || opened.t === 'list' || opened.t === 'item') continue;
      break;
    }
  }
  while (stack.length > 1) finalize(stack.pop());
  return doc;
}

function parse(src) {
  const refs = new Map();
  const doc = parseBlocks(src, refs);
  const out = [];
  renderBlocks(doc, out, refs, false);
  return out.join('');
}

export { parse };
