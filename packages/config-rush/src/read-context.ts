import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ConfigurationError } from './types.js';

export interface FileInfo {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}
interface ObservedPath {
  path: string;
  canonicalPath: string;
}
interface ObservedNode extends ObservedPath {
  mode: number;
  device: number;
  inode: number;
}
export type ObservedInput =
  | (ObservedPath & { kind: 'missing' })
  | (ObservedNode & { kind: 'file'; sha256: string })
  | (ObservedNode & { kind: 'directory'; entriesSha256?: string })
  | (ObservedNode & { kind: 'symlink'; link: string })
  | (ObservedNode & { kind: 'other' });
export type FileObservation = Extract<ObservedInput, { kind: 'file' }>;
const signature = (input: ObservedInput): string =>
  JSON.stringify(input, Object.keys(input).toSorted());
const digest = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const missing = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';
function invalid(code: string, message: string, file: string): never {
  throw new ConfigurationError([{ code, message, file }]);
}
/** Canonicalize prospective paths without pretending absent resources exist. */
function physicalFuture(file: string, links = new Set<string>()): string {
  let cursor = path.resolve(file);
  const suffix: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(cursor), ...suffix);
    } catch (error) {
      if (!missing(error)) throw error;
      try {
        if (fs.lstatSync(cursor).isSymbolicLink()) {
          if (links.has(cursor) || links.size >= 40)
            invalid('PATH_CYCLE', 'Cannot resolve symbolic-link cycle', cursor);
          links.add(cursor);
          return physicalFuture(
            path.resolve(path.dirname(cursor), fs.readlinkSync(cursor), ...suffix),
            links,
          );
        }
      } catch (statError) {
        if (!missing(statError)) throw statError;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      suffix.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}
function fileDigest(file: string): string {
  const fd = fs.openSync(file, 'r');
  try {
    const hasher = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    for (;;) {
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!bytes) return hasher.digest('hex');
      hasher.update(buffer.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(fd);
  }
}
function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
}
function virtualInfo(directory: boolean): FileInfo {
  return { isFile: () => !directory, isDirectory: () => directory, isSymbolicLink: () => false };
}

/** Explicit per-preview IO state; ordinary reads never retain observations or candidate bytes. */
export class ReadContext {
  private readonly candidates = new Map<string, string>();
  private readonly observed = new Map<string, ObservedInput>();
  private readonly directories = new Set<string>();
  private readonly fileSizes = new Map<string, number>();
  private observedBytes = 0;
  private ignoredPaths = new Set<string>();
  private readonly declaredDependencies = new Set<string>();
  private discoveryGuard: ReadContext | undefined;
  constructor(
    readonly recording = false,
    private readonly bounded = true,
    private readonly trackDependencies = recording,
  ) {}

  private observe(file: string): void {
    if (!this.recording) return;
    const absolute = path.resolve(file);
    let value: ObservedInput;
    try {
      const stat = fs.lstatSync(absolute);
      if (stat.isFile() && this.bounded) {
        if (stat.size > 16 * 1024 * 1024)
          invalid('OBSERVATION_LIMIT', 'Observed input exceeds 16 MiB', absolute);
        this.observedBytes += stat.size - (this.fileSizes.get(absolute) ?? 0);
        this.fileSizes.set(absolute, stat.size);
        if (this.observedBytes > 64 * 1024 * 1024)
          invalid('OBSERVATION_LIMIT', 'Observed file content exceeds 64 MiB', absolute);
      }
      const identity = {
        path: absolute,
        canonicalPath: physicalFuture(absolute),
        mode: stat.mode,
        device: stat.dev,
        inode: stat.ino,
      };
      if (stat.isSymbolicLink())
        value = { ...identity, kind: 'symlink', link: fs.readlinkSync(absolute) };
      else if (stat.isFile()) value = { ...identity, kind: 'file', sha256: fileDigest(absolute) };
      else if (stat.isDirectory())
        value = {
          ...identity,
          kind: 'directory',
          ...(this.directories.has(absolute)
            ? {
                entriesSha256: digest(
                  JSON.stringify(
                    fs
                      .readdirSync(absolute)
                      .filter((name) => !this.ignoredPaths.has(path.join(absolute, name)))
                      .toSorted(),
                  ),
                ),
              }
            : {}),
        };
      else value = { ...identity, kind: 'other' };
    } catch (error) {
      if (!missing(error)) throw error;
      value = { path: absolute, canonicalPath: physicalFuture(absolute), kind: 'missing' };
    }
    if (this.bounded && !this.observed.has(absolute) && this.observed.size >= 16384)
      invalid('OBSERVATION_LIMIT', 'Too many observed filesystem inputs', absolute);
    const previous = this.observed.get(absolute);
    if (
      previous &&
      JSON.stringify(
        value.kind === 'directory' &&
          (previous.kind !== 'directory' || previous.entriesSha256 === undefined)
          ? { ...value, entriesSha256: undefined }
          : value,
      ) !== JSON.stringify(previous)
    )
      invalid(
        'INPUT_CHANGED',
        'Input changed during candidate validation; retry preview',
        absolute,
      );
    this.observed.set(absolute, value);
  }

  observePath(file: string): void {
    if (!this.recording) return;
    let cursor = path.resolve(file);
    for (;;) {
      this.observe(cursor);
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  }

  dependOn(file: string): void {
    if (this.trackDependencies) {
      this.declaredDependencies.add(path.resolve(file));
      this.guardDiscovery(file);
    }
  }
  private guardDiscovery(file: string): void {
    if (this.trackDependencies && !this.recording) {
      this.discoveryGuard ??= new ReadContext(true);
      this.discoveryGuard.observeResource(file);
    }
  }
  discoveryInputs(): ObservedInput[] {
    return this.discoveryGuard?.snapshot().inputs ?? [];
  }
  dependencyAffected(files: readonly string[]): boolean {
    return [...this.declaredDependencies].some((input) =>
      files.some(
        (file) =>
          overlaps(path.resolve(input), path.resolve(file)) ||
          overlaps(physicalFuture(input), physicalFuture(file)),
      ),
    );
  }

  observeResource(file: string): void {
    this.observePath(file);
    this.observePath(physicalFuture(file));
  }

  observePackageSearch(start: string, name: string): void {
    if (!this.recording) return;
    let cursor = path.resolve(start);
    for (;;) {
      this.observePath(path.join(cursor, 'node_modules', name, 'package.json'));
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  }

  addCandidate(projectFolder: string, file: string, contents: string): void {
    const absolute = path.resolve(file);
    const relative = path.relative(projectFolder, absolute);
    if (
      !relative ||
      path.isAbsolute(relative) ||
      relative === '..' ||
      relative.startsWith(`..${path.sep}`)
    )
      invalid('CANDIDATE_PATH', 'Candidate must be a named project-local document', absolute);
    const parts = relative.split(path.sep);
    if (
      parts.some((part) => ['.git', 'node_modules'].includes(part)) ||
      relative === 'package.json' ||
      relative === path.join('config', 'rig.json')
    )
      invalid(
        'CANDIDATE_PATH',
        'Project candidates cannot replace identity, rig or package metadata',
        absolute,
      );
    let cursor = projectFolder;
    for (const part of parts) {
      cursor = path.join(cursor, part);
      this.observePath(cursor);
      try {
        const stat = fs.lstatSync(cursor);
        if (stat.isSymbolicLink())
          invalid('CANDIDATE_SYMLINK', 'Candidate destinations may not traverse symlinks', cursor);
        if (cursor !== absolute && !stat.isDirectory())
          invalid('CANDIDATE_PATH', 'Candidate ancestor is not a directory', cursor);
        if (cursor === absolute && !stat.isFile())
          invalid('CANDIDATE_PATH', 'Candidate destination is not a regular file', cursor);
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
    if (this.candidates.has(absolute))
      invalid('DUPLICATE_TARGET', 'Multiple candidates name the same destination', absolute);
    for (const other of this.candidates.keys()) {
      if (other.startsWith(absolute + path.sep) || absolute.startsWith(other + path.sep))
        invalid(
          'CANDIDATE_CONFLICT',
          'Candidate file paths overlap as ancestor and descendant',
          absolute,
        );
    }
    this.candidates.set(absolute, contents);
  }

  private virtual(file: string): FileInfo | undefined {
    const absolute = path.resolve(file);
    if ([...this.candidates.keys()].some((candidate) => absolute.startsWith(candidate + path.sep)))
      throw Object.assign(new Error('Candidate ancestor is not a directory'), { code: 'ENOTDIR' });
    if (this.candidates.has(absolute)) return virtualInfo(false);
    if ([...this.candidates.keys()].some((candidate) => candidate.startsWith(absolute + path.sep)))
      return virtualInfo(true);
    return undefined;
  }
  readText(file: string): string {
    this.guardDiscovery(file);
    this.observePath(file);
    const candidate = this.candidates.get(path.resolve(file));
    if (candidate !== undefined) return candidate;
    const real = this.realpath(file);
    this.observe(real);
    const substituted = this.candidates.get(real);
    if (substituted !== undefined) return substituted;
    if (!fs.statSync(real).isFile())
      throw new Error('Configuration resource is not a regular file');
    const bytes = fs.readFileSync(real);
    const text = bytes.toString('utf8');
    if (!Buffer.from(text).equals(bytes))
      invalid('INVALID_UTF8', 'Configuration resource must be valid UTF-8', real);
    return text;
  }
  realpath(file: string): string {
    this.observePath(file);
    try {
      const real = fs.realpathSync(file);
      this.observePath(real);
      return real;
    } catch (error) {
      if (missing(error)) {
        const prospective = physicalFuture(file);
        if (this.virtual(prospective)) {
          this.observePath(prospective);
          return prospective;
        }
      }
      throw error;
    }
  }
  lstat(file: string): FileInfo {
    this.observePath(file);
    if (this.virtual(file)) return this.virtual(file)!;
    try {
      return fs.lstatSync(file);
    } catch (error) {
      if (!missing(error)) throw error;
      const real = this.realpath(file);
      return this.virtual(real) ?? fs.lstatSync(file);
    }
  }
  stat(file: string): FileInfo {
    this.observePath(file);
    if (this.virtual(file)) return this.virtual(file)!;
    const real = this.realpath(file);
    return this.virtual(real) ?? fs.statSync(real);
  }
  exists(file: string): boolean {
    try {
      this.lstat(file);
      return true;
    } catch (error) {
      if (missing(error)) return false;
      throw error;
    }
  }
  packageFingerprint(folder: string): string {
    const reader = this.recording ? this : new ReadContext(true, false);
    const visited = new Set<string>();
    const packageInputs: string[] = [];
    const walk = (file: string): void => {
      reader.observePath(file);
      const lexical = reader.observed.get(path.resolve(file));
      if (lexical?.kind === 'symlink') packageInputs.push(JSON.stringify(lexical));
      const real = reader.realpath(file);
      if (visited.has(real)) return;
      visited.add(real);
      if (reader.bounded && visited.size > 4096)
        invalid('OBSERVATION_LIMIT', 'Admitted package exceeds 4096 entries', folder);
      const stat = fs.statSync(real);
      if (stat.isDirectory()) {
        reader.directories.add(real);
        reader.observe(real);
        for (const name of fs.readdirSync(real).toSorted()) walk(path.join(real, name));
      } else if (reader.bounded && !stat.isFile())
        invalid('PACKAGE_RESOURCE_TYPE', 'Admitted package contains a non-file resource', real);
      packageInputs.push(JSON.stringify(reader.observed.get(real)));
    };
    walk(folder);
    return digest(packageInputs.toSorted().join('\n'));
  }
  static producedFile(
    file: string,
    stat: { dev: number; ino: number; mode: number },
    sha256: string,
  ): FileObservation {
    return {
      path: file,
      canonicalPath: file,
      kind: 'file',
      device: stat.dev,
      inode: stat.ino,
      mode: stat.mode,
      sha256,
    };
  }
  static advanceWrite(
    inputs: readonly ObservedInput[],
    produced: FileObservation,
  ): ObservedInput[] {
    return inputs.map((input) =>
      (input.path === produced.path || input.canonicalPath === produced.canonicalPath) &&
      (input.kind === 'file' || input.kind === 'missing')
        ? { ...produced, path: input.path }
        : input,
    );
  }
  static currentInputs(
    inputs: readonly ObservedInput[],
    ignoredPaths: readonly string[] = [],
  ): ObservedInput[] {
    const reader = new ReadContext(true);
    reader.ignoredPaths = new Set(ignoredPaths);
    for (const input of inputs)
      if (input.kind === 'directory' && input.entriesSha256 !== undefined)
        reader.directories.add(input.path);
    return inputs.map((input) => {
      reader.observe(input.path);
      return reader.observed.get(input.path)!;
    });
  }
  static assertInputs(
    inputs: readonly ObservedInput[],
    ignoredPaths: readonly string[] = [],
  ): void {
    const current = ReadContext.currentInputs(inputs, ignoredPaths);
    for (let i = 0; i < inputs.length; i++) {
      if (signature(inputs[i]!) !== signature(current[i]!))
        invalid('INPUT_CHANGED', 'Observed input changed; create a fresh preview', inputs[i]!.path);
    }
  }
  snapshot(): { inputs: ObservedInput[]; inputFingerprint: string } {
    for (const file of this.observed.keys()) this.observe(file);
    const inputs = [...this.observed.values()].toSorted((a, b) => a.path.localeCompare(b.path));
    return { inputs, inputFingerprint: digest(JSON.stringify(inputs)) };
  }
}
export const liveReads = new ReadContext();
