import "dotenv/config";
import "reflect-metadata";

import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DaemoClient, DaemoHostedConnection } from "daemo-engine";
import { buildSessionData } from "./agentSession.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const publicDir = path.resolve(__dirname, "..", "public");

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".ico":
      return "image/x-icon";
    default:
      return "application/octet-stream";
  }
}

async function readJsonBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(text);
}

function writeJson(res: http.ServerResponse, statusCode: number, body: any) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

function writeText(res: http.ServerResponse, statusCode: number, text: string) {
  res.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(text);
}

async function serveStatic(reqUrlPath: string, res: http.ServerResponse) {
  const urlPath = reqUrlPath === "/" ? "/index.html" : reqUrlPath;
  const decoded = decodeURIComponent(urlPath);

  // Block directory traversal.
  const resolved = path.resolve(publicDir, "." + decoded);
  if (!resolved.startsWith(publicDir)) {
    writeText(res, 400, "Bad path");
    return;
  }

  try {
    const data = await fs.readFile(resolved);
    res.writeHead(200, {
      "content-type": contentTypeFor(resolved),
      "content-length": data.length,
      "cache-control": resolved.endsWith(".html") ? "no-store" : "public, max-age=60",
    });
    res.end(data);
  } catch {
    writeText(res, 404, "Not found");
  }
}

async function main() {
  const agentApiKey = process.env.DAEMO_AGENT_API_KEY;
  if (!agentApiKey) throw new Error("Missing DAEMO_AGENT_API_KEY");

  // Start the hosted tool service so the agent can call your AWS tools.
  const sessionData = buildSessionData();
  const connection = new DaemoHostedConnection(
    {
      agentApiKey,
      daemoGatewayUrl: process.env.DAEMO_GATEWAY_URL,
    },
    sessionData
  );
  await connection.start();

  // Expose an HTTP API for the browser chat UI.
  const client = new DaemoClient({ agentApiKey });

  const port = process.env.PORT ? Number(process.env.PORT) : 8787;

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      if (req.method === "GET" && url.pathname === "/api/health") {
        writeJson(res, 200, { ok: true, agentOnline: connection.isActive() });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/chat") {
        const body = await readJsonBody(req);
        const message = typeof body?.message === "string" ? body.message : "";
        const threadId = typeof body?.threadId === "string" ? body.threadId : undefined;

        if (!message.trim()) {
          writeJson(res, 400, { ok: false, error: "Missing 'message' string" });
          return;
        }

        const result = await client.processQuery(message, { threadId });
        writeJson(res, 200, {
          ok: result.success,
          response: result.response,
          threadId: result.threadId,
          errorMessage: result.errorMessage,
          toolInteractions: result.toolInteractions,
          executionTimeMs: result.executionTimeMs,
        });
        return;
      }

      if (req.method === "GET") {
        await serveStatic(url.pathname, res);
        return;
      }

      writeText(res, 405, "Method not allowed");
    } catch (err: any) {
      writeJson(res, 500, { ok: false, error: err?.message ?? "ServerError" });
    }
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`Web chat running on http://127.0.0.1:${port}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

