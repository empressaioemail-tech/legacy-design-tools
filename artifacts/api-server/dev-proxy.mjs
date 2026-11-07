import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

const PORT = Number(process.env.PORT ?? 8080);
// D-25: NO DEFAULT UPSTREAM. This used to fall back to the retired Google Cloud
// Run cortex-api host, so `pnpm run dev` proxied every request to a corpse and
// the failure surfaced as a generic 502 from THIS proxy -- "upstream error" --
// rather than as "you never named an upstream". The upstream is named here or
// this refuses by name before it binds a port.
const TARGET = process.env.API_PROXY_TARGET?.trim();
if (!TARGET) {
  console.error(
    "dev-proxy: API_PROXY_TARGET is not set, and there is no default upstream (D-25):\n" +
      "  the retired Google Cloud Run cortex-api host is dead and must not be used.\n" +
      "  Name the cortex-api origin you mean to develop against, e.g.\n" +
      "    API_PROXY_TARGET=https://<cortex-api-origin> pnpm run dev",
  );
  process.exit(1);
}

let targetUrl;
try {
  targetUrl = new URL(TARGET);
} catch {
  console.error(`dev-proxy: API_PROXY_TARGET is not a valid absolute URL: ${TARGET}`);
  process.exit(1);
}
const isHttps = targetUrl.protocol === "https:";
const client = isHttps ? https : http;

const server = http.createServer((req, res) => {
  const upstreamPath = req.url ?? "/";
  const headers = { ...req.headers, host: targetUrl.host };

  const upstreamReq = client.request(
    {
      protocol: targetUrl.protocol,
      hostname: targetUrl.hostname,
      port: targetUrl.port || (isHttps ? 443 : 80),
      method: req.method,
      path: upstreamPath,
      headers,
      ...(isHttps ? { rejectUnauthorized: false } : {}),
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );

  upstreamReq.on("error", (err) => {
    res.writeHead(502, { "content-type": "text/plain" });
    res.end(`dev-proxy upstream error: ${err.message}`);
  });

  req.pipe(upstreamReq);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[dev-proxy] :${PORT} -> ${TARGET}`);
});
