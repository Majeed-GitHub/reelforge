import { useMemo } from 'react';
import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: true });

/**
 * Article bodies are Markdown produced by the API from a recorded flow.
 * `marked` gives us GFM; the small scrubber below removes the tags that could
 * ever execute if a body was pasted in from elsewhere (this dashboard renders
 * inside an authenticated workspace, but defence in depth is cheap).
 */
function scrub(html: string): string {
  return html
    .replace(/<(script|style|iframe|object|embed|link|meta|base|form)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(script|style|iframe|object|embed|link|meta|base|form)\b[^>]*\/?>/gi, '')
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '')
    .replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1="#"');
}

export function Markdown({ source, className }: { source: string; className?: string }) {
  const html = useMemo(() => {
    try {
      const rendered = marked.parse(source ?? '', { async: false });
      return scrub(String(rendered));
    } catch {
      return '<p>This article could not be rendered.</p>';
    }
  }, [source]);

  return <div className={className ? `md ${className}` : 'md'} dangerouslySetInnerHTML={{ __html: html }} />;
}
