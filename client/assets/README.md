# /client/assets — Restaurant Assets

Place your restaurant's image assets here.

## Required Files

| File | Purpose | Notes |
|------|---------|-------|
| `logo.png` | Restaurant logo shown in login page and sidebar | Recommended: 200×200px, transparent background or white bg |
| `payment_qr.png` | QR code for UPI / digital payments (optional) | Shown on receipt if referenced by billing page |

## Optional Files

| File | Purpose |
|------|---------|
| `favicon.png` | Browser tab icon (fallback for favicon.svg) |

## Tips

- Logo should be square (1:1 ratio) for best display in the sidebar
- The sidebar displays the logo at 80×80px — use at least 160×160px source image for crisp HiDPI displays
- Supported formats: PNG, JPG, SVG
- The favicon is defined separately in `client/favicon.svg` — edit that file to change the browser tab icon

> ⚠️ **Do NOT commit real customer QR codes or sensitive payment information** to a public repository.
