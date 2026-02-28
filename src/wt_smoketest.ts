export interface WebTransportSmokeAttempt {
  attempt: number;
  ok: boolean;
  latency_ms: number;
  error_name: string | null;
  error_message: string | null;
  source: string | null;
  closeCode: string | null;
  reason: string | null;
  timestamp_ms: number;
}

export interface WebTransportSmokeSummary {
  successCount: number;
  failureCount: number;
  averageLatencyMs: number | null;
  p95LatencyMs: number | null;
}

export interface WebTransportSmokeJson {
  url: string;
  attempt_count: number;
  ready_timeout_ms: number;
  use_backoff: boolean;
  max_retries: number;
  attempts: WebTransportSmokeAttempt[];
  summary: {
    success_count: number;
    failure_count: number;
    average_latency_ms: number | null;
    p95_latency_ms: number | null;
  };
}

export interface WebTransportSmokeResult {
  attempts: WebTransportSmokeAttempt[];
  summary: WebTransportSmokeSummary;
  json: string;
  report: WebTransportSmokeJson;
}

export interface WebTransportSmokeOptions {
  useBackoff: boolean;
}

const WT_URL = "https://us-east-1.relay.sylvan-b.com/";
const ATTEMPT_COUNT = 20;
const READY_TIMEOUT_MS = 3000;
const CLOSE_TIMEOUT_MS = 1000;
const MAX_RETRIES = 5;
const BACKOFF_DELAYS_MS = [100, 200, 400, 800, 1600];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timeoutError(label: string, ms: number): Error {
  return new Error(`${label} timed out after ${ms}ms`);
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      window.setTimeout(() => reject(timeoutError(label, ms)), ms);
    }),
  ]);
}

function formatCloseInfo(value: unknown): {
  source: string | null;
  closeCode: string | null;
  reason: string | null;
} {
  if (!value || typeof value !== "object") {
    return { source: null, closeCode: null, reason: null };
  }

  const close = value as Record<string, unknown>;
  const closeCode =
    close.closeCode ?? close.sessionCloseCode ?? close.streamErrorCode;

  return {
    source: close.source ? String(close.source) : null,
    closeCode: closeCode != null ? String(closeCode) : null,
    reason: close.reason ? String(close.reason) : null,
  };
}

function percentile95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index] ?? null;
}

function jitterMs(): number {
  return Math.floor(Math.random() * 101);
}

async function runSingleHandshake(): Promise<{
  readyLatencyMs: number;
  closeInfo: { source: string | null; closeCode: string | null; reason: string | null } | undefined;
}> {
  const startedAt = performance.now();
  const wt = new WebTransport(WT_URL);
  const closedInfoPromise = wt.closed
    .then((info) => formatCloseInfo(info))
    .catch((err) => formatCloseInfo(err));

  try {
    await withTimeout(wt.ready, READY_TIMEOUT_MS, "wt.ready");
    const readyLatencyMs = Math.round(performance.now() - startedAt);

    wt.close();

    const closeInfo = await Promise.race([
      closedInfoPromise,
      sleep(CLOSE_TIMEOUT_MS).then(() => undefined),
    ]);

    return { readyLatencyMs, closeInfo };
  } catch (err) {
    try {
      wt.close();
    } catch {
      // ignore local close errors on failed attempts
    }

    const closeInfo = await Promise.race([
      closedInfoPromise,
      sleep(CLOSE_TIMEOUT_MS).then(() => undefined),
    ]);

    const closeError = Object.assign(err instanceof Error ? err : new Error(String(err)), {
      wtCloseInfo: closeInfo,
    });
    throw closeError;
  }
}

export async function runWebTransportSmokeTest(
  log: (message: string) => void,
  options: WebTransportSmokeOptions,
): Promise<WebTransportSmokeResult> {
  const attempts: WebTransportSmokeAttempt[] = [];

  for (let attempt = 1; attempt <= ATTEMPT_COUNT; attempt += 1) {
    const startedAt = performance.now();
    const timestampMs = Date.now();
    let lastError:
      | (Error & {
          wtCloseInfo?: {
            source: string | null;
            closeCode: string | null;
            reason: string | null;
          };
        })
      | undefined;

    for (let retry = 0; retry <= (options.useBackoff ? MAX_RETRIES : 0); retry += 1) {
      try {
        const result = await runSingleHandshake();
        const latencyMs = Math.round(performance.now() - startedAt);
        const attemptResult: WebTransportSmokeAttempt = {
          attempt,
          ok: true,
          latency_ms: latencyMs,
          error_name: null,
          error_message: null,
          source: result.closeInfo?.source ?? null,
          closeCode: result.closeInfo?.closeCode ?? null,
          reason: result.closeInfo?.reason ?? null,
          timestamp_ms: timestampMs,
        };
        attempts.push(attemptResult);

        const closeSuffix = result.closeInfo
          ? ` source=${result.closeInfo.source ?? ""} closeCode=${result.closeInfo.closeCode ?? ""} reason=${result.closeInfo.reason ?? ""}`
          : "";
        log(
          `[WT] attempt=${attempt} status=OK latency_ms=${latencyMs}${closeSuffix}`,
        );
        lastError = undefined;
        break;
      } catch (err) {
        lastError = err as Error & {
          wtCloseInfo?: {
            source: string | null;
            closeCode: string | null;
            reason: string | null;
          };
        };

        if (!options.useBackoff || retry === MAX_RETRIES) {
          continue;
        }

        const delayMs = BACKOFF_DELAYS_MS[retry] + jitterMs();
        log(`[WT_RETRY] attempt=${attempt} retry=${retry + 1} delay_ms=${delayMs}`);
        await sleep(delayMs);
      }
    }

    if (attempts.length === attempt) {
      continue;
    }

    const latencyMs = Math.round(performance.now() - startedAt);
    const closeInfo = lastError?.wtCloseInfo;
    const attemptResult: WebTransportSmokeAttempt = {
      attempt,
      ok: false,
      latency_ms: latencyMs,
      error_name: lastError?.name ?? "Error",
      error_message: lastError?.message ?? "Unknown error",
      source: closeInfo?.source ?? null,
      closeCode: closeInfo?.closeCode ?? null,
      reason: closeInfo?.reason ?? null,
      timestamp_ms: timestampMs,
    };
    attempts.push(attemptResult);

    const closeSuffix = closeInfo
      ? ` source=${closeInfo.source ?? ""} closeCode=${closeInfo.closeCode ?? ""} reason=${closeInfo.reason ?? ""}`
      : "";
    log(
      `[WT] attempt=${attempt} status=FAIL name=${attemptResult.error_name} message=${attemptResult.error_message}${closeSuffix}`,
    );
  }

  const successLatencies = attempts
    .filter((attempt) => attempt.ok)
    .map((attempt) => attempt.latency_ms);
  const successCount = successLatencies.length;
  const failureCount = attempts.length - successCount;
  const averageLatencyMs =
    successLatencies.length > 0
      ? Math.round(
          successLatencies.reduce((sum, latency) => sum + latency, 0) /
            successLatencies.length,
        )
      : null;
  const p95LatencyMs = percentile95(successLatencies);

  const summary: WebTransportSmokeSummary = {
    successCount,
    failureCount,
    averageLatencyMs,
    p95LatencyMs,
  };

  const report: WebTransportSmokeJson = {
    url: WT_URL,
    attempt_count: ATTEMPT_COUNT,
    ready_timeout_ms: READY_TIMEOUT_MS,
    use_backoff: options.useBackoff,
    max_retries: options.useBackoff ? MAX_RETRIES : 0,
    attempts,
    summary: {
      success_count: successCount,
      failure_count: failureCount,
      average_latency_ms: averageLatencyMs,
      p95_latency_ms: p95LatencyMs,
    },
  };
  const json = JSON.stringify(report);

  log(
    `[WT] summary success_count=${summary.successCount} failure_count=${summary.failureCount} average_latency_ms=${summary.averageLatencyMs ?? "n/a"} p95_latency_ms=${summary.p95LatencyMs ?? "n/a"}`,
  );
  console.log(`[WT_JSON] ${json}`);

  return { attempts, summary, json, report };
}
