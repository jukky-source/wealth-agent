// Inline SVG icon system (no build step, no network fetch, offline-safe).
// Every icon is a 24x24 stroke glyph that inherits `currentColor`, so it
// follows the light/dark theme automatically and never looks like a sticker.
const P = (d) => d;

export const ICONS = {
  home: P('<path d="M3 10.6 12 3.4l9 7.2"/><path d="M5.6 9.7V20h12.8V9.7"/><path d="M10 20v-5.6h4V20"/>'),
  target: P('<circle cx="12" cy="12" r="8.2"/><circle cx="12" cy="12" r="4.1"/><circle cx="12" cy="12" r="1"/>'),
  list: P('<path d="M4 6.5h16M4 12h16M4 17.5h10"/>'),
  trending: P('<path d="M3 17.2 9 11l4 4 8-8"/><path d="M15 7h6v6"/>'),
  chart: P('<path d="M4 4v16h16"/><path d="M8.5 16v-4.5M12.5 16V8M16.5 16v-6.5"/>'),
  gift: P('<path d="M4 11.5h16V20H4z"/><path d="M3 7.5h18v4H3z"/><path d="M12 7.5V20"/><path d="M12 7.5C11 4.4 8.2 4.4 8.2 6.1S10.6 7.5 12 7.5Z"/><path d="M12 7.5c1-3.1 3.8-3.1 3.8-1.4S13.4 7.5 12 7.5Z"/>'),
  briefcase: P('<path d="M3 8.5h18V19H3z"/><path d="M9 8.5V6.7A1.7 1.7 0 0 1 10.7 5h2.6A1.7 1.7 0 0 1 15 6.7v1.8"/><path d="M3 13h18"/>'),
  branch: P('<circle cx="6.5" cy="6" r="2.2"/><circle cx="6.5" cy="18" r="2.2"/><circle cx="17.5" cy="9" r="2.2"/><path d="M6.5 8.2v7.6M17.5 11.2V13a3 3 0 0 1-3 3h-5"/>'),
  book: P('<path d="M12 6.4C10.2 4.9 7 4.4 4 5.3v12.6c3-.9 6.2-.4 8 1.1"/><path d="M12 6.4c1.8-1.5 5-2 8-1.1v12.6c-3-.9-6.2-.4-8 1.1"/><path d="M12 6.4v12.6"/>'),
  file: P('<path d="M6.5 3h6.8l4.2 4.2V21h-11z"/><path d="M13.3 3v4.2H17.5"/><path d="M9.5 13h5M9.5 16.5h5"/>'),
  mask: P('<path d="M4 8.4A1.9 1.9 0 0 1 5.9 6.5h12.2A1.9 1.9 0 0 1 20 8.4v3.9a5.8 5.8 0 0 1-5.8 5.8h-4.4A5.8 5.8 0 0 1 4 12.3z"/><path d="M9.3 11h.01M14.7 11h.01"/><path d="M9.8 14.4c1.4.9 3 .9 4.4 0"/>'),
  gear: P('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6h.09A1.65 1.65 0 0 0 10 3.09V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
  shield: P('<path d="M12 3.2 20 6v6.1c0 4.9-3.4 7.9-8 8.7-4.6-.8-8-3.8-8-8.7V6z"/><path d="M9 12l2.2 2.2L15 10"/>'),
  chat: P('<path d="M21 12a8.4 8.4 0 0 1-12.2 7.4L4 21l1.7-4.6A8.4 8.4 0 1 1 21 12z"/>'),
  play: P('<path d="M8 5.4 19 12 8 18.6z"/>'),
  pause: P('<path d="M9.2 5v14M14.8 5v14"/>'),
  stop: P('<path d="M7 7h10v10H7z"/>'),
  refresh: P('<path d="M20.5 11a8.5 8.5 0 1 0-2.4 6.6"/><path d="M20.5 5v6h-6"/>'),
  menu: P('<path d="M4 7h16M4 12h16M4 17h16"/>'),
  external: P('<path d="M14 4h6v6"/><path d="M20 4l-8.5 8.5"/><path d="M18 14.5V19a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V7.5A1.5 1.5 0 0 1 5 6h4.5"/>'),
  check: P('<path d="M4.5 12.5 9.5 17.5 19.5 6.5"/>'),
  alert: P('<path d="M12 4.2 21 20H3z"/><path d="M12 10v4.2M12 17h.01"/>'),
  clock: P('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.2V12l3.2 2"/>'),
  cpu: P('<rect x="6.5" y="6.5" width="11" height="11" rx="1.5"/><rect x="10" y="10" width="4" height="4" rx="1"/><path d="M10 3v3.5M14 3v3.5M10 17.5V21M14 17.5V21M3 10h3.5M3 14h3.5M17.5 10H21M17.5 14H21"/>'),
  wallet: P('<path d="M4 7h12.5A1.5 1.5 0 0 1 18 8.5V10"/><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H16v2"/><path d="M3 7.5V17a2 2 0 0 0 2 2h14V10H6.5"/><path d="M16 13.5h.01"/>'),
  search: P('<circle cx="11" cy="11" r="7.5"/><path d="M21 21l-4.4-4.4"/>'),
  pulse: P('<path d="M3 12h4l2.2-5.5 3.4 11L15 12h6"/>'),
  zap: P('<path d="M13.4 2.5 4.5 14.2h6.4l-1 7.3 9.6-11.7h-6.4z"/>'),
  upload: P('<path d="M12 16.5V4.2"/><path d="M7.6 8.4 12 4l4.4 4.4"/><path d="M4.5 15v3.3A1.7 1.7 0 0 0 6.2 20h11.6a1.7 1.7 0 0 0 1.7-1.7V15"/>'),
  image: P('<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M4 17.2 9.4 12l3.4 3.2 3-2.6 4.2 3.9"/>'),
  sparkle: P('<path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9z"/><path d="M18.4 16.4l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>'),
  plus: P('<path d="M12 5v14M5 12h14"/>'),
  pin: P('<path d="M9 3.5h6l-.8 5.2 3.3 3.3H6.5l3.3-3.3z"/><path d="M12 12v8.5"/>'),
  trash: P('<path d="M4.5 7h15"/><path d="M9.5 7V4.6h5V7"/><path d="M6.5 7l1 13h9l1-13"/>'),
  pencil: P('<path d="M4 20h4l10-10-4-4L4 16z"/><path d="M14.5 5.5l4 4"/>'),
  users: P('<circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 20c0-3 2.5-5 5.5-5s5.5 2 5.5 5"/><path d="M16 5.6a3 3 0 0 1 0 5.8M17.5 20c0-2.2-.6-3.9-1.7-5"/>'),
  eye: P('<path d="M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>'),
  dot: P('<circle cx="12" cy="12" r="2.4"/>'),
};

/** Render an icon. `name` comes from ICONS; unknown names fall back to a dot. */
export function icon(name, cls = 'i') {
  const body = ICONS[name] || ICONS.dot;
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}
