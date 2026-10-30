import React from 'react';

const paths = {
  search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
  file: <><path d="M6 2h8l4 4v16H6z"/><path d="M14 2v5h5M9 12h6M9 16h6"/></>,
  bookmark: <path d="M6 3h12v18l-6-4-6 4z"/>,
  help: <><circle cx="12" cy="12" r="9"/><path d="M9.8 9a2.4 2.4 0 0 1 4.6 1c0 2-2.4 2.2-2.4 4M12 18h.01"/></>,
  upload: <><path d="M12 16V3m-5 5 5-5 5 5M4 14v6h16v-6"/></>,
  plus: <path d="M12 5v14M5 12h14"/>,
  book: <><path d="M3 5h7c2 0 2 2 2 2v14s0-2-3-2H3zM21 5h-7c-2 0-2 2-2 2v14s0-2 3-2h6z"/></>,
  copy: <><rect x="8" y="8" width="12" height="13" rx="1"/><path d="M16 8V3H4v13h4"/></>,
  download: <><path d="M12 3v12m-5-5 5 5 5-5M4 20h16"/></>,
  trash: <><path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6"/></>,
  close: <path d="m6 6 12 12M18 6 6 18"/>,
  database: <><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7"/></>,
  arrow: <><path d="M5 12h14m-5-5 5 5-5 5"/></>,
  check: <path d="m5 12 4 4L19 6"/>,
};

export function Icon({ name, size = 18, filled = false, ...props }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[name]}</svg>;
}
