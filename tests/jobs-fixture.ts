import { resetChannelsForTest, resetEnvForTest } from "../src/config.ts";
import {
  WORKSPACE_TOKENS,
  WORKSPACE_TOKEN_ENV,
  clearWorkspaceTokenEnv,
  setWorkspaceTokenEnv,
  withTempCwd,
  writeCanonicalChannels,
} from "./helpers.ts";

/**
 * Jobs-path view of the canonical workspace tree in `helpers.ts`:
 *
 *   leadership
 *   └── eboard
 *       ├── programs-mentorship
 *       └── programs-dev
 *
 * A token sees its own workspace plus every descendant, so `eboard` reaches the
 * two programs workspaces but never `leadership`.
 */
export const LEADERSHIP = "leadership";
export const EBOARD = "eboard";
export const PROGRAMS_MENTORSHIP = "programs-mentorship";
export const PROGRAMS_DEV = "programs-dev";

/** Allowlisted channel ids from the canonical config. Slugs are `<name>-<last 4 of id>`. */
export const SPONSORS = "1001";
export const LEADERSHIP_TEAM = "2002";
export const MENTORSHIP_CHAT = "3003";
export const DEV_CHAT = "4004";
export const GENERAL_CHAT = "5005";

/** Channel index paths — what `messagePath`/`parseIndexPath` produce and accept. */
export const SPONSORS_PATH = `/${EBOARD}/eboard-teams/sponsors-1001`;
export const LEADERSHIP_TEAM_PATH = `/${LEADERSHIP}/eboard-teams/leadership-team-2002`;
export const MENTORSHIP_CHAT_PATH = `/${PROGRAMS_MENTORSHIP}/programs/mentorship-chat-3003`;
export const DEV_CHAT_PATH = `/${PROGRAMS_DEV}/programs/dev-chat-4004`;
export const GENERAL_CHAT_PATH = `/${EBOARD}/general-chat-5005`;

export const TOKEN_ENV = WORKSPACE_TOKEN_ENV;
export const LEADERSHIP_TOKEN = WORKSPACE_TOKENS.leadership;
export const EBOARD_TOKEN = WORKSPACE_TOKENS.eboard;
export const MENTORSHIP_TOKEN = WORKSPACE_TOKENS["programs-mentorship"];
export const DEV_TOKEN = WORKSPACE_TOKENS["programs-dev"];

/**
 * chdir into a temp dir holding the canonical `config/channels.yml`, export the
 * four workspace bearers, and clear the config/env caches. Call from `beforeAll`
 * and run the returned cleanup in `afterAll`.
 */
export function withWorkspaceConfig(opts: { tokens?: boolean } = {}): {
  cleanup: () => void;
  dir: string;
} {
  const cwd = withTempCwd();
  writeCanonicalChannels(cwd.dir);

  const saved: Record<string, string | undefined> = {};
  for (const envName of Object.values(WORKSPACE_TOKEN_ENV)) saved[envName] = process.env[envName];
  if (opts.tokens === false) clearWorkspaceTokenEnv();
  else setWorkspaceTokenEnv();

  resetChannelsForTest();
  resetEnvForTest();

  return {
    dir: cwd.dir,
    cleanup: () => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      cwd.cleanup();
      resetChannelsForTest();
      resetEnvForTest();
    },
  };
}
