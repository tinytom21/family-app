/**
 * Find out why the model will not answer.
 *
 * A 500 from a provider tells you almost nothing: it could be the key, the
 * model name, the request shape, or the provider having a bad afternoon. This
 * walks the same path the app does, one rung at a time, and stops at the first
 * one that fails — so the answer is "the model name is wrong", not "something
 * went wrong somewhere".
 *
 *   node scripts/doctor.mjs
 *
 * It prints no key material. Where it has to show one, it shows the first few
 * characters and the length, which is enough to tell a real key from a
 * placeholder and not enough to use.
 */

const mask = (key) =>
  !key ? "(not set)" : `${key.slice(0, 8)}… (${key.length} chars)`;

const ok = (m) => console.log(`  [32m✓[0m ${m}`);
const bad = (m) => console.log(`  [31m✗[0m ${m}`);
const info = (m) => console.log(`    ${m}`);

console.log("\n  Family app — model doctor\n");

/* ---- 1. what is in the environment ---- */
console.log("  Environment");
info(`ANTHROPIC_API_KEY  ${mask(process.env.ANTHROPIC_API_KEY)}`);
info(`GEMINI_API_KEY     ${mask(process.env.GEMINI_API_KEY)}`);
info(`MEAL_PLAN_PROVIDER ${process.env.MEAL_PLAN_PROVIDER ?? "(not set)"}`);
console.log();

/* ---- 2. which provider would the app choose ---- */
let provider = null;
try {
  const { selectProvider } = await import("../src/ai/providers.ts");
  provider = selectProvider();
  ok(`Provider chosen: ${provider.id} (${provider.model})`);
} catch (error) {
  bad(`No provider: ${error.message}`);
  howToSetAKey();
  // Deliberately not process.exit(): calling it while the dynamic import above
  // is still unwinding trips a libuv assertion on Windows and replaces a clear
  // message with an incomprehensible crash. Setting the code and falling off
  // the end exits just as non-zero, and cleanly.
  process.exitCode = 1;
}

if (provider) {
  console.log();
  if (provider.id === "gemini") await checkGemini();
  else await checkClaude();
}

/**
 * The variable has to be set in the same window you then run the app in, and
 * the syntax differs by shell — which is a large share of "it says not set but
 * I definitely set it".
 */
function howToSetAKey() {
  console.log();
  info("An API key is set per terminal window, and the syntax differs:");
  console.log();
  info("PowerShell");
  info('  $env:GEMINI_API_KEY = "your-key"');
  info("Command Prompt");
  info('  set GEMINI_API_KEY=your-key');
  console.log();
  info("Then, in that same window:");
  info("  node scripts/doctor.mjs");
  info("  node web/server.ts");
  console.log();
}

/* ------------------------------------------------------------------ */

async function checkGemini() {
  const { GoogleGenAI } = await import("@google/genai");
  const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  /* 3. does the key work at all, independent of any model */
  let names = [];
  try {
    const res = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models",
      { headers: { "x-goog-api-key": process.env.GEMINI_API_KEY } },
    );
    if (!res.ok) {
      bad(`The key was rejected listing models (HTTP ${res.status}).`);
      info(`${(await res.text()).slice(0, 200)}`);
      info("Make a new key at https://aistudio.google.com/apikey");
      return;
    }
    const body = await res.json();
    names = (body.models ?? []).map((m) => m.name.replace(/^models\//, ""));
    ok(`The key works. ${names.length} models visible to it.`);
  } catch (error) {
    bad(`Could not reach Google: ${error.message}`);
    return;
  }

  /* 4. is the model this app asks for actually one of them */
  const wanted = provider.model;
  if (names.includes(wanted)) {
    ok(`"${wanted}" is available to this key.`);
  } else {
    bad(`"${wanted}" is NOT available to this key.`);
    const alternatives = names
      .filter((n) => /gemini/.test(n) && !/embedding|aqa|vision/.test(n))
      .slice(0, 12);
    info("Models this key can use:");
    for (const name of alternatives) info(`  ${name}`);
    info("");
    info("Set one with:  $env:GEMINI_MODEL = \"<name>\"");
    return;
  }
  console.log();

  /* 5. the smallest possible real call */
  try {
    const interaction = await client.interactions.create({
      model: wanted,
      input: "Reply with the single word: ok",
      generation_config: { max_output_tokens: 16 },
    });
    ok(`A plain request works. Model said: ${JSON.stringify(interaction.output_text?.trim())}`);
  } catch (error) {
    bad(`A plain request failed: ${describe(error)}`);
    info("The key and the model are fine, so this is the request shape or");
    info("the service itself. Try again in a minute before changing anything.");
    return;
  }

  /* 6. the same call the app makes, with the JSON schema attached */
  try {
    const { planResponseSchema } = await import("../src/ai/schema.ts");
    const { toGeminiDialect } = await import("../src/ai/dialect.ts");
    const interaction = await client.interactions.create({
      model: wanted,
      input: "Return the smallest valid object for this schema.",
      store: true,
      generation_config: { thinking_level: "high", max_output_tokens: 32000 },
      response_format: {
        type: "text",
        mime_type: "application/json",
        schema: toGeminiDialect(planResponseSchema()),
      },
    });
    ok(`Structured output works (${interaction.output_text?.length ?? 0} chars back).`);
    console.log("\n  Everything the app needs is working.\n");
  } catch (error) {
    bad(`Structured output failed: ${describe(error)}`);
    info("Plain requests work, so the key and model are fine — it is the");
    info("JSON schema, the thinking level, or max_output_tokens that this");
    info("model will not accept. Report this and it can be narrowed further.");
  }
}

async function checkClaude() {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic();
  try {
    const message = await client.messages.create({
      model: provider.model,
      max_tokens: 16,
      messages: [{ role: "user", content: "Reply with the single word: ok" }],
    });
    ok(`A plain request works. Model said: ${JSON.stringify(message.content[0]?.text?.trim())}`);
    console.log("\n  Everything the app needs is working.\n");
  } catch (error) {
    bad(`A plain request failed: ${describe(error)}`);
    if (/401|authentication/i.test(String(error))) {
      info("That is an authentication failure: the key is wrong, empty, or a");
      info("placeholder. Check it at https://console.anthropic.com/settings/keys");
    }
  }
}

function describe(error) {
  const status = error?.status ?? error?.code ?? "";
  const message = error?.message ?? String(error);
  return `${status ? `[${status}] ` : ""}${message.slice(0, 300)}`;
}
