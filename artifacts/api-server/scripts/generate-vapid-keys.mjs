#!/usr/bin/env node
/**
 * T2-WATCH — generate a Web Push VAPID key pair for the Watching tab.
 *
 * For the INTEGRATION SEAT only. Prints the three env lines to stdout so they
 * can be pasted straight into the secret store for cortex:
 *
 *   WEB_PUSH_VAPID_PUBLIC_KEY   (also safe to show the browser; served by GET /api/watching/push/key)
 *   WEB_PUSH_VAPID_PRIVATE_KEY  (secret)
 *   WEB_PUSH_SUBJECT            (mailto: or https: contact the push services can reach)
 *
 * Writes nothing to disk. Never commit the output. Generate ONCE: rotating the
 * pair invalidates every existing browser subscription (each device must
 * subscribe again).
 *
 *   pnpm --filter @workspace/api-server exec node scripts/generate-vapid-keys.mjs [subject]
 */

import webpush from "web-push";

const subject = process.argv[2] ?? "mailto:support@smartsite.cloud";
if (!/^(mailto:|https:\/\/)/.test(subject)) {
  console.error("subject must start with mailto: or https://");
  process.exit(2);
}
const { publicKey, privateKey } = webpush.generateVAPIDKeys();
process.stdout.write(
  `WEB_PUSH_VAPID_PUBLIC_KEY=${publicKey}\nWEB_PUSH_VAPID_PRIVATE_KEY=${privateKey}\nWEB_PUSH_SUBJECT=${subject}\n`,
);
