import { performance } from "node:perf_hooks";

export interface AnalysisBudgets {
  max_input_bytes: number;
  max_input_events: number;
  max_wall_ms: number;
  max_cpu_ms: number;
  max_output_bytes: number;
  max_source_items: number;
}

export interface AnalysisBudgetUsage {
  input_bytes: number;
  input_events: number;
  wall_ms: number;
  cpu_ms: number;
  output_bytes: number;
  source_items: number;
}

export type AnalysisTruncationReason =
  | "max_input_bytes"
  | "max_input_events"
  | "max_wall_ms"
  | "max_cpu_ms"
  | "max_output_bytes"
  | "max_source_items"
  | "source_failure"
  | "meter_error";

export interface AnalysisBudgetResult {
  configured: AnalysisBudgets;
  consumed: AnalysisBudgetUsage;
  observed: AnalysisBudgetUsage;
  completeness: "complete" | "partial";
  truncation_reason?: AnalysisTruncationReason;
  coverage: number;
}

export interface AnalysisBudgetClock {
  wall_ms(): number;
  cpu_ms(): number;
}

export type AnalysisBudgetValidationCode = "invalid_shape" | "invalid_value";

export class AnalysisBudgetValidationError extends TypeError {
  constructor(readonly code: AnalysisBudgetValidationCode) {
    super("Invalid analysis budgets.");
    this.name = "AnalysisBudgetValidationError";
  }
}

const LIMIT_KEYS = [
  "max_input_bytes",
  "max_input_events",
  "max_wall_ms",
  "max_cpu_ms",
  "max_output_bytes",
  "max_source_items",
] as const;

const REASON_ORDER: readonly AnalysisTruncationReason[] = [
  ...LIMIT_KEYS,
  "source_failure",
  "meter_error",
];

const EMPTY_USAGE = (): AnalysisBudgetUsage => ({
  input_bytes: 0,
  input_events: 0,
  wall_ms: 0,
  cpu_ms: 0,
  output_bytes: 0,
  source_items: 0,
});

function invalidShape(): never {
  throw new AnalysisBudgetValidationError("invalid_shape");
}

function invalidValue(): never {
  throw new AnalysisBudgetValidationError("invalid_value");
}

export function normalizeAnalysisBudgets(value: unknown): AnalysisBudgets {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalidShape();
  }

  let keys: readonly PropertyKey[];
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
    keys = Reflect.ownKeys(descriptors);
  } catch {
    return invalidShape();
  }
  if (
    keys.length !== LIMIT_KEYS.length ||
    keys.some((key) =>
      typeof key !== "string" ||
      !LIMIT_KEYS.includes(key as (typeof LIMIT_KEYS)[number])
    )
  ) {
    return invalidShape();
  }

  const entry = (key: (typeof LIMIT_KEYS)[number]): number => {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !("value" in descriptor)
    ) {
      return invalidShape();
    }
    const result = descriptor.value as unknown;
    if (
      typeof result !== "number" ||
      !Number.isSafeInteger(result) ||
      result < 0
    ) {
      return invalidValue();
    }
    return result;
  };

  return Object.freeze({
    max_input_bytes: entry("max_input_bytes"),
    max_input_events: entry("max_input_events"),
    max_wall_ms: entry("max_wall_ms"),
    max_cpu_ms: entry("max_cpu_ms"),
    max_output_bytes: entry("max_output_bytes"),
    max_source_items: entry("max_source_items"),
  });
}

function validClockReading(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) &&
    Number.isSafeInteger(value) && value >= 0;
}

function safeAmount(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("Invalid analysis budget usage.");
  }
}

function safeAdd(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

function finiteRatio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.max(0, Math.min(1, numerator / denominator));
}

export class AnalysisBudgetMeter {
  readonly #configured: Readonly<AnalysisBudgets>;
  readonly #clock: AnalysisBudgetClock;
  readonly #consumed = EMPTY_USAGE();
  readonly #observed = EMPTY_USAGE();
  readonly #reasons = new Set<AnalysisTruncationReason>();
  readonly #reasonCoverage = new Map<AnalysisTruncationReason, number>();
  #startedWallMs = 0;
  #startedCpuMs = 0;

  constructor(budgets: unknown, clock: AnalysisBudgetClock) {
    this.#configured = normalizeAnalysisBudgets(budgets);
    this.#clock = clock;
    try {
      const wall = clock.wall_ms();
      const cpu = clock.cpu_ms();
      if (!validClockReading(wall) || !validClockReading(cpu)) {
        this.#recordReason("meter_error", 0);
      } else {
        this.#startedWallMs = wall;
        this.#startedCpuMs = cpu;
      }
    } catch {
      this.#recordReason("meter_error", 0);
    }
  }

  get stopped(): boolean {
    return this.#reasons.size > 0;
  }

  checkpoint(): boolean {
    if (this.#reasons.has("meter_error")) return false;
    let wall: number;
    let cpu: number;
    try {
      wall = this.#clock.wall_ms();
      cpu = this.#clock.cpu_ms();
    } catch {
      this.#recordReason("meter_error", 0);
      return false;
    }
    if (
      !validClockReading(wall) ||
      !validClockReading(cpu) ||
      wall < this.#startedWallMs ||
      cpu < this.#startedCpuMs
    ) {
      this.#recordReason("meter_error", 0);
      return false;
    }
    const wallElapsed = wall - this.#startedWallMs;
    const cpuElapsed = cpu - this.#startedCpuMs;
    if (!Number.isSafeInteger(wallElapsed) || !Number.isSafeInteger(cpuElapsed)) {
      this.#recordReason("meter_error", 0);
      return false;
    }
    this.#consumed.wall_ms = wallElapsed;
    this.#observed.wall_ms = wallElapsed;
    this.#consumed.cpu_ms = cpuElapsed;
    this.#observed.cpu_ms = cpuElapsed;
    if (wallElapsed > this.#configured.max_wall_ms) {
      this.#recordReason(
        "max_wall_ms",
        finiteRatio(this.#configured.max_wall_ms, wallElapsed),
      );
    }
    if (cpuElapsed > this.#configured.max_cpu_ms) {
      this.#recordReason(
        "max_cpu_ms",
        finiteRatio(this.#configured.max_cpu_ms, cpuElapsed),
      );
    }
    return !this.stopped;
  }

  admitSourceItem(): boolean {
    return this.#admit("source_items", "max_source_items", 1) === 1;
  }

  admitInputBytes(bytes: number): number {
    return this.#admit("input_bytes", "max_input_bytes", bytes);
  }

  admitInputEvents(events: number): number {
    return this.#admit("input_events", "max_input_events", events);
  }

  admitOutputBytes(bytes: number): number {
    return this.#admit("output_bytes", "max_output_bytes", bytes);
  }

  recordSourceFailure(): void {
    this.#recordReason("source_failure", 0);
  }

  result(): AnalysisBudgetResult {
    const reason = REASON_ORDER.find((entry) => this.#reasons.has(entry));
    const coverage = reason === undefined
      ? 1
      : Math.max(0, Math.min(1, Math.min(
          ...[...this.#reasons].map((entry) =>
            this.#reasonCoverage.get(entry) ?? 0
          ),
        )));
    return {
      configured: { ...this.#configured },
      consumed: { ...this.#consumed },
      observed: { ...this.#observed },
      completeness: reason === undefined ? "complete" : "partial",
      ...(reason === undefined ? {} : { truncation_reason: reason }),
      coverage,
    };
  }

  #admit(
    usage: "input_bytes" | "input_events" | "output_bytes" | "source_items",
    reason: Extract<AnalysisTruncationReason, `max_${string}`>,
    requested: number,
  ): number {
    safeAmount(requested);
    this.#observed[usage] = safeAdd(this.#observed[usage], requested);
    const limit = this.#configured[reason];
    const remaining = Math.max(0, limit - this.#consumed[usage]);
    const admitted = Math.min(requested, remaining);
    this.#consumed[usage] = safeAdd(this.#consumed[usage], admitted);
    if (admitted < requested) {
      this.#recordReason(
        reason,
        finiteRatio(this.#consumed[usage], this.#observed[usage]),
      );
    }
    return admitted;
  }

  #recordReason(reason: AnalysisTruncationReason, coverage: number): void {
    this.#reasons.add(reason);
    const current = this.#reasonCoverage.get(reason);
    this.#reasonCoverage.set(
      reason,
      current === undefined ? coverage : Math.min(current, coverage),
    );
  }
}

export function systemAnalysisBudgetClock(): AnalysisBudgetClock {
  return {
    wall_ms: () => Math.floor(performance.now()),
    cpu_ms: () => {
      const usage = process.cpuUsage();
      return Math.floor((usage.user + usage.system) / 1_000);
    },
  };
}
