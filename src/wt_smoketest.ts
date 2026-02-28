export interface WebTransportSmokeAttempt {
  attempt: number;
  status: "OK" | "FAIL";
  latencyMs: number;
  name?: string;
  message?: string;
  source?: string;
  closeCode?: string;
  reason?: string;
}

export interface WebTransportSmokeSummary {
  successCount: number;
  failureCount: number;
  averageLatencyMs: number | null;
  p95LatencyMs: number | null;
}

export interface WebTransportSmokeResult {
  attempts: WebTransportSmokeAttempt[];
  summary: WebTransportSmokeSummary;
}

const WT_URL = "https://us-east-1.relay.sylvan-b.com/";
const ATTEMPT_COUNT = 20;
const READY_TIMEOUT_MS = 3000;
const CLOSE_TIMEOUT_MS = 1000;

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
  source?: string;
  closeCode?: string;
  reason?: string;
} {
  if (!value || typeof value !== "object") {
    return {};
  }

  const close = value as Record<string, unknown>;
  return {
    source: close.source ? String(close.source) : undefined,
    closeCode:
      close.closeCode ?? close.sessionCloseCode ?? close.streamErrorCode
        ? String(
            close.closeCode ??
              close.sessionCloseCode ??
              close.streamErrorCode,
          )
        : undefined,
    reason: close.reason ? String(close.reason) : undefined,
  };
}

function percentile95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index] ?? null;
}

export async function runWebTransportSmokeTest(
  log: (message: string) => void,
): Promise<WebTransportSmokeResult> {
  const attempts: WebTransportSmokeAttempt[] = [];

  for (let attempt = 1; attempt <= ATTEMPT_COUNT; attempt += 1) {
    const startedAt = performance.now();
    const wt = new WebTransport(WT_URL);
    const closedInfoPromise = wt.closed
      .then((info) => formatCloseInfo(info))
      .catch((err) => formatCloseInfo(err));

    try {
      await withTimeout(wt.ready, READY_TIMEOUT_MS, "wt.ready");
      const latencyMs = Math.round(performance.now() - startedAt);

      wt.close();

      const closeInfo = await Promise.race([
        closedInfoPromise,
        sleep(CLOSE_TIMEOUT_MS).then(() => undefined),
      ]);

      const attemptResult: WebTransportSmokeAttempt = {
        attempt,
        status: "OK",
        latencyMs,
        source: closeInfo?.source,
        closeCode: closeInfo?.closeCode,
        reason: closeInfo?.reason,
      };
      attempts.push(attemptResult);

      const closeSuffix = closeInfo
        ? ` source=${closeInfo.source ?? ""} closeCode=${closeInfo.closeCode ?? ""} reason=${closeInfo.reason ?? ""}`
        : "";
      log(
        `[WT] attempt=${attempt} status=OK latency_ms=${latencyMs}${closeSuffix}`,
      );
    } catch (err) {
      const latencyMs = Math.round(performance.now() - startedAt);
      const error = err as { name?: string; message?: string };
      const closeInfo = await Promise.race([
        closedInfoPromise,
        sleep(CLOSE_TIMEOUT_MS).then(() => undefined),
      ]);

      try {
        wt.close();
      } catch {
        // ignore local close errors on failed attempts
      }

      const attemptResult: WebTransportSmokeAttempt = {
        attempt,
        status: "FAIL",
        latencyMs,
        name: error?.name ?? "Error",
        message: error?.message ?? String(err),
        source: closeInfo?.source,
        closeCode: closeInfo?.closeCode,
        reason: closeInfo?.reason,
      };
      attempts.push(attemptResult);

      const closeSuffix = closeInfo
        ? ` source=${closeInfo.source ?? ""} closeCode=${closeInfo.closeCode ?? ""} reason=${closeInfo.reason ?? ""}`
        : "";
      log(
        `[WT] attempt=${attempt} status=FAIL name=${attemptResult.name} message=${attemptResult.message}${closeSuffix}`,
      );
    }
  }

  const successLatencies = attempts
    .filter((attempt) => attempt.status === "OK")
    .map((attempt) => attempt.latencyMs);
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

  log(
    `[WT] summary success_count=${summary.successCount} failure_count=${summary.failureCount} average_latency_ms=${summary.averageLatencyMs ?? "n/a"} p95_latency_ms=${summary.p95LatencyMs ?? "n/a"}`,
  );

  return { attempts, summary };
}
