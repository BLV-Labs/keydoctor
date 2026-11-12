/**
 * A bar's width as a class (`.w-0` … `.w-100` in public/styles.css), never a `style=""` attribute: the site's CSP
 * (`public/_headers`) has no 'unsafe-inline' for styles, so the browser drops inline styles and every bar would be empty.
 * A non-zero share never rounds to 0, and a share short of the whole never rounds to 100.
 */
export function widthClass(n: number, d: number): string {
  if (d <= 0 || n <= 0) return "w-0";
  const p = Math.round((100 * Math.min(n, d)) / d);
  return `w-${String(Math.min(n < d ? 99 : 100, Math.max(1, p)))}`;
}
