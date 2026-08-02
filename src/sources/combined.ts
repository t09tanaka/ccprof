import type { Session } from "../core/model.js";
import type { SessionQuery, SessionSource } from "./session-source.js";

/**
 * Concatenates results from several session sources, in source order. A
 * source that throws (a discovery failure, e.g. Claude's typed
 * `ClaudeDiscoveryError`) contributes an empty array rather than failing the
 * whole combined discovery, so one source's outage never loses another
 * source's sessions.
 */
export class CombinedSessionSource implements SessionSource {
  readonly #sources: readonly SessionSource[];

  constructor(sources: readonly SessionSource[]) {
    this.#sources = sources;
  }

  async discover(query: SessionQuery): Promise<Session[]> {
    const results = await Promise.all(
      this.#sources.map(async (source) => {
        try {
          return await source.discover(query);
        } catch {
          return [];
        }
      }),
    );
    return results.flat();
  }
}
