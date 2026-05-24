import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

const PORT = Number(process.env.PORT ?? 8080);
const TARGET =
  process.env.API_PROXY_TARGET ??
  "https://cortex-api-tds7av26va-uc.a.run.app";

const targetUrl = new URL(TARGET);
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
  console.log(
    `[dev-proxy] :${PORT} -> ${TARGET}  (override via API_PROXY_TARGET)`,
  );
});
