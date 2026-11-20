# Public npm release

The npm registry is the record of what is published. The Publish workflow
processes this repository's packages in this order:

1. `@butshouldwe/config-rush`
2. `@butshouldwe/fallow-rush`
3. `@butshouldwe/sbom-rush`

## Protect the release environment

1. Verify that this GitHub repository is public. GitHub Actions cannot generate
   npm provenance from a private repository.
2. In Settings > Environments, create `npm-release`. Verify the release
   approver's GitHub account and add it as a required reviewer.
3. Stop if the repository plan cannot enforce a required reviewer. Naming an
   environment in the workflow does not enforce reviewer approval.
4. Set deployment branches to selected branches and allow only `main`. Disable
   administrator bypass. Enable prevent self-review when a separate maintainer
   dispatches releases. Leave it off only if the same maintainer must dispatch
   and approve.
5. Check repository, organization, and environment secrets. Do not store or
   pass `NPM_TOKEN`, `NODE_AUTH_TOKEN`, or any other npm write token.

## Inspect a dry run

1. Dispatch **Publish** from `main` with `dry_run: true`. Verify the source
   commit and confirm that the build and package checks pass. The build job
   has no OIDC permission. A dry run does not publish to npm or prove publish
   authorization or reviewer enforcement.
2. Download the `npm-release` artifact from that run. Extract it into an empty
   directory. Read `manifest.json` and `SHA256SUMS`. Compare the package names
   and versions with the approved release.
3. Run `sha256sum -c SHA256SUMS` from the extracted directory. List each
   tarball's contents with `tar -tzf`. Stop on a failed checksum, unexpected
   file, or host path. Use the exact checked tarballs. Do not repack them.

## Publish a package for the first time

A package must exist on npm before you can configure its trusted publisher.
Publish only packages the release approver has approved. Follow the package
order above.

1. Use a maintainer's npm account with publish access to the package scope.
   Enable account 2FA and store recovery codes offline. Do not create an
   automation token.
2. In a dedicated shell, use Node 22.14.0 or later and npm 11.5.1 or later.
   Work in the extracted artifact directory without a project `.npmrc`.
   Use an empty user config so scoped registry settings cannot override the
   public registry:

   ```sh
   export NPM_CONFIG_USERCONFIG="$(mktemp)"
   export NPM_CONFIG_BROWSER=false
   npm --version
   npm login --registry=https://registry.npmjs.org/ --auth-type=web
   npm whoami --registry=https://registry.npmjs.org/
   ```

   Open the login URL in a graphical browser. Do not copy the temporary
   config into a repository or workflow.
3. Confirm the approved name and version are absent from npm. Stop if that
   cannot be verified. Set `tarball` to the exact checked file and run:

   ```sh
   npm publish "$tarball" --ignore-scripts --access=public --registry=https://registry.npmjs.org/
   ```

   Complete interactive 2FA. Keep one-time codes out of scripts and logs.
   Do not use `--provenance` for an interactive publish outside GitHub Actions.
4. Read the released version anonymously from public npm. Verify
   `dist.integrity` and compare the downloaded tarball's SHA-512 with the
   checked file. Verify that `latest` points to the intended version, not a
   staging placeholder. If npm reports that the publish is still processing,
   retry the anonymous read for at least ten minutes before reporting failure.
   Do not republish while the outcome is unknown.
5. Log out and remove the temporary config. If logout fails, resolve it before
   deleting the config. Close the dedicated shell after cleanup:

   ```sh
   npm logout --registry=https://registry.npmjs.org/ &&
     rm -- "$NPM_CONFIG_USERCONFIG" &&
     unset NPM_CONFIG_USERCONFIG NPM_CONFIG_BROWSER
   ```

## Configure Trusted Publishing

1. In each package's npm settings, add a GitHub Actions publisher under
   **Trusted publishing**. Use these values:

   | Field                | Value             |
   | -------------------- | ----------------- |
   | Organization or user | `butshouldwe`     |
   | Repository           | `rush`          |
   | Workflow filename    | `publish.yml`     |
   | Environment name     | `npm-release`     |
   | Allowed actions      | Allow npm publish |

   Enter the workflow filename, not its path. Allow direct `npm publish`.
   Approval happens in GitHub, not through npm staging.
2. Under **Publishing access**, select **Require two-factor authentication and
   disallow tokens**. This blocks traditional publishing tokens but allows
   Trusted Publishing with OIDC.
3. Create the publisher when an approved, unpublished version is ready. It
   expires if its first successful publish does not occur within two days.
   Recreate an expired publisher before the next approved release. Do not bump
   a version to test authentication. Verify the binding if the repository
   changes identity.

## Release through the workflow

1. Get approval for the version changes and every package in the workflow.
   Dispatch **Publish** from `main` with `dry_run: false`.
2. Have the release approver verify the source commit, checks, and artifact
   from that run before approving the waiting `npm-release` job.
3. Check the job output. The job installs no project dependencies and runs
   no package lifecycle scripts. It publishes the same checksummed tarballs
   with OIDC and `--provenance`. It checks provenance metadata and anonymously
   downloads and checks the newly published bytes. It skips an existing version
   only when registry integrity and downloaded bytes match. A skip does not
   prove OIDC authorization. Unknown registry errors stop the job.

## Handle a failed or bad release

1. For a partial failure, check each intended version in npm before rerunning.
   Do not treat an unreadable registry response as proof of absence.
2. If a bad version is public, have the release approver decide whether to
   deprecate it and approve a new version. npm versions are immutable. Do not
   overwrite or attempt to republish a version.
3. To stop future releases, get approval before disabling the workflow and
   removing its trusted publisher.

## References

- [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers)
- [npm provenance](https://docs.npmjs.com/generating-provenance-statements)
- https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-deployments/managing-environments-for-deployment
