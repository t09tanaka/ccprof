import type { Session } from "../core/model.js";

export interface SessionQuery {
  repoRoot: string;
  headBranch: string;
  startedAtMs: number;
  endedAtMs: number;
}

export interface SessionSource {
  discover(query: SessionQuery): Promise<Session[]>;
}
