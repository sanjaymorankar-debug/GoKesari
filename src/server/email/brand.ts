/**
 * The GoKesari wordmark for emails: "Go" green, "Kesari" saffron, the G and
 * K heavier, and the green bold tagline underneath — the same look as
 * src/components/brand-wordmark.tsx, in inline styles because mail clients
 * drop stylesheets.
 */
const MARKER = "<!--gk-brand-->";

export const EMAIL_BRAND_GREEN = "#15803d";
export const EMAIL_BRAND_SAFFRON = "#c2410c";

export function emailBrandHeader(): string {
  return (
    `${MARKER}<div style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;margin:0 0 16px">` +
    `<div style="font-size:22px;font-weight:600;line-height:1.2">` +
    `<span style="color:${EMAIL_BRAND_GREEN}"><span style="font-weight:800">G</span>o</span>` +
    `<span style="color:${EMAIL_BRAND_SAFFRON}"><span style="font-weight:800">K</span>esari</span>` +
    `</div>` +
    `<div style="font-size:12px;font-weight:700;color:${EMAIL_BRAND_GREEN}">Everything for Everyone</div>` +
    `</div>`
  );
}

/** Puts the wordmark at the top of an HTML email body, once. */
export function withEmailBrand(html: string): string {
  return html.includes(MARKER) ? html : emailBrandHeader() + html;
}
