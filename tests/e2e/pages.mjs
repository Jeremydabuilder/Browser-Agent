// Waits for an extension page (e.g. the recorder window) to appear. Edge reports a new window's URL a
// little later than Chromium, so this polls open pages instead of filtering the "page" event by URL.
export async function waitForExtPage(context, fragment, { timeout = 30000, exclude = [] } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const hit = context.pages().find((p) => p.url().includes(fragment) && !exclude.includes(p));
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for a page containing "${fragment}"`);
}
