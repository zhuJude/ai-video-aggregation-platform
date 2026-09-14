import { PublicationError } from '../application/publication.service.js';

const ALLOWED_TAGS = new Set([
  'p',
  'br',
  'strong',
  'em',
  'u',
  's',
  'ul',
  'ol',
  'li',
  'blockquote',
  'h1',
  'h2',
  'h3',
  'h4',
  'a',
  'img',
  'code',
  'pre',
  'iframe',
]);
const VOID_TAGS = new Set(['br', 'img']);
const DANGEROUS_ELEMENT =
  /<\s*\/?\s*(?:script|style|object|embed|svg|math|form|input|button|link|meta|base)\b/i;
const EVENT_HANDLER = /\s+on[a-z][\w-]*\s*=/i;
const UNSAFE_URL = /^(?:javascript|vbscript|data):/i;

export interface RichTextPolicy {
  trustedIframeOrigins: readonly string[];
}

/** Conservative rich-text allowlist. Dangerous constructs are rejected instead of silently rewritten. */
export function sanitizeRichText(html: string, policy: RichTextPolicy): string {
  if (typeof html !== 'string' || html.length > 200_000)
    throw new PublicationError('INVALID_RICH_TEXT');
  if (DANGEROUS_ELEMENT.test(html) || EVENT_HANDLER.test(html))
    throw new PublicationError('UNSAFE_RICH_TEXT');

  const trustedOrigins = new Set(policy.trustedIframeOrigins.map(normalizeOrigin));
  return html.replace(
    /<\/?([a-zA-Z][\w-]*)([^>]*)>/g,
    (raw, rawName: string, rawAttributes: string) => {
      const name = rawName.toLowerCase();
      if (!ALLOWED_TAGS.has(name)) return '';
      if (raw.startsWith('</')) return VOID_TAGS.has(name) ? '' : `</${name}>`;
      const attributes = parseAttributes(rawAttributes);
      const rendered: string[] = [];

      if (name === 'a') {
        const href = safeUrl(attributes.get('href'), new Set(['https:', 'mailto:']));
        if (attributes.has('href') && href === null) throw new PublicationError('UNSAFE_RICH_TEXT');
        if (href !== null) rendered.push(`href="${escapeAttribute(href)}"`);
        const title = attributes.get('title');
        if (title !== undefined) rendered.push(`title="${escapeAttribute(title)}"`);
        rendered.push('rel="noopener noreferrer"');
      } else if (name === 'img') {
        const src = safeUrl(attributes.get('src'), new Set(['https:']));
        if (src === null) throw new PublicationError('UNSAFE_RICH_TEXT');
        rendered.push(`src="${escapeAttribute(src)}"`);
        const alt = attributes.get('alt');
        if (alt !== undefined) rendered.push(`alt="${escapeAttribute(alt)}"`);
      } else if (name === 'iframe') {
        const src = safeUrl(attributes.get('src'), new Set(['https:']));
        if (src === null) throw new PublicationError('UNSAFE_RICH_TEXT');
        let origin: string;
        try {
          origin = new URL(src).origin;
        } catch {
          throw new PublicationError('UNSAFE_RICH_TEXT');
        }
        if (!trustedOrigins.has(origin)) throw new PublicationError('UNSAFE_RICH_TEXT');
        rendered.push(`src="${escapeAttribute(src)}"`);
        if (attributes.has('allowfullscreen')) rendered.push('allowfullscreen');
      }

      return `<${name}${rendered.length === 0 ? '' : ` ${rendered.join(' ')}`}>`;
    },
  );
}

function parseAttributes(source: string): Map<string, string> {
  const result = new Map<string, string>();
  const pattern = /([a-zA-Z][\w-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const name = (match[1] ?? '').toLowerCase();
    result.set(name, match[2] ?? match[3] ?? match[4] ?? '');
  }
  return result;
}

function safeUrl(value: string | undefined, protocols: ReadonlySet<string>): string | null {
  if (value === undefined || UNSAFE_URL.test(value.trim())) return null;
  try {
    const parsed = new URL(value);
    return protocols.has(parsed.protocol) ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function normalizeOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    throw new PublicationError('INVALID_IFRAME_ORIGIN');
  }
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
