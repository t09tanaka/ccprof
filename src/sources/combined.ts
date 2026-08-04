import type { Session } from "../core/model.js";
import {
  isSessionSourceValidationError,
  validateSessionSource,
} from "./session-source.js";
import type { SessionQuery, SessionSource } from "./session-source.js";

const DIRECT_COMBINED_DISCOVERIES = new WeakMap<
  object,
  (query: SessionQuery) => Promise<Session[]>
>();

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
  static snapshotDirectInstance(
    value: unknown,
  ): Pick<SessionSource, "discover"> | undefined {
    if (typeof value !== "object" || value === null) return undefined;
    const discover = DIRECT_COMBINED_DISCOVERIES.get(value);
    if (discover === undefined) return undefined;
    try {
      if (Object.getOwnPropertyDescriptor(value, "discover") !== undefined) {
        return undefined;
      }
    } catch {
      return undefined;
    }
    return Object.freeze({ discover });
  }

  constructor(
    sources: readonly SessionSource[],
    onSourceError?: (error: unknown) => void,
  ) {
    this.#sources = sources.map(validateSessionSource);
    this.#onSourceError = onSourceError;
    if (new.target === CombinedSessionSource) {
      DIRECT_COMBINED_DISCOVERIES.set(this, COMBINED_DISCOVER.bind(this));
    }
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
          if (isSessionSourceValidationError(error)) throw error;
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
          if (isSessionSourceValidationError(error)) throw error;
          this.#onSourceError?.(error);
          return [];
        }
      }),
    );
    return results.flat();
  }
}
const COMBINED_DISCOVER = CombinedSessionSource.prototype.discover;
