import { spawn, type ChildProcess } from "node:child_process";

export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const COMMAND_TIMEOUT_SETTLE_GRACE_MS = 100;

export interface CommandOptions {
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  envMode?: "inherit" | "replace";
  stdin?: string | Uint8Array;
  maxStdinBytes?: number;
  timeoutMs?: number;
  maxOutputBytes?: number;
  killProcessGroup?: boolean;
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

function errorCode(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return typeof code === "string" ? code : error.name;
  }
  return "UNKNOWN";
}

function killProcess(
  child: ChildProcess,
  processGroup: boolean,
  onFailure: (code: string) => void,
): void {
  const pid = child.pid;
  if (!processGroup || pid === undefined) {
    try {
      child.kill("SIGKILL");
    } catch (error) {
      onFailure(errorCode(error));
    }
    return;
  }
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      onFailure(errorCode(error));
    }
    return;
  }

  const taskkill = spawn(
    "taskkill",
    ["/PID", String(pid), "/T", "/F"],
    { shell: false, stdio: "ignore", windowsHide: true },
  );
  taskkill.once("error", (error) => {
    onFailure(errorCode(error));
    try {
      child.kill("SIGKILL");
    } catch {
      // The process may already have exited while taskkill was starting.
    }
  });
  taskkill.once("close", (code) => {
    if (code === 0) return;
    onFailure(`TASKKILL_${code ?? "UNKNOWN"}`);
    try {
      child.kill("SIGKILL");
    } catch {
      // The process may already have exited after taskkill returned.
    }
  });
}

export const runCommand: CommandRunner = async (
  command,
  args,
  options = {},
) => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const envMode = options.envMode ?? "inherit";
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("maxOutputBytes must be a non-negative safe integer");
  }
  if (envMode !== "inherit" && envMode !== "replace") {
    throw new RangeError('envMode must be "inherit" or "replace"');
  }
  if (
    options.maxStdinBytes !== undefined &&
    (!Number.isSafeInteger(options.maxStdinBytes) || options.maxStdinBytes < 0)
  ) {
    throw new RangeError("maxStdinBytes must be a non-negative safe integer");
  }
  const stdin = options.stdin === undefined
    ? undefined
    : typeof options.stdin === "string"
      ? Buffer.from(options.stdin, "utf8")
      : Buffer.from(options.stdin);
  if (
    stdin !== undefined &&
    options.maxStdinBytes !== undefined &&
    stdin.byteLength > options.maxStdinBytes
  ) {
    throw new RangeError(
      `stdin exceeds maxStdinBytes (${stdin.byteLength} > ${options.maxStdinBytes})`,
    );
  }
  const env = envMode === "replace"
    ? { ...options.env }
    : options.env === undefined
      ? undefined
      : { ...process.env, ...options.env };
  const killProcessGroup = options.killProcessGroup === true;

  return await new Promise<CommandResult>((resolve) => {
    const stdout: Capture = { chunks: [], bytes: 0, truncated: false };
    const stderr: Capture = { chunks: [], bytes: 0, truncated: false };
    const child = spawn(command, [...args], {
      shell: false,
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(env === undefined ? {} : { env }),
      ...(killProcessGroup && process.platform !== "win32"
        ? { detached: true }
        : {}),
    });
    const stdoutStream = child.stdout;
    const stderrStream = child.stderr;
    const stdinStream = child.stdin;
    if (stdoutStream === null || stderrStream === null) {
      child.kill("SIGKILL");
      resolve({
        code: 127,
        stdout: "",
        stderr: "command output streams unavailable",
      });
      return;
    }
    let timedOut = false;
    let stdinFailed = false;
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
      stdoutStream.off("data", readStdout);
      stderrStream.off("data", readStderr);
      stdinStream?.off("error", onStdinError);
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
      stdinStream?.destroy();
      stdoutStream.destroy();
      stderrStream.destroy();
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
      finish(
        timedOut
          ? 124
          : stdinFailed && (code === null || code === 0)
            ? 1
            : (code ?? 1),
      );
    };
    const onStdinError = (error: Error): void => {
      if (stdinFailed || settled) return;
      stdinFailed = true;
      captureChunk(
        stderr,
        Buffer.from(`stdin write failed: ${errorCode(error)}`),
        maxBytes,
      );
    };

    stdoutStream.on("data", readStdout);
    stderrStream.on("data", readStderr);
    child.once("error", onError);
    child.once("close", onClose);
    if (stdin !== undefined) {
      if (stdinStream === null) {
        onStdinError(new Error("stdin unavailable"));
      } else {
        stdinStream.once("error", onStdinError);
        stdinStream.end(stdin);
      }
    }
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      killProcess(child, killProcessGroup, (code) => {
        captureChunk(
          stderr,
          Buffer.from(`process termination failed: ${code}`),
          maxBytes,
        );
      });
      if (!settled) {
        hardSettleTimer = setTimeout(forceFinish, COMMAND_TIMEOUT_SETTLE_GRACE_MS);
      }
    }, timeoutMs);
  });
};
