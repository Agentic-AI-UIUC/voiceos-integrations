/**
 * Test-only preload (bun --preload) that points server.ts at the local fake
 * Calendly API (and fake Composio proxy, under /composio) in calendly.test.ts,
 * so failure paths like timeouts can be tested
 * without credentials. VoiceOS never loads this file.
 */
const base = process.env.CALENDLY_FAKE_URL;
if (!base) throw new Error("CALENDLY_FAKE_URL is required");

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input)
    .replace("https://api.calendly.com", base)
    .replace("https://backend.composio.dev", `${base}/composio`);
  const res = await realFetch(url, init);
  // Same error AbortSignal.timeout() raises, without making the tests wait 8 seconds.
  if (res.headers.get("x-fake-timeout")) throw new DOMException("The operation timed out.", "TimeoutError");
  return res;
}) as typeof fetch;
