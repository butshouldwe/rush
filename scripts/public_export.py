#!/usr/bin/env python3
"""Committed-tree public export and fail-closed byte scanner, Python 3.12+.

Contract: check scans all paths, link targets and file bytes, including hidden
and pinned binary files. Rules are the union of the pinned consumer refusals;
only RFC 2606 domains are built in. No match text is emitted. Locations are
hashed unless PUBLIC_EXPORT_SHOW_PATHS=1. Unknown reads fail closed.

New policies are UTF-8 JSON objects, one per LF-delimited line (empty lines
allowed). Duplicate keys, records, unknown fields, invalid paths and unused
records refuse. Reviewed text binds raw sha256 + exact path + exact rule label,
content only. Email domain entries are exact, case-insensitive domains; address
entries are exact case-sensitive local/domain pairs with prefix/suffix/exclude
scope. No local-part pattern is accepted. Legacy binary input is unchanged.

Email recognition retains legacy trigger eligibility, then expands to the whole
ASCII dot-atom local part and domain token before applying any exemption. A
terminal prose dot is excluded; numeric and hyphenated domain tails are not.
Export reads one pinned commit through an isolated object-backed Git archive,
with only committed attributes and controlled configuration, never dirty bytes.
It preserves selected bytes, modes and links; rejects traversal and unsupported
members before extraction. Output is new/empty, outside source and Git state.
The optional policy directory supplies ONLY the two new input files for staged
adoption/parity; these inputs are not copied into or removed from the export.
Inputs and source must be quiescent during checking; this is not a filesystem
sandbox against a concurrent writer. No extraction of scanned containers occurs.

Parses: policy JSON uses json.loads; globs use fnmatchcase; scanner regexes
recognize arbitrary file bytes, not another program's output. Git names and
archive members remain structured; Git stderr is never parsed.
"""
import fnmatch
import hashlib
import io
import ipaddress
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import unicodedata

sys.dont_write_bytecode = True
MAX_BYTES = 32 * 1024 * 1024
TEXT_POLICY = ".public-export-reviewed-text"
EMAIL_POLICY = ".public-export-emails"
DOC_DOMAINS = {"example.com", "example.org", "example.net"}

PRIVATE_NETWORKS = tuple(ipaddress.ip_network(cidr) for cidr in (
    "10." + "0.0.0/8", "172." + "16.0.0/12", "192." + "168.0.0/16",
    "100." + "64.0.0/10", "fc" + "00::/7", "fe" + "80::/10",
))


def rules():
    # Split literal prefixes/paths so this scanner is itself safe to export.
    # Reference contract (Latin-1 byte view): ASCII-case scheme, left boundary
    # outside ASCII scheme characters, two nonempty slash-delimited segments.
    # Segments exclude quotes, backticks and bytes 0x00-0x1f or 0x7f;
    # bytes 0x80-0xff count as name characters. Segments cannot start with
    # space. Only an item-leading angle placeholder exempts a match,
    # followed by a segment boundary, space or . , ; : ) ]. No bytes change.
    segment = r"[^/\"'`\x00-\x1f\x7f]"
    placeholder = r"<[^<>/\"'`\x00-\x1f\x7f]+>"
    item_end = r"(?=$|[/\"'`\x00-\x1f\x7f .,;:)\]])"
    return [
        ("1Password reference", re.compile(
            r"(?<![A-Za-z0-9+.\-])(?i:" + "o" + "p" + r")://"
            + r"(?! )" + segment + r"+/"
            + r"(?!" + placeholder + item_end + r")(?! )" + segment + r"+"
        )),
        # Byte-view hostname contract: the left edge excludes ASCII label
        # characters; the right excludes only ASCII letters/digits, not hyphens.
        # Non-ASCII bytes and underscores delimit a hostname. No bytes change.
        ("tailnet hostname", re.compile(r"(?<![A-Za-z0-9-])(?:[A-Za-z0-9-]+\.)*(?ai:ts[.]net)(?![A-Za-z0-9])")),
        ("host path", re.compile("/home/" + "hermes" + "|/srv/" + "butshouldwe")),
        ("key prefix", re.compile("(?:sk_" + "live_|pk_" + "live_)")),
        ("AWS key", re.compile("(?:AK" + "IA|AS" + "IA)[0-9A-Z]{16}")),
        ("GitHub token", re.compile(
            "github_" + "pat_[A-Za-z0-9_]{82}|gh" + "[pousr]_[A-Za-z0-9]{36}|"
            "gh" + "p_[A-Za-z0-9]{20}"
        )),
        ("npm token", re.compile("npm" + "_[A-Za-z0-9]{36}")),
        ("API key", re.compile("sk" + "-[A-Za-z0-9_-]{20,}")),
        ("Slack token", re.compile("xox" + "[baprs]-")),
        ("private key", re.compile(
            "-----" + "BEGIN (?:[A-Z0-9-]+ )*PRIVATE KEY-----|"
            "BEGIN " + "(?:RSA|OPENSSH) PRIVATE KEY|"
            "-----" + "BEGIN (?:[^\\r\\n]* )?PRIVATE KEY-----"
        )),
        ("email", re.compile(r"[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})")),
    ]


# IPv4 and IPv6 use independent scanners, so a malformed IPv6 candidate can
# never consume (and hide) an IPv4 address inside it.
# Each ASCII quad is considered, even after a dot or overlapping another quad.
# The bounded lookahead consumes nothing; each position costs bounded work.
IPV4_CANDIDATES = re.compile(r"(?<![0-9])(?=((?:[0-9]{1,3}[.]){3}[0-9]{1,3})(?![0-9]))")
IPV6_RUNS = re.compile(r"[0-9A-Fa-f:]*:[0-9A-Fa-f:]*:[0-9A-Fa-f:]*(?:[.]\d{1,3}){0,3}")
IPV6_PREFIX = re.compile(r"[0-9A-Fa-f:]+")
MAX_IPV6_RUN = 128


class Span:
    """Match-like object (start/end/group) for computed address spans."""

    def __init__(self, text, start, end):
        self._text, self._start, self._end = text, start, end

    def start(self):
        return self._start

    def end(self):
        return self._end

    def group(self, index=0):
        return self._text[self._start:self._end]


def is_private(address):
    # IPv4-mapped IPv6 (::ffff:a.b.c.d or hex form) carries an IPv4 address.
    candidates = [address]
    if address.version == 6 and address.ipv4_mapped is not None:
        candidates.append(address.ipv4_mapped)
    return any(c in network for c in candidates for network in PRIVATE_NETWORKS)


def ipv6_spans(run):
    """Private IPv6 spans in one colon/hex run.

    The longest address claims its text and is judged whole, so a public
    address's private-looking tail is never flagged. Text that does not parse
    is searched for an address inside it, so labels like `peer:` cannot hide one.
    """
    colons = [i for i, ch in enumerate(run) if ch == ":"]
    bounds = set(colons) | {i + 1 for i in colons}
    parsed = []
    for start in sorted(bounds | {0}):
        for end in sorted(bounds | {len(run)}, reverse=True):
            if end - start < 2 or ":" not in run[start:end]:
                continue
            try:
                parsed.append((end - start, start, end, ipaddress.IPv6Address(run[start:end])))
            except ValueError:
                continue
            break
    claimed = []
    for _, start, end, address in sorted(parsed, key=lambda item: (-item[0], item[1])):
        if any(start < e and end > s for s, e in claimed):
            continue
        claimed.append((start, end))
        if is_private(address):
            yield start, end


def private_ip_matches(text):
    # Decimal is always tried. A second, C reading uses octal only for padded
    # groups; an invalid reading never suppresses the other valid reading.
    for match in IPV4_CANDIDATES.finditer(text):
        groups = match.group(1).split(".")
        readings = [[int(group, 10) for group in groups]]
        if any(len(group) > 1 and group.startswith("0") for group in groups):
            try:
                readings.append([int(group, 8 if len(group) > 1 and group.startswith("0") else 10)
                                 for group in groups])
            except ValueError:
                pass
        for reading in readings:
            if all(value <= 255 for value in reading) and is_private(
                    ipaddress.IPv4Address(bytes(reading))):
                yield Span(text, match.start(1), match.end(1))
                break
    for match in candidate_matches(text, IPV6_RUNS, IPV6_PREFIX):
        run = match.group()
        # Oversized address-like runs fail closed instead of being truncated.
        if len(run) > MAX_IPV6_RUN:
            yield Span(text, match.start(), match.end())
            continue
        views = [(0, run)]
        # A run that starts mid-word (`node:` or `iface:` then a ULA or link-local) begins
        # with the tail of a label: also judge it with that tail removed.
        if match.start() > 0 and (text[match.start() - 1].isalnum() or text[match.start() - 1] == "_"):
            cut = run.find(":")
            if cut >= 0:
                views.append((cut + 1, run[cut + 1:]))
        for offset, view in views:
            for start, end in ipv6_spans(view):
                yield Span(text, match.start() + offset + start, match.start() + offset + end)


class PolicyError(ValueError):
    """Message contains fixed reasons, numeric positions and safe locations only."""


def show_paths():
    return os.environ.get("PUBLIC_EXPORT_SHOW_PATHS") == "1"


def path_label(relative):
    if show_paths():
        return os.fsdecode(relative)
    return "path-sha256:" + hashlib.sha256(os.fsencode(relative)).hexdigest()[:12]


def safe_error(error):
    if show_paths():
        return str(error)
    if isinstance(error, OSError):
        where = path_label(error.filename) if error.filename else "unknown path"
        return f"{type(error).__name__} (errno {error.errno}) at {where}"
    member = getattr(getattr(error, "tarinfo", None), "name", None)
    if member is not None:
        return f"archive member rejected ({type(error).__name__}) at {path_label(member)}"
    return "operation failed (details withheld; set PUBLIC_EXPORT_SHOW_PATHS=1 locally)"


def read_regular(path, limit=None):
    limit = MAX_BYTES if limit is None else limit
    # Nonblocking + fstat refuses FIFOs and a file swapped to a special entry.
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
        with os.fdopen(fd, "rb") as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                raise PolicyError(f"{path_label(path.name)}: not a regular file")
            data = stream.read(limit + 1)
    except OSError:
        raise PolicyError(f"{path_label(path.name)}: read error") from None
    if len(data) > limit:
        raise PolicyError(f"{path_label(path.name)}: file exceeds scan limit")
    return data


def is_text(data):
    try:
        data.decode("utf-8")
    except UnicodeDecodeError:
        return False
    return b"\0" not in data


def valid_path(value):
    return (isinstance(value, str) and bool(value) and not value.startswith("/")
            and "\\" not in value and all(32 <= ord(c) < 127 for c in value)
            and all(part not in {"", ".", ".."} for part in value.split("/")))


def valid_archive_path(value):
    """Accept UTF-8 relative member names, preserving their spelling.

    Refuse empty/dot/parent segments, backslashes and Unicode Cc characters.
    Format characters are permitted. Policy paths still use valid_path.
    """
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return (bool(value) and "\\" not in value
            and not any(unicodedata.category(c) == "Cc" for c in value)
            and all(part not in {"", ".", ".."} for part in value.split("/")))


def safe_archive_link(name, entries):
    """Resolve in the selected archive, not the not-yet-extracted filesystem.

    Follow relative links component by component, counting the initial link
    among the 40 allowed hops. Dot/parent steps require a directory. Missing
    (including excluded) entries, absolute targets and root escapes refuse.
    The root itself is a valid result. No path bytes or archive state change.
    """
    pending = name.split("/")[::-1]
    resolved = []
    hops = 0
    while pending:
        part = pending.pop()
        if part in {"", "."}:
            continue
        if part == "..":
            if not resolved:
                return False
            resolved.pop()
            continue
        member = entries.get("/".join(resolved + [part]))
        if member is None:
            return False
        if member.issym():
            hops += 1
            if hops > 40 or not member.linkname or member.linkname.startswith("/"):
                return False
            pending.extend(member.linkname.split("/")[::-1])
        else:
            if pending and not member.isdir():
                return False
            resolved.append(part)
    return True


def export_filter(member, destination):
    # Links have already passed archive-graph resolution. data_filter on newer
    # Python versions normpaths link text, changing kernel semantics of link/..
    # and losing byte fidelity. Keep its member/permission checks, not that rewrite.
    filtered = tarfile.data_filter(member.replace(linkname=".") if member.issym() else member,
                                   destination)
    return filtered.replace(linkname=member.linkname) if member.issym() else filtered


def valid_domain(value):
    return (isinstance(value, str) and re.fullmatch(
        r"[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:[.][A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+", value) is not None)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate key")
        result[key] = value
    return result


def policy_records(directory, name):
    path = Path(directory) / name
    if not os.path.lexists(path):
        return []
    try:
        text = read_regular(path).decode("utf-8")
        records = []
        seen = set()
        for number, line in enumerate(text.split("\n"), 1):
            if not line:
                continue
            record = json.loads(line, object_pairs_hook=unique_object)
            if not isinstance(record, dict):
                raise ValueError("object required")
            key = json.dumps(record, sort_keys=True)
            if key in seen:
                raise PolicyError(f"duplicate policy entry at line {number}")
            seen.add(key)
            records.append(record)
        return records
    except (ValueError, UnicodeError) as error:
        if isinstance(error, PolicyError):
            raise
        raise PolicyError("invalid policy input") from None


class RepoPolicy:
    def __init__(self, root, policy_root=None):
        directory = root if policy_root is None else policy_root
        self.reviewed = policy_records(directory, TEXT_POLICY)
        self.emails = policy_records(directory, EMAIL_POLICY)
        self.used_text = set()
        self.used_email = set()
        labels = {label for label, _ in rules()} | {"private IP"}
        identities = set()
        for record in self.reviewed:
            if (set(record) != {"sha256", "path", "rule"}
                    or not valid_path(record["path"])
                    or not isinstance(record["rule"], str)
                    or record["rule"] not in labels
                    or not isinstance(record["sha256"], str)
                    or not re.fullmatch(r"[0-9a-f]{64}", record["sha256"])):
                raise PolicyError("invalid policy reviewed-text entry")
            identity = (record["path"], record["rule"])
            if identity in identities:
                raise PolicyError("duplicate policy reviewed-text entry")
            identities.add(identity)
        identities = set()
        for record in self.emails:
            if not valid_domain(record.get("domain")):
                raise PolicyError("invalid policy email domain")
            if set(record) == {"domain"}:
                identity = (record["domain"].lower(),)
            elif set(record) == {"local", "domain", "prefix", "suffix", "exclude"}:
                local = record["local"]
                prefix, suffix = record["prefix"], record["suffix"]
                if (not isinstance(local, str) or not re.fullmatch(r"[A-Za-z0-9._%+-]+", local)
                        or not isinstance(prefix, str) or not prefix.endswith("/")
                        or not valid_path(prefix[:-1])
                        or not isinstance(suffix, str) or not suffix.startswith(".")
                        or not re.fullmatch(r"[.][A-Za-z0-9]+", suffix)
                        or record["exclude"] != "!"):
                    raise PolicyError("invalid policy email scope")
                identity = (local, record["domain"], prefix, suffix, "!")
            else:
                raise PolicyError("invalid policy email entry")
            if identity in identities:
                raise PolicyError("duplicate policy email entry")
            identities.add(identity)

    def email_allowed(self, name, email):
        local, domain = email.rsplit("@", 1)
        if domain.lower() in DOC_DOMAINS:
            return True
        allowed = False
        for index, record in enumerate(self.emails):
            match = (domain.lower() == record["domain"].lower() if set(record) == {"domain"}
                     else (local == record["local"] and domain == record["domain"]
                           and name.startswith(record["prefix"]) and name.endswith(record["suffix"])
                           and "!" not in name))
            if match:
                self.used_email.add(index)
                allowed = True
        return allowed

    def text_allowed(self, name, data, label):
        allowed = False
        for index, record in enumerate(self.reviewed):
            if (record["path"] == name and record["rule"] == label
                    and hashlib.sha256(data).hexdigest() == record["sha256"]):
                self.used_text.add(index)
                allowed = True
        return allowed

    def finish(self):
        if len(self.used_text) != len(self.reviewed):
            raise PolicyError("unused reviewed-text policy entry (path, bytes or rule did not match)")
        if len(self.used_email) != len(self.emails):
            raise PolicyError("unused email policy entry")


def email_allowed(name, email):
    return email.rsplit("@", 1)[1].lower() in DOC_DOMAINS


EMAIL_RUN = re.compile(r"[A-Za-z0-9._%+-]+")
HOST_RUN = re.compile(r"[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*")


def candidate_matches(text, regex, runs):
    """Try once per maximal prefix run, resuming at each successful match end.

    A failed email, hostname or IPv6 prefix cannot succeed at an interior
    position. Skipping that run avoids retrying every suffix. Resuming after
    success preserves finditer's non-overlap semantics, even within a run.
    """
    position = 0
    while candidate := runs.search(text, position):
        match = regex.match(text, candidate.start())
        if match is not None:
            yield match
            position = match.end()
        else:
            position = candidate.end()


def email_matches(text, regex):
    """Keep legacy trigger eligibility; judge the entire ASCII mailbox candidate.

    Extend through RFC dot-atom local characters and domain letters/digits/dots/
    hyphens. A terminal prose dot stays outside the candidate. Never normalize
    the local part or grant an exemption to a substring of this span.
    """
    local_chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.!#$%&'*+/=?^_`{|}~-"
    domain_chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.-"
    for match in candidate_matches(text, regex, EMAIL_RUN):
        start, end = match.start(), match.end()
        while start and text[start - 1] in local_chars:
            start -= 1
        while end < len(text) and text[end] in domain_chars:
            end += 1
        while text[end - 1] == ".":
            end -= 1
        yield Span(text, start, end)


def forbidden_matches(text, checks):
    found = [(kind, match) for kind, regex in checks
             for match in (email_matches(text, regex) if kind == "email" else
                           candidate_matches(text, regex, HOST_RUN) if kind == "tailnet hostname" else
                           regex.finditer(text))
             if kind != "email" or not email_allowed("", match.group())]
    return found + [("private IP", match) for match in private_ip_matches(text)]


def scan_text(name, data, findings, policy=None, content=False):
    # Latin-1 maps every byte, including a token after invalid UTF-8.
    for kind, match in forbidden_matches(data.decode("latin-1"), rules()):
        if kind == "email" and policy is not None and policy.email_allowed(name, match.group()):
            continue
        if content and policy is not None and policy.text_allowed(name, data, kind):
            continue
        findings.append(f"{path_label(name)}: forbidden {kind}")


def scan_data(name, data, findings):
    if len(data) > MAX_BYTES:
        raise PolicyError(f"{path_label(name)}: file exceeds scan limit")
    if not is_text(data):
        raise PolicyError(f"{path_label(name)}: binary or non-UTF-8 file not allowed")
    scan_text(name, data, findings)


def binary_allowlist(root):
    path = Path(root) / ".public-export-binaries"
    entries = {}
    if os.path.lexists(path):
        for line in read_regular(path).decode("utf-8").splitlines():
            if line.strip() and not line.startswith("#"):
                digest, name = line.split(None, 1)
                entries[name.strip()] = digest
    def check(relative, data):
        if relative not in entries:
            return None
        return entries[relative] == hashlib.sha256(data).hexdigest()
    return check


def check_tree(target, policy_root=None):
    root = Path(target)
    if root.is_symlink() or not root.is_dir():
        raise PolicyError("check target must be a non-symlink directory")
    root = root.resolve()
    policy = RepoPolicy(root, policy_root)
    binary_ok = binary_allowlist(root)
    findings = []
    count = 0
    def traversal_error(error):
        raise PolicyError(f"{path_label(error.filename or '')}: traversal error")
    for directory, dirs, files in os.walk(root, followlinks=False, onerror=traversal_error):
        for basename in sorted(dirs + files):
            path = Path(directory) / basename
            name = path.relative_to(root).as_posix()
            location = path_label(name)
            scan_text(name, os.fsencode(name), findings, policy)
            try:
                mode = path.lstat().st_mode
                if stat.S_ISLNK(mode):
                    data = os.fsencode(os.readlink(path))
                    scan_text(name, data, findings, policy)
                    try:
                        safe = path.resolve(strict=True).is_relative_to(root)
                        os.stat(path)
                    except (OSError, RuntimeError):
                        safe = False
                    if not safe:
                        findings.append(f"{location}: unsafe or dangling symlink")
                elif stat.S_ISREG(mode):
                    data = read_regular(path)
                    pinned = binary_ok(name, data)
                    if pinned is False:
                        findings.append(f"{location}: pinned file bytes changed")
                    elif pinned is None and not is_text(data):
                        findings.append(f"{location}: binary or non-UTF-8 file not allowed")
                    scan_text(name, data, findings, policy, content=is_text(data))
                    count += 1
                elif not stat.S_ISDIR(mode):
                    findings.append(f"{location}: not a regular file")
            except (OSError, RuntimeError):
                findings.append(f"{location}: read error")
    if not count:
        raise PolicyError("check target contains no files")
    policy.finish()
    if findings:
        raise PolicyError("public export check FAILED (locations only):\n" + "\n".join(sorted(set(findings))))
    return count


def excluded(name, patterns):
    parts = PurePosixPath(name).parts
    ancestors = ["/".join(parts[:i]) for i in range(1, len(parts) + 1)]
    return any(fnmatch.fnmatchcase(path, pattern) for path in ancestors for pattern in patterns)


def parse_excludes(text):
    result = []
    for number, line in enumerate(text.splitlines(), 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith(("/", "!")) or ".." in PurePosixPath(line).parts or "\\" in line:
            raise PolicyError(f"invalid exclude at line {number}: use root-relative paths/globs")
        result.append(line.rstrip("/"))
    return result


def run_git(args, cwd=None, isolated=False):
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    if isolated:
        env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull,
                   GIT_ATTR_NOSYSTEM="1", GIT_CONFIG_COUNT="1",
                   GIT_CONFIG_KEY_0="core.attributesFile", GIT_CONFIG_VALUE_0=os.devnull)
    result = subprocess.run(["git", *args], cwd=cwd, capture_output=True, check=False, env=env)
    if result.stderr:
        if show_paths():
            sys.stderr.write(os.fsdecode(result.stderr))
        else:
            print("public-export: git wrote diagnostics (withheld)", file=sys.stderr)
    if result.returncode:
        raise PolicyError(f"git operation failed (exit {result.returncode})")
    return result.stdout


def head_archive(root):
    """Use committed attributes and source storage format, never caller defaults."""
    object_format = run_git(["rev-parse", "--show-object-format"], cwd=root).strip().decode("ascii")
    revision = run_git(["rev-parse", "--verify", "HEAD^{commit}"], cwd=root).strip().decode("ascii")
    objects = run_git(["rev-parse", "--path-format=absolute", "--git-path", "objects"], cwd=root).removesuffix(b"\n")
    # Git's alternates file accepts C-quoted paths. Escape raw bytes, not text.
    quoted = b'"' + b"".join(bytes([c]) if 32 <= c < 127 and c not in (34, 92)
                            else f"\\{c:03o}".encode() for c in objects) + b'"\n'
    with tempfile.TemporaryDirectory() as directory:
        repo = Path(directory) / "archive.git"
        run_git(["init", "--quiet", "--bare", "--template=", "--object-format=" + object_format, str(repo)], isolated=True)
        (repo / "objects/info/alternates").write_bytes(quoted)
        return run_git(["archive", "--format=tar", revision], cwd=repo, isolated=True)


def export_tree(target, source=None, policy_root=None):
    cwd = Path(__file__).parent if source is None else Path(source)
    root = Path(os.fsdecode(run_git(["rev-parse", "--show-toplevel"], cwd=cwd)).rstrip("\n")).resolve()
    out = Path(target).absolute()
    resolved = out.resolve()
    common = Path(os.fsdecode(run_git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd=root)).rstrip("\n")).resolve()
    if any(resolved == p or p in resolved.parents or resolved in p.parents for p in (root, common)):
        raise PolicyError("output must be outside source, Git state and their ancestors")
    if out.is_symlink() or (out.exists() and (not out.is_dir() or any(out.iterdir()))):
        raise PolicyError("output must be a new or empty non-symlink directory")
    archive = head_archive(root)
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as tree:
        policy = tree.extractfile(".public-export-exclude")
        if policy is None:
            raise PolicyError("HEAD has no export policy")
        patterns = parse_excludes(policy.read().decode("utf-8"))
        members = [member for member in tree.getmembers() if not excluded(member.name, patterns)]
        entries = {member.name.rstrip("/"): member for member in members}
        for member in members:
            if not valid_archive_path(member.name.rstrip("/")):
                raise PolicyError(f"{path_label(member.name)}: unsafe archive path")
            if member.issym():
                if not safe_archive_link(member.name, entries):
                    raise PolicyError(f"{path_label(member.name)}: unsafe or dangling exported symlink")
            elif not (member.isfile() or member.isdir()):
                raise PolicyError(f"{path_label(member.name)}: unsupported archive member")
        out.parent.mkdir(parents=True, exist_ok=True)
        if out.exists():
            mode = stat.S_IMODE(out.stat().st_mode)
        else:
            mask = os.umask(0)
            os.umask(mask)
            mode = 0o777 & ~mask
        staged = Path(tempfile.mkdtemp(prefix=".public-export-", dir=out.parent))
        try:
            tree.extractall(staged, members=members, filter=export_filter)
            check_tree(staged, policy_root)
            staged.chmod(mode)
            staged.rename(out)
        except BaseException as error:
            try:
                staged.chmod(stat.S_IMODE(staged.stat().st_mode) | stat.S_IRWXU)
                shutil.rmtree(staged)
            except BaseException as cleanup_error:
                error.add_note(f"staging cleanup failed: {safe_error(cleanup_error)}")
                raise error from cleanup_error
            raise
    print(f"public-export: exported HEAD ({len(members)} archive entries) to {path_label(os.fsencode(out))}")


def gitleaks_scan(target):
    binary = shutil.which("gitleaks")
    if binary is None:
        raise PolicyError("gitleaks is required on PATH; refusing to pass without it")
    root = Path(target).resolve()
    with tempfile.TemporaryDirectory() as temp:
        config = Path(temp) / "gitleaks.toml"
        config.write_text("[extend]\nuseDefault = true\n")
        ignore = Path(temp) / ".gitleaksignore"
        ignore.write_text("")
        report = Path(temp) / "report.json"
        env = {k: v for k, v in os.environ.items() if not k.startswith("GITLEAKS_")}
        result = subprocess.run(
            [binary, "dir", str(root), "--config", str(config), "--gitleaks-ignore-path", str(ignore),
             "--ignore-gitleaks-allow", "--redact", "--no-banner", "--exit-code", "3",
             "--report-format", "json", "--report-path", str(report)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False, env=env)
        if result.returncode not in (0, 3):
            raise PolicyError(f"gitleaks failed to run (exit {result.returncode})")
        try:
            leaks = json.loads(report.read_bytes())
            if not isinstance(leaks, list) or any(not isinstance(leak, dict) or not isinstance(leak.get("File"), str) for leak in leaks):
                raise ValueError("invalid report")
        except (OSError, ValueError):
            raise PolicyError("gitleaks report unreadable or invalid") from None
    if result.returncode == 3 or leaks:
        # RuleID is untrusted output too; do not reproduce it.
        lines = {f"{path_label(leak['File'])}: gitleaks finding" for leak in leaks}
        raise PolicyError("gitleaks findings (locations only):\n" + "\n".join(sorted(lines) or ["(unlisted)"]))


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    try:
        if len(argv) < 2 or argv[0] not in {"export", "check"}:
            raise PolicyError("usage: public_export.py {export|check} TARGET [--source REPO] [--policy-dir DIR]")
        options = {}
        for index in range(2, len(argv), 2):
            if argv[index] not in {"--source", "--policy-dir"} or index + 1 == len(argv) or argv[index] in options:
                raise PolicyError("invalid command arguments")
            options[argv[index]] = argv[index + 1]
        if argv[0] == "export":
            export_tree(argv[1], options.get("--source"), options.get("--policy-dir"))
        else:
            if "--source" in options:
                raise PolicyError("source is valid only for export")
            count = check_tree(argv[1], options.get("--policy-dir"))
            gitleaks_scan(argv[1])
            print(f"public-export-check: PASS ({count} files; gitleaks clean)")
        return 0
    except PolicyError as error:
        print(f"public-export: {error}", file=sys.stderr)
        return 1
    except Exception as error:  # noqa: BLE001 - every library error is a path sink
        print(f"public-export: {safe_error(error)}", file=sys.stderr)
        return 1

if __name__ == "__main__":
    sys.exit(main())
