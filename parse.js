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
    if (c === 32 || c === 34 || c === 60 || c === 62 || c === 92 || c === 96 || c < 32 || c >= 0x80) { need = true; break; }
  }
  if (!need) return url;
  let out = '';
  for (let i = 0; i < url.length; i++) {
    const c = url.charCodeAt(i);
    if (c === 32 || c === 34 || c === 60 || c === 62 || c === 92 || c === 96 || c < 32 || c >= 0x80) {
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
  // labels match on raw text (backslashes NOT unescaped), with whitespace
  // collapsed and Unicode case folded (ß/ẞ fold to ss)
  return s.replace(/\s+/g, ' ').trim().toLowerCase().replace(/ß/g, 'ss');
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
// Label: no nested brackets (marked rejects them), backslash escapes, max 999 chars.
function parseLabel(str, j) {
  const n = str.length;
  let k = j + 1;
  while (k < n) {
    const c = str.charCodeAt(k);
    if (c === 92 && k + 1 < n && isAsciiPunct(str.charCodeAt(k + 1))) { k += 2; continue; }
    if (c === 91) return null; // nested '[' not allowed in a label
    if (c === 93) return { label: str.slice(j + 1, k), end: k + 1 };
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
  if (str.charCodeAt(k) === 60) { // <...>: backslash escapes apply; \> does not close
    let m = k + 1;
    let ok = false;
    let dest = '';
    while (m < n) {
      const c = str.charCodeAt(m);
      if (c === 10 || c === 60) break;
      if (c === 92 && m + 1 < n && isAsciiPunct(str.charCodeAt(m + 1))) { dest += str[m + 1]; m += 2; continue; }
      if (c === 62) { ok = true; break; }
      dest += str[m]; m++;
    }
    if (!ok) return null;
    href = dest;
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
  // inline link: '(' must follow ']' immediately (no space); if the
  // destination/title is invalid, fall through to the shortcut reference
  if (k < n && str.charCodeAt(k) === 40) { // (...
    const inl = parseLinkDestTitle(str, k + 1);
    if (inl) return inl;
  } else if (k < n && str.charCodeAt(k) === 91) { // [label]
    const lab = parseLabel(str, k);
    if (lab) {
      const key = lab.label === '' ? normalizeLabel(str.slice(bracket.strIdx + 1, bracket.closeIdx)) : normalizeLabel(lab.label);
      const ref = refs.get(key);
      if (ref) return { href: ref.dest, title: ref.title, end: lab.end };
    }
    // a '[label]' follows but does not resolve: no shortcut fallback
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
  let ci = 0;
  while (ci < delims.length) {
    const closer = delims[ci];
    if (!closer.canClose || closer.len === 0) { ci++; continue; }
    let oi = -1;
    for (let j = ci - 1; j >= 0; j--) {
      const opener = delims[j];
      if (opener.ch !== closer.ch || !opener.canOpen || opener.len === 0) continue;
      // a delimiter absorbed inside an already-formed emphasis node is
      // no longer a direct child here and cannot open across its boundary
      if (nodes.indexOf(opener) === -1) continue;
      if ((opener.canClose || closer.canOpen) && ((opener.len + closer.len) % 3 === 0) && (opener.len % 3 !== 0 || closer.len % 3 !== 0)) continue;
      oi = j; break;
    }
    if (oi === -1) { ci++; continue; }
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

// Classify an inline HTML tag string: 'a-open' for <a ...> (not
// self-closing), 'a-close' for </a>, else null.
function aTagKind(tagStr) {
  let j = 1, closing = false;
  if (tagStr.charCodeAt(1) === 47) { closing = true; j = 2; }
  let k = j;
  while (k < tagStr.length) {
    const c = tagStr.charCodeAt(k);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45) k++;
    else break;
  }
  if (k === j) return null;
  if (tagStr.slice(j, k).toLowerCase() !== 'a') return null;
  if (closing) return 'a-close';
  if (tagStr.length >= 2 && tagStr.charCodeAt(tagStr.length - 2) === 47 && tagStr.charCodeAt(tagStr.length - 1) === 62) return null; // <a ... />
  return 'a-open';
}

// Replace GFM extended-autolink nodes (email/www/scheme) inside a link's
// text with their plain text: extended autolinks never form inside a link
// (angle autolinks <...> do form, so they are left alone).
function stripGfmAutolinks(nodes) {
  for (let k = 0; k < nodes.length; k++) {
    const nd = nodes[k];
    if (nd.t === 'link' && nd.gfm) {
      nodes[k] = { t: 'text', s: nd.c.length === 1 && nd.c[0].t === 'text' ? nd.c[0].s : '' };
    } else if (nd.t === 'em' || nd.t === 'strong' || nd.t === 'del') {
      stripGfmAutolinks(nd.c);
    }
  }
}

// Plain-text content of inline nodes (for image alt text): an image
// contributes its own alt, a link/emphasis contributes its children, and
// raw HTML tags contribute their literal text (marked keeps e.g. <b> in
// alt as "&lt;b&gt;"); an unmatched delimiter contributes its chars.
function plainText(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (nd.t === 'text' || nd.t === 'code' || nd.t === 'raw' || nd.t === 'html') out += nd.s;
    else if (nd.t === 'delim') out += nd.ch.repeat(nd.len);
    else if (nd.t === 'image') out += nd.alt;
    else if (nd.t === 'link' || nd.t === 'em' || nd.t === 'strong' || nd.t === 'del') out += plainText(nd.c);
    else if (nd.t === 'br') out += '\n';
  }
  return out;
}

// ---------- inline HTML tags ----------
function parseHtmlTag(str, i) {
  const n = str.length;
  if (str.charCodeAt(i) !== 60) return null; // <
  if (i + 1 >= n) return null;
  const c1 = str.charCodeAt(i + 1);
  // comment <!-- ... -->; <!--> and <!---> are complete empty comments
  if (c1 === 33 && str.startsWith('!--', i + 1)) {
    if (str.charCodeAt(i + 4) === 62) return { end: i + 5 }; // <!-->
    if (str.charCodeAt(i + 4) === 45 && str.charCodeAt(i + 5) === 62) return { end: i + 6 }; // <!--
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
    // an attribute must be preceded by whitespace; '>' or '/>' may follow directly
    const beforeWs = j;
    while (j < n && isSpace(str.charCodeAt(j))) j++;
    if (j >= n) return null;
    const c = str.charCodeAt(j);
    if (c === 62) return { end: j + 1 }; // >
    if (c === 47) { // /
      if (j + 1 < n && str.charCodeAt(j + 1) === 62) return { end: j + 2 };
      return null;
    }
    if (j === beforeWs) return null; // no whitespace before attribute: not a tag
    // attribute name
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 58)) return null;
    j++;
    while (j < n) {
      const d = str.charCodeAt(j);
      if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57) || d === 95 || d === 58 || d === 46 || d === 45) j++;
      else break;
    }
    const afterName = j;
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
    } else {
      // boolean attribute (no '='): rewind past the skipped whitespace so
      // the next attribute still sees whitespace before it
      j = afterName;
    }
  }
}

// ---------- extended autolinks (GFM) ----------
// Parse a URL host (domain labels + TLD) starting at str[j], plus an
// optional path. Returns the end index, or -1 if the host is invalid.
// `prefix` are the labels already known before j (e.g. ['www']).
function parseHostPath(str, j, prefix) {
  const n = str.length;
  let k = j;
  while (k < n) {
    const c = str.charCodeAt(k);
    if (isDomainChar(c) || c === 46) { k++; continue; }
    break;
  }
  while (k > j && str.charCodeAt(k - 1) === 46) k--;
  const dom = str.slice(j, k);
  if (!dom) return -1;
  const parts = dom.split('.');
  const allParts = [...prefix, ...parts];
  for (let p = 0; p < allParts.length; p++) {
    const lab = allParts[p];
    if (!lab) return -1;
    if (lab[0] === '-' || lab[lab.length - 1] === '-') return -1;
    for (let q = 0; q < lab.length; q++) if (!isDomainChar(lab.charCodeAt(q))) return -1;
  }
  const tld = allParts[allParts.length - 1];
  if (tld.length < 2) return -1;
  for (let q = 0; q < tld.length; q++) {
    const c = tld.charCodeAt(q);
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122))) return -1;
  }
  const domainEnd = k;
  let end = domainEnd;
  // optional path / query / fragment (a query or fragment may follow the
  // host directly, without a '/': https://host?q=1#f)
  if (end < n && (str.charCodeAt(end) === 47 || str.charCodeAt(end) === 63 || str.charCodeAt(end) === 35)) {
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
      else if (c === 41) depth--;
      p++;
    }
    end = p;
    while (end > domainEnd) {
      const c = str.charCodeAt(end - 1);
      if (c === 46 || c === 44 || c === 59 || c === 58 || c === 33 || c === 63 || c === 42 || c === 95 || c === 126 || c === 39 || c === 34) end--;
      else break;
    }
    let d2 = 0;
    for (let q = domainEnd; q < end; q++) {
      if (str.charCodeAt(q) === 40) d2++;
      else if (str.charCodeAt(q) === 41) d2--;
    }
    while (d2 < 0 && end > domainEnd && str.charCodeAt(end - 1) === 41) { end--; d2++; }
  }
  return end;
}

// Parse a www. autolink starting at str[i] ('w'). Returns {end, text} or null.
function parseWwwAutolink(str, i) {
  const end = parseHostPath(str, i + 4, ['www']);
  if (end === -1 || end === i + 4) return null;
  return { end, text: str.slice(i, end) };
}

// Parse a scheme autolink (http://, https://, ftp://, ...) starting at
// str[i] (a letter). Returns {end, text} or null.
function parseSchemeAutolink(str, i) {
  const n = str.length;
  let j = i;
  if (j >= n) return null;
  const c0 = str.charCodeAt(j);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return null;
  j++;
  let len = 1;
  while (j < n && len < 32) {
    const c = str.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) { j++; len++; continue; }
    break;
  }
  if (len < 2) return null;
  if (j >= n || str.charCodeAt(j) !== 58) return null; // need ':'
  // scheme://host/path
  if (j + 2 < n && str.charCodeAt(j + 1) === 47 && str.charCodeAt(j + 2) === 47) {
    const hostStart = j + 3;
    const end = parseHostPath(str, hostStart, []);
    if (end === -1 || end <= hostStart) return null;
    return { end, text: str.slice(i, end) };
  }
  // scheme:opaque (mailto:, xmpp:, ...) — scan a URL run, then validate
  // that it carries a dotted domain; strip trailing punctuation
  let k = j + 1;
  const urlStart = k;
  while (k < n) {
    const c = str.charCodeAt(k);
    if (c === 32 || c === 10 || c === 9 || c === 60 || c === 62 || c === 34 || c === 96) break;
    if (c === 38) { // &entity; terminates
      let m = k + 1;
      while (m < n && ((str.charCodeAt(m) >= 65 && str.charCodeAt(m) <= 90) || (str.charCodeAt(m) >= 97 && str.charCodeAt(m) <= 122) || (str.charCodeAt(m) >= 48 && str.charCodeAt(m) <= 57))) m++;
      if (m > k + 1 && m < n && str.charCodeAt(m) === 59) break;
    }
    k++;
  }
  let end = k;
  while (end > urlStart) {
    const c = str.charCodeAt(end - 1);
    if (c === 46 || c === 44 || c === 59 || c === 58 || c === 33 || c === 63 || c === 47 || c === 41) end--;
    else break;
  }
  if (end <= urlStart) return null;
  const url = str.slice(urlStart, end);
  // the domain is after the first '@' (if any), up to the first '/'
  const atIdx = url.indexOf('@');
  const domStart = atIdx === -1 ? 0 : atIdx + 1;
  let domEnd = url.indexOf('/', domStart);
  if (domEnd === -1) domEnd = url.length;
  const dom = url.slice(domStart, domEnd);
  if (!dom || !dom.includes('.')) return null;
  const parts = dom.split('.');
  for (const lab of parts) {
    if (!lab) return null;
    if (lab[0] === '-' || lab[lab.length - 1] === '-') return null;
    for (let q = 0; q < lab.length; q++) if (!isDomainChar(lab.charCodeAt(q))) return null;
  }
  const tld = parts[parts.length - 1];
  for (let q = 0; q < tld.length; q++) {
    const c = tld.charCodeAt(q);
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122))) return null;
  }
  // a scheme: autolink includes at most one path segment (xmpp:.../txt
  // links, but /txt/bin stops after /txt)
  if (domEnd !== -1 && domEnd < url.length) {
    const secondSlash = url.indexOf('/', domEnd + 1);
    if (secondSlash !== -1) end = urlStart + secondSlash;
  }
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
  // a backslash right before the local part means its first char is
  // escaped (foo\+@...), so this is not a standalone email
  if (ls > 0 && str.charCodeAt(ls - 1) === 92) return null;
  const local = str.slice(ls, atIdx);
  if (local[0] === '.' || local[local.length - 1] === '.') return null;
  // domain after @
  let k = atIdx + 1;
  let ds = k;
  while (k < n && (isDomainChar(str.charCodeAt(k)) || str.charCodeAt(k) === 46)) k++;
  // a trailing '_' means the email is part of a larger token: no autolink
  if (k < n && str.charCodeAt(k) === 95) return null;
  let dom = str.slice(ds, k);
  // strip trailing dots (a.b-c_d@a.b. links a.b-c_d@a.b, '.' literal)
  while (dom.endsWith('.')) dom = dom.slice(0, -1);
  if (!dom) return null;
  const parts = dom.split('.');
  if (parts.length < 2) return null;
  for (const lab of parts) {
    if (!lab) return null;
    if (lab[0] === '-' || lab[lab.length - 1] === '-') return null;
    for (let q = 0; q < lab.length; q++) if (!isDomainChar(lab.charCodeAt(q))) return null;
  }
  const tld = parts[parts.length - 1];
  // GFM extended emails allow a 1-letter TLD (a.b-c_d@a.b is a link)
  for (let q = 0; q < tld.length; q++) {
    const c = tld.charCodeAt(q);
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122))) return null;
  }
  return { start: ls, end: ds + dom.length, text: str.slice(ls, ds + dom.length) };
}

// ---------- the inline scanner ----------
// `istate` is the document-level inline state, shared across every
// parseInline call of one parse(): { inLink } — true once an unclosed
// <a> tag has been seen (an <a> opens a link context that suppresses
// GFM extended autolinks until a </a> closes it). It is also saved and
// restored around each link/image bracket, so a tag inside link text
// cannot leak out of the link.
export function parseInline(str, refs, istate) {
  if (!istate) istate = { inLink: false };
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
      if (nc === 10) {
        flush(); nodes.push({ t: 'br' }); i += 2;
        // leading spaces of the next line are indentation, not content
        while (i < n && (str.charCodeAt(i) === 32 || str.charCodeAt(i) === 9)) i++;
        continue;
      }
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
      brackets.push({ node: tn, bang: null, strIdx: i, closeIdx: -1, image: false, active: true, inLink: istate.inLink });
      i++; continue;
    }
    if (c === 33 && i + 1 < n && str.charCodeAt(i + 1) === 91) { // ![
      flush();
      const bang = { t: 'text', s: '!' };
      nodes.push(bang);
      const tn = { t: 'text', s: '[' };
      nodes.push(tn);
      brackets.push({ node: tn, bang, strIdx: i + 1, closeIdx: -1, image: true, active: true, inLink: istate.inLink });
      i += 2; continue;
    }
    if (c === 93) { // ]
      // only the innermost bracket can close here; an inactive one makes
      // this ']' literal (it must not fall through to an outer bracket)
      let bi = brackets.length - 1;
      if (bi < 0 || !brackets[bi].active) {
        if (bi >= 0) brackets.splice(bi, 1);
        buf += ']'; i++; continue;
      }
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
        // GFM extended autolinks never form inside a link's text; a tag
        // inside the link text must not leak its link context out either
        if (!br.image) stripGfmAutolinks(childNodes);
        istate.inLink = br.inLink;
        let linkNode;
        if (br.image) {
          linkNode = { t: 'image', href: link.href, title: link.title, alt: plainText(childNodes) };
        } else {
          linkNode = { t: 'link', href: link.href, title: link.title, c: childNodes };
        }
        flush();
        nodes.splice(startIdx, nodes.length - startIdx, linkNode);
        brackets.splice(bi, 1);
        // a link cannot contain another link, but an image CAN contain a
        // link (in its alt text) and a link CAN contain an image, so only
        // link brackets are ever deactivated, and only by a link
        if (!br.image) for (const b of brackets) if (!b.image) b.active = false;
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
          // autolink hrefs percent-encode [ and ] (they would close a link)
          const href = inner.replace(/\[/g, '%5B').replace(/\]/g, '%5D');
          flush(); nodes.push({ t: 'link', href, title: null, c: [{ t: 'text', s: inner }] });
          i = gt + 1; matched = true;
        } else if (/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/.test(inner)) {
          flush(); nodes.push({ t: 'link', href: 'mailto:' + inner, title: null, c: [{ t: 'text', s: inner }] });
          i = gt + 1; matched = true;
        }
      }
      if (matched) continue;
      const tag = parseHtmlTag(str, i);
      if (tag) {
        flush();
        const tagStr = str.slice(i, tag.end);
        nodes.push({ t: 'html', s: tagStr });
        // an unclosed <a> opens a link context (suppresses GFM autolinks
        // until a </a> closes it); a self-closing <a/> does not
        const kind = aTagKind(tagStr);
        if (kind === 'a-open') istate.inLink = true;
        else if (kind === 'a-close') istate.inLink = false;
        i = tag.end; continue;
      }
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
        i++;
        // leading spaces of the next line are indentation, not content
        while (i < n && (str.charCodeAt(i) === 32 || str.charCodeAt(i) === 9)) i++;
        continue;
      } else {
        buf += '\n';
      }
      i++; continue;
    }
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) { // possible scheme autolink
      const prev = i === 0 ? 0 : str.charCodeAt(i - 1);
      const prevAlnum = (prev >= 65 && prev <= 90) || (prev >= 97 && prev <= 122) || (prev >= 48 && prev <= 57);
      if (!prevAlnum && !istate.inLink) {
        const s = parseSchemeAutolink(str, i);
        if (s) {
          flush(); nodes.push({ t: 'link', href: s.text, title: null, gfm: true, c: [{ t: 'text', s: s.text }] });
          i = s.end; continue;
        }
      }
    }
    if (c === 119) { // w — possible www. autolink (lowercase only)
      if (!istate.inLink && (i === 0 || !((str.charCodeAt(i - 1) >= 65 && str.charCodeAt(i - 1) <= 90) || (str.charCodeAt(i - 1) >= 97 && str.charCodeAt(i - 1) <= 122) || (str.charCodeAt(i - 1) >= 48 && str.charCodeAt(i - 1) <= 57))) &&
        str.slice(i, i + 4) === 'www.') {
        const w = parseWwwAutolink(str, i);
        if (w) {
          flush(); nodes.push({ t: 'link', href: 'http://' + w.text, title: null, gfm: true, c: [{ t: 'text', s: w.text }] });
          i = w.end; continue;
        }
      }
      buf += str[i]; i++; continue;
    }
    if (c === 64) { // @ — possible extended email autolink
      const em = parseEmailAutolink(str, i);
      if (!istate.inLink && em && em.start < i) {
        // local part is the tail of buf
        const localLen = i - em.start;
        if (buf.length >= localLen && buf.slice(buf.length - localLen) === str.slice(em.start, i)) {
          buf = buf.slice(0, buf.length - localLen);
          flush();
          const text = str.slice(em.start, em.end);
          nodes.push({ t: 'link', href: 'mailto:' + text, title: null, gfm: true, c: [{ t: 'text', s: text }] });
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

export function inlineToHtml(str, refs, out, istate) {
  renderInline(parseInline(str, refs, istate), out);
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
    if (c === 92 && i + 1 < n && isAsciiPunct(line.charCodeAt(i + 1))) {
      // \| is a table-level escape: the pipe stays, the backslash goes
      if (line.charCodeAt(i + 1) === 124) { cur += '|'; i += 2; continue; }
      cur += line[i] + line[i + 1]; i += 2; continue;
    }
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
      let m = k + 1, ok = false, d = '';
      while (m < n) {
        const c = text.charCodeAt(m);
        if (c === 10 || c === 60) break;
        if (c === 92 && m + 1 < n && isAsciiPunct(text.charCodeAt(m + 1))) { d += text[m + 1]; m += 2; continue; }
        if (c === 62) { ok = true; break; }
        d += text[m]; m++;
      }
      if (!ok) break;
      dest = d;
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
    if (!key) break; // empty (or whitespace-only) label is not a refdef
    if (!refs.has(key)) refs.set(key, { dest, title });
    pos = k3; any = true;
  }
  return any ? text.slice(pos) : null;
}

// ---------- rendering ----------
function renderBlocks(node, out, refs, inTightList, istate) {
  switch (node.t) {
    case 'doc': for (const c of node.children) renderBlocks(c, out, refs, false, istate); break;
    case 'para': {
      let content = node.content;
      // task list checkbox on the first paragraph of an item
      out.push('<p>');
      inlineToHtml(content, refs, out, istate);
      out.push('</p>\n');
      break;
    }
    case 'heading': {
      out.push('<h' + node.level + '>');
      inlineToHtml(node.content, refs, out, istate);
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
      for (const c of node.children) renderBlocks(c, out, refs, false, istate);
      out.push('</blockquote>\n');
      break;
    }
    case 'list': {
      out.push(node.ordered ? '<ol' : '<ul');
      if (node.ordered && node.start !== 1) out.push(' start="' + node.start + '"');
      out.push('>\n');
      for (const item of node.children) renderBlocks(item, out, refs, node.tight, istate);
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
            inlineToHtml(ch.content, refs, out, istate);
            // in a tight item, paragraphs are separated by \n only when the
            // next sibling is also a paragraph (not a nested list/block)
            if (k < kids.length - 1 && kids[k + 1].t === 'para') out.push('\n');
          } else {
            if (k === 0 && node.task !== undefined) {
              out.push('<p>');
              out.push(node.task);
              inlineToHtml(ch.content, refs, out, istate);
              out.push('</p>\n');
            } else {
              out.push('<p>');
              inlineToHtml(ch.content, refs, out, istate);
              out.push('</p>\n');
            }
          }
        } else {
          renderBlocks(ch, out, refs, false, istate);
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
        inlineToHtml(node.header[k], refs, out, istate);
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
            inlineToHtml(node.rows[r][k], refs, out, istate);
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
        if (content.startsWith('[ ] ')) { par.task = '<input disabled="" type="checkbox">'; node.content = content.slice(3); }
        else if (content.startsWith('[x] ') || content.startsWith('[X] ')) { par.task = '<input checked="" disabled="" type="checkbox">'; node.content = content.slice(3); }
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
    } else if (node.t === 'code' && node.fenced) {
      // a fenced block's content is its lines joined by \n, with a trailing
      // \n only if the last line is non-blank
      if (node.content.endsWith('\n\n')) node.content = node.content.slice(0, -1);
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
    if (m6 && BLOCK_TAGS.has(m6[1].toLowerCase())) {
      // a complete tag on this line must be well-formed (valid attributes);
      // an incomplete tag (no '>' on the line) starts a multi-line block
      const tag = parseHtmlTag(r, 0);
      if (tag) return { type: 6 };
      if (r.indexOf('>', m6[0].length) === -1) return { type: 6 };
      return null;
    }
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
    if (r.length < 2 || r.charCodeAt(0) !== 60) return null; // must start with <
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
      const beforeWs = j;
      while (j < r.length && (r[j] === ' ' || r[j] === '\t')) j++;
      if (j >= r.length) return null;
      const c = r[j];
      if (c === '>') return { name: name.toLowerCase(), isClose: false, end: j + 1 };
      if (c === '/') {
        if (j + 1 < r.length && r[j + 1] === '>') return { name: name.toLowerCase(), isClose: false, end: j + 2 };
        return null;
      }
      // attribute: must be preceded by whitespace and start with a valid char
      if (j === beforeWs) return null;
      if (!/[A-Za-z_:]/.test(c)) return null;
      j++;
      while (j < r.length && /[A-Za-z0-9_.:-]/.test(r[j])) j++;
      while (j < r.length && (r[j] === ' ' || r[j] === '\t')) j++;
      if (j < r.length && r[j] === '=') {
        j++;
        while (j < r.length && (r[j] === ' ' || r[j] === '\t')) j++;
        if (j >= r.length) return null;
        const q = r[j];
        if (q === '"' || q === "'") {
          const e = r.indexOf(q, j + 1);
          if (e === -1) return null;
          j = e + 1;
        } else {
          while (j < r.length && !/[ \t>"'=<>`]/.test(r[j])) j++;
          if (j >= r.length) return null;
        }
      }
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

  // Expand tabs in the leading whitespace of the remaining line content,
  // using each tab's column in the original source line (tab stops every
  // 4 columns). Only the leading whitespace is expanded; tabs later in
  // the line are preserved verbatim. Advances the cursor past the leading
  // whitespace and returns the expanded leading whitespace plus the rest
  // of the line.
  function expandLeadingWs(line) {
    let out = '';
    while (true) {
      const c = curCh(line);
      if (c === 32) { out += ' '; advCh(line); }
      else if (c === 9) { const span = 4 - (line.col & 3); out += ' '.repeat(span); advCh(line); }
      else break;
    }
    return out + remStr(line);
  }

  function addCodeLine(node, line) {
    // A blank content line breaks fenced-code absorption of later
    // non-matching lines (after a blank line a line must match the
    // container to stay in the block).
    node._prevBlank = isBlankL(line);
    if (node.inContainer) {
      // Inside a list item / blockquote, the container indent was already
      // consumed and leading tabs expand by their original column; the
      // fence (or 4-space) indent is then removed from the expanded text.
      const expanded = expandLeadingWs(line);
      const dedent = node.fenced ? node.fenceIndent : 4;
      let s = expanded, rem = dedent;
      while (rem > 0 && s.charCodeAt(0) === 32) { s = s.slice(1); rem--; }
      node.content += s + '\n';
      return;
    }
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
            const node = { t: 'code', fenced: true, fenceChar: c, fenceLen: j, fenceIndent: ind, info, content: '', inContainer: stack.some(b => b.t === 'item' || b.t === 'quote') };
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
      const node = { t: 'code', fenced: false, content: '', inContainer: stack.some(b => b.t === 'item' || b.t === 'quote') };
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

  // A fenced code block inside a list item absorbs content lines that do
  // not match the list item (its content is literal text); only a closing
  // fence line is a block boundary. A fenced code block directly inside a
  // blockquote does not absorb: a line without '>' closes the quote.
  // Returns true when the line should be added to the open fenced code
  // block as content, without closing any container.
  function tryAbsorbCodeLine(line, failIdx, blank) {
    const tipBlk = tip();
    if (tipBlk.t !== 'code' || !tipBlk.fenced || blank || tipBlk._prevBlank) return false;
    let inList = false;
    for (let k = failIdx; k < stack.length; k++) if (stack[k].t === 'item') { inList = true; break; }
    if (!inList) return false;
    // a closing fence line is a boundary, not content
    const st = saveL(line);
    const res = matchLeaf(line, tipBlk, blank);
    if (res === 2) { restL(line, st); return false; }
    restL(line, st);
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
    // a blank line inside a code block is code content, not a separator
    // mark the blank line only on the blocks down to the innermost list
    // item: a blank line inside a nested list loosens that list, not the
    // outer list that contains it
    if (blank && tip().t !== 'code') {
      let deepestItem = -1;
      for (let k = stack.length - 1; k >= 1; k--) if (stack[k].t === 'item') { deepestItem = k; break; }
      // include the innermost item's parent list: that list is a child of
      // the outer item, and its blank flag decides the outer list's
      // looseness when a paragraph follows it (cm-325); harmless when it
      // is the outer item's last child (cm-319)
      const lo = deepestItem === -1 ? stack.length - 1 : Math.max(1, deepestItem - 1);
      for (let k = stack.length - 1; k >= lo; k--) stack[k]._lastLineBlank = true;
    }
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
          if (tryAbsorbCodeLine(line, i, blank)) { lastMatched = stack.length - 1; break; }
          // Lazy continuation only if the line has content and does NOT
          // start a new block that can interrupt the paragraph. A line
          // that is blank after the markers it did match (e.g. a lone '>')
          // closes the inner containers instead.
          const rem = remStr(line);
          const hasContent = /[^ \t\n]/.test(rem);
          if (tip().t === 'para' && !blank && hasContent && !wouldInterrupt(line, tipInList())) { lazy = true; lastMatched = stack.length - 1; }
          break;
        }
        markerConsumed = true;
        lastMatched = i; i++; continue;
      }
      if (blk.t === 'list') { lastMatched = i; i++; continue; }
      if (blk.t === 'item') {
        if (isBlankL(line)) blankHit = true;
        if (!matchItem(line, blk)) {
          if (tryAbsorbCodeLine(line, i, blank)) { lastMatched = stack.length - 1; break; }
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
  const istate = { inLink: false };
  renderBlocks(doc, out, refs, false, istate);
  return out.join('');
}

export { parse };
