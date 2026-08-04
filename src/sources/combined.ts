import type { Session } from "../core/model.js";
import { SessionSourceValidationError, validateSessionSource } from "./session-source.js";
import type { SessionQuery, SessionSource } from "./session-source.js";

/**
 * Concatenates results from several session sources, in source order. A
 * source that throws (a discovery failure, e.g. Claude's typed
 * `ClaudeDiscoveryError`) contributes an empty array rather than failing the
 * whole combined discovery, so one source's outage never loses another
 * source's sessions. `discover()` itself therefore never rejects because of
 * an ordinary source failure; contract-validation failures still reject.
 *
 * The thrown value is not simply dropped, though: when `onSourceError` is
 * supplied, it is invoked with the raw thrown value for every source that
 * fails, so a caller (e.g. `analyze()`'s default-source wiring) can decide
 * how to surface it - propagate it when nothing else was found, or fold it
 * into a warning when other sources still produced sessions.
 */
export class CombinedSessionSource {
  readonly #sources: readonly SessionSource[];
  readonly #onSourceError: ((error: unknown) => void) | undefined;
  static isDirectInstance(value: unknown): value is CombinedSessionSource {
    return typeof value === "object" && value !== null && #sources in value &&
      Object.getPrototypeOf(value) === CombinedSessionSource.prototype &&
      !Object.hasOwn(value, "discover");
  }

  constructor(
    sources: readonly SessionSource[],
    onSourceError?: (error: unknown) => void,
  ) {
    this.#sources = sources.map(validateSessionSource);
    this.#onSourceError = onSourceError;
  }

  async discover(query: SessionQuery): Promise<Session[]> {
    const meter = query.analysisBudgetMeter;
    if (meter !== undefined) {
      const sessions: Session[] = [];
      for (const source of this.#sources) {
        if (!meter.checkpoint()) break;
        try {
          sessions.push(...await source.discover(query));
        } catch (error) {
          if (error instanceof SessionSourceValidationError) throw error;
          this.#onSourceError?.(error);
          meter.recordSourceFailure();
        }
      }
      return sessions;
    }
    const results = await Promise.all(
      this.#sources.map(async (source) => {
        try {
          return await source.discover(query);
        } catch (error) {
          if (error instanceof SessionSourceValidationError) throw error;
          this.#onSourceError?.(error);
          return [];
        }
      }),
    );
    return results.flat();
  }
}
