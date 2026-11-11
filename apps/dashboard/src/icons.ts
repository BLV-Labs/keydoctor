import type { Status } from "key-doctor";
import { Html } from "./html.ts";

// Decorative only: every icon sits next to a text label.
const svg = (size: number, body: string, width = 2) =>
  new Html(
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`,
  );

export const icon = {
  // Mark: a key whose bow is a medical cross (docs/design/keyfence/logo.svg). 24px on the 32px header tile.
  logo: () => svg(24, '<path d="M6 6.5h2a1 1 0 0 1 1 1V10h2.5a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H9v2.5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V14H2.5a1 1 0 0 1-1-1v-2a1 1 0 0 1 1-1H5V7.5a1 1 0 0 1 1-1z"></path><path d="M12.5 12H22"></path><path d="M17.5 12v3.5M20.5 12v2.5"></path>', 2.2),
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
  sun: () => svg(18, '<circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"></path>'),
  moon: () => svg(18, '<path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"></path>'),
  alert: () => svg(22, '<path d="M12 3l10 18H2L12 3z"></path><path d="M12 10v4M12 17.5v.01"></path>'),
  alertSmall: () => svg(12, '<path d="M12 3l10 18H2L12 3z"></path><path d="M12 10v4M12 17.5v.01"></path>'),
  bellNav: () => svg(20, '<path d="M6 8a6 6 0 1112 0c0 7 3 9 3 9H3s3-2 3-9"></path><path d="M10.3 21a1.9 1.9 0 003.4 0"></path>'),
  wallet: () => svg(16, '<rect x="3" y="6" width="18" height="14" rx="2"></rect><path d="M3 10h18M16 15h.01"></path>'),
  clock: () => svg(12, '<circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path>'),
  pause: () => svg(16, '<path d="M9 5v14M15 5v14"></path>'),
  play: () => svg(16, '<path d="M7 4l13 8-13 8V4z"></path>'),
  plus: () => svg(16, '<path d="M12 5v14M5 12h14"></path>'),
  chevronRight: () => svg(16, '<path d="M9 6l6 6-6 6"></path>'),
  trend: () => svg(28, '<path d="M3 17l6-6 4 4 8-8"></path><path d="M14 7h7v7"></path>', 1.8),
};

const STATUS_ICON: Record<Status, string> = {
  high: '<path d="M12 3l10 18H2L12 3z"></path><path d="M12 10v4M12 17.5v.01"></path>',
  cleanup: '<circle cx="12" cy="12" r="9"></circle><path d="M12 8v5M12 16v.01"></path>',
  note: '<circle cx="12" cy="12" r="9"></circle><path d="M12 11v5M12 8v.01"></path>',
  ok: '<path d="M5 12l5 5L20 7"></path>',
};

export const statusIcon = (status: Status, size = 14) => svg(size, STATUS_ICON[status], 2.4);
