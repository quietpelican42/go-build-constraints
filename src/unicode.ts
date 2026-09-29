const LETTER = /^\p{L}$/u;
const DIGIT = /^\p{Nd}$/u;

/** Go's unicode.IsSpace: Latin-1 spaces, NEL, NBSP and the White_Space code points. */
export function isSpace(ch: string): boolean {
  switch (ch) {
    case '\t':
    case '\n':
    case '\v':
    case '\f':
    case '\r':
    case ' ':
    case '\u0085':
    case ' ':
    case ' ':
    case ' ':
    case ' ':
    case ' ':
    case ' ':
    case '　':
      return true;
  }
  return ch >= ' ' && ch <= ' ';
}

/** Whether a code point may appear in a build tag: letter, digit, `_` or `.`. */
export function isTagChar(ch: string): boolean {
  return ch === '_' || ch === '.' || LETTER.test(ch) || DIGIT.test(ch);
}

/** strings.TrimSpace. */
export function trimSpace(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && isSpace(s[start]!)) start++;
  while (end > start && isSpace(s[end - 1]!)) end--;
  return s.slice(start, end);
}

/** strings.Fields: split around runs of Unicode white space. */
export function fields(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (const ch of s) {
    if (isSpace(ch)) {
      if (cur !== '') out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur !== '') out.push(cur);
  return out;
}

/** Length of s when encoded as UTF-8. */
export function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length;
}
