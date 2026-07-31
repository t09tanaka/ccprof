import { spawn } from "node:child_process";

export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const COMMAND_TIMEOUT_SETTLE_GRACE_MS = 100;

export interface CommandOptions {
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  options?: CommandOptions,
) => Promise<CommandResult>;

interface Capture {
  chunks: Buffer[];
  bytes: number;
  truncated: boolean;
}

function captureChunk(capture: Capture, chunk: Buffer, limit: number): void {
  const remaining = Math.max(0, limit - capture.bytes);
  if (chunk.length > remaining) {
    capture.truncated = true;
  }
  if (remaining > 0) {
    const kept = chunk.subarray(0, remaining);
    capture.chunks.push(kept);
    capture.bytes += kept.length;
  }
}

export const runCommand: CommandRunner = async (
  command,
  args,
  options = {},
) => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("maxOutputBytes must be a non-negative safe integer");
  }

  return await new Promise<CommandResult>((resolve) => {
    const stdout: Capture = { chunks: [], bytes: 0, truncated: false };
    const stderr: Capture = { chunks: [], bytes: 0, truncated: false };
    const child = spawn(command, [...args], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined
        ? {}
        : { env: { ...process.env, ...options.env } }),
    });
    let timedOut = false;
    let settled = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let hardSettleTimer: ReturnType<typeof setTimeout> | undefined;
    const readStdout = (chunk: Buffer): void => {
      captureChunk(stdout, chunk, maxBytes);
    };
    const readStderr = (chunk: Buffer): void => {
      captureChunk(stderr, chunk, maxBytes);
    };

    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      if (hardSettleTimer !== undefined) clearTimeout(hardSettleTimer);
      child.stdout.off("data", readStdout);
      child.stderr.off("data", readStderr);
      child.off("error", onError);
      child.off("close", onClose);
      resolve({
        code,
        stdout: Buffer.concat(stdout.chunks).toString("utf8"),
        stderr: Buffer.concat(stderr.chunks).toString("utf8"),
        timedOut,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      });
    };

    const forceFinish = (): void => {
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      finish(124);
    };
    const onError = (error: Error): void => {
      captureChunk(stderr, Buffer.from(error.message), maxBytes);
      if (timedOut) {
        forceFinish();
      } else {
        finish(127);
      }
    };
    const onClose = (code: number | null): void => {
      finish(timedOut ? 124 : (code ?? 1));
    };

    child.stdout.on("data", readStdout);
    child.stderr.on("data", readStderr);
    child.once("error", onError);
    child.once("close", onClose);
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch (error) {
        captureChunk(
          stderr,
          Buffer.from(error instanceof Error ? error.message : String(error)),
          maxBytes,
        );
      }
      if (!settled) {
        hardSettleTimer = setTimeout(forceFinish, COMMAND_TIMEOUT_SETTLE_GRACE_MS);
      }
    }, timeoutMs);
  });
};
