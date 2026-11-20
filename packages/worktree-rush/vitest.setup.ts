import { beforeEach } from 'vitest';

// Under `rush test`, Rush sets RUSH_INVOKED_FOLDER for custom-command context.
// The plugin CLIs consult it for repo discovery (correct in production), so
// clear it before each unit test — tests drive discovery via cwd/args, and the
// few that exercise the RUSH_INVOKED_FOLDER path set it explicitly themselves.
beforeEach(() => {
  delete process.env.RUSH_INVOKED_FOLDER;
});
