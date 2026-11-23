"""Remove each release guard in an isolated copy; its named test must fail."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent
# The mutation does not touch the working source and never runs a real publish.
# Publish tests replace npm on PATH and use an ephemeral loopback tarball server.
MUTANTS = [
    ('private', 'if (p.private)', 'if (false)', 'pack refuses a private package'),
    ('registry-pin', 'if (p.publishConfig?.registry)', 'if (false)', 'pack refuses a pinned publish registry'),
    ('access', "if (p.publishConfig?.access !== 'public')", 'if (false)', 'pack refuses restricted access'),
    ('repository', 'if (p.repository?.url !== `git+https://github.com/${repository}.git`)', 'if (false)', 'pack refuses a repository other'),
    ('dependency-scheme', 'if (/^(workspace:|file:|link:)/.test(version))', 'if (false)', 'pack refuses a workspace'),
    ('minimum-npm', "fail('npm >=11.5.1 required');", ';', 'publish refuses an npm older'),
    ('prerelease', "fail('invalid or prerelease version');", ';', 'pack refuses a prerelease'),
    ('manifest-required', "fail('RELEASE_MANIFEST is required');", ';', 'publish refuses to run without'),
    ('filename', "fail('invalid manifest file');", ';', 'publish refuses a manifest file name'),
    ('output-empty', 'if (existsSync(dir) && readdirSync(dir).length)', 'if (false)', 'pack refuses an output'),
    ('sha256', "if (hash(bytes, 'sha256', 'hex') !== e.sha256)", 'if (false)', 'publish refuses every package'),
    ('tarball-name', 'if (p.name !== e.name || p.version !== e.version)', 'if (false)', 'publish refuses a tarball whose package.json'),
    ('token', 'if (value && /^(NODE_AUTH_TOKEN|NPM_TOKEN|NPM_AUTH_TOKEN)$|authToken/i.test(key))', 'if (false)', 'publish refuses a long-lived token'),
    ('registry-error', 'pending(`registry state unknown for ${spec}`);\n  }\n  // Some npm', 'return null;\n  }\n  // Some npm', 'publish stops when the registry state is unknown'),
    ('registry-shape', "if (!dist || typeof dist !== 'object' || Array.isArray(dist))", 'if (false)', 'publish refuses malformed successful'),
    ('downloaded-integrity', "if (sri(bytes) !== entry.integrity)", 'if (false)', 'publish stops before later packages when matching metadata'),
    ('provenance-metadata', 'if (provenance && !dist.attestations?.provenance?.predicateType)', 'if (false)', 'publish fails when the registry holds the version without provenance'),
    ('registry-integrity', 'if (dist.integrity !== entry.integrity)', 'if (false)', 'publish fails when the registry serves bytes'),
    ('publish-provenance', "'--provenance',", "'--ignore-scripts',", 'publish sends each absent package'),
]
WORKFLOW_MUTANTS = [
    ('environment', '    environment: npm-release', '    environment: unprotected', 'workflow: only the gated'),
    ('oidc', '      id-token: write', '      id-token: read', 'workflow: only the gated'),
    ('main-only', "github.ref == 'refs/heads/main'", 'true', 'workflow: only the gated'),
    ('dry-default', '        default: true', '        default: false', 'workflow: manual trigger'),
    ('credentials', '          persist-credentials: false', '          persist-credentials: true', 'workflow: no caches'),
]
TEST_MUTANTS = [
    ('fixture-credentials', '([key]) => !/^(NODE_AUTH_TOKEN|NPM_TOKEN|NPM_AUTH_TOKEN)$|authToken|^npm_config_/i.test(key)', '() => true', 'publish fixtures ignore ambient setup-node'),
]

def main():
    with tempfile.TemporaryDirectory(prefix='release-mutants-') as tmp:
        root = Path(tmp)
        (root / 'scripts').mkdir()
        (root / '.github/workflows').mkdir(parents=True)
        for f in ['scripts/release-npm.mjs', 'scripts/release-npm.test.mjs', '.github/workflows/publish.yml']:
            shutil.copyfile(ROOT / f, root / f)
        env = dict(os.environ, GITHUB_ACTIONS='', GITHUB_STEP_SUMMARY='')
        for key in ['NODE_AUTH_TOKEN', 'NPM_TOKEN', 'NPM_AUTH_TOKEN']:
            env.pop(key, None)
        baseline = subprocess.run(['node', '--test', 'scripts/release-npm.test.mjs'], cwd=root, env=env, capture_output=True, text=True)
        if baseline.returncode != 0 or 'pass 55' not in baseline.stdout:
            print(baseline.stdout, baseline.stderr)
            raise RuntimeError('baseline failed or empty; mutation results inconclusive')
        print('baseline: 55 tests pass')
        for file, mutations in [('scripts/release-npm.mjs', MUTANTS), ('.github/workflows/publish.yml', WORKFLOW_MUTANTS), ('scripts/release-npm.test.mjs', TEST_MUTANTS)]:
            path = root / file
            original = path.read_text()
            for name, old, new, killer in mutations:
                if original.count(old) != (2 if name == 'credentials' else 1):
                    raise RuntimeError(f'{name}: mutant anchor missing')
                path.write_text(original.replace(old, new))
                run = subprocess.run(['node', '--test', f'--test-name-pattern={killer}', 'scripts/release-npm.test.mjs'], cwd=root, env=env, capture_output=True, text=True)
                if run.returncode == 0 or 'AssertionError' not in run.stdout:
                    print(run.stdout, run.stderr)
                    raise RuntimeError(f'{name}: not killed by its assertion')
                print(f'killed {name}: {killer}')
            path.write_text(original)
    print('25 mutants killed by named assertions; no real publishes')

if __name__ == '__main__':
    main()
