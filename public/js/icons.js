// Icons adapted from Lucide (ISC); see /js/ICONS-LICENSE.txt.
// The tomato and bucket use the same 24px grid and 1.5px stroke.
const paths = {
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/>',
  'mic-off': '<path d="m2 2 20 20M9 9v3a3 3 0 0 0 5.12 2.12M9 5V4a3 3 0 0 1 6 0v5m4 1v2c0 .5-.05 1-.15 1.47M5 10v2a7 7 0 0 0 12 4.9M12 19v3m-4 0h8"/>',
  music: '<path d="M9 18V5l12-2v13M9 9l12-2"/><ellipse cx="6" cy="18" rx="3" ry="3"/><ellipse cx="18" cy="16" rx="3" ry="3"/>',
  volume: '<path d="m11 5-6 4H2v6h3l6 4V5Zm4 3a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
  'volume-off': '<path d="m11 5-6 4H2v6h3l6 4V5Zm6 4 5 6m0-6-5 6"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4m0 4h.01"/>',
  tomato: '<path d="M12 7c-4-4-10 0-9 6 1 5 5 8 9 8s8-3 9-8c1-6-5-10-9-6Zm0 0V2m0 5L8 4m4 3 4-3"/>',
  bucket: '<path d="M3 7h18l-2 14H5L3 7Zm3 0V6a6 6 0 0 1 12 0v1M7 11h10"/>',
};

export function icon(name) {
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || ''}</svg>`;
}
