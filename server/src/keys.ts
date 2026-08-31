import { ulid } from 'ulid';

/**
 * Object keys are built entirely server-side from validated pieces; raw
 * client filenames are sanitized and never used for authorization or paths.
 */

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || 'untitled';
}

export function sanitizeFilename(raw: string): string {
  // Drop any path components, then whitelist characters.
  const base = raw.split(/[/\\]/).pop() ?? '';
  const cleaned = base.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^[._]+/, '');
  const trimmed = cleaned.slice(0, 128);
  return trimmed || 'file';
}

export function buildObjectKey(
  projectSlug: string,
  folderSlug: string | null,
  filename: string,
): string {
  const date = new Date().toISOString().slice(0, 10);
  return `projects/${projectSlug}/${folderSlug ?? 'raw'}/${date}/${ulid()}-${sanitizeFilename(filename)}`;
}
