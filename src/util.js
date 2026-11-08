// Shared helpers. Kept in their own module so sandbox.js and runner.js do not
// import each other (a cycle that used to crash on duplicate declarations).

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until a service answers from inside the sandbox. A container reports
 * "started" before its server is listening, so the first request can fail.
 * The collector only answers POST; the docs server only answers GET.
 */
export async function waitUntilReady(box, method, url, tries = 20) {
  const body = method === 'POST' ? '-d ready' : '';
  let last = '';
  for (let i = 0; i < tries; i++) {
    const text = await box.exec(
      `curl -s -m 2 -X ${method} ${body} -o /dev/null -w "%{http_code}" ${url}`
    );
    last = String(text).split('\n')[0].trim();
    if (last === '200') return;
    await sleep(1000);
  }
  throw new Error(`service not ready after ${tries}s: ${method} ${url} (last status: ${last})`);
}
