import { Component, createSignal } from "solid-js";

type Result = {
  attempt: number;
  success: boolean;
  latency?: number;
  error?: string;
};

export const TestCall2: Component = () => {
  const [relayUrl, setRelayUrl] = createSignal(
    "https://us-east-1.relay.sylvan-b.com/"
  );
  const [attempts, setAttempts] = createSignal(20);

  const [logs, setLogs] = createSignal<string[]>([]);
  const [results, setResults] = createSignal<Result[]>([]);
  const [running, setRunning] = createSignal(false);

  const log = (msg: string) => {
    console.log(msg);
    setLogs((prev) => [...prev, msg]);
  };

  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  const runSingleTest = async (attempt: number): Promise<Result> => {
    const start = performance.now();
    log(`Attempt #${attempt} — starting`);

    try {
      if (typeof WebTransport === "undefined") {
        throw new Error("WebTransport unsupported");
      }

      const wt = new WebTransport(relayUrl());

      await Promise.race([
        wt.ready,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("READY TIMEOUT")), 5000)
        ),
      ]);

      const latency = performance.now() - start;

      log(`Attempt #${attempt} — SUCCESS (${Math.round(latency)} ms)`);

      wt.close();

      return {
        attempt,
        success: true,
        latency,
      };
    } catch (err: any) {
      log(`Attempt #${attempt} — FAIL: ${err?.message || err}`);

      return {
        attempt,
        success: false,
        error: err?.message || String(err),
      };
    }
  };

  const runSmokeTest = async () => {
    if (!relayUrl().startsWith("https://")) {
      alert("Relay URL must start with https://");
      return;
    }

    if (attempts() <= 0) {
      alert("Attempts must be greater than 0");
      return;
    }

    setRunning(true);
    setLogs([]);
    setResults([]);

    const newResults: Result[] = [];

    for (let i = 1; i <= attempts(); i++) {
      const result = await runSingleTest(i);
      newResults.push(result);
      setResults([...newResults]);
      await sleep(300);
    }

    const success = newResults.filter((r) => r.success).length;
    const fail = attempts() - success;

    log("---- SUMMARY ----");
    log(`Success: ${success}`);
    log(`Fail: ${fail}`);
    log(`Failure rate: ${Math.round((fail / attempts()) * 100)}%`);

    setRunning(false);
  };

  const successCount = () => results().filter((r) => r.success).length;
  const failCount = () => results().filter((r) => !r.success).length;

  return (
    <div class="min-h-screen bg-slate-900 text-slate-200 font-mono p-10">
      <div class="max-w-5xl mx-auto">
        <h1 class="text-3xl font-semibold mb-8">WebTransport Smoketest</h1>

        <div class="bg-slate-800 rounded-2xl p-6 mb-6 shadow-lg">
          <h2 class="text-xl font-semibold mb-4">Configuration</h2>

          <div class="mb-5">
            <label class="block text-sm mb-2">Relay URL</label>
            <input
              type="text"
              value={relayUrl()}
              disabled={running()}
              onInput={(e) => setRelayUrl(e.currentTarget.value)}
              class="w-full px-4 py-2 rounded-lg bg-slate-900 border border-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
            />
          </div>

          <div class="mb-6">
            <label class="block text-sm mb-2">Attempts</label>
            <input
              type="number"
              value={attempts()}
              disabled={running()}
              onInput={(e) => setAttempts(Number(e.currentTarget.value))}
              class="w-32 px-4 py-2 rounded-lg bg-slate-900 border border-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
            />
          </div>

          <button
            onClick={runSmokeTest}
            disabled={running()}
            class={`px-6 py-2 rounded-lg font-semibold transition 
              ${
                running()
                  ? "bg-slate-600 cursor-not-allowed"
                  : "bg-blue-600 hover:bg-blue-700"
              }`}
          >
            {running() ? "Running..." : "Start Test"}
          </button>
        </div>

        <div class="bg-slate-800 rounded-2xl p-6 mb-6 shadow-lg">
          <h2 class="text-xl font-semibold mb-4">Results</h2>

          <div class="flex gap-4 mb-4">
            <span class="bg-green-600 px-4 py-1 rounded-full text-sm">
              Success: {successCount()}
            </span>

            <span class="bg-red-600 px-4 py-1 rounded-full text-sm">
              Fail: {failCount()}
            </span>
          </div>

          <pre class="bg-slate-900 p-4 rounded-lg overflow-auto max-h-64 text-xs">
            {JSON.stringify(results(), null, 2)}
          </pre>
        </div>

        <div class="bg-slate-800 rounded-2xl p-6 shadow-lg">
          <h2 class="text-xl font-semibold mb-4">Logs</h2>

          <pre class="bg-slate-900 p-4 rounded-lg overflow-auto max-h-80 text-xs leading-relaxed">
            {logs().join("\n")}
          </pre>
        </div>
      </div>
    </div>
  );
};
