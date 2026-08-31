import sanitizeHtml from 'sanitize-html';

const allowedTags = ['h2', 'h3', 'p', 'strong', 'em', 'ul', 'ol', 'li', 'blockquote', 'a'];

export function sanitizePublishedHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags,
    allowedAttributes: {
      a: ['href', 'title', 'rel'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowProtocolRelative: false,
    transformTags: {
      a: (_tagName, attributes) => {
        const attribs: Record<string, string> = { rel: 'noreferrer noopener' };
        if (attributes.href) attribs.href = attributes.href;
        if (attributes.title) attribs.title = attributes.title;
        return { tagName: 'a', attribs };
      },
    },
  });
}
