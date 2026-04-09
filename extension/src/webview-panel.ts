export function getWebviewContent(
  nonce: string,
  scriptUri: string,
  styleUri: string,
  cspSource: string,
): string {
  // Removed 'unsafe-inline' from style-src — Tailwind CSS v4 generates static CSS at build time
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${cspSource}; img-src ${cspSource} data:; font-src ${cspSource};">
  <link rel="stylesheet" href="${styleUri}">
  <title>Atelier</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`
}
