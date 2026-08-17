/**
 * The local development host.
 *
 * Everything interesting is in `src/app-state.ts`; this file only knows how to
 * turn an HTTP request into a `handle(path, body)` call, serve four static
 * files, and hand the model SDKs to the app. The hosted demo is the same app
 * with a different twenty lines wrapped round it — see `web/static/main.ts`.
 *
 *   node web/server.ts        then open http://localhost:4321
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import { createApp } from "../src/app-state.ts";
import type { AiHooks } from "../src/app-state.ts";

const PORT = Number(process.env.PORT ?? 4321);
const PUBLIC_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "public");

/**
 * The model, wired in rather than imported by the app.
 *
 * Loaded lazily so that starting the server without a key costs nothing, and
 * so the SDKs stay out of any bundle that does not need them.
 */
const ai: AiHooks = {
  available: Boolean(process.env.ANTHROPIC_API_KEY ?? process.env.GEMINI_API_KEY),

  async generatePlan(constraints, options) {
    const { generatePlan, selectProvider } = await import("../src/ai/planner.ts");
    const run = await generatePlan(constraints, {
      provider: selectProvider(),
      slots: options.slots,
      larderLines: options.larderLines,
    });
    return {
      plan: run.plan,
      provider: run.provider,
      model: run.model,
      attempts: run.attempts,
      costUsd: run.costUsd,
    };
  },

  async captureTasks(text, context) {
    const { captureTasks } = await import("../src/ai/capture.ts");
    const { selectProvider } = await import("../src/ai/providers.ts");
    const run = await captureTasks(text, context, {
      provider: selectProvider(),
    });
    return {
      tasks: run.tasks,
      note: run.note,
      provider: run.provider,
      model: run.model,
      costUsd: run.costUsd,
    };
  },
};

const app = createApp({ ai });

/* ------------------------------------------------------------------ */

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

async function readBody(req: any): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;

  try {
    if (path.startsWith("/api/")) {
      const body = req.method === "POST" ? await readBody(req) : {};
      const result = await app.handle(path, body);
      res.writeHead(result.status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify(result.body));
      return;
    }

    /* The Supabase browser bundle, served from node_modules rather than a CDN
       so the checker works on a train and nothing phones home. Named to match
       where the published build puts it, so one relative path serves both. */
    if (path === "/vendor-supabase.js" && req.method === "GET") {
      const bundle = join(
        fileURLToPath(new URL("..", import.meta.url)),
        "node_modules/@supabase/supabase-js/dist/umd/supabase.js",
      );
      const body = await readFile(bundle);
      res.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(body);
      return;
    }

    /* The published build ships a bundled copy of the app here, which the
       client uses instead of this server. Locally there is a server, so the
       page asks for the same file and gets nothing — served explicitly rather
       than 404'd, so the console stays clean and the markup stays identical
       in both places. */
    if (
      (path === "/app/family-app.js" || path === "/app/supabase-config.js") &&
      req.method === "GET"
    ) {
      res.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end("/* served by web/server.ts; the client will use fetch */\n");
      return;
    }

    /* ---- static files ---- */
    if (req.method === "GET") {
      /* The published site puts the app under /app/ and the setup checker
         beside it at the root. Serving the same shape locally is what lets
         every path in the HTML be relative, which is in turn what stops the
         pages breaking the moment they are hosted under a subpath. */
      if (path === "/" || path === "/app") {
        res.writeHead(302, { location: "/app/" }).end();
        return;
      }
      const rel = path.endsWith("/") ? `${path.slice(1)}index.html` : path.slice(1);
      // normalize + prefix check keeps ../ out of the served directory
      const file = normalize(join(PUBLIC_DIR, rel));
      if (!file.startsWith(PUBLIC_DIR)) {
        res.writeHead(403).end("Forbidden");
        return;
      }
      const body = await readFile(file);
      res.writeHead(200, {
        "content-type": MIME[extname(file)] ?? "application/octet-stream",
        "cache-control": "no-store",
      });
      res.end(body);
      return;
    }

    res.writeHead(404).end("Not found");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      res.writeHead(404).end("Not found");
      return;
    }
    console.error(message);
    res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: message }));
  }
});

server.listen(PORT, () => {
  console.log(`\n  Family app spike — http://localhost:${PORT}\n`);
  console.log(
    ai.available
      ? "  A model key is present: the AI buttons are live.\n"
      : "  No model key set, so the AI buttons are disabled.\n" +
          "  Everything else works from the fixture week.\n",
  );
});
