// Public identity; durable storage and protocol identifiers keep their original names
// so a rebrand does not reset an existing deployment (ADR-0002).
export const LOGO_PATH = "/brand/orbit.png";
export const AVATAR_PATH = "/brand/orbit.png";
export const BRAND_HEAD = `<link rel="icon" type="image/png" href="${LOGO_PATH}">
<meta name="theme-color" content="#06101f">`;
export const BRAND_LOCKUP = `<span class="orbit-brand"><img src="${LOGO_PATH}" width="32" height="32" alt=""><span>Orbit</span></span>`;
export const BRAND_STYLE = `.orbit-brand { display: inline-flex; align-items: center; gap: 9px; font-weight: 700; letter-spacing: -.03em; vertical-align: middle; }
.orbit-brand img { display: block; flex: none; border-radius: 8px; object-fit: cover; }`;
