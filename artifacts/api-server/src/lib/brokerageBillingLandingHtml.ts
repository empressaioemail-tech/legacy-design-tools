export type BillingLandingVariant = "complete" | "cancel";

export function renderBillingLandingHtml(
  variant: BillingLandingVariant,
): string {
  const isComplete = variant === "complete";
  const title = isComplete ? "Payment complete" : "Checkout canceled";
  const message = isComplete
    ? "Your Hauska subscription is active. Return to the Hauska extension to continue."
    : "Checkout was canceled. You can close this tab and return to the Hauska extension.";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title} — Hauska</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b1220; color: #e8eef8; }
    main { max-width: 28rem; padding: 2rem; text-align: center; }
    h1 { font-size: 1.5rem; margin: 0 0 0.75rem; }
    p { margin: 0; line-height: 1.5; color: #b8c4d9; }
  </style>
</head>
<body>
  <main>
    <h1>${title}</h1>
    <p>${message}</p>
  </main>
</body>
</html>`;
}
