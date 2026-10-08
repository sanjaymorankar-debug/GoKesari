/**
 * The small pages the system browser shows during the app's Google sign-in
 * (see src/server/mobile-auth.ts). They are plain HTML rather than React
 * pages because they render outside the app, in a browser tab the user only
 * passes through, and must not carry the site header, cart or wallet.
 */
const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function browserPage(options: {
  status: number;
  title: string;
  message: string;
  /** Sends the browser here straight away, with a button in case the browser holds it back. */
  continueUrl?: string;
}): Response {
  const title = escapeHtml(options.title);
  const message = escapeHtml(options.message);
  const continueUrl = options.continueUrl ? escapeHtml(options.continueUrl) : null;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title} · GoKesari</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         background: #fffdf7; color: #1f2937; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 22rem; padding: 2rem 1.5rem; text-align: center; }
  h1 { margin: 0 0 .5rem; font-size: 1.25rem; }
  p { margin: 0 0 1.5rem; color: #4b5563; }
  a.button { display: inline-block; padding: .75rem 1.5rem; border-radius: .5rem; background: #c9450c;
             color: #fff; font-weight: 600; text-decoration: none; }
</style>
</head>
<body>
<main>
<h1>${title}</h1>
<p>${message}</p>
${continueUrl ? `<a class="button" href="${continueUrl}">Open the GoKesari app</a>` : ""}
</main>
${continueUrl ? `<script>window.location.replace(${JSON.stringify(options.continueUrl).replace(/</g, "\\u003c")});</script>` : ""}
</body>
</html>`;
  return new Response(html, {
    status: options.status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
