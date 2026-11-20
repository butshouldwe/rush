#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import {
  createClient,
  ConfigurationError,
  type Diagnostic,
  type EditRequest,
  type EditPlan,
  type EditEffects,
} from './index.js';
import { parseJson, readJson } from './json.js';
import { Predicate } from 'effect';

const authorCommands = [
  'preview',
  'init',
  'set',
  'unset',
  'suppress',
  'remove-suppression',
  'set-version',
];
const operations = new Set([
  'discover',
  'get',
  'explain',
  'validate',
  ...authorCommands,
  'apply',
  'status',
]);
const help = `config-rush <discover|get|explain|validate|preview|apply|status|init|set|unset|suppress|remove-suppression|set-version> [options]
  --root <folder>          Explicit Rush repository (otherwise search cwd ancestors)
  --project <exact-name>   Project; repeatable for validate
  --domain <name>          Domain; repeatable for validate
  --optional              Permit absent configuration only if registration permits it
  --allow-empty           Explicitly permit an empty validation selection
  --result-file <path>     New invocation-bound JSON artifact; never overwritten
  --invocation-id <id>     Caller identity to verify before consuming the artifact
  --json                  Emit one JSON envelope on stdout (direct binary only)
  --request-file <path|-> Complete multi-edit request for preview
  --plan-file <path>      Saved preview plan or successful preview envelope for apply
  --operation-id <uuid>   Read-only journal reconciliation for status
  --document-file <path|-> Complete document for init (preview only)
  --pointer <pointer>    Domain-value pointer for field-edit preview
  --value <JSON>         Explicit JSON value for set
  --contract-version <v> Explicit version for set-version
  --help                  Show help
Rush commands use the config- prefix (for example config-preview, config-apply, config-status).
init/set/unset/suppress/remove-suppression/set-version produce plans only; apply performs writes.
Rush emits its own banners; use --result-file for CI instead of stripping stdout.
`;
function findRoot(start: string): string {
  let current = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(current, 'rush.json'))) return current;
    const parent = path.dirname(current);
    if (parent === current)
      throw new ConfigurationError([
        { code: 'REPOSITORY_NOT_FOUND', message: 'Pass --root pointing to a Rush repository' },
      ]);
    current = parent;
  }
}
function publish(file: string, text: string): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  let published = false;
  let primary: unknown;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
    const opened = fd;
    fd = undefined; // Never revisit this descriptor below, even if the close on the next line throws.
    fs.closeSync(opened);
    fs.linkSync(temporary, file);
    published = true;
  } catch (error) {
    primary = error;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* Best-effort close of a descriptor that never reached its own explicit close. */
      }
    }
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      // A published result leaves only a harmless duplicate-content temp file; do not fail
      // an already-published result over its cleanup. A cleanup error must never displace an
      // already-recorded primary failure, but an otherwise-silent failure before success is real.
      if (
        !published &&
        !primary &&
        !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
      )
        primary = error;
    }
  }
  if (primary) throw primary;
}
function physicalOutput(file: string): string {
  let cursor = path.dirname(file);
  const remainder = [path.basename(file)];
  for (;;) {
    try {
      return path.join(fs.realpathSync(cursor), ...remainder);
    } catch (error) {
      if (!Predicate.isObject(error) || error.code !== 'ENOENT') throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      remainder.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}
/** Where the user typed the command; Rush runs custom commands from the repository root. */
const invokedFolder = (): string => process.env.RUSH_INVOKED_FOLDER ?? process.cwd();
const userPath = (file: string): string => path.resolve(invokedFolder(), file);
const inputFile = (file: string | undefined): unknown => {
  if (!file) throw new Error('The operation requires an explicit input file');
  return file === '-' ? parseJson(fs.readFileSync(0, 'utf8'), '(stdin)') : readJson(userPath(file));
};
function checkPlannedResult(file: string | undefined, plan: unknown): void {
  if (!file || !Predicate.isObject(plan)) return;
  const destination = physicalOutput(file);
  if (
    Array.isArray(plan.targets) &&
    plan.targets.some((target) => Predicate.isObject(target) && target.file === destination)
  )
    throw new Error('Result file cannot be a planned destination');
}
async function main(): Promise<number> {
  let invocationId: string = randomUUID();
  let operation = 'unknown';
  let resultFile: string | undefined;
  let json = process.argv.slice(2).includes('--json');
  let data: unknown = null;
  let status = 'success';
  let exitCode = 0;
  let diagnostics: readonly Diagnostic[] = [];
  let projects: string[] = [];
  let domains: string[] = [];
  let evaluated: { project: string; domain: string }[] = [];
  let repositoryWide = false;
  let effects: EditEffects = { applied: [], failed: [], unattempted: [], unknown: [] };
  try {
    const parsed = parseArgs({
      allowPositionals: true,
      options: {
        root: { type: 'string' },
        'request-file': { type: 'string' },
        'plan-file': { type: 'string' },
        'operation-id': { type: 'string' },
        'document-file': { type: 'string' },
        pointer: { type: 'string' },
        value: { type: 'string' },
        'contract-version': { type: 'string' },
        project: { type: 'string', multiple: true },
        domain: { type: 'string', multiple: true },
        optional: { type: 'boolean' },
        'allow-empty': { type: 'boolean' },
        'result-file': { type: 'string' },
        'invocation-id': { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean' },
      },
    });
    if (parsed.values.help) {
      process.stdout.write(help);
      return 0;
    }
    json = parsed.values.json ?? false;
    invocationId = parsed.values['invocation-id'] ?? invocationId;
    if (!invocationId.trim()) throw new Error('--invocation-id must be nonempty');
    operation = parsed.positionals[0] ?? '';
    if (parsed.positionals.length !== 1 || !operations.has(operation))
      throw new Error('Select exactly one supported operation; see --help');
    projects = parsed.values.project ?? [];
    domains = parsed.values.domain ?? [];
    const requestedResultFile = parsed.values['result-file']
      ? userPath(parsed.values['result-file'])
      : undefined;
    if (requestedResultFile && fs.existsSync(requestedResultFile))
      throw new Error('Result path already exists; use a fresh invocation path');
    if (operation === 'discover' && (projects.length || domains.length || parsed.values.optional))
      throw new Error('discover does not accept project/domain/optional filters');
    if (operation !== 'validate' && parsed.values['allow-empty'])
      throw new Error('--allow-empty is only valid for validate');
    if (operation === 'validate' && parsed.values.optional)
      throw new Error(
        'validate checks registration requiredness; --optional is only for get/explain',
      );
    if (['get', 'explain'].includes(operation) && (projects.length !== 1 || domains.length !== 1))
      throw new Error('get/explain require exactly one --project and --domain');
    const selectedRoot = parsed.values.root
      ? userPath(parsed.values.root)
      : findRoot(invokedFolder());
    if (requestedResultFile) {
      const destination = physicalOutput(requestedResultFile);
      const stateRoot = path.join(
        fs.realpathSync(selectedRoot),
        'common/temp/config-rush-authoring',
      );
      const physicalStateRoot = path.dirname(physicalOutput(path.join(stateRoot, 'writer.lock')));
      if (
        [stateRoot, physicalStateRoot].some(
          (boundary) =>
            requestedResultFile === boundary ||
            requestedResultFile.startsWith(boundary + path.sep) ||
            destination === boundary ||
            destination.startsWith(boundary + path.sep),
        )
      )
        throw new Error('Result files cannot occupy authoring state storage');
    }
    // A requested path is not a publication capability. Authoring must establish
    // its candidate destinations first; thrown preflight errors stay on stdio.
    if (!authorCommands.includes(operation) && operation !== 'apply')
      resultFile = requestedResultFile;
    const client = createClient({ root: selectedRoot });

    const authorOptionKeys = [
      'request-file',
      'plan-file',
      'operation-id',
      'document-file',
      'pointer',
      'value',
      'contract-version',
    ] as const;
    const allowedAuthorOptions: Record<string, readonly string[]> = {
      preview: ['request-file'],
      apply: ['plan-file'],
      status: ['operation-id'],
      init: ['document-file'],
      set: ['pointer', 'value'],
      unset: ['pointer'],
      suppress: ['pointer'],
      'remove-suppression': ['pointer'],
      'set-version': ['contract-version'],
    };
    for (const key of authorOptionKeys)
      if (
        parsed.values[key] !== undefined &&
        !(allowedAuthorOptions[operation] ?? []).includes(key)
      )
        throw new Error(`${key} is not valid for ${operation}`);
    if (
      (authorCommands.includes(operation) || ['apply', 'status'].includes(operation)) &&
      parsed.values.optional
    )
      throw new Error('--optional is only valid for get/explain');
    if (['preview', 'apply', 'status'].includes(operation) && (projects.length || domains.length))
      throw new Error('Targets come from the explicit request/plan, not extra filters');
    if (authorCommands.includes(operation)) {
      let request: unknown;
      if (operation === 'preview') request = inputFile(parsed.values['request-file']);
      else {
        if (projects.length !== 1 || domains.length !== 1)
          throw new Error('Field/init previews require one exact project and domain');
        const target = { project: projects[0]!, domain: domains[0]! };
        if (operation === 'init')
          request = {
            requestVersion: 1,
            edits: [
              {
                ...target,
                operation: 'create',
                document: inputFile(parsed.values['document-file']),
              },
            ],
          };
        else if (operation === 'set-version')
          request = {
            requestVersion: 1,
            edits: [{ ...target, operation, contractVersion: parsed.values['contract-version'] }],
          };
        else {
          if (parsed.values.pointer === undefined)
            throw new Error('Field preview requires --pointer');
          if (operation === 'set' && parsed.values.value === undefined)
            throw new Error('set requires an explicit JSON --value');
          request = {
            requestVersion: 1,
            edits: [
              {
                ...target,
                operation,
                pointer: parsed.values.pointer,
                ...(operation === 'set'
                  ? { value: parseJson(parsed.values.value!, '(value)') }
                  : {}),
              },
            ],
          };
        }
      }
      const plan = await client.previewEdits(request as EditRequest);
      checkPlannedResult(requestedResultFile, plan);
      resultFile = requestedResultFile;
      data = plan;
      evaluated = plan.scope.evaluated;
      projects = [...new Set(plan.request.edits.map((edit) => edit.project))].toSorted();
      domains = [...new Set(plan.request.edits.map((edit) => edit.domain))].toSorted();
    } else if (operation === 'apply') {
      const input = inputFile(parsed.values['plan-file']);
      let plan: unknown = input;
      if (Predicate.isObject(input) && 'resultVersion' in input) {
        if (
          input.resultVersion !== 1 ||
          input.status !== 'success' ||
          typeof input.operation !== 'string' ||
          !authorCommands.includes(input.operation)
        )
          throw new Error('Apply requires a successful authoring preview envelope');
        plan = input.data;
      }
      checkPlannedResult(requestedResultFile, plan);
      const result = await client.applyEdits(plan as EditPlan);
      resultFile = requestedResultFile;
      data = result;
      effects = result.effects;
      diagnostics = result.diagnostics;
      status = result.status;
      evaluated = result.scope.evaluated;
      projects = [...new Set(evaluated.map((item) => item.project))].toSorted();
      domains = [...new Set(evaluated.map((item) => item.domain))].toSorted();
      if (result.status !== 'success') exitCode = result.status === 'partial' ? 4 : 2;
    } else if (operation === 'status') {
      if (!parsed.values['operation-id']) throw new Error('status requires --operation-id');
      data = await client.editStatus(parsed.values['operation-id']);
    } else if (operation === 'discover') data = await client.discover();
    else if (operation === 'validate') {
      const result = await client.validate({
        allowEmpty: parsed.values['allow-empty'] ?? false,
        ...(projects.length ? { projects } : {}),
        ...(domains.length ? { domains } : {}),
      });
      data = result;
      diagnostics = result.diagnostics;
      evaluated = result.evaluated;
      repositoryWide = !projects.length && !domains.length;
      if (!result.valid) {
        status = 'failure';
        exitCode = 2;
      }
    } else {
      const query = {
        project: projects[0]!,
        domain: domains[0]!,
        optional: parsed.values.optional ?? false,
      };
      if (operation === 'get') {
        const result = await client.get(query);
        data = result;
        evaluated = [{ project: query.project, domain: query.domain }];
        diagnostics = result.diagnostics ?? [];
      } else {
        const result = await client.explain(query);
        data = result;
        evaluated = result.evaluated;
        diagnostics = result.diagnostics;
        if (!result.valid) {
          status = 'failure';
          exitCode = 2;
        }
      }
    }
  } catch (error) {
    status = 'failure';
    exitCode = 2;
    diagnostics =
      error instanceof ConfigurationError
        ? error.diagnostics
        : Predicate.isObject(error) &&
            typeof error.code === 'string' &&
            typeof error.errno === 'number' &&
            error.code !== 'ENOENT'
          ? [
              // A system error other than absence (EACCES, EISDIR, EIO ...) is an unexpected
              // execution failure, exit 1; absence and usage mistakes stay exit 2.
              {
                code: 'IO_FAILURE',
                kind: 'execution',
                message: `${error instanceof Error ? error.message : 'Command failed'}. Check the path and its permissions; nothing was written`,
              },
            ]
          : [
              {
                code: 'USAGE_OR_IO',
                message: `${error instanceof Error ? error.message : 'Command failed'}. Run with --help for usage; for file errors check the path, and pass --root if the repository was not found`,
              },
            ];
  }
  if (status === 'failure' && diagnostics.some((item) => item.kind === 'execution')) exitCode = 1;
  if (
    status === 'failure' &&
    !diagnostics.some((item) => item.kind === 'execution') &&
    diagnostics.some((item) =>
      ['STALE_PREVIEW', 'WRITER_BUSY', 'INPUT_CHANGED', 'JOURNAL_LIMIT'].includes(item.code),
    )
  )
    exitCode = 3;
  const envelope = {
    resultVersion: 1,
    invocationId,
    operation,
    status,
    scope: { projects, domains, requested: { projects, domains }, evaluated, repositoryWide },
    data,
    diagnostics,
    effects,
  };
  const serialized = JSON.stringify(envelope, null, 2) + '\n';
  if (resultFile) {
    try {
      publish(resultFile, serialized);
    } catch (error) {
      process.stderr.write(
        `RESULT_PUBLICATION_FAILED: ${error instanceof Error ? error.message : 'Cannot publish result'}\n`,
      );
      const partial = effects.applied.length > 0 || effects.unknown.length > 0;
      const failed = {
        ...envelope,
        status: partial ? 'partial' : 'failure',
        diagnostics: [
          ...diagnostics,
          {
            code: 'RESULT_PUBLICATION_FAILED',
            kind: 'execution',
            message: 'Result publication failed; inspect operation journal before retrying',
          },
        ],
      };
      if (json) process.stdout.write(JSON.stringify(failed, null, 2) + '\n');
      else process.stderr.write(JSON.stringify({ effects, operation: data }) + '\n');
      return partial ? 4 : 1;
    }
  }
  if (json) process.stdout.write(serialized);
  else {
    process.stdout.write(`${operation}: ${status}\n`);
    if (operation === 'apply' && Predicate.isObject(data))
      process.stdout.write(
        JSON.stringify({ operationId: data.operationId, journal: data.journal, effects }, null, 2) +
          '\n',
      );
    if (resultFile) process.stdout.write(`Result: ${resultFile}\n`);
    if (!diagnostics.length && data !== null)
      process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    for (const d of diagnostics)
      process.stderr.write(
        `${d.code}: ${d.message}${d.file ? ` (${d.file}${d.pointer ?? ''})` : ''}${d.nextAction ? `\nNext: ${d.nextAction}` : ''}\n`,
      );
  }
  return exitCode;
}
process.exitCode = await main();
