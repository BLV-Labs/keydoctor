import type { Status } from "key-doctor";
import { Html } from "./html.ts";

// Decorative only: every icon sits next to a text label.
const svg = (size: number, body: string, width = 2) =>
  new Html(
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`,
  );

export const icon = {
  logo: () => svg(28, '<path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6l7-3z"></path><path d="M12 9v6M9 12h6"></path>'),
  search: () => svg(18, '<circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.5-3.5"></path>'),
  rescan: () => svg(16, '<path d="M21 12a9 9 0 11-3-6.7L21 8"></path><path d="M21 3v5h-5"></path>'),
  bell: () => svg(16, '<path d="M6 8a6 6 0 1112 0c0 7 3 9 3 9H3s3-2 3-9"></path><path d="M10.3 21a1.9 1.9 0 003.4 0"></path>'),
  close: () => svg(20, '<path d="M6 6l12 12M18 6L6 18"></path>'),
  copy: () => svg(16, '<rect x="9" y="9" width="12" height="12" rx="2"></rect><path d="M5 15V5a2 2 0 012-2h10"></path>'),
  send: () => svg(16, '<path d="M22 2L11 13"></path><path d="M22 2l-7 20-4-9-9-4 20-7z"></path>'),
  info: () => svg(18, '<circle cx="12" cy="12" r="9"></circle><path d="M12 11v5M12 8v.01"></path>'),
  check: () => svg(16, '<path d="M5 12l5 5L20 7"></path>'),
  user: () => svg(28, '<circle cx="12" cy="8" r="4"></circle><path d="M4 21c0-4 4-6 8-6s8 2 8 6"></path>', 1.8),
  users: () =>
    svg(28, '<circle cx="9" cy="8" r="3.5"></circle><circle cx="17" cy="9" r="2.5"></circle><path d="M2.5 20c0-3.5 3-5.5 6.5-5.5s6.5 2 6.5 5.5M15 14.6c3 0 6.5 1.4 6.5 4.9"></path>', 1.8),
  key: () => svg(28, '<circle cx="8" cy="15" r="4"></circle><path d="M11 12l9-9M17 6l3 3M15 8l2 2"></path>', 1.8),
  list: () => svg(28, '<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"></path>', 1.8),
  bellLarge: () => svg(28, '<path d="M6 8a6 6 0 1112 0c0 7 3 9 3 9H3s3-2 3-9"></path><path d="M10.3 21a1.9 1.9 0 003.4 0"></path>', 1.8),
  alert: () => svg(22, '<path d="M12 3l10 18H2L12 3z"></path><path d="M12 10v4M12 17.5v.01"></path>'),
};

const STATUS_ICON: Record<Status, string> = {
  high: '<path d="M12 3l10 18H2L12 3z"></path><path d="M12 10v4M12 17.5v.01"></path>',
  cleanup: '<circle cx="12" cy="12" r="9"></circle><path d="M12 8v5M12 16v.01"></path>',
  note: '<circle cx="12" cy="12" r="9"></circle><path d="M12 11v5M12 8v.01"></path>',
  ok: '<path d="M5 12l5 5L20 7"></path>',
};

export const statusIcon = (status: Status, size = 14) => svg(size, STATUS_ICON[status], 2.4);
