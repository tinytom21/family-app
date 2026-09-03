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
 * Is there a usable model?
 *
 * Asked by trying to choose one, rather than by checking a variable is set —
 * a placeholder left over from a copied command line is "set" and lights the
 * buttons up, then fails at the provider with somebody else's 401.
 */
const modelProblem = await (async () => {
  try {
    const { selectProvider } = await import("../src/ai/providers.ts");
    selectProvider();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
})();

const ai: AiHooks = {
  available: modelProblem === null,

  async generatePlan(constraints, options) {
    const { generatePlan, selectProvider } = await import("../src/ai/planner.ts");
    const provider = selectProvider();
    // A bare 401 from an SDK says nothing about which provider it came from,
    // which matters most when two keys are set and the wrong one won.
    const run = await withProviderNamed(provider, () =>
      generatePlan(constraints, {
        provider,
        slots: options.slots,
        larderLines: options.larderLines,
      }),
    );
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
    const provider = selectProvider();
    const run = await withProviderNamed(provider, () =>
      captureTasks(text, context, { provider }),
    );
    return {
      tasks: run.tasks,
      note: run.note,
      provider: run.provider,
      model: run.model,
      costUsd: run.costUsd,
    };
  },
};

/** Long enough for a slow plan with two repair rounds, short enough to notice. */
const MODEL_TIMEOUT_MS = Number(process.env.MODEL_TIMEOUT_MS ?? 180_000);

function rejectAfter(ms: number, provider: { id: string }): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(
      () =>
        reject(
          new Error(
            `no answer in ${Math.round(ms / 1000)}s — it may be retrying a failing request. Run "npm run doctor" to find out why.`,
          ),
        ),
      ms,
    ).unref(),
  );
}

/**
 * Say who rejected us.
 *
 * The SDKs throw an HTTP error with the remote server's own wording and nothing
 * else — `401 API key is invalid` gives no clue that the request went to
 * Anthropic when you thought you had configured Gemini. With two keys in the
 * environment that is the single most confusing failure available.
 */
async function withProviderNamed<T>(
  provider: { id: string; model: string },
  run: () => Promise<T>,
): Promise<T> {
  try {
    // The SDKs retry 5xx on their own, so one click can sit through several
    // slow failures with nothing on screen but "Asking the model…". A ceiling
    // turns an indefinite wait into an answer somebody can act on.
    return await Promise.race([run(), rejectAfter(MODEL_TIMEOUT_MS, provider)]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const variable =
      provider.id === "claude" ? "ANTHROPIC_API_KEY" : "GEMINI_API_KEY";
    const hint = /401|authentication|api key|unauthor/i.test(message)
      ? ` Check ${variable}, or set MEAL_PLAN_PROVIDER to use the other one.`
      : "";
    throw new Error(`${provider.id} (${provider.model}) refused: ${message}${hint}`);
  }
}

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
      : `  AI buttons disabled — ${modelProblem}\n` +
          "  Everything else works without a model.\n",
  );
});
