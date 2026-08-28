// src/cli/main.ts
import { basename as basename11, join as join10, resolve as resolve10 } from "node:path";
import { tmpdir as tmpdir2 } from "node:os";

// src/cli/args.ts
var SHORT_VALUE_FLAGS = /* @__PURE__ */ new Set(["o", "r", "l", "s"]);
var BOOL_FLAGS = /* @__PURE__ */ new Set([
  "json",
  "open",
  "help",
  "version",
  "no-redact",
  "redact",
  "include-text",
  "no-include-text",
  "strip-paths",
  "quiet",
  "watch",
  "global",
  "all",
  "no-open",
  "stdout",
  "md",
  "markdown",
  "fail-on-hook-errors",
  "follow",
  "slim",
  "list",
  "allow-claude",
  "estimate",
  "for-proposal",
  "for-apply",
  "verbose",
  "no-color",
  "plain"
]);
var KNOWN_FLAGS = /* @__PURE__ */ new Set([
  ...BOOL_FLAGS,
  ...SHORT_VALUE_FLAGS,
  "out",
  "root",
  "config",
  "cwd",
  "limit",
  "no-cache",
  "jobs",
  "j",
  "max-tokens",
  "max-cost",
  "port",
  "p",
  "max-live",
  "context",
  "depth",
  "scope",
  "session",
  "s",
  "rule",
  "insight",
  "title",
  "finding",
  "suggestion",
  "receipt",
  "show",
  "set",
  "proposal",
  "manifest",
  "application",
  "verification",
  "cohort"
]);
function unknownFlags(flags) {
  return Object.keys(flags).filter((k) => !KNOWN_FLAGS.has(k)).map((k) => (k.length === 1 ? "-" : "--") + k);
}
function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  let command;
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const body = a.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else if (BOOL_FLAGS.has(body)) {
        flags[body] = true;
      } else {
        const next = argv[i + 1];
        if (next !== void 0 && !next.startsWith("-")) {
          flags[body] = next;
          i++;
        } else {
          flags[body] = true;
        }
      }
    } else if (a.startsWith("-") && a.length > 1) {
      const ch = a.slice(1);
      if (ch.length === 1 && SHORT_VALUE_FLAGS.has(ch)) {
        const next = argv[i + 1];
        if (next !== void 0 && !next.startsWith("-")) {
          flags[ch] = next;
          i++;
        } else {
          flags[ch] = true;
        }
      } else {
        for (const c of ch) flags[c] = true;
      }
    } else if (!command && !a.startsWith("-")) {
      command = a;
    } else {
      positionals.push(a);
    }
  }
  return { command, positionals, flags };
}
function flagStr(flags, ...names) {
  for (const n2 of names) {
    const v = flags[n2];
    if (typeof v === "string") return v;
  }
  return void 0;
}
function flagBool(flags, ...names) {
  return names.some((n2) => flags[n2] === true || flags[n2] === "true");
}

// src/discover/discover.ts
import { lstat as lstat2, open as open3, opendir as opendir2, realpath as realpath2 } from "node:fs/promises";
import { constants as constants3, existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename as basename2, dirname as dirname2, isAbsolute as isAbsolute2, join as join2, relative as relative2, resolve as resolve2, sep as sep2 } from "node:path";

// src/adapters/claude-code/evidence-input.ts
import { constants as constants2 } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open as open2, opendir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

// src/adapters/claude-code/jsonl.ts
import { constants, createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
var DEFAULT_MAX_JSONL_BYTES = 256 * 1024 * 1024;
var DEFAULT_MAX_JSONL_LINE_BYTES = 8 * 1024 * 1024;
var DEFAULT_MAX_JSONL_RECORDS = 1e5;
function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function tryParseObject(line) {
  const t = line.charCodeAt(0);
  if (t !== 123) return null;
  try {
    const v = JSON.parse(line);
    return isPlainObject(v) ? v : null;
  } catch {
    return null;
  }
}
function emptyJsonlResult(fromByte, fileSize) {
  return {
    records: [],
    lineNumbers: [],
    totalLines: 0,
    badLines: 0,
    trailingPartial: false,
    maxLineBytes: 0,
    bytesRead: 0,
    nextByte: fromByte,
    fileSize,
    physicalBytesRead: 0
  };
}
async function parseJsonlChunks(chunks, fromByte, fileSize, maxBytes, maxRecordBytes = DEFAULT_MAX_JSONL_LINE_BYTES, maxRecords = DEFAULT_MAX_JSONL_RECORDS) {
  const records = [];
  const lineNumbers = [];
  let totalLines = 0;
  let badLines = 0;
  let maxLineBytes = 0;
  let trailingPartial = false;
  let lineNo = 0;
  let carry = [];
  let carryLen = 0;
  const handleLine = (buf, terminated) => {
    lineNo++;
    if (buf.length > maxRecordBytes) throw new Error(`JSONL line exceeds ${maxRecordBytes} bytes`);
    let s = buf.toString("utf8");
    if (s.endsWith("\r")) s = s.slice(0, -1);
    if (s.length === 0) return;
    totalLines++;
    if (totalLines > maxRecords) throw new Error(`JSONL input exceeds ${maxRecords} records`);
    if (buf.length > maxLineBytes) maxLineBytes = buf.length;
    const parsed = tryParseObject(s);
    if (parsed) {
      records.push(parsed);
      lineNumbers.push(lineNo);
    } else {
      badLines++;
      if (!terminated) trailingPartial = true;
    }
  };
  if (fromByte >= fileSize) {
    return { records, lineNumbers, totalLines, badLines, trailingPartial, maxLineBytes, bytesRead: 0, nextByte: fromByte, fileSize, physicalBytesRead: 0 };
  }
  let streamed = 0;
  for await (const chunk of chunks) {
    streamed += chunk.length;
    if (maxBytes !== void 0 && streamed > maxBytes) throw new Error(`JSONL input exceeds ${maxBytes} bytes`);
    let start = 0;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] === 10) {
        const piece = chunk.subarray(start, i);
        if (carryLen + piece.length > maxRecordBytes) throw new Error(`JSONL line exceeds ${maxRecordBytes} bytes`);
        const line = carryLen ? Buffer.concat([...carry, piece], carryLen + piece.length) : piece;
        carry = [];
        carryLen = 0;
        handleLine(line, true);
        start = i + 1;
      }
    }
    if (start < chunk.length) {
      const rest = chunk.subarray(start);
      if (carryLen + rest.length > maxRecordBytes) throw new Error(`JSONL line exceeds ${maxRecordBytes} bytes`);
      carry.push(Buffer.from(rest));
      carryLen += rest.length;
    }
  }
  const bytesRead = streamed - carryLen;
  if (carryLen > 0) {
    const line = Buffer.concat(carry, carryLen);
    const before = records.length;
    handleLine(line, false);
    if (records.length > before) {
      return { records, lineNumbers, totalLines, badLines, trailingPartial, maxLineBytes, bytesRead: streamed, nextByte: fromByte + streamed, fileSize, physicalBytesRead: streamed };
    }
  }
  return { records, lineNumbers, totalLines, badLines, trailingPartial, maxLineBytes, bytesRead, nextByte: fromByte + bytesRead, fileSize, physicalBytesRead: streamed };
}
async function readJsonlFile(path, opts = {}) {
  const fromByte = opts.fromByte ?? 0;
  if (opts.noFollow) {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const st2 = await handle.stat({ bigint: true });
      if (!st2.isFile()) throw new Error(`JSONL input must be a regular file: ${path}`);
      if (st2.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`JSONL input is too large to address safely: ${path}`);
      const fileSize2 = Number(st2.size);
      if (opts.maxFileBytes !== void 0 && fileSize2 > opts.maxFileBytes) {
        throw new Error(`JSONL input exceeds the ${opts.maxFileBytes}-byte file budget`);
      }
      const value = await readJsonlHandle(handle, { ...opts, fileSize: fileSize2 });
      const { physicalBytesRead: _physicalBytesRead2, ...result2 } = value;
      return { ...result2, fileIdentity: { device: String(st2.dev), inode: String(st2.ino) } };
    } finally {
      await handle.close();
    }
  }
  const st = await stat(path, { bigint: true });
  if (st.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`JSONL input is too large to address safely: ${path}`);
  const fileSize = Number(st.size);
  if (opts.maxFileBytes !== void 0 && fileSize > opts.maxFileBytes) {
    throw new Error(`JSONL input exceeds the ${opts.maxFileBytes}-byte file budget`);
  }
  const fileIdentity = { device: String(st.dev), inode: String(st.ino) };
  if (fromByte >= fileSize) {
    const { physicalBytesRead: _physicalBytesRead2, ...result2 } = emptyJsonlResult(fromByte, fileSize);
    return { ...result2, fileIdentity };
  }
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_JSONL_BYTES;
  if (fileSize - fromByte > maxBytes) throw new Error(`JSONL input exceeds ${maxBytes} bytes`);
  const stream = createReadStream(path, { start: fromByte, highWaterMark: 1 << 20 });
  const { physicalBytesRead: _physicalBytesRead, ...result } = await parseJsonlChunks(
    stream,
    fromByte,
    fileSize,
    maxBytes,
    opts.maxLineBytes,
    opts.maxRecords
  );
  return { ...result, fileIdentity };
}
async function readJsonlHandle(handle, opts) {
  const fromByte = opts.fromByte ?? 0;
  if (fromByte >= opts.fileSize) return emptyJsonlResult(fromByte, opts.fileSize);
  const end = opts.fileSize > fromByte ? opts.fileSize - 1 : fromByte;
  const stream = handle.createReadStream({ start: fromByte, end, highWaterMark: 1 << 20, autoClose: false });
  return parseJsonlChunks(
    stream,
    fromByte,
    opts.fileSize,
    opts.maxBytes ?? DEFAULT_MAX_JSONL_BYTES,
    opts.maxLineBytes,
    opts.maxRecords
  );
}

// src/adapters/claude-code/evidence-input.ts
var MAX_EVIDENCE_SESSION_BYTES = 64 * 1024 * 1024;
var MAX_LOCAL_SESSION_BYTES = DEFAULT_MAX_JSONL_BYTES;
var MAX_EVIDENCE_META_BYTES = 1 * 1024 * 1024;
var MAX_EVIDENCE_SESSION_RECORDS = DEFAULT_MAX_JSONL_RECORDS;
var MAX_EVIDENCE_SIDECAR_ENTRIES = 2048;
var MAX_EVIDENCE_SIDECAR_DEPTH = 4;
function snapshotOf(stat8) {
  return {
    dev: stat8.dev,
    ino: stat8.ino,
    mode: stat8.mode,
    size: stat8.size,
    mtimeNs: stat8.mtimeNs,
    ctimeNs: stat8.ctimeNs
  };
}
function sameSnapshot(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function isMissing(error) {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
function isWithin(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}
async function prevalidateRegularFile(path, root) {
  const requestedPath = resolve(path);
  const requestedStat = await lstat(requestedPath, { bigint: true });
  if (requestedStat.isSymbolicLink()) throw new Error(`session input must not include symbolic links: ${requestedPath}`);
  if (!requestedStat.isFile()) throw new Error(`session input must contain only regular files: ${requestedPath}`);
  const canonicalPath = await realpath(requestedPath);
  if (root && !isWithin(root, canonicalPath)) throw new Error(`session sidecar escapes its canonical root: ${requestedPath}`);
  const canonicalStat = await lstat(canonicalPath, { bigint: true });
  const snapshot2 = snapshotOf(requestedStat);
  if (canonicalStat.isSymbolicLink() || !canonicalStat.isFile() || !sameSnapshot(snapshot2, snapshotOf(canonicalStat))) {
    throw new Error(`session input changed during prevalidation: ${requestedPath}`);
  }
  return { requestedPath, canonicalPath, snapshot: snapshot2 };
}
async function prevalidateDirectory(path, root) {
  const requestedPath = resolve(path);
  const requestedStat = await lstat(requestedPath, { bigint: true });
  if (requestedStat.isSymbolicLink()) throw new Error(`session input must not include symbolic links: ${requestedPath}`);
  if (!requestedStat.isDirectory()) throw new Error(`session sidecar path must be a directory: ${requestedPath}`);
  const canonicalPath = await realpath(requestedPath);
  if (root && !isWithin(root, canonicalPath)) throw new Error(`session sidecar escapes its canonical root: ${requestedPath}`);
  const canonicalStat = await lstat(canonicalPath, { bigint: true });
  const snapshot2 = snapshotOf(requestedStat);
  if (!canonicalStat.isDirectory() || !sameSnapshot(snapshot2, snapshotOf(canonicalStat))) {
    throw new Error(`session sidecar directory changed during prevalidation: ${requestedPath}`);
  }
  return { requestedPath, canonicalPath, snapshot: snapshot2 };
}
async function assertDirectoryStillMatches(directory) {
  let requestedStat;
  let canonicalNow;
  try {
    requestedStat = await lstat(directory.requestedPath, { bigint: true });
    canonicalNow = await realpath(directory.requestedPath);
  } catch {
    throw new Error(`session sidecar directory changed while it was being read: ${directory.requestedPath}`);
  }
  if (requestedStat.isSymbolicLink() || !requestedStat.isDirectory() || canonicalNow !== directory.canonicalPath || !sameSnapshot(directory.snapshot, snapshotOf(requestedStat))) {
    throw new Error(`session sidecar directory changed while it was being read: ${directory.requestedPath}`);
  }
}
async function discoverEvidenceSidecars(main2) {
  const sessionDir = join(dirname(main2.canonicalPath), basename(main2.canonicalPath, ".jsonl"));
  let sessionDirStat;
  try {
    sessionDirStat = await lstat(sessionDir, { bigint: true });
  } catch (error) {
    if (isMissing(error)) {
      const projectDirectory = await prevalidateDirectory(dirname(main2.canonicalPath));
      return { directories: [projectDirectory], absentPaths: [sessionDir], sidecars: [] };
    }
    throw error;
  }
  if (sessionDirStat.isSymbolicLink()) throw new Error(`session input must not include symbolic links: ${sessionDir}`);
  if (!sessionDirStat.isDirectory()) throw new Error(`session sidecar parent must be a directory: ${sessionDir}`);
  const canonicalSessionDir = await realpath(sessionDir);
  const canonicalSessionDirStat = await lstat(canonicalSessionDir, { bigint: true });
  if (!canonicalSessionDirStat.isDirectory() || !sameSnapshot(snapshotOf(sessionDirStat), snapshotOf(canonicalSessionDirStat))) {
    throw new Error(`session sidecar parent changed during prevalidation: ${sessionDir}`);
  }
  const directories = [{
    requestedPath: sessionDir,
    canonicalPath: canonicalSessionDir,
    snapshot: snapshotOf(canonicalSessionDirStat)
  }];
  const expectedRoot = join(canonicalSessionDir, "subagents");
  let rootStat;
  try {
    rootStat = await lstat(expectedRoot, { bigint: true });
  } catch (error) {
    if (isMissing(error)) return { directories, absentPaths: [expectedRoot], sidecars: [] };
    throw error;
  }
  if (rootStat.isSymbolicLink()) throw new Error(`session input must not include symbolic links: ${expectedRoot}`);
  if (!rootStat.isDirectory()) throw new Error(`session sidecar root must be a directory: ${expectedRoot}`);
  const root = await realpath(expectedRoot);
  if (!isWithin(canonicalSessionDir, root)) throw new Error(`session sidecar escapes its canonical parent: ${expectedRoot}`);
  const canonicalRootStat = await lstat(root, { bigint: true });
  if (!canonicalRootStat.isDirectory() || !sameSnapshot(snapshotOf(rootStat), snapshotOf(canonicalRootStat))) {
    throw new Error(`session sidecar root changed during prevalidation: ${expectedRoot}`);
  }
  const rootDirectory = {
    requestedPath: expectedRoot,
    canonicalPath: root,
    snapshot: snapshotOf(canonicalRootStat)
  };
  directories.push(rootDirectory);
  const sessionDirAfter = await lstat(canonicalSessionDir, { bigint: true });
  if (!sameSnapshot(snapshotOf(sessionDirStat), snapshotOf(sessionDirAfter))) {
    throw new Error(`session sidecar parent changed during prevalidation: ${sessionDir}`);
  }
  const transcriptFiles = [];
  let visitedEntries = 0;
  const walk2 = async (directory, depth) => {
    const canonicalDir = directory.canonicalPath;
    const entries = [];
    for await (const entry of await opendir(canonicalDir)) {
      visitedEntries++;
      if (visitedEntries > MAX_EVIDENCE_SIDECAR_ENTRIES) {
        throw new Error(`session sidecar manifest exceeds ${MAX_EVIDENCE_SIDECAR_ENTRIES} entries`);
      }
      entries.push(entry);
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(canonicalDir, entry.name);
      const stat8 = await lstat(path, { bigint: true });
      if (stat8.isSymbolicLink()) throw new Error(`session input must not include symbolic links: ${path}`);
      if (stat8.isDirectory()) {
        if (depth >= MAX_EVIDENCE_SIDECAR_DEPTH) {
          throw new Error(`session sidecar traversal exceeds ${MAX_EVIDENCE_SIDECAR_DEPTH} levels`);
        }
        const child = await prevalidateDirectory(path, root);
        directories.push(child);
        await walk2(child, depth + 1);
      } else if (entry.name.endsWith(".jsonl") && entry.name.startsWith("agent-")) {
        transcriptFiles.push(await prevalidateRegularFile(path, root));
      }
    }
    await assertDirectoryStillMatches(directory);
  };
  await walk2(rootDirectory, 0);
  const sidecars = [];
  for (const transcript of transcriptFiles.sort((a, b) => a.canonicalPath.localeCompare(b.canonicalPath))) {
    const agentIdHint = basename(transcript.canonicalPath, ".jsonl").replace(/^agent-/, "");
    const metaPath = transcript.canonicalPath.replace(/\.jsonl$/, ".meta.json");
    let meta;
    try {
      meta = await prevalidateRegularFile(metaPath, root);
      if (meta.snapshot.size > BigInt(MAX_EVIDENCE_META_BYTES)) {
        throw new Error(`session sidecar metadata exceeds ${MAX_EVIDENCE_META_BYTES} bytes: ${metaPath}`);
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    sidecars.push({ transcript, ...meta ? { meta } : {}, agentIdHint });
  }
  for (const directory of directories) await assertDirectoryStillMatches(directory);
  return { root, directories, absentPaths: [], sidecars };
}
function manifestFingerprint(main2, sidecars, directories, absentPaths) {
  const hash2 = createHash("sha256");
  const add = (role, file) => {
    const s = file.snapshot;
    hash2.update([role, file.canonicalPath, s.dev, s.ino, s.mode, s.size, s.mtimeNs, s.ctimeNs].join("\0"));
    hash2.update("\0");
  };
  add("main", main2);
  for (const directory of directories) {
    const s = directory.snapshot;
    hash2.update(["directory", directory.canonicalPath, s.dev, s.ino, s.mode, s.mtimeNs, s.ctimeNs].join("\0"));
    hash2.update("\0");
  }
  for (const path of absentPaths) hash2.update(`absent\0${path}\0`);
  for (const sidecar of sidecars) {
    add("sidecar", sidecar.transcript);
    if (sidecar.meta) add("meta", sidecar.meta);
  }
  return hash2.digest("hex");
}
async function prevalidateEvidenceSession(mainPath, options = {}) {
  const maxBytes = options.maxBytes ?? MAX_EVIDENCE_SESSION_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_LOCAL_SESSION_BYTES) {
    throw new Error(`session prevalidation budget must be an integer from 1-${MAX_LOCAL_SESSION_BYTES} bytes`);
  }
  let main2;
  try {
    main2 = await prevalidateRegularFile(mainPath);
  } catch (error) {
    if (isMissing(error)) throw new Error(`session JSONL not found: ${resolve(mainPath)}`);
    throw error;
  }
  const discovered = options.includeSidecars === false ? { directories: [], absentPaths: [], sidecars: [] } : await discoverEvidenceSidecars(main2);
  const files2 = [main2, ...discovered.sidecars.flatMap((sidecar) => [sidecar.transcript, ...sidecar.meta ? [sidecar.meta] : []])];
  let declaredBytes = 0n;
  for (const file of files2) {
    declaredBytes += file.snapshot.size;
    if (declaredBytes > BigInt(maxBytes)) throw new Error(`session input exceeds ${maxBytes} bytes`);
  }
  return {
    main: main2,
    ...discovered.root ? { sidecarRoot: discovered.root } : {},
    sidecarDirectories: discovered.directories,
    absentSidecarPaths: discovered.absentPaths,
    sidecars: discovered.sidecars,
    fingerprint: manifestFingerprint(main2, discovered.sidecars, discovered.directories, discovered.absentPaths),
    maxBytes
  };
}
function evidenceManifestSidecarFiles(manifest) {
  return manifest.sidecars.map((sidecar) => ({
    path: sidecar.transcript.canonicalPath,
    ...sidecar.meta ? { metaPath: sidecar.meta.canonicalPath } : {},
    agentIdHint: sidecar.agentIdHint
  }));
}
function evidenceManifestLatestChangeMs(manifest) {
  const entries = [
    manifest.main,
    ...manifest.sidecars.flatMap((sidecar) => [sidecar.transcript, ...sidecar.meta ? [sidecar.meta] : []]),
    ...manifest.sidecarDirectories
  ];
  let latestNs = -1n;
  for (const entry of entries) {
    const changedNs = entry.snapshot.mtimeNs > entry.snapshot.ctimeNs ? entry.snapshot.mtimeNs : entry.snapshot.ctimeNs;
    if (changedNs > latestNs) latestNs = changedNs;
  }
  if (latestNs < 0n) return void 0;
  const milliseconds = Number((latestNs + 999999n) / 1000000n);
  return Number.isSafeInteger(milliseconds) && milliseconds >= 0 ? milliseconds : void 0;
}
async function assertEvidenceSessionManifestStable(manifest) {
  await assertPathStillMatches(manifest.main);
  for (const sidecar of manifest.sidecars) {
    await assertPathStillMatches(sidecar.transcript);
    if (sidecar.meta) await assertPathStillMatches(sidecar.meta);
  }
  for (const directory of manifest.sidecarDirectories) await assertDirectoryStillMatches(directory);
  for (const path of manifest.absentSidecarPaths) {
    try {
      await lstat(path);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    throw new Error(`session sidecar tree changed while it was being read: ${path}`);
  }
}
async function assertPathStillMatches(file) {
  let requestedStat;
  let canonicalNow;
  try {
    requestedStat = await lstat(file.requestedPath, { bigint: true });
    canonicalNow = await realpath(file.requestedPath);
  } catch {
    throw new Error(`session input changed while it was being read: ${file.requestedPath}`);
  }
  if (requestedStat.isSymbolicLink() || canonicalNow !== file.canonicalPath || !sameSnapshot(file.snapshot, snapshotOf(requestedStat))) {
    throw new Error(`session input changed while it was being read: ${file.requestedPath}`);
  }
  const canonicalStat = await lstat(file.canonicalPath, { bigint: true });
  if (canonicalStat.isSymbolicLink() || !sameSnapshot(file.snapshot, snapshotOf(canonicalStat))) {
    throw new Error(`session input changed while it was being read: ${file.requestedPath}`);
  }
}
async function withStableFile(file, remainingBytes, read) {
  let handle;
  try {
    handle = await open2(file.canonicalPath, constants2.O_RDONLY | constants2.O_NOFOLLOW);
  } catch {
    throw new Error(`session input changed before it was read: ${file.requestedPath}`);
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || !sameSnapshot(file.snapshot, snapshotOf(before))) {
      throw new Error(`session input changed before it was read: ${file.requestedPath}`);
    }
    await assertPathStillMatches(file);
    if (before.size > BigInt(remainingBytes)) throw new Error(`session input exceeds the remaining ${remainingBytes}-byte read budget`);
    const size = Number(before.size);
    const result = await read(handle, size);
    if (result.bytesRead !== size) throw new Error(`session input changed while it was being read: ${file.requestedPath}`);
    const after = await handle.stat({ bigint: true });
    if (!sameSnapshot(snapshotOf(before), snapshotOf(after))) {
      throw new Error(`session input changed while it was being read: ${file.requestedPath}`);
    }
    await assertPathStillMatches(file);
    return result;
  } finally {
    await handle.close();
  }
}
function readStableJsonl(file, remainingBytes, remainingRecords) {
  return withStableFile(file, remainingBytes, async (handle, size) => {
    const value = await readJsonlHandle(handle, {
      fileSize: size,
      maxBytes: remainingBytes,
      maxLineBytes: DEFAULT_MAX_JSONL_LINE_BYTES,
      maxRecords: remainingRecords
    });
    return { value, bytesRead: value.physicalBytesRead };
  });
}
function readStableText(file, remainingBytes) {
  return withStableFile(file, remainingBytes, async (handle, size) => {
    const buffer = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const result = await handle.read(buffer, offset, size - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
      if (offset > remainingBytes) throw new Error(`session input exceeds the remaining ${remainingBytes}-byte read budget`);
    }
    return { value: buffer.subarray(0, offset).toString("utf8"), bytesRead: offset };
  });
}
function jsonObject(text2) {
  try {
    const value = JSON.parse(text2);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
  } catch {
    return void 0;
  }
}
async function readEvidenceSessionManifest(manifest, maxBytes = manifest.maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > manifest.maxBytes) {
    throw new Error(`session read budget must be an integer from 1-${manifest.maxBytes} bytes`);
  }
  let bytesRead = 0;
  let recordsRead = 0;
  const main2 = await readStableJsonl(manifest.main, maxBytes, MAX_EVIDENCE_SESSION_RECORDS);
  bytesRead += main2.bytesRead;
  recordsRead += main2.value.totalLines;
  if (recordsRead > MAX_EVIDENCE_SESSION_RECORDS) throw new Error(`session input exceeds ${MAX_EVIDENCE_SESSION_RECORDS} records`);
  const subagents = [];
  for (const sidecar of manifest.sidecars) {
    let transcript;
    try {
      transcript = await readStableJsonl(
        sidecar.transcript,
        maxBytes - bytesRead,
        MAX_EVIDENCE_SESSION_RECORDS - recordsRead
      );
    } catch (error) {
      if (error instanceof Error && /JSONL input exceeds \d+ records/.test(error.message)) {
        throw new Error(`session input exceeds ${MAX_EVIDENCE_SESSION_RECORDS} records`);
      }
      throw error;
    }
    bytesRead += transcript.bytesRead;
    recordsRead += transcript.value.totalLines;
    if (recordsRead > MAX_EVIDENCE_SESSION_RECORDS) throw new Error(`session input exceeds ${MAX_EVIDENCE_SESSION_RECORDS} records`);
    let meta;
    if (sidecar.meta) {
      const loadedMeta = await readStableText(sidecar.meta, maxBytes - bytesRead);
      bytesRead += loadedMeta.bytesRead;
      meta = jsonObject(loadedMeta.value);
    }
    subagents.push({
      path: sidecar.transcript.canonicalPath,
      records: transcript.value.records,
      lineNumbers: transcript.value.lineNumbers,
      agentIdHint: sidecar.agentIdHint,
      ...meta ? { meta } : {},
      totalLines: transcript.value.totalLines,
      badLines: transcript.value.badLines,
      bytes: transcript.bytesRead,
      trailingPartial: transcript.value.trailingPartial
    });
  }
  await assertEvidenceSessionManifestStable(manifest);
  return {
    bytesRead,
    parseInput: {
      path: manifest.main.canonicalPath,
      records: main2.value.records,
      lineNumbers: main2.value.lineNumbers,
      subagents,
      totalLines: main2.value.totalLines,
      badLines: main2.value.badLines,
      bytes: main2.bytesRead,
      trailingPartial: main2.value.trailingPartial
    }
  };
}

// src/discover/discover.ts
function defaultConfigDir() {
  const env = process.env["CLAUDE_CONFIG_DIR"];
  if (env && env.trim()) return env;
  return join2(homedir(), ".claude");
}
async function claudeRoots(explicit, homeDir = homedir(), env = process.env) {
  const entryBudget = discoveryEntryBudget();
  const roots = [];
  const add = (p) => {
    if (p && p.trim() && !roots.includes(p)) roots.push(p);
  };
  if (explicit) {
    explicit.split(",").forEach((r) => add(r.trim()));
    if (roots.length) return roots;
  }
  ;
  (env["ORANGU_CLAUDE_ROOTS"] ?? "").split(",").forEach((r) => add(r.trim()));
  (env["CLAUDE_CONFIG_DIR"] ?? "").split(",").forEach((r) => add(r.trim()));
  add(join2(homeDir, ".claude"));
  add(join2(homeDir, ".config", "claude"));
  const coworkBase = join2(homeDir, "Library", "Application Support", "Claude", "local-agent-mode-sessions");
  const canonicalCoworkBase = await canonicalNonSymlinkDirectoryChain(homeDir, [
    "Library",
    "Application Support",
    "Claude",
    "local-agent-mode-sessions"
  ]);
  if (canonicalCoworkBase) {
    for (const a of await safeReaddir(canonicalCoworkBase, entryBudget)) {
      const ad = join2(coworkBase, a);
      if (!await canonicalNonSymlinkDirectory(ad)) continue;
      for (const b of await safeReaddir(ad, entryBudget)) {
        const bd = join2(ad, b);
        if (!await canonicalNonSymlinkDirectory(bd)) continue;
        for (const c of await safeReaddir(bd, entryBudget)) {
          if (c.startsWith("local_") && !c.endsWith(".json")) {
            const cc = join2(bd, c, ".claude");
            if (!await canonicalNonSymlinkDirectory(join2(bd, c))) continue;
            if (!await canonicalNonSymlinkDirectory(cc)) continue;
            const projects = await canonicalNonSymlinkDirectory(join2(cc, "projects"));
            if (projects && isWithin2(canonicalCoworkBase, projects)) add(cc);
          }
        }
      }
    }
  }
  const seen = /* @__PURE__ */ new Set();
  const out3 = [];
  for (const r of roots) {
    if (!existsSync(join2(r, "projects"))) continue;
    let real = r;
    try {
      real = await realpath2(r);
    } catch {
    }
    if (seen.has(real)) continue;
    seen.add(real);
    out3.push(r);
  }
  return out3;
}
function projectSlug(cwd) {
  return cwd.replace(/[^A-Za-z0-9-]/g, "-");
}
var SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var MAX_DISCOVERY_DIRECTORY_ENTRIES = 25e3;
var MAX_DISCOVERED_SESSIONS = 25e3;
var DiscoveryLimitError = class extends Error {
};
function discoveryEntryBudget(limit = MAX_DISCOVERY_DIRECTORY_ENTRIES) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_DISCOVERY_DIRECTORY_ENTRIES) {
    throw new Error(`discovery entry cap must be an integer from 1-${MAX_DISCOVERY_DIRECTORY_ENTRIES}`);
  }
  return { remaining: limit, limit };
}
async function readBoundedDiscoveryDirectory(p, maxEntries = MAX_DISCOVERY_DIRECTORY_ENTRIES, budget) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_DISCOVERY_DIRECTORY_ENTRIES) {
    throw new Error(`discovery directory cap must be an integer from 1-${MAX_DISCOVERY_DIRECTORY_ENTRIES}`);
  }
  let dir;
  try {
    dir = await opendir2(p);
  } catch {
    return [];
  }
  const names = [];
  for await (const entry of dir) {
    if (budget) {
      if (budget.remaining <= 0) throw new DiscoveryLimitError(`session discovery exceeds ${budget.limit} cumulative directory entries`);
      budget.remaining--;
    }
    names.push(entry.name);
    if (names.length > maxEntries) {
      throw new DiscoveryLimitError(`session discovery directory exceeds ${maxEntries} entries: ${p}`);
    }
  }
  return names;
}
var safeReaddir = (path, budget) => readBoundedDiscoveryDirectory(path, MAX_DISCOVERY_DIRECTORY_ENTRIES, budget);
function sessionLimit(opts) {
  const value = opts.maxSessions ?? MAX_DISCOVERED_SESSIONS;
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_DISCOVERED_SESSIONS) {
    throw new Error(`session discovery cap must be an integer from 0-${MAX_DISCOVERED_SESSIONS}`);
  }
  return value;
}
function isWithin2(root, candidate) {
  const rel = relative2(root, candidate);
  return rel === "" || !isAbsolute2(rel) && rel !== ".." && !rel.startsWith(`..${sep2}`);
}
async function canonicalNonSymlinkDirectory(path) {
  try {
    const st = await lstat2(path);
    if (st.isSymbolicLink() || !st.isDirectory()) return void 0;
    return await realpath2(path);
  } catch {
    return void 0;
  }
}
async function canonicalNonSymlinkDirectoryChain(root, segments2) {
  let current = resolve2(root);
  if (!await canonicalNonSymlinkDirectory(current)) return void 0;
  for (const segment of segments2) {
    current = join2(current, segment);
    if (!await canonicalNonSymlinkDirectory(current)) return void 0;
  }
  return realpath2(current);
}
async function canonicalProjectsRoot(configDir) {
  try {
    const root = await realpath2(join2(configDir, "projects"));
    const st = await lstat2(root);
    return st.isDirectory() ? root : void 0;
  } catch {
    return void 0;
  }
}
async function sessionRefFor(projectPath, file, projectsRoot, entryBudget) {
  try {
    const projectStat = await lstat2(projectPath);
    if (projectStat.isSymbolicLink() || !projectStat.isDirectory()) return null;
  } catch {
    return null;
  }
  const path = join2(projectPath, file);
  let st;
  try {
    st = await lstat2(path);
  } catch {
    return null;
  }
  if (st.isSymbolicLink() || !st.isFile()) return null;
  if (projectsRoot) {
    let canonicalPath;
    try {
      canonicalPath = await realpath2(path);
    } catch {
      return null;
    }
    if (!isWithin2(projectsRoot, canonicalPath)) return null;
  }
  const sessionId = basename2(file, ".jsonl");
  const sidecar = join2(projectPath, sessionId);
  let hasSidecarDir = false;
  let subagentFiles = [];
  try {
    const sessionDirStat = await lstat2(sidecar);
    const subagentRoot = join2(sidecar, "subagents");
    const subagentRootStat = await lstat2(subagentRoot);
    hasSidecarDir = !sessionDirStat.isSymbolicLink() && sessionDirStat.isDirectory() && !subagentRootStat.isSymbolicLink() && subagentRootStat.isDirectory();
    if (hasSidecarDir) {
      const subs = await safeReaddir(subagentRoot, entryBudget);
      if (subs.length <= MAX_EVIDENCE_SIDECAR_ENTRIES) {
        for (const name of subs.sort()) {
          if (!name.endsWith(".jsonl")) continue;
          const candidate = join2(subagentRoot, name);
          const candidateStat = await lstat2(candidate);
          if (!candidateStat.isSymbolicLink() && candidateStat.isFile()) subagentFiles.push(candidate);
        }
      }
    }
  } catch (error) {
    if (error instanceof DiscoveryLimitError) throw error;
  }
  return {
    sessionId,
    path,
    projectSlug: basename2(projectPath),
    projectPath,
    sizeBytes: st.size,
    mtimeMs: st.mtimeMs,
    hasSidecarDir,
    subagentFiles
  };
}
async function projectDirsForCwd(root, cwd, entryBudget) {
  const exact = join2(root, projectSlug(cwd));
  if (existsSync(exact)) return [exact];
  const out3 = [];
  for (const name of await safeReaddir(root, entryBudget)) {
    const p = join2(root, name);
    try {
      const st = await lstat2(p);
      if (st.isSymbolicLink() || !st.isDirectory()) continue;
    } catch {
      continue;
    }
    const files2 = (await safeReaddir(p, entryBudget)).filter((f2) => f2.endsWith(".jsonl"));
    const f = files2[0];
    if (!f) continue;
    const c = await peekCwd(join2(p, f));
    if (c === cwd) out3.push(p);
  }
  return out3;
}
var PEEK_HEAD_BYTES = 64e3;
var TITLE_MAX = 120;
var COMMAND_NAME_RE = /<command-name>([^<]*)<\/command-name>/;
var COMMAND_ARGS_RE = /<command-args>([^<]*)<\/command-args>/;
function textOfContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string" ? b.text : "").filter(Boolean).join(" ");
}
function oneLine(s) {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > TITLE_MAX ? flat.slice(0, TITLE_MAX - 1) + "\u2026" : flat;
}
function promptTitle(text2) {
  const t = text2.trim();
  if (!t) return void 0;
  if (/^<command-(?:message|name)>/.test(t)) {
    const name = COMMAND_NAME_RE.exec(t)?.[1]?.trim();
    if (!name) return void 0;
    const args = COMMAND_ARGS_RE.exec(t)?.[1]?.trim();
    return oneLine(args ? `${name} ${args}` : name);
  }
  if (/^<(?:task|system)-notification>/.test(t)) return void 0;
  return oneLine(t);
}
async function peekHead(path) {
  const out3 = {};
  let handle;
  try {
    handle = await open3(path, constants3.O_RDONLY | constants3.O_NOFOLLOW);
  } catch {
    return out3;
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) return out3;
    const size = Math.min(st.size, PEEK_HEAD_BYTES);
    const buffer = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const read = await handle.read(buffer, offset, size - offset, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    const head = buffer.subarray(0, offset).toString("utf8");
    let custom;
    let ai;
    let prompt;
    for (const line of head.split("\n")) {
      if (!line.startsWith("{")) continue;
      let r;
      try {
        r = JSON.parse(line);
      } catch {
        continue;
      }
      if (out3.cwd === void 0 && typeof r["cwd"] === "string") out3.cwd = r["cwd"];
      const type = r["type"];
      if (type === "custom-title" && custom === void 0 && typeof r["customTitle"] === "string") custom = oneLine(r["customTitle"]);
      else if (type === "ai-title" && ai === void 0 && typeof r["aiTitle"] === "string") ai = oneLine(r["aiTitle"]);
      else if (type === "user" && prompt === void 0 && !r["isMeta"] && !r["isCompactSummary"] && !r["isSidechain"]) {
        const message = r["message"];
        const content = message && typeof message === "object" ? message.content : void 0;
        const hasToolResult = Array.isArray(content) && content.some((b) => b && typeof b === "object" && b.type === "tool_result");
        if (!hasToolResult) prompt = promptTitle(textOfContent(content));
      }
      if (out3.cwd !== void 0 && custom !== void 0) break;
    }
    const title = custom ?? ai ?? prompt;
    if (title) out3.title = title;
  } finally {
    await handle.close();
  }
  return out3;
}
async function peekCwd(path) {
  return (await peekHead(path)).cwd;
}
async function listSessions(opts = {}) {
  const limit = sessionLimit(opts);
  return listSessionsWithBudget(opts, { remaining: limit, limit }, discoveryEntryBudget(opts.maxEntries));
}
async function listSessionsWithBudget(opts, budget, entryBudget) {
  if (opts.roots && opts.roots.length) {
    const all = [];
    const seen = /* @__PURE__ */ new Set();
    for (const r of opts.roots) {
      for (const ref of await listSessionsWithBudget({ configDir: r, cwd: opts.cwd }, budget, entryBudget)) {
        if (seen.has(ref.path)) continue;
        seen.add(ref.path);
        all.push(ref);
      }
    }
    all.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return all;
  }
  const configDir = opts.configDir ?? defaultConfigDir();
  const root = await canonicalProjectsRoot(configDir);
  if (!root) return [];
  const dirs = opts.cwd ? await projectDirsForCwd(root, resolve2(opts.cwd), entryBudget) : (await safeReaddir(root, entryBudget)).map((n2) => join2(root, n2));
  const out3 = [];
  for (const d of dirs) {
    let st;
    try {
      st = await lstat2(d);
    } catch {
      continue;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) continue;
    for (const f of await safeReaddir(d, entryBudget)) {
      if (!f.endsWith(".jsonl")) continue;
      if (budget.remaining <= 0) throw new Error(`session discovery exceeds ${budget.limit} sessions`);
      budget.remaining--;
      const ref = await sessionRefFor(d, f, root, entryBudget);
      if (ref) out3.push(ref);
    }
  }
  out3.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out3;
}
async function resolveSession(ref, opts = {}) {
  const r = ref.trim();
  if (r.endsWith(".jsonl") || r.includes("/") || r.includes("\\")) {
    const abs = isAbsolute2(r) ? r : resolve2(process.cwd(), r);
    if (existsSync(abs)) {
      const projectPath = dirname2(abs);
      const made = await sessionRefFor(projectPath, basename2(abs));
      if (made) return made;
      try {
        const st = await lstat2(abs);
        if (st.isSymbolicLink()) {
          return {
            sessionId: basename2(abs, ".jsonl"),
            path: abs,
            projectSlug: basename2(projectPath),
            projectPath,
            sizeBytes: st.size,
            mtimeMs: st.mtimeMs,
            hasSidecarDir: false,
            subagentFiles: []
          };
        }
      } catch {
        return null;
      }
    }
    return null;
  }
  const all = await listSessions({ configDir: opts.configDir, roots: opts.roots });
  const exact = all.find((s) => s.sessionId.toLowerCase() === r.toLowerCase());
  if (exact) return exact;
  const matches = all.filter((s) => s.sessionId.toLowerCase().startsWith(r.toLowerCase()));
  if (matches.length === 1) return matches[0];
  return null;
}
async function candidatesForPrefix(prefix, opts = {}) {
  const all = await listSessions({ configDir: opts.configDir, roots: opts.roots });
  return all.filter((s) => s.sessionId.toLowerCase().startsWith(prefix.toLowerCase()));
}
async function findLatestSession(opts = {}) {
  const sessions = await listSessions(opts);
  return sessions[0] ?? null;
}

// src/discover/current.ts
import { constants as constants4 } from "node:fs";
import { open as open4, readdir } from "node:fs/promises";
import { join as join3 } from "node:path";
var MAX_SESSION_RECORD_BYTES = 4096;
var MAX_SESSION_RECORDS = 500;
var ALTERNATIVES = "use latest, an id, or orangu pick";
function sessionsDirs(opts) {
  if (opts.configDir) return [join3(opts.configDir, "sessions")];
  if (opts.roots && opts.roots.length) return opts.roots.map((r) => join3(r, "sessions"));
  return [join3(defaultConfigDir(), "sessions")];
}
async function readSessionRecord(path) {
  let handle;
  try {
    handle = await open4(path, constants4.O_RDONLY | constants4.O_NOFOLLOW);
  } catch {
    return void 0;
  }
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.size > MAX_SESSION_RECORD_BYTES) return void 0;
    const buffer = Buffer.allocUnsafe(st.size);
    const { bytesRead } = await handle.read(buffer, 0, st.size, 0);
    const r = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    if (!r || typeof r !== "object") return void 0;
    const pid = r["pid"];
    const sessionId = r["sessionId"];
    if (!Number.isSafeInteger(pid) || pid <= 0 || typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) return void 0;
    const str2 = (k) => typeof r[k] === "string" ? r[k] : void 0;
    const out3 = { pid, sessionId };
    const cwd = str2("cwd");
    const name = str2("name");
    const status = str2("status");
    if (cwd) out3.cwd = cwd;
    if (name) out3.name = name;
    if (status) out3.status = status;
    return out3;
  } catch {
    return void 0;
  } finally {
    await handle.close();
  }
}
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
async function runningSessions(opts, deps = {}) {
  const isAlive = deps.isAlive ?? pidAlive;
  const out3 = /* @__PURE__ */ new Map();
  for (const dir of sessionsDirs(opts)) {
    let names;
    try {
      names = (await readdir(dir)).filter((n2) => /^\d+\.json$/.test(n2)).sort().slice(0, MAX_SESSION_RECORDS);
    } catch {
      continue;
    }
    for (const name of names) {
      const rec = await readSessionRecord(join3(dir, name));
      if (!rec || !isAlive(rec.pid)) continue;
      if (!out3.has(rec.sessionId)) out3.set(rec.sessionId, rec);
    }
  }
  return out3;
}
async function resolveNamed(id, opts, via) {
  const ref = await resolveSession(id, opts);
  if (ref) return { ref, via };
  throw new Error(
    `current: session ${id.slice(0, 8)} has no transcript yet (Claude Code writes it asynchronously); try again in a moment, or ${ALTERNATIVES}`
  );
}
async function resolveCurrentSession(opts, env = process.env, deps = {}) {
  const envId = env["CLAUDE_CODE_SESSION_ID"]?.trim();
  if (envId) {
    if (!SESSION_ID_RE.test(envId)) throw new Error(`current: CLAUDE_CODE_SESSION_ID is not a session id; ${ALTERNATIVES}`);
    return resolveNamed(envId, opts, "env");
  }
  const pid = Number(env["CLAUDE_PID"]);
  if (Number.isSafeInteger(pid) && pid > 0) {
    for (const dir of sessionsDirs(opts)) {
      const rec = await readSessionRecord(join3(dir, `${pid}.json`));
      if (rec) return resolveNamed(rec.sessionId, opts, "pid-file");
    }
  }
  if (env["CLAUDECODE"]) {
    const cwd = env["CLAUDE_PROJECT_DIR"]?.trim() || (deps.cwd ?? (() => process.cwd()))();
    const ref = await findLatestSession({ ...opts, cwd });
    if (!ref) throw new Error(`current: no session for ${cwd} yet; ${ALTERNATIVES}`);
    return { ref, via: "cwd", note: `current: guessed ${ref.sessionId.slice(0, 8)} from cwd (no session id in the environment)` };
  }
  throw new Error(`current: not inside a Claude Code session; ${ALTERNATIVES}`);
}

// src/model/session.ts
var TURN_STARTING_KINDS = /* @__PURE__ */ new Set(["human", "command", "peer", "scheduled"]);
function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, webSearchRequests: 0, webFetchRequests: 0 };
}
function addUsage(a, b) {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cacheWrite5m: a.cacheWrite5m + b.cacheWrite5m,
    cacheWrite1h: a.cacheWrite1h + b.cacheWrite1h,
    webSearchRequests: a.webSearchRequests + b.webSearchRequests,
    webFetchRequests: a.webFetchRequests + b.webFetchRequests,
    serviceTier: a.serviceTier ?? b.serviceTier,
    speed: a.speed ?? b.speed,
    inferenceGeo: a.inferenceGeo ?? b.inferenceGeo
  };
}
function usageTotal(u) {
  return u.input + u.output + u.cacheRead + u.cacheWrite;
}

// src/analyze/util.ts
function sum(xs) {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}
function percentile(xs, p) {
  if (!xs.length) return 0;
  const a = [...xs].sort((x, y) => x - y);
  const idx = Math.min(a.length - 1, Math.max(0, Math.ceil(p / 100 * a.length) - 1));
  return a[idx];
}
function round(n2, d = 2) {
  const f = 10 ** d;
  return Math.round(n2 * f) / f;
}
function shortPath(p, cwd) {
  if (cwd && p.startsWith(cwd + "/")) return p.slice(cwd.length + 1);
  return p;
}
function topN(xs, n2, key) {
  return [...xs].sort((a, b) => key(b) - key(a)).slice(0, n2);
}
function fmtTokens(n2) {
  if (n2 >= 1e9 || n2 >= 1e6 && Number((n2 / 1e6).toFixed(2)) >= 1e3) return (n2 / 1e9).toFixed(n2 >= 1e10 ? 0 : 1) + "B";
  if (n2 >= 1e6) return (n2 / 1e6).toFixed(2) + "M";
  if (n2 >= 1e3) return (n2 / 1e3).toFixed(1) + "k";
  return String(n2);
}
function fmtMs(ms2) {
  if (ms2 === void 0) return "\u2013";
  if (!Number.isFinite(ms2)) return "\u2013";
  if (ms2 < 1e3) return `${Math.round(ms2)}ms`;
  const s = ms2 / 1e3;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.round(s % 60)}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// src/analyze/aggregate.ts
var AGGREGATE_SCHEMA_VERSION = "2";
var SEVERITY_ORDER = { high: 3, medium: 2, low: 1, info: 0 };
function compareCrossFindings(a, b) {
  return (SEVERITY_ORDER[b.severity] ?? 0) - (SEVERITY_ORDER[a.severity] ?? 0) || b.totalSavingsTokens - a.totalSavingsTokens || b.sessions - a.sessions || a.ruleId.localeCompare(b.ruleId);
}
function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
var WEEK_MS = 7 * 864e5;
var DAY_MS = 864e5;
function isoWeekStartUtc(ts2) {
  const dayStart = Math.floor(ts2 / DAY_MS) * DAY_MS;
  const dow = new Date(dayStart).getUTCDay();
  const sinceMonday = (dow + 6) % 7;
  return dayStart - sinceMonday * DAY_MS;
}
function byWeekOf(sessions, weeks = 12) {
  let latest;
  for (const s of sessions) if (s.startedAt !== void 0 && (latest === void 0 || s.startedAt > latest)) latest = s.startedAt;
  if (latest === void 0) return [];
  const lastWeek = isoWeekStartUtc(latest);
  const firstWeek = lastWeek - (weeks - 1) * WEEK_MS;
  const out3 = [];
  for (let i = 0; i < weeks; i++) out3.push({ weekStartUtc: firstWeek + i * WEEK_MS, tokens: 0, sessions: 0 });
  for (const s of sessions) {
    if (s.startedAt === void 0) continue;
    const idx = Math.floor((isoWeekStartUtc(s.startedAt) - firstWeek) / WEEK_MS);
    const b = out3[idx];
    if (!b) continue;
    b.tokens += s.tokens;
    b.sessions++;
  }
  return out3;
}
var EXAMPLE_SESSIONS = 5;
function titlePatternOf(title) {
  return title.replace(/\d[\d.,kM%×]*/g, "N");
}
function exampleTitle(title) {
  return title ? `e.g. ${title}` : "";
}
function inc(map, key, tokens, extra) {
  const e = map.get(key) ?? { key, count: 0, tokens: 0, extra: {} };
  e.count++;
  e.tokens += tokens;
  if (extra) for (const [k, v] of Object.entries(extra)) e.extra[k] = (e.extra[k] ?? 0) + v;
  map.set(key, e);
}
function sortRollup(map) {
  return [...map.values()].sort((a, b) => b.tokens - a.tokens || b.count - a.count);
}
function aggregate(analyses, scope, now) {
  const byModel = /* @__PURE__ */ new Map();
  const byProject = /* @__PURE__ */ new Map();
  const byTool = /* @__PURE__ */ new Map();
  const byAgentType = /* @__PURE__ */ new Map();
  const bySkill = /* @__PURE__ */ new Map();
  const reReadFiles = /* @__PURE__ */ new Map();
  const errorSigs = /* @__PURE__ */ new Map();
  const findings = /* @__PURE__ */ new Map();
  const perSessionSavings = /* @__PURE__ */ new Map();
  const exampleClaim = /* @__PURE__ */ new Map();
  const rows = [];
  const t = { tokens: 0, toolCalls: 0, toolErrors: 0, agents: 0, turns: 0, humanTurns: 0, wallMs: 0, activeMs: 0, compactions: 0, prs: 0, commits: 0 };
  let cacheRatioSum = 0;
  let cacheRatioN = 0;
  for (const a of analyses) {
    const sid = a.session.id;
    const tokens = a.summary.totalTokens;
    t.tokens += tokens;
    t.toolCalls += a.summary.toolCalls;
    t.toolErrors += a.summary.toolErrors;
    t.agents += a.summary.agents;
    t.turns += a.summary.turns;
    t.humanTurns += a.summary.humanTurns;
    t.wallMs += a.summary.wallMs ?? 0;
    t.activeMs += a.summary.activeMs;
    t.compactions += a.summary.compactions;
    t.prs += a.summary.outcomes.prLinks.length;
    t.commits += a.summary.outcomes.gitCommits;
    cacheRatioSum += a.summary.cacheHitRatio;
    cacheRatioN++;
    for (const m of a.tokens.byModel) inc(byModel, m.displayName, m.totalTokens);
    const proj = a.session.projectSlug ?? a.session.cwd ?? "unknown";
    inc(byProject, proj, tokens, { sessions: 1, errors: a.summary.toolErrors });
    for (const s of a.tools.byName) inc(byTool, s.name, 0, { calls: s.count, errors: s.errors });
    for (const at of a.agents.byType) inc(byAgentType, at.agentType, at.tokens, { runs: at.count });
    for (const sk of a.skills.byName) inc(bySkill, sk.name, 0, { uses: sk.count });
    for (const f of a.files.mostReRead) {
      if (f.reads < 3) continue;
      const e = reReadFiles.get(f.path) ?? { sessions: /* @__PURE__ */ new Set(), totalReads: 0 };
      e.sessions.add(sid);
      e.totalReads += f.reads;
      reReadFiles.set(f.path, e);
    }
    for (const g of a.tools.errorGroups) {
      const key = g.name + "|" + g.signature;
      const e = errorSigs.get(key) ?? { tool: g.name, sessions: /* @__PURE__ */ new Set(), total: 0 };
      e.sessions.add(sid);
      e.total += g.count;
      errorSigs.set(key, e);
    }
    for (const ins of a.insights) {
      const claimTokens = ins.savings?.tokens ?? 0;
      const claimMs = ins.savings?.ms ?? 0;
      const f = findings.get(ins.ruleId) ?? { ruleId: ins.ruleId, title: exampleTitle(ins.title), titlePattern: titlePatternOf(ins.title), sessions: 0, totalSavingsTokens: 0, totalSavingsMs: 0, axis: ins.axis, severity: ins.severity, exampleSessionIds: [] };
      f.sessions++;
      f.totalSavingsTokens += claimTokens;
      f.totalSavingsMs += claimMs;
      if (f.exampleSessionIds.length < EXAMPLE_SESSIONS) {
        f.exampleSessionIds.push(sid);
        const best = exampleClaim.get(ins.ruleId);
        if (!best) exampleClaim.set(ins.ruleId, { tokens: claimTokens, ms: claimMs });
        else if (claimTokens > best.tokens || claimTokens === best.tokens && claimMs > best.ms) {
          f.title = exampleTitle(ins.title);
          exampleClaim.set(ins.ruleId, { tokens: claimTokens, ms: claimMs });
        }
      }
      findings.set(ins.ruleId, f);
      const per = perSessionSavings.get(ins.ruleId) ?? { tokens: [], ms: [] };
      per.tokens.push(ins.savings?.tokens ?? 0);
      per.ms.push(ins.savings?.ms ?? 0);
      perSessionSavings.set(ins.ruleId, per);
    }
    rows.push({
      id: sid,
      title: a.session.title,
      project: proj,
      source: a.session.source,
      startedAt: a.session.startedAt,
      wallMs: a.summary.wallMs,
      activeMs: a.summary.activeMs,
      turns: a.summary.turns,
      humanTurns: a.summary.humanTurns,
      toolCalls: a.summary.toolCalls,
      toolErrors: a.summary.toolErrors,
      agents: a.summary.agents,
      tokens,
      contextPeak: a.summary.contextPeak,
      cacheHitRatio: a.summary.cacheHitRatio,
      compactions: a.summary.compactions,
      prs: a.summary.outcomes.prLinks.length,
      commits: a.summary.outcomes.gitCommits,
      interruptions: a.quality.interruptions,
      topInsightRuleId: a.insights[0]?.ruleId
    });
  }
  rows.sort((a, b) => b.tokens - a.tokens);
  const n2 = analyses.length || 1;
  return {
    schemaVersion: AGGREGATE_SCHEMA_VERSION,
    generatedAt: now,
    scope,
    sessionCount: analyses.length,
    totals: { ...t },
    averages: {
      tokensPerSession: round(t.tokens / n2, 0),
      tokensPerHumanTurn: t.humanTurns ? round(t.tokens / t.humanTurns, 0) : 0,
      toolErrorRate: t.toolCalls ? round(t.toolErrors / t.toolCalls, 4) : 0,
      cacheHitRatio: cacheRatioN ? round(cacheRatioSum / cacheRatioN, 4) : 0,
      agentsPerSession: round(t.agents / n2, 2),
      contextPeak: round(rows.reduce((a, r) => a + r.contextPeak, 0) / n2, 0)
    },
    byModel: sortRollup(byModel),
    byProject: sortRollup(byProject),
    byTool: sortRollup(byTool).sort((a, b) => (b.extra?.["calls"] ?? 0) - (a.extra?.["calls"] ?? 0)),
    byAgentType: sortRollup(byAgentType),
    bySkill: sortRollup(bySkill).sort((a, b) => (b.extra?.["uses"] ?? 0) - (a.extra?.["uses"] ?? 0)),
    topReReadFiles: [...reReadFiles.entries()].map(([path, e]) => ({ path, sessions: e.sessions.size, totalReads: e.totalReads })).sort((a, b) => b.totalReads - a.totalReads).slice(0, 20),
    recurringErrors: [...errorSigs.entries()].map(([key, e]) => ({ signature: key.split("|")[1] ?? key, tool: e.tool, sessions: e.sessions.size, total: e.total })).filter((e) => e.sessions >= 2).sort((a, b) => b.sessions - a.sessions || b.total - a.total).slice(0, 20),
    crossFindings: [...findings.values()].map((f) => {
      const per = perSessionSavings.get(f.ruleId) ?? { tokens: [], ms: [] };
      return {
        ...f,
        totalSavingsTokens: round(f.totalSavingsTokens, 0),
        totalSavingsMs: round(f.totalSavingsMs, 0),
        boundedSavingsTokens: round(Math.min(f.totalSavingsTokens, median(per.tokens) * f.sessions), 0),
        boundedSavingsMs: round(Math.min(f.totalSavingsMs, median(per.ms) * f.sessions), 0)
      };
    }).sort(compareCrossFindings),
    sessions: rows,
    topSessions: rows.slice(0, 15),
    byWeek: byWeekOf(rows)
  };
}

// src/report/generated/client-bundle.ts
var CLIENT_JS = '"use strict";(()=>{var Qt=["live","overview","timeline","tools","agents","context","coverage","repo","global","harness","suggest"];function V(e){return e.slice(0,8)}function z(e){return e.mode==="file"&&!e.capabilities.watch?[]:e.sessions.filter(t=>t.badge==="live")}function Oe(e){return e.mode==="serve"&&z(e).length>1?"live":"overview"}function De(e,t){let n=t.audience==="plain"?"plain":"dev",s=z(e),o=[];s.length>1&&o.push({id:"live-all",label:`All live \\xB7 ${s.length}`,screen:"live",dot:"pulse"});for(let f of s)o.push({id:"live-"+f.id,label:s.length>1?`${V(f.id)} \\xB7 ${f.projectSlug}`:`Watch \\xB7 ${V(f.id)}`,screen:"live",s:f.id,dot:"pulse"});let a=[{id:"overview",label:"Overview",screen:"overview"},{id:"timeline",label:"Timeline",screen:"timeline"},{id:"tools",label:"Tools & calls",screen:"tools"}];n==="dev"&&((e.session?.agents.runs.length??0)>0&&a.push({id:"agents",label:"Agents",screen:"agents"}),a.push({id:"context",label:"Context & tokens",screen:"context"}),a.push({id:"coverage",label:"Coverage",screen:"coverage"}));let i=e.aggregates.repo?.sessionCount,l=e.aggregates.global?.sessionCount,c=e.mode==="file"?"needs orangu serve":void 0,p=[{id:"repo",label:i!==void 0?`Repo \\xB7 ${i} sessions`:"Repo",screen:"repo",hint:i===void 0?c:void 0},{id:"global",label:"Global \\xB7 all time",screen:"global",hint:l===void 0?c:void 0},{id:"harness",label:"Harness",screen:"harness",hint:c}];return[{id:"live",label:"Live",items:o},{id:"session",label:"Observe this session",items:a},{id:"across",label:"Recurring patterns",items:p},{id:"improve",label:"Improve the next run",items:[{id:"suggest",label:"Suggestions",screen:"suggest"}]}]}function qe(e){let t={screen:"overview"},n=e.replace(/^#/,""),[s,o]=n.split("?");if(s&&Qt.includes(s)&&(t.screen=s),o)for(let a of o.split("&")){let i=a.indexOf("=");if(i<0)continue;let l=a.slice(0,i),c=decodeURIComponent(a.slice(i+1));l==="s"?t.s=c:l==="scope"&&(c==="session"||c==="repo"||c==="global")?t.scope=c:l==="tool"?t.tool=c:l==="cat"?t.cat=c:l==="agent"?t.agent=c:l==="turn"?t.turn=Number(c):l==="err"?t.errorsOnly=c==="1":l==="filter"&&(c==="all"||c==="errors"||c==="agents"||c==="human")?t.filter=c:l==="theme"?t.theme=c:l==="audience"&&(c==="dev"||c==="plain")&&(t.audience=c)}return t}function ie(e,t){return Te({...e,scope:void 0,tool:void 0,cat:void 0,agent:void 0,turn:void 0,errorsOnly:void 0,filter:void 0,...t})}function Te(e){let t=[];return e.s&&t.push("s="+encodeURIComponent(e.s)),e.scope&&t.push("scope="+e.scope),e.tool&&t.push("tool="+encodeURIComponent(e.tool)),e.cat&&t.push("cat="+encodeURIComponent(e.cat)),e.agent&&t.push("agent="+encodeURIComponent(e.agent)),e.turn!==void 0&&t.push("turn="+e.turn),e.errorsOnly&&t.push("err=1"),e.filter&&t.push("filter="+e.filter),e.audience&&t.push("audience="+e.audience),e.theme&&t.push("theme="+e.theme),"#"+e.screen+(t.length?"?"+t.join("&"):"")}function x(e){return e>=1e9?(e/1e9).toFixed(e>=1e10?0:1)+"B":e>=1e6?(e/1e6).toFixed(e>=1e7?0:2)+"M":e>=1e3?(e/1e3).toFixed(e>=1e5?0:1)+"k":String(Math.round(e))}function A(e){if(e===void 0||!isFinite(e))return"\\u2013";if(e<1e3)return Math.round(e)+"ms";let t=e/1e3;if(t<60)return t.toFixed(t<10?1:0)+"s";let n=Math.floor(t/60);if(n<60)return n+"m "+Math.round(t%60)+"s";let s=Math.floor(n/60);return s<24?s+"h "+n%60+"m":Math.floor(s/24)+"d "+s%24+"h"}function M(e,t=0){return(e*100).toFixed(t)+"%"}function R(e,t,n=t+"s"){return`${H(e)} ${e===1?t:n}`}function H(e){return e.toLocaleString("en-US")}function We(e){return e===void 0?"\\u2013":new Date(e).toISOString().slice(0,16).replace("T"," ")}function Ue(e){return e===void 0?"--:--:--":new Date(e).toISOString().slice(11,19)}function ce(e){return e>=1<<20?(e/(1<<20)).toFixed(1)+" MB":e>=1024?Math.round(e/1024)+" KB":e+" B"}function r(e){return String(e??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/\'/g,"&#39;")}var ee={read:"Read",search:"Search",edit:"Edit",write:"Write",exec:"Shell",agent:"Agents",skill:"Skills",web:"Web",plan:"Plan",ask:"Ask",mcp:"MCP",task:"Tasks",notebook:"Notebook",other:"Other"},Xt=["read","search","edit","write","exec","agent","skill","web","other"];function F(e){return`var(--cat-${Xt.includes(e)?e:"other"}, var(--cat-other))`}var Zt={clean:"The last check it ran passed",interrupted:"You stopped it",failing:"The last test run was failing"};function Ke(e,t){let n=Zt[e]??"The agent completed its last task";return e==="clean"&&t&&Ie(t)?`${n}; ${t.testRunsFailed} of ${R(t.testRuns,"test run")} failed earlier`:n}function Ie(e){return e.testRunsFailed&&e.testRunsFailed<e.testRuns?"last run":""}function Ae(e,t){let n=[],s=new Map;for(let o of e){if(o.signature){n.push(o);continue}let{tool:a,total:i,sessions:l=0}=t(o),c=s.get(a)??{tool:a,total:0,signatures:0,sessions:0};c.total+=i,c.signatures++,c.sessions=Math.max(c.sessions,l),s.set(a,c)}return{kept:n,hidden:[...s.values()].sort((o,a)=>a.total-o.total)}}function Ge(e){if(e.ending==="interrupted")return`Stopped by you after ${R(e.turns,"turn")}`;let t=Ce(e);if(t.length)return t.join(" \\xB7 ");let n=R(e.humanTurns,"request");return e.toolCalls>0?`${n}, ${e.agents?R(e.agents,"subagent")+", ":""}nothing committed`:`${n}, no tool calls recorded`}function Ce(e){let t=e.outcomes,n=[];t.prLinks.length&&n.push(R(t.prLinks.length,"PR")),t.gitCommits&&n.push(R(t.gitCommits,"commit"));let s=t.filesEdited+t.filesWritten;return s&&n.push(R(s,"file")+" changed"),t.buildRunsFailed&&n.push(`${t.buildRunsFailed} of ${R(t.buildRuns,"build run")} failed`),t.testRuns&&n.push(t.testRunsFailed?`${t.testRunsFailed} of ${R(t.testRuns,"test run")} failed`:`${R(t.testRuns,"test run")} green`),n}function ze(e){return{value:A(e.activeMs),note:e.wallMs!==void 0?`over ${A(e.wallMs)} wall \\xB7 ${A(e.humanWaitMs)} waiting for you`:"single-message session"}}function Ye(e){let t=e.evidence,n=t.calls?.[0],s=n?.tool??n?.name??t.tools?.[0]?.name;if(typeof s=="string"&&s)return{tool:s};if(e.turnIndexes.length)return{turn:e.turnIndexes[0]}}function ue(e,t){return e.map(n=>{let s=t.findIndex(o=>o.ts!==void 0&&n.ts!==void 0&&o.ts>=n.ts);return{x:s<0?Math.max(0,t.length-1):s,label:"compaction @turn "+n.turnIndex}})}function Me(e){if(!e)return"";let t=e.estimated?"~":"";return e.tokens?`save ${t}${x(e.tokens)} tokens`:e.ms?`save ${t}${A(e.ms)}`:""}function pe(e,t,n){if(!e||!e.tokens&&!e.ms)return;let s=`${e.estimated?"estimated":"measured"} by rule ${n}`;if(e.tokens&&t&&e.tokens<=t){let o=e.tokens/t;return{text:o<.005?"under 1% of this session":`~${M(o)} of this session`,title:`\\u2248${x(e.tokens)} tokens of the ${x(t)} this session measured; ${s}`}}return{text:Me(e),title:e.tokens?`\\u2248${x(e.tokens)} tokens; ${s}`:`\\u2248${A(e.ms)}; ${s}`}}function Je(e,t){return!t||!e.tokens&&!e.ms?"":`${e.tokens?`\\u2248${x(e.tokens)} tokens`:`\\u2248${A(e.ms)}`} recoverable across ${R(t,"finding")}`}function Qe(e){let t=e.summary,n=e.context,s=[];if(n.contextWindow&&t.contextPeak&&s.push(`context grew to ${M(t.contextPeak/n.contextWindow)} of the window`),t.totalTokens&&s.push(`${M(t.cacheHitRatio)} of tokens were cache reads`),t.totalTokens&&e.tokens.agents&&s.push(`${M(e.tokens.agents/t.totalTokens)} went to subagents`),!s.length)return"No token usage was recorded for this session.";let o=s.join("; ");return o[0].toUpperCase()+o.slice(1)+"."}function Xe(e){let t=e.find(s=>s.id==="tests");return t?.tone==="good"?"passing":t?.tone==="bad"?"failing":e.some(s=>(s.id==="commits"||s.id==="prs")&&Number(s.value)>0)?"shipped":"\\u2013"}function te(e,t,n){return e.filter(s=>s.turnIndex===t&&(!n||s.agentId===n))}function Ze(e,t,n){let s=te(e,t,n);if(!s.length)return[];let o=new Map;for(let a of s)o.set(a.category,(o.get(a.category)??0)+1);return[...o.entries()].map(([a,i])=>({cat:a,pct:i/s.length*100}))}function et(e,t){let n=[...t].sort((a,i)=>a.turnIndex-i.turnIndex).filter(a=>a.turnIndex>(e[0]?.index??0)&&a.turnIndex<=(e[e.length-1]?.index??0)),s=[],o=e;for(let a of n){let i=o.filter(l=>l.index<a.turnIndex);o=o.filter(l=>l.index>=a.turnIndex),s.push({turns:i,after:a})}return s.push({turns:o,after:void 0}),s}function tt(e,t){let n=[];for(let s of e.tools.calls)n.push({ts:s.startTs,name:s.name,category:s.category,summary:s.summary,durationMs:s.durationMs,isError:s.isError,agentType:s.agentId?"agent":void 0,key:s.toolUseId});for(let s of e.events)n.push({ts:s.ts,name:s.kind,category:"other",summary:s.label,key:"ev-"+s.turnIndex+"-"+s.kind});for(let s of e.agents.runs)n.push({ts:s.startTs,name:s.agentType||s.name||s.agentId,category:"agent",summary:s.taskKind??s.description??"subagent run",durationMs:s.durationMs,key:s.agentId});return n.sort((s,o)=>(s.ts??1/0)-(o.ts??1/0)||(s.key<o.key?-1:s.key>o.key?1:0)),n.slice(-t)}function Ve(e){let t=Math.max(0,Math.round(e/1e3));if(t<60)return t+"s";let n=Math.floor(t/60);return n<60?n+"m":Math.floor(n/60)+"h"}function me(e){return e.badge!=="ended"&&e.possiblyLive?"Watching \\xB7 possibly live":e.badge==="ended"?"ended \\xB7 updated "+Ve(e.ageMs)+" ago":"updated "+Ve(e.ageMs)+" ago"}function nt(e){if(!e.length)return 1/0;let t=e.map(s=>s.totalTokens).sort((s,o)=>o-s),n=Math.max(1,Math.floor(t.length*.2));return t[n-1]}function st(e,t){let n=new Set(t.map(a=>a.id)),s=e.filter(a=>!n.has(a)),o=t.filter(a=>a.open).map(a=>a.id);return[...new Set([...s,...o])]}var ot="orangu-brand-icon";var en=/^data:image\\/png;base64,[A-Za-z0-9+/]+={0,2}$/;function W(e=30){let t=`width="${e}" height="${e}" style="display:block"`,n=typeof document>"u"?void 0:document.getElementById(ot)?.getAttribute("href");return!n||!en.test(n)?`<span class="logo" ${t} role="img" aria-label="orangu"></span>`:`<img class="logo" src="${n}" ${t} alt="orangu" draggable="false">`}var Wn=String.raw`\n.-"""-.\n/  o o  \\   orangu\n|  \\___/()o  see what your agent did\n\\_______/`;function I(e){let t=document.createElement("template");return t.innerHTML=e.trim(),t.content.firstElementChild}function ge(e){e.querySelectorAll("details").forEach(t=>{let n=t.querySelector("summary");n&&(n.setAttribute("role","button"),n.setAttribute("aria-expanded",String(t.open)),t.addEventListener("toggle",()=>n.setAttribute("aria-expanded",String(t.open))))})}function fe(e){e.querySelectorAll("[data-copy]").forEach(t=>{t.addEventListener("click",()=>{let n=t.getAttribute("data-copy")??"",s=()=>{let o=t.textContent;t.textContent="copied",setTimeout(()=>t.textContent=o,1200)};if(navigator.clipboard?.writeText)navigator.clipboard.writeText(n).then(s,s);else{let o=document.createElement("textarea");o.value=n,document.body.appendChild(o),o.select();try{document.execCommand("copy")}catch{}o.remove(),s()}})})}var rt={"context window":"working memory","cache reads":"reused context","cache read":"reused context","cache writes":"saved context","cache write":"saved context","cache hits":"reused context",compactions:"memory refreshes",compaction:"memory refresh"};var tn=Object.keys(rt).sort((e,t)=>t.length-e.length);function E(e,t){if(t!=="plain")return e;let n=e;for(let s of tn)n=n.split(s).join(rt[s]);return n}function N(e,t,n="",s={}){let o=s.estimated?\'<span class="est" title="estimated: derived from bytes, not reported by the API">~</span>\':"";return`<div class="kpi${s.big?" big":""}${s.skeleton?" skel":""}"${s.title?` title="${r(s.title)}"`:""}>\n<div class="label">${r(e)}</div>\n<div class="val${s.accent?" accent":""}">${s.skeleton?"\\xB7\\xB7\\xB7":r(t)+o}</div>\n${n?`<div class="hint${s.badHint?" bad":""}">${r(n)}</div>`:""}\n</div>`}function Y(e,t="$"){return`<div class="cmd"><span class="p" aria-hidden="true">${r(t)}</span><span class="txt">${r(e)}</span><button class="copy" data-copy="${r(e)}" aria-label="copy command">copy</button></div>`}function D(e){return`<div class="card"><div class="empty-hero">\n${W(e.mascotSize??48)}\n<div class="t">${r(e.title)}</div>\n${e.hint?`<div class="s">${r(e.hint)}</div>`:""}\n${e.command?Y(e.command):""}\n</div></div>`}function K(){return I(`<section>${D({title:"No session selected."})}</section>`)}function he(e){return`<span class="mascot" style="display:block;width:${e}px;flex:none" aria-hidden="true">${W(e)}</span>`}function it(e,t={}){let n=e.reduce((i,l)=>i+l.value,0)||1,s=t.height??14,o=0,a=e.filter(i=>i.value>0).map(i=>{let l=i.value/n*100,c=`<rect x="${o}%" y="0" width="${l}%" height="${s}" fill="${i.color}"><title>${r(i.label)}</title></rect>`;return o+=l,c}).join("");return`<svg width="100%" height="${s}" viewBox="0 0 100 ${s}" preserveAspectRatio="none" role="img"${t.title?` aria-label="${r(t.title)}"`:""}>${a}</svg>`}function at(e,t,n={}){let s=n.width??720,o=n.height??160,a={l:4,r:4,t:8,b:16},i=e[0]?.length??0;if(i===0)return\'<div class="chart-empty">no data points yet</div>\';let l=s-a.l-a.r,c=o-a.t-a.b,p=new Array(i).fill(0),f=0;for(let m of e)for(let u=0;u<i;u++)f=Math.max(f,p[u]+(m[u]??0));let k=new Array(i).fill(0);for(let m of e)for(let u=0;u<i;u++)k[u]+=m[u]??0;f=n.yMaxOverride??Math.max(...k,1);let T=m=>a.l+(i===1?l/2:m/(i-1)*l),h=m=>a.t+c-m/f*c,y=new Array(i).fill(0),g=[];e.forEach((m,u)=>{let v=m.map((d,b)=>y[b]+(d??0)),L=`M ${T(0).toFixed(1)} ${h(y[0]).toFixed(1)}`;for(let d=0;d<i;d++)L+=` L ${T(d).toFixed(1)} ${h(v[d]).toFixed(1)}`;for(let d=i-1;d>=0;d--)L+=` L ${T(d).toFixed(1)} ${h(y[d]).toFixed(1)}`;L+=" Z",g.push(`<path d="${L}" fill="${t[u]??"var(--cat-other)"}" opacity="0.85"><title>${r(n.labels?.[u]??"")}</title></path>`);for(let d=0;d<i;d++)y[d]=v[d]});let S=(n.markers??[]).map(m=>{let u=T(m.x);return`<line x1="${u.toFixed(1)}" y1="${a.t}" x2="${u.toFixed(1)}" y2="${a.t+c}" stroke="${m.color??"var(--bad)"}" stroke-width="1.5" stroke-dasharray="3 2"><title>${r(m.label)}</title></line>`}).join(""),$=`<line x1="${a.l}" y1="${a.t+c}" x2="${a.l+l}" y2="${a.t+c}" stroke="var(--border2)" stroke-width="1"/>`;return`<svg width="100%" viewBox="0 0 ${s} ${o}" role="img" aria-label="stacked area">${g.join("")}${S}${$}</svg>`}function ae(e,t={}){let n=t.width??720,s=t.height??150,o={l:4,r:4,t:8,b:14},a=e.length;if(!a)return\'<div class="chart-empty">no data points yet</div>\';let i=n-o.l-o.r,l=s-o.t-o.b,c=t.yMax??Math.max(...e,1),p=$=>o.l+(a===1?i/2:$/(a-1)*i),f=$=>o.t+l-$/c*l,k="";e.forEach(($,m)=>{k+=(m===0?"M":"L")+" "+p(m).toFixed(1)+" "+f($).toFixed(1)+" "});let T=t.color??"var(--accent-ink)",h=t.threshold?`<line x1="${o.l}" y1="${f(t.threshold.y).toFixed(1)}" x2="${o.l+i}" y2="${f(t.threshold.y).toFixed(1)}" stroke="var(--warn)" stroke-width="1" stroke-dasharray="4 3"><title>${r(t.threshold.label)}</title></line>`:"",y=(t.markers??[]).map($=>`<line x1="${p($.x).toFixed(1)}" y1="${o.t}" x2="${p($.x).toFixed(1)}" y2="${o.t+l}" stroke="var(--bad)" stroke-width="1.5" stroke-dasharray="3 2"><title>${r($.label)}</title></line>`).join(""),g=t.fmtY,S=g?`<text x="${o.l+2}" y="${o.t+8}" font-size="9" fill="var(--ink3)" font-family="var(--mono)">${r(g(c))}</text><text x="${o.l+2}" y="${o.t+l-3}" font-size="9" fill="var(--ink3)" font-family="var(--mono)">${r(g(0))}</text>`:"";return`<svg width="100%" viewBox="0 0 ${n} ${s}" role="img" aria-label="line chart">${h}<path d="${k}" fill="none" stroke="${T}" stroke-width="2" stroke-linejoin="round"/>${y}<line x1="${o.l}" y1="${o.t+l}" x2="${o.l+i}" y2="${o.t+l}" stroke="var(--border2)"/><line x1="${o.l}" y1="${o.t}" x2="${o.l}" y2="${o.t+l}" stroke="var(--border2)"/>${S}</svg>`}function lt(e,t,n,s,o,a){let i=s-n||1,l=(e-n)/i*100,c=Math.max(.6,(t-e)/i*100);return`<svg width="100%" height="14" viewBox="0 0 100 14" preserveAspectRatio="none"><rect x="${l.toFixed(2)}" y="3" width="${c.toFixed(2)}" height="8" rx="3" fill="${o}"><title>${r(a)}</title></rect></svg>`}function ve(e,t){let n=Math.max(...e.map(s=>s.value),1);return e.map(s=>`<div class="proprow" style="display:grid;grid-template-columns:130px 1fr 72px;gap:10px;align-items:center;padding:3px 0">\n<div class="small" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r(s.label)}${s.sub?` <span class="muted">${r(s.sub)}</span>`:""}</div>\n<span class="trough"><i style="width:${(s.value/n*100).toFixed(1)}%;background:${s.color}"></i></span>\n<div class="right mono small">${r(t(s.value))}</div>\n</div>`).join("")}var be=50,dt=12;function nn(e,t,n){return t?e.conn==="reconnecting"?"reconnecting":t.badge==="ended"?"ended":n&&n.summary.toolCalls===0?"empty":e.data.mode==="file"?e.data.capabilities.watch?"file":"snapshot":t.badge==="idle"?"stalled":"live":"connecting"}function ye(e,t){return`<span class="bdot ${e}"${e==="p"?\' data-pulse="1"\':""} aria-hidden="true"></span>${t?`<span class="vh">${t}</span>`:""}`}var Q={pulse:ye("p","live"),hollow:ye("h","quiet"),good:ye("g","ended"),static:ye("s")},ct=[Q.pulse,"","Refreshes as the transcript grows. Nothing leaves this machine."],sn={connecting:[Q.static,"Connecting to orangu serve\\u2026","Waiting for the first event."],live:ct,empty:ct,stalled:[Q.hollow,"","No transcript growth lately; it may be waiting on you."],ended:[Q.good,"Session ended \\xB7 final numbers",""],reconnecting:[Q.hollow,"Connection lost \\xB7 retrying","The page reconnects on its own."],file:[Q.static,"Watching via orangu watch","Rewritten on every change; reload to refresh."],snapshot:[Q.static,"Static snapshot","This file does not update; orangu watch follows the session live."]};function on(e,t,n){let s=n?`turn <b style="color:var(--ink1)">${n.summary.turns}</b>${e==="ended"||e==="snapshot"?"":" in progress"}`:"",[o,a,i]=sn[e],l=a,c=i;return e==="live"||e==="empty"?l=t?.possiblyLive?"Watching \\xB7 possibly live":"Watching a running session":e==="stalled"?l=`Watching \\xB7 quiet for ${Math.max(1,Math.round((t?.ageMs??0)/6e4))}m`:e==="ended"&&(c=t?me(t):""),`<div class="livebanner">${he(44)}<div class="grow"><div class="lt">${o}<span aria-live="polite">${r(l)}</span></div><div class="ls">${r(c)}</div></div><div class="lr">${s}</div></div>`}function $e(e,t,n){let s=e.startTs!==void 0&&isFinite(t)?lt(e.startTs,e.endTs??n,t,n||t+1,F("agent"),`${e.agentType??e.name??e.agentId} \\xB7 ${A(e.durationMs)} \\xB7 ${x(e.totalTokens)} tokens`):\'<div class="small muted">no timing</div>\';return`<div class="swimrow"><div class="alabel">${"\\xB7 ".repeat(e.spawnDepth)}${r(e.agentType||e.name||e.agentId.slice(0,10))} <small>${r(e.model??"")}</small></div><div${e.status==="running"?"":\' class="dim"\'}>${s}</div></div>`}function rn(e){let t=e.agents.runs;if(!t.length)return"";let n=t.filter(l=>l.status==="running"),s=Math.min(...t.map(l=>l.startTs??1/0).filter(isFinite)),o=Math.max(...t.map(l=>l.endTs??-1/0).filter(isFinite)),a=[...n,...t.filter(l=>l.status!=="running")].slice(0,dt),i=t.length>dt?`<div class="pagefoot"><button data-all-lanes="1">show all ${t.length} agents</button></div>`:"";return`<div class="card pad mb18"><div class="card-title">Agents \\xB7 ${n.length} running \\xB7 ${t.length-n.length} done</div><div class="agent-lanes">${a.map(l=>$e(l,s,o)).join("")}</div>${i}</div>`}function an(e,t,n){let s=nn(e,t,n),o=n?.summary,a=!n,i=[N("Elapsed",o?.wallMs!==void 0?A(o.wallMs):"\\u2013","",{big:!0,skeleton:a}),N("Tokens so far",o?x(o.totalTokens):"\\u2013","",{big:!0,accent:!0,skeleton:a}),N("Tool calls",o?String(o.toolCalls):"\\u2013","",{big:!0,skeleton:a}),N("Cache hits",o?M(o.cacheHitRatio):"\\u2013","",{big:!0,skeleton:a})].join(""),l=n?.context,c=l?.contextWindow?l.final/l.contextWindow:void 0,p=s==="ended"?"\\u2013":`${R(o?.compactions??0,"compaction")} so far${c!==void 0&&c>=.75?" \\xB7 compaction likely near 90%":""}`,f=`<div class="card pad mb18">\n<div class="ctxhead"><span>Context window</span><span class="mono">${c!==void 0?r(M(c))+" of "+r(x(l.contextWindow)):l?r(x(l.final)):"\\u2013"}</span></div>\n<div class="ctxbar"><i style="width:${c!==void 0?(c*100).toFixed(1):0}%"></i></div>\n<div class="smt8">${r(p)}</div>\n</div>`,k=n?tt(n,be+1):[],T=k.length>be,h=k.slice(-be).map(u=>`<div class="feedrow">${u.agentType?\'<span style="width:2px;align-self:stretch;background:var(--cat-agent);flex:none"></span>\':""}<span class="ft">${r(Ue(u.ts))}</span><span class="sw" style="background:${F(u.category)}"></span><span class="fn">${r(u.name)}</span><span class="fw">${r(u.summary)}</span><span class="fd">${u.durationMs!==void 0?r(A(u.durationMs)):""}${u.isError?" \\xB7 error":""}</span></div>`).join(""),y=s==="connecting"?\'<div class="feedrow muted">Waiting for the first event\\u2026</div>\':\'<div class="feedrow muted">No tool calls yet.</div>\',g=[];t&&g.push(`streaming from \\u2026/${V(t.id)}.jsonl`),s==="ended"&&g.push("transcript closed"),T&&n&&g.push(`showing last ${be} of ${n.tools.calls.length+n.events.length+n.agents.runs.length} \\xB7 full list in Timeline`);let S=s==="ended"?`<a class="btn-sm" href="#overview${t?"?s="+r(t.id):""}" style="display:inline-block;margin-left:10px">Open Overview \\u2192</a>`:"",$=`<div class="feed" aria-live="off"><div class="card-head">Live feed</div>${h||y}<div class="feedfoot">${r(g.join(" \\xB7 "))}${S}</div></div>`,m=I(`<section>${on(s,t,n)}<div class="kpis k4">${i}</div>${f}${n?rn(n):""}${$}</section>`);return m.querySelector("[data-all-lanes]")?.addEventListener("click",u=>{if(!n)return;let v=m.querySelector(".agent-lanes");v.classList.add("swimbox");let L=Math.min(...n.agents.runs.map(b=>b.startTs??1/0).filter(isFinite)),d=Math.max(...n.agents.runs.map(b=>b.endTs??-1/0).filter(isFinite));v.innerHTML=n.agents.runs.map(b=>$e(b,L,d)).join(""),u.currentTarget.parentElement?.remove()}),m}function ut(e){let t=z(e.data),n=/[?&]s=/.test(location.hash),s=typeof window<"u"?window.__ORANGU_FLEET__:void 0;if(t.length>1&&!n&&s)return s(e,t);let o=e.data.sessions.find(a=>a.id===(e.state.s??e.data.selectedId))??e.data.sessions[0];return o?an(e,o,e.a):I(`<section>${D({title:"No sessions discovered.",command:"orangu serve"})}</section>`)}function xe(e,t){return`<div class="banner ${e}">${t}</div>`}function G(e,t){let n=e.parse.reconciliation;if(!(e.parse.badLines>0||!n.ok))return"";if(t==="plain")return xe("warn",`Some of the transcript could not be read (${H(e.parse.badLines)} lines); the numbers may be low.`);let o=n.matchesWithinPct.toFixed(2);return xe("warn",`Parsed ${r(H(e.parse.totalLines-e.parse.badLines))} of ${r(H(e.parse.totalLines))} records \\xB7 token totals off by ${r(o)}% \\xB7 <a href="#coverage">see Coverage</a>`)}function _(e,t={}){let n=Object.entries(t.data??{}).map(([i,l])=>` data-${i}="${r(l)}"`).join(""),s="chip"+(t.active?" active":""),o=t.disabled?\' aria-disabled="true" tabindex="-1"\':"",a=t.removable?\'<button class="x" aria-label="remove filter">\\xD7</button>\':"";return`<button type="button" class="${s}"${o}${t.title?` title="${r(t.title)}"`:""}${n}>${r(e)}${a}</button>`}function pt(e){if(!e.length)return"";let t=e.map(n=>`<span class="sigchip">${r(n.label)} <b class="${r(n.tone)}"${n.detail?` title="${r(n.detail)}"`:""}>${r(String(n.value))}</b></span>`).join("");return`<details class="signals"><summary>${e.length} signals</summary><div class="chiprow">${t}</div></details>`}function Ee(e,t,n={}){let s=pe(e.savings,n.sessionTotalTokens,e.ruleId),o=t==="plain"?"":`<span class="pill">${r(e.ruleId)}</span>`,a=e.turnIndexes.length&&t!=="plain"&&!n.link?`<div style="margin-top:10px"><button class="btn-sm" data-turns="${r(e.turnIndexes.join(","))}">Show ${R(e.turnIndexes.length,"turn")} \\u2192</button></div>`:"",i=e.detail?`<p>${r(E(e.detail,t))}</p>`:"",l=n.command?`<div class="fcmd"><div class="eyebrow">Draft a proposal</div>${Y(n.command)}</div>`:"",c=n.link?`<div style="margin-top:10px"><a class="btn-sm" href="${r(n.link.href)}">${r(n.link.label)}</a></div>`:"";return`<details class="finding${n.open?" top":""}"${n.open?" open":""}>\n<summary><span class="chev" aria-hidden="true">\\u25B8</span><span class="sev ${r(e.severity)}" title="${r(e.severity)}"></span><b>${r(E(e.title,t))}</b>${s?`<span class="fsave" title="${r(s.title)}">${r(s.text)}</span>`:""}${o}</summary>\n<div class="fbody">\n${i}\n<div class="rec"><b>Fix.</b> ${r(E(e.recommendation,t))}</div>\n${c}${a}\n${l}\n</div>\n</details>`}var mt={high:3,medium:2,low:1,info:0};function gt(e,t){return(mt[t.severity]??0)-(mt[e.severity]??0)||t.totalSavingsTokens-e.totalSavingsTokens||t.sessions-e.sessions||e.ruleId.localeCompare(t.ruleId)}var Ps=7*864e5;function ft(e){return new TextEncoder().encode(e)}function ht(e){let t=ft(e),n=t.length,s=(n+8>>6)+1,o=new Uint32Array(s*16);for(let y=0;y<n;y++)o[y>>2]|=t[y]<<24-(y&3)*8;o[n>>2]|=128<<24-(n&3)*8;let a=n*8;o[s*16-1]=a>>>0,o[s*16-2]=Math.floor(a/4294967296)>>>0;let i=1732584193,l=4023233417,c=2562383102,p=271733878,f=3285377520,k=new Uint32Array(80),T=(y,g)=>y<<g|y>>>32-g;for(let y=0;y<o.length;y+=16){for(let v=0;v<16;v++)k[v]=o[y+v];for(let v=16;v<80;v++)k[v]=T(k[v-3]^k[v-8]^k[v-14]^k[v-16],1);let g=i,S=l,$=c,m=p,u=f;for(let v=0;v<80;v++){let L,d;v<20?(L=S&$|~S&m,d=1518500249):v<40?(L=S^$^m,d=1859775393):v<60?(L=S&$|S&m|$&m,d=2400959708):(L=S^$^m,d=3395469782);let b=T(g,5)+L+u+d+k[v]>>>0;u=m,m=$,$=T(S,30)>>>0,S=g,g=b}i=i+g>>>0,l=l+S>>>0,c=c+$>>>0,p=p+m>>>0,f=f+u>>>0}let h=y=>y.toString(16).padStart(8,"0");return h(i)+h(l)+h(c)+h(p)+h(f)}function X(e){return[...new Set(e.map(t=>t.trim().replace(/\\\\/g,"/")).filter(Boolean))].sort()}function vt(e){return ht(JSON.stringify(X(e))).slice(0,16)}function bt(e,t="finding"){let n=e.cohortFingerprint;if(e.scope==="session"){if(n!==void 0)throw new Error(`${t} session scope must omit cohortFingerprint`);return}if(typeof n!="string"||!/^[0-9a-f]{16}$/.test(n))throw new Error(`${t} repo/global scope requires a 16-hex cohortFingerprint`)}function ne(e,t){return bt(e),{v:2,source:t,scope:e.scope,ruleId:e.ruleId,sessionIds:X(e.sessionIds),...e.insightId?{insightId:e.insightId}:{},...e.cohortFingerprint?{cohortFingerprint:e.cohortFingerprint}:{}}}function se(e){let t=JSON.stringify({v:2,source:e.source,scope:e.scope,ruleId:e.ruleId,sessionIds:X(e.sessionIds),insightId:e.insightId??null,...e.cohortFingerprint?{cohortFingerprint:e.cohortFingerprint}:{}});return"sg_"+ht(t).slice(0,12)}function ln(e){return btoa(Array.from(e,t=>String.fromCharCode(t)).join("")).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"")}function dn(e){return JSON.stringify(e,(t,n)=>n&&typeof n=="object"&&!Array.isArray(n)?Object.fromEntries(Object.entries(n).sort(([s],[o])=>s<o?-1:s>o?1:0)):n)}var Hs=256*1024;function cn(e,t="report"){bt(e);let n={...e,sessionIds:X(e.sessionIds)};return ln(ft(dn({v:2,source:t,finding:n})))}function un(e,t){if(t==="serve")return e.id;if(e.title&&e.evidence){let s={ruleId:e.ruleId,title:e.title,scope:e.scope,sessionIds:e.sessionIds,...e.insightId?{insightId:e.insightId}:{},...e.cohortFingerprint?{cohortFingerprint:e.cohortFingerprint}:{},evidence:e.evidence};return`${e.id} --finding ${cn(s,e.source??"report")}`}let n=[...e.sessionIds].sort().join(",");return`${e.id} --rule ${e.ruleId} --scope ${e.scope} --session ${n}`}function oe(e,t){let n=un(e,t);return{claude:`claude "/orangu:improve ${n}"`,codex:`$orangu-improve ${n}`}}var pn=12,ke=6,$t="/plugin marketplace add NissanOhana/orangu \\xB7 /plugin install orangu",le=e=>typeof e=="string"&&e.trim().length>0;function Le(e){let t=e.proposal;return!!t&&/^sg_[0-9a-f]{12}$/.test(e.id)&&Array.isArray(e.sessionIds)&&e.sessionIds.length>0&&e.sessionIds.every(le)&&le(t.title)&&le(t.change)&&/^[SML]$/.test(String(t.effort))&&le(t.proposalPath)&&(t.v??1)===1}function mn(e){let t=e.trim().replace(/[-_]+/g," ")||"finding";return t[0].toUpperCase()+t.slice(1)}var gn="Details hidden by redaction (they quote commands and result previews); re-run with --include-text to see them.";function xt(e,t,n){return{title:t.trim()||mn(e),detail:n.trim()||gn}}function kt(e){let t=e.boundedSavingsTokens??e.totalSavingsTokens,n=e.boundedSavingsMs??e.totalSavingsMs;return{...t?{tokens:t}:{},...n?{ms:n}:{},estimated:!0}}function wt(e,t){let n=xt(e.ruleId,e.title,e.detail);return{ruleId:e.ruleId,...n,recommendation:e.recommendation,savings:e.savings,sessionIds:t?[t]:[],insightId:e.id,severity:e.severity}}function de(e,t,n){if(e==="session")return(t?.insights??[]).map(o=>wt(o,t?.session.id));let s=n?vt(n.sessions.map(o=>o.id)):void 0;return[...n?.crossFindings??[]].sort(gt).map(o=>{let a=xt(o.ruleId,o.title,`Recurs in ${R(o.sessions,"session")}.`);return{ruleId:o.ruleId,...a,savings:kt(o),sessionIds:o.exampleSessionIds,sessions:o.sessions,severity:o.severity,...s?{cohortFingerprint:s}:{}}})}function Fe(e,t){return fn(e,t).command}function fn(e,t){let n=Pe(wt(e,t),"session"),s=ne(n,"report"),o=se(s);return{id:o,command:oe({id:o,...n,sessionIds:s.sessionIds,source:"report"},"file").claude}}function St(e){let t=0,n=0;for(let s of e)t+=s.savings?.tokens??0,n+=s.savings?.ms??0;return{tokens:t,ms:n}}function Pe(e,t){return{ruleId:e.ruleId,title:e.title,scope:t,sessionIds:e.sessionIds,...e.insightId?{insightId:e.insightId}:{},...e.cohortFingerprint?{cohortFingerprint:e.cohortFingerprint}:{},evidence:{estimated:e.savings?.estimated??!0,sessions:e.sessions??1,...e.savings?.tokens!==void 0?{savingsTokens:e.savings.tokens}:{},...e.savings?.ms!==void 0?{savingsMs:e.savings.ms}:{}}}}function Rt(e){if(e?.status!=="failed")return"";let t=e.kickoff?.error?.trim();return t?`Improvement workflow failed: ${t}`:"Improvement workflow failed. Copy the command to inspect it in Claude Code."}function Tt(e,t,n,s){let o,a=X(t.sessionIds).join(`\n`);for(let i of e){if(!Array.isArray(i.sessionIds)||!i.sessionIds.every(p=>typeof p=="string"))continue;let l=i.id===s||Array.isArray(i.legacyIds)&&i.legacyIds.includes(s),c=i.v===1&&i.ruleId===t.ruleId&&i.scope===n&&X(i.sessionIds).join(`\n`)===a&&(!t.insightId||!i.insightId||t.insightId===i.insightId);!l&&!c||(!o||i.statusAt>o.statusAt)&&(o=i)}return o}function yt(e){return[e.id,...Array.isArray(e.legacyIds)?e.legacyIds:[],e.proposal?.proposalPath].filter(le)}function It(e,t,n,s,o){let a=new Set(t==="session"?n?[n]:[]:s);if(!a.size)return[];let i=new Set(o.flatMap(yt)),l=[],c=[...e].sort((p,f)=>f.statusAt-p.statusAt);for(let p of c){if(p.scope!==t||!Le(p)||!p.sessionIds.some(k=>a.has(k)))continue;let f=yt(p);if(!f.some(k=>i.has(k))&&(f.forEach(k=>i.add(k)),l.push(p),l.length===pn))break}return l}function we(e,t,n){return ie(e.state,{s:e.state.s??t.session.id,...n})}function hn(e,t){return`<div class="hero overview-hero"><span class="overview-brand" aria-hidden="true">${W(64)}</span><div class="grow overview-copy"><div class="eyebrow">What happened</div><div class="herotitle">${r(Ge(e.summary))}</div><div class="sg-sub">${r(E(e.summary.narrative,t))}</div></div></div>`}function vn(e){let t=e.summary,n=Ce(t).join(" \\xB7 ")||"no commits, PRs or test runs detected",s=ze(t),o=t.totalTokens?`${M(t.cacheHitRatio)} read from cache \\xB7 ${x(e.tokens.byKind.output)} generated`:"no usage recorded",a=Ie(t.outcomes);return`<div class="triptych">\n<div class="axis q"><div class="aname">Quality \\u2191</div><div class="aval">${r(Xe(e.quality.signals))}${a?` <span class="anote">(${a})</span>`:""}</div><div class="anote">${r(n)}</div>${pt(e.quality.signals)}</div>\n<div class="axis t"><div class="aname">Time \\u2193</div><div class="aval">${r(s.value)}</div><div class="anote">${r(s.note)}</div></div>\n<div class="axis c"><div class="aname">Tokens \\u2193</div><div class="aval">${r(x(t.totalTokens))}</div><div class="anote">${r(o)}</div></div>\n</div>`}function At(e,t,n){if(!n)return`<div class="card pad mb16" style="background:var(--bg2);display:flex;align-items:center;gap:10px">${W(22)}<span class="muted">Nothing stood out. This session ran clean.</span></div>`;let s=Ye(n),o=s?.tool?{href:we(e,t,{screen:"timeline",tool:s.tool}),label:`See the ${s.tool} calls \\u2192`}:s?{href:we(e,t,{screen:"timeline",turn:s.turn}),label:`See the ${R(n.turnIndexes.length,"turn")} \\u2192`}:void 0;return`<div class="eyebrow mb6">The one thing to improve</div>${Ee(n,e.audience,{command:Fe(n,t.session.id),sessionTotalTokens:t.summary.totalTokens,open:!0,...o?{link:o}:{}})}`}function bn(e){let t=e.context,n=t.series.filter(i=>!i.agentId),o=`${t.contextWindow?`peak ${M(e.summary.contextPeak/t.contextWindow)} of the window`:`peak ${x(e.summary.contextPeak)}`} \\xB7 ${R(e.summary.compactions,"compaction")}`;return`<div class="card pad"><div class="card-title">Context</div>${n.length?`<div class="spark">${ae(n.map(i=>i.contextSize),{width:320,height:60,markers:ue(t.compactions,n),yMax:t.contextWindow})}</div>`:""}<div class="small muted">${r(o)}</div></div>`}function Ct(e,t){let n=t.summary,s=de("session",t,void 0).length;return`<nav class="card pad where-next" aria-label="Where to look next"><div class="card-title">Where to look next</div>${[{screen:"timeline",label:n.toolErrors?`Timeline \\xB7 ${R(n.toolErrors,"error")} only`:`Timeline \\xB7 ${H(n.turns)} turns`,state:n.toolErrors?{errorsOnly:!0}:{}},{screen:"tools",label:`Tools \\xB7 ${R(n.toolCalls,"call")}, ${R(n.toolErrors,"error")}`,state:{}},{screen:"suggest",label:s?`Suggestions \\xB7 ${R(s,"finding")}`:"Suggestions \\xB7 nothing to improve",state:{}}].map(a=>`<a data-screen="${a.screen}" href="${r(we(e,t,{screen:a.screen,...a.state}))}">${r(E(a.label,e.audience))} \\u2192</a>`).join("")}</nav>`}function yn(e,t){let n=t.summary.topInsightIds.map(a=>t.insights.find(i=>i.id===a)).filter(a=>!!a),s=n.slice(1).map(a=>Ee(a,"dev",{command:Fe(a,t.session.id),sessionTotalTokens:t.summary.totalTokens})).join(""),o=Je(St(de("session",t,void 0)),t.insights.length);return`${vn(t)}${At(e,t,n[0])}\n<div class="two-up mb16">${bn(t)}${Ct(e,t)}</div>\n${e.harnessCard?.()??""}\n${o?`<p class="recoverable"><a href="${r(we(e,t,{screen:"suggest"}))}">${r(o)} \\u2192</a></p>`:""}${s?`<h3 style="margin:4px 0 10px">More findings</h3>${s}`:""}`}function $n(e,t){let n=t.summary,o=t.turns.find(l=>l.kind==="human")?.promptPreview.slice(0,140)||(t.session.title?t.session.title:"(prompt text not included in this report)"),a=`${x(n.totalTokens)} tokens \\xB7 ${A(n.wallMs)}, of which ${A(n.humanWaitMs)} needed your attention`,i=t.insights.find(l=>l.id===n.topInsightIds[0])??t.insights[0];return`<div class="card mb16" style="overflow:hidden">\n<div class="card-head">${W(22)}What happened here</div>\n<div class="plaingrid">\n<div class="k">Goal</div><div>${r(o)}</div>\n<div class="k">How it ended</div><div>${r(Ke(n.ending,n.outcomes))}</div>\n<div class="k">Tokens &amp; time</div><div>${r(a)}</div>\n</div>\n</div>\n${At(e,t,i)}\n${Ct(e,t)}`}function je(e){let t=e.a;if(!t)return I(`<section>${D({title:"No session selected.",hint:"Pick a session from the sidebar."})}</section>`);let n=e.audience==="plain"?$n(e,t):yn(e,t);return I(`<section>${G(t,e.audience)}${hn(t,e.audience)}${n}</section>`)}var Mt=10;function xn(e,t,n){let s=n.state;if(s.turn!==void 0&&t.index!==s.turn)return!1;let o=te(e.tools.calls,t.index,s.agent);return!(s.filter==="errors"&&!o.some(a=>a.isError)||s.filter==="agents"&&t.agents.length===0&&!o.some(a=>a.agentId)||s.filter==="human"&&t.kind!=="human"||s.agent&&!t.agents.includes(s.agent)&&!o.length||(s.tool||s.cat||s.errorsOnly)&&(s.tool&&!o.some(a=>a.name===s.tool)||s.cat&&!o.some(a=>a.category===s.cat)||s.errorsOnly&&!o.some(a=>a.isError)))}function kn(e){let t=e.isCommand?"cmd":e.kind==="human"?"human":e.autoContinuations>0?"auto":e.kind;return`<span class="kind ${e.isCommand?"kcmd":e.kind==="human"?"khuman":""}">${r(t)}</span>`}function wn(e,t){let n=e.promptPreview||e.commandName;return n?{text:n,own:!1}:{text:[e.promptChars?`${x(e.promptChars)}-char prompt`:"",e.activity].filter(Boolean).join(" \\xB7 ")||(t?"(no prompt)":"(prompt text not included)"),own:!0}}function Sn(e,t,n,s,o){let i=Ze(e.tools.calls,t.index,n.state.agent).map(g=>`<i style="width:${g.pct.toFixed(1)}%;background:${F(g.cat)}"></i>`).join(""),{text:l,own:c}=wn(t,n.data.capabilities.includeText),p=c?\' style="color:var(--ink3)"\':"",f=te(e.tools.calls,t.index,n.state.agent),k=f.map(g=>{let S=g.agentId?e.agents.runs.find(m=>m.agentId===g.agentId):void 0,$=g.agentId?S?.agentType||S?.name||g.agentId.slice(0,8):"main";return`<div class="evline"><span class="sw" style="background:${F(g.category)}"></span><span class="pill">${r($)}</span><span class="en">${r(g.name)}</span><span class="ew">${r(g.summary)}</span><span class="tag ${g.isError?"bad":"good"}">${g.isError?"error":"ok"}</span><span class="ex">${[g.durationMs!==void 0?A(g.durationMs):"",g.resultBytes?ce(g.resultBytes):"",g.errorHint??""].filter(Boolean).map(r).join(" \\xB7 ")}</span></div>`}).join(""),T=t.agents.map(g=>{let S=e.agents.runs.find(m=>m.agentId===g);if(!S)return"";let $=S.hasTranscript?"":\' <span class="tag warn" title="only the parent summary was available">summary</span>\';return`<button class="btn-sm" data-agent-jump="${r(g)}">\\u25B8 ${r(S.agentType||S.name||g.slice(0,8))} \\xB7 ${r(x(S.totalTokens))} tokens${$}</button>`}).join(" "),h=[t.firstResponseMs!==void 0?`first response ${A(t.firstResponseMs)}`:"",t.humanGapMs?`waited ${A(t.humanGapMs)}`:"",t.autoContinuations?`${t.autoContinuations} auto-continuations`:"",t.models.length?t.models.join(", "):"","context end "+(t.contextEnd?x(t.contextEnd):"\\u2013")].filter(Boolean).join(" \\xB7 "),y=A(t.durationMs??t.reportedDurationMs);return`<details class="turn${t.interrupted?" interrupted":""}" id="turn-${t.index}"${o?" open":""}>\n<summary>\n<span class="tnum">#${t.index}</span>\n<span class="tprompt"${p}>${kn(t)}${r(l)}</span>\n<span class="mixbar" title="tool mix">${i}</span>\n<span class="tcell">${f.length}\\u2699</span>\n<span class="tcell">${r(y)}</span>\n<span class="tcell${t.totalTokens>=s&&t.totalTokens>0?" hot":""}">${r(x(t.totalTokens))}</span>\n</summary>\n<div class="tbody">\n<div class="tmeta">${r(h)}</div>\n${k||\'<p class="small muted" style="margin:0">No tool calls in this turn.</p>\'}\n${T?`<div class="pill-row">${T}</div>`:""}\n</div>\n</details>`}function Et(e,t,n,s){return et(t,e.context.compactions).map(o=>{let a=o.turns.map(l=>Sn(e,l,n,s,n.state.turn===l.index)).join(""),i=o.after?`<div class="divider"><span class="mono">\\u21C5 context compacted at turn ${o.after.turnIndex}${o.after.contextBefore&&o.after.contextAfter?` \\xB7 ${x(o.after.contextBefore)} \\u2192 ${x(o.after.contextAfter)}`:""}</span></div>`:"";return a+i}).join("")}function Ft(e){let t=e.a;if(!t)return K();let n=e.state,s=t.turns,o={all:s.length,errors:s.filter(m=>te(t.tools.calls,m.index).some(u=>u.isError)).length,agents:s.filter(m=>m.agents.length>0||te(t.tools.calls,m.index).some(u=>u.agentId)).length,human:s.filter(m=>m.kind==="human").length},a=n.filter??"all",i=[_(`All turns \\xB7 ${o.all}`,{active:a==="all",data:{filter:"all"}}),_(`Errors only \\xB7 ${o.errors}`,{active:a==="errors",data:{filter:"errors"}}),_(`With agents \\xB7 ${o.agents}`,{active:a==="agents",data:{filter:"agents"}}),_(`Human turns \\xB7 ${o.human}`,{active:a==="human",data:{filter:"human"}})].join(""),l=[];n.tool&&l.push(_("tool: "+n.tool,{active:!0,removable:!0,data:{clear:"tool"}})),n.cat&&l.push(_("category: "+n.cat,{active:!0,removable:!0,data:{clear:"cat"}})),n.agent&&l.push(_("agent: "+n.agent.slice(0,12),{active:!0,removable:!0,data:{clear:"agent"}})),n.turn!==void 0&&l.push(_("turn "+n.turn,{active:!0,removable:!0,data:{clear:"turn"}})),n.errorsOnly&&l.push(_("errors only",{active:!0,removable:!0,data:{clear:"err"}}));let c=s.filter(m=>xn(t,m,e)),p=nt(s),f=c.length<=Mt||n.turn!==void 0||!!(n.tool||n.cat||n.agent||n.errorsOnly||n.filter&&n.filter!=="all"),k=f?c:c.slice(0,Mt),T=new Set(k.map(m=>m.index)),h=Et(t,k,e,p),y=c.length?"":`<div class="card pad" style="background:var(--bg2);text-align:center"><p class="muted" style="margin:0 0 10px">No turns match \\xB7 ${r(a==="all"?"these filters":a)}</p><button class="btn-sm" data-clearall="1">Clear filters</button></div>`,g=f?"":`<div class="pagefoot">showing ${k.length} of ${c.length} turns \\xB7 <button data-showall="1">show all</button></div>`,S=E("expand a turn for every parent and subagent call \\xB7 the URL is the saved view",e.audience),$=I(`<section>\n${G(t,e.audience)}\n<div class="chiprow">${i}${l.join("")}<span class="small muted" style="margin-left:auto">${r(S)}</span></div>\n<div id="turnlist">${h}${y}${g}</div>\n</section>`);return $.querySelectorAll("[data-filter]").forEach(m=>m.addEventListener("click",()=>{let u=m.dataset.filter;e.go({filter:u==="all"?void 0:u,turn:void 0})})),$.querySelectorAll("[data-clear]").forEach(m=>m.addEventListener("click",()=>{let u=m.dataset.clear;u==="err"?e.go({errorsOnly:void 0}):u==="tool"?e.go({tool:void 0}):u==="cat"?e.go({cat:void 0}):u==="agent"?e.go({agent:void 0}):e.go({turn:void 0})})),$.querySelector("[data-clearall]")?.addEventListener("click",()=>e.go({filter:void 0,tool:void 0,cat:void 0,agent:void 0,turn:void 0,errorsOnly:void 0})),$.querySelector("[data-showall]")?.addEventListener("click",()=>{let m=$.querySelector("#turnlist");m.innerHTML=Et(t,c,e,p),ge(m),Lt(m,e)}),Lt($,e),n.turn!==void 0&&T.has(n.turn)&&setTimeout(()=>$.querySelector("#turn-"+n.turn)?.scrollIntoView({block:"center"}),0),$}function Lt(e,t){e.querySelectorAll("[data-agent-jump]").forEach(n=>n.addEventListener("click",()=>t.go({screen:"agents",agent:n.dataset.agentJump},{push:!0})))}function He(e,t,n=""){let s=t?"no error text was recorded":\'text hidden; re-run with <span class="mono">--include-text</span>\';return`<div class="rrow"${n?` style="${n}"`:""}><span class="grow"><b>${r(e.tool)}</b> \\xB7 ${R(e.total,"error")} across ${R(e.signatures,"recurring signature")}</span>${e.sessions?`<span class="mono small muted">${e.sessions}+ sessions</span>`:""}<span class="small muted">${s}</span></div>`}var Pt=12,Rn=[[/ENOENT/,"run the build first, or check the path"],[/old_string not found|String to replace not found/i,"file changed since last read; re-read before editing"],[/EACCES|permission/i,"permission problem: check file modes"],[/timed? out/i,"raise the timeout or split the command"]];function Tn(e){for(let[t,n]of Rn)if(t.test(e))return n;return""}function jt(e){let t=e.a;if(!t)return K();let n=t.tools,s=t.summary.toolCalls,o=n.byCategory.map(u=>`<span style="width:${s?(u.count/s*100).toFixed(1):0}%;background:${F(u.category)}" title="${r(ee[u.category]??u.category)} \\xB7 ${u.count}"></span>`).join(""),a=n.byCategory.map(u=>`<span><i class="sw" style="background:${F(u.category)}"></i>${r(ee[u.category]??u.category)} \\xB7 ${u.count}</span>`).join(""),i=n.parallelism,l=i.groups?`${i.parallelGroups} of ${i.groups} batches ran in parallel \\xB7 max ${i.maxGroupSize} at once`:"",c=Math.max(...n.byName.map(u=>u.totalMs),1),p=e.audience==="plain"?"one or more calls far above the rest":"one or more calls far above the rest; p95 is the typical worst case",f=u=>u.avgMs>u.p95Ms?`<td class="num" title="${p}">${r(A(u.avgMs))}<span class="outlier">outlier</span></td>`:`<td class="num">${r(A(u.avgMs))}</td>`,k=u=>u.map(v=>`<tr class="tool-row" data-tool="${r(v.name)}" title="${r(`${ce(v.resultBytesTotal)} output \\xB7 ${v.mainCount} main / ${v.agentCount} agent`)}">\n<td><i class="swd" style="background:${F(v.category)}"></i><span class="mono125">${r(v.name)}</span></td>\n<td class="num">${H(v.count)}</td>\n<td class="num"${v.errors?\' style="color:var(--bad)"\':\' style="color:var(--ink3)"\'}>${v.errors}</td>\n${f(v)}\n<td class="num p95col">${r(A(v.p95Ms))}</td>\n<td><span class="trough"><i style="width:${(v.totalMs/c*100).toFixed(1)}%;background:${F(v.category)}"></i></span></td>\n</tr>`).join(""),T=`<tr><th>Tool</th><th class="num">Calls</th><th class="num">Errors</th><th class="num">Avg</th><th class="num p95col">${e.audience==="plain"?"":"p95"}</th><th>Share of tool time</th></tr>`,h=n.byName.length>Pt?`<div class="pagefoot"><button data-more-tools="1">show all ${n.byName.length} tools</button></div>`:"",{kept:y,hidden:g}=Ae(n.errorGroups,u=>({tool:u.name,total:u.count})),S=n.errorGroups.length?g.map(u=>He(u,e.data.capabilities.includeText)).join("")+y.slice(0,8).map(u=>{let v=u.sampleHint||Tn(u.signature);return`<div class="rerow" style="font-size:13px"><div style="display:flex;gap:8px;align-items:center"><span class="sigline">${r(u.signature)}</span><span class="mono115" style="margin-left:auto">\\xD7${u.count}</span></div><div class="small muted" style="margin-top:2px">${r(u.name)}${v?" \\xB7 "+r(v):""}</div></div>`}).join(""):\'<p class="small" style="color:var(--good);margin:0">No tool errors in this session.</p>\',$=I(`<section>\n${G(t,e.audience)}\n<div class="card pad mb16">\n<div class="card-title">${r(E(`Calls by category \\xB7 ${s} total`,e.audience))}</div>\n<div class="catbar">${o}</div>\n<div class="legend">${a}</div>\n${l?`<div class="smt8">${r(l)} \\xB7 ${r(M(i.parallelCallShare))} of calls in a parallel batch</div>`:""}\n</div>\n<div class="card scroll-x mb16">\n<table class="grid"><thead>${T}</thead><tbody id="toolbody">${k(n.byName.slice(0,Pt))}</tbody></table>\n${h}\n</div>\n<div class="card pad"><div class="card-title">Recurring errors in this session</div>${S}</div>\n</section>`),m=u=>{e.audience==="plain"&&u.querySelectorAll(".p95col").forEach(v=>v.remove()),u.querySelectorAll(".tool-row").forEach(v=>v.addEventListener("click",()=>e.go({screen:"timeline",tool:v.dataset.tool},{push:!0})))};return m($),$.querySelector("[data-more-tools]")?.addEventListener("click",u=>{let v=$.querySelector("#toolbody");v.innerHTML=k(n.byName),m(v),u.currentTarget.parentElement?.remove()}),$}function Ht(e){return D({title:"Across-session views need orangu serve",hint:`This single-file report carries one session. Start the local viewer to ${e==="repo"?"analyse this repository":e==="global"?"analyse everything on this machine":"compare your Claude Code config with what your sessions used"}. Nothing leaves your machine.`,command:"orangu serve"})}var _t=["Instruction files","Scripts and CLIs","Hooks","Skills to create","Skills to discover","Subagents and agents","MCP servers","Plugins","Workflow and configuration"];var _e=e=>e?.verificationTrusted===!0;function Nt(e){return e==="kicked-off"?"running":e==="rejected"?"dismissed":e??"new"}function Bt(e,t="",n=!1){let s=e!=="verified"||n,o=s?e==="verified"?"verified comparison":e:"legacy unverified";return`<span class="status-chip" data-status="${s?e:"legacy"}" aria-live="polite"${t?` title="${r(t)}"`:""}>${o}${e==="verified"&&s?" \\u2713":""}</span>`}function Z(e){return typeof e!="string"?"":e.trim().slice(0,600)}function J(e,t){let n=Z(t);return n?`<div class="sg-pfield"><b>${e}.</b> ${r(n)}</div>`:""}function Se(e,t,n){if(!Array.isArray(t))return"";let s=t.slice(0,ke).map(o=>n&&o&&typeof o=="object"?n.map(a=>Z(o[a])).filter(Boolean).join(" \\xB7 "):Z(o)).filter(Boolean);return s.length?`<div class="sg-pfield"><b>${e}.</b><ul>${s.map(o=>`<li>${r(o)}</li>`).join("")}${t.length>ke?`<li class="muted">+${t.length-ke} more</li>`:""}</ul></div>`:""}function In(e){let t=e.proposal;return e.scope==="global"||e.status!=="proposed"||t?.v!==1||!Z(t.manifestPath)||!Z(t.workspace?.cwd)||!Array.isArray(t.files)||t.files.length===0?"":`<div class="sg-handoffs" aria-label="Apply handoff"><div class="small muted">Copy only. Nothing runs here.</div><div class="sg-hand"><span>Claude</span>${Y(`claude "/orangu:apply ${e.id}"`)}</div></div>`}function Ot(e){return`<div class="sg-handoffs"><div class="sg-hand"><span>Claude</span>${Y(e.claude)}</div></div>`}function Dt(e){if(!e||!Le(e))return"";let t=e.proposal,n=e.verificationReceipt,s=_e(e),o=n?.v===1&&s?J("Later evidence",n.summary)+Se("Computed comparisons",n.checks,["name","evidence"]):e.status==="verified"?J("Legacy state","Not verified under the current deterministic contract."):e.application?.v===1?J("Applied",e.application.summary):"";return`<div class="sg-proposal"><div class="sg-phead"><span class="eyebrow">Proposal</span>${t.changeClass?`<span class="pill">${r(t.changeClass)}</span>`:""}<span class="pill">effort ${r(t.effort)}</span></div><div class="sg-ptitle">${r(Z(t.title))}</div>${J("Change",t.change)}${J("Evidence",t.evidence)}${J("Expected effect",t.expectedEffect)}${J("Risk",t.risk)}${J("Verification",t.verification)}${Se("Reviewed comparisons",t.verificationChecks,["metric","comparison"])}${Se("Files",t.files)}${Se("Sources",t.sources,["kind","label","url","verifiedAt"])}${o}${In(e)}</div>`}function An(e){return`<details class="saved-proposal" id="saved-${r(e.id)}"><summary><span class="chev" aria-hidden="true">\\u25B8</span><b>${r(Z(e.proposal?.title))}</b>${Bt(Nt(e.status),"",_e(e))}</summary><div class="saved-proposal-body">${Dt(e)}</div></details>`}function Cn(e,t){if(t!=="serve")return"";let n=e.length?e.map(An).join(""):\'<p class="small muted" style="margin:0">Nothing yet. A proposal drafted by /orangu:improve for this scope lands here.</p>\';return`<section class="sg-inbox card pad mb16" aria-label="Saved proposals"><div class="sg-inbox-head"><div class="card-title">Saved proposals \\xB7 ${e.length}</div><span class="eyebrow">Localhost only</span></div>${n}</section>`}function Mn(e){return e==="serve"?"The proposal appears below under Saved proposals.":"The proposal is saved under ~/.orangu; open orangu serve to review it."}function En(e,t,n,s,o){let a=e.audience,i=pe(t.savings,e.state.scope===void 0||e.state.scope==="session"?e.a?.summary.totalTokens:void 0,t.ruleId),l=o?.proposal?.effort,c=Nt(o?.status),p=Rt(o),f=e.a?.session.cwd,k=t.sessionIds.map(T=>e.data.mode==="serve"?`<a class="exch" href="#overview?s=${r(T)}">${r(T.slice(0,8))}</a>`:`<span class="exch">${r(T.slice(0,8))}</span>`).join("");return`<details class="finding" data-sid="${r(s)}" data-rule="${r(t.ruleId)}">\n<summary><span class="chev" aria-hidden="true">\\u25B8</span><span class="rank">${n}</span>${t.severity?`<span class="sev ${r(t.severity)}" title="${r(t.severity)}"></span>`:""}<b class="sg-t">${r(E(t.title,a))}</b>${i?`<span class="fsave sg-save" title="${r(i.title)}">${r(i.text)}</span>`:""}${l?`<span class="pill">effort ${r(l)}</span>`:""}</summary>\n<div class="fbody sg-body">\n<div class="sg-ev"><b>Evidence.</b> ${r(E(t.detail,a))} ${a==="plain"?"":`<span class="pill">${r(t.ruleId)}</span>`}</div>\n${t.recommendation?`<div class="rec sg-fix"><b>Fix.</b> ${r(E(t.recommendation,a))}</div>`:""}\n<div class="sg-ex"><span class="small muted">example sessions:</span>${k}</div>\n${Dt(o)}\n<div class="kickrow">\n<span class="mono115">handled by</span>\n<span class="pill">orangu:improve</span>\n${Bt(c,p,_e(o))}\n</div>\n<ol class="steps" aria-label="Hand off to Claude Code">\n<li><button type="button" class="btn-sm" data-kick-copy="${r(s)}">Copy improve command</button></li>\n<li><div><span>Paste it in Claude Code${f?` in <span class="mono">${r(f)}</span>`:""}.</span><div class="small muted" style="margin:6px 0 4px">Needs the plugin once, typed inside Claude Code:</div>${Y($t,">")}</div></li>\n<li><span>${Mn(e.data.mode)}</span></li>\n</ol>\n<div class="kick-cmd sg-cmd">${e.data.mode==="serve"&&o&&!o.proposal&&c!=="dismissed"?Ot(oe(o,"serve")):""}</div>\n<div class="kick-msg small muted" aria-live="polite">${r(p)}</div>\n</div>\n</details>`}function qt(e){let t=e.a,n=e.state.scope??"session",s=e.data.aggregates.repo?.sessionCount,o=e.data.aggregates.global?.sessionCount,a=[_("This session",{active:n==="session",data:{scope:"session"}}),_(s!==void 0?`Repo \\xB7 ${s}`:"Repo",{active:n==="repo",disabled:s===void 0,title:s===void 0?"run orangu serve":"",data:{scope:"repo"}}),_(o!==void 0?`Global \\xB7 ${o}`:"Global",{active:n==="global",disabled:o===void 0,title:o===void 0?"run orangu serve":"",data:{scope:"global"}})].join(""),i=n==="session"?void 0:e.data.aggregates[n],l=de(n,t,i).map(d=>{let b=Pe(d,n);return{row:d,finding:b,sid:se(ne(b,"report"))}}),c=new Map(l.map(d=>[d.sid,d])),p=l.map(d=>({...d,record:Tt(e.data.suggestions,d.row,n,d.sid)})),f=p.flatMap(({record:d})=>d?[d]:[]),k=i?.sessions.map(d=>d.id)??[],T=e.data.mode==="serve"?It(e.data.suggestions,n,t?.session.id??e.state.s??e.data.selectedId,k,f):[],h=E(n==="session"?"One finding, one bounded proposal. Verify it on a later run before calling it an improvement.":n==="repo"?"Recurring repo patterns for larger harness changes. Apply only after review.":"Recurring global patterns. Global suggestions are proposal-only.",e.audience),y=p.length?p.map((d,b)=>En(e,d.row,b+1,d.sid,d.record)).join(""):D({title:"Nothing to improve was found",hint:"Ran clean. Re-run after your next session."}),g=_t.map(d=>`<span class="sigchip">${r(d)}</span>`).join(""),S=p.length?`<details class="card pad mb16 sg-note"><summary><span class="chev" aria-hidden="true">\\u25B8</span>What a proposal can change</summary><div class="chiprow mt8">${g}</div></details>`:"",$=n==="session"||!i?"":e.megaReview?.(n)??"",m="The evidence is deterministic; an optional AI skill drafts the proposal. "+(n==="session"?"Only a later session in the same workspace can verify it.":n==="repo"?"Applied means the reviewed files changed; only a later session can verify it.":"Global suggestions stay proposals; nothing is applied from here."),u=I(`<section>\n<div class="hero">\n${he(48)}\n<div class="grow sg-hero"><div class="herotitle">Improvement plan</div><div class="sg-sub">${r(h)}</div></div>\n</div>\n<div class="chiprow">${a}</div>\n${n!=="session"&&!i?D({title:"This scope needs orangu serve",command:"orangu serve"}):y+S}\n${Cn(T,e.data.mode)}\n${$}\n<p class="small muted sg-foot">${m}</p>\n</section>`);u.querySelectorAll("[data-scope]").forEach(d=>d.addEventListener("click",()=>{if(d.getAttribute("aria-disabled")==="true")return;let b=d.dataset.scope;e.go({scope:b==="session"?void 0:b})}));let v=t?.session.cwd;return(d=>{u.querySelectorAll(d).forEach(b=>b.addEventListener("click",()=>{let C=b.closest("details"),B=C.querySelector(".kick-msg"),P=b.dataset.kickCopy,q=P?c.get(P):void 0;if(!q)return;b.setAttribute("aria-busy","true");let j={mode:"copy",suggestionId:P,finding:q.finding};e.ds.kickoff(j).then(w=>w.ok?{kind:"copied",message:`Claude command copied. Paste it in Claude Code${v?` in ${v}`:""}.`,response:w.response}:{kind:"error",message:w.message,...w.response?{response:w.response}:{}}).then(w=>{if(b.removeAttribute("aria-busy"),B.textContent=w.message,"response"in w&&w.response?.commands){let U=C.querySelector(".kick-cmd");U.innerHTML=Ot(w.response.commands),fe(U),w.kind==="copied"&&U.querySelector("[data-copy]")?.click()}})}))})("[data-kick-copy]"),u}var Ne=24;function Wt(e){let t=e.a;if(!t)return K();let n=t.agents;if(!n.runs.length)return I(`<section>${D({title:"No subagents in this session.",hint:"This session ran entirely on the main thread."})}</section>`);let s=Math.min(...n.runs.map(p=>p.startTs??1/0).filter(isFinite)),o=Math.max(...n.runs.map(p=>p.endTs??-1/0).filter(isFinite)),a=n.runs.slice(0,Ne).map(p=>$e(p,s,o)).join(""),i=ve(n.byType.map(p=>({label:p.agentType,value:p.tokens,color:F("agent"),sub:"\\xD7"+p.count})),p=>x(p)),l=n.runs.map(p=>`<tr data-agent="${r(p.agentId)}" class="agent-row"${e.state.agent===p.agentId?\' style="background:var(--accent-weak)"\':""}>\n<td>${"\\xB7 ".repeat(p.spawnDepth)}${r(p.agentType||p.name||p.agentId.slice(0,8))}${p.hasTranscript?"":\' <span class="tag warn" title="only the parent summary was available">summary</span>\'}</td>\n<td>${r(p.model??"\\u2013")}</td>\n<td class="num">${r(A(p.durationMs))}</td>\n<td class="num">${p.toolCallCount}${p.toolErrors?` <span class="tag bad">${p.toolErrors}</span>`:""}</td>\n<td class="num">${r(x(p.totalTokens))}</td>\n</tr>`).join(""),c=I(`<section>\n${G(t,e.audience)}\n<div class="card pad" style="margin-bottom:16px">\n<div class="card-title">${n.runs.length} subagent runs \\xB7 ${r(M(1-n.mainThreadShare.tokens))} of tokens \\xB7 max depth ${n.maxDepth} \\xB7 up to ${n.maxConcurrency} parallel</div>\n<div class="swimbox">${a}</div>\n${n.runs.length>Ne?`<div class="pagefoot muted small">showing ${Ne} of ${n.runs.length} lanes \\xB7 all runs in the table below</div>`:""}\n</div>\n<div class="two-up">\n<div class="card pad"><div class="card-title">Tokens by agent type</div>${i}</div>\n<div class="card scroll-x"><table class="grid"><thead><tr><th>Agent</th><th>Model</th><th class="num">Duration</th><th class="num">Tools</th><th class="num">Tokens</th></tr></thead><tbody>${l}</tbody></table></div>\n</div>\n</section>`);return c.querySelectorAll("[data-agent]").forEach(p=>p.addEventListener("click",()=>e.go({screen:"timeline",agent:p.dataset.agent},{push:!0}))),c}function re(e,t,n=""){return`<div class="card pad${n?" "+n:""}"><div class="card-title">${e}</div>${t}</div>`}function Ut(e){let t=e.a;if(!t)return K();let n=t.context,s=n.series.filter(h=>!h.agentId),o=ue(n.compactions,s),a=ae(s.map(h=>h.contextSize),{threshold:n.contextWindow?{y:n.contextWindow,label:"window "+x(n.contextWindow)}:void 0,markers:o,yMax:n.contextWindow,fmtY:x}),i=at([s.map(h=>h.cacheRead),s.map(h=>h.cacheWrite),s.map(h=>h.input),s.map(h=>h.output)],["var(--cat-read)","var(--cat-edit)","var(--cat-write)","var(--cat-agent)"],{markers:o,labels:["cache read","cache write","fresh input","output"]}),l=t.tokens,c=[{value:l.byKind.cacheRead,color:"var(--cat-read)",label:"cache read "+x(l.byKind.cacheRead)},{value:l.byKind.cacheWrite5m,color:"var(--cat-skill)",label:"cache write 5m "+x(l.byKind.cacheWrite5m)},{value:l.byKind.cacheWrite1h,color:"var(--cat-edit)",label:"cache write 1h "+x(l.byKind.cacheWrite1h)},{value:l.byKind.input,color:"var(--cat-write)",label:"fresh input "+x(l.byKind.input)},{value:l.byKind.output,color:"var(--cat-agent)",label:"output "+x(l.byKind.output)}],p=ve(l.byModel.map(h=>({label:h.displayName,value:h.totalTokens,color:F("edit"),sub:h.estimatedMatch?"~est. match":""})),h=>x(h)),f=l.serverToolRequests.webSearch+l.serverToolRequests.webFetch,k=ae(l.byTurn.map(h=>h.cumulativeTokens),{color:"var(--accent-ink)",fmtY:x}),T=[re("Token composition per request",`<div class="scroll-x">${i}</div><div class="legend">${["read","edit","write","agent"].map((h,y)=>`<span><i class="sw" style="background:var(--cat-${h})"></i>${["cache read","cache write","fresh input","output"][y]}</span>`).join("")}</div>`,"mb16"),re("By model",`${p}<p class="small muted" style="margin-top:8px">Main thread ${r(x(l.mainThread))} \\xB7 agents ${r(x(l.agents))}</p>`,"mb16"),re("Cumulative tokens over turns",`<div class="scroll-x">${k}</div>`)].join("");return I(`<section>\n${G(t,e.audience)}\n<p class="ctx-lead">${r(Qe(t))}</p>\n<div class="kpis">\n${N("Peak context",x(n.peak),n.contextWindow?M(n.peak/n.contextWindow)+" of "+x(n.contextWindow):"")}\n${N("Cache hit ratio",M(n.cacheHitRatio,1),"context re-read rather than re-sent")}\n${N("Context re-read",n.reReadMultiplier.toFixed(1)+"\\xD7","context carried \\xF7 peak")}\n${N("Long-lived cache writes",M(n.cacheWrite1hShare),"of cache writes (the 1h tier)")}\n${N("Fixed weight per request",x(n.baseline),"system + tools + CLAUDE.md, every request")}\n${N("Compactions",String(n.compactions.length),n.compactions.length?"context was reset":"none")}\n</div>\n${re("Context size over the session",`<div class="scroll-x">${a}</div><div class="legend"><span>Each point is one API request; dashed lines are compactions.</span></div>`,"mb16")}\n${re(`Where the tokens went \\xB7 ${r(x(l.totalTokens))} total`,`${it(c,{height:22})}<div class="legend">${c.filter(h=>h.value>0).map(h=>`<span><i class="sw" style="background:${h.color}"></i>${r(h.label)}</span>`).join("")}</div>${f?`<div class="smt8">${R(f,"server-tool request")} (web search/fetch), counted per request, not in tokens</div>`:""}`,"mb16")}\n<details class="more-charts"><summary><span class="chev" aria-hidden="true">\\u25B8</span>More charts \\xB7 composition per request, by model, cumulative</summary><div class="mt8">${T}</div></details>\n</section>`)}var Be="\\u2039stripped\\u203A";function Vt(e){let t=e.a;if(!t)return K();let n=t.parse,s=n.reconciliation,o=Object.entries(n.unknownRecordTypes).filter(([y])=>y!==Be),a=n.unknownRecordTypes[Be]??0,i=o.length,l=a?`<div class="small muted">${R(a,"unrecognized record")} were counted; their type names are hidden by redaction. Re-run with --include-text to see them.</div>`:"",c=t.skills.byName.length?`<div class="card pad mt16"><div class="card-title">Skills &amp; commands used</div><div class="pill-row">${t.skills.byName.map(y=>`<span class="sigchip">${r(y.name)} <span class="muted">\\xD7${y.count} ${r(y.via.join("/"))}</span></span>`).join("")}</div></div>`:"",p=t.hooks.runs?`<div class="card pad mt16"><div class="card-title">Hooks</div><p class="small muted" style="margin:0">${t.hooks.runs} hook runs \\xB7 ${t.hooks.errors} errors \\xB7 ${r(A(t.hooks.totalMs))} total</p></div>`:"",f=I(`<section>\n${xe(s.ok?"info":"warn",`<strong>Parse coverage:</strong>&nbsp;${r(H(n.totalLines))} records, ${n.badLines} unreadable, ${R(i,"unrecognized record type")}${a?` (+${a} record${a===1?"":"s"} with redacted type names)`:""}. Token totals reconcile to within ${r(s.matchesWithinPct.toFixed(2))}% ${s.ok?"\\u2713":"(review)"}.`)}\n<div class="two-up">\n<div class="card pad"><div class="card-title">Session</div>\n<table class="grid"><tbody>\n<tr><td>ID</td><td class="mono small">${r(t.session.id)}</td></tr>\n<tr><td>Source</td><td>${r(t.session.source)}</td></tr>\n<tr><td>Project</td><td class="mono small">${r(t.session.cwd??t.session.projectSlug??"\\u2013")}</td></tr>\n<tr><td>Started</td><td>${r(We(t.session.startedAt))}</td></tr>\n<tr><td>Client</td><td>${r(t.session.clientVersions.join(", "))}</td></tr>\n<tr><td>Models</td><td>${t.session.models.map(y=>r(y.displayName)+(y.estimatedMatch?" ~":"")).join(", ")}</td></tr>\n<tr><td>Branches</td><td class="mono small">${r(t.session.gitBranches.join(", ")||"\\u2013")}</td></tr>\n<tr><td>Generated</td><td>orangu v${r(t.generator.version)} \\xB7 model catalog ${r(t.generator.modelCatalogUpdatedAt)}</td></tr>\n</tbody></table>\n</div>\n<div class="card pad"><div class="card-title">How to read the numbers</div>\n<ul class="small" style="padding-left:18px;line-height:1.7;margin:0">\n<li><strong>Tokens are the only usage metric</strong> orangu reports. They are what the transcript records.</li>\n<li>Token usage is <strong>deduplicated by message id</strong>.</li>\n<li>Context = fresh input + cache read + cache write.</li>\n<li>~ marks a model matched by family fallback: the name is approximate, the token counts are not.</li>\n<li>No LLM produced any number here; zero network calls.</li>\n</ul>\n</div>\n</div>\n${i||a?`<div class="card pad mt16"><div class="card-title">Unrecognized records (counted, not dropped)</div>${i?`<div class="pill-row">${o.map(([y,g])=>`<span class="pill">${r(y)} \\xD7${g}</span>`).join("")}</div>`:""}${l}</div>`:""}\n${c}\n${p}\n<div class="card pad mt16">\n<div class="card-title">Raw explorer</div>\n<div class="raw-filter no-print">\n<input type="text" id="raw-q" placeholder="filter by text\\u2026" aria-label="filter calls by text" />\n<select id="raw-cat" aria-label="filter by category"><option value="">all categories</option>${Object.keys(ee).map(y=>`<option value="${r(y)}">${r(ee[y])}</option>`).join("")}</select>\n<label class="small"><input type="checkbox" id="raw-err" /> errors only</label>\n<span class="small muted" id="raw-count"></span>\n</div>\n<div id="raw-list" style="max-height:480px;overflow:auto;border-top:1px solid var(--border)"></div>\n</div>\n</section>`),k=f.querySelector("#raw-list"),T=f.querySelector("#raw-count"),h=()=>{let y=f.querySelector("#raw-q").value.toLowerCase(),g=f.querySelector("#raw-cat").value,S=f.querySelector("#raw-err").checked,$=t.tools.calls.filter(m=>(!g||m.category===g)&&(!S||m.isError)&&(!y||m.summary.toLowerCase().includes(y)||m.name.toLowerCase().includes(y)));T.textContent=$.length+" of "+t.tools.calls.length+" calls",k.innerHTML=$.slice(0,2e3).map(m=>`<div class="rawrow"><span class="rt">${r(m.name)}</span><span class="muted">#${m.turnIndex}${m.agentId?" agent":""}${m.isError?" \\u26A0":""}</span><span class="rp">${r(m.summary)}${m.durationMs!==void 0?" \\xB7 "+r(A(m.durationMs)):""}</span></div>`).join("")+($.length>2e3?`<div class="rawrow muted">\\u2026${$.length-2e3} more (narrow the filter)</div>`:""),$.length||(k.innerHTML=\'<div class="rawrow muted">no calls match</div>\')};return f.querySelector("#raw-q").addEventListener("input",h),f.querySelector("#raw-cat").addEventListener("change",h),f.querySelector("#raw-err").addEventListener("change",h),h(),f}var Ln={live:ut,overview:je,timeline:Ft,tools:jt,suggest:qt,agents:Wt,context:Ut,coverage:Vt},Fn={live:"Live",overview:"Overview",timeline:"Timeline",tools:"Tools & calls",repo:"Repo",global:"Global",harness:"Harness",suggest:"Improve the next outcome",agents:"Agents",context:"Context & tokens",coverage:"Coverage"};function Pn(e){return Fn[e]??"Overview"}function jn(e){let t=e.a,n=e.audience;switch(e.state.screen){case"live":{let s=z(e.data);if(s.length>1)return`${s.length} running sessions \\xB7 ${s.reduce((a,i)=>a+(i.agentsRunning??0),0)} agents active`;let o=e.data.sessions.find(a=>a.id===(e.state.s??e.data.selectedId));return o?`${V(o.id)} \\xB7 ${me(o)}`:""}case"overview":return t?E(`outcome and evidence \\xB7 ${V(t.session.id)} \\xB7 ${t.summary.turns} turns \\xB7 ${t.summary.toolCalls} tool calls`,n):"";case"timeline":return t?E(`every step and tool call \\xB7 ${t.summary.turns} turns \\xB7 ${t.summary.toolErrors} errors`,n):"";case"tools":return t?E(`${t.summary.toolCalls} tool calls \\xB7 ${t.tools.byName.length} tools`,n):"";case"repo":return`${e.data.aggregates.repo?e.data.aggregates.repo.sessionCount+" sessions \\xB7 ":""}recurring evidence in this repository`;case"global":return`${e.data.aggregates.global?e.data.aggregates.global.sessionCount+" sessions \\xB7 ":""}recurring evidence across this machine`;case"harness":return"declared vs used, in tokens";case"suggest":return e.state.scope==="repo"||e.state.scope==="global"?"recurring patterns \\xB7 bounded proposals \\xB7 whole-harness review":"one finding \\xB7 one bounded proposal";case"agents":return t?`${t.agents.runs.length} runs \\xB7 up to ${t.agents.maxConcurrency} parallel`:"";case"context":return t?`peak ${H(t.context.peak)} \\xB7 ${t.context.compactions.length} compactions`:"";case"coverage":return t?`${H(t.parse.totalLines)} records \\xB7 ${t.parse.badLines} unreadable`:"";default:return""}}async function Kt(e,t,n,s){try{e.suggestions=await t.suggestions(),n&&s()}catch{}}async function Hn(e,t,n,s,o){e.type==="connection"&&e.state==="connected"&&await Kt(t,n,s,o)}async function Gt(e,t){let n=document.getElementById("app");if(!n)return;let s=null;try{s=await e.load()}catch{s=null}if(!s){n.innerHTML=`<div class="page"><div class="card"><div class="empty-hero">${W(48)}<div class="t">No analysis data in this file.</div><div class="s mono">node dist/orangu.js report</div></div></div></div>`;return}let o=s,a=d=>{let b=qe(d);return d.replace(/^#/,"")||(b.screen=Oe(o)),b.s||(b.s=o.selectedId),b},i=a(location.hash),l=async d=>{if(!d)return o.session;if(o.mode!=="serve")return o.session&&o.session.session.id===d?o.session:await e.session(d)??o.session;let b=await e.session(d);return b||(o.session&&o.session.session.id===d?o.session:void 0)},c=()=>{let d=document.documentElement;i.theme==="dark"?d.setAttribute("data-theme","dark"):i.theme==="light"?d.setAttribute("data-theme","light"):d.removeAttribute("data-theme")},p=(d,b={})=>{i={...i,...d};let C=Te(i);b.push?history.pushState(null,"",C):history.replaceState(null,"",C),L()},f,k=async()=>({data:o,a:await l(i.s),ds:e,state:i,audience:i.audience==="plain"?"plain":"dev",conn:f,aggLoading:t?i.screen==="harness"?t.ensureHarness(e,g):t.ensureAggregate(o,e,i,g):!1,megaReview:t?.megaReview,harnessCard:t?()=>t.harnessCard(e,g,ie(i,{screen:"harness"})):void 0,go:p}),T=!1,h=0,y=600;function g(){if(T)return;T=!0;let d=Math.max(0,h+y-Date.now());setTimeout(()=>{T=!1,L()},d)}function S(d){let b=De(o,i),C=o.sessions.find(O=>O.id===i.s)??o.sessions[0],B=b.filter(O=>O.items.length).map(O=>`<div class="navgroup"><div class="navgroup-label">${r(O.label)}</div>${O.items.map(w=>{let U=ie(i,{screen:w.screen,s:w.s??i.s,scope:i.scope}),Re=i.screen===w.screen&&(w.s===void 0||w.s===i.s),Jt=w.dot?`<span class="ldot${w.dot==="hollow"?" hollow":w.dot==="ended"?" done":""}"${w.dot==="pulse"?\' data-pulse="1"\':""} aria-hidden="true"></span><span class="vh">${w.dot==="pulse"?"live":w.dot==="hollow"?"quiet":"ended"}</span>`:"";return`<a class="navitem" href="${r(U)}"${Re?\' aria-current="page"\':""}>${Jt}${r(w.label)}${w.hint?`<span class="hint">${r(w.hint)}</span>`:""}</a>`}).join("")}</div>`).join(""),P=z(o).length,q=o.mode==="serve"?"Served from 127.0.0.1<br/>nothing leaves this machine."+(P>1?"<br/>alt+\\u2191\\u2193 switch session":""):"Self-contained report.<br/>0 network requests.",j=I(`<aside class="side">\n<div class="brand">${W(26)}<span class="name">orangu</span><span class="ver">v${r(o.version)}</span></div>\n<div class="sesscard"><div class="eyebrow">Session</div>${t?t.pickerHtml(o,C):`<div class="sid">${C?r(V(C.id))+" \\xB7 "+r(C.projectSlug||C.source):"\\u2013"}</div>`}</div>\n<div class="navwrap"><nav aria-label="Report">${B}</nav></div>\n<div class="side-foot">\n<button class="themebtn" id="btn-theme">\\u25D0 theme \\xB7 ${r(i.theme??"auto")}</button>\n<div class="note">${q}</div>\n</div>\n</aside>`);return j.querySelector("#btn-theme").addEventListener("click",()=>{let O=["auto","light","dark"],w=i.theme??"auto",U=O[(O.indexOf(w)+1)%3];p({theme:U==="auto"?void 0:U})}),t?.wirePicker(j,p),j}function $(d){let b=d.audience,C=I(`<header class="page-head">\n<div><h1>${r(Pn(i.screen))}</h1><div class="sub">${r(jn(d))}</div></div>\n<div class="page-tools">\n<div class="aud" role="group" aria-label="Detail level">\n<button id="aud-dev" aria-pressed="${b==="dev"}">Detailed</button>\n<button id="aud-plain" aria-pressed="${b==="plain"}">Plain language</button>\n</div>\n<button class="btn" id="btn-export">\\u2193 Export HTML</button>\n</div>\n</header>`);return C.querySelector("#aud-dev").addEventListener("click",()=>p({audience:void 0})),C.querySelector("#aud-plain").addEventListener("click",()=>p({audience:"plain"})),C.querySelector("#btn-export").addEventListener("click",()=>{let B=e.exportHref(i.s??"");if(B){location.href=B;return}let P=new Blob([`<!doctype html>\n`+document.documentElement.outerHTML],{type:"text/html"}),q=URL.createObjectURL(P),j=document.createElement("a");j.href=q,j.download=`orangu-${V(i.s??"report")}.html`,document.body.appendChild(j),j.click(),j.remove(),setTimeout(()=>URL.revokeObjectURL(q),2e3)}),C}let m=[],u="details[data-sid],details[id]",v=d=>d.dataset.sid??d.id;async function L(){h=Date.now(),c();let d=await k();document.title="orangu \\xB7 "+(d.a?.session.title||V(i.s??"")||"report");let b=Ln[i.screen]??je,C=i.screen==="repo"||i.screen==="global"||i.screen==="harness"?i.screen:void 0,B=d.aggLoading&&t?t.aggScreen():C?t?C==="harness"?t.harnessView(d):t.aggregateView(d):I(`<section>${Ht(C)}</section>`):b(d);B.classList.add("screen"),B.id="screen-"+i.screen;let P=I(\'<div class="page"></div>\');o.illustrative&&P.appendChild(I(\'<div class="sample-note" role="note"><b>Illustrative synthetic sample.</b> Its numbers come from made-up input, not a measured customer result.</div>\')),P.appendChild($(d)),P.appendChild(B);let q=I(\'<main class="main"></main>\');q.appendChild(P);let j=[];n.querySelectorAll(u).forEach(w=>j.push({id:v(w),open:w.open})),m=st(m,j);let O=n.querySelector(".main")?.scrollTop??0;n.innerHTML="",n.appendChild(S(d)),n.appendChild(q),n.querySelectorAll(u).forEach(w=>{m.includes(v(w))&&(w.open=!0)}),q.scrollTop=O,ge(n),fe(n),n.querySelectorAll("[data-turns]").forEach(w=>w.addEventListener("click",U=>{U.preventDefault();let Re=Number(w.dataset.turns.split(",")[0]);p({screen:"timeline",turn:Re},{push:!0})}))}window.addEventListener("hashchange",()=>{i=a(location.hash),L()}),window.addEventListener("keydown",d=>{if(!d.altKey||d.key!=="ArrowUp"&&d.key!=="ArrowDown"||i.screen!=="live")return;let b=z(o);if(b.length<2)return;let C=b.findIndex(P=>P.id===i.s),B=b[(C+(d.key==="ArrowDown"?1:b.length-1))%b.length];d.preventDefault(),p({s:B.id},{push:!0})}),e.subscribe(d=>{if(d.type==="session-updated"){let b=o.sessions.findIndex(C=>C.id===d.id);b>=0&&(o.sessions[b]=d.row),t?.invalidateHarness(),(i.s===d.id||i.screen==="live")&&g()}else if(d.type==="session-added")o.sessions.push(d.row),t?.invalidateHarness(),g();else if(d.type==="session-live"){let b=o.sessions.find(C=>C.id===d.id);b&&(b.badge=d.badge,b.ageMs=d.ageMs),i.screen==="live"&&g()}else if(d.type==="suggestion-updated")Kt(o,e,i.screen==="suggest",g);else if(d.type==="connection"){let b=f;f=d.state,Hn(d,o,e,i.screen==="suggest",g),b!==f&&g()}}),await L()}function zt(){let e=null,t=()=>{if(e)return e;if(window.__ORANGU__)return e=window.__ORANGU__,e;let n=document.getElementById("orangu-data");if(!n)return null;try{e=JSON.parse(n.textContent||"null")}catch{e=null}return e};return{mode:"file",async load(){let n=t();if(!n)throw new Error("no embedded data");return n},async session(n){let s=t();return s?.session&&s.session.session.id===n?s.session:null},async aggregate(){return null},async harness(){return null},async suggestions(){return t()?.suggestions??[]},async kickoff(n){let s=n.finding,o=ne(s,"report"),a={id:n.suggestionId??se(o),v:2,key:o,createdAt:0,source:"report",scope:s.scope,sessionIds:o.sessionIds,ruleId:s.ruleId,title:s.title,insightId:s.insightId,cohortFingerprint:s.cohortFingerprint,evidence:s.evidence,status:"new",statusAt:0},i=oe(a,"file");return{ok:!0,response:{record:a,commands:i,command:i.claude,spawned:!1}}},async setStatus(){return null},subscribe(){return()=>{}},exportHref(){return null}}}function Yt(){Gt(zt())}document.readyState==="loading"?document.addEventListener("DOMContentLoaded",Yt):Yt();})();\n';
var CLIENT_JS_SERVE = '"use strict";(()=>{var On=["live","overview","timeline","tools","agents","context","coverage","repo","global","harness","suggest"];function P(e){return e.slice(0,8)}function Y(e){return e.mode==="file"&&!e.capabilities.watch?[]:e.sessions.filter(t=>t.badge==="live")}function lt(e){return e.mode==="serve"&&Y(e).length>1?"live":"overview"}function ct(e,t){let n=t.audience==="plain"?"plain":"dev",s=Y(e),o=[];s.length>1&&o.push({id:"live-all",label:`All live \\xB7 ${s.length}`,screen:"live",dot:"pulse"});for(let g of s)o.push({id:"live-"+g.id,label:s.length>1?`${P(g.id)} \\xB7 ${g.projectSlug}`:`Watch \\xB7 ${P(g.id)}`,screen:"live",s:g.id,dot:"pulse"});let l=[{id:"overview",label:"Overview",screen:"overview"},{id:"timeline",label:"Timeline",screen:"timeline"},{id:"tools",label:"Tools & calls",screen:"tools"}];n==="dev"&&((e.session?.agents.runs.length??0)>0&&l.push({id:"agents",label:"Agents",screen:"agents"}),l.push({id:"context",label:"Context & tokens",screen:"context"}),l.push({id:"coverage",label:"Coverage",screen:"coverage"}));let i=e.aggregates.repo?.sessionCount,a=e.aggregates.global?.sessionCount,d=e.mode==="file"?"needs orangu serve":void 0,c=[{id:"repo",label:i!==void 0?`Repo \\xB7 ${i} sessions`:"Repo",screen:"repo",hint:i===void 0?d:void 0},{id:"global",label:"Global \\xB7 all time",screen:"global",hint:a===void 0?d:void 0},{id:"harness",label:"Harness",screen:"harness",hint:d}];return[{id:"live",label:"Live",items:o},{id:"session",label:"Observe this session",items:l},{id:"across",label:"Recurring patterns",items:c},{id:"improve",label:"Improve the next run",items:[{id:"suggest",label:"Suggestions",screen:"suggest"}]}]}function dt(e){let t={screen:"overview"},n=e.replace(/^#/,""),[s,o]=n.split("?");if(s&&On.includes(s)&&(t.screen=s),o)for(let l of o.split("&")){let i=l.indexOf("=");if(i<0)continue;let a=l.slice(0,i),d=decodeURIComponent(l.slice(i+1));a==="s"?t.s=d:a==="scope"&&(d==="session"||d==="repo"||d==="global")?t.scope=d:a==="tool"?t.tool=d:a==="cat"?t.cat=d:a==="agent"?t.agent=d:a==="turn"?t.turn=Number(d):a==="err"?t.errorsOnly=d==="1":a==="filter"&&(d==="all"||d==="errors"||d==="agents"||d==="human")?t.filter=d:a==="theme"?t.theme=d:a==="audience"&&(d==="dev"||d==="plain")&&(t.audience=d)}return t}function le(e,t){return Oe({...e,scope:void 0,tool:void 0,cat:void 0,agent:void 0,turn:void 0,errorsOnly:void 0,filter:void 0,...t})}function Oe(e){let t=[];return e.s&&t.push("s="+encodeURIComponent(e.s)),e.scope&&t.push("scope="+e.scope),e.tool&&t.push("tool="+encodeURIComponent(e.tool)),e.cat&&t.push("cat="+encodeURIComponent(e.cat)),e.agent&&t.push("agent="+encodeURIComponent(e.agent)),e.turn!==void 0&&t.push("turn="+e.turn),e.errorsOnly&&t.push("err=1"),e.filter&&t.push("filter="+e.filter),e.audience&&t.push("audience="+e.audience),e.theme&&t.push("theme="+e.theme),"#"+e.screen+(t.length?"?"+t.join("&"):"")}function $(e){return e>=1e9?(e/1e9).toFixed(e>=1e10?0:1)+"B":e>=1e6?(e/1e6).toFixed(e>=1e7?0:2)+"M":e>=1e3?(e/1e3).toFixed(e>=1e5?0:1)+"k":String(Math.round(e))}function C(e){if(e===void 0||!isFinite(e))return"\\u2013";if(e<1e3)return Math.round(e)+"ms";let t=e/1e3;if(t<60)return t.toFixed(t<10?1:0)+"s";let n=Math.floor(t/60);if(n<60)return n+"m "+Math.round(t%60)+"s";let s=Math.floor(n/60);return s<24?s+"h "+n%60+"m":Math.floor(s/24)+"d "+s%24+"h"}function A(e,t=0){return(e*100).toFixed(t)+"%"}function T(e,t,n=t+"s"){return`${j(e)} ${e===1?t:n}`}function j(e){return e.toLocaleString("en-US")}function ut(e){return e===void 0?"\\u2013":new Date(e).toISOString().slice(0,16).replace("T"," ")}function ge(e){return e===void 0?"--:--:--":new Date(e).toISOString().slice(11,19)}function fe(e){return e>=1<<20?(e/(1<<20)).toFixed(1)+" MB":e>=1024?Math.round(e/1024)+" KB":e+" B"}function r(e){return String(e??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/\'/g,"&#39;")}var se={read:"Read",search:"Search",edit:"Edit",write:"Write",exec:"Shell",agent:"Agents",skill:"Skills",web:"Web",plan:"Plan",ask:"Ask",mcp:"MCP",task:"Tasks",notebook:"Notebook",other:"Other"},Dn=["read","search","edit","write","exec","agent","skill","web","other"];function _(e){return`var(--cat-${Dn.includes(e)?e:"other"}, var(--cat-other))`}var Bn={clean:"The last check it ran passed",interrupted:"You stopped it",failing:"The last test run was failing"};function mt(e,t){let n=Bn[e]??"The agent completed its last task";return e==="clean"&&t&&De(t)?`${n}; ${t.testRunsFailed} of ${T(t.testRuns,"test run")} failed earlier`:n}function De(e){return e.testRunsFailed&&e.testRunsFailed<e.testRuns?"last run":""}function he(e,t){let n=[],s=new Map;for(let o of e){if(o.signature){n.push(o);continue}let{tool:l,total:i,sessions:a=0}=t(o),d=s.get(l)??{tool:l,total:0,signatures:0,sessions:0};d.total+=i,d.signatures++,d.sessions=Math.max(d.sessions,a),s.set(l,d)}return{kept:n,hidden:[...s.values()].sort((o,l)=>l.total-o.total)}}function gt(e){if(e.ending==="interrupted")return`Stopped by you after ${T(e.turns,"turn")}`;let t=Be(e);if(t.length)return t.join(" \\xB7 ");let n=T(e.humanTurns,"request");return e.toolCalls>0?`${n}, ${e.agents?T(e.agents,"subagent")+", ":""}nothing committed`:`${n}, no tool calls recorded`}function Be(e){let t=e.outcomes,n=[];t.prLinks.length&&n.push(T(t.prLinks.length,"PR")),t.gitCommits&&n.push(T(t.gitCommits,"commit"));let s=t.filesEdited+t.filesWritten;return s&&n.push(T(s,"file")+" changed"),t.buildRunsFailed&&n.push(`${t.buildRunsFailed} of ${T(t.buildRuns,"build run")} failed`),t.testRuns&&n.push(t.testRunsFailed?`${t.testRunsFailed} of ${T(t.testRuns,"test run")} failed`:`${T(t.testRuns,"test run")} green`),n}function ft(e){return{value:C(e.activeMs),note:e.wallMs!==void 0?`over ${C(e.wallMs)} wall \\xB7 ${C(e.humanWaitMs)} waiting for you`:"single-message session"}}function ht(e){let t=e.evidence,n=t.calls?.[0],s=n?.tool??n?.name??t.tools?.[0]?.name;if(typeof s=="string"&&s)return{tool:s};if(e.turnIndexes.length)return{turn:e.turnIndexes[0]}}function ve(e,t){return e.map(n=>{let s=t.findIndex(o=>o.ts!==void 0&&n.ts!==void 0&&o.ts>=n.ts);return{x:s<0?Math.max(0,t.length-1):s,label:"compaction @turn "+n.turnIndex}})}function be(e){if(!e)return"";let t=e.estimated?"~":"";return e.tokens?`save ${t}${$(e.tokens)} tokens`:e.ms?`save ${t}${C(e.ms)}`:""}function ye(e,t,n){if(!e||!e.tokens&&!e.ms)return;let s=`${e.estimated?"estimated":"measured"} by rule ${n}`;if(e.tokens&&t&&e.tokens<=t){let o=e.tokens/t;return{text:o<.005?"under 1% of this session":`~${A(o)} of this session`,title:`\\u2248${$(e.tokens)} tokens of the ${$(t)} this session measured; ${s}`}}return{text:be(e),title:e.tokens?`\\u2248${$(e.tokens)} tokens; ${s}`:`\\u2248${C(e.ms)}; ${s}`}}function vt(e,t){return!t||!e.tokens&&!e.ms?"":`${e.tokens?`\\u2248${$(e.tokens)} tokens`:`\\u2248${C(e.ms)}`} recoverable across ${T(t,"finding")}`}function bt(e){let t=e.summary,n=e.context,s=[];if(n.contextWindow&&t.contextPeak&&s.push(`context grew to ${A(t.contextPeak/n.contextWindow)} of the window`),t.totalTokens&&s.push(`${A(t.cacheHitRatio)} of tokens were cache reads`),t.totalTokens&&e.tokens.agents&&s.push(`${A(e.tokens.agents/t.totalTokens)} went to subagents`),!s.length)return"No token usage was recorded for this session.";let o=s.join("; ");return o[0].toUpperCase()+o.slice(1)+"."}function yt(e){let t=e.find(s=>s.id==="tests");return t?.tone==="good"?"passing":t?.tone==="bad"?"failing":e.some(s=>(s.id==="commits"||s.id==="prs")&&Number(s.value)>0)?"shipped":"\\u2013"}function oe(e,t,n){return e.filter(s=>s.turnIndex===t&&(!n||s.agentId===n))}function $t(e,t,n){let s=oe(e,t,n);if(!s.length)return[];let o=new Map;for(let l of s)o.set(l.category,(o.get(l.category)??0)+1);return[...o.entries()].map(([l,i])=>({cat:l,pct:i/s.length*100}))}function kt(e,t){let n=[...t].sort((l,i)=>l.turnIndex-i.turnIndex).filter(l=>l.turnIndex>(e[0]?.index??0)&&l.turnIndex<=(e[e.length-1]?.index??0)),s=[],o=e;for(let l of n){let i=o.filter(a=>a.index<l.turnIndex);o=o.filter(a=>a.index>=l.turnIndex),s.push({turns:i,after:l})}return s.push({turns:o,after:void 0}),s}function xt(e,t=600,n=104,s=8){let o=e.length;if(!o)return"";let l=Math.max(...e.map(i=>i.tokens),1e-4);return e.map((i,a)=>{let d=o===1?t/2:a/(o-1)*t,c=n-i.tokens/l*(n-s);return`${Math.round(d*10)/10},${Math.round(c*10)/10}`}).join(" ")}var qn={"claude-code":"Claude Code",cowork:"Cowork",desktop:"Desktop"};function wt(e){return qn[e]??e}function St(e,t){let n=[];for(let s of e.tools.calls)n.push({ts:s.startTs,name:s.name,category:s.category,summary:s.summary,durationMs:s.durationMs,isError:s.isError,agentType:s.agentId?"agent":void 0,key:s.toolUseId});for(let s of e.events)n.push({ts:s.ts,name:s.kind,category:"other",summary:s.label,key:"ev-"+s.turnIndex+"-"+s.kind});for(let s of e.agents.runs)n.push({ts:s.startTs,name:s.agentType||s.name||s.agentId,category:"agent",summary:s.taskKind??s.description??"subagent run",durationMs:s.durationMs,key:s.agentId});return n.sort((s,o)=>(s.ts??1/0)-(o.ts??1/0)||(s.key<o.key?-1:s.key>o.key?1:0)),n.slice(-t)}function pt(e){let t=Math.max(0,Math.round(e/1e3));if(t<60)return t+"s";let n=Math.floor(t/60);return n<60?n+"m":Math.floor(n/60)+"h"}function re(e){return e.badge!=="ended"&&e.possiblyLive?"Watching \\xB7 possibly live":e.badge==="ended"?"ended \\xB7 updated "+pt(e.ageMs)+" ago":"updated "+pt(e.ageMs)+" ago"}function Tt(e){if(!e.length)return 1/0;let t=e.map(s=>s.totalTokens).sort((s,o)=>o-s),n=Math.max(1,Math.floor(t.length*.2));return t[n-1]}function Rt(e,t){let n=new Set(t.map(l=>l.id)),s=e.filter(l=>!n.has(l)),o=t.filter(l=>l.open).map(l=>l.id);return[...new Set([...s,...o])]}function Et(e,t){let n=[];for(let s of e)for(let o of s.lastEvents??[])n.push({...o,sid:s.id});return n.sort((s,o)=>(s.ts??1/0)-(o.ts??1/0)||(s.sid<o.sid?-1:s.sid>o.sid?1:0)),n.slice(-t)}var Ct="orangu-brand-icon";var Wn=/^data:image\\/png;base64,[A-Za-z0-9+/]+={0,2}$/;function q(e=30){let t=`width="${e}" height="${e}" style="display:block"`,n=typeof document>"u"?void 0:document.getElementById(Ct)?.getAttribute("href");return!n||!Wn.test(n)?`<span class="logo" ${t} role="img" aria-label="orangu"></span>`:`<img class="logo" src="${n}" ${t} alt="orangu" draggable="false">`}var Ys=String.raw`\n.-"""-.\n/  o o  \\   orangu\n|  \\___/()o  see what your agent did\n\\_______/`;function w(e){let t=document.createElement("template");return t.innerHTML=e.trim(),t.content.firstElementChild}function $e(e){e.querySelectorAll("details").forEach(t=>{let n=t.querySelector("summary");n&&(n.setAttribute("role","button"),n.setAttribute("aria-expanded",String(t.open)),t.addEventListener("toggle",()=>n.setAttribute("aria-expanded",String(t.open))))})}function ke(e){e.querySelectorAll("[data-copy]").forEach(t=>{t.addEventListener("click",()=>{let n=t.getAttribute("data-copy")??"",s=()=>{let o=t.textContent;t.textContent="copied",setTimeout(()=>t.textContent=o,1200)};if(navigator.clipboard?.writeText)navigator.clipboard.writeText(n).then(s,s);else{let o=document.createElement("textarea");o.value=n,document.body.appendChild(o),o.select();try{document.execCommand("copy")}catch{}o.remove(),s()}})})}var It={"context window":"working memory","cache reads":"reused context","cache read":"reused context","cache writes":"saved context","cache write":"saved context","cache hits":"reused context",compactions:"memory refreshes",compaction:"memory refresh"};var Un=Object.keys(It).sort((e,t)=>t.length-e.length);function H(e,t){if(t!=="plain")return e;let n=e;for(let s of Un)n=n.split(s).join(It[s]);return n}function M(e,t,n="",s={}){let o=s.estimated?\'<span class="est" title="estimated: derived from bytes, not reported by the API">~</span>\':"";return`<div class="kpi${s.big?" big":""}${s.skeleton?" skel":""}"${s.title?` title="${r(s.title)}"`:""}>\n<div class="label">${r(e)}</div>\n<div class="val${s.accent?" accent":""}">${s.skeleton?"\\xB7\\xB7\\xB7":r(t)+o}</div>\n${n?`<div class="hint${s.badHint?" bad":""}">${r(n)}</div>`:""}\n</div>`}function K(e,t="$"){return`<div class="cmd"><span class="p" aria-hidden="true">${r(t)}</span><span class="txt">${r(e)}</span><button class="copy" data-copy="${r(e)}" aria-label="copy command">copy</button></div>`}function N(e){return`<div class="card"><div class="empty-hero">\n${q(e.mascotSize??48)}\n<div class="t">${r(e.title)}</div>\n${e.hint?`<div class="s">${r(e.hint)}</div>`:""}\n${e.command?K(e.command):""}\n</div></div>`}function Q(e){return`<div class="chart-empty">${r(e)}</div>`}function z(){return w(`<section>${N({title:"No session selected."})}</section>`)}function ie(e){return`<span class="mascot" style="display:block;width:${e}px;flex:none" aria-hidden="true">${q(e)}</span>`}function At(e,t={}){let n=e.reduce((i,a)=>i+a.value,0)||1,s=t.height??14,o=0,l=e.filter(i=>i.value>0).map(i=>{let a=i.value/n*100,d=`<rect x="${o}%" y="0" width="${a}%" height="${s}" fill="${i.color}"><title>${r(i.label)}</title></rect>`;return o+=a,d}).join("");return`<svg width="100%" height="${s}" viewBox="0 0 100 ${s}" preserveAspectRatio="none" role="img"${t.title?` aria-label="${r(t.title)}"`:""}>${l}</svg>`}function Mt(e,t,n={}){let s=n.width??720,o=n.height??160,l={l:4,r:4,t:8,b:16},i=e[0]?.length??0;if(i===0)return\'<div class="chart-empty">no data points yet</div>\';let a=s-l.l-l.r,d=o-l.t-l.b,c=new Array(i).fill(0),g=0;for(let f of e)for(let p=0;p<i;p++)g=Math.max(g,c[p]+(f[p]??0));let k=new Array(i).fill(0);for(let f of e)for(let p=0;p<i;p++)k[p]+=f[p]??0;g=n.yMaxOverride??Math.max(...k,1);let S=f=>l.l+(i===1?a/2:f/(i-1)*a),v=f=>l.t+d-f/g*d,m=new Array(i).fill(0),h=[];e.forEach((f,p)=>{let b=f.map((u,y)=>m[y]+(u??0)),F=`M ${S(0).toFixed(1)} ${v(m[0]).toFixed(1)}`;for(let u=0;u<i;u++)F+=` L ${S(u).toFixed(1)} ${v(b[u]).toFixed(1)}`;for(let u=i-1;u>=0;u--)F+=` L ${S(u).toFixed(1)} ${v(m[u]).toFixed(1)}`;F+=" Z",h.push(`<path d="${F}" fill="${t[p]??"var(--cat-other)"}" opacity="0.85"><title>${r(n.labels?.[p]??"")}</title></path>`);for(let u=0;u<i;u++)m[u]=b[u]});let R=(n.markers??[]).map(f=>{let p=S(f.x);return`<line x1="${p.toFixed(1)}" y1="${l.t}" x2="${p.toFixed(1)}" y2="${l.t+d}" stroke="${f.color??"var(--bad)"}" stroke-width="1.5" stroke-dasharray="3 2"><title>${r(f.label)}</title></line>`}).join(""),x=`<line x1="${l.l}" y1="${l.t+d}" x2="${l.l+a}" y2="${l.t+d}" stroke="var(--border2)" stroke-width="1"/>`;return`<svg width="100%" viewBox="0 0 ${s} ${o}" role="img" aria-label="stacked area">${h.join("")}${R}${x}</svg>`}function ce(e,t={}){let n=t.width??720,s=t.height??150,o={l:4,r:4,t:8,b:14},l=e.length;if(!l)return\'<div class="chart-empty">no data points yet</div>\';let i=n-o.l-o.r,a=s-o.t-o.b,d=t.yMax??Math.max(...e,1),c=x=>o.l+(l===1?i/2:x/(l-1)*i),g=x=>o.t+a-x/d*a,k="";e.forEach((x,f)=>{k+=(f===0?"M":"L")+" "+c(f).toFixed(1)+" "+g(x).toFixed(1)+" "});let S=t.color??"var(--accent-ink)",v=t.threshold?`<line x1="${o.l}" y1="${g(t.threshold.y).toFixed(1)}" x2="${o.l+i}" y2="${g(t.threshold.y).toFixed(1)}" stroke="var(--warn)" stroke-width="1" stroke-dasharray="4 3"><title>${r(t.threshold.label)}</title></line>`:"",m=(t.markers??[]).map(x=>`<line x1="${c(x.x).toFixed(1)}" y1="${o.t}" x2="${c(x.x).toFixed(1)}" y2="${o.t+a}" stroke="var(--bad)" stroke-width="1.5" stroke-dasharray="3 2"><title>${r(x.label)}</title></line>`).join(""),h=t.fmtY,R=h?`<text x="${o.l+2}" y="${o.t+8}" font-size="9" fill="var(--ink3)" font-family="var(--mono)">${r(h(d))}</text><text x="${o.l+2}" y="${o.t+a-3}" font-size="9" fill="var(--ink3)" font-family="var(--mono)">${r(h(0))}</text>`:"";return`<svg width="100%" viewBox="0 0 ${n} ${s}" role="img" aria-label="line chart">${v}<path d="${k}" fill="none" stroke="${S}" stroke-width="2" stroke-linejoin="round"/>${m}<line x1="${o.l}" y1="${o.t+a}" x2="${o.l+i}" y2="${o.t+a}" stroke="var(--border2)"/><line x1="${o.l}" y1="${o.t}" x2="${o.l}" y2="${o.t+a}" stroke="var(--border2)"/>${R}</svg>`}function Lt(e,t,n,s,o,l){let i=s-n||1,a=(e-n)/i*100,d=Math.max(.6,(t-e)/i*100);return`<svg width="100%" height="14" viewBox="0 0 100 14" preserveAspectRatio="none"><rect x="${a.toFixed(2)}" y="3" width="${d.toFixed(2)}" height="8" rx="3" fill="${o}"><title>${r(l)}</title></rect></svg>`}function xe(e,t){let n=Math.max(...e.map(s=>s.value),1);return e.map(s=>`<div class="proprow" style="display:grid;grid-template-columns:130px 1fr 72px;gap:10px;align-items:center;padding:3px 0">\n<div class="small" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r(s.label)}${s.sub?` <span class="muted">${r(s.sub)}</span>`:""}</div>\n<span class="trough"><i style="width:${(s.value/n*100).toFixed(1)}%;background:${s.color}"></i></span>\n<div class="right mono small">${r(t(s.value))}</div>\n</div>`).join("")}var we=50,Ft=12;function Gn(e,t,n){return t?e.conn==="reconnecting"?"reconnecting":t.badge==="ended"?"ended":n&&n.summary.toolCalls===0?"empty":e.data.mode==="file"?e.data.capabilities.watch?"file":"snapshot":t.badge==="idle"?"stalled":"live":"connecting"}function Se(e,t){return`<span class="bdot ${e}"${e==="p"?\' data-pulse="1"\':""} aria-hidden="true"></span>${t?`<span class="vh">${t}</span>`:""}`}var Z={pulse:Se("p","live"),hollow:Se("h","quiet"),good:Se("g","ended"),static:Se("s")},Ht=[Z.pulse,"","Refreshes as the transcript grows. Nothing leaves this machine."],Vn={connecting:[Z.static,"Connecting to orangu serve\\u2026","Waiting for the first event."],live:Ht,empty:Ht,stalled:[Z.hollow,"","No transcript growth lately; it may be waiting on you."],ended:[Z.good,"Session ended \\xB7 final numbers",""],reconnecting:[Z.hollow,"Connection lost \\xB7 retrying","The page reconnects on its own."],file:[Z.static,"Watching via orangu watch","Rewritten on every change; reload to refresh."],snapshot:[Z.static,"Static snapshot","This file does not update; orangu watch follows the session live."]};function Kn(e,t,n){let s=n?`turn <b style="color:var(--ink1)">${n.summary.turns}</b>${e==="ended"||e==="snapshot"?"":" in progress"}`:"",[o,l,i]=Vn[e],a=l,d=i;return e==="live"||e==="empty"?a=t?.possiblyLive?"Watching \\xB7 possibly live":"Watching a running session":e==="stalled"?a=`Watching \\xB7 quiet for ${Math.max(1,Math.round((t?.ageMs??0)/6e4))}m`:e==="ended"&&(d=t?re(t):""),`<div class="livebanner">${ie(44)}<div class="grow"><div class="lt">${o}<span aria-live="polite">${r(a)}</span></div><div class="ls">${r(d)}</div></div><div class="lr">${s}</div></div>`}function Te(e,t,n){let s=e.startTs!==void 0&&isFinite(t)?Lt(e.startTs,e.endTs??n,t,n||t+1,_("agent"),`${e.agentType??e.name??e.agentId} \\xB7 ${C(e.durationMs)} \\xB7 ${$(e.totalTokens)} tokens`):\'<div class="small muted">no timing</div>\';return`<div class="swimrow"><div class="alabel">${"\\xB7 ".repeat(e.spawnDepth)}${r(e.agentType||e.name||e.agentId.slice(0,10))} <small>${r(e.model??"")}</small></div><div${e.status==="running"?"":\' class="dim"\'}>${s}</div></div>`}function zn(e){let t=e.agents.runs;if(!t.length)return"";let n=t.filter(a=>a.status==="running"),s=Math.min(...t.map(a=>a.startTs??1/0).filter(isFinite)),o=Math.max(...t.map(a=>a.endTs??-1/0).filter(isFinite)),l=[...n,...t.filter(a=>a.status!=="running")].slice(0,Ft),i=t.length>Ft?`<div class="pagefoot"><button data-all-lanes="1">show all ${t.length} agents</button></div>`:"";return`<div class="card pad mb18"><div class="card-title">Agents \\xB7 ${n.length} running \\xB7 ${t.length-n.length} done</div><div class="agent-lanes">${l.map(a=>Te(a,s,o)).join("")}</div>${i}</div>`}function Jn(e,t,n){let s=Gn(e,t,n),o=n?.summary,l=!n,i=[M("Elapsed",o?.wallMs!==void 0?C(o.wallMs):"\\u2013","",{big:!0,skeleton:l}),M("Tokens so far",o?$(o.totalTokens):"\\u2013","",{big:!0,accent:!0,skeleton:l}),M("Tool calls",o?String(o.toolCalls):"\\u2013","",{big:!0,skeleton:l}),M("Cache hits",o?A(o.cacheHitRatio):"\\u2013","",{big:!0,skeleton:l})].join(""),a=n?.context,d=a?.contextWindow?a.final/a.contextWindow:void 0,c=s==="ended"?"\\u2013":`${T(o?.compactions??0,"compaction")} so far${d!==void 0&&d>=.75?" \\xB7 compaction likely near 90%":""}`,g=`<div class="card pad mb18">\n<div class="ctxhead"><span>Context window</span><span class="mono">${d!==void 0?r(A(d))+" of "+r($(a.contextWindow)):a?r($(a.final)):"\\u2013"}</span></div>\n<div class="ctxbar"><i style="width:${d!==void 0?(d*100).toFixed(1):0}%"></i></div>\n<div class="smt8">${r(c)}</div>\n</div>`,k=n?St(n,we+1):[],S=k.length>we,v=k.slice(-we).map(p=>`<div class="feedrow">${p.agentType?\'<span style="width:2px;align-self:stretch;background:var(--cat-agent);flex:none"></span>\':""}<span class="ft">${r(ge(p.ts))}</span><span class="sw" style="background:${_(p.category)}"></span><span class="fn">${r(p.name)}</span><span class="fw">${r(p.summary)}</span><span class="fd">${p.durationMs!==void 0?r(C(p.durationMs)):""}${p.isError?" \\xB7 error":""}</span></div>`).join(""),m=s==="connecting"?\'<div class="feedrow muted">Waiting for the first event\\u2026</div>\':\'<div class="feedrow muted">No tool calls yet.</div>\',h=[];t&&h.push(`streaming from \\u2026/${P(t.id)}.jsonl`),s==="ended"&&h.push("transcript closed"),S&&n&&h.push(`showing last ${we} of ${n.tools.calls.length+n.events.length+n.agents.runs.length} \\xB7 full list in Timeline`);let R=s==="ended"?`<a class="btn-sm" href="#overview${t?"?s="+r(t.id):""}" style="display:inline-block;margin-left:10px">Open Overview \\u2192</a>`:"",x=`<div class="feed" aria-live="off"><div class="card-head">Live feed</div>${v||m}<div class="feedfoot">${r(h.join(" \\xB7 "))}${R}</div></div>`,f=w(`<section>${Kn(s,t,n)}<div class="kpis k4">${i}</div>${g}${n?zn(n):""}${x}</section>`);return f.querySelector("[data-all-lanes]")?.addEventListener("click",p=>{if(!n)return;let b=f.querySelector(".agent-lanes");b.classList.add("swimbox");let F=Math.min(...n.agents.runs.map(y=>y.startTs??1/0).filter(isFinite)),u=Math.max(...n.agents.runs.map(y=>y.endTs??-1/0).filter(isFinite));b.innerHTML=n.agents.runs.map(y=>Te(y,F,u)).join(""),p.currentTarget.parentElement?.remove()}),f}function jt(e){let t=Y(e.data),n=/[?&]s=/.test(location.hash),s=typeof window<"u"?window.__ORANGU_FLEET__:void 0;if(t.length>1&&!n&&s)return s(e,t);let o=e.data.sessions.find(l=>l.id===(e.state.s??e.data.selectedId))??e.data.sessions[0];return o?Jn(e,o,e.a):w(`<section>${N({title:"No sessions discovered.",command:"orangu serve"})}</section>`)}function Re(e,t){return`<div class="banner ${e}">${t}</div>`}function J(e,t){let n=e.parse.reconciliation;if(!(e.parse.badLines>0||!n.ok))return"";if(t==="plain")return Re("warn",`Some of the transcript could not be read (${j(e.parse.badLines)} lines); the numbers may be low.`);let o=n.matchesWithinPct.toFixed(2);return Re("warn",`Parsed ${r(j(e.parse.totalLines-e.parse.badLines))} of ${r(j(e.parse.totalLines))} records \\xB7 token totals off by ${r(o)}% \\xB7 <a href="#coverage">see Coverage</a>`)}function B(e,t={}){let n=Object.entries(t.data??{}).map(([i,a])=>` data-${i}="${r(a)}"`).join(""),s="chip"+(t.active?" active":""),o=t.disabled?\' aria-disabled="true" tabindex="-1"\':"",l=t.removable?\'<button class="x" aria-label="remove filter">\\xD7</button>\':"";return`<button type="button" class="${s}"${o}${t.title?` title="${r(t.title)}"`:""}${n}>${r(e)}${l}</button>`}function _t(e){if(!e.length)return"";let t=e.map(n=>`<span class="sigchip">${r(n.label)} <b class="${r(n.tone)}"${n.detail?` title="${r(n.detail)}"`:""}>${r(String(n.value))}</b></span>`).join("");return`<details class="signals"><summary>${e.length} signals</summary><div class="chiprow">${t}</div></details>`}function qe(e,t,n={}){let s=ye(e.savings,n.sessionTotalTokens,e.ruleId),o=t==="plain"?"":`<span class="pill">${r(e.ruleId)}</span>`,l=e.turnIndexes.length&&t!=="plain"&&!n.link?`<div style="margin-top:10px"><button class="btn-sm" data-turns="${r(e.turnIndexes.join(","))}">Show ${T(e.turnIndexes.length,"turn")} \\u2192</button></div>`:"",i=e.detail?`<p>${r(H(e.detail,t))}</p>`:"",a=n.command?`<div class="fcmd"><div class="eyebrow">Draft a proposal</div>${K(n.command)}</div>`:"",d=n.link?`<div style="margin-top:10px"><a class="btn-sm" href="${r(n.link.href)}">${r(n.link.label)}</a></div>`:"";return`<details class="finding${n.open?" top":""}"${n.open?" open":""}>\n<summary><span class="chev" aria-hidden="true">\\u25B8</span><span class="sev ${r(e.severity)}" title="${r(e.severity)}"></span><b>${r(H(e.title,t))}</b>${s?`<span class="fsave" title="${r(s.title)}">${r(s.text)}</span>`:""}${o}</summary>\n<div class="fbody">\n${i}\n<div class="rec"><b>Fix.</b> ${r(H(e.recommendation,t))}</div>\n${d}${l}\n${a}\n</div>\n</details>`}var Pt={high:3,medium:2,low:1,info:0};function Nt(e,t){return(Pt[t.severity]??0)-(Pt[e.severity]??0)||t.totalSavingsTokens-e.totalSavingsTokens||t.sessions-e.sessions||e.ruleId.localeCompare(t.ruleId)}var qo=7*864e5;function Ot(e){return new TextEncoder().encode(e)}function Dt(e){let t=Ot(e),n=t.length,s=(n+8>>6)+1,o=new Uint32Array(s*16);for(let m=0;m<n;m++)o[m>>2]|=t[m]<<24-(m&3)*8;o[n>>2]|=128<<24-(n&3)*8;let l=n*8;o[s*16-1]=l>>>0,o[s*16-2]=Math.floor(l/4294967296)>>>0;let i=1732584193,a=4023233417,d=2562383102,c=271733878,g=3285377520,k=new Uint32Array(80),S=(m,h)=>m<<h|m>>>32-h;for(let m=0;m<o.length;m+=16){for(let b=0;b<16;b++)k[b]=o[m+b];for(let b=16;b<80;b++)k[b]=S(k[b-3]^k[b-8]^k[b-14]^k[b-16],1);let h=i,R=a,x=d,f=c,p=g;for(let b=0;b<80;b++){let F,u;b<20?(F=R&x|~R&f,u=1518500249):b<40?(F=R^x^f,u=1859775393):b<60?(F=R&x|R&f|x&f,u=2400959708):(F=R^x^f,u=3395469782);let y=S(h,5)+F+p+u+k[b]>>>0;p=f,f=x,x=S(R,30)>>>0,R=h,h=y}i=i+h>>>0,a=a+R>>>0,d=d+x>>>0,c=c+f>>>0,g=g+p>>>0}let v=m=>m.toString(16).padStart(8,"0");return v(i)+v(a)+v(d)+v(c)+v(g)}function ee(e){return[...new Set(e.map(t=>t.trim().replace(/\\\\/g,"/")).filter(Boolean))].sort()}function Bt(e){return Dt(JSON.stringify(ee(e))).slice(0,16)}function qt(e,t="finding"){let n=e.cohortFingerprint;if(e.scope==="session"){if(n!==void 0)throw new Error(`${t} session scope must omit cohortFingerprint`);return}if(typeof n!="string"||!/^[0-9a-f]{16}$/.test(n))throw new Error(`${t} repo/global scope requires a 16-hex cohortFingerprint`)}function Ee(e,t){return qt(e),{v:2,source:t,scope:e.scope,ruleId:e.ruleId,sessionIds:ee(e.sessionIds),...e.insightId?{insightId:e.insightId}:{},...e.cohortFingerprint?{cohortFingerprint:e.cohortFingerprint}:{}}}function Ce(e){let t=JSON.stringify({v:2,source:e.source,scope:e.scope,ruleId:e.ruleId,sessionIds:ee(e.sessionIds),insightId:e.insightId??null,...e.cohortFingerprint?{cohortFingerprint:e.cohortFingerprint}:{}});return"sg_"+Dt(t).slice(0,12)}function Yn(e){return btoa(Array.from(e,t=>String.fromCharCode(t)).join("")).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"")}function Xn(e){return JSON.stringify(e,(t,n)=>n&&typeof n=="object"&&!Array.isArray(n)?Object.fromEntries(Object.entries(n).sort(([s],[o])=>s<o?-1:s>o?1:0)):n)}var Uo=256*1024;function Qn(e,t="report"){qt(e);let n={...e,sessionIds:ee(e.sessionIds)};return Yn(Ot(Xn({v:2,source:t,finding:n})))}function Zn(e,t){if(t==="serve")return e.id;if(e.title&&e.evidence){let s={ruleId:e.ruleId,title:e.title,scope:e.scope,sessionIds:e.sessionIds,...e.insightId?{insightId:e.insightId}:{},...e.cohortFingerprint?{cohortFingerprint:e.cohortFingerprint}:{},evidence:e.evidence};return`${e.id} --finding ${Qn(s,e.source??"report")}`}let n=[...e.sessionIds].sort().join(",");return`${e.id} --rule ${e.ruleId} --scope ${e.scope} --session ${n}`}function Ie(e,t){let n=Zn(e,t);return{claude:`claude "/orangu:improve ${n}"`,codex:`$orangu-improve ${n}`}}var es=12,Ae=6,Ut="/plugin marketplace add NissanOhana/orangu \\xB7 /plugin install orangu",de=e=>typeof e=="string"&&e.trim().length>0;function We(e){let t=e.proposal;return!!t&&/^sg_[0-9a-f]{12}$/.test(e.id)&&Array.isArray(e.sessionIds)&&e.sessionIds.length>0&&e.sessionIds.every(de)&&de(t.title)&&de(t.change)&&/^[SML]$/.test(String(t.effort))&&de(t.proposalPath)&&(t.v??1)===1}function ts(e){let t=e.trim().replace(/[-_]+/g," ")||"finding";return t[0].toUpperCase()+t.slice(1)}var ns="Details hidden by redaction (they quote commands and result previews); re-run with --include-text to see them.";function Gt(e,t,n){return{title:t.trim()||ts(e),detail:n.trim()||ns}}function Ue(e){let t=e.boundedSavingsTokens??e.totalSavingsTokens,n=e.boundedSavingsMs??e.totalSavingsMs;return{...t?{tokens:t}:{},...n?{ms:n}:{},estimated:!0}}function Vt(e,t){let n=Gt(e.ruleId,e.title,e.detail);return{ruleId:e.ruleId,...n,recommendation:e.recommendation,savings:e.savings,sessionIds:t?[t]:[],insightId:e.id,severity:e.severity}}function ue(e,t,n){if(e==="session")return(t?.insights??[]).map(o=>Vt(o,t?.session.id));let s=n?Bt(n.sessions.map(o=>o.id)):void 0;return[...n?.crossFindings??[]].sort(Nt).map(o=>{let l=Gt(o.ruleId,o.title,`Recurs in ${T(o.sessions,"session")}.`);return{ruleId:o.ruleId,...l,savings:Ue(o),sessionIds:o.exampleSessionIds,sessions:o.sessions,severity:o.severity,...s?{cohortFingerprint:s}:{}}})}function Ge(e,t){return ss(e,t).command}function ss(e,t){let n=Ve(Vt(e,t),"session"),s=Ee(n,"report"),o=Ce(s);return{id:o,command:Ie({id:o,...n,sessionIds:s.sessionIds,source:"report"},"file").claude}}function Kt(e){let t=0,n=0;for(let s of e)t+=s.savings?.tokens??0,n+=s.savings?.ms??0;return{tokens:t,ms:n}}function Ve(e,t){return{ruleId:e.ruleId,title:e.title,scope:t,sessionIds:e.sessionIds,...e.insightId?{insightId:e.insightId}:{},...e.cohortFingerprint?{cohortFingerprint:e.cohortFingerprint}:{},evidence:{estimated:e.savings?.estimated??!0,sessions:e.sessions??1,...e.savings?.tokens!==void 0?{savingsTokens:e.savings.tokens}:{},...e.savings?.ms!==void 0?{savingsMs:e.savings.ms}:{}}}}function Me(e){return`claude "/orangu:harness --scope ${e}"`}function zt(e){if(e?.status!=="failed")return"";let t=e.kickoff?.error?.trim();return t?`Improvement workflow failed: ${t}`:"Improvement workflow failed. Copy the command to inspect it in Claude Code."}function Jt(e,t,n,s){let o,l=ee(t.sessionIds).join(`\n`);for(let i of e){if(!Array.isArray(i.sessionIds)||!i.sessionIds.every(c=>typeof c=="string"))continue;let a=i.id===s||Array.isArray(i.legacyIds)&&i.legacyIds.includes(s),d=i.v===1&&i.ruleId===t.ruleId&&i.scope===n&&ee(i.sessionIds).join(`\n`)===l&&(!t.insightId||!i.insightId||t.insightId===i.insightId);!a&&!d||(!o||i.statusAt>o.statusAt)&&(o=i)}return o}function Wt(e){return[e.id,...Array.isArray(e.legacyIds)?e.legacyIds:[],e.proposal?.proposalPath].filter(de)}function Yt(e,t,n,s,o){let l=new Set(t==="session"?n?[n]:[]:s);if(!l.size)return[];let i=new Set(o.flatMap(Wt)),a=[],d=[...e].sort((c,g)=>g.statusAt-c.statusAt);for(let c of d){if(c.scope!==t||!We(c)||!c.sessionIds.some(k=>l.has(k)))continue;let g=Wt(c);if(!g.some(k=>i.has(k))&&(g.forEach(k=>i.add(k)),a.push(c),a.length===es))break}return a}function Le(e,t,n){return le(e.state,{s:e.state.s??t.session.id,...n})}function os(e,t){return`<div class="hero overview-hero"><span class="overview-brand" aria-hidden="true">${q(64)}</span><div class="grow overview-copy"><div class="eyebrow">What happened</div><div class="herotitle">${r(gt(e.summary))}</div><div class="sg-sub">${r(H(e.summary.narrative,t))}</div></div></div>`}function rs(e){let t=e.summary,n=Be(t).join(" \\xB7 ")||"no commits, PRs or test runs detected",s=ft(t),o=t.totalTokens?`${A(t.cacheHitRatio)} read from cache \\xB7 ${$(e.tokens.byKind.output)} generated`:"no usage recorded",l=De(t.outcomes);return`<div class="triptych">\n<div class="axis q"><div class="aname">Quality \\u2191</div><div class="aval">${r(yt(e.quality.signals))}${l?` <span class="anote">(${l})</span>`:""}</div><div class="anote">${r(n)}</div>${_t(e.quality.signals)}</div>\n<div class="axis t"><div class="aname">Time \\u2193</div><div class="aval">${r(s.value)}</div><div class="anote">${r(s.note)}</div></div>\n<div class="axis c"><div class="aname">Tokens \\u2193</div><div class="aval">${r($(t.totalTokens))}</div><div class="anote">${r(o)}</div></div>\n</div>`}function Xt(e,t,n){if(!n)return`<div class="card pad mb16" style="background:var(--bg2);display:flex;align-items:center;gap:10px">${q(22)}<span class="muted">Nothing stood out. This session ran clean.</span></div>`;let s=ht(n),o=s?.tool?{href:Le(e,t,{screen:"timeline",tool:s.tool}),label:`See the ${s.tool} calls \\u2192`}:s?{href:Le(e,t,{screen:"timeline",turn:s.turn}),label:`See the ${T(n.turnIndexes.length,"turn")} \\u2192`}:void 0;return`<div class="eyebrow mb6">The one thing to improve</div>${qe(n,e.audience,{command:Ge(n,t.session.id),sessionTotalTokens:t.summary.totalTokens,open:!0,...o?{link:o}:{}})}`}function is(e){let t=e.context,n=t.series.filter(i=>!i.agentId),o=`${t.contextWindow?`peak ${A(e.summary.contextPeak/t.contextWindow)} of the window`:`peak ${$(e.summary.contextPeak)}`} \\xB7 ${T(e.summary.compactions,"compaction")}`;return`<div class="card pad"><div class="card-title">Context</div>${n.length?`<div class="spark">${ce(n.map(i=>i.contextSize),{width:320,height:60,markers:ve(t.compactions,n),yMax:t.contextWindow})}</div>`:""}<div class="small muted">${r(o)}</div></div>`}function Qt(e,t){let n=t.summary,s=ue("session",t,void 0).length;return`<nav class="card pad where-next" aria-label="Where to look next"><div class="card-title">Where to look next</div>${[{screen:"timeline",label:n.toolErrors?`Timeline \\xB7 ${T(n.toolErrors,"error")} only`:`Timeline \\xB7 ${j(n.turns)} turns`,state:n.toolErrors?{errorsOnly:!0}:{}},{screen:"tools",label:`Tools \\xB7 ${T(n.toolCalls,"call")}, ${T(n.toolErrors,"error")}`,state:{}},{screen:"suggest",label:s?`Suggestions \\xB7 ${T(s,"finding")}`:"Suggestions \\xB7 nothing to improve",state:{}}].map(l=>`<a data-screen="${l.screen}" href="${r(Le(e,t,{screen:l.screen,...l.state}))}">${r(H(l.label,e.audience))} \\u2192</a>`).join("")}</nav>`}function as(e,t){let n=t.summary.topInsightIds.map(l=>t.insights.find(i=>i.id===l)).filter(l=>!!l),s=n.slice(1).map(l=>qe(l,"dev",{command:Ge(l,t.session.id),sessionTotalTokens:t.summary.totalTokens})).join(""),o=vt(Kt(ue("session",t,void 0)),t.insights.length);return`${rs(t)}${Xt(e,t,n[0])}\n<div class="two-up mb16">${is(t)}${Qt(e,t)}</div>\n${e.harnessCard?.()??""}\n${o?`<p class="recoverable"><a href="${r(Le(e,t,{screen:"suggest"}))}">${r(o)} \\u2192</a></p>`:""}${s?`<h3 style="margin:4px 0 10px">More findings</h3>${s}`:""}`}function ls(e,t){let n=t.summary,o=t.turns.find(a=>a.kind==="human")?.promptPreview.slice(0,140)||(t.session.title?t.session.title:"(prompt text not included in this report)"),l=`${$(n.totalTokens)} tokens \\xB7 ${C(n.wallMs)}, of which ${C(n.humanWaitMs)} needed your attention`,i=t.insights.find(a=>a.id===n.topInsightIds[0])??t.insights[0];return`<div class="card mb16" style="overflow:hidden">\n<div class="card-head">${q(22)}What happened here</div>\n<div class="plaingrid">\n<div class="k">Goal</div><div>${r(o)}</div>\n<div class="k">How it ended</div><div>${r(mt(n.ending,n.outcomes))}</div>\n<div class="k">Tokens &amp; time</div><div>${r(l)}</div>\n</div>\n</div>\n${Xt(e,t,i)}\n${Qt(e,t)}`}function Ke(e){let t=e.a;if(!t)return w(`<section>${N({title:"No session selected.",hint:"Pick a session from the sidebar."})}</section>`);let n=e.audience==="plain"?ls(e,t):as(e,t);return w(`<section>${J(t,e.audience)}${os(t,e.audience)}${n}</section>`)}var Zt=10;function cs(e,t,n){let s=n.state;if(s.turn!==void 0&&t.index!==s.turn)return!1;let o=oe(e.tools.calls,t.index,s.agent);return!(s.filter==="errors"&&!o.some(l=>l.isError)||s.filter==="agents"&&t.agents.length===0&&!o.some(l=>l.agentId)||s.filter==="human"&&t.kind!=="human"||s.agent&&!t.agents.includes(s.agent)&&!o.length||(s.tool||s.cat||s.errorsOnly)&&(s.tool&&!o.some(l=>l.name===s.tool)||s.cat&&!o.some(l=>l.category===s.cat)||s.errorsOnly&&!o.some(l=>l.isError)))}function ds(e){let t=e.isCommand?"cmd":e.kind==="human"?"human":e.autoContinuations>0?"auto":e.kind;return`<span class="kind ${e.isCommand?"kcmd":e.kind==="human"?"khuman":""}">${r(t)}</span>`}function us(e,t){let n=e.promptPreview||e.commandName;return n?{text:n,own:!1}:{text:[e.promptChars?`${$(e.promptChars)}-char prompt`:"",e.activity].filter(Boolean).join(" \\xB7 ")||(t?"(no prompt)":"(prompt text not included)"),own:!0}}function ps(e,t,n,s,o){let i=$t(e.tools.calls,t.index,n.state.agent).map(h=>`<i style="width:${h.pct.toFixed(1)}%;background:${_(h.cat)}"></i>`).join(""),{text:a,own:d}=us(t,n.data.capabilities.includeText),c=d?\' style="color:var(--ink3)"\':"",g=oe(e.tools.calls,t.index,n.state.agent),k=g.map(h=>{let R=h.agentId?e.agents.runs.find(f=>f.agentId===h.agentId):void 0,x=h.agentId?R?.agentType||R?.name||h.agentId.slice(0,8):"main";return`<div class="evline"><span class="sw" style="background:${_(h.category)}"></span><span class="pill">${r(x)}</span><span class="en">${r(h.name)}</span><span class="ew">${r(h.summary)}</span><span class="tag ${h.isError?"bad":"good"}">${h.isError?"error":"ok"}</span><span class="ex">${[h.durationMs!==void 0?C(h.durationMs):"",h.resultBytes?fe(h.resultBytes):"",h.errorHint??""].filter(Boolean).map(r).join(" \\xB7 ")}</span></div>`}).join(""),S=t.agents.map(h=>{let R=e.agents.runs.find(f=>f.agentId===h);if(!R)return"";let x=R.hasTranscript?"":\' <span class="tag warn" title="only the parent summary was available">summary</span>\';return`<button class="btn-sm" data-agent-jump="${r(h)}">\\u25B8 ${r(R.agentType||R.name||h.slice(0,8))} \\xB7 ${r($(R.totalTokens))} tokens${x}</button>`}).join(" "),v=[t.firstResponseMs!==void 0?`first response ${C(t.firstResponseMs)}`:"",t.humanGapMs?`waited ${C(t.humanGapMs)}`:"",t.autoContinuations?`${t.autoContinuations} auto-continuations`:"",t.models.length?t.models.join(", "):"","context end "+(t.contextEnd?$(t.contextEnd):"\\u2013")].filter(Boolean).join(" \\xB7 "),m=C(t.durationMs??t.reportedDurationMs);return`<details class="turn${t.interrupted?" interrupted":""}" id="turn-${t.index}"${o?" open":""}>\n<summary>\n<span class="tnum">#${t.index}</span>\n<span class="tprompt"${c}>${ds(t)}${r(a)}</span>\n<span class="mixbar" title="tool mix">${i}</span>\n<span class="tcell">${g.length}\\u2699</span>\n<span class="tcell">${r(m)}</span>\n<span class="tcell${t.totalTokens>=s&&t.totalTokens>0?" hot":""}">${r($(t.totalTokens))}</span>\n</summary>\n<div class="tbody">\n<div class="tmeta">${r(v)}</div>\n${k||\'<p class="small muted" style="margin:0">No tool calls in this turn.</p>\'}\n${S?`<div class="pill-row">${S}</div>`:""}\n</div>\n</details>`}function en(e,t,n,s){return kt(t,e.context.compactions).map(o=>{let l=o.turns.map(a=>ps(e,a,n,s,n.state.turn===a.index)).join(""),i=o.after?`<div class="divider"><span class="mono">\\u21C5 context compacted at turn ${o.after.turnIndex}${o.after.contextBefore&&o.after.contextAfter?` \\xB7 ${$(o.after.contextBefore)} \\u2192 ${$(o.after.contextAfter)}`:""}</span></div>`:"";return l+i}).join("")}function nn(e){let t=e.a;if(!t)return z();let n=e.state,s=t.turns,o={all:s.length,errors:s.filter(f=>oe(t.tools.calls,f.index).some(p=>p.isError)).length,agents:s.filter(f=>f.agents.length>0||oe(t.tools.calls,f.index).some(p=>p.agentId)).length,human:s.filter(f=>f.kind==="human").length},l=n.filter??"all",i=[B(`All turns \\xB7 ${o.all}`,{active:l==="all",data:{filter:"all"}}),B(`Errors only \\xB7 ${o.errors}`,{active:l==="errors",data:{filter:"errors"}}),B(`With agents \\xB7 ${o.agents}`,{active:l==="agents",data:{filter:"agents"}}),B(`Human turns \\xB7 ${o.human}`,{active:l==="human",data:{filter:"human"}})].join(""),a=[];n.tool&&a.push(B("tool: "+n.tool,{active:!0,removable:!0,data:{clear:"tool"}})),n.cat&&a.push(B("category: "+n.cat,{active:!0,removable:!0,data:{clear:"cat"}})),n.agent&&a.push(B("agent: "+n.agent.slice(0,12),{active:!0,removable:!0,data:{clear:"agent"}})),n.turn!==void 0&&a.push(B("turn "+n.turn,{active:!0,removable:!0,data:{clear:"turn"}})),n.errorsOnly&&a.push(B("errors only",{active:!0,removable:!0,data:{clear:"err"}}));let d=s.filter(f=>cs(t,f,e)),c=Tt(s),g=d.length<=Zt||n.turn!==void 0||!!(n.tool||n.cat||n.agent||n.errorsOnly||n.filter&&n.filter!=="all"),k=g?d:d.slice(0,Zt),S=new Set(k.map(f=>f.index)),v=en(t,k,e,c),m=d.length?"":`<div class="card pad" style="background:var(--bg2);text-align:center"><p class="muted" style="margin:0 0 10px">No turns match \\xB7 ${r(l==="all"?"these filters":l)}</p><button class="btn-sm" data-clearall="1">Clear filters</button></div>`,h=g?"":`<div class="pagefoot">showing ${k.length} of ${d.length} turns \\xB7 <button data-showall="1">show all</button></div>`,R=H("expand a turn for every parent and subagent call \\xB7 the URL is the saved view",e.audience),x=w(`<section>\n${J(t,e.audience)}\n<div class="chiprow">${i}${a.join("")}<span class="small muted" style="margin-left:auto">${r(R)}</span></div>\n<div id="turnlist">${v}${m}${h}</div>\n</section>`);return x.querySelectorAll("[data-filter]").forEach(f=>f.addEventListener("click",()=>{let p=f.dataset.filter;e.go({filter:p==="all"?void 0:p,turn:void 0})})),x.querySelectorAll("[data-clear]").forEach(f=>f.addEventListener("click",()=>{let p=f.dataset.clear;p==="err"?e.go({errorsOnly:void 0}):p==="tool"?e.go({tool:void 0}):p==="cat"?e.go({cat:void 0}):p==="agent"?e.go({agent:void 0}):e.go({turn:void 0})})),x.querySelector("[data-clearall]")?.addEventListener("click",()=>e.go({filter:void 0,tool:void 0,cat:void 0,agent:void 0,turn:void 0,errorsOnly:void 0})),x.querySelector("[data-showall]")?.addEventListener("click",()=>{let f=x.querySelector("#turnlist");f.innerHTML=en(t,d,e,c),$e(f),tn(f,e)}),tn(x,e),n.turn!==void 0&&S.has(n.turn)&&setTimeout(()=>x.querySelector("#turn-"+n.turn)?.scrollIntoView({block:"center"}),0),x}function tn(e,t){e.querySelectorAll("[data-agent-jump]").forEach(n=>n.addEventListener("click",()=>t.go({screen:"agents",agent:n.dataset.agentJump},{push:!0})))}function Fe(e,t,n=""){let s=t?"no error text was recorded":\'text hidden; re-run with <span class="mono">--include-text</span>\';return`<div class="rrow"${n?` style="${n}"`:""}><span class="grow"><b>${r(e.tool)}</b> \\xB7 ${T(e.total,"error")} across ${T(e.signatures,"recurring signature")}</span>${e.sessions?`<span class="mono small muted">${e.sessions}+ sessions</span>`:""}<span class="small muted">${s}</span></div>`}var sn=12,ms=[[/ENOENT/,"run the build first, or check the path"],[/old_string not found|String to replace not found/i,"file changed since last read; re-read before editing"],[/EACCES|permission/i,"permission problem: check file modes"],[/timed? out/i,"raise the timeout or split the command"]];function gs(e){for(let[t,n]of ms)if(t.test(e))return n;return""}function on(e){let t=e.a;if(!t)return z();let n=t.tools,s=t.summary.toolCalls,o=n.byCategory.map(p=>`<span style="width:${s?(p.count/s*100).toFixed(1):0}%;background:${_(p.category)}" title="${r(se[p.category]??p.category)} \\xB7 ${p.count}"></span>`).join(""),l=n.byCategory.map(p=>`<span><i class="sw" style="background:${_(p.category)}"></i>${r(se[p.category]??p.category)} \\xB7 ${p.count}</span>`).join(""),i=n.parallelism,a=i.groups?`${i.parallelGroups} of ${i.groups} batches ran in parallel \\xB7 max ${i.maxGroupSize} at once`:"",d=Math.max(...n.byName.map(p=>p.totalMs),1),c=e.audience==="plain"?"one or more calls far above the rest":"one or more calls far above the rest; p95 is the typical worst case",g=p=>p.avgMs>p.p95Ms?`<td class="num" title="${c}">${r(C(p.avgMs))}<span class="outlier">outlier</span></td>`:`<td class="num">${r(C(p.avgMs))}</td>`,k=p=>p.map(b=>`<tr class="tool-row" data-tool="${r(b.name)}" title="${r(`${fe(b.resultBytesTotal)} output \\xB7 ${b.mainCount} main / ${b.agentCount} agent`)}">\n<td><i class="swd" style="background:${_(b.category)}"></i><span class="mono125">${r(b.name)}</span></td>\n<td class="num">${j(b.count)}</td>\n<td class="num"${b.errors?\' style="color:var(--bad)"\':\' style="color:var(--ink3)"\'}>${b.errors}</td>\n${g(b)}\n<td class="num p95col">${r(C(b.p95Ms))}</td>\n<td><span class="trough"><i style="width:${(b.totalMs/d*100).toFixed(1)}%;background:${_(b.category)}"></i></span></td>\n</tr>`).join(""),S=`<tr><th>Tool</th><th class="num">Calls</th><th class="num">Errors</th><th class="num">Avg</th><th class="num p95col">${e.audience==="plain"?"":"p95"}</th><th>Share of tool time</th></tr>`,v=n.byName.length>sn?`<div class="pagefoot"><button data-more-tools="1">show all ${n.byName.length} tools</button></div>`:"",{kept:m,hidden:h}=he(n.errorGroups,p=>({tool:p.name,total:p.count})),R=n.errorGroups.length?h.map(p=>Fe(p,e.data.capabilities.includeText)).join("")+m.slice(0,8).map(p=>{let b=p.sampleHint||gs(p.signature);return`<div class="rerow" style="font-size:13px"><div style="display:flex;gap:8px;align-items:center"><span class="sigline">${r(p.signature)}</span><span class="mono115" style="margin-left:auto">\\xD7${p.count}</span></div><div class="small muted" style="margin-top:2px">${r(p.name)}${b?" \\xB7 "+r(b):""}</div></div>`}).join(""):\'<p class="small" style="color:var(--good);margin:0">No tool errors in this session.</p>\',x=w(`<section>\n${J(t,e.audience)}\n<div class="card pad mb16">\n<div class="card-title">${r(H(`Calls by category \\xB7 ${s} total`,e.audience))}</div>\n<div class="catbar">${o}</div>\n<div class="legend">${l}</div>\n${a?`<div class="smt8">${r(a)} \\xB7 ${r(A(i.parallelCallShare))} of calls in a parallel batch</div>`:""}\n</div>\n<div class="card scroll-x mb16">\n<table class="grid"><thead>${S}</thead><tbody id="toolbody">${k(n.byName.slice(0,sn))}</tbody></table>\n${v}\n</div>\n<div class="card pad"><div class="card-title">Recurring errors in this session</div>${R}</div>\n</section>`),f=p=>{e.audience==="plain"&&p.querySelectorAll(".p95col").forEach(b=>b.remove()),p.querySelectorAll(".tool-row").forEach(b=>b.addEventListener("click",()=>e.go({screen:"timeline",tool:b.dataset.tool},{push:!0})))};return f(x),x.querySelector("[data-more-tools]")?.addEventListener("click",p=>{let b=x.querySelector("#toolbody");b.innerHTML=k(n.byName),f(b),p.currentTarget.parentElement?.remove()}),x}function pe(e){return N({title:"Across-session views need orangu serve",hint:`This single-file report carries one session. Start the local viewer to ${e==="repo"?"analyse this repository":e==="global"?"analyse everything on this machine":"compare your Claude Code config with what your sessions used"}. Nothing leaves your machine.`,command:"orangu serve"})}function ze(e){return`<div class="hero"><div class="grow"><div class="eyebrow">Recurring patterns</div><div class="herotitle">Choose major improvements from repeated evidence.</div><div class="sg-sub">Patterns across ${e==="repo"?"this repository":"supported sessions on this machine"} link back to example sessions. Review them before changing instructions, tools, skills, hooks, agents, plugins, or workflow configuration.</div></div><a class="btn" href="#suggest?scope=${e}">Review ${e} improvements \\u2192</a></div>`}function rn(e){let t=e.data.aggregates.repo;return t?w(`<section>${ze("repo")}${fs(t,e)}</section>`):w(`<section>${pe("repo")}</section>`)}function fs(e,t){return`<div class="kpis">${[M("Sessions",String(e.sessionCount)),M("Total tokens",$(e.totals.tokens),"",{accent:!0}),M("Per session",$(e.averages.tokensPerSession)),M("Per human turn",$(e.averages.tokensPerHumanTurn)),M("Cache hits",A(e.averages.cacheHitRatio)),M("Tool error rate",A(e.averages.toolErrorRate,1),"",{badHint:e.averages.toolErrorRate>=.03})].join("")}</div>${Je(e,t)}`}function Je(e,t){let n=e.crossFindings.length?e.crossFindings.slice(0,8).map(c=>`<div class="rrow"><span class="pill">${r(c.ruleId)}</span><span class="grow">${r(c.title)}</span><span class="mono small muted">${T(c.sessions,"session")}</span><span class="saveval">${r(be(Ue(c)))}</span></div>`).join(""):Q(e.sessionCount<2?"Patterns appear from 2 sessions on.":`No recurring findings across ${e.sessionCount} sessions.`),s=Math.max(...e.topReReadFiles.map(c=>c.totalReads),1),o=e.topReReadFiles.length?e.topReReadFiles.slice(0,8).map(c=>`<div class="rerow"><div class="rehead"><span class="mono grow ellip">${r(c.path)}</span><span class="mono115">${c.sessions} sess</span><span class="saveval">${c.totalReads} reads</span></div><span class="trough" style="height:6px;margin-top:5px"><i style="width:${(c.totalReads/s*100).toFixed(1)}%"></i></span></div>`).join(""):Q("No heavily re-read files."),{kept:l,hidden:i}=he(e.recurringErrors,c=>({tool:c.tool,total:c.total,sessions:c.sessions})),a=e.recurringErrors.length?`<div class="card mb16" style="overflow:hidden"><div class="card-head">Recurring errors \\xB7 environment problems to fix once</div>${i.map(c=>Fe(c,t.data.capabilities.includeText,"padding:10px 18px")).join("")}${l.slice(0,8).map(c=>`<div class="rrow" style="padding:10px 18px"><span class="sigline">${r(c.signature)}</span><span class="kind">${r(c.tool)}</span><span class="mono small muted">${T(c.sessions,"session")}</span><span class="mono125">\\xD7${c.total}</span></div>`).join("")}</div>`:"",d=e.topSessions.slice(0,10).map(c=>{let g=[c.prs?`${c.prs} PR`:"",c.commits?`${c.commits} commits`:"",c.interruptions?`interrupted \\xD7${c.interruptions}`:""].filter(Boolean).join(" \\xB7 ")||"\\u2013";return`<tr>\n<td><a class="mono" style="font-size:12px" ${t.data.mode==="serve"?`href="#overview?s=${r(c.id)}"`:`href="#" title="open with: orangu report ${r(c.id.slice(0,8))}" aria-disabled="true" onclick="return false"`}>${r(c.id.slice(0,8))}</a></td>\n<td class="ellip" style="max-width:280px;color:var(--ink2)">${r(c.title??"")}</td>\n<td class="num">${c.turns}</td>\n<td class="num">${c.toolCalls}</td>\n<td class="num"${c.toolErrors?\' style="color:var(--bad)"\':""}>${c.toolErrors}</td>\n<td class="num" style="font-weight:700">${r($(c.tokens))}</td>\n<td class="small muted">${r(g)}</td>\n</tr>`}).join("");return`<div class="two-up">\n<div class="card pad"><div class="card-title">Recurring findings \\xB7 ranked by evidence</div><div class="cardsub">patterns one session cannot establish</div>${n}</div>\n<div class="card pad"><div class="card-title">Most re-read files</div><div class="cardsub">context carried again and again \\xB7 trim or index these</div>${o}</div>\n</div>\n${a}\n<div class="card scroll-x">\n<div class="card-head"><span>Heaviest sessions</span><span style="margin-left:auto;font-weight:400;font-size:12px;color:var(--ink3)">sorted by tokens</span></div>\n<table class="grid"><thead><tr><th>Session</th><th>Title</th><th class="num">Turns</th><th class="num">Calls</th><th class="num">Errors</th><th class="num">Tokens</th><th>Outcome</th></tr></thead><tbody>${d}</tbody></table>\n</div>\n${e.sessionCount?"":`<div style="margin-top:16px">${Q("Analysing sessions\\u2026")}</div>`}\n<p class="small muted" style="margin-top:12px">${T(e.sessionCount,"session")} \\xB7 every figure is a token count reported by the API.</p>`}var an=["Instruction files","Scripts and CLIs","Hooks","Skills to create","Skills to discover","Subagents and agents","MCP servers","Plugins","Workflow and configuration"];var Ye=e=>e?.verificationTrusted===!0;function ln(e){return e==="kicked-off"?"running":e==="rejected"?"dismissed":e??"new"}function cn(e,t="",n=!1){let s=e!=="verified"||n,o=s?e==="verified"?"verified comparison":e:"legacy unverified";return`<span class="status-chip" data-status="${s?e:"legacy"}" aria-live="polite"${t?` title="${r(t)}"`:""}>${o}${e==="verified"&&s?" \\u2713":""}</span>`}function te(e){return typeof e!="string"?"":e.trim().slice(0,600)}function X(e,t){let n=te(t);return n?`<div class="sg-pfield"><b>${e}.</b> ${r(n)}</div>`:""}function He(e,t,n){if(!Array.isArray(t))return"";let s=t.slice(0,Ae).map(o=>n&&o&&typeof o=="object"?n.map(l=>te(o[l])).filter(Boolean).join(" \\xB7 "):te(o)).filter(Boolean);return s.length?`<div class="sg-pfield"><b>${e}.</b><ul>${s.map(o=>`<li>${r(o)}</li>`).join("")}${t.length>Ae?`<li class="muted">+${t.length-Ae} more</li>`:""}</ul></div>`:""}function hs(e){let t=e.proposal;return e.scope==="global"||e.status!=="proposed"||t?.v!==1||!te(t.manifestPath)||!te(t.workspace?.cwd)||!Array.isArray(t.files)||t.files.length===0?"":`<div class="sg-handoffs" aria-label="Apply handoff"><div class="small muted">Copy only. Nothing runs here.</div><div class="sg-hand"><span>Claude</span>${K(`claude "/orangu:apply ${e.id}"`)}</div></div>`}function dn(e){return`<div class="sg-handoffs"><div class="sg-hand"><span>Claude</span>${K(e.claude)}</div></div>`}function un(e){if(!e||!We(e))return"";let t=e.proposal,n=e.verificationReceipt,s=Ye(e),o=n?.v===1&&s?X("Later evidence",n.summary)+He("Computed comparisons",n.checks,["name","evidence"]):e.status==="verified"?X("Legacy state","Not verified under the current deterministic contract."):e.application?.v===1?X("Applied",e.application.summary):"";return`<div class="sg-proposal"><div class="sg-phead"><span class="eyebrow">Proposal</span>${t.changeClass?`<span class="pill">${r(t.changeClass)}</span>`:""}<span class="pill">effort ${r(t.effort)}</span></div><div class="sg-ptitle">${r(te(t.title))}</div>${X("Change",t.change)}${X("Evidence",t.evidence)}${X("Expected effect",t.expectedEffect)}${X("Risk",t.risk)}${X("Verification",t.verification)}${He("Reviewed comparisons",t.verificationChecks,["metric","comparison"])}${He("Files",t.files)}${He("Sources",t.sources,["kind","label","url","verifiedAt"])}${o}${hs(e)}</div>`}function vs(e){return`<details class="saved-proposal" id="saved-${r(e.id)}"><summary><span class="chev" aria-hidden="true">\\u25B8</span><b>${r(te(e.proposal?.title))}</b>${cn(ln(e.status),"",Ye(e))}</summary><div class="saved-proposal-body">${un(e)}</div></details>`}function bs(e,t){if(t!=="serve")return"";let n=e.length?e.map(vs).join(""):\'<p class="small muted" style="margin:0">Nothing yet. A proposal drafted by /orangu:improve for this scope lands here.</p>\';return`<section class="sg-inbox card pad mb16" aria-label="Saved proposals"><div class="sg-inbox-head"><div class="card-title">Saved proposals \\xB7 ${e.length}</div><span class="eyebrow">Localhost only</span></div>${n}</section>`}function ys(e){return e==="serve"?"The proposal appears below under Saved proposals.":"The proposal is saved under ~/.orangu; open orangu serve to review it."}function $s(e,t,n,s,o){let l=e.audience,i=ye(t.savings,e.state.scope===void 0||e.state.scope==="session"?e.a?.summary.totalTokens:void 0,t.ruleId),a=o?.proposal?.effort,d=ln(o?.status),c=zt(o),g=e.a?.session.cwd,k=t.sessionIds.map(S=>e.data.mode==="serve"?`<a class="exch" href="#overview?s=${r(S)}">${r(S.slice(0,8))}</a>`:`<span class="exch">${r(S.slice(0,8))}</span>`).join("");return`<details class="finding" data-sid="${r(s)}" data-rule="${r(t.ruleId)}">\n<summary><span class="chev" aria-hidden="true">\\u25B8</span><span class="rank">${n}</span>${t.severity?`<span class="sev ${r(t.severity)}" title="${r(t.severity)}"></span>`:""}<b class="sg-t">${r(H(t.title,l))}</b>${i?`<span class="fsave sg-save" title="${r(i.title)}">${r(i.text)}</span>`:""}${a?`<span class="pill">effort ${r(a)}</span>`:""}</summary>\n<div class="fbody sg-body">\n<div class="sg-ev"><b>Evidence.</b> ${r(H(t.detail,l))} ${l==="plain"?"":`<span class="pill">${r(t.ruleId)}</span>`}</div>\n${t.recommendation?`<div class="rec sg-fix"><b>Fix.</b> ${r(H(t.recommendation,l))}</div>`:""}\n<div class="sg-ex"><span class="small muted">example sessions:</span>${k}</div>\n${un(o)}\n<div class="kickrow">\n<span class="mono115">handled by</span>\n<span class="pill">orangu:improve</span>\n${cn(d,c,Ye(o))}\n</div>\n<ol class="steps" aria-label="Hand off to Claude Code">\n<li><button type="button" class="btn-sm" data-kick-copy="${r(s)}">Copy improve command</button></li>\n<li><div><span>Paste it in Claude Code${g?` in <span class="mono">${r(g)}</span>`:""}.</span><div class="small muted" style="margin:6px 0 4px">Needs the plugin once, typed inside Claude Code:</div>${K(Ut,">")}</div></li>\n<li><span>${ys(e.data.mode)}</span></li>\n</ol>\n<div class="kick-cmd sg-cmd">${e.data.mode==="serve"&&o&&!o.proposal&&d!=="dismissed"?dn(Ie(o,"serve")):""}</div>\n<div class="kick-msg small muted" aria-live="polite">${r(c)}</div>\n</div>\n</details>`}function pn(e){let t=e.a,n=e.state.scope??"session",s=e.data.aggregates.repo?.sessionCount,o=e.data.aggregates.global?.sessionCount,l=[B("This session",{active:n==="session",data:{scope:"session"}}),B(s!==void 0?`Repo \\xB7 ${s}`:"Repo",{active:n==="repo",disabled:s===void 0,title:s===void 0?"run orangu serve":"",data:{scope:"repo"}}),B(o!==void 0?`Global \\xB7 ${o}`:"Global",{active:n==="global",disabled:o===void 0,title:o===void 0?"run orangu serve":"",data:{scope:"global"}})].join(""),i=n==="session"?void 0:e.data.aggregates[n],a=ue(n,t,i).map(u=>{let y=Ve(u,n);return{row:u,finding:y,sid:Ce(Ee(y,"report"))}}),d=new Map(a.map(u=>[u.sid,u])),c=a.map(u=>({...u,record:Jt(e.data.suggestions,u.row,n,u.sid)})),g=c.flatMap(({record:u})=>u?[u]:[]),k=i?.sessions.map(u=>u.id)??[],S=e.data.mode==="serve"?Yt(e.data.suggestions,n,t?.session.id??e.state.s??e.data.selectedId,k,g):[],v=H(n==="session"?"One finding, one bounded proposal. Verify it on a later run before calling it an improvement.":n==="repo"?"Recurring repo patterns for larger harness changes. Apply only after review.":"Recurring global patterns. Global suggestions are proposal-only.",e.audience),m=c.length?c.map((u,y)=>$s(e,u.row,y+1,u.sid,u.record)).join(""):N({title:"Nothing to improve was found",hint:"Ran clean. Re-run after your next session."}),h=an.map(u=>`<span class="sigchip">${r(u)}</span>`).join(""),R=c.length?`<details class="card pad mb16 sg-note"><summary><span class="chev" aria-hidden="true">\\u25B8</span>What a proposal can change</summary><div class="chiprow mt8">${h}</div></details>`:"",x=n==="session"||!i?"":e.megaReview?.(n)??"",f="The evidence is deterministic; an optional AI skill drafts the proposal. "+(n==="session"?"Only a later session in the same workspace can verify it.":n==="repo"?"Applied means the reviewed files changed; only a later session can verify it.":"Global suggestions stay proposals; nothing is applied from here."),p=w(`<section>\n<div class="hero">\n${ie(48)}\n<div class="grow sg-hero"><div class="herotitle">Improvement plan</div><div class="sg-sub">${r(v)}</div></div>\n</div>\n<div class="chiprow">${l}</div>\n${n!=="session"&&!i?N({title:"This scope needs orangu serve",command:"orangu serve"}):m+R}\n${bs(S,e.data.mode)}\n${x}\n<p class="small muted sg-foot">${f}</p>\n</section>`);p.querySelectorAll("[data-scope]").forEach(u=>u.addEventListener("click",()=>{if(u.getAttribute("aria-disabled")==="true")return;let y=u.dataset.scope;e.go({scope:y==="session"?void 0:y})}));let b=t?.session.cwd;return(u=>{p.querySelectorAll(u).forEach(y=>y.addEventListener("click",()=>{let I=y.closest("details"),W=I.querySelector(".kick-msg"),O=y.dataset.kickCopy,G=O?d.get(O):void 0;if(!G)return;y.setAttribute("aria-busy","true");let D={mode:"copy",suggestionId:O,finding:G.finding};e.ds.kickoff(D).then(E=>E.ok?{kind:"copied",message:`Claude command copied. Paste it in Claude Code${b?` in ${b}`:""}.`,response:E.response}:{kind:"error",message:E.message,...E.response?{response:E.response}:{}}).then(E=>{if(y.removeAttribute("aria-busy"),W.textContent=E.message,"response"in E&&E.response?.commands){let V=I.querySelector(".kick-cmd");V.innerHTML=dn(E.response.commands),ke(V),E.kind==="copied"&&V.querySelector("[data-copy]")?.click()}})}))})("[data-kick-copy]"),p}var Xe=24;function mn(e){let t=e.a;if(!t)return z();let n=t.agents;if(!n.runs.length)return w(`<section>${N({title:"No subagents in this session.",hint:"This session ran entirely on the main thread."})}</section>`);let s=Math.min(...n.runs.map(c=>c.startTs??1/0).filter(isFinite)),o=Math.max(...n.runs.map(c=>c.endTs??-1/0).filter(isFinite)),l=n.runs.slice(0,Xe).map(c=>Te(c,s,o)).join(""),i=xe(n.byType.map(c=>({label:c.agentType,value:c.tokens,color:_("agent"),sub:"\\xD7"+c.count})),c=>$(c)),a=n.runs.map(c=>`<tr data-agent="${r(c.agentId)}" class="agent-row"${e.state.agent===c.agentId?\' style="background:var(--accent-weak)"\':""}>\n<td>${"\\xB7 ".repeat(c.spawnDepth)}${r(c.agentType||c.name||c.agentId.slice(0,8))}${c.hasTranscript?"":\' <span class="tag warn" title="only the parent summary was available">summary</span>\'}</td>\n<td>${r(c.model??"\\u2013")}</td>\n<td class="num">${r(C(c.durationMs))}</td>\n<td class="num">${c.toolCallCount}${c.toolErrors?` <span class="tag bad">${c.toolErrors}</span>`:""}</td>\n<td class="num">${r($(c.totalTokens))}</td>\n</tr>`).join(""),d=w(`<section>\n${J(t,e.audience)}\n<div class="card pad" style="margin-bottom:16px">\n<div class="card-title">${n.runs.length} subagent runs \\xB7 ${r(A(1-n.mainThreadShare.tokens))} of tokens \\xB7 max depth ${n.maxDepth} \\xB7 up to ${n.maxConcurrency} parallel</div>\n<div class="swimbox">${l}</div>\n${n.runs.length>Xe?`<div class="pagefoot muted small">showing ${Xe} of ${n.runs.length} lanes \\xB7 all runs in the table below</div>`:""}\n</div>\n<div class="two-up">\n<div class="card pad"><div class="card-title">Tokens by agent type</div>${i}</div>\n<div class="card scroll-x"><table class="grid"><thead><tr><th>Agent</th><th>Model</th><th class="num">Duration</th><th class="num">Tools</th><th class="num">Tokens</th></tr></thead><tbody>${a}</tbody></table></div>\n</div>\n</section>`);return d.querySelectorAll("[data-agent]").forEach(c=>c.addEventListener("click",()=>e.go({screen:"timeline",agent:c.dataset.agent},{push:!0}))),d}function ae(e,t,n=""){return`<div class="card pad${n?" "+n:""}"><div class="card-title">${e}</div>${t}</div>`}function gn(e){let t=e.a;if(!t)return z();let n=t.context,s=n.series.filter(v=>!v.agentId),o=ve(n.compactions,s),l=ce(s.map(v=>v.contextSize),{threshold:n.contextWindow?{y:n.contextWindow,label:"window "+$(n.contextWindow)}:void 0,markers:o,yMax:n.contextWindow,fmtY:$}),i=Mt([s.map(v=>v.cacheRead),s.map(v=>v.cacheWrite),s.map(v=>v.input),s.map(v=>v.output)],["var(--cat-read)","var(--cat-edit)","var(--cat-write)","var(--cat-agent)"],{markers:o,labels:["cache read","cache write","fresh input","output"]}),a=t.tokens,d=[{value:a.byKind.cacheRead,color:"var(--cat-read)",label:"cache read "+$(a.byKind.cacheRead)},{value:a.byKind.cacheWrite5m,color:"var(--cat-skill)",label:"cache write 5m "+$(a.byKind.cacheWrite5m)},{value:a.byKind.cacheWrite1h,color:"var(--cat-edit)",label:"cache write 1h "+$(a.byKind.cacheWrite1h)},{value:a.byKind.input,color:"var(--cat-write)",label:"fresh input "+$(a.byKind.input)},{value:a.byKind.output,color:"var(--cat-agent)",label:"output "+$(a.byKind.output)}],c=xe(a.byModel.map(v=>({label:v.displayName,value:v.totalTokens,color:_("edit"),sub:v.estimatedMatch?"~est. match":""})),v=>$(v)),g=a.serverToolRequests.webSearch+a.serverToolRequests.webFetch,k=ce(a.byTurn.map(v=>v.cumulativeTokens),{color:"var(--accent-ink)",fmtY:$}),S=[ae("Token composition per request",`<div class="scroll-x">${i}</div><div class="legend">${["read","edit","write","agent"].map((v,m)=>`<span><i class="sw" style="background:var(--cat-${v})"></i>${["cache read","cache write","fresh input","output"][m]}</span>`).join("")}</div>`,"mb16"),ae("By model",`${c}<p class="small muted" style="margin-top:8px">Main thread ${r($(a.mainThread))} \\xB7 agents ${r($(a.agents))}</p>`,"mb16"),ae("Cumulative tokens over turns",`<div class="scroll-x">${k}</div>`)].join("");return w(`<section>\n${J(t,e.audience)}\n<p class="ctx-lead">${r(bt(t))}</p>\n<div class="kpis">\n${M("Peak context",$(n.peak),n.contextWindow?A(n.peak/n.contextWindow)+" of "+$(n.contextWindow):"")}\n${M("Cache hit ratio",A(n.cacheHitRatio,1),"context re-read rather than re-sent")}\n${M("Context re-read",n.reReadMultiplier.toFixed(1)+"\\xD7","context carried \\xF7 peak")}\n${M("Long-lived cache writes",A(n.cacheWrite1hShare),"of cache writes (the 1h tier)")}\n${M("Fixed weight per request",$(n.baseline),"system + tools + CLAUDE.md, every request")}\n${M("Compactions",String(n.compactions.length),n.compactions.length?"context was reset":"none")}\n</div>\n${ae("Context size over the session",`<div class="scroll-x">${l}</div><div class="legend"><span>Each point is one API request; dashed lines are compactions.</span></div>`,"mb16")}\n${ae(`Where the tokens went \\xB7 ${r($(a.totalTokens))} total`,`${At(d,{height:22})}<div class="legend">${d.filter(v=>v.value>0).map(v=>`<span><i class="sw" style="background:${v.color}"></i>${r(v.label)}</span>`).join("")}</div>${g?`<div class="smt8">${T(g,"server-tool request")} (web search/fetch), counted per request, not in tokens</div>`:""}`,"mb16")}\n<details class="more-charts"><summary><span class="chev" aria-hidden="true">\\u25B8</span>More charts \\xB7 composition per request, by model, cumulative</summary><div class="mt8">${S}</div></details>\n</section>`)}var Qe="\\u2039stripped\\u203A";function fn(e){let t=e.a;if(!t)return z();let n=t.parse,s=n.reconciliation,o=Object.entries(n.unknownRecordTypes).filter(([m])=>m!==Qe),l=n.unknownRecordTypes[Qe]??0,i=o.length,a=l?`<div class="small muted">${T(l,"unrecognized record")} were counted; their type names are hidden by redaction. Re-run with --include-text to see them.</div>`:"",d=t.skills.byName.length?`<div class="card pad mt16"><div class="card-title">Skills &amp; commands used</div><div class="pill-row">${t.skills.byName.map(m=>`<span class="sigchip">${r(m.name)} <span class="muted">\\xD7${m.count} ${r(m.via.join("/"))}</span></span>`).join("")}</div></div>`:"",c=t.hooks.runs?`<div class="card pad mt16"><div class="card-title">Hooks</div><p class="small muted" style="margin:0">${t.hooks.runs} hook runs \\xB7 ${t.hooks.errors} errors \\xB7 ${r(C(t.hooks.totalMs))} total</p></div>`:"",g=w(`<section>\n${Re(s.ok?"info":"warn",`<strong>Parse coverage:</strong>&nbsp;${r(j(n.totalLines))} records, ${n.badLines} unreadable, ${T(i,"unrecognized record type")}${l?` (+${l} record${l===1?"":"s"} with redacted type names)`:""}. Token totals reconcile to within ${r(s.matchesWithinPct.toFixed(2))}% ${s.ok?"\\u2713":"(review)"}.`)}\n<div class="two-up">\n<div class="card pad"><div class="card-title">Session</div>\n<table class="grid"><tbody>\n<tr><td>ID</td><td class="mono small">${r(t.session.id)}</td></tr>\n<tr><td>Source</td><td>${r(t.session.source)}</td></tr>\n<tr><td>Project</td><td class="mono small">${r(t.session.cwd??t.session.projectSlug??"\\u2013")}</td></tr>\n<tr><td>Started</td><td>${r(ut(t.session.startedAt))}</td></tr>\n<tr><td>Client</td><td>${r(t.session.clientVersions.join(", "))}</td></tr>\n<tr><td>Models</td><td>${t.session.models.map(m=>r(m.displayName)+(m.estimatedMatch?" ~":"")).join(", ")}</td></tr>\n<tr><td>Branches</td><td class="mono small">${r(t.session.gitBranches.join(", ")||"\\u2013")}</td></tr>\n<tr><td>Generated</td><td>orangu v${r(t.generator.version)} \\xB7 model catalog ${r(t.generator.modelCatalogUpdatedAt)}</td></tr>\n</tbody></table>\n</div>\n<div class="card pad"><div class="card-title">How to read the numbers</div>\n<ul class="small" style="padding-left:18px;line-height:1.7;margin:0">\n<li><strong>Tokens are the only usage metric</strong> orangu reports. They are what the transcript records.</li>\n<li>Token usage is <strong>deduplicated by message id</strong>.</li>\n<li>Context = fresh input + cache read + cache write.</li>\n<li>~ marks a model matched by family fallback: the name is approximate, the token counts are not.</li>\n<li>No LLM produced any number here; zero network calls.</li>\n</ul>\n</div>\n</div>\n${i||l?`<div class="card pad mt16"><div class="card-title">Unrecognized records (counted, not dropped)</div>${i?`<div class="pill-row">${o.map(([m,h])=>`<span class="pill">${r(m)} \\xD7${h}</span>`).join("")}</div>`:""}${a}</div>`:""}\n${d}\n${c}\n<div class="card pad mt16">\n<div class="card-title">Raw explorer</div>\n<div class="raw-filter no-print">\n<input type="text" id="raw-q" placeholder="filter by text\\u2026" aria-label="filter calls by text" />\n<select id="raw-cat" aria-label="filter by category"><option value="">all categories</option>${Object.keys(se).map(m=>`<option value="${r(m)}">${r(se[m])}</option>`).join("")}</select>\n<label class="small"><input type="checkbox" id="raw-err" /> errors only</label>\n<span class="small muted" id="raw-count"></span>\n</div>\n<div id="raw-list" style="max-height:480px;overflow:auto;border-top:1px solid var(--border)"></div>\n</div>\n</section>`),k=g.querySelector("#raw-list"),S=g.querySelector("#raw-count"),v=()=>{let m=g.querySelector("#raw-q").value.toLowerCase(),h=g.querySelector("#raw-cat").value,R=g.querySelector("#raw-err").checked,x=t.tools.calls.filter(f=>(!h||f.category===h)&&(!R||f.isError)&&(!m||f.summary.toLowerCase().includes(m)||f.name.toLowerCase().includes(m)));S.textContent=x.length+" of "+t.tools.calls.length+" calls",k.innerHTML=x.slice(0,2e3).map(f=>`<div class="rawrow"><span class="rt">${r(f.name)}</span><span class="muted">#${f.turnIndex}${f.agentId?" agent":""}${f.isError?" \\u26A0":""}</span><span class="rp">${r(f.summary)}${f.durationMs!==void 0?" \\xB7 "+r(C(f.durationMs)):""}</span></div>`).join("")+(x.length>2e3?`<div class="rawrow muted">\\u2026${x.length-2e3} more (narrow the filter)</div>`:""),x.length||(k.innerHTML=\'<div class="rawrow muted">no calls match</div>\')};return g.querySelector("#raw-q").addEventListener("input",v),g.querySelector("#raw-cat").addEventListener("change",v),g.querySelector("#raw-err").addEventListener("change",v),v(),g}var ks={live:jt,overview:Ke,timeline:nn,tools:on,suggest:pn,agents:mn,context:gn,coverage:fn},xs={live:"Live",overview:"Overview",timeline:"Timeline",tools:"Tools & calls",repo:"Repo",global:"Global",harness:"Harness",suggest:"Improve the next outcome",agents:"Agents",context:"Context & tokens",coverage:"Coverage"};function ws(e){return xs[e]??"Overview"}function Ss(e){let t=e.a,n=e.audience;switch(e.state.screen){case"live":{let s=Y(e.data);if(s.length>1)return`${s.length} running sessions \\xB7 ${s.reduce((l,i)=>l+(i.agentsRunning??0),0)} agents active`;let o=e.data.sessions.find(l=>l.id===(e.state.s??e.data.selectedId));return o?`${P(o.id)} \\xB7 ${re(o)}`:""}case"overview":return t?H(`outcome and evidence \\xB7 ${P(t.session.id)} \\xB7 ${t.summary.turns} turns \\xB7 ${t.summary.toolCalls} tool calls`,n):"";case"timeline":return t?H(`every step and tool call \\xB7 ${t.summary.turns} turns \\xB7 ${t.summary.toolErrors} errors`,n):"";case"tools":return t?H(`${t.summary.toolCalls} tool calls \\xB7 ${t.tools.byName.length} tools`,n):"";case"repo":return`${e.data.aggregates.repo?e.data.aggregates.repo.sessionCount+" sessions \\xB7 ":""}recurring evidence in this repository`;case"global":return`${e.data.aggregates.global?e.data.aggregates.global.sessionCount+" sessions \\xB7 ":""}recurring evidence across this machine`;case"harness":return"declared vs used, in tokens";case"suggest":return e.state.scope==="repo"||e.state.scope==="global"?"recurring patterns \\xB7 bounded proposals \\xB7 whole-harness review":"one finding \\xB7 one bounded proposal";case"agents":return t?`${t.agents.runs.length} runs \\xB7 up to ${t.agents.maxConcurrency} parallel`:"";case"context":return t?`peak ${j(t.context.peak)} \\xB7 ${t.context.compactions.length} compactions`:"";case"coverage":return t?`${j(t.parse.totalLines)} records \\xB7 ${t.parse.badLines} unreadable`:"";default:return""}}async function hn(e,t,n,s){try{e.suggestions=await t.suggestions(),n&&s()}catch{}}async function Ts(e,t,n,s,o){e.type==="connection"&&e.state==="connected"&&await hn(t,n,s,o)}async function vn(e,t){let n=document.getElementById("app");if(!n)return;let s=null;try{s=await e.load()}catch{s=null}if(!s){n.innerHTML=`<div class="page"><div class="card"><div class="empty-hero">${q(48)}<div class="t">No analysis data in this file.</div><div class="s mono">node dist/orangu.js report</div></div></div></div>`;return}let o=s,l=u=>{let y=dt(u);return u.replace(/^#/,"")||(y.screen=lt(o)),y.s||(y.s=o.selectedId),y},i=l(location.hash),a=async u=>{if(!u)return o.session;if(o.mode!=="serve")return o.session&&o.session.session.id===u?o.session:await e.session(u)??o.session;let y=await e.session(u);return y||(o.session&&o.session.session.id===u?o.session:void 0)},d=()=>{let u=document.documentElement;i.theme==="dark"?u.setAttribute("data-theme","dark"):i.theme==="light"?u.setAttribute("data-theme","light"):u.removeAttribute("data-theme")},c=(u,y={})=>{i={...i,...u};let I=Oe(i);y.push?history.pushState(null,"",I):history.replaceState(null,"",I),F()},g,k=async()=>({data:o,a:await a(i.s),ds:e,state:i,audience:i.audience==="plain"?"plain":"dev",conn:g,aggLoading:t?i.screen==="harness"?t.ensureHarness(e,h):t.ensureAggregate(o,e,i,h):!1,megaReview:t?.megaReview,harnessCard:t?()=>t.harnessCard(e,h,le(i,{screen:"harness"})):void 0,go:c}),S=!1,v=0,m=600;function h(){if(S)return;S=!0;let u=Math.max(0,v+m-Date.now());setTimeout(()=>{S=!1,F()},u)}function R(u){let y=ct(o,i),I=o.sessions.find(U=>U.id===i.s)??o.sessions[0],W=y.filter(U=>U.items.length).map(U=>`<div class="navgroup"><div class="navgroup-label">${r(U.label)}</div>${U.items.map(E=>{let V=le(i,{screen:E.screen,s:E.s??i.s,scope:i.scope}),Ne=i.screen===E.screen&&(E.s===void 0||E.s===i.s),Nn=E.dot?`<span class="ldot${E.dot==="hollow"?" hollow":E.dot==="ended"?" done":""}"${E.dot==="pulse"?\' data-pulse="1"\':""} aria-hidden="true"></span><span class="vh">${E.dot==="pulse"?"live":E.dot==="hollow"?"quiet":"ended"}</span>`:"";return`<a class="navitem" href="${r(V)}"${Ne?\' aria-current="page"\':""}>${Nn}${r(E.label)}${E.hint?`<span class="hint">${r(E.hint)}</span>`:""}</a>`}).join("")}</div>`).join(""),O=Y(o).length,G=o.mode==="serve"?"Served from 127.0.0.1<br/>nothing leaves this machine."+(O>1?"<br/>alt+\\u2191\\u2193 switch session":""):"Self-contained report.<br/>0 network requests.",D=w(`<aside class="side">\n<div class="brand">${q(26)}<span class="name">orangu</span><span class="ver">v${r(o.version)}</span></div>\n<div class="sesscard"><div class="eyebrow">Session</div>${t?t.pickerHtml(o,I):`<div class="sid">${I?r(P(I.id))+" \\xB7 "+r(I.projectSlug||I.source):"\\u2013"}</div>`}</div>\n<div class="navwrap"><nav aria-label="Report">${W}</nav></div>\n<div class="side-foot">\n<button class="themebtn" id="btn-theme">\\u25D0 theme \\xB7 ${r(i.theme??"auto")}</button>\n<div class="note">${G}</div>\n</div>\n</aside>`);return D.querySelector("#btn-theme").addEventListener("click",()=>{let U=["auto","light","dark"],E=i.theme??"auto",V=U[(U.indexOf(E)+1)%3];c({theme:V==="auto"?void 0:V})}),t?.wirePicker(D,c),D}function x(u){let y=u.audience,I=w(`<header class="page-head">\n<div><h1>${r(ws(i.screen))}</h1><div class="sub">${r(Ss(u))}</div></div>\n<div class="page-tools">\n<div class="aud" role="group" aria-label="Detail level">\n<button id="aud-dev" aria-pressed="${y==="dev"}">Detailed</button>\n<button id="aud-plain" aria-pressed="${y==="plain"}">Plain language</button>\n</div>\n<button class="btn" id="btn-export">\\u2193 Export HTML</button>\n</div>\n</header>`);return I.querySelector("#aud-dev").addEventListener("click",()=>c({audience:void 0})),I.querySelector("#aud-plain").addEventListener("click",()=>c({audience:"plain"})),I.querySelector("#btn-export").addEventListener("click",()=>{let W=e.exportHref(i.s??"");if(W){location.href=W;return}let O=new Blob([`<!doctype html>\n`+document.documentElement.outerHTML],{type:"text/html"}),G=URL.createObjectURL(O),D=document.createElement("a");D.href=G,D.download=`orangu-${P(i.s??"report")}.html`,document.body.appendChild(D),D.click(),D.remove(),setTimeout(()=>URL.revokeObjectURL(G),2e3)}),I}let f=[],p="details[data-sid],details[id]",b=u=>u.dataset.sid??u.id;async function F(){v=Date.now(),d();let u=await k();document.title="orangu \\xB7 "+(u.a?.session.title||P(i.s??"")||"report");let y=ks[i.screen]??Ke,I=i.screen==="repo"||i.screen==="global"||i.screen==="harness"?i.screen:void 0,W=u.aggLoading&&t?t.aggScreen():I?t?I==="harness"?t.harnessView(u):t.aggregateView(u):w(`<section>${pe(I)}</section>`):y(u);W.classList.add("screen"),W.id="screen-"+i.screen;let O=w(\'<div class="page"></div>\');o.illustrative&&O.appendChild(w(\'<div class="sample-note" role="note"><b>Illustrative synthetic sample.</b> Its numbers come from made-up input, not a measured customer result.</div>\')),O.appendChild(x(u)),O.appendChild(W);let G=w(\'<main class="main"></main>\');G.appendChild(O);let D=[];n.querySelectorAll(p).forEach(E=>D.push({id:b(E),open:E.open})),f=Rt(f,D);let U=n.querySelector(".main")?.scrollTop??0;n.innerHTML="",n.appendChild(R(u)),n.appendChild(G),n.querySelectorAll(p).forEach(E=>{f.includes(b(E))&&(E.open=!0)}),G.scrollTop=U,$e(n),ke(n),n.querySelectorAll("[data-turns]").forEach(E=>E.addEventListener("click",V=>{V.preventDefault();let Ne=Number(E.dataset.turns.split(",")[0]);c({screen:"timeline",turn:Ne},{push:!0})}))}window.addEventListener("hashchange",()=>{i=l(location.hash),F()}),window.addEventListener("keydown",u=>{if(!u.altKey||u.key!=="ArrowUp"&&u.key!=="ArrowDown"||i.screen!=="live")return;let y=Y(o);if(y.length<2)return;let I=y.findIndex(O=>O.id===i.s),W=y[(I+(u.key==="ArrowDown"?1:y.length-1))%y.length];u.preventDefault(),c({s:W.id},{push:!0})}),e.subscribe(u=>{if(u.type==="session-updated"){let y=o.sessions.findIndex(I=>I.id===u.id);y>=0&&(o.sessions[y]=u.row),t?.invalidateHarness(),(i.s===u.id||i.screen==="live")&&h()}else if(u.type==="session-added")o.sessions.push(u.row),t?.invalidateHarness(),h();else if(u.type==="session-live"){let y=o.sessions.find(I=>I.id===u.id);y&&(y.badge=u.badge,y.ageMs=u.ageMs),i.screen==="live"&&h()}else if(u.type==="suggestion-updated")hn(o,e,i.screen==="suggest",h);else if(u.type==="connection"){let y=g;g=u.state,Ts(u,o,e,i.screen==="suggest",h),y!==g&&h()}}),await F()}function yn(e){return e.length>1&&e.endsWith("/")?e.slice(0,-1):e}async function je(e){try{let t=await fetch(e,{headers:{accept:"application/json"}});return!t.ok&&t.status!==202?{status:t.status,body:null}:{status:t.status,body:await t.json()}}catch{return{status:0,body:null}}}async function bn(e){let t=Date.now();for(;;){let{status:n,body:s}=await je(e);if(n===200&&s)return s;if(n!==202||Date.now()-t>12e4)return null;await new Promise(o=>setTimeout(o,800))}}function $n(e=""){let t=new Map,n=new Set,s=null,o=i=>{for(let a of n)a(i)},l=()=>{if(!s){s=new EventSource(e+"/events"),s.onopen=()=>o({type:"connection",state:"connected"}),s.onerror=()=>o({type:"connection",state:"reconnecting"});for(let i of["hello","session-updated","session-live","session-added","suggestion-updated"])s.addEventListener(i,a=>{try{o(JSON.parse(a.data))}catch{}})}};return{mode:"serve",async load(){let i=/[?&#]s=([^&]+)/.exec(location.hash)?.[1],{body:a}=await je(e+"/api/app"+(i?`?s=${encodeURIComponent(i)}`:""));if(!a)throw new Error("orangu serve unreachable");return a.session&&t.set(a.session.session.id,{at:Date.now(),analysis:a.session}),a},async session(i){let a=Date.now(),d=t.get(i);if(d?.inflight)return d.inflight;if(d&&a-d.at<2e3)return d.analysis;let c=je(e+"/api/session/"+encodeURIComponent(i)).then(({body:g})=>(t.set(i,{at:Date.now(),analysis:g}),g));return t.set(i,{at:a,analysis:d?.analysis??null,inflight:c}),c},async aggregate(i,a){return bn(i==="repo"?e+"/api/repo"+(a?`?cwd=${encodeURIComponent(a)}`:""):e+"/api/global")},async harness(){return bn(e+"/api/harness")},async suggestions(){let{body:i}=await je(e+"/api/suggestions");return i??[]},async kickoff(i){let a;try{a=await fetch(e+"/api/kickoff",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(i)})}catch(c){return{ok:!1,kind:"network",message:c instanceof Error?c.message:"localhost request failed"}}let d=null;try{d=await a.json()}catch{}return a.ok?!d?.record||typeof d.command!="string"||!d.commands||typeof d.commands.claude!="string"||typeof d.commands.codex!="string"||d.command!==d.commands.claude||d.spawned!==!1?{ok:!1,kind:"protocol",status:a.status,message:"localhost returned an incomplete kickoff response",...d?{response:d}:{}}:{ok:!0,response:d}:{ok:!1,kind:"http",status:a.status,message:d?.error||`localhost request failed (${a.status})`,...d?{response:d}:{}}},async setStatus(i,a){try{let d=await fetch(e+"/api/suggestions/"+encodeURIComponent(i)+"/status",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({status:a})});return d.ok?await d.json():null}catch{return null}},subscribe(i){return n.add(i),l(),()=>{n.delete(i)}},exportHref(i){return i?e+"/export/"+encodeURIComponent(i)+".html":null}}}function kn(e){let t=e.data.aggregates.global;if(!t)return w(`<section>${pe("global")}</section>`);let n=new Map;for(let g of t.sessions)n.set(g.source,(n.get(g.source)??0)+1);let s=[M("Sessions",String(t.sessionCount),T(n.size,"source")),M("Total tokens",$(t.totals.tokens),A(t.averages.cacheHitRatio)+" read from cache",{accent:!0}),M("Per session",$(t.averages.tokensPerSession)),M("Active time",C(t.totals.activeMs),"of "+C(t.totals.wallMs)+" wall"),M("Per human turn",$(t.averages.tokensPerHumanTurn)),M("Shipped",`${t.totals.prs} PRs`,`${t.totals.commits} commits`)].join(""),o=t.byWeek.filter(g=>g.sessions>0).length,l=t.byWeek.map(g=>g.tokens).filter(g=>g>0),i=l.length?`${$(Math.min(...l))} \\u2013 ${$(Math.max(...l))} / week`:"",a=o>=2?`<svg viewBox="0 0 600 110" style="width:100%;height:110px;display:block" preserveAspectRatio="none" role="img"><title>Weekly token trend</title><polyline points="${xt(t.byWeek)}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round"></polyline><line x1="0" y1="104" x2="600" y2="104" stroke="var(--border2)" stroke-width="1"></line></svg>\n<div style="display:flex;justify-content:space-between;font-family:var(--mono);font-size:10.5px;color:var(--ink3);margin-top:4px"><span>12w ago</span><span>8w</span><span>4w</span><span>this week</span></div>`:Q("not enough history for a trend"),d=(g,k)=>{if(!g.length)return Q("nothing here yet");let S=Math.max(...g.map(v=>v.tokens),1e-4);return g.slice(0,6).map(v=>`<div class="rollrow"><div class="rollhead"><span class="mono">${r(v.key)}</span><span class="muted" style="font-size:11.5px">${T(v.count,"session")}</span><span class="mono" style="margin-left:auto;font-weight:700">${r($(v.tokens))}</span></div><span class="trough" style="margin-top:5px"><i style="width:${(v.tokens/S*100).toFixed(1)}%;background:${k}"></i></span></div>`).join("")},c=[...n.entries()].sort((g,k)=>k[1]-g[1]).map(([g,k])=>`<span class="sigchip">${r(wt(g))} \\xB7 ${k}</span>`).join("");return w(`<section>${ze("global")}\n<div class="kpis">${s}</div>\n<div class="card pad mb16">\n<div style="display:flex;align-items:baseline;gap:10px;margin-bottom:8px"><span style="font-weight:700;font-size:13.5px">Weekly tokens \\xB7 last 12 weeks</span><span class="mono small muted">${r(i)}</span></div>\n${a}\n</div>\n<div class="two-up">\n<div class="card pad"><div class="card-title">Tokens by model</div>${d(t.byModel,"var(--accent)")}</div>\n<div class="card pad"><div class="card-title">Tokens by project</div>${d(t.byProject,"var(--cat-agent)")}</div>\n</div>\n<div class="chiprow mb16">${c}<span class="small muted" style="align-self:center">a session is a session, wherever it ran</span></div>\n${Je(t,e)}\n</section>`)}var Ze=12,xn=e=>{let t=e.inventory;return!t.settings.length&&!t.skills.length&&!t.agents.length&&!t.plugins.length&&!t.mcpServers.length&&!t.claudeMd.length};function wn(e){let t=e.crosswalk,n=t.skills.filter(a=>a.status==="idle").length,s=e.inventory.totals.skills,o=s?n?`${n} of ${s} skills never fired`:`every one of ${s} skills fired`:"no skills installed",l=[...t.injectedListings].sort((a,d)=>d.approxTokensPerSession-a.approxTokensPerSession)[0],i=l?`${l.type} \\u2248${j(l.approxTokensPerSession)} tokens per session, every session`:`${j(e.scope.sessionsScanned)} sessions scanned`;return{title:o,sub:i}}function tt(e){return e.length?`<div class="pill-row">${e.slice(0,Ze).map(n=>`<span class="pill">${r(n)}</span>`).join("")}${e.length>Ze?`<span class="small muted">+${e.length-Ze} more</span>`:""}</div>`:""}function et(e,t,n,s,o){let l=n?t.length?`<div class="aval">${t.length}<span class="anote"> of ${n} ${s}</span></div>${tt(t)}`:`<p class="small" style="color:var(--good);margin:0">Every one of ${n} ${o}.</p>`:\'<p class="small muted" style="margin:0">None declared in the config that was read.</p>\';return`<div class="card pad"><div class="card-title">${e}</div>${l}</div>`}function Sn(e,t){let n=e===void 0?{title:"Comparing what your config declares with what these sessions used\\u2026",sub:"a cold cache takes a moment"}:e===null?{title:"The harness report could not be computed.",sub:"orangu harness prints the reason"}:xn(e)?{title:"no harness config found under the scanned roots",sub:"settings.json \\xB7 skills/ \\xB7 agents/ \\xB7 plugins/ \\xB7 .mcp.json \\xB7 CLAUDE.md"}:wn(e);return`<a class="card pad mb16 harness-card" href="${r(t)}"${e===void 0?\' aria-busy="true"\':""}><div class="eyebrow">Harness</div><div class="card-title" style="margin:2px 0">${r(n.title)}</div><div class="small muted">${r(n.sub)} \\xB7 open the harness view \\u2192</div></a>`}function Tn(e,t){if(!t)return w(`<section>${N({title:"The harness report could not be computed.",hint:"Run the verb directly for the reason.",command:"orangu harness"})}</section>`);if(xn(t))return w(`<section>${N({title:"No harness config found under the scanned roots.",hint:`Looked for settings.json \\xB7 skills/ \\xB7 agents/ \\xB7 plugins/ \\xB7 .mcp.json \\xB7 CLAUDE.md under ${t.scope.roots.join(", ")}. Nothing to cross-reference.`,command:"orangu harness"})}</section>`);let n=t.crosswalk,s=t.inventory,o=wn(t),l=n.skills.filter(m=>m.status==="idle").map(m=>m.name),i=n.mcpServers.filter(m=>m.status==="idle").map(m=>m.name),a=n.agents.filter(m=>m.status==="idle").map(m=>m.name),d=[...n.skills.filter(m=>m.status==="undeclared").map(m=>"skill "+m.name),...n.mcpServers.filter(m=>m.status==="undeclared").map(m=>"mcp "+m.name),...n.agents.filter(m=>m.status==="undeclared").map(m=>"agent "+m.name)],c=n.injectedListings.length?`<div class="scroll-x"><table class="grid"><thead><tr><th>Listing</th><th class="num">\\u2248 tokens / session</th><th class="num">Sessions</th></tr></thead><tbody>${[...n.injectedListings].sort((m,h)=>h.approxTokensPerSession-m.approxTokensPerSession).map(m=>`<tr><td class="mono">${r(m.type)}</td><td class="num">${r(j(m.approxTokensPerSession))}</td><td class="num">${m.sessions}</td></tr>`).join("")}</tbody></table></div><div class="smt8">Recurring context weight: what Claude Code injects at the start of every session (skill and tool listings), bytes \\xF7 4.</div>`:\'<p class="small muted" style="margin:0">No injected listings were measured in these sessions.</p>\',g=n.claudeMd.reduce((m,h)=>m+h.approxTokensCarried,0),k=s.claudeMd.length?`<div class="aval">\\u2248${r($(s.totals.claudeMdApproxTokens))}<span class="anote"> tokens in ${s.claudeMd.length} file${s.claudeMd.length===1?"":"s"} \\xB7 \\u2248${r($(g))} carried across the window</span></div>${tt(s.claudeMd.map(m=>m.file))}`:\'<p class="small muted" style="margin:0">No CLAUDE.md under the scanned roots.</p>\',S=t.notes.length?`<div class="card pad mb16" style="background:var(--bg2)"><div class="card-title">Notes</div><ul class="small muted" style="margin:0;padding-left:18px">${t.notes.map(m=>`<li>${r(m)}</li>`).join("")}</ul></div>`:"",v=t.scope.global?`global \\xB7 ${t.scope.roots.length} root${t.scope.roots.length===1?"":"s"}`:`repo ${t.scope.cwd}`;return w(`<section>\n<div class="hero">\n${ie(48)}\n<div class="grow"><div class="eyebrow">Declared vs used</div><div class="herotitle">${r(o.title)}</div><div class="sg-sub">${r(o.sub)} \\xB7 ${r(v)} \\xB7 ${j(t.scope.sessionsScanned)} sessions scanned</div></div>\n</div>\n<div class="kpis">\n${et("Idle skills",l,s.totals.skills,"skills never fired","skills fired")}\n${et("Idle MCP servers",i,s.totals.mcpServers,"servers never called","servers was called")}\n${et("Agents never dispatched",a,s.totals.agents,"agents never dispatched","agents was dispatched")}\n</div>\n<div class="card pad mb16"><div class="card-title">Injected listings \\xB7 per session</div>${c}</div>\n<div class="two-up">\n<div class="card pad"><div class="card-title">CLAUDE.md</div>${k}</div>\n<div class="card pad"><div class="card-title">Undeclared \\xB7 ${d.length}</div>${d.length?`<p class="small muted" style="margin:0 0 8px">Observed in sessions but not found in the config that was read: a source outside this scope, or drift.</p>${tt(d)}`:\'<p class="small muted" style="margin:0">Everything the sessions used is declared in the config that was read.</p>\'}</div>\n</div>\n<div class="card pad mb16"><div class="eyebrow">Whole-harness review</div><div class="card-title">Turn this into proposals in Claude Code.</div>${K(Me(t.scope.global?"global":"repo"))}<div class="smt8">Copy only; nothing runs here. <span class="mono">orangu harness --json</span> prints this report.</div></div>\n${S}\n</section>`)}var Rs=50;function Es(e){let t=Et(e,Rs);return t.length?`<div class="feed" style="margin-top:18px" aria-live="off"><div class="card-head">Fleet feed</div>${t.map(s=>`<div class="feedrow"><span class="ft">${r(P(s.sid))}</span><span class="ft">${r(ge(s.ts))}</span><span class="sw" style="background:${_(s.category)}"></span><span class="fn">${r(s.name)}</span><span class="fw">${r(s.summary)}</span></div>`).join("")}<div class="feedfoot">last ${t.length} events across the live sessions</div></div>`:""}var _e=[],Rn=0;function Cs(e){let t=new Map(e.map(i=>[i.id,i])),n=_e.length===e.length&&_e.every(i=>t.has(i)),s=typeof matchMedia=="function"&&matchMedia("(prefers-reduced-motion: reduce)").matches,o=Date.now()-Rn<5e3;if(n&&(o||s))return _e.map(i=>t.get(i));let l=[...e].sort((i,a)=>a.mtimeMs-i.mtimeMs);return _e=l.map(i=>i.id),Rn=Date.now(),l}function Is(e,t){let n=Cs(t),s=typeof window<"u"?window.__ORANGU_SERVE__?.maxLive:void 0,o=s!==void 0&&e.data.mode==="serve"?`<div class="banner info">watching ${Math.min(s,n.length)} of ${n.length} live session${n.length===1?"":"s"}${n.length>s?\' \\xB7 raise with <span class="mono">--max-live</span>\':""}</div>`:"",l=e.conn==="reconnecting"?\'<div class="banner warn">Connection lost \\xB7 retrying. The page reconnects on its own.</div>\':"",i=n.map(a=>{let d=a.contextWindow&&a.contextFinal?a.contextFinal/a.contextWindow:0,c=Math.min(a.agentsRunning??0,8),g=c?`<div class="agentstrip">${"<i></i>".repeat(c)}${(a.agentsRunning??0)>8?`<span class="more">+${(a.agentsRunning??0)-8}</span>`:""}</div>`:"",k=a.lastEvent?`last: ${a.lastEvent.name} \\xB7 ${a.lastEvent.summary}`:re(a);return`<a class="fleetcard" href="#live?s=${r(a.id)}">\n<div class="fh"><span class="ldot" data-pulse="1" aria-hidden="true"></span><span>${r(P(a.id))}</span><span class="proj">${r(a.projectSlug)}</span><span class="muted">turn ${a.turns??"\\u2013"}</span></div>\n<div class="fk"><span>${a.startedAt!==void 0&&a.mtimeMs>a.startedAt?r(C(a.mtimeMs-a.startedAt)):"\\u2013"}</span><span style="color:var(--accent-ink)">${a.tokens!==void 0?r($(a.tokens)):"\\u2013"}</span><span>${a.toolCalls??"\\u2013"}\\u2699</span><span>${d?r(A(d)):"\\u2013"} ctx</span></div>\n<span class="trough" style="height:6px"><i style="width:${(d*100).toFixed(1)}%"></i></span>\n<div class="fl">${r(k)}</div>\n${g}\n</a>`}).join("");return w(`<section>${l}${o}<div class="fleet">${i}</div>${Es(n)}<p class="small muted">Each card is one running session. Click a card to watch it.</p></section>`)}typeof window<"u"&&(window.__ORANGU_FLEET__=Is);function As(e,t){let n=t?r(P(t.id))+" \\xB7 "+r(t.projectSlug||t.source):"\\u2013";if(e.sessions.length<2)return`<div class="sid">${n}</div>`;let s=e.sessions.map(o=>{let l=o.badge==="live"?\'<span class="ldot" data-pulse="1" aria-hidden="true"></span>\':o.badge==="idle"?\'<span class="ldot hollow" aria-hidden="true"></span>\':\'<span class="ldot done" aria-hidden="true"></span>\';return`<div role="option" tabindex="-1" data-id="${r(o.id)}" aria-selected="${o.id===t?.id}">${l}<span class="mono">${r(P(o.id))}</span><span class="proj">${r(o.projectSlug)}</span></div>`}).join("");return`<button class="sid pick" id="btn-pick" aria-haspopup="listbox" aria-expanded="false">${n} \\u25BE</button>\n<div class="picklist" id="pick-list" role="listbox" aria-label="Sessions" hidden>${s}</div>`}function Ms(e,t){let n=e.querySelector("#btn-pick"),s=e.querySelector("#pick-list");if(!n||!s)return;let o=Array.prototype.slice.call(s.querySelectorAll(\'[role="option"]\')),l=()=>{s.hidden=!0,n.setAttribute("aria-expanded","false")};n.addEventListener("click",()=>{let i=s.hidden;s.hidden=!i,n.setAttribute("aria-expanded",String(i)),i&&(o.find(a=>a.getAttribute("aria-selected")==="true")??o[0])?.focus()}),s.addEventListener("keydown",i=>{let a=o.indexOf(document.activeElement);i.key==="Escape"?(l(),n.focus()):i.key==="ArrowDown"||i.key==="ArrowUp"?(i.preventDefault(),o[(a+(i.key==="ArrowDown"?1:o.length-1))%o.length]?.focus()):(i.key==="Enter"||i.key===" ")&&(i.preventDefault(),document.activeElement?.click())});for(let i of o)i.addEventListener("click",()=>{l(),t({s:i.dataset.id},{push:!0})})}var me=new Set;function Ls(e,t,n,s){let o;if(n.screen==="repo"?o="repo":n.screen==="global"?o="global":n.screen==="suggest"&&(n.scope==="repo"||n.scope==="global")&&(o=n.scope),!o||e.aggregates[o])return!1;if(!me.has(o)){let l=o;me.add(l);let i=e.sessions.find(a=>a.id===n.s)??e.sessions[0];t.aggregate(l,l==="repo"?i?.cwd:void 0).then(a=>{me.delete(l),a&&(e.aggregates[l]=a,s())}).catch(()=>me.delete(l))}return me.has(o)}function Fs(){return w(`<section><div class="card"><div class="empty-hero">${q(48)}<div class="t">Analysing sessions\\u2026</div><div class="s">A cold cache takes a moment; the numbers appear as soon as they are ready.</div></div></div></section>`)}function Hs(e){return e.state.screen==="global"?kn(e):rn(e)}function js(e){let t=Me(e);return`<div class="card pad mb16"><div class="eyebrow">Whole-harness review</div><div class="card-title">Review major ${e} improvements separately.</div><p class="narrative">This interactive command reviews the wider harness. It is copy-only here, creates no row status, and keeps its estimate gates inside /orangu:harness.</p><div class="kickrow"><span class="mono125 grow">${r(t)}</span><button type="button" class="btn-sm" data-copy="${r(t)}">Copy whole-harness review</button></div></div>`}var _s=3e4,ne,Pe=!1,nt=!1,En=0;function Ps(){nt=!0}function Cn(e,t){let n=nt&&Date.now()-En>=_s;return ne!==void 0&&!n?!1:(Pe||(Pe=!0,nt=!1,e.harness().then(s=>{ne=s},()=>{ne===void 0&&(ne=null)}).finally(()=>{Pe=!1,En=Date.now(),t()})),Pe&&ne===void 0)}function Ns(e){return Tn(e,ne??null)}function Os(e,t,n){return Cn(e,t),Sn(ne,n)}var In={pickerHtml:As,wirePicker:Ms,ensureAggregate:Ls,aggScreen:Fs,aggregateView:Hs,megaReview:js,ensureHarness:Cn,invalidateHarness:Ps,harnessView:Ns,harnessCard:Os};var Ds=["session","repo","global","report","app"],ot=["bug","confusing","missing","slow","delight","other"],An="https://github.com/NissanOhana/orangu/issues/new";function Mn(e){return typeof e=="string"&&Ds.includes(e)}function rt(){return{summary:"",category:"bug",rant:"",expected:"",reproduction:""}}function Ln(e){return e.replace(/\\r\\n?/g,`\n`).trim()}function st(e,t){let n=Ln(t);return`## ${e}\n\n${n||"_Not provided._"}`}function Fn(e,t){let n=Ln(e.summary).replace(/\\s+/g," "),s=`${e.category} \\xB7 ${t.context}`,o=`[beta feedback] ${[...n||s].slice(0,160).join("")}`,l=[st("Experience",e.rant),st("What I expected",e.expected),st("How to reproduce",e.reproduction),`## Context\n\n- Area: ${t.context}\n- Category: ${e.category}`,`## Diagnostics (reviewed)\n\n- Orangu: ${t.version}\n- Node: ${t.nodeMajor}\n- OS: ${t.osFamily}\n- Architecture: ${t.arch}\n- Surface: ${t.surface}`].join(`\n\n`);return{title:o,body:l}}function it(e,t=7500){let n=new URLSearchParams({title:e.title,body:e.body}).toString(),s=`${An}?${n}`,o=s.length;return o>t?{kind:"oversized",blankUrl:An,encodedLength:o,report:e}:{kind:"composer",url:s,encodedLength:o,report:e}}var L={context:"app",draft:rt(),reviewed:!1};function Bs(){let e=/(?:[?&])context=([^&]+)/.exec(location.hash),t="app";try{e?.[1]&&(t=decodeURIComponent(e[1]))}catch{}return Mn(t)?t:"app"}function Hn(e){window.open(e,"_blank","noopener,noreferrer")}function qs(e,t){let n=()=>{let s=t.textContent;t.textContent="copied",setTimeout(()=>t.textContent=s,1200)};if(navigator.clipboard?.writeText)navigator.clipboard.writeText(e).then(n,n);else{let s=document.createElement("textarea");s.value=e,document.body.appendChild(s),s.select();try{document.execCommand("copy")}catch{}s.remove(),n()}}function Ws(){let e=Bs();L.context!==e&&(L={context:e,draft:rt(),reviewed:!1});let t=window.__ORANGU_SERVE__?.feedback,n={version:t?.version??window.__ORANGU_SERVE__?.version??"unknown",nodeMajor:t?.nodeMajor??"unknown",osFamily:t?.osFamily??"other",arch:t?.arch??"other",surface:"localhost",context:e},s=ot.map(p=>`<option value="${p}"${L.draft.category===p?" selected":""}>${p}</option>`).join(""),o=w(`<section class="feedback">\n<div class="banner info"><b>Private until you choose otherwise.</b>&nbsp; Nothing from a session or report is attached. Opening the reviewed composer sends only the preview below to GitHub.</div>\n<div class="card pad mb16">\n<div class="card-title">Rant about the beta</div>\n<p class="narrative">Be blunt. What was confusing, broken, slow, or unexpectedly good?</p>\n<div class="feedback-grid">\n<label>Short summary<input id="fb-summary" maxlength="240" value="${r(L.draft.summary)}" placeholder="What should we fix first?"></label>\n<label>Category<select id="fb-category">${s}</select></label>\n</div>\n<label>Your experience<textarea id="fb-rant" rows="7" placeholder="Rant here\\u2026">${r(L.draft.rant)}</textarea></label>\n<label>What did you expect?<textarea id="fb-expected" rows="3">${r(L.draft.expected)}</textarea></label>\n<label>How can we reproduce it? <span class="muted">optional</span><textarea id="fb-reproduction" rows="3">${r(L.draft.reproduction)}</textarea></label>\n<button type="button" class="btn" id="fb-preview">Review exact report</button>\n</div>\n<div class="card pad mb16" id="fb-review">\n<div class="card-title">Exact GitHub prefill</div>\n<p class="small muted" id="fb-review-status">Review the title, body, and generic diagnostics before anything can leave localhost.</p>\n<div class="eyebrow">Title</div><pre class="feedback-preview" id="fb-title-preview"></pre>\n<div class="eyebrow">Body</div><pre class="feedback-preview" id="fb-body-preview"></pre>\n<label class="feedback-check"><input type="checkbox" id="fb-reviewed"> I reviewed this exact report and want to send its prefill to GitHub.</label>\n<button type="button" class="btn" id="fb-send">Send reviewed prefill to GitHub</button>\n<div id="fb-fallback"></div>\n</div>\n</section>`),l=o.querySelector("#fb-summary"),i=o.querySelector("#fb-category"),a=o.querySelector("#fb-rant"),d=o.querySelector("#fb-expected"),c=o.querySelector("#fb-reproduction"),g=o.querySelector("#fb-reviewed"),k=o.querySelector("#fb-send"),S=o.querySelector("#fb-title-preview"),v=o.querySelector("#fb-body-preview"),m=o.querySelector("#fb-review-status"),h=o.querySelector("#fb-fallback"),R=()=>({summary:l.value,category:ot.includes(i.value)?i.value:"other",rant:a.value,expected:d.value,reproduction:c.value}),x=()=>{L.draft=R(),L.preview=void 0,L.reviewed=!1,g.checked=!1,g.disabled=!0,k.disabled=!0,S.textContent="",v.textContent="",h.replaceChildren(),m.textContent="Draft changed. Review the exact report again."};for(let p of[l,i,a,d,c])p.addEventListener("input",x);i.addEventListener("change",x);let f=()=>{let p=L.preview;if(S.textContent=p?.title??"",v.textContent=p?.body??"",g.disabled=!p,g.checked=!!(p&&L.reviewed),k.disabled=!p||!L.reviewed,h.replaceChildren(),!p)return;let b=it(p);if(m.textContent=b.kind==="composer"?`The encoded prefill is ${b.encodedLength.toLocaleString()} characters. Opening it sends this title and body to GitHub.`:`The complete prefill is ${b.encodedLength.toLocaleString()} characters; too large for a reliable URL. Nothing was dropped.`,b.kind==="oversized"&&L.reviewed){k.disabled=!0;let F=`${p.title}\n\n${p.body}`,u=document.createElement("button");u.type="button",u.className="btn-sm",u.textContent="Copy complete report",u.addEventListener("click",()=>qs(F,u));let y=document.createElement("button");y.type="button",y.className="btn-sm",y.textContent="Open blank GitHub issue",y.addEventListener("click",()=>Hn(b.blankUrl)),h.append(u,y)}return b};return o.querySelector("#fb-preview").addEventListener("click",()=>{L.draft=R(),L.preview=Fn(L.draft,n),L.reviewed=!1,f()}),g.addEventListener("change",()=>{L.reviewed=!!(L.preview&&g.checked),f()}),k.addEventListener("click",()=>{if(!L.reviewed||!L.preview)return;let p=it(L.preview);p.kind==="composer"&&Hn(p.url)}),f(),o}function at(){return/^#feedback(?:[?]|$)/.test(location.hash)}function jn(){let e=document.getElementById("app");if(!e)return;e.className="app feedback-root",e.replaceChildren();let t=w(\'<main class="feedback-shell"><header class="page-head"><div><h1>Beta feedback</h1><div class="sub">rant locally \\xB7 review exactly what will be shared</div></div><a class="btn" href="#overview">Back to Orangu</a></header></main>\');t.appendChild(Ws()),e.appendChild(t),document.title="orangu \\xB7 beta feedback"}function _n(){if(document.getElementById("feedback-launch"))return;let e=document.createElement("a");e.id="feedback-launch",e.className="feedback-launch",e.href="#feedback?context=app",e.textContent="Beta feedback",e.setAttribute("aria-label","Open beta feedback"),document.body.appendChild(e)}function Pn(){let e=at();e?jn():vn($n(yn(location.pathname)),In).then(_n),window.addEventListener("hashchange",()=>{at()!==e&&location.reload()})}document.readyState==="loading"?document.addEventListener("DOMContentLoaded",Pn):Pn();})();\n';
var CLIENT_CSS = `/* Canonical design tokens for the report, served app, and landing page.
   scripts/build.mjs inlines this file.
   Do not hand-duplicate these values anywhere else. \`--accent\` is decorative only on light backgrounds; text uses \`--accent-ink\`. */
:root{--bg:#ffffff;--bg2:#f6f5f0;--surface:#ffffff;--border:#e8e6df;--border2:#d2cfc5;--ink1:#1a1a18;--ink2:#52504a;--ink3:#8a877e;--accent:#d97757;--accent-ink:#b4522f;--accent-weak:#f7e9e2;--good:#3d6330;--warn:#8a6410;--bad:#a03016;--cmd:#1a1a18;--cmd-ink:#faf9f5;--cat-read:#6a9bcc;--cat-search:#4a72a8;--cat-edit:#d97757;--cat-write:#b4522f;--cat-exec:#8a6bb0;--cat-agent:#3f8a86;--cat-skill:#b5852a;--cat-web:#4f7a3f;--cat-other:#949086;--title:'Bricolage Grotesque','Helvetica Neue',Helvetica,Arial,sans-serif;--sans:'Helvetica Neue',Helvetica,Arial,sans-serif;--mono:ui-monospace,'SF Mono',Menlo,Consolas,monospace}
:root[data-theme="dark"]{--bg:#151412;--bg2:#1d1c18;--surface:#201f1b;--border:#2e2c25;--border2:#403d33;--ink1:#f5f3ec;--ink2:#c9c5ba;--ink3:#8f8c81;--accent-ink:#e79f84;--accent-weak:#38281f;--good:#9cc47f;--warn:#e6c374;--bad:#f0a08b;--cmd:#26241e;--cmd-ink:#f5f3ec;--cat-read:#7fa8d8;--cat-search:#9cc0e8;--cat-edit:#e79f84;--cat-write:#f0a08b;--cat-exec:#b39bd8;--cat-agent:#6fbdb8;--cat-skill:#e6c374;--cat-web:#9cc47f;--cat-other:#a8a498}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#151412;--bg2:#1d1c18;--surface:#201f1b;--border:#2e2c25;--border2:#403d33;--ink1:#f5f3ec;--ink2:#c9c5ba;--ink3:#8f8c81;--accent-ink:#e79f84;--accent-weak:#38281f;--good:#9cc47f;--warn:#e6c374;--bad:#f0a08b;--cmd:#26241e;--cmd-ink:#f5f3ec;--cat-read:#7fa8d8;--cat-search:#9cc0e8;--cat-edit:#e79f84;--cat-write:#f0a08b;--cat-exec:#b39bd8;--cat-agent:#6fbdb8;--cat-skill:#e6c374;--cat-web:#9cc47f;--cat-other:#a8a498}}
/* Orangu app shell: layout and components on the design tokens (tokens.css is prepended by the build).
   No colour literals here: every colour is a var() from tokens.css. */
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink1);
  font-family: var(--sans);
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
a { color: var(--accent-ink); text-decoration: none; }
a:hover { text-decoration: underline; }
h1, h2, h3 { font-family: var(--title); font-weight: 700; line-height: 1.2; margin: 0; }
h3 { font-size: 16px; }
.mono, code { font-family: var(--mono); font-variant-numeric: tabular-nums; }
.num { font-variant-numeric: tabular-nums; }
button { font-family: var(--sans); }
:focus-visible { outline: 2px solid var(--accent-ink); outline-offset: 2px; border-radius: 4px; }
summary { list-style: none; cursor: pointer; }
summary::-webkit-details-marker { display: none; }
summary .chev { color: var(--ink3); font-size: 10px; width: 12px; flex: none; }
details[open] > summary .chev { transform: rotate(90deg); display: inline-block; }
@keyframes o-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
[data-pulse="1"] { animation: o-pulse 1.6s infinite; }
@media (prefers-reduced-motion: reduce) { [data-pulse] { animation: none !important; } html { scroll-behavior: auto !important; } }

/* ---------- shell ---------- */
.app { display: flex; height: 100vh; overflow: hidden; }
.side { width: 230px; flex-shrink: 0; border-right: 1px solid var(--border); display: flex; flex-direction: column; background: var(--bg2); }
.brand { display: flex; align-items: center; gap: 9px; padding: 16px 16px 12px; }
.brand .name { font-family: var(--title); font-weight: 700; font-size: 17px; }
.brand .ver { font-family: var(--mono); font-size: 10.5px; color: var(--ink3); border: 1px solid var(--border2); border-radius: 999px; padding: 1px 7px; margin-left: auto; }
.sesscard { margin: 0 12px 14px; border: 1px solid var(--border); background: var(--surface); border-radius: 8px; padding: 8px 10px; }
.sesscard .eyebrow { font-size: 10.5px; color: var(--ink3); text-transform: uppercase; letter-spacing: 0.05em; }
.sesscard .sid { font-family: var(--mono); font-size: 12px; color: var(--ink1); margin-top: 2px; }
/* serve-mode session picker: button + listbox */
.sesscard { position: relative; }
.sesscard button.sid.pick { display: block; width: 100%; text-align: left; background: transparent; border: 0; padding: 2px 0 0; cursor: pointer; }
.picklist { position: absolute; left: -1px; right: -1px; top: calc(100% + 4px); z-index: 30; background: var(--surface); border: 1px solid var(--border2); border-radius: 8px; padding: 4px; max-height: 260px; overflow-y: auto; }
.picklist [role='option'] { display: flex; align-items: center; gap: 7px; padding: 6px 8px; border-radius: 6px; font-size: 12px; cursor: pointer; }
.picklist [role='option'] .proj { color: var(--ink3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.picklist [role='option'][aria-selected='true'] { background: var(--accent-weak); color: var(--accent-ink); }
.picklist [role='option']:hover, .picklist [role='option']:focus-visible { background: var(--bg2); }
.navwrap { padding: 0 12px 8px; overflow-y: auto; flex: 1; }
.navgroup-label { font-size: 10.5px; color: var(--ink3); text-transform: uppercase; letter-spacing: 0.06em; padding: 12px 8px 4px; }
.navgroup-label:first-child { padding-top: 6px; }
nav a.navitem { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-radius: 8px; font-size: 13.5px; margin-bottom: 2px; color: var(--ink2); }
nav a.navitem:hover { background: color-mix(in srgb, var(--ink1) 5%, transparent); text-decoration: none; }
nav a.navitem[aria-current="page"] { background: var(--accent-weak); color: var(--accent-ink); font-weight: 700; }
nav a.navitem .hint { margin-left: auto; font-size: 11px; color: var(--ink3); font-weight: 400; }
.ldot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); flex: none; }
.ldot.hollow { background: transparent; border: 1.5px solid var(--accent); }
.ldot.done { background: var(--good); }
.side-foot { padding: 14px 16px; border-top: 1px solid var(--border); }
.side-foot .themebtn { width: 100%; background: transparent; border: 1px solid var(--border2); color: var(--ink2); border-radius: 8px; padding: 7px 10px; cursor: pointer; font-size: 12.5px; text-align: left; }
.side-foot .note { font-size: 11.5px; color: var(--ink3); margin-top: 10px; line-height: 1.5; }

.main { flex: 1; overflow-y: auto; background: var(--bg); }
.page { max-width: 1080px; margin: 0 auto; padding: 22px 28px 64px; }
.sample-note { border: 1px solid var(--border); border-radius: 9px; background: var(--accent-weak); color: var(--ink2); padding: 9px 12px; margin-bottom: 14px; font-size: 12.5px; }
.sample-note b { color: var(--accent-ink); }
.page-head { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; padding-bottom: 16px; border-bottom: 1px solid var(--border); margin-bottom: 22px; }
.page-head h1 { font-size: 24px; letter-spacing: -0.01em; }
.page-head .sub { font-family: var(--mono); font-size: 12px; color: var(--ink3); margin-top: 2px; }
.page-tools { margin-left: auto; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.aud { display: flex; border: 1px solid var(--border2); border-radius: 8px; overflow: hidden; }
.aud button { border: 0; cursor: pointer; font-size: 12.5px; padding: 7px 13px; background: transparent; color: var(--ink2); font-weight: 600; }
.aud button[aria-pressed="true"] { background: var(--ink1); color: var(--bg); }
.btn { border: 1px solid var(--border2); border-radius: 8px; padding: 7px 13px; font-size: 12.5px; color: var(--ink2); background: transparent; cursor: pointer; }
.btn:hover { background: var(--bg2); }
.btn-sm { border: 1px solid var(--border2); border-radius: 7px; padding: 5px 11px; font-size: 12px; color: var(--ink1); background: transparent; cursor: pointer; }
.btn-sm:hover { background: var(--bg2); }
.btn-sm[aria-disabled="true"], .btn[aria-disabled="true"] { color: var(--ink3); cursor: not-allowed; }

/* ---------- cards / KPIs ---------- */
.card { border: 1px solid var(--border); border-radius: 12px; background: var(--surface); }
.pad { padding: 16px 18px; }
.card-title { font-weight: 700; font-size: 13.5px; margin-bottom: 10px; }
.card-head { padding: 12px 18px; border-bottom: 1px solid var(--border); font-weight: 700; font-size: 13.5px; display: flex; align-items: center; gap: 8px; }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(160px, 100%), 1fr)); gap: 10px; margin-bottom: 16px; }
.kpis.k4 { grid-template-columns: repeat(auto-fit, minmax(min(150px, 100%), 1fr)); gap: 12px; }
.kpi { border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; background: var(--surface); }
.kpi .label { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--ink3); }
.kpi .val { font-family: var(--mono); font-size: 19px; font-weight: 700; margin-top: 2px; }
.kpi.big .val { font-size: 22px; margin-top: 3px; }
.kpi .val.accent { color: var(--accent-ink); }
.kpi .hint { font-size: 11.5px; color: var(--ink3); }
.kpi .hint.bad { color: var(--bad); }
.kpi .val .est { color: var(--ink3); font-weight: 400; }
.skel .val { background: var(--bg2); color: transparent; border-radius: 4px; min-width: 48px; }

/* axis triptych */
.triptych { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr)); gap: 12px; margin-bottom: 16px; }
.axis { border: 1px solid var(--border); border-radius: 10px; padding: 16px; background: var(--surface); }
.axis.q { border-left: 3px solid var(--good); }
.axis.t { border-left: 3px solid var(--border2); }
.axis.c { border-left: 3px solid var(--accent); }
.axis .aname { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ink3); }
.axis .aval { font-family: var(--title); font-size: 30px; font-weight: 700; margin-top: 2px; }
.axis.c .aval { color: var(--accent-ink); }
.axis .anote { font-size: 12.5px; color: var(--ink3); }

/* chips & pills */
.chiprow { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; align-items: center; }
.chip { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; border: 1px solid var(--border); border-radius: 999px; padding: 5px 12px; min-height: 28px; color: var(--ink2); background: transparent; cursor: pointer; }
.chip.active { border-color: var(--border2); background: var(--surface); font-weight: 600; color: var(--ink1); }
.chip[aria-disabled="true"] { color: var(--ink3); cursor: not-allowed; }
.chip .x { border: 0; background: none; color: var(--ink3); cursor: pointer; font-size: 13px; line-height: 1; padding: 0; }
.chip .x:hover { color: var(--bad); }
.sigchip { font-size: 12px; border: 1px solid var(--border); border-radius: 999px; padding: 4px 11px; color: var(--ink2); min-height: 28px; display: inline-flex; align-items: center; gap: 5px; }
.sigchip b.good { color: var(--good); }
.sigchip b.warn { color: var(--warn); }
.sigchip b.bad { color: var(--bad); }
.sigchip b.neutral, .sigchip b.unknown { color: var(--ink3); }
.pill { font-family: var(--mono); font-size: 11px; color: var(--ink3); border: 1px solid var(--border); border-radius: 999px; padding: 2px 9px; white-space: nowrap; }
.tag { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11px; font-weight: 600; white-space: nowrap; }
.tag.good { color: var(--good); background: color-mix(in srgb, var(--good) 15%, transparent); }
.tag.warn { color: var(--warn); background: color-mix(in srgb, var(--warn) 15%, transparent); }
.tag.bad { color: var(--bad); background: color-mix(in srgb, var(--bad) 15%, transparent); }
.tag.neutral, .tag.unknown { color: var(--ink2); background: var(--bg2); }

/* banners */
.banner { display: flex; gap: 10px; align-items: center; padding: 10px 14px; border-radius: 8px; font-size: 13px; margin-bottom: 14px; border: 1px solid var(--border); }
.banner.info { background: color-mix(in srgb, var(--cat-read) 10%, var(--surface)); }
.banner.warn { background: color-mix(in srgb, var(--warn) 12%, var(--surface)); }

/* command block */
.cmd { background: var(--cmd); color: var(--cmd-ink); font-family: var(--mono); font-size: 12.5px; border-radius: 8px; padding: 10px 12px; display: flex; align-items: center; gap: 10px; }
.cmd .p { color: var(--accent); }
.cmd .txt { flex: 1; overflow-x: auto; white-space: nowrap; }
.cmd .copy { border: 1px solid color-mix(in srgb, var(--cmd-ink) 30%, transparent); background: transparent; color: var(--cmd-ink); border-radius: 6px; padding: 3px 9px; font-size: 11px; cursor: pointer; flex: none; }

/* findings */
details.finding { border: 1px solid var(--border); border-radius: 10px; background: var(--surface); margin-bottom: 8px; }
details.finding > summary { display: flex; align-items: center; gap: 10px; padding: 12px 16px; font-size: 14px; }
details.finding > summary b { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.sev { display: inline-block; width: 8px; height: 8px; border-radius: 50%; flex: none; }
.sev.high { background: var(--bad); }
.sev.medium { background: var(--warn); }
.sev.low { background: var(--cat-read); }
.sev.info { background: var(--ink3); }
.fsave { font-family: var(--mono); font-size: 12.5px; color: var(--accent-ink); white-space: nowrap; }
.fbody { padding: 0 16px 14px; font-size: 13.5px; color: var(--ink2); }
.fbody p { margin: 0 0 8px; }
.rec { border-left: 2px solid var(--accent); padding: 6px 12px; background: var(--bg2); border-radius: 0 8px 8px 0; color: var(--ink1); }
.fcmd { margin-top: 12px; }
details.finding.top { border-color: var(--border2); margin-bottom: 16px; }
details.finding.top > summary b { font-size: 15px; }
.axis .signals { margin-top: 8px; font-size: 12px; }
.axis .signals > summary { cursor: pointer; color: var(--ink3); }
.axis .signals .chiprow { margin: 8px 0 0; gap: 6px; }
.axis .signals .sigchip { font-size: 11px; padding: 2px 8px; min-height: 24px; }
.spark { max-width: 360px; margin: 4px 0 6px; }
.spark svg { display: block; height: 60px; }
.where-next a { display: block; padding: 6px 0; font-size: 13.5px; border-bottom: 1px solid var(--border); }
.where-next a:last-child { border-bottom: 0; }
.mb6 { margin-bottom: 6px; }
.fcmd .eyebrow { margin-bottom: 6px; }
.recoverable { margin: 0 0 10px; font-size: 13px; color: var(--ink2); }

/* timeline turns */
details.turn { border: 1px solid var(--border); border-radius: 10px; background: var(--surface); margin-bottom: 6px; }
details.turn.interrupted { border-left: 3px solid var(--bad); }
details.turn > summary { display: grid; grid-template-columns: 44px minmax(0, 1fr) 92px 46px 62px 62px; gap: 10px; align-items: center; padding: 10px 14px; }
.tnum { font-family: var(--mono); font-size: 12px; color: var(--ink3); }
.tprompt { font-size: 13.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kind { font-family: var(--mono); font-size: 10.5px; border: 1px solid var(--border); border-radius: 4px; padding: 1px 6px; margin-right: 8px; color: var(--ink3); }
.kind.khuman { color: var(--accent-ink); }
.kind.kcmd { color: var(--cat-skill); }
.mixbar { display: flex; height: 8px; border-radius: 4px; overflow: hidden; background: var(--bg2); }
.mixbar i { display: block; height: 100%; }
.tcell { font-family: var(--mono); font-size: 12px; color: var(--ink2); text-align: right; }
.tcell.hot { color: var(--accent-ink); }
.tbody { padding: 2px 14px 12px 54px; font-size: 12.5px; color: var(--ink2); }
.tmeta { color: var(--ink3); margin-bottom: 6px; font-family: var(--mono); font-size: 11.5px; }
.evline { display: flex; gap: 9px; align-items: center; padding: 3px 0; }
.evline .sw { width: 7px; height: 7px; border-radius: 2px; flex: none; }
.evline .en { font-family: var(--mono); font-size: 12px; color: var(--ink1); }
.evline .ew { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.evline .ex { font-family: var(--mono); font-size: 11px; color: var(--ink3); }
.divider { display: flex; align-items: center; gap: 10px; margin: 12px 0; color: var(--ink3); font-size: 12px; }
.divider::before, .divider::after { content: ""; flex: 1; border-top: 1px dashed var(--border2); }
.pagefoot { text-align: center; font-size: 12.5px; color: var(--ink3); padding: 10px; }
.pagefoot button { border: 0; background: none; color: var(--accent-ink); cursor: pointer; font-size: 12.5px; }

/* grid tables */
table.grid { width: 100%; border-collapse: collapse; font-size: 13px; }
table.grid th { text-align: left; color: var(--ink3); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; padding: 9px 10px; border-bottom: 1px solid var(--border); }
table.grid td { padding: 8px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
table.grid tr:hover td { background: var(--bg2); }
table.grid td.num, table.grid th.num { text-align: right; font-variant-numeric: tabular-nums; font-family: var(--mono); font-size: 12.5px; }
.scroll-x { overflow-x: auto; }

/* bars */
.trough { display: block; height: 8px; border-radius: 4px; background: var(--bg2); overflow: hidden; }
.trough > i { display: block; height: 100%; background: var(--accent); }
/* Tools table: the Avg cell carries a mean that sits above p95 (a few calls far above the rest); the title says why. */
.outlier { font: 600 10px/1.4 var(--sans); color: var(--ink3); text-transform: uppercase; letter-spacing: 0.04em; margin-left: 5px; vertical-align: middle; cursor: help; }
.ctxbar { height: 10px; border-radius: 6px; background: var(--bg2); border: 1px solid var(--border); overflow: hidden; }
.ctxbar > i { display: block; height: 100%; background: var(--accent); }

/* live */
.livebanner { display: flex; align-items: center; gap: 12px; background: var(--accent-weak); border: 1px solid var(--border); border-radius: 12px; padding: 14px 18px; margin-bottom: 18px; }
.livebanner .lt { font-weight: 700; font-size: 15px; }
.livebanner .ls { font-size: 13px; color: var(--ink2); }
.livebanner .lr { font-family: var(--mono); font-size: 13px; color: var(--ink2); }
.feed { border: 1px solid var(--border); border-radius: 12px; background: var(--surface); }
.feedrow { display: flex; align-items: center; gap: 10px; padding: 9px 18px; border-bottom: 1px solid var(--border); font-size: 13px; }
.feedrow .ft { font-family: var(--mono); font-size: 11.5px; color: var(--ink3); width: 52px; flex: none; }
.feedrow .sw { width: 8px; height: 8px; border-radius: 2px; flex: none; }
.feedrow .fn { font-family: var(--mono); font-size: 12.5px; color: var(--ink1); }
.feedrow .fw { color: var(--ink2); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.feedrow .fd { font-family: var(--mono); font-size: 11.5px; color: var(--ink3); }
.feedfoot { padding: 10px 18px; font-size: 12px; color: var(--ink3); }
.fleet { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(320px, 100%), 1fr)); gap: 12px; margin-bottom: 18px; }
.fleetcard { display: block; border: 1px solid var(--border); border-radius: 12px; padding: 14px; background: var(--surface); color: var(--ink1); }
.fleetcard:hover { text-decoration: none; background: var(--bg2); }
.fleetcard .fh { display: flex; align-items: center; gap: 8px; font-family: var(--mono); font-size: 12.5px; }
.fleetcard .fh .proj { color: var(--ink2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.fleetcard .fk { display: flex; gap: 14px; font-family: var(--mono); font-size: 13px; margin: 8px 0 6px; flex-wrap: wrap; }
.fleetcard .fl { font-size: 12px; color: var(--ink3); margin-top: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agentstrip { display: flex; gap: 3px; margin-top: 8px; align-items: center; }
.agentstrip i { width: 8px; height: 8px; border-radius: 2px; background: var(--cat-agent); }
.agentstrip .more { font-family: var(--mono); font-size: 10.5px; color: var(--ink3); }

/* agents swimlanes */
.swimrow { display: grid; grid-template-columns: 160px 1fr; gap: 10px; align-items: center; padding: 4px 0; border-bottom: 1px solid var(--border); }
.swimrow .alabel { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.swimrow .alabel small { color: var(--ink3); }
.swimbox { max-height: 360px; overflow-y: auto; }

/* raw explorer */
.raw-filter { display: flex; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; align-items: center; }
.raw-filter input, .raw-filter select { font-family: var(--sans); font-size: 13px; padding: 6px 10px; border: 1px solid var(--border2); border-radius: 8px; background: var(--surface); color: var(--ink1); }
.rawrow { font-family: var(--mono); font-size: 12px; padding: 4px 8px; border-bottom: 1px solid var(--border); display: grid; grid-template-columns: 90px 70px 1fr; gap: 10px; }
.rawrow:hover { background: var(--bg2); }
.rawrow .rt { color: var(--accent-ink); overflow: hidden; text-overflow: ellipsis; }
.rawrow .rp { color: var(--ink2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* misc */
.muted { color: var(--ink3); }
.small { font-size: 12px; }
.right { text-align: right; }
.hidden { display: none !important; }
.two-up { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(340px, 100%), 1fr)); gap: 16px; margin-bottom: 16px; }
.pill-row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
.narrative { font-size: 14.5px; color: var(--ink2); line-height: 1.6; margin: 0; }
.plaingrid { display: grid; grid-template-columns: 150px 1fr; font-size: 14px; }
.plaingrid > div { padding: 11px 18px; border-bottom: 1px solid var(--border); }
.plaingrid > div:nth-last-child(-n + 2) { border-bottom: 0; }
.plaingrid > .k { color: var(--ink3); }
.eyebrow { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--ink3); }
.hero { display: flex; gap: 16px; align-items: center; border: 1px solid var(--border); border-radius: 12px; background: var(--bg2); padding: 16px 18px; margin-bottom: 16px; flex-wrap: wrap; }
.overview-hero { position: relative; min-height: 112px; flex-wrap: nowrap; overflow: hidden; padding: 20px 24px; background: linear-gradient(120deg, var(--surface), var(--accent-weak)); }
.overview-hero::after { content: ""; position: absolute; width: 220px; height: 220px; right: -70px; top: -110px; border-radius: 50%; background: color-mix(in srgb, var(--accent) 12%, transparent); }
.overview-brand { position: relative; z-index: 1; display: grid; place-items: center; width: 80px; height: 80px; flex: none; }
@keyframes overview-float { 0%, 100% { transform: translateY(0) rotate(-1deg); } 50% { transform: translateY(-6px) rotate(1deg); } }
@keyframes overview-halo { 0%, 100% { transform: scale(.92); opacity: .45; } 50% { transform: scale(1.08); opacity: 1; } }
.overview-brand::before { content: ""; position: absolute; inset: 9px; border: 1px solid color-mix(in srgb, var(--accent-ink) 28%, transparent); border-radius: 50%; animation: overview-halo 3.8s ease-in-out infinite; }
.overview-brand .logo { position: relative; z-index: 1; filter: drop-shadow(0 10px 14px color-mix(in srgb, var(--ink1) 18%, transparent)); animation: overview-float 4.8s ease-in-out infinite; }
.overview-copy { position: relative; z-index: 1; min-width: 0; }
.overview-copy .herotitle { margin-top: 2px; font-size: clamp(24px, 3vw, 34px); letter-spacing: -0.02em; }
.overview-copy .sg-sub { max-width: 680px; font-size: 14px; line-height: 1.55; }
@media (prefers-reduced-motion: reduce) { .overview-brand::before, .overview-brand .logo { animation: none !important; transition: none !important; } }
.rank { width: 28px; height: 28px; border-radius: 50%; background: var(--accent-ink); color: var(--bg); display: grid; place-items: center; font-weight: 700; font-size: 13px; flex-shrink: 0; }
.vh { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.chart-empty { padding: 22px; text-align: center; color: var(--ink3); font-size: 12.5px; background: var(--bg2); border-radius: 8px; }
svg { display: block; max-width: 100%; }
.legend { display: flex; gap: 14px; flex-wrap: wrap; font-size: 12px; color: var(--ink2); margin-top: 8px; }
.legend span { display: inline-flex; align-items: center; gap: 5px; }
.legend .sw { display: inline-block; width: 8px; height: 8px; border-radius: 2px; }
.empty-hero { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 44px 24px; text-align: center; }
.empty-hero .t { font-family: var(--title); font-weight: 700; font-size: 17px; }
.empty-hero .s { font-size: 13px; color: var(--ink2); max-width: 460px; }
.empty-hero .cmd { width: min(460px, 100%); text-align: left; }

/* utility classes the client templates lean on (keeps the file JS bundle within 70,000 bytes) */
.mb16 { margin-bottom: 16px; }
.mb18 { margin-bottom: 18px; }
.mt16 { margin-top: 16px; }
.ellip { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.grow { flex: 1; }
.mono115 { font-family: var(--mono); font-size: 11.5px; color: var(--ink3); }
.mono125 { font-family: var(--mono); font-size: 12.5px; }
.bdot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 7px; }
.bdot.p { background: var(--accent); }
.bdot.h { border: 2px solid var(--accent); }
.bdot.g { background: var(--good); }
.bdot.s { background: var(--ink3); }
.swd { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 8px; flex: none; }
.exch { font-family: var(--mono); font-size: 11.5px; border: 1px solid var(--border); border-radius: 5px; padding: 2px 7px; }
.kickrow { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; border-top: 1px solid var(--border); padding-top: 10px; margin-top: 12px; }
/* Suggest plan items: kept here, not as inline styles, for the CLIENT_JS size ratchet */
.sg-t { font-size: 14.5px; }
.sg-ev { margin-bottom: 8px; }
.sg-ev b { color: var(--ink1); }
.sg-fix { margin-bottom: 10px; }
.sg-ex { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin-bottom: 10px; }
.sg-body { padding-left: 56px; }
.sg-save { font-weight: 700; }
.sg-cmd { margin-top: 8px; }
.steps { list-style: none; counter-reset: step; margin: 10px 0 0; padding: 0; display: grid; gap: 6px; font-size: 13px; color: var(--ink2); }
.steps > li { display: flex; align-items: flex-start; gap: 10px; counter-increment: step; min-width: 0; }
.steps > li > span, .steps > li > button { margin-top: 1px; }
.steps > li > div { min-width: 0; flex: 1; }
.steps > li::before { content: counter(step); width: 22px; height: 22px; border-radius: 50%; border: 1px solid var(--border2); display: grid; place-items: center; font: 700 11px var(--mono); color: var(--ink3); flex: none; }
.sg-note > summary { cursor: pointer; font-size: 13px; color: var(--ink2); display: flex; align-items: center; gap: 8px; }
.mt8 { margin-top: 8px; }
.harness-card { display: block; color: inherit; text-decoration: none; }
.harness-card:hover { background: var(--bg2); }
.kpis .card .aval { font-family: var(--title); font-size: 26px; font-weight: 700; }
.kpis .card .anote { font-family: var(--sans); font-size: 12.5px; font-weight: 400; color: var(--ink3); }
.ctx-lead { font-size: 16px; line-height: 1.5; color: var(--ink1); margin: 0 0 14px; max-width: 760px; }
.more-charts > summary { cursor: pointer; font-size: 13px; color: var(--ink2); display: flex; align-items: center; gap: 8px; padding: 6px 0; }
.sg-hero { min-width: 220px; }
.sg-sub { font-size: 13px; color: var(--ink2); margin-top: 2px; }
.sg-foot { margin: 14px 0 0; }
.sg-proposal { min-width: 0; margin: 12px 0; padding: 12px; border: 1px solid var(--border); border-radius: 9px; background: var(--bg2); overflow-wrap: anywhere; }
.sg-phead, .sg-inbox-head { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.sg-phead .eyebrow { margin-right: auto; }
.sg-ptitle { margin: 5px 0 8px; font-weight: 700; }
.sg-pfield { margin-top: 6px; color: var(--ink2); font-size: 12.5px; }
.sg-pfield b { color: var(--ink1); }
.sg-pfield ul { margin: 4px 0 0; padding-left: 20px; }
.sg-handoffs { min-width: 0; margin-top: 11px; padding-top: 10px; border-top: 1px solid var(--border); }
.sg-hand { display: grid; grid-template-columns: 54px minmax(0, 1fr); align-items: center; gap: 8px; margin-top: 7px; font: 11.5px var(--mono); }
.sg-hand .cmd { min-width: 0; }
.sg-inbox { min-width: 0; }
.sg-inbox-head { justify-content: space-between; margin-bottom: 9px; }
.sg-inbox-head .card-title { margin: 1px 0 0; }
.saved-proposal { min-width: 0; border-top: 1px solid var(--border); }
.saved-proposal > summary { display: flex; align-items: center; gap: 9px; padding: 11px 2px; }
.saved-proposal > summary b { min-width: 0; flex: 1; overflow-wrap: anywhere; }
.saved-proposal-body { min-width: 0; padding: 0 2px 12px 21px; }
.status-chip { font-family: var(--mono); font-size: 11.5px; border-radius: 999px; padding: 3px 10px; border: 1px solid var(--border); }
.status-chip[data-status="new"] { color: var(--ink3); }
.status-chip[data-status="running"] { color: var(--ink1); background: var(--accent-weak); }
.status-chip[data-status="proposed"] { color: var(--good); }
.status-chip[data-status="applied"] { color: var(--good); background: color-mix(in srgb, var(--good) 15%, transparent); }
.status-chip[data-status="verified"] { color: var(--bg); border-color: var(--good); background: var(--good); }
.status-chip[data-status="legacy"] { color: var(--warn); border-color: var(--warn); background: transparent; }
.status-chip[data-status="dismissed"] { color: var(--ink3); text-decoration: line-through; }
.status-chip[data-status="failed"] { color: var(--bad); }
.rrow { display: flex; gap: 10px; align-items: center; padding: 9px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
.rerow { padding: 8px 0; border-bottom: 1px solid var(--border); }
.rehead { display: flex; gap: 10px; font-size: 12.5px; align-items: baseline; }
.saveval { font-family: var(--mono); font-size: 12.5px; color: var(--accent-ink); font-weight: 700; }
.sigline { font-family: var(--mono); font-size: 12.5px; color: var(--bad); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rollrow { padding: 7px 0; }
.rollhead { display: flex; font-size: 12.5px; gap: 10px; }
.cardsub { font-size: 12px; color: var(--ink3); margin: -6px 0 10px; }
.ctxhead { display: flex; justify-content: space-between; font-size: 12.5px; color: var(--ink3); margin-bottom: 8px; }
.smt8 { font-size: 12px; color: var(--ink3); margin-top: 8px; }
.catbar { display: flex; height: 14px; border-radius: 7px; overflow: hidden; margin-bottom: 10px; background: var(--bg2); }
.herotitle { font-family: var(--title); font-weight: 700; font-size: 17px; }
.dim { opacity: 0.55; }

@media (max-width: 860px) {
  .app { flex-direction: column; height: auto; overflow: visible; }
  .side { width: auto; border-right: 0; border-bottom: 1px solid var(--border); }
  .navwrap { display: flex; overflow-x: auto; gap: 4px; padding: 0 12px 10px; }
  .navgroup { display: flex; align-items: center; gap: 4px; }
  .navgroup-label { padding: 6px 8px; white-space: nowrap; }
  nav a.navitem { white-space: nowrap; }
  .main { overflow: visible; }
  .page { padding: 16px; }
  .overview-hero { padding: 18px; }
  .overview-brand { width: 96px; height: 96px; }
  .overview-brand .logo { width: 82px; height: 82px; }
}

@media (max-width: 560px) {
  details.finding > summary {
    display: grid;
    grid-template-columns: 12px 28px minmax(0, 1fr);
    gap: 6px 8px;
    align-items: center;
    padding: 12px;
  }
  details.finding > summary > .chev { grid-column: 1; grid-row: 1; }
  details.finding > summary > .sev,
  details.finding > summary > .rank { grid-column: 2; grid-row: 1; }
  details.finding > summary > b { grid-column: 3; grid-row: 1; }
  details.finding > summary > .fsave,
  details.finding > summary > .pill {
    grid-column: 3;
    justify-self: start;
    max-width: 100%;
    white-space: normal;
    overflow-wrap: anywhere;
  }
  .sg-body { padding-left: 16px; }
  .saved-proposal-body { padding-left: 0; }
  .sg-hand { grid-template-columns: 1fr; }
  .sg-hand .cmd { width: 100%; }
  .navwrap { flex-wrap: wrap; overflow-x: visible; }
  .navgroup { flex-wrap: wrap; }
}

@media print {
  .side, .page-tools, .no-print { display: none !important; }
  .overview-brand::before, .overview-brand .logo { animation: none !important; transition: none !important; transform: none !important; }
  .app { display: block; height: auto; overflow: visible; }
  .main { overflow: visible; }
  details.turn > .tbody, details.finding > .fbody { display: block !important; }
  .card, .kpi, details { break-inside: avoid; }
  body { font-size: 11px; }
}

/* beta feedback (interactive only in the localhost serve bundle) */
.feedback label { display: block; font-size: 12.5px; font-weight: 650; color: var(--ink2); margin: 12px 0; }
.feedback input:not([type="checkbox"]), .feedback select, .feedback textarea { display: block; width: 100%; margin-top: 6px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg1); color: var(--ink1); padding: 9px 10px; font: inherit; font-weight: 400; resize: vertical; }
.feedback-grid { display: grid; grid-template-columns: minmax(0, 2fr) minmax(150px, 1fr); gap: 12px; }
.feedback-preview { max-height: 280px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; border: 1px solid var(--border); border-radius: 8px; padding: 10px; background: var(--bg2); color: var(--ink1); font: 12px/1.5 var(--mono); }
.feedback-check { display: flex !important; align-items: flex-start; gap: 8px; font-weight: 500 !important; }
.feedback-check input { margin-top: 2px; }
#fb-fallback { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
@media (max-width: 640px) { .feedback-grid { grid-template-columns: 1fr; } }
.feedback-root { display: block; overflow-y: auto; }
.feedback-shell { width: min(900px, 100%); margin: 0 auto; padding: 28px 24px 64px; }
.feedback-shell .page-head { justify-content: space-between; }
.feedback-launch { position: fixed; z-index: 80; right: 18px; bottom: 18px; border: 1px solid var(--border2); border-radius: 999px; padding: 8px 13px; background: var(--surface); color: var(--accent-ink); box-shadow: 0 5px 20px color-mix(in srgb, var(--ink1) 14%, transparent); font-size: 12.5px; font-weight: 700; }
.feedback-launch:hover { text-decoration: none; background: var(--accent-weak); }
`;
var BUILD_VERSION = "0.6.0";

// src/report/brand.ts
var BRAND_ICON_ID = "orangu-brand-icon";

// src/model/app-data.ts
var APP_DATA_VERSION = "1";
var STRIPPED_KEY = "\u2039stripped\u203A";

// src/serve/types.ts
var LIVE_THRESHOLDS_MS = { live: 5 * 6e4, idle: 30 * 6e4 };

// src/serve/badge.ts
function badgeFor(mtimeMs, now) {
  const ageMs = Math.max(0, now - mtimeMs);
  const badge = ageMs < LIVE_THRESHOLDS_MS.live ? "live" : ageMs < LIVE_THRESHOLDS_MS.idle ? "idle" : "ended";
  return { badge, ageMs };
}

// src/redact/redact.ts
var PATTERNS = [
  // API keys / tokens (do these before generic ones)
  [/\bsk-ant-[A-Za-z0-9_-]{10,}/g, "\u2039anthropic-key\u203A"],
  [/\bsk-proj-[A-Za-z0-9_-]{20,}/g, "\u2039openai-project-key\u203A"],
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g, "\u2039stripe-key\u203A"],
  [/\bwhsec_[A-Za-z0-9]{16,}/g, "\u2039stripe-webhook-secret\u203A"],
  [/\bsk-[A-Za-z0-9]{20,}/g, "\u2039api-key\u203A"],
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g, "\u2039github-token\u203A"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, "\u2039slack-token\u203A"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "\u2039aws-key\u203A"],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, "\u2039google-key\u203A"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, "\u2039jwt\u203A"],
  [/\b[A-Fa-f0-9]{40}\b/g, "\u2039hash40\u203A"],
  // connection strings
  [/\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s'"]+/gi, "\u2039db-url\u203A"],
  // bearer/authorization
  [/\bBearer\s+[A-Za-z0-9._-]{12,}/g, "Bearer \u2039token\u203A"],
  [/\b(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*['"]?[^\s'"]{6,}/gi, "$1=\u2039redacted\u203A"],
  // email
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "\u2039email\u203A"],
  // long hex/base64 blobs
  [/\b[A-Za-z0-9+/]{60,}={0,2}\b/g, "\u2039blob\u203A"]
];
var counter = 0;
function scrubStr(s) {
  let out3 = s;
  for (const [re, rep] of PATTERNS) {
    out3 = out3.replace(re, () => {
      counter++;
      return rep;
    });
  }
  return out3;
}
function basename3(p) {
  return p.split(/[\\/]/).filter(Boolean).at(-1) ?? p;
}
function encodedProjectLeaf(value) {
  let inMarker = false;
  for (let i = value.length - 1; i >= 0; i--) {
    if (value[i] === "\u203A") inMarker = true;
    else if (value[i] === "\u2039") inMarker = false;
    else if (value[i] === "-" && !inMarker) return value.slice(i + 1) || "project";
  }
  return value;
}
function isEncodedProjectSlug(value) {
  return value.startsWith("-") || /^[A-Za-z]--/.test(value);
}
function projectIdentity(value, opts) {
  if (!opts.scrub) return value;
  const scrubbed = scrubOne(value, opts);
  if (isEncodedProjectSlug(value) || isEncodedProjectSlug(scrubbed)) return encodedProjectLeaf(scrubbed);
  if (opts.stripPaths && (scrubbed.includes("/") || scrubbed.includes("\\"))) return scrubOne(basename3(scrubbed), opts);
  return scrubbed;
}
function detectHome() {
  const proc = globalThis.process;
  return proc?.env?.["HOME"] ?? proc?.env?.["USERPROFILE"] ?? "";
}
function homeRegExp(home) {
  if (home.length < 2) return null;
  const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(escaped + "(?![A-Za-z0-9_.-])", "g");
}
function homeSlugRegExp(home) {
  if (home.length < 2) return null;
  const slug = home.replace(/[^A-Za-z0-9-]/g, "-");
  if (slug.length < 2 || !/[A-Za-z0-9]/.test(slug)) return null;
  const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(escaped + "(?![A-Za-z0-9_.])", "g");
}
var TEXT_KEYS = /* @__PURE__ */ new Set([
  "promptPreview",
  "summary",
  "inputSummary",
  "resultPreview",
  "preview",
  "detail",
  "sampleHint",
  "signature",
  "title",
  "label",
  "description",
  "args",
  "command",
  "message",
  "errorHint",
  "teamName",
  "taskKind",
  "url",
  "template",
  "sample"
]);
var PATH_KEYS = /* @__PURE__ */ new Set(["path", "cwd", "transcriptPath", "file"]);
var PATH_ARRAY_KEYS = /* @__PURE__ */ new Set(["subagentPaths"]);
var PROJECT_KEYS = /* @__PURE__ */ new Set(["projectSlug", "project"]);
var NARRATIVE_TITLE_RE = /^In “[\s\S]*?”, (?=the human made )/;
var PRIVATE_STRING_ARRAY_KEYS = /* @__PURE__ */ new Set(["gitBranches"]);
var UNKNOWN_COUNT_MAP_KEYS = /* @__PURE__ */ new Set([
  "unknownRecordTypes",
  "unknownBlockTypes",
  "attachmentTypes",
  "attachmentBytes",
  "systemSubtypes",
  "queueOperations"
]);
function scrubOne(s, opts) {
  if (!opts.scrub) return s;
  let out3 = scrubStr(s);
  for (const re of [opts.homeRe, opts.homeSlugRe]) {
    if (!re) continue;
    out3 = out3.replace(re, () => {
      counter++;
      return "~";
    });
  }
  return out3;
}
function isAgentRecord(obj2) {
  if ("toolUseId" in obj2 || "category" in obj2) return false;
  return "spawnDepth" in obj2 && ("agentId" in obj2 || "hasTranscript" in obj2) || "agentId" in obj2 && ("agentType" in obj2 || "status" in obj2) && ("toolErrors" in obj2 || "tokens" in obj2);
}
function isRuleRecord(obj2) {
  return "ruleId" in obj2 && "severity" in obj2 && "axis" in obj2;
}
function isQualitySignal(obj2) {
  return "tone" in obj2 && "value" in obj2 && !("ruleId" in obj2);
}
var SAFE_EVENT_KINDS = /* @__PURE__ */ new Set(["interrupt", "pr_link", "plan_mode", "model_fallback", "permission_prompt", "away_summary"]);
function isSafeEventRecord(obj2) {
  return "kind" in obj2 && "turnIndex" in obj2 && "label" in obj2 && SAFE_EVENT_KINDS.has(String(obj2["kind"]));
}
function stripsText(key, source) {
  switch (key) {
    case "name":
      return isAgentRecord(source);
    case "title":
      return !isRuleRecord(source);
    case "label":
      return !isQualitySignal(source) && !isSafeEventRecord(source);
    case "detail":
      return !isQualitySignal(source);
    default:
      return TEXT_KEYS.has(key);
  }
}
function strippedCountMap(value, opts) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return walk(value, opts);
  const source = value;
  if (!opts.stripText) {
    const out3 = /* @__PURE__ */ new Map();
    for (const [key, count] of Object.entries(source)) {
      const publicKey = scrubOne(key, opts);
      out3.set(publicKey, typeof count === "number" ? (Number(out3.get(publicKey)) || 0) + count : walk(count, opts));
    }
    return Object.fromEntries(out3);
  }
  const total = Object.values(source).reduce((sum2, count) => sum2 + (typeof count === "number" ? count : 0), 0);
  return total ? { [STRIPPED_KEY]: total } : {};
}
function walk(obj2, opts) {
  if (typeof obj2 === "string") return scrubOne(obj2, opts);
  if (Array.isArray(obj2)) return obj2.map((x) => walk(x, opts));
  if (obj2 && typeof obj2 === "object") {
    const out3 = /* @__PURE__ */ new Map();
    const source = obj2;
    const unknownRecordTypes = source["unknownRecordTypes"];
    const unknownRecordKeys = unknownRecordTypes && typeof unknownRecordTypes === "object" && !Array.isArray(unknownRecordTypes) ? new Set(Object.keys(unknownRecordTypes)) : void 0;
    for (const [k, v] of Object.entries(source)) {
      if (UNKNOWN_COUNT_MAP_KEYS.has(k)) {
        out3.set(k, strippedCountMap(v, opts));
        continue;
      }
      if (k === "recordCounts" && v && typeof v === "object" && !Array.isArray(v)) {
        const counts = /* @__PURE__ */ new Map();
        for (const [recordType, count] of Object.entries(v)) {
          if (opts.stripText && unknownRecordKeys?.has(recordType)) continue;
          const publicKey = scrubOne(recordType, opts);
          counts.set(publicKey, typeof count === "number" ? (Number(counts.get(publicKey)) || 0) + count : walk(count, opts));
        }
        out3.set(k, Object.fromEntries(counts));
        continue;
      }
      if (opts.stripText && PRIVATE_STRING_ARRAY_KEYS.has(k) && Array.isArray(v)) {
        out3.set(k, []);
        continue;
      }
      if (opts.stripText && typeof v === "string" && stripsText(k, source)) {
        out3.set(k, "");
        continue;
      }
      if (opts.stripText && k === "narrative" && typeof v === "string") {
        out3.set(k, scrubOne(v.replace(NARRATIVE_TITLE_RE, "In this session, "), opts));
        continue;
      }
      if (opts.stripPaths && PATH_KEYS.has(k) && typeof v === "string" && (v.includes("/") || v.includes("\\"))) {
        out3.set(k, scrubOne(basename3(v), opts));
        continue;
      }
      if (opts.stripPaths && PATH_ARRAY_KEYS.has(k) && Array.isArray(v)) {
        out3.set(k, v.map((x) => typeof x === "string" ? scrubOne(basename3(x), opts) : walk(x, opts)));
        continue;
      }
      if (PROJECT_KEYS.has(k) && typeof v === "string") {
        out3.set(k, projectIdentity(v, opts));
        continue;
      }
      if (k === "byProject" && Array.isArray(v)) {
        out3.set(
          k,
          v.map((item) => {
            const row2 = walk(item, opts);
            if (row2 && typeof row2 === "object" && !Array.isArray(row2) && typeof row2.key === "string") {
              return { ...row2, key: projectIdentity(item.key, opts) };
            }
            return row2;
          })
        );
        continue;
      }
      out3.set(k, typeof v === "string" ? scrubOne(v, opts) : walk(v, opts));
    }
    return Object.fromEntries(out3);
  }
  return obj2;
}
function redactAnalysis(a, options = {}) {
  const scrub = options.scrub ?? true;
  const home = options.home ?? detectHome();
  const opts = {
    scrub,
    stripText: options.stripText ?? false,
    stripPaths: options.stripPaths ?? false,
    homeRe: scrub ? homeRegExp(home) : null,
    homeSlugRe: scrub ? homeSlugRegExp(home) : null
  };
  counter = 0;
  const redacted2 = walk(a, opts);
  return { analysis: redacted2, report: { applied: counter, scrubbed: opts.scrub, strippedText: opts.stripText, strippedPaths: opts.stripPaths } };
}
function redactValue(value, options = {}) {
  const scrub = options.scrub ?? true;
  const home = options.home ?? detectHome();
  const opts = {
    scrub,
    stripText: options.stripText ?? false,
    stripPaths: options.stripPaths ?? false,
    homeRe: scrub ? homeRegExp(home) : null,
    homeSlugRe: scrub ? homeSlugRegExp(home) : null
  };
  return walk(value, opts);
}

// src/report/render.ts
function safeJson(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}
var CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'";
var BRAND_MASCOT_96_DATA_URI = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAYAAADimHc4AAA6jElEQVR4nO29d5gcxRWv/VZ1T9yclLMEyhICJCEQSOScBFqSwQQTTDDBGExcLcmAweSMjQGTtGSDyEGAQCBAgKQFhFDOm3fydHfV90d3z8xKAgeE7e/eW8+zOzPdPd1V55w653dC1cD/D1tdXZ0EJEAgFEZr3e/Pt15/yrkn1t5z3IFT3z/24L2eXrasrVxrhNZa/Je7+39Wmz59ugEQCkd449mZk044fP8/7zJm0Nqx/Ur0Dn2CetsS9CGTx+jmzvQIyDHr/7Wf2rTWYgqYABs2rBxyypEHztxxcI0a20PoadsK/dChJc6+g4Q1Ydue+m/33HaoEIIdIAAYuLNFTpkyxfQY8v9mxb/ScmpESO784zVn7za6/8bhNUKfPNbU751caXde0kv99ZBSZ3iNqW6sv+y6YDhCJFqEkAZCGgRDIULhSJd7/q/MjP9ZSdBaixkzZoh3362Xs2dja60D5584/eo333zt4hozxu92KbN36BE2NZB20Ec+uUH0HT1pw2/OPu+KJ595Zlwq2TlwzYrv0/GURXWPPtH+PWuaS0sq3t/70NqvDple+2Ei1vnfHiLwP8iAuro6WV9fLwAHACHQSgV/c+KR97726qyTdu3pOJdMLhPlISE7MpqioOSNpRmunN1BIFqmIoYjhZUkhENl1MDRkMw6KIBAFCNaqWq69Xhrh50m11963S0fCSE0oP9b4/2fYUAh4YU0UI4d/ts9t4z/asGi3VevWjp1/qcf7j61l3bqd6+QtqNFxtEIoCwsuOitDuats5ja12BUTVCN7RFWxQEhQFAUkhQF4O/fJLj/87gRt0DZMPnA6a33PjpzkBCiU2uNx4j/ePuvM0BrLYQQEnDMQJCVi78d/serLzvhs8/nHdTc3DTKsOIEhc3ugyPqwp1KZSar0WikEGhACljRYREJSAaVm9hKk7U1tgLDELSn4ZGvEvrt5RmIVrZ1r65+r3f/wfNGT5z86tnnX/TF/9UzwJN6hZBk0h2jLzjlxLM+n//pCe0bV0cGlTrs0j/M+D5hp29pgLKANCxHows7LUBpCBkCpTUZGxAaNJgSWtKa374V4/NVGbXv5O3lL07/3ccH1R79G2CeL/G6rk6K+nr1XyLBf48BM2fONGprax2tdfi+m6+58tmGmeevXLIoPKEn1I4qcbbrHhKRANJWkHXA1i6WFKKw267gKk9+pQCtwdGakqDk8UVJnv82hSEFrSlFS1LTu/8gBvUbMO+waYfdfcSJZz0lhEhNnz7daGhocP4LZPjvMKBuyhSzfvZsW2s99KLTf/HUSy++MLZ3MM65O5c7O/UOS621SFoaR2ukACkFILzOFs6BLb3PM8VlmCaZ1bQkFcs7LeasiPHxKoiHa9h54oSPL7rmxsuGDRv5Fu7l//GZ8B9nQF1dnVlfX28v+bZx2mW/OfWOTz6a0+vY0WH7jB1LjYiBiFnudbKgZ3mpL1TVooD2Gq2964QADVpr75TLRFNA0BAIKWhOavXUgk7192/TZq/hO3D+ZVedt/dBh9926SWXuCrxP9j+owzwif/l5/OOvOqic2Yu+HSuuGL3MuegwWGjM6NwtMAwfFILRKGE53qqPWEvnA+6gDcixyvtHdfehY7WGAJWdipa0orPN2Sdxz5JiLE7jJa/+PUl+xxx7LFvzJw53ait/c+pI/M/9SBP59urli8/8IJTj37yi4/m6jsOrdQ79woYLSmFIcE0XGJ5stuV6Gw2Jdy3/n+BawCEzn0WBceFAK0EQUOwJpbllk9ibExgVJYZ9qpVK1m4YP6Uujr91l13Tf2PCuV/5GE+2tFaD6zdb/L78+fO6X3HQRXOhB4Boy2tCRh5qaXAyIouDPix7vpfdsVdeBC1sGnt/lMaioMQzyju/zLF3z5PqKl77e088vzrU4QQH71T9465e/3u9lYc/o+2n30GeDhfaK3D559yzN/mzZ3Tu35quTOpV9BoSakc8bvimq7NV0Y/8pTcdYj8J4/q/hm0EEihiWXBkJKLJkTpWyy5dfYb5tH7TbpLa10rhPj+PwlNf3YG1NbWSoR0brry4rNee+XFnY8ZGbYP2SZktqYUAenraVGg1nNKJddy+EaTVzEFbVMc5M4HvYU7uG9Nz39oScOxoyIyGhCq7t1Pxl1wylHPa613EEJkPcH52R20n5UBvuppa2sbcMDksVf0CSf1ryd0N+JZhSFcQ+s3X22IH9AyGrqop9xBsYVZkwNMXZngzwLtvQ8Y0JJUHDwkLNfGLPvRl54d2feqS+4KhsK/qq2tNfDjUT9j+1lDso319SIQCOoLT5l+QeuGVdVnTyxXRQbCVpsTWqN9BImjQWmdg5JKg6MKNAp4Hyi02p4T5l7rnhI42nXidA4oufhKuJgVQwpiWcVp25eao8od+/nnnznlw3fePryhocGZOXOm8TOSB/gZGVBXVycbwGmc+9GQLxYsPHWX3lLt0isoOzMu4vH1ssg5WC7hAlJQHpZURAyKQwbRoEFZxKQqahAxXcYoVTB3hGtYldJETaiOuN+NBA2KwiaVUZPKsCRggFI+I1zmCoEXUxLYjuK8XSpF07Lv9H23XP07rXW0trZW/9wpzZ9NBTXW1wuttThl2r4np9o3ho+eUOZohKRQrXpDUxpMISgJSdYlNbO+S/DFmiQr2l0w0q1YMrQmzPg+EcZ0D+I4mkRWYRpgKygKgCENFjVlmbMiyXdNadbFNOEA9Ck3Gdk9woQ+EfqWGCQthVI6JwQIjZSQtDQjqwPGYcODzqvzP5v06tOP7Q28MGPGDBP42VDRz8Jd34Bprct2226bxp6Zpb1u379aJW2kKbuaV0dBUUCQcAQPze+k4cskCSPA0MG96d2rhkgoyJoNrTQuXkW2I86UQZLTJ1YxrMIknnWoiEg+X29z90ctfL5eE64sZ1C/nvTuXoVybJat3sjX360imLU4bocIJ21fSkQKUpbLBKFdc621JmwIVsUd56TnW+S4Sbs/88iLb9cKV1f9bIjoZ5kBtbW1EnDuv+mqyU1N63oePSakggYyaXXF844SFAVhRYfDBa80szoT5vSTDuXwA3ZjcJ8ajGAAhAQrS1NbnPfnLeLm+5/nmMdXc9V+5Rw+JMKTi1LcOLudvkMGcuM1BzB14mgqy4shEATl4GTSrFjXxnOvfsjdf/07b3+/gT8d2I2BJQYJDwz4BjplKwaWmXJSH1PM+/qbPYBuwIafExH9TCqoASkNPvn08/1LZUZM7F3qpC0tZc7iuHo7EpCsiilOea6Zyj79ePmGcxg+rB+kslhZCytjARopJFWlRUw7aDL7T92eq297khlPvc5Hqy1eWJDg9F8ewOXnH0sgaOIkUmRTGVQiDQKklAzqXcNvz6nlwD3Hc8bFd3Dm86u5//Bu9IxKMrabW/BgABItpvSPqDmftFXeed2lewKPz5g61eBnUkNb1Qh7iW6joQHtOHZ4xapVO/WK2vQuNWVW+XLvBs4MKcgqwe9fa6G4R28a7r+U4YN6kWzpIJO1XGJIiTQMhBTYtk2qPU4AwXVXnsZpJx/GY/MSXPKbI6i/9GTIZEi1x3GURgiJYRoYhoEQgkzGItnczrBt+tBw3yXIip5c9kYLWuh80E8IpICUrRnVPaAjZFm2ZsMRhmFQP3u2AoyfwyBvNQb4mD8QCjmRomIF1KRT8UGDyiVhUwqVg48ukikOCJ5aGGdRu+SB68+kurKUZCxJIBBACoEQeafK88AwTQNHaayOTi46bRrP/fkizjr+YKyOThQC05AevCxo2o2sBgIBUh1JarpV8uAfzmBRCzQsilMSEi7TcKGxpaAqEhDVIc2aNesG2rZdpLUWSMPx7NpWZcJWYYDWWtTX16s1a9b0+9WRB909YWDVnCP33PGN1pam8p6lIR/xeddCQEJzSvPoZzFOOWoPRoweQqozTiCwCezOOVQidwMpBVoLlOOw95RxaOXOKJnnVv7Pdxy875oBk1RHnDHjhnH0YVN49PMEHVkX+vq5Ng0EDSH6VQZZ9Nl7fScN7/fp1FED5l965i9u1VpXCiH01ixp+ck2oK6uTgoh1PyF3044+fC9nlix5OtBI0cOgeR62traKAqV5sMCXki42JS8uSxFpwhw/LQ90OkM0sgTXwiBUi5cFML9LAoAm/C86HQ8iZQyf87PAQDK88b87+ZILCU6a3PC4Xsw88XZzFuTYs8BEToznjoSAtNAFAUlVjZbPWpQeXUskeKZxx8d/dnnC8ZrrQ8TQrRsLcP8kxhQADfDJxyy+x1rViwZdNuNv83uM3VHs7MzxZQjL5QmKaSI5sIMQruGcc6yOCOGDWbIwD5YqbRnCD105DiEQkEIukgmm0yjlUYUQFiBxpB+kZtHXI9xUkC4OApSQiZLJmMhpMsGKQR2Os3QwX0YMqgPHy1fzd6Dor6Wc4liSFQ2w4hRI/QD91+lyWR56LFZ1h9vfWTn35ww7UozEDxna4UqftJUmjFjhgHo11564fjPPpk74YxTptn7HLx70IrFZWlFVA4dOoiVbWmMAsJJKbCUZnmrYuSwgYhQAEepLh5JqKSIletbef2dT5n72TdI0yAYCqLVlgQuHwnVSruMMwPMmfc1s16fy8r1rYRKinIxINf30ASiYQb06833LQ6Ozqs4IUBpwZq4YsL2IwU40o7H5UknHxacsstoNWfOhyda2cyghoYGZ2uoop80A+rr67UZCPDiE49sFw4Jfch+k4VqbWVda4IyM8Q5h43nu+e/JOu401sDhoSko+mwYEDPStBuYMhV1wozEubW+5/lrvsaSKc1lgW77jKMW/7wG3pVlmJlMkghN3EhBUorAuEQy9c2c8EVdzH3k8UYBhgBOP+s6Zxz0qHYqWw+Si00PWrKWZaFrKPzyRsEacth6qAiDtt/R5Z/vx6VyTCwpEgccsAU/d7ce4rv+eO1OwBLGxsbf7JB/qkc1IZp8t3S7wfU1FSJXt2qsWzFFTc/zB6HnUfJmvkcOryMjrTv8OSTVpYDyAAIw02UOIpgSRGvv/MpV98wk/32msBzT17NHTf9mi+/WsJlV9+Dll5mYAvDFoASgsuuvY/5X33PPbeeywtPXceh+0/iuhsbeH32fILFUZRSuNDIIBAMkbLcTkmvnEUACUvxy9HFzH3xGfauvYhHnn8HYZgMHjBAmcGAXrZ8+VCAjRs3/tcZgECQiXeapUUhDGy0leWeG87lwL0m8vnceSgjSECCQiC0GxAzhKAkCB2xOC5aUS66cRT3P/I8O+3Yhztu/B07Dh/I9OMO5KrLTua5Vxcw/6slBIuKcJy86tUalHIIFkWY/+ViXn2rkRvrT+HQI/Zk+2H9ue36Cxgzuhf3PvQsKNszyoByaGttozTshqXzKFkTMsCRkvkffcLlvzuJut/+AtXRQSRkUBINiqY1y9M/lW5++6kMEJZtE4lEkraVxdImhmESDRhc/KuD2W10X2KpDJYWhUlDQgb0LYXFS1eBZeMWxoF2HIxAiH32mAhSEO9MYm9sYbeJ2zFmeA8y2awbDS2oevB1uuMoHNth5MheTJ44Dru5jXhnAi0lUyZvT3FJMX5uTUqBTmdYsnwN29ZIDOlGYgUaU0BHBpo705yx3yiO3Xc8djyFDIRIW4pYMqur+gwyALp1m/2TUdBPngFSwJDho5pWr2vRTc3N2gwGSGdsIkEDC4PTXm5jaUuWqOlGPZWGoITh3UN88tX3xDoSBIMBtNYox+Gvt/yOU4/eD6uzk1AoiHYcupWHmfXo1UwYPRipHKKlxRhSopXGNE33M4odRw3m5Ueuobo4iHYUoVAQq6ODC04+hPuuPxc7k3X9kGCQdc1xvl26mjE9IwjPt1JANADftFic/WoHSpoIobGUQgdNvlm8RGYtR4wcMWq5O/rpP5V8P40B06dPx8pmGTd+/NutnWkxZ94iKSIRhBDYCs55pZWeJZIx3UxiWVfPCiBtKXYZUEzrhjbem9eILIqgcVVQOGAQDPjYwC32cRxFaWmEQCjCl4uW8uHHC0g5EAiZxJIZ5sxdwGdffocMBSgpDuE4vp1wBTQYCBAyzZzTJqIRZr37GTqeYsdeUdKWm6MQQEdaM7VvgKIA/OblDRiBAEJrhGnqdz6YL4pLyjpOOvOcOQAjRoz4yTPgJxmRAj+gYtdRA7+qLhe9Gv5yHWZQyIf+9hpX3fAQzxxTQ+/ifPgX3Bh+NGhyzssbsLsP4en7r8DOZBFCFqgWFxoqpQlFgnzZ+D0XXvMQTjaFlgGGbdufC35dyx9ueZQ1azeQTqYIhiPcePmvGDd6GzJJ37fompiUUmA5DnsecwkTitu4cmo1HSkH03MpHC+/0Nhic9JzrfzxqrM4onYPvl+03Jl+4iXGmAlTnnhi1vvHZjPprVJJ95NmgBBCT58+3ZCG0Xb40cfdt2DhCnnfX59zsirInQ89y3FjgwwoN0naYBrChZteOlCgOGNiBe/PXczDT79FsKoCx3bcc14sSGuNaUraY2l+O+Me9p+6I2823Mw7T9/ElWfX0q0kyvUX/ZLXnvwDs1+8gwP2mMjZl99JS3sc0zRc3C/IxZW0UpgV5dz20EusXr6RY8aWk7VVDiKDC5Pjlma77kH2Hmhyy5+fpzOu9OXX3U9Gh1Pn/K7+D9lMWtTV1f1U2rs0/Kk3KCg7KTuj9qDnP3r3ld0GjximFyz4Wjx6eCUDy0w35CtBa5FLBdqOpjQkue3TJH/7Ksnjd1/KxO2HkkmmMQzDC1sowuUl/O2xWSxYvJwb7ricd599g0g4yMTxI7DiKQLFUd7/4HMytmavI/fm9+dcy+hhAznu2ANIt8W8UAUorQiVFDHr9U847uw/ceXepfxqbJTmpIMpBNrz0gEvVA6frLG4eHacPj2qdVt7Uux31EmXXPvHO64/4ohpW62Yd6tE9gpUUcl5Jx/9/LMzn5q67/Cw+MPUMpHIuMQvbL4hbklrzp3VQiZazb03ncfwQb2xsxbSCzForTFDARoXryIaCdO9ewW7HXQ27Z0pnnnkWsaMHsznnzZSe0o9kaIgH79yN62tncQSaYYP6YOVsXKxJKU1ZjBA4/drOe/S29Gta7n1oGq6RyUZWxVEiwqIIyXnvNKiv20LZo7+xfG/r7v53ju8GaryqvKnta0S1fMihKYQInbqub+7tqxbjdi+RrjpDTz42SUVLEAYXPNuG02Bah6/9xJGDe2PnckT37sxTsZm1DZ96d+zknAoyJGH7klLu2Le543IkiifzP+Gpk7NyUfvRyQUpHdNBSMH9/bulQ/iSSGwMxajh/Xj8XsvJVbcmyvfagXhh+q6jAdHQ0kQPa6boKimh667+d6XfMJvLeLDVsyIvfvuuwDioXtun2haMTGye9SWAjNoSmylcrEWR0N5SPDUojjvr9W8+vCZ9OvTjVRHAsM0XRUFHmEAAdms5SZxtMXFZxzJ1J3HMqRfD5ymVo4+ZHfGjdmWCaMHo20Hx3H/hD/tREHBlhCkOuN0717JU3ecx+5HXcbDX8Y4fYdS2pNOQWYMwgGJAWJ4dVA9v6Ipcvs1l+8khPi+trb2fy8fADB79mxtBoK6pXnDgMqgxeCqgPi62WJxq0XYlG45iFeVFrc0D34S49hpuzN63AhSnUlM08D0QzybJFWEEEjpRjpt22LSDsOoKitGZWzKi4NM2n4ojmV7kVCRJ77/fW8aBkyJaRqkOuIMGtqfX59wAE/MT9CU8upTccPckYBg4UaLLzZabFsV1tLJsL65eRtX8hu2FsmArZuS1KZhEM/qviaKjZ02Z8xqZXWnRcjwnDAgEhB8ujZNk21w4uFT0OmslwETtCWy6M261BVKCiTpZBrbdtCeMc8k0vkZswWz5uYPNBvbkyAkhmGgEmmOOXgybYSYuzJBNODaCddTF3zfZnH2q+2ks1qXBATLli8VABs3bt1Kkq3KgFQqKaKRsBk14baPO2hKKnoUm2SdvFCbUvLx8gSDBvZm6KC+WOk0AVPSEU9x4C+v4MvvVmFGIm6IujAJgzsT/ES7+9aDrIbwShvFZvRXWiPDIb5dsYHDTrqC5rYYAdPASmfo17s7Y0cOZN7KBH42DO36KdURSVNS8deFMUxDk3UM8+dY3L01bygASqOhliVtmkXtQXqUBsjYKreGy48HLW+z6dOnO2ZRBKU0jqMprSinMmryWMMriFCgIPa/icHzdZkHHQsvEcI/nT+gHAcZjfDkc28RMaGyuhzbdlBaI4IGg/r1ZFW7wvFqFzWu82cIKA1JPlhji7asZNL4iRvq6+tVU9MIuVne+Se0rcaA007bwRBC6IFDRnwUDQfp0b0nCRWmJWkRMsllxGylSdhQURIG3ESMozWBgOTi807k0ac/4q035xKpqcSyu0JtrQuAoscIlxdbIojAthwiFeV8+P5nPPLkm1x83gmEQqaXhHczcBUlUdK2K/X+M4TQxDIKrSEopYwnLb1k0Wd7a61HNDY2ZrXWYmvNhq1yk+nTMe6//zOrqLiEdCpZnFQh5/ul30uRjbExlc82OcotRwkZkEw7Xi7ArdXPxBJM2XU7Tjp6Kmf89hYaFy0lWlWK47i54ULo5xPPbfnjfsZLa43j2ESqy1mydC2/PPuPTDtsN/bdd2eysSSGkVdVsWQGKcBz1NG4ZZKLmh3KQ/Dg/mXikG0DvP3WrIN2327QW9dcePoJfhHC1mDCT7qBKwlTzIYGnKbVTUMP2227Fx+6/65re4VT8u6DKsX4XiE+W5tBKeWWAHrSuk11gPXrNrjJeCndkigpyXbGuf6KU9ln9/HsNe1CnnnhPcJVFYSKIl7SxnGT9dr984seXDXmuKEMBKHiIsLlZfz95Q84pPZC9thlNH+84ldkOzrdSjuv5ghb8e3y9fQuE27xrlevlLYFXzfbjO1uMqwmwO8mlYo/H1zuVKSW93j8iScePvPYQ/6qte5TX1+v6qZM+UlQ/t/+sh+CAOznnnjgqNpDd71t4/Jvu5+9Y1QdPrxCVoUkywaGueWTTtZ1OpQEDRQaoRUjekZ59qM1rF67kd49qrAsBylclKQti9uvO5PuPau58NI7ePbF2Zx58sHsvMMIRCQMtg1ZK1/qLA03Jm4YYBqotMW8L77jnj8/wytvfcEZJx/A5ecfh85aKO3bCY1pGrS0dLBi+Ur2HxbGcXS+ZCatWdbpcPzoKAkL4lnNsKqAcdsB3fT989qdp954+fgj99p5x9mvvXDglH0PXYa7Jc6/FZr4t6yJ1lp6XqF5U/1F5z543wPX9gm1h66cUmmP7hY0O9OOV/0Gtc+1ctg2EU4bV0xH1iFkCtqzgoMf3cB55xzN2aceQaqlHcM0vIS426lgeSmfzlvINX/6G18tXMI2g3qy2y7jGD18MIP6dqOivBzDNMmmUnQkUqxZ18QnX3zLW+/PZ93a9ew4bhjnnXkME7YfSjaWdCPbXnGAbTtEKkp45IlXue6Gh3j6mBqqwm7EtiJicP8XSV5fluTRgyuwHT+R5FbOlYQksxYn7T+832lW9xm09vpb7jx10p4HzPp3F3v/ywzwJB+ttfHo3TfNvPv2Ww7vpTfqG/Yp12UhKWMZjellmMrDkpmNSR78MslLR1VjOYqMA2Uhg+vntPFBWymvPf4HokED5ejcgmy3rschXBwBQzL/q++Y9fqHvP/Rl6xc14JQNoGAgUKQtVy1VBIJ0L17DZN2HM2B+0xi+7HbgqNIJ1K5kIT2pF9KQdaBPY+5hO0jrVy7ZxWdaRtDChwF059t4azxxRy2TZjWlJfP9gyZo6AiBF9ssNSFr7XJbkPGcOV1N585afe975kyZYo5e/bsf6mG9F9igNZaTJ061Xj33Xfln++4+bFbrr/2yJ0q261r9q42HQdheRtkaA9QK6WJGoLLP+hkm+oAp40ppimhKApoYo5k2mMbOPiwPflD/VmkmtvcWZDrmcjZjmA0DMEApDM0tcVYv7GVjo5Okuks4XCI8rJSulWV0qOmAkJBtxYo6TpnsqAkRgOOo4hUlVN37QM8/virPH1cN7qHIWFpehQb3PlZghUxi6t3LSeW8ZdSdc1RWA6UhQSr4o465elmum87Rl5/692njd1p1wfeefttc/fd//lVlv8SA0477bTA/fffbz14xw1X/fnOP12xjdFi3bBvVcBWCttxDZhf9iFwjaP0slr1c2IcOyrK6JoA8ayiJCh5ZWmGC19p5+YZp/CL4w50mSCNHGryYzhulZzCkJJAwESYhhfkl3hWGG1ZWLaDo/Ohi8LBae0WfEW6VfHs029wxsV3c90+ZUwbGqEzbRMJSBa3OLywJMn5E4rR2g3I+SilizfiJW5Kg4IVMaVPf7ZJDdx+knHd7Q8dvs2wYc+/8847/zQT/mkG+JtrPPv4oydfeelv7x0V3sitB3Y3M1ktFGAI7SVb8r3VSvu1lrSlFS0ZzTaVbn7AcTRlYcnt8+Lc9UmCO68+jaOP2R+rrQPbdtzKZvyicberOT8g95ofgfQjd34gtYDwSilMQ2KWl/LMs29z9uX3cOr2Yc6dWEosrZDCVZurOxVlIUlJUGB7pXI5YdjEmfQLecuDsLjNVic+3cqQ7XZY/ewbHx4aCoW+8O3kVmGAf7Pm9et3On7aXq/GViws+8vhPXSxqUTGcQefG3Cu/MGvWHPhQUAKD+Lli7S01pSEJHd/Gue2jxKcdeIBXPKbowlHI2Q74zie1CN87O8zxAftOqceCgnuUslVgVJAsKSITDrLH+9p4M4H/87pE4s4Z3wJiazKZcuU0gQNgdJgKY3hZ+U2JZUuVEga23HH8MEay7nszTZj70OOWHDrX56eIoTo0K7B/NHY9T+EoQVGN3zqMYc9sHrJwrIHDq5ySk1tJG0X6eTFIldc5smt21mJG4a2Cirk/PKQeFZz5g7FdCsyuPnxWcyZt4gLzpjOvruOJRgOo1NpslkLxwtp+/GgfILBZYkfp/eNbCgYhHAQlcny8pufcOM9z7D6uxVcs3cJh28bIZZW+AV2fnV11nHvmbMbBb6eP/O6OH7atXkdGc3u/YLG2ROKrNtefmn0H6/8/W3BUOiEGTOm/sP1Zf9wBkyfPt14+ulnnDtuuPr6u/9Uf/EFO4aco0cVG+tjDgGP+PlIgOgiio7yILos0BY53UHuy0ppysKCVTHNNe808+5yxaQJQzn2iL2YtP0IencvdzeS8OtabAelHI9wAmFItxDXkGCYYDusWrOR9z9dxNMvzmbeZ9+wS1/JhbtWsk25pC2lMaXAkNqLU7kM9COquTphIVDKDVP4lXP8wIxTWlMaNjn/5Sb7a6eHedNt9xw9Zb9DnvJV97/FgII9Hvruv8vobzqWLwyP7hUR47qbonZEEZ1plavLL4xbCrwOhSQ2kljWLQf0x5XXUO40l1Jj2RD0aLygKcsLje18uFJTVFHBdqOHsN3IQWw7uD+9enSjvCRMKCAxAkG0hmQyTWtbJxua21iyfC2fffUdn3/5LbH2DnbqKzlu+wpGVgawHI3t5SSkR7Quu7IIujBAaUHIkEQNiGcc3OWt5K/HC/x5wMMQkHSk+uUzG8Q2E/dsfuT5N0cJIZrr6ur4oW1wflwF1de74YbfnnXbhu8XRjPacD5alZEnjY6Stvw6H+Gtvc1XMigN4YDg2W+SNHzRSVsGr8Rks1xLbvoL4ceK3Mo5KcFxYMPaNl5aNo8Xnp+HkBAIQzQC0UgAKQ0cR5FKZUmnwcqC9hynUAgiIVjXobjp7RaaE+5zTEle7xcYcQ+s5ZxBibvAO2LAYWMiHDWqDG0XXJgTpbw2tBR0i2h5wc6l9iWz36+56aorb5CGcVJjY+MPLvj+cQa4pRdGJBzOFJV108nWJm7ap4xhVQbtGYULAv0OudLhKCgKSv48P8Z9X9kccsRJDB81GttWuUyVj5S83Qq9Y/lXWymUgpDpwslcfY/W2I6D9oyrUhql3XUCpmm4iy98enoBvIwX5nTv8wNCsAnOF7jFYEJKOlo2cP/Df+bTVa3cckAVWdvJ2bDcd7z3hoCOjGZy/6ixXWVMvfL3p47paGr6U0ll5cLc/nj/EgNACiHs9157Zf5Lf3/m6NqhQb1znzBtKcfF/F6AzW9KQ9gUrOhU3Pdpgt9fewtHHHM8sc5OZM5au0PuYrn9/6Jr8t536AosRv6d2PRYQR6g8IQv2TkyFRJu02yD7vJWaUVRUTGjx43n3FN/wXvLE+wxsIh4xsGTvk2+KdxNodCibo9K5xfPfx+65IJzzhdSntzY2LjFwOcPMsDjmKO17r/HxNG/iXas0L/eq5vRnnLy8XdROAjXSIVMyRdrOqnq1Yddd9+bDevWegimK8Hz3RZseqYLUQqWHQnvmf5scz9u4rV1ucOWTdymPdhi84xye1sr43YYz5gddmTusvfZf5sSOjMOhi6wZwV3iwYEy9ptnv42ZQwocdS3C+cdrhznT0KIhVvyDX6QAY2NjSIQDKkZF559Q9PKb3vfslelExDCyGhvLZX2ML+Hx3N+kACJJhIOuNkow3Dj71ugQn5tV/6YXxWxpTqdLbeucpxnSH7ZkvsIt8P/SjJLa41hmFi2ha2NLhV0+acW3lNjOZruxQbz11tiTadwSq1V5ddefsnJUhoXbKmiYovTYubMmUZDQ4OzZOH8fd5887WjpvZ0nB17hoxY1i9i9RwgT0UIjxF+AVRJxCQR6ySVSiINo0u9Z350nsrwsLV/v/wsyNuHf0Cm3LsuwQevP3mHcFPHavO2padJKbAsi0y8jZpiifJSpbl0aMGrX09UHBRcMKEYGyFTWVKrVnyXMQMBGhoaNrMBW2TAokWLtNZa3nz9NZem1i/h9PEVJLN2wU6GXVGASwb3pKOgKiqx0wkSiYRbZvgjA9ySDhZ0Gdc/5a77bt+PFk35M/UHnt5lemjfKTPIpDPEY52UR0w3l+w/MaeKyTlrUgjiGcWkPiE9vlqLbgNHpO999Om/ZDPpLf6YxGYMmDlzulFfX6+++HjOXnM/nL3rodsEVJ9S00jb+a1duggaec/Wx//FQQMnmyEWi2F4XpjAlZpNpTqnugpIkvvzk+90ZcIPMsSX+i0SddO7bH4nF9Ln7Ru4FRiZdIpMMk5ZJJCrbS18jPANfQHzldLiiJElzsaV31Y8dPvNvxZC6qlTp25G781sQG1tgw6Fw/zlgXsucNrXymlTqpxE1i0t9wmS77r/35c/jwEhA1NpOtrbXBWExt+pRouucydvXMkzqgtRClXM5s0tR/EdpE1vWngjseVTm45JQN7p1UhpkEwmsNNxKiKB3LNcW7W5LwCuDxO3FDv3i8ohC9bz1FOPTlXKMYUQzqbri7twRGstAZXu7Nzhi88+mbpHP6n7lpoy6+SNbBdq+EZYuKFowxtIcdD1Httam90Vjbmhk9sepstz86c9onY97+vuwj+/jH0zNOT3LT+Nct5qfqYVYJcC4m+qIDRgGAaxzg6knaY8bOTiWYZw753rfEHwUSA8SI7cc0DEaWnesN3Hb796DOSW9uZaFwa4Vlpw9eUXHpJoWhk6aGiJk7G16z8J/9Z5Ta09bB0yBHPXZohbCiEkAcOgyISW5hbP+dJdUFNe7XiOT5dpQG4m5JSH3pz3ucEWoKkurBX+566r7PPh0i3MJ7/UpYAFhmHQ2tqKoTXFIQlaE8s6fLQy7S4+9K8XXYcghSCVVUwdWKSDqSYxs6HhEGkYur6+vov8mflna+HlecP7T9np0L6RDMNrymXKym8VXyhl2hu8ozThICxptTEF7NQ7jBBQE4XW1ma3P/7FPjTMHfN77GP9rupGF7zmcJTIx5oK95Vzq+XyDMzdq5CLXcBDfiyFDC18DhqkIWltaSYiIRowMAQs3GizrD3L3oPDJG1NYBOj4BpjyDqKHkXCGFDk8PU3C6c6tt1dCNFl/6GCGTBDAHr+h7NHb1i3avTOfYI6IIV09Jb0JrnQr6M0aRuipuDtFVmCQmMKTWkI2tuac0arEIF0wecFhPFXxhQSxD8OOW2XQyIlJcVUV1dRUV6GYRjudgYFjOxqkH3j6j2vQA67OlM+v/L3aG5uoth064WCBsxZbREwDV/DocBbuen1N0dVgRBC7NYv5LQ3ra3+4I1XpwA0NDTkrsjNgNraRiGE4LXXXztYJ5rlpH4RJ20rQwof45CL3RQH3P0UtPfgiCnYoUeQv3zZweoxNv3LgtQUw4K2FmzLysVohDcgvZkdKPATupzwLbbO6XzlOASCAfr07kU0EsHPmFm2zZq164nHE8hNV4Tk6O9L06ZgYpPrNgEDLc3NdCty8f3amMOn67McvG0ZUVNiFLu7t9gKUpbCIW+chYCsrRnbq0inFm7Qb77xyhhg5l0FDlmOAQ0NDVprLU44cv/RFQGLfmVlWKprCLk4KHG0oLHFYv6GLKs7HaJBQf9Sg0GlkrChebIxxdVTgpRFJPHODhzHzg3TRxb4ryJ/XBTKfaHKZnPo2rtXT6LRCLbt5CTeNAz69O7J0qUrsGx7c3VZSN2CKb2Z16ALX1yxjnW0ETKgPCJ5YH4GR2tKw4KHvkyyPuXmw4dWGuw6IExVRNKWVCiv35aGXqWmqAnZ4vvvF4/1VX0XBhQcLGlqah47pAyKA4aIZZ2c+x00BAubLB6Yn2BJq01FRFAcdGtpGhodEllN0IDXl2c4dZxFdSRAbEM7lpV1Z4BSmyPDAuSQN35dk+k5tgiB4ziUlBQTjUbcRRi+VkHiKIVpGFRUlrN+/UZMw8yrooLndYkd+W9+wON2o6IOsc42ehdBa1Lz2rI0rUnFyS+2YAhBZVgSDQrmrdU89XWCPQZEmDY0iuFFBWylKQ9L0a8E1ra0DQeCQMa3AybAjBkzfCGvamluqppSYyKFFr56DhiwstNmzuoM04dHGFJhUhWRBA13ijUlFcvabd5ekeapxjQXvBHjqOEGZOO0t3dSVVWF5Thsaqi6EIf8PMmjHlFIPbTWhILBTYx4nkEa77zYQhxpS6Kei+tv3tzUpiSVStPR1krvcoO69zqZv97iqBFhDtomwoBSg9KQJBQQOI5mSavNByvTLGrKML5XiJTlWhchENVhWJ5N9QIGAV97D3YZMHLkSAHQuGD+EG1bJVUR6X/Rq4PRVEckp4wpwpTuvmppW5O03OUUFWFB775Bduod5KAhUe6eH+eu+RmU5RCPdVJdU7P5+LdAl82u8bF2QfTVtu0ujOxqdCW2bW8ejvAgsHArs36gJ1toQpBJp5GZGI99rSmN2jx4QBmTeocwpSDjaBwNiYwrHIMqTEbVFBPLuLTJwWygZ2mAzrWdwfVLlkiAGTNmAJ4KWrRokQaY9dzfO+xsQnQrNsltTuuNP+ARHvJ2wQ9y2gra0u5vevUoMwmrLMs2QnHIIR5rd3fD0ppcHc8/HrlL1E2QkxSCRDKFZdkYhnR3Pslld9yXzlh8i4a1wAqRK5/Zosucb4ZhkEjESSXjbOxQRMhgyjBCQsLOqzdfTVtK056GTXfTcZSmNByko705+fKzf2sDd6sf8GFofT0AX8x+OaGyGRfSad/NyjdZ4PSIgj8NlIUNGr5OccgjG0l0G87N1/yaoqIQLc3NmN7iux8i/qYkEDmJ9g5o//luZHLdug0AmKaJlBJDGhimyYamJhcFGcaWH+VN6U3vW9hySSBPBaXTKTLpFDMuPp5hO0/mlBc6uPPTOCURI+f5+7SReAVh2nNTfXOjBQEpCEhhGMFwsPB5XWJBWW06CuHN+i0hFJ8oebiotFtgNbMxxXWzO6m/6AROO+EAMAT33P8Yqc62Hw0rb+pw5Y8Xqos8FJZS0hmLsXSZRUVFGcFgEMe26eiMEYvFc+nLrg5Yl85v8nDd5bMfwXYNtiTZ0UbWtjhwz5345a+OZNq+kzjtotuJp9u5bLdyEhmnIE+Qr1ny0S54+W2lydooK5PuUqYiAUbOnCkAzrjw4t7RklJiWUv7N8mZQ7GJpApX94YDgm+abW58r4NLzzuK006bRiaWpKUphQhE6ezsIBwpcrunFMpx0ErliYzYjPi6kICbhh5zkplm7dr1rFixmtVr1rnEz2+duDnRhWBz/S985wTIrzNwS14U4WiURDJJcThIS9wiu7GVffadwAPXn8mTi9K8tTxJSUjiqK691zl25J25eMamtKzM3Ge//QPuMHSeAb4NGD9u/Lq0Tcf6mHK7q3PkyMc7crrTPR40JHd93M7wsdtwzimHkdzQRLAozDtzPuOzr9bz2dwP+fqrz5GGQVl5BRVV1USiRR4TdAEBtuQYdf2U31rS3U3XMAw32S5lfoH3libbpsZ8C89QShEKhSivqKKisppwJMqalSuY+/47NC5P8vSLbxIsihBf18re+0/ml0ftye0fdBDPai8wV0ggv74oL7xrOjK6orpG9x87sbjwwR4Ez201ENh53NAF28vvh16zR7VqSylpSP+eBZKqXdUTMgWrY5pjG5q45cbzOXCviaQ6vI0yhOTpVz7gkSdmsXTlBnr26E63Xv3pPXAYu++7P6PH7UgqGd+EyLqLIyT83m/S/LSlzp3+YRVX8KUt3suNXDpEi0pYtfx73n39Fb5d8AXN61eyfMVKSotCTJ+2B6cfewDFkTC2ZREMB1i+cgN7HHsZ100Osd+QKO62/J7WEF4JgPbzI0Jd8GqLXFM66tM3P/xiohdzy/sBXmBIAk6f3n2/Wtz43baxrNKm4YcNcs51jlBau2t+P1oZp6i6kt12HIGT8gw4ILTDsUfuyRH7T6ZxyUq++WYpC75ezLxPXmHWk3/huNPP4rjTLyCdShbYiLz+9p2zgnhznpA5BokC2v44ovkhZ0tph0i0hNmvvcSNl19IdVWE7ccMYde9RzNi+DRGDRtIVU0FTiKJ47joy8pYDBrYm7GjhjBnxdccNLQo1yfQubwHuHVOsazWyzscJkydkCIH6FxvOGeEp0+fLoQQzk0zLn7n4S8+nP7lhiw79Q7np1jBI3J0EpKvN6QYPHgoJRXlZDpjBXEYQao9DijGDRvAuNHbcIzeC2SAF2fN5sLL72KHXfZk+OixpBKJLlsLFASOCj7kCVkgBqB9afsB9fNjzUu6xzvbueP6Kzjh2L254JzjCUnHfaajsFJpkq0dmAEzJyhKAQGTscMH8cmsRjKO6CpEHlp00IQNg8aNKd0hogwcOOAlIYSeMmWKMdvdjzofDZ05c6YC+G3d9S+GSru1vLQ4IQOm1HlxFHnVr13LbitBc0LTr0clyALQ6vUlUlxEpKYaImFQfsmawV5TdsAMGTRvXI9REDJgk+9viWBdLxM59fgvE98bimGatLe2kEjE2HfPiYSqS91KYq0haBKoriRaUe4ROK/TQTOwTw2dGcg4+YLewuu0FgRNgze+i8vq3oP1mb/53bsAZ511Vm4guRkghNDTwTADwTVnH3/EE2/Najj7i/UZe2R10ExYCunzwp9enkrNOhAMhbr89qBAYKO59pZHwVb069uDqooihDRZunItL/z9Xfr37cv4XaaSTMQLsmZbal2lvwv1NjmdO/5PMkMIQTadps+AwUzedQonn3Ed06btyZjhAzGkoKUtzrqmVtasb+H3Zx1Fr+oybMvKfT8YCmEpV88bwuVbIWQOStgYt50P1jnG0J36PBcuLfsEkIXFul1GPrOuTju2xa1/eeK+XoNGpq+f3SocKXRh6s+f6W79pKIkBC3tcfdEgW9gGpLag3bDNAUvvzmXux98mlvufIS3Zn9Kt27dWLO2iXlzZhMOR1AF5Sn/dNsC4swhBApff7hprQhFIqxY+h0LF35N/4F9+HLhEu6673FuvfcJGl6azbr1TRxxwC50qyx1Q+sib2ibWzuImm6gMrfLi9cH29GUhCWPfdGGXdyTX595zr2ZdIqZ06d36XUXR0zU16uZM2caQsiFf737TzNuv+na62+e02pdPqUq0JZwAN2lOAkN/StM5q9di0qmcgVYQrgb8I0Y3IcRF58EjiCTTGBbNqFIFLOqjAvPu5bHH7yL3fbaD1ebi39HixQQM4+M8BPm/8Awa6WJRKI8+fADVJYKXph5E2RtkvFOhFZEioogICBjkU1lc+pFACj4btlauhVB2IBOKz9BbQfKQpIvNljOzG+yxuG/OHjuxD32f7uurk7W1td3KVXfbO5Pnz5dTZ9+pPHLX5/3pyOOOu6lF78ncPvH7VZFket6OwWK3nI0Ow8oYfHiFSxZvg4jFPKk2dsLOhL26vkzhCIhispLMcMmWA52NusmdbRCK+U5aa6j5i/I9o/71yjlLdRWzmZ/2ltHlv9z3OJd/35O/jpdcI3tOBSFgwSFTTaVAsMmWhwhUlzk/va5rSEcRhreKkvc2Z3qTPDpl1+zU98gAjc9Cm7gMhoQtGdQl77WbAzfYZfsdbfd9yshhD1jC0KwWVmKt/uVFkJYWuuTAoZ87cH779t+Y6zZvnhKtVEilOjMKjSQtjXb9QxT7LTx1Kz3ueLiX+LEE8iAiULw4COzKAoKBg/sgxkIkkwmWbx0Fe/NWUDj18upv/OvlJRWIISRQ09bruvRm2iUzXMHhVvk579XcMBzGgrvrpQiGAxy3Gnnc/FpH3PEcb9nrz3GM3roACoqylDKYf3GNpat2sD0A3elpryIdDpLtKqcl/4+m7a1G5m6cxUpy9uQRGkqI5LVMdS5L61HVw10zj3v4pOEEItmzpxpiC0s1PjB+VmwOKP0T1f9/u4nH/vbceHYGs6bXGbv2j9qBKQWiazClO4vYdz8qcXLf61j1KjBJNpiBMMBXn5rHs/M+pCN69eyoS1FyNAEA0HWrWuh34D+9Bm4LXY2idYFtT0FoYFcyB7yv3ZU0O18lMJHHVuqpC4c6qYoymOcDJLubGbRggWU11QRMRTJrEM4GKBbt2r2mrojx0/bE0MpIpEgbfEMux11GXtWtXPFbpXEsw7FQYkWkg9Wpuzr3203w32Gc9JJpx164jnnv/hji7h/VO361byRaDFPP3zvqQ/95S83Lfjso9IxZSmOGF1kj+sZFaUBQ5YGNee90ioWWZU8fOdFDBk6CNXejoyEwDDpbGklkchgBoPUDOnH2b+u59MF65i0xz5kM2l81OCTpBD++3sC5eIrHgQrjNa6wu0ap1wNEPnIpl8RIaXs8hsE4P9WQZjvFn6OldzI68/fQaItQUdHByHpUFVTA8EAKp5AlpbS1hrj9PNvoGnJNzwyrbuujEhaU45e3JJWj87vMOZsDItJu0zZ+NvLZpy53YSdn6mr282sr//hxdv/0O4V7AmhtNbb3HF9/ZlvvfnWaUuXfB0NpZsZUwPbdQ9QHjW497M0SVmkzz3jSH3AnhPpVlMtkNpd32WGIJPl1bfmcskVt+iBo3dm8j4Hk0rEkNIo8DVcsc/X++T3ihYIl4DaX5Dn0HWHLVWgggqOa7deyVVBvqPkXqocm2AoQuOXn/PhrAZ95SWncNRhewozbAqMANgWOBCPxfW7Hy/gznufEqtXrOX83YpE0FF8uSHNgo2aNVYxfQYM0/sdsN9fzrvs6muFEMv+me0L/mngkbuZkGjlDHz2sYePeOWVV3dZv3bFhPVrV5Zb6UQ0LG0cBY6jiUSDbDuoJ5XVVZRGwzS1dbJk6Wo2buykqqYb4aAkmcrk6ny6Sm3et9L+MV2AlQr8ri6RU0/YCxMim0S0c/fOEUC4iwSFNIgETdZtbCYUEAzfti+9etSQsRQd7W00Ll5JW3uSoCEIBg2UgoQK2j379ncqSis+2mnipFfOv/KqN8xAYL5j28ycPt2o/Sf2jviXkJ+nkgTeziCRaJRkItFj9eLF/V965e+lCxZ8YfTr2Su6zegxPT9+751J33/79fi1q9dEsJNGaVVPho4eF5u004T7t9tp17ZsOmVoLbNKKSGl1u6GIz/eCmu7/X2DXTl38L+fP1b4HZ8OxhbLwZVQQjkORcXFZWtWrur58ovP7/3Vx++FEp1tlbFkNt2jR/fUhMlTY8NGjXs4mejoaGtrC1vp1No9dt/bmbzfgeuA74QQWf8hdXV1+p/9bfr/D1XhmegofYvkAAAAAElFTkSuQmCC";
var BRAND_ICON_SCRIPT = `<script>var l=document.createElement("link");l.id="${BRAND_ICON_ID}";l.rel="icon";l.type="image/png";l.href="${BRAND_MASCOT_96_DATA_URI}";document.head.appendChild(l);</script>`;
function rowFromAnalysis(a, now) {
  const { badge, ageMs } = badgeFor(a.session.endedAt ?? now, now);
  const last = a.tools.calls[a.tools.calls.length - 1];
  return {
    id: a.session.id,
    projectSlug: a.session.projectSlug ?? "",
    cwd: a.session.cwd,
    title: a.session.title,
    path: a.session.path,
    source: a.session.source,
    sizeBytes: a.parse.bytes,
    mtimeMs: a.session.endedAt ?? now,
    badge,
    ageMs,
    possiblyLive: a.session.live,
    startedAt: a.session.startedAt,
    turns: a.summary.turns,
    toolCalls: a.summary.toolCalls,
    toolErrors: a.summary.toolErrors,
    tokens: a.summary.totalTokens,
    contextFinal: a.context.final,
    contextWindow: a.context.contextWindow,
    cacheHitRatio: a.summary.cacheHitRatio,
    compactions: a.summary.compactions,
    agentsTotal: a.agents.totals.count,
    agentsRunning: 0,
    lastEvent: last ? { ts: last.startTs, name: last.name, category: last.category, summary: last.summary } : void 0
  };
}
function renderReport(analysis, options = {}) {
  let data = analysis;
  let redaction;
  if (options.redact !== false) {
    const r = redactAnalysis(analysis, options.redact || {});
    data = r.analysis;
    redaction = r.report;
  }
  const now = data.generator.generatedAt;
  const stripText = options.redact !== false && options.redact?.stripText === true;
  const appData = {
    v: APP_DATA_VERSION,
    mode: "file",
    version: BUILD_VERSION,
    generatedAt: now,
    ...options.illustrative ? { illustrative: true } : {},
    capabilities: { live: false, aggregates: false, kickoffRun: false, exportHtml: true, includeText: !stripText, ...options.watch ? { watch: true } : {} },
    selectedId: data.session.id,
    session: data,
    sessions: [rowFromAnalysis(data, now)],
    aggregates: {},
    suggestions: [],
    redaction: redaction ? { applied: redaction.applied, strippedText: redaction.strippedText, strippedPaths: redaction.strippedPaths } : void 0
  };
  const title = escapeHtml(options.title ?? `orangu \xB7 ${data.session.title || data.session.id.slice(0, 8)}`);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta http-equiv="Content-Security-Policy" content="${CSP}"/>
<meta name="generator" content="orangu ${escapeHtml(BUILD_VERSION)}"/>
<meta name="robots" content="noindex"/>
<title>${title}</title>
${BRAND_ICON_SCRIPT}
<style>${CLIENT_CSS}</style>
</head>
<body data-density="comfortable">
<div id="app" class="app"></div>
<script type="application/json" id="orangu-data">${safeJson(appData)}</script>
<script>window.__ORANGU__=JSON.parse(document.getElementById('orangu-data').textContent);</script>
<script>${CLIENT_JS}</script>
</body>
</html>`;
  return { html, redaction };
}
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
var CLIENT_JS_SERVE2 = CLIENT_JS_SERVE ?? "";
var CSP_SERVE = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'";
function renderShell(o) {
  const boot = { maxLive: o.maxLive, capabilities: o.capabilities, version: o.version, feedback: o.feedback };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="referrer" content="no-referrer"/>
<meta http-equiv="Content-Security-Policy" content="${CSP_SERVE}"/>
<meta name="generator" content="orangu ${escapeHtml(o.version)}"/>
<meta name="robots" content="noindex"/>
<title>orangu \xB7 live</title>
${BRAND_ICON_SCRIPT}
<style>${CLIENT_CSS}</style>
</head>
<body>
<div id="app" class="app"></div>
<script>window.__ORANGU_SERVE__=${safeJson(boot)};</script>
<script>${CLIENT_JS_SERVE2}</script>
</body>
</html>`;
}

// src/cache/index.ts
import { createHash as createHash2, randomBytes } from "node:crypto";
import { constants as constants6 } from "node:fs";
import { lstat as lstat4, mkdir, open as open6, realpath as realpath4, rename, stat as stat2, unlink } from "node:fs/promises";
import { join as join5, resolve as resolve4 } from "node:path";

// src/model/analysis.ts
var ANALYSIS_SCHEMA_VERSION = "2";

// src/adapters/claude-code/parse.ts
import { basename as basename4, dirname as dirname3 } from "node:path";

// src/adapters/claude-code/tools.ts
function categorizeTool(name) {
  const n2 = name;
  if (n2 === "Read" || n2 === "NotebookRead") return "read";
  if (n2 === "Grep" || n2 === "Glob" || n2 === "LS" || n2 === "ToolSearch") return "search";
  if (n2 === "Edit" || n2 === "MultiEdit" || n2 === "NotebookEdit") return "edit";
  if (n2 === "Write") return "write";
  if (n2 === "Bash" || n2 === "BashOutput" || n2 === "KillShell" || n2 === "KillBash" || n2 === "Monitor") return "exec";
  if (n2 === "Agent" || n2 === "Task" || n2 === "SendMessage" || n2 === "ListAgents" || n2 === "TaskOutput" || n2 === "TaskStop" || n2 === "Workflow") return "agent";
  if (n2 === "Skill") return "skill";
  if (n2 === "WebFetch" || n2 === "WebSearch") return "web";
  if (n2 === "EnterPlanMode" || n2 === "ExitPlanMode" || n2 === "EnterWorktree" || n2 === "ExitWorktree") return "plan";
  if (n2 === "AskUserQuestion") return "ask";
  if (n2 === "TaskCreate" || n2 === "TaskUpdate" || n2 === "TaskList" || n2 === "TaskGet" || n2 === "TodoWrite" || n2 === "TodoRead") return "task";
  if (n2.startsWith("mcp__")) return "mcp";
  return "other";
}
function short(s, max = 80) {
  if (typeof s !== "string") return "";
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1) + "\u2026" : one;
}
function baseName(p) {
  if (typeof p !== "string") return "";
  const parts = p.split(/[\\/]/);
  const last = parts[parts.length - 1] ?? p;
  const prev = parts.length > 1 ? parts[parts.length - 2] : "";
  return prev ? `${prev}/${last}` : last;
}
function summarizeToolInput(name, input) {
  const i = input && typeof input === "object" ? input : {};
  switch (name) {
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
    case "NotebookRead":
      return `${name} ${baseName(i["file_path"] ?? i["notebook_path"] ?? i["path"])}`.trim();
    case "Bash":
      return `Bash ${short(i["description"] ?? i["command"], 90)}`;
    case "Grep":
      return `Grep ${short(i["pattern"], 50)}${i["path"] ? " in " + baseName(i["path"]) : ""}`;
    case "Glob":
      return `Glob ${short(i["pattern"], 60)}`;
    case "Agent":
    case "Task":
      return `${name} ${short(i["description"] ?? i["name"] ?? i["prompt"], 70)}${i["subagent_type"] ? ` (${String(i["subagent_type"])})` : ""}`;
    case "Skill":
      return `Skill ${short(i["skill"] ?? i["name"], 60)}${i["args"] ? " " + short(i["args"], 30) : ""}`;
    case "WebFetch":
      return `WebFetch ${short(i["url"], 80)}`;
    case "WebSearch":
      return `WebSearch ${short(i["query"], 80)}`;
    case "SendMessage":
      return `SendMessage \u2192 ${short(i["to"] ?? i["recipient"], 30)}`;
    case "ToolSearch":
      return `ToolSearch ${short(i["query"], 60)}`;
    case "AskUserQuestion":
      return "AskUserQuestion";
    case "Workflow":
      return `Workflow ${short(i["name"] ?? i["scriptPath"] ?? "inline script", 60)}`;
    default: {
      const firstStr = Object.values(i).find((v) => typeof v === "string");
      return `${name}${firstStr ? " " + short(firstStr, 60) : ""}`;
    }
  }
}
function skillNameFromInput(input) {
  if (!input || typeof input !== "object") return void 0;
  const i = input;
  const s = i["skill"] ?? i["name"];
  return typeof s === "string" ? s : void 0;
}

// src/adapters/claude-code/parse.ts
var str = (v) => typeof v === "string" ? v : void 0;
var num = (v) => typeof v === "number" && Number.isFinite(v) ? v : void 0;
var bool = (v) => v === true;
var obj = (v) => v && typeof v === "object" && !Array.isArray(v) ? v : void 0;
var arr = (v) => Array.isArray(v) ? v : void 0;
var ts = (v) => {
  if (typeof v === "number") return v > 1e12 ? v : v * 1e3;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : void 0;
  }
  return void 0;
};
var bytesOf = (v) => {
  try {
    return typeof v === "string" ? Buffer.byteLength(v) : Buffer.byteLength(JSON.stringify(v) ?? "");
  } catch {
    return 0;
  }
};
var preview = (s, max = 160) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1) + "\u2026" : one;
};
function parseUsage(u) {
  const o = obj(u);
  if (!o) return void 0;
  const cc = obj(o["cache_creation"]);
  const st = obj(o["server_tool_use"]);
  const cacheWrite = num(o["cache_creation_input_tokens"]) ?? 0;
  let w5 = num(cc?.["ephemeral_5m_input_tokens"]);
  let w1 = num(cc?.["ephemeral_1h_input_tokens"]);
  if (cacheWrite > 0 && (w5 ?? 0) + (w1 ?? 0) === 0) {
    w5 = 0;
    w1 = cacheWrite;
  }
  return {
    input: num(o["input_tokens"]) ?? 0,
    output: num(o["output_tokens"]) ?? 0,
    cacheRead: num(o["cache_read_input_tokens"]) ?? 0,
    cacheWrite,
    cacheWrite5m: w5 ?? (w1 === void 0 ? cacheWrite : 0),
    cacheWrite1h: w1 ?? 0,
    webSearchRequests: num(st?.["web_search_requests"]) ?? 0,
    webFetchRequests: num(st?.["web_fetch_requests"]) ?? 0,
    serviceTier: str(o["service_tier"]),
    speed: str(o["speed"]),
    inferenceGeo: str(o["inference_geo"])
  };
}
function textOfContent2(content) {
  if (typeof content === "string") return content;
  const a = arr(content);
  if (!a) return "";
  const parts = [];
  for (const b of a) {
    const o = obj(b);
    if (!o) continue;
    if (o["type"] === "text" && typeof o["text"] === "string") parts.push(o["text"]);
  }
  return parts.join("\n");
}
function addCount(counts, key, amount = 1) {
  counts.set(key, (counts.get(key) ?? 0) + amount);
}
function countRecord(counts) {
  return Object.fromEntries(counts);
}
function parseBlocks(content, keepText, unknownBlockTypes) {
  if (typeof content === "string") return [{ kind: "text", text: keepText ? content : "" }];
  const a = arr(content);
  if (!a) return [];
  const out3 = [];
  for (const raw of a) {
    const b = obj(raw);
    if (!b) continue;
    const t = str(b["type"]) ?? "other";
    switch (t) {
      case "text":
        out3.push({ kind: "text", text: keepText ? str(b["text"]) ?? "" : "" });
        break;
      case "thinking": {
        const th = str(b["thinking"]) ?? "";
        out3.push({ kind: "thinking", chars: th.length, text: keepText ? th : void 0 });
        break;
      }
      case "redacted_thinking":
        out3.push({ kind: "redacted_thinking", rawType: t, bytes: bytesOf(b["data"]) });
        break;
      case "tool_use":
        out3.push({ kind: "tool_use", toolUseId: str(b["id"]) ?? "", name: str(b["name"]) ?? "unknown", input: b["input"] });
        break;
      case "tool_result": {
        const c = b["content"];
        out3.push({
          kind: "tool_result",
          toolUseId: str(b["tool_use_id"]) ?? "",
          text: textOfContent2(c),
          isError: bool(b["is_error"]),
          bytes: bytesOf(c)
        });
        break;
      }
      case "image":
      case "document":
        out3.push({ kind: t, rawType: t, bytes: bytesOf(b["source"]) });
        break;
      case "fallback": {
        const from = obj(b["from"]);
        const to = obj(b["to"]);
        out3.push({ kind: "other", rawType: "fallback", bytes: 0, note: `model fallback ${str(from?.["model"]) ?? "?"} \u2192 ${str(to?.["model"]) ?? "?"}` });
        break;
      }
      default:
        addCount(unknownBlockTypes, t);
        out3.push({ kind: "other", rawType: t, bytes: bytesOf(b) });
    }
  }
  return out3;
}
var COMMAND_RE = /<command-name>\s*([^<\s]+)\s*<\/command-name>/;
var COMMAND_ARGS_RE2 = /<command-args>\s*([^<]*?)\s*<\/command-args>/;
function commandEnvelopeTitle(envelope, commandName) {
  const name = commandName || COMMAND_RE.exec(envelope)?.[1] || envelope;
  const args = COMMAND_ARGS_RE2.exec(envelope)?.[1];
  return args ? `${name} ${args}` : name;
}
var INTERRUPT_RE = /\[Request interrupted by user/i;
var NOTIFICATION_ENQUEUE_RE = /^\s*<(?:task|system)-notification>/;
var LEADING_REMINDERS_RE = /^(?:\s*<system-reminder>[\s\S]*?<\/system-reminder>\s*)+/;
function classifyPrompt(r, text2, isMeta) {
  const origin = obj(r["origin"]);
  const originKind = str(origin?.["kind"]);
  const promptSource = str(r["promptSource"]);
  if (INTERRUPT_RE.test(text2.slice(0, 200))) return "interrupt";
  if (r["isVisibleInTranscriptOnly"] === true) return "meta";
  if (originKind === "human" || promptSource === "typed") return COMMAND_RE.test(text2) ? "command" : "human";
  if (originKind === "task-notification") return "notification";
  if (originKind === "peer" || originKind === "teammate" || originKind === "cross-session") return "peer";
  const t = text2.replace(LEADING_REMINDERS_RE, "").trimStart();
  if (t.startsWith("<command-name>") || t.startsWith("<command-message>")) return "command";
  if (t.startsWith("<local-command-stdout>") || t.startsWith("<local-command-caveat>") || t.startsWith("<local-command-stderr>")) return "local_output";
  if (t.startsWith("<task-notification>")) return "notification";
  if (t.startsWith("<teammate-message") || t.startsWith("<cross-session-message") || t.startsWith("Another Claude session sent a message")) return "peer";
  if (isMeta && promptSource === "system") return "scheduled";
  if (isMeta) return "meta";
  const META_TAGS = ["<user-prompt-submit-hook>", "<system-reminder>", "<budget:", "<total_tokens>", "<user-memory-input>", "<important_context>", "<function_results>", "<returned-by-"];
  if (META_TAGS.some((tag) => t.startsWith(tag))) return "meta";
  return "human";
}
async function discoverSubagentFiles(mainPath) {
  return evidenceManifestSidecarFiles(await prevalidateEvidenceSession(mainPath, { maxBytes: MAX_LOCAL_SESSION_BYTES }));
}
var TRANSIENT_INPUT_CHANGE_RE = /^session (?:input|sidecar (?:directory|tree)) changed (?:before it was read|while it was being read)\b/;
function isTransientInputChange(error) {
  return error instanceof Error && TRANSIENT_INPUT_CHANGE_RE.test(error.message);
}
var STABLE_READ_ATTEMPTS = 3;
var STABLE_READ_BACKOFF_MS = [20, 80];
var STILL_WRITING_HINT = "the session is still being written; re-run, or use `orangu watch` to follow it live";
async function withStableSessionRead(path, options, read) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await read(await prevalidateEvidenceSession(path, options));
    } catch (error) {
      if (!isTransientInputChange(error)) throw error;
      if (attempt >= STABLE_READ_ATTEMPTS) throw new Error(`${error.message}; ${STILL_WRITING_HINT}`);
      const pause = STABLE_READ_BACKOFF_MS[Math.min(attempt, STABLE_READ_BACKOFF_MS.length) - 1];
      await new Promise((resolve11) => setTimeout(resolve11, pause));
    }
  }
}
function readStableEvidenceSession(path, options, maxBytes) {
  return withStableSessionRead(path, options, (manifest) => readEvidenceSessionManifest(manifest, maxBytes));
}
var readStableSession = readStableEvidenceSession;
async function parseClaudeCodeSession(input) {
  const t0 = Date.now();
  const keepText = input.keepText ?? true;
  const files2 = [];
  let effectiveInput = input;
  if (input.path && input.records === void 0) {
    const loaded = await readStableSession(input.path, { includeSidecars: !input.noSidecar, maxBytes: MAX_LOCAL_SESSION_BYTES });
    effectiveInput = { ...loaded.parseInput, keepText: input.keepText, noSidecar: true };
  } else if (input.path && input.records && input.subagents === void 0 && !input.noSidecar) {
    const loaded = await readStableSession(input.path, { maxBytes: MAX_LOCAL_SESSION_BYTES });
    effectiveInput = { ...input, subagents: loaded.parseInput.subagents };
  }
  const mainPath = effectiveInput.path ?? "(memory)";
  if (effectiveInput.records) {
    files2.push({
      index: 0,
      path: mainPath,
      records: effectiveInput.records,
      lineNumbers: effectiveInput.lineNumbers,
      totalLines: effectiveInput.totalLines ?? effectiveInput.records.length,
      badLines: effectiveInput.badLines ?? 0,
      bytes: effectiveInput.bytes ?? 0,
      trailingPartial: effectiveInput.trailingPartial ?? false
    });
  } else {
    throw new Error("parseClaudeCodeSession: need path or records");
  }
  if (effectiveInput.subagents) {
    for (const s of effectiveInput.subagents) {
      files2.push({
        index: files2.length,
        path: s.path,
        records: s.records,
        lineNumbers: s.lineNumbers,
        agentIdHint: s.agentIdHint ?? basename4(s.path, ".jsonl").replace(/^agent-/, ""),
        meta: s.meta,
        totalLines: s.totalLines ?? s.records.length,
        badLines: s.badLines ?? 0,
        bytes: s.bytes ?? 0,
        trailingPartial: s.trailingPartial ?? false
      });
    }
  }
  return buildSession(files2, mainPath, keepText, t0);
}
function buildSession(files2, mainPath, keepText, t0) {
  const recordCounts = /* @__PURE__ */ new Map();
  const unknownRecordTypes = /* @__PURE__ */ new Map();
  const unknownBlockTypes = /* @__PURE__ */ new Map();
  const warnings = /* @__PURE__ */ new Map();
  const warn = (code, message, line) => {
    const w = warnings.get(code);
    if (w) w.count++;
    else warnings.set(code, { code, message, count: 1, sampleLine: line });
  };
  const KNOWN_TYPES = /* @__PURE__ */ new Set([
    "user",
    "assistant",
    "system",
    "attachment",
    "summary",
    "last-prompt",
    "mode",
    "permission-mode",
    "custom-title",
    "agent-name",
    "queue-operation",
    "file-history-snapshot",
    "file-history-delta",
    "pr-link",
    "progress",
    "ai-title",
    "frame-link",
    "relocated",
    "worktree-state",
    "started",
    "result"
  ]);
  const messages = [];
  const toolCalls = [];
  const toolByUseId = /* @__PURE__ */ new Map();
  const agents = /* @__PURE__ */ new Map();
  const skills = [];
  const hooks = [];
  const compactions = [];
  const usageEvents = [];
  const events = [];
  const turns = [];
  const meta = {
    sessionId: "",
    source: "claude-code",
    path: mainPath,
    subagentPaths: files2.slice(1).map((f) => f.path),
    gitBranches: [],
    clientVersions: [],
    entrypoints: [],
    permissionModes: [],
    models: [],
    effortLevels: [],
    possiblyLive: false,
    truncatedReads: 0
  };
  const attachmentTypes = /* @__PURE__ */ new Map();
  const attachmentBytes = /* @__PURE__ */ new Map();
  const systemSubtypes = /* @__PURE__ */ new Map();
  const queueOperations = /* @__PURE__ */ new Map();
  let enqueueHuman = 0;
  let enqueueNotification = 0;
  const deferredToolNames = /* @__PURE__ */ new Set();
  const cacheMissByProviderMsg = /* @__PURE__ */ new Map();
  const thinkingByProviderMsg = /* @__PURE__ */ new Map();
  const prByNumber = /* @__PURE__ */ new Map();
  const setAdd = (list, v) => {
    if (v && !list.includes(v)) list.push(v);
  };
  const lastRecordForProviderMsg = /* @__PURE__ */ new Map();
  let currentTurn;
  let mainTurnIndex = -1;
  const agentTurnIndex = /* @__PURE__ */ new Map();
  let firstTs;
  let lastTs;
  let firstPromptPreview;
  let lastNonPromptTs;
  let pendingAskCount = 0;
  const seenSessionIds = /* @__PURE__ */ new Set();
  const seenUuids = /* @__PURE__ */ new Set();
  const pendingTeammateLinks = [];
  let pendingBoundary;
  const hiddenIterations = [];
  for (const f of files2) {
    const isSub = f.index > 0;
    let subAgentId = f.agentIdHint;
    if (isSub && f.meta) {
      const id = subAgentId ?? `agent-${f.index}`;
      const run = ensureAgent(agents, id);
      run.agentType = str(f.meta["agentType"]) ?? run.agentType;
      run.description = str(f.meta["description"]) ?? run.description;
      run.name = str(f.meta["name"]) ?? run.name;
      run.model = str(f.meta["model"]) ?? run.model;
      run.spawnDepth = num(f.meta["spawnDepth"]) ?? run.spawnDepth;
      run.taskKind = str(f.meta["taskKind"]) ?? run.taskKind;
      run.teamName = str(f.meta["teamName"]) ?? run.teamName;
      run.transcriptPath = f.path;
    }
    for (let ri = 0; ri < f.records.length; ri++) {
      const r = f.records[ri];
      const line = f.lineNumbers?.[ri] ?? ri + 1;
      const type = str(r["type"]) ?? "unknown";
      addCount(recordCounts, type);
      if (!KNOWN_TYPES.has(type)) addCount(unknownRecordTypes, type);
      const sid = str(r["sessionId"]);
      if (sid) seenSessionIds.add(sid);
      if (!meta.sessionId && sid && !isSub) meta.sessionId = sid;
      setAdd(meta.gitBranches, str(r["gitBranch"]));
      setAdd(meta.clientVersions, str(r["version"]));
      setAdd(meta.entrypoints, str(r["entrypoint"]));
      if (!meta.cwd) meta.cwd = str(r["cwd"]);
      const t = ts(r["timestamp"]);
      if (t !== void 0) {
        if (firstTs === void 0 || t < firstTs) firstTs = t;
        if (lastTs === void 0 || t > lastTs) lastTs = t;
      }
      if (type === "custom-title") {
        meta.customTitle = str(r["customTitle"]) ?? meta.customTitle;
        continue;
      }
      if (type === "agent-name") {
        meta.agentName = str(r["agentName"]) ?? meta.agentName;
        continue;
      }
      if (type === "ai-title") {
        meta.aiTitle = str(r["aiTitle"]) ?? meta.aiTitle;
        continue;
      }
      if (type === "relocated") {
        meta.relocatedCwd = str(r["relocatedCwd"]) ?? meta.relocatedCwd;
        continue;
      }
      if (type === "worktree-state") {
        meta.worktree = true;
        continue;
      }
      if (type === "frame-link") {
        events.push({ kind: "other", ts: t, turnIndex: mainTurnIndex, label: "frame link", detail: str(r["path"]) });
        continue;
      }
      if (type === "permission-mode") {
        setAdd(meta.permissionModes, str(r["permissionMode"]));
        continue;
      }
      if (type === "pr-link") {
        const key = String(r["prNumber"] ?? r["prUrl"] ?? "?");
        if (!prByNumber.has(key)) {
          const ev = { kind: "pr_link", ts: t, turnIndex: mainTurnIndex, label: `PR #${key}`, detail: str(r["prUrl"]) };
          prByNumber.set(key, ev);
          events.push(ev);
        }
        continue;
      }
      if (type === "summary") {
        continue;
      }
      if (type === "attachment") {
        const a = obj(r["attachment"]);
        const at = str(a?.["type"]) ?? "unknown";
        addCount(attachmentTypes, at);
        addCount(attachmentBytes, at, bytesOf(a));
        if (at.startsWith("hook")) {
          const he = str(a?.["hookEvent"]);
          if (he && he !== "Stop") {
            hooks.push({ hookEvent: he, hookName: str(a?.["hookName"]), ok: at !== "hook_error" && at !== "hook_failure", ts: t, turnIndex: mainTurnIndex });
          }
        } else if (at === "skill_listing" && !isSub) {
          const names = (arr(a?.["names"]) ?? []).filter((x) => typeof x === "string");
          const count = num(a?.["skillCount"]) ?? names.length;
          if (!meta.skillsAvailable || bool(a?.["isInitial"])) meta.skillsAvailable = { count, names };
        } else if (at === "read_truncation_notice") {
          meta.truncatedReads++;
        } else if (at === "deferred_tools_delta") {
          for (const key of ["addedNames", "readdedNames"]) for (const n2 of arr(a?.[key]) ?? []) if (typeof n2 === "string") deferredToolNames.add(n2);
        } else if (at === "queued_command") {
          events.push({ kind: "other", ts: t, turnIndex: mainTurnIndex, label: "queued command", detail: str(a?.["commandMode"]) });
        } else if (at === "ultra_effort_enter" || at === "ultra_effort_exit" || at === "plan_mode_exit") {
          events.push({ kind: at === "plan_mode_exit" ? "plan_mode" : "other", ts: t, turnIndex: mainTurnIndex, label: at });
        }
        continue;
      }
      if (type === "queue-operation") {
        const op = str(r["operation"]) ?? "unknown";
        addCount(queueOperations, op);
        if (op === "enqueue") {
          const content2 = str(r["content"]) ?? "";
          const isNotification = NOTIFICATION_ENQUEUE_RE.test(content2);
          if (isNotification) enqueueNotification++;
          else enqueueHuman++;
          events.push({ kind: "other", ts: t, turnIndex: mainTurnIndex, label: isNotification ? "queued notification" : "queued message", detail: preview(content2, 100) });
        }
        continue;
      }
      if (type !== "user" && type !== "assistant" && type !== "system") continue;
      const recUuid = str(r["uuid"]);
      if (recUuid) {
        if (seenUuids.has(recUuid)) {
          warn("duplicate_uuid", "record uuid written more than once (superseded rewrite); first occurrence kept", line);
          continue;
        }
        seenUuids.add(recUuid);
      }
      const isSidechain = bool(r["isSidechain"]) || isSub;
      const agentId = str(r["agentId"]) ?? (isSub ? subAgentId : void 0);
      if (isSub && !subAgentId && agentId) subAgentId = agentId;
      const message = obj(r["message"]);
      const role = type === "system" ? "system" : str(message?.["role"]) ?? type;
      const content = message?.["content"];
      const blocks = type === "system" ? [] : parseBlocks(content, keepText, unknownBlockTypes);
      const hasToolResult = blocks.some((b) => b.kind === "tool_result");
      const isMeta = bool(r["isMeta"]);
      const isCompactSummary = bool(r["isCompactSummary"]);
      const text2 = type === "system" ? str(r["content"]) ?? "" : textOfContent2(content);
      const cmd = COMMAND_RE.exec(text2)?.[1];
      const interrupted = INTERRUPT_RE.test(text2);
      const isPromptLike = type === "user" && !hasToolResult && !isCompactSummary && !!message;
      const promptKind = isPromptLike ? classifyPrompt(r, text2, isMeta) : void 0;
      const startsTurn = !!promptKind && TURN_STARTING_KINDS.has(promptKind);
      const isHumanPrompt = startsTurn && !isSidechain;
      const isAgentPrompt = startsTurn && isSidechain && !isMeta;
      if (isHumanPrompt) {
        mainTurnIndex++;
        const prevEnd = currentTurn?.endTs ?? lastNonPromptTs;
        currentTurn = {
          index: mainTurnIndex,
          kind: promptKind ?? "human",
          startTs: t,
          promptPreview: preview(text2),
          promptChars: text2.length,
          commandName: cmd,
          messageUuids: [],
          toolCallIds: [],
          agentIds: [],
          usage: emptyUsage(),
          models: [],
          isCommand: promptKind === "command",
          interrupted: false,
          autoContinuations: 0,
          humanGapMs: prevEnd !== void 0 && t !== void 0 && t >= prevEnd ? t - prevEnd : void 0
        };
        turns.push(currentTurn);
        if (!firstPromptPreview && promptKind === "human") firstPromptPreview = currentTurn.promptPreview;
        if (cmd) skills.push({ name: cmd, via: "command", turnIndex: mainTurnIndex, ts: t, args: preview(text2.replace(COMMAND_RE, ""), 80) || void 0 });
      } else if (promptKind && !isSidechain && (promptKind === "notification" || promptKind === "local_output") && currentTurn) {
        currentTurn.autoContinuations++;
      } else if (isAgentPrompt && agentId) {
        agentTurnIndex.set(agentId, (agentTurnIndex.get(agentId) ?? -1) + 1);
        const run = ensureAgent(agents, agentId);
        if (run.startTs === void 0 || t !== void 0 && t < run.startTs) run.startTs = t;
      }
      const turnIndex = agentId ? agentTurnIndex.get(agentId) ?? 0 : mainTurnIndex;
      const usage = type === "assistant" ? parseUsage(message?.["usage"]) : void 0;
      const model = str(message?.["model"]);
      const iters = type === "assistant" ? arr(obj(message?.["usage"])?.["iterations"]) : void 0;
      const providerMessageId = str(message?.["id"]);
      let cacheMissReason;
      let thinkingTokens;
      if (type === "assistant") {
        const cmr = obj(obj(message?.["diagnostics"])?.["cache_miss_reason"]);
        if (cmr) cacheMissReason = { type: str(cmr["type"]) ?? "unknown", missedInputTokens: num(cmr["cache_missed_input_tokens"]) };
        thinkingTokens = num(obj(obj(message?.["usage"])?.["output_tokens_details"])?.["thinking_tokens"]);
        if (providerMessageId) {
          if (cacheMissReason && !cacheMissByProviderMsg.has(providerMessageId)) cacheMissByProviderMsg.set(providerMessageId, cacheMissReason);
          if (thinkingTokens !== void 0) {
            const prevTh = thinkingByProviderMsg.get(providerMessageId);
            if (prevTh === void 0 || thinkingTokens > prevTh) thinkingByProviderMsg.set(providerMessageId, thinkingTokens);
          }
        }
      }
      const apiErr = bool(r["isApiErrorMessage"]) || r["error"] !== void 0;
      const msg = {
        uuid: str(r["uuid"]) ?? `${f.index}:${line}`,
        parentUuid: str(r["parentUuid"]),
        role,
        ts: t,
        turnIndex,
        agentId,
        isSidechain,
        isMeta,
        isCompactSummary,
        isToolResultCarrier: hasToolResult,
        isHumanPrompt,
        promptKind,
        blocks,
        model,
        effort: str(r["effort"]),
        requestId: str(r["requestId"]),
        providerMessageId,
        stopReason: str(message?.["stop_reason"]),
        usage,
        usageCounted: false,
        preview: preview(text2 || blocks.map((b) => b.kind === "tool_use" ? `[${b.name}]` : b.kind === "thinking" ? "[thinking]" : b.kind === "tool_result" ? "[result]" : "").join(" ")),
        line,
        fileIndex: f.index,
        systemSubtype: type === "system" ? str(r["subtype"]) : void 0,
        commandName: cmd,
        interrupted,
        apiError: apiErr ? { status: r["apiErrorStatus"], message: preview(str(r["error"]) ?? text2, 200) } : void 0,
        attribution: type === "assistant" && (r["attributionSkill"] !== void 0 || r["attributionPlugin"] !== void 0 || r["attributionMcpServer"] !== void 0 || r["attributionAgent"] !== void 0) ? { skill: str(r["attributionSkill"]), plugin: str(r["attributionPlugin"]), mcpServer: str(r["attributionMcpServer"]), mcpTool: str(r["attributionMcpTool"]), agent: str(r["attributionAgent"]) } : void 0,
        thinkingTokens,
        cacheMissReason
      };
      const mi = messages.length;
      messages.push(msg);
      if (iters && iters.length > 1) {
        const list = [];
        for (let k = 0; k < iters.length - 1; k++) {
          const io = obj(iters[k]);
          const iu = parseUsage(io);
          if (iu) list.push({ model: str(io?.["model"]), usage: iu, type: str(io?.["type"]) });
        }
        if (list.length) hiddenIterations.push({ messageUuid: msg.uuid, iterations: list });
      }
      if (!agentId && currentTurn) currentTurn.messageUuids.push(msg.uuid);
      if (interrupted) {
        if (currentTurn && !agentId) currentTurn.interrupted = true;
        events.push({ kind: "interrupt", ts: t, turnIndex, agentId, label: "Request interrupted by user" });
      }
      for (const b of blocks) {
        if (b.kind === "other" && b.rawType === "fallback") events.push({ kind: "model_fallback", ts: t, turnIndex, agentId, label: b.note ?? "model fallback" });
      }
      if (apiErr) events.push({ kind: "api_error", ts: t, turnIndex, agentId, label: `API error${msg.apiError?.status ? " " + String(msg.apiError.status) : ""}`, detail: msg.apiError?.message });
      if (isCompactSummary) {
        if (pendingBoundary && pendingBoundary.summaryChars === void 0) {
          pendingBoundary.summaryChars = text2.length;
          pendingBoundary = void 0;
        } else {
          compactions.push({ ts: t, turnIndex, trigger: "unknown", summaryChars: text2.length });
        }
      }
      if (type === "system") {
        const sub = msg.systemSubtype;
        addCount(systemSubtypes, sub ?? "unknown");
        if (sub === "compact_boundary") {
          const cm = obj(r["compactMetadata"]);
          const ev = {
            ts: t,
            turnIndex,
            trigger: str(cm?.["trigger"]) ?? "unknown",
            contextBefore: num(cm?.["preTokens"]),
            contextAfter: num(cm?.["postTokens"]),
            durationMs: num(cm?.["durationMs"]),
            cumulativeDroppedTokens: num(cm?.["cumulativeDroppedTokens"])
          };
          compactions.push(ev);
          pendingBoundary = ev;
        } else if (sub === "turn_duration") {
          if (currentTurn && !agentId) currentTurn.reportedDurationMs = num(r["durationMs"]);
        } else if (sub === "stop_hook_summary") {
          for (const h of arr(r["hookInfos"]) ?? []) {
            const ho = obj(h);
            hooks.push({ hookEvent: "Stop", command: str(ho?.["command"]), durationMs: num(ho?.["durationMs"]), ok: true, ts: t, turnIndex });
          }
          for (const e of arr(r["hookErrors"]) ?? []) {
            const eo = obj(e);
            hooks.push({ hookEvent: "Stop", command: str(eo?.["command"]) ?? preview(String(e), 80), ok: false, ts: t, turnIndex });
          }
        } else if (sub === "scheduled_task_fire") {
          events.push({ kind: "scheduled_fire", ts: t, turnIndex, label: str(r["cronKind"]) ?? "scheduled", detail: preview(text2, 120) });
        } else if (sub === "away_summary") {
          events.push({ kind: "away_summary", ts: t, turnIndex, label: "away summary", detail: preview(text2, 200) });
        } else if (sub === "api_error" || sub === "api_retry") {
          events.push({ kind: "api_error", ts: t, turnIndex, label: sub, detail: preview(text2, 200) });
        }
        continue;
      }
      if (type === "assistant") {
        setAdd(meta.models, model);
        setAdd(meta.effortLevels, msg.effort);
        if (currentTurn && !agentId && model && !currentTurn.models.includes(model)) currentTurn.models.push(model);
        if (usage && providerMessageId) {
          const prev = lastRecordForProviderMsg.get(providerMessageId);
          const prevMsg = prev !== void 0 ? messages[prev] : void 0;
          const better = !prevMsg || !prevMsg.stopReason && !!msg.stopReason || !!prevMsg.stopReason === !!msg.stopReason && usage.output >= (prevMsg.usage?.output ?? 0);
          if (better) {
            if (prevMsg) prevMsg.usageCounted = false;
            lastRecordForProviderMsg.set(providerMessageId, mi);
          }
        }
        msg.usageCounted = !!usage && model !== "<synthetic>";
        for (const b of blocks) {
          if (b.kind !== "tool_use") continue;
          const name = b.name;
          const call = {
            toolUseId: b.toolUseId,
            name,
            category: categorizeTool(name),
            input: b.input,
            inputSummary: summarizeToolInput(name, b.input),
            inputBytes: bytesOf(b.input),
            messageUuid: msg.uuid,
            turnIndex,
            agentId,
            startTs: t,
            isError: false,
            unresolved: true,
            parallelGroupSize: 1,
            skillName: name === "Skill" ? skillNameFromInput(b.input) : void 0
          };
          toolCalls.push(call);
          if (b.toolUseId) toolByUseId.set(b.toolUseId, { call, msg });
          if (currentTurn && !agentId) currentTurn.toolCallIds.push(b.toolUseId);
          if (name === "Skill" && call.skillName) skills.push({ name: call.skillName, via: "tool", turnIndex, ts: t, agentId, args: str(obj(b.input)?.["args"]) });
          if (name === "AskUserQuestion") pendingAskCount++;
          if (name === "EnterPlanMode" || name === "ExitPlanMode") events.push({ kind: "plan_mode", ts: t, turnIndex, agentId, label: name });
          if (agentId) {
            const run = ensureAgent(agents, agentId);
            run.toolCallCount++;
          }
        }
        if (agentId) {
          const run = ensureAgent(agents, agentId);
          run.messageCount++;
          if (model && !run.model) run.model = model;
        }
        continue;
      }
      if (type === "user") {
        if (agentId && !hasToolResult) {
          const run = ensureAgent(agents, agentId);
          run.messageCount++;
        }
        for (const b of blocks) {
          if (b.kind !== "tool_result") continue;
          const p = toolByUseId.get(b.toolUseId);
          if (!p) {
            warn("orphan_tool_result", "tool_result without a matching tool_use", line);
            continue;
          }
          const c = p.call;
          c.endTs = t;
          c.durationMs = t !== void 0 && c.startTs !== void 0 && t >= c.startTs ? t - c.startTs : void 0;
          c.resultBytes = b.bytes;
          c.isError = b.isError;
          c.unresolved = false;
          c.resultPreview = preview(b.text, 200);
          const tur = r["toolUseResult"];
          c.resultMeta = tur;
          const turo = obj(tur);
          if (typeof tur === "string" && /^error/i.test(tur)) c.isError = true;
          if (turo) {
            if (bool(turo["interrupted"])) c.errorHint = "interrupted";
            if (bool(obj(turo["file"])?.["truncatedByTokenCap"])) c.truncated = true;
            const exit = num(turo["exitCode"]) ?? num(turo["exit_code"]);
            if (exit !== void 0 && exit !== 0) {
              c.isError = true;
              c.errorHint = `exit ${exit}`;
            }
            if (typeof turo["stderr"] === "string" && turo["stderr"] && c.isError && !c.errorHint) c.errorHint = preview(turo["stderr"], 120);
            if (c.name === "Agent" || c.name === "Task") {
              const aid = str(turo["agentId"]);
              if (aid) {
                c.spawnedAgentId = aid;
                const run = ensureAgent(agents, aid);
                run.spawnedByToolUseId = c.toolUseId;
                run.parentAgentId = agentId;
                const inp = obj(c.input);
                run.description = run.description ?? str(inp?.["description"]);
                run.agentType = run.agentType ?? str(inp?.["subagent_type"]);
                run.name = run.name ?? str(inp?.["name"]);
                run.reportedTotalTokens = num(turo["totalTokens"]);
                run.reportedDurationMs = num(turo["totalDurationMs"]);
                run.status = str(turo["status"]);
                if (run.endTs === void 0) run.endTs = t;
                if (run.startTs === void 0) run.startTs = c.startTs;
                const u = parseUsage(turo["usage"]);
                if (u && run.messageCount === 0) run.usage = u;
                if (currentTurn && !agentId && !currentTurn.agentIds.includes(aid)) currentTurn.agentIds.push(aid);
              } else {
                const name = str(turo["name"]);
                const teamName = str(turo["team_name"]) ?? str(turo["teamName"]);
                if (name) {
                  pendingTeammateLinks.push({
                    toolUseId: c.toolUseId,
                    name,
                    teamName,
                    parentAgentId: agentId,
                    turnIndex: !agentId && currentTurn ? currentTurn.index : void 0,
                    reportedTotalTokens: num(turo["totalTokens"]),
                    reportedDurationMs: num(turo["totalDurationMs"]),
                    status: str(turo["status"]),
                    endTs: t,
                    startTs: c.startTs,
                    description: str(obj(c.input)?.["description"])
                  });
                }
              }
            }
          }
          if (c.isError && !c.errorHint) c.errorHint = preview(b.text, 120);
        }
        if (isHumanPrompt || isMeta) {
        }
        if (!isHumanPrompt) lastNonPromptTs = t ?? lastNonPromptTs;
        continue;
      }
    }
  }
  const groupCount = /* @__PURE__ */ new Map();
  for (const m of messages) {
    if (m.role !== "assistant" || !m.providerMessageId) continue;
    const n2 = m.blocks.filter((b) => b.kind === "tool_use").length;
    if (n2) groupCount.set(m.providerMessageId, (groupCount.get(m.providerMessageId) ?? 0) + n2);
  }
  const msgByUuid = new Map(messages.map((m) => [m.uuid, m]));
  if (pendingTeammateLinks.length) {
    const byNameTeam = /* @__PURE__ */ new Map();
    for (const run of agents.values()) if (run.name) byNameTeam.set(run.name + "\0" + (run.teamName ?? ""), run);
    for (const link of pendingTeammateLinks) {
      const run = byNameTeam.get(link.name + "\0" + (link.teamName ?? "")) ?? [...agents.values()].find((r) => r.name === link.name);
      if (!run) continue;
      const call = toolByUseId.get(link.toolUseId)?.call;
      if (call) call.spawnedAgentId = run.agentId;
      run.spawnedByToolUseId = run.spawnedByToolUseId ?? link.toolUseId;
      run.parentAgentId = run.parentAgentId ?? link.parentAgentId;
      run.status = run.status ?? link.status;
      run.reportedTotalTokens = run.reportedTotalTokens ?? link.reportedTotalTokens;
      run.reportedDurationMs = run.reportedDurationMs ?? link.reportedDurationMs;
      run.description = run.description ?? link.description;
      if (run.startTs === void 0) run.startTs = link.startTs;
      if (run.endTs === void 0) run.endTs = link.endTs;
      if (link.turnIndex !== void 0) {
        const turn = turns[link.turnIndex];
        if (turn && !turn.agentIds.includes(run.agentId)) turn.agentIds.push(run.agentId);
      }
    }
  }
  for (const c of toolCalls) {
    const m = msgByUuid.get(c.messageUuid);
    const pid = m?.providerMessageId;
    if (pid) c.parallelGroupSize = groupCount.get(pid) ?? 1;
  }
  const agentsWithTranscriptUsage = /* @__PURE__ */ new Set();
  for (const [idx, m] of messages.entries()) {
    if (m.role !== "assistant" || !m.usage) continue;
    if (m.providerMessageId) {
      const lastIdx = lastRecordForProviderMsg.get(m.providerMessageId);
      m.usageCounted = lastIdx === idx && m.model !== "<synthetic>";
    }
    if (!m.usageCounted) continue;
    const u = m.usage;
    const evCacheMiss = (m.providerMessageId ? cacheMissByProviderMsg.get(m.providerMessageId) : void 0) ?? m.cacheMissReason;
    const evThinking = (m.providerMessageId ? thinkingByProviderMsg.get(m.providerMessageId) : void 0) ?? m.thinkingTokens;
    usageEvents.push({ messageUuid: m.uuid, ts: m.ts, turnIndex: m.turnIndex, agentId: m.agentId, model: m.model ?? "unknown", effort: m.effort, attribution: m.attribution, usage: u, contextSize: u.input + u.cacheRead + u.cacheWrite, thinkingTokens: evThinking, cacheMissReason: evCacheMiss });
    if (m.agentId) {
      const run = ensureAgent(agents, m.agentId);
      if (!agentsWithTranscriptUsage.has(m.agentId)) {
        agentsWithTranscriptUsage.add(m.agentId);
        run.usage = u;
      } else run.usage = addUsage(run.usage, u);
    } else {
      const turn = turns[m.turnIndex];
      if (turn) turn.usage = addUsage(turn.usage, u);
    }
  }
  const countedUuids = new Set(usageEvents.map((u) => u.messageUuid));
  for (const h of hiddenIterations) {
    if (!countedUuids.has(h.messageUuid)) continue;
    const m = msgByUuid.get(h.messageUuid);
    if (!m) continue;
    h.iterations.forEach((it, idx) => {
      usageEvents.push({ messageUuid: m.uuid, ts: m.ts, turnIndex: m.turnIndex, agentId: m.agentId, model: it.model ?? m.model ?? "unknown", effort: m.effort, usage: it.usage, contextSize: it.usage.input + it.usage.cacheRead + it.usage.cacheWrite, hiddenIteration: { index: idx, type: it.type } });
      if (m.agentId) {
        const run = ensureAgent(agents, m.agentId);
        run.usage = addUsage(run.usage, it.usage);
      } else {
        const turn = turns[m.turnIndex];
        if (turn) turn.usage = addUsage(turn.usage, it.usage);
      }
    });
  }
  for (const run of agents.values()) {
    if (run.startTs !== void 0 && run.endTs !== void 0 && run.endTs >= run.startTs) run.durationMs = run.endTs - run.startTs;
    else if (run.reportedDurationMs !== void 0) run.durationMs = run.reportedDurationMs;
  }
  for (const m of messages) {
    if (!m.agentId || m.ts === void 0) continue;
    const run = agents.get(m.agentId);
    if (!run) continue;
    if (run.endTs === void 0 || m.ts > run.endTs) run.endTs = m.ts;
    if (run.startTs === void 0 || m.ts < run.startTs) run.startTs = m.ts;
  }
  for (const run of agents.values()) {
    if (run.startTs !== void 0 && run.endTs !== void 0 && run.endTs >= run.startTs) run.durationMs = run.endTs - run.startTs;
  }
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    let end;
    let firstAssistant;
    for (const uuid of turn.messageUuids) {
      const m = msgByUuid.get(uuid);
      if (!m || m.ts === void 0) continue;
      if (end === void 0 || m.ts > end) end = m.ts;
      if (m.role === "assistant" && (firstAssistant === void 0 || m.ts < firstAssistant)) firstAssistant = m.ts;
    }
    for (const id of turn.toolCallIds) {
      const c = toolByUseId.get(id)?.call;
      if (c?.endTs !== void 0 && (end === void 0 || c.endTs > end)) end = c.endTs;
    }
    turn.endTs = end;
    turn.durationMs = end !== void 0 && turn.startTs !== void 0 && end >= turn.startTs ? end - turn.startTs : void 0;
    turn.firstResponseMs = firstAssistant !== void 0 && turn.startTs !== void 0 && firstAssistant >= turn.startTs ? firstAssistant - turn.startTs : void 0;
  }
  for (let i = 1; i < turns.length; i++) {
    const prev = turns[i - 1];
    const cur = turns[i];
    if (prev.endTs !== void 0 && cur.startTs !== void 0 && cur.startTs >= prev.endTs) cur.humanGapMs = cur.startTs - prev.endTs;
  }
  if (pendingAskCount) events.push({ kind: "permission_prompt", turnIndex: -1, label: `AskUserQuestion x${pendingAskCount}` });
  meta.startedAt = firstTs;
  meta.endedAt = lastTs;
  meta.wallMs = firstTs !== void 0 && lastTs !== void 0 ? lastTs - firstTs : void 0;
  const rawTitle = meta.customTitle ?? meta.aiTitle ?? firstPromptPreview ?? turns[0]?.promptPreview;
  meta.title = rawTitle !== void 0 && /^\s*<command-(?:message|name)>/.test(rawTitle) ? commandEnvelopeTitle(rawTitle, turns[0]?.commandName) : rawTitle;
  if (!meta.sessionId) meta.sessionId = basename4(mainPath, ".jsonl");
  if (files2[0]?.trailingPartial) meta.possiblyLive = true;
  if (seenSessionIds.size > 1) warn("multiple_session_ids", `records reference ${seenSessionIds.size} distinct sessionIds (resumed/forked session)`);
  if (queueOperations.size) meta.queueOperations = countRecord(queueOperations);
  if (enqueueHuman || enqueueNotification) meta.enqueueKinds = { human: enqueueHuman, notification: enqueueNotification };
  if (deferredToolNames.size) meta.deferredToolNames = [...deferredToolNames].sort();
  meta.projectSlug = mainPath !== "(memory)" ? basename4(dirname3(mainPath)) : void 0;
  if (meta.projectSlug && !meta.projectSlug.startsWith("-") && !/^[A-Za-z]-/.test(meta.projectSlug)) meta.projectSlug = void 0;
  const parseReport = {
    totalLines: files2.reduce((a, f) => a + f.totalLines, 0),
    badLines: files2.reduce((a, f) => a + f.badLines, 0),
    recordCounts: countRecord(recordCounts),
    unknownRecordTypes: countRecord(unknownRecordTypes),
    unknownBlockTypes: countRecord(unknownBlockTypes),
    attachmentTypes: countRecord(attachmentTypes),
    attachmentBytes: countRecord(attachmentBytes),
    systemSubtypes: countRecord(systemSubtypes),
    warnings: [...warnings.values()],
    parseMs: Date.now() - t0,
    bytes: files2.reduce((a, f) => a + f.bytes, 0)
  };
  const unresolved = toolCalls.filter((c) => c.unresolved).length;
  if (unresolved) parseReport.warnings.push({ code: "unresolved_tool_calls", message: "tool_use without a tool_result (interrupted or still running)", count: unresolved });
  return {
    meta,
    turns,
    messages,
    toolCalls,
    agents: [...agents.values()].sort((a, b) => (a.startTs ?? 0) - (b.startTs ?? 0)),
    skills,
    hooks,
    compactions,
    usageEvents,
    events,
    parseReport
  };
}
function ensureAgent(map, id) {
  let run = map.get(id);
  if (!run) {
    run = { agentId: id, spawnDepth: 0, messageCount: 0, toolCallCount: 0, usage: emptyUsage() };
    map.set(id, run);
  }
  return run;
}

// src/models/catalog.json
var catalog_default = {
  $comment: "orangu model catalog: display names, families, context windows and id-resolution rules for every model orangu has seen. Tokens are the only metric orangu reports; this file carries no rates of any kind.",
  schemaVersion: 2,
  updatedAt: "2026-08-14",
  models: {
    "claude-fable-5": {
      displayName: "Claude Fable 5",
      family: "fable",
      status: "active",
      releaseDate: "2026-06-09",
      releaseDateConfidence: "verified",
      contextWindow: 1e6,
      maxOutputTokens: 128e3,
      tokenizer: "opus-4-7",
      verified: true
    },
    "claude-mythos-5": {
      displayName: "Claude Mythos 5",
      family: "mythos",
      status: "active-limited",
      releaseDate: "2026-06-09",
      releaseDateConfidence: "verified",
      contextWindow: 1e6,
      maxOutputTokens: 128e3,
      tokenizer: "opus-4-7",
      verified: true
    },
    "claude-mythos-preview": {
      displayName: "Claude Mythos Preview",
      family: "mythos",
      status: "deprecated",
      releaseDate: null,
      releaseDateConfidence: "unknown",
      contextWindow: 1e6,
      maxOutputTokens: 128e3,
      tokenizer: "opus-4-7",
      verified: false
    },
    "claude-opus-5": {
      displayName: "Claude Opus 5",
      family: "opus",
      status: "active",
      releaseDate: "2026-07-24",
      releaseDateConfidence: "verified",
      contextWindow: 1e6,
      maxOutputTokens: 128e3,
      tokenizer: "opus-4-7",
      verified: true
    },
    "claude-opus-4-8": {
      displayName: "Claude Opus 4.8",
      family: "opus",
      status: "active-legacy",
      releaseDate: "2026-05-28",
      releaseDateConfidence: "derived",
      contextWindow: 1e6,
      maxOutputTokens: 128e3,
      tokenizer: "opus-4-7",
      verified: true
    },
    "claude-opus-4-7": {
      displayName: "Claude Opus 4.7",
      family: "opus",
      status: "active-legacy",
      releaseDate: "2026-04-16",
      releaseDateConfidence: "derived",
      contextWindow: 1e6,
      maxOutputTokens: 128e3,
      tokenizer: "opus-4-7",
      verified: true,
      note: "First model on the newer tokenizer (~30% more tokens for the same text). speed:fast returns an error."
    },
    "claude-opus-4-6": {
      displayName: "Claude Opus 4.6",
      family: "opus",
      status: "active-legacy",
      releaseDate: "2026-02-05",
      releaseDateConfidence: "derived",
      contextWindow: 1e6,
      maxOutputTokens: 128e3,
      tokenizer: "legacy",
      verified: true
    },
    "claude-opus-4-5-20251101": {
      displayName: "Claude Opus 4.5",
      family: "opus",
      status: "active-legacy",
      releaseDate: "2025-11-01",
      releaseDateConfidence: "verified",
      contextWindow: 2e5,
      maxOutputTokens: 64e3,
      tokenizer: "legacy",
      verified: true
    },
    "claude-opus-4-1-20250805": {
      displayName: "Claude Opus 4.1",
      family: "opus",
      status: "retired",
      retiredOn: "2026-08-05",
      releaseDate: "2025-08-05",
      releaseDateConfidence: "derived-from-id",
      contextWindow: 2e5,
      maxOutputTokens: 32e3,
      maxOutputTokensVerified: false,
      tokenizer: "legacy",
      verified: true
    },
    "claude-opus-4-20250514": {
      displayName: "Claude Opus 4",
      family: "opus",
      status: "retired",
      retiredOn: "2026-06-15",
      releaseDate: "2025-05-14",
      releaseDateConfidence: "derived-from-id",
      contextWindow: 2e5,
      maxOutputTokens: 32e3,
      maxOutputTokensVerified: false,
      tokenizer: "legacy",
      verified: true
    },
    "claude-sonnet-5": {
      displayName: "Claude Sonnet 5",
      family: "sonnet",
      status: "active",
      releaseDate: "2026-06-30",
      releaseDateConfidence: "derived",
      contextWindow: 1e6,
      maxOutputTokens: 128e3,
      tokenizer: "opus-4-7",
      verified: true
    },
    "claude-sonnet-4-6": {
      displayName: "Claude Sonnet 4.6",
      family: "sonnet",
      status: "active-legacy",
      releaseDate: "2026-02-17",
      releaseDateConfidence: "derived",
      contextWindow: 1e6,
      maxOutputTokens: 128e3,
      tokenizer: "legacy",
      verified: true
    },
    "claude-sonnet-4-5-20250929": {
      displayName: "Claude Sonnet 4.5",
      family: "sonnet",
      status: "active-legacy",
      releaseDate: "2025-09-29",
      releaseDateConfidence: "verified",
      contextWindow: 2e5,
      maxOutputTokens: 64e3,
      tokenizer: "legacy",
      verified: true
    },
    "claude-sonnet-4-20250514": {
      displayName: "Claude Sonnet 4",
      family: "sonnet",
      status: "retired",
      retiredOn: "2026-06-15",
      releaseDate: "2025-05-14",
      releaseDateConfidence: "derived-from-id",
      contextWindow: 2e5,
      maxOutputTokens: 64e3,
      maxOutputTokensVerified: false,
      tokenizer: "legacy",
      verified: true
    },
    "claude-haiku-4-5-20251001": {
      displayName: "Claude Haiku 4.5",
      family: "haiku",
      status: "active",
      releaseDate: "2025-10-01",
      releaseDateConfidence: "verified",
      contextWindow: 2e5,
      maxOutputTokens: 64e3,
      tokenizer: "legacy",
      verified: true
    },
    "claude-3-5-haiku-20241022": {
      displayName: "Claude Haiku 3.5",
      family: "haiku",
      status: "retired",
      retiredOn: "2026-02-19",
      releaseDate: "2024-10-22",
      releaseDateConfidence: "derived-from-id",
      contextWindow: 2e5,
      maxOutputTokens: 8192,
      maxOutputTokensVerified: false,
      tokenizer: "legacy",
      verified: true
    },
    "claude-3-7-sonnet-20250219": {
      displayName: "Claude Sonnet 3.7",
      family: "sonnet",
      status: "retired",
      retiredOn: "2026-02-19",
      releaseDate: "2025-02-19",
      releaseDateConfidence: "derived-from-id",
      contextWindow: 2e5,
      maxOutputTokens: 64e3,
      maxOutputTokensVerified: false,
      tokenizer: "legacy",
      verified: false
    },
    "claude-3-5-sonnet-20241022": {
      displayName: "Claude Sonnet 3.5 (v2)",
      family: "sonnet",
      status: "retired",
      retiredOn: "2025-10-28",
      releaseDate: "2024-10-22",
      releaseDateConfidence: "derived-from-id",
      contextWindow: 2e5,
      maxOutputTokens: 8192,
      maxOutputTokensVerified: false,
      tokenizer: "legacy",
      verified: false
    },
    "claude-3-5-sonnet-20240620": {
      displayName: "Claude Sonnet 3.5 (v1)",
      family: "sonnet",
      status: "retired",
      retiredOn: "2025-10-28",
      releaseDate: "2024-06-20",
      releaseDateConfidence: "derived-from-id",
      contextWindow: 2e5,
      maxOutputTokens: 8192,
      maxOutputTokensVerified: false,
      tokenizer: "legacy",
      verified: false,
      note: "NOT on any live Anthropic page. Historical value, unverified."
    },
    "claude-3-opus-20240229": {
      displayName: "Claude Opus 3",
      family: "opus",
      status: "retired",
      retiredOn: "2026-01-05",
      releaseDate: "2024-02-29",
      releaseDateConfidence: "derived-from-id",
      contextWindow: 2e5,
      maxOutputTokens: 4096,
      maxOutputTokensVerified: false,
      tokenizer: "legacy",
      verified: false,
      note: "NOT on any live Anthropic page. Historical value, unverified."
    },
    "claude-3-sonnet-20240229": {
      displayName: "Claude Sonnet 3",
      family: "sonnet",
      status: "retired",
      retiredOn: "2025-07-21",
      releaseDate: "2024-02-29",
      releaseDateConfidence: "derived-from-id",
      contextWindow: 2e5,
      maxOutputTokens: 4096,
      maxOutputTokensVerified: false,
      tokenizer: "legacy",
      verified: false,
      note: "NOT on any live Anthropic page. Historical value, unverified."
    },
    "claude-3-haiku-20240307": {
      displayName: "Claude Haiku 3",
      family: "haiku",
      status: "retired",
      retiredOn: "2026-04-20",
      releaseDate: "2024-03-07",
      releaseDateConfidence: "derived-from-id",
      contextWindow: 2e5,
      maxOutputTokens: 4096,
      maxOutputTokensVerified: false,
      tokenizer: "legacy",
      verified: false,
      note: "NOT on any live Anthropic page. Historical value, unverified."
    },
    "claude-2.1": {
      displayName: "Claude 2.1",
      family: "legacy",
      status: "retired",
      retiredOn: "2025-07-21",
      releaseDate: "2023-11-21",
      releaseDateConfidence: "unverified",
      contextWindow: 2e5,
      maxOutputTokens: 4096,
      maxOutputTokensVerified: false,
      tokenizer: "legacy",
      verified: false,
      note: "NOT on any live Anthropic page. Historical value, unverified. Prompt caching never existed for this model - cache fields are derived placeholders only."
    },
    "claude-2.0": {
      displayName: "Claude 2.0",
      family: "legacy",
      status: "retired",
      retiredOn: "2025-07-21",
      releaseDate: "2023-07-11",
      releaseDateConfidence: "unverified",
      contextWindow: 1e5,
      maxOutputTokens: 4096,
      maxOutputTokensVerified: false,
      tokenizer: "legacy",
      verified: false,
      note: "NOT on any live Anthropic page. Historical value, unverified."
    }
  },
  aliases: {
    "claude-opus-4-5": "claude-opus-4-5-20251101",
    "claude-opus-4-1": "claude-opus-4-1-20250805",
    "claude-opus-4-0": "claude-opus-4-20250514",
    "claude-opus-4": "claude-opus-4-20250514",
    "claude-sonnet-4-5": "claude-sonnet-4-5-20250929",
    "claude-sonnet-4-0": "claude-sonnet-4-20250514",
    "claude-sonnet-4": "claude-sonnet-4-20250514",
    "claude-haiku-4-5": "claude-haiku-4-5-20251001",
    "claude-3-7-sonnet-latest": "claude-3-7-sonnet-20250219",
    "claude-3-5-sonnet-latest": "claude-3-5-sonnet-20241022",
    "claude-3-5-haiku-latest": "claude-3-5-haiku-20241022",
    "claude-3-opus-latest": "claude-3-opus-20240229"
  },
  unstableAliases: {
    opus: "claude-opus-5",
    sonnet: "claude-sonnet-5",
    haiku: "claude-haiku-4-5-20251001",
    opusplan: "claude-opus-5",
    default: "claude-sonnet-5",
    $comment: "Bare tier names emitted by the Claude Code UI/config and by Task/Agent tool inputs (input.model), NOT by the API. They resolve to whatever the CLI default for that tier was on the day the session ran, so any model attribution derived from them MUST be flagged estimatedMatch:true."
  },
  nonModelSentinels: {
    "<synthetic>": {
      reason: "Claude Code-generated local message (API error notices, interrupt notices, hook output). Its usage object is all zeros with service_tier/speed/inference_geo null."
    },
    $comment: "Values that appear in the `model` position but are not real models. They are excluded from per-model rollups; their usage is counted as reported."
  },
  idNormalization: {
    $comment: "Apply these rewrites in order before alias/exact lookup.",
    steps: [
      {
        step: 1,
        rule: "lowercase and trim"
      },
      {
        step: 2,
        rule: "strip cross-region inference-profile prefixes",
        regex: "^(us|eu|apac|global|us-gov)\\.",
        example: "us.anthropic.claude-sonnet-4-5-20250929-v1:0 -> anthropic.claude-sonnet-4-5-20250929-v1:0"
      },
      {
        step: 3,
        rule: "strip provider prefix",
        regex: "^anthropic\\.",
        example: "anthropic.claude-opus-5 -> claude-opus-5"
      },
      {
        step: 4,
        rule: "strip Bedrock version suffix",
        regex: "-v\\d+:\\d+$",
        example: "claude-haiku-4-5-20251001-v1:0 -> claude-haiku-4-5-20251001"
      },
      {
        step: 5,
        rule: "strip trailing bare :N",
        regex: ":\\d+$"
      },
      {
        step: 6,
        rule: "Vertex date separator",
        regex: "@(\\d{8})$ -> -$1",
        example: "claude-opus-4-5@20251101 -> claude-opus-4-5-20251101"
      },
      {
        step: 7,
        rule: "strip Claude Code context tag and record it",
        regex: "\\[(1m|200k|\\d+k)\\]$",
        example: "claude-opus-5[1m] -> claude-opus-5"
      },
      {
        step: 8,
        rule: "strip -fast suffix and set speed=fast",
        regex: "-fast$",
        example: "claude-opus-4-6-fast -> claude-opus-4-6"
      },
      {
        step: 9,
        rule: "exact lookup in models, then aliases, then unstableAliases (mark estimated), then dated-to-dateless prefix match, then fallbackByFamily (mark estimated)"
      }
    ]
  },
  fallbackByFamily: {
    order: [
      "mythos",
      "fable",
      "opus",
      "sonnet",
      "haiku",
      "unknown"
    ],
    mythos: {
      match: "mythos",
      useModel: "claude-mythos-5",
      estimated: true
    },
    fable: {
      match: "fable",
      useModel: "claude-fable-5",
      estimated: true
    },
    opus: {
      match: "opus",
      useModel: "claude-opus-5",
      estimated: true
    },
    sonnet: {
      match: "sonnet",
      useModel: "claude-sonnet-5",
      estimated: true
    },
    haiku: {
      match: "haiku",
      useModel: "claude-haiku-4-5-20251001",
      estimated: true
    },
    unknown: {
      match: ".*",
      useModel: null,
      estimated: true,
      behavior: "Do NOT invent an identity. Keep the raw id as the display name, leave contextWindow undefined, set estimatedMatch=true, and count the tokens exactly as reported."
    },
    $comment: "Last resort for a model id orangu has never seen. Match the FIRST pattern that hits against the normalized id. A match found this way MUST be tagged estimatedMatch:true and surfaced as an approximation, never as a fact."
  }
};

// src/models/catalog.ts
var T = catalog_default;
function normalizeModelId(raw) {
  const tags = [];
  let id = raw.trim().toLowerCase();
  id = id.replace(/^(us|eu|apac|global|us-gov)\./, "");
  id = id.replace(/^anthropic\./, "");
  id = id.replace(/-v\d+:\d+$/, "");
  id = id.replace(/:\d+$/, "");
  id = id.replace(/@(\d{8})$/, "-$1");
  const ctx = /\[(1m|200k|\d+k)\]$/.exec(id);
  if (ctx) {
    tags.push(`context:${ctx[1]}`);
    id = id.slice(0, ctx.index);
  }
  if (id.endsWith("-fast")) {
    tags.push("speed:fast");
    id = id.slice(0, -5);
  }
  return { id, tags };
}
var cache = /* @__PURE__ */ new Map();
function resolveModel(rawId) {
  const raw = rawId ?? "unknown";
  const hit = cache.get(raw);
  if (hit) return hit;
  const { id, tags } = normalizeModelId(raw);
  let out3;
  if (raw in T.nonModelSentinels || id in T.nonModelSentinels) {
    out3 = { rawId: raw, normalizedId: id, displayName: raw, family: "none", estimatedMatch: false, synthetic: true, tags };
  } else {
    let catalogId;
    let estimatedMatch = false;
    if (T.models[id]) catalogId = id;
    else if (T.aliases[id]) catalogId = T.aliases[id];
    else if (T.unstableAliases[id] && typeof T.unstableAliases[id] === "string" && T.models[T.unstableAliases[id]]) {
      catalogId = T.unstableAliases[id];
      estimatedMatch = true;
    } else {
      const dateless = id.replace(/-\d{8}$/, "");
      const candidates = Object.keys(T.models).filter((k) => k === dateless || k.startsWith(dateless + "-") || dateless.startsWith(k + "-"));
      if (candidates.length) {
        catalogId = candidates.sort((a, b) => b.length - a.length)[0];
        estimatedMatch = true;
      } else {
        for (const fam of T.fallbackByFamily.order) {
          const rule = T.fallbackByFamily[fam];
          if (rule?.match && id.includes(rule.match) && rule.useModel && T.models[rule.useModel]) {
            catalogId = rule.useModel;
            estimatedMatch = true;
            break;
          }
        }
      }
    }
    const entry = catalogId ? T.models[catalogId] : void 0;
    const unverified = entry ? entry.verified === false : false;
    out3 = {
      rawId: raw,
      normalizedId: id,
      catalogId,
      displayName: entry?.displayName ?? raw,
      family: entry?.family ?? guessFamily(id),
      contextWindow: entry?.contextWindow,
      estimatedMatch: estimatedMatch || !entry || unverified,
      synthetic: false,
      tags
    };
  }
  cache.set(raw, out3);
  return out3;
}
function guessFamily(id) {
  for (const f of ["mythos", "fable", "opus", "sonnet", "haiku"]) if (id.includes(f)) return f;
  return "unknown";
}
function catalogInfo() {
  return { updatedAt: T.updatedAt, modelCount: Object.keys(T.models).length };
}

// src/analyze/tools.ts
function toolCallView(c) {
  return {
    toolUseId: c.toolUseId,
    name: c.name,
    category: c.category,
    summary: c.inputSummary,
    turnIndex: c.turnIndex,
    agentId: c.agentId,
    startTs: c.startTs,
    durationMs: c.durationMs,
    resultBytes: c.resultBytes,
    isError: c.isError,
    errorHint: c.errorHint,
    parallelGroupSize: c.parallelGroupSize
  };
}
function errorSignature(c) {
  const raw = scrubStr(c.errorHint ?? c.resultPreview ?? "error").toLowerCase();
  return raw.replace(/\/[^\s'"]+/g, "<path>").replace(/0x[0-9a-f]+/g, "<hex>").replace(/\d+/g, "<n>").replace(/\s+/g, " ").trim().slice(0, 80);
}
function analyzeTools(s) {
  const byName = /* @__PURE__ */ new Map();
  for (const c of s.toolCalls) {
    const arr2 = byName.get(c.name);
    if (arr2) arr2.push(c);
    else byName.set(c.name, [c]);
  }
  const stats = [];
  for (const [name, calls] of byName) {
    const durs = calls.map((c) => c.durationMs).filter((d) => d !== void 0);
    const res = calls.map((c) => c.resultBytes ?? 0);
    stats.push({
      name,
      category: calls[0].category,
      count: calls.length,
      errors: calls.filter((c) => c.isError).length,
      unresolved: calls.filter((c) => c.unresolved).length,
      totalMs: sum(durs),
      avgMs: durs.length ? round(sum(durs) / durs.length, 0) : 0,
      p95Ms: percentile(durs, 95),
      maxMs: durs.length ? Math.max(...durs) : 0,
      resultBytesTotal: sum(res),
      resultBytesMax: res.length ? Math.max(...res) : 0,
      inputBytesTotal: sum(calls.map((c) => c.inputBytes)),
      parallelShare: calls.length ? round(calls.filter((c) => c.parallelGroupSize > 1).length / calls.length, 3) : 0,
      mainCount: calls.filter((c) => !c.agentId).length,
      agentCount: calls.filter((c) => !!c.agentId).length
    });
  }
  stats.sort((a, b) => b.count - a.count);
  const catMap = /* @__PURE__ */ new Map();
  for (const c of s.toolCalls) {
    const e = catMap.get(c.category) ?? { count: 0, totalMs: 0, errors: 0 };
    e.count++;
    e.totalMs += c.durationMs ?? 0;
    if (c.isError) e.errors++;
    catMap.set(c.category, e);
  }
  const byCategory = [...catMap.entries()].map(([category, v]) => ({ category, ...v })).sort((a, b) => b.count - a.count);
  const groups = /* @__PURE__ */ new Map();
  for (const c of s.toolCalls) {
    if (!c.isError) continue;
    const sig = errorSignature(c);
    const key = c.name + "|" + sig;
    const g = groups.get(key);
    if (g) g.count++;
    else groups.set(key, { name: c.name, signature: sig, count: 1, sampleTurnIndex: c.turnIndex, sampleHint: c.errorHint ?? c.resultPreview });
  }
  const errorGroups = [...groups.values()].sort((a, b) => b.count - a.count);
  const seen = /* @__PURE__ */ new Set();
  let groupsN = 0;
  let parallelGroups = 0;
  let maxGroupSize = 1;
  let parallelCalls = 0;
  for (const c of s.toolCalls) {
    const key = `${c.agentId ?? "main"}|${c.messageUuid}|${c.parallelGroupSize}`;
    if (c.parallelGroupSize > 1) parallelCalls++;
    if (seen.has(key)) continue;
    seen.add(key);
    groupsN++;
    if (c.parallelGroupSize > 1) parallelGroups++;
    if (c.parallelGroupSize > maxGroupSize) maxGroupSize = c.parallelGroupSize;
  }
  return {
    byName: stats,
    byCategory,
    errorGroups,
    slowest: topN(s.toolCalls, 10, (c) => c.durationMs ?? 0).map(toolCallView),
    largestResults: topN(s.toolCalls, 10, (c) => c.resultBytes ?? 0).map(toolCallView),
    parallelism: { groups: groupsN, parallelGroups, maxGroupSize, parallelCallShare: s.toolCalls.length ? round(parallelCalls / s.toolCalls.length, 3) : 0 },
    calls: s.toolCalls.map(toolCallView)
  };
}
function bashTemplate(cmd) {
  return cmd.replace(/\s+/g, " ").trim().replace(/[^\s'"|;&<>()=]*\/[^\s'"|;&<>()]+/g, "\xABpath\xBB").replace(/\b[0-9a-f]{7,64}\b/gi, "\xABhash\xBB").replace(/\b\d+(?:\.\d+)*\b/g, "\xABn\xBB");
}
function repeatedNgrams(seq2, n2, minCount) {
  if (n2 < 1 || seq2.length < n2 * minCount) return [];
  const sliding = /* @__PURE__ */ new Map();
  const SEP = "\0";
  for (let i = 0; i + n2 <= seq2.length; i++) {
    const key = seq2.slice(i, i + n2).join(SEP);
    sliding.set(key, (sliding.get(key) ?? 0) + 1);
  }
  const hits = [];
  for (const [key, c] of sliding) {
    if (c < minCount) continue;
    const gram = key.split(SEP);
    const starts = [];
    for (let i = 0; i + n2 <= seq2.length; ) {
      let match = true;
      for (let j = 0; j < n2; j++)
        if (seq2[i + j] !== gram[j]) {
          match = false;
          break;
        }
      if (match) {
        starts.push(i);
        i += n2;
      } else i++;
    }
    if (starts.length >= minCount) hits.push({ gram, count: starts.length, starts });
  }
  hits.sort((a, b) => b.count - a.count || (a.gram.join() < b.gram.join() ? -1 : 1));
  return hits;
}

// src/analyze/quality.ts
var TEST_RUNNERS = ["vitest", "jest", "pytest", "mocha", "rspec", "phpunit", "ava", "tap", "karma", "jasmine"];
var BUILD_TOOLS = ["tsc", "eslint", "ruff", "mypy", "prettier", "webpack", "rollup", "esbuild", "turbo"];
function segments(cmd) {
  return cmd.split(/&&|\|\||[;|\n]/).map((s) => s.trim()).filter(Boolean);
}
function words(seg) {
  return seg.split(/\s+/).filter(Boolean);
}
function isTestSegment(seg) {
  const w = words(seg);
  if (!w.length) return false;
  let i = 0;
  while (i < w.length && /^[A-Z_][A-Z0-9_]*=/.test(w[i])) i++;
  const cmd0 = w[i] ?? "";
  const base = cmd0.split("/").pop() ?? cmd0;
  const rest = w.slice(i + 1);
  const first = rest[0] ?? "";
  if (["npm", "pnpm", "yarn", "bun"].includes(base)) {
    const sub = first === "run" ? rest[1] : first;
    return sub === "test" || TEST_RUNNERS.includes(sub ?? "");
  }
  if (base === "npx") return TEST_RUNNERS.includes(first) || first === "playwright" && rest[1] === "test";
  if (TEST_RUNNERS.includes(base)) return true;
  if (base === "python" || base === "python3") return rest.includes("pytest") && rest[0] === "-m";
  if (base === "go" && first === "test") return true;
  if (base === "cargo" && first === "test") return true;
  if ((base === "mvn" || base === "gradle") && rest.includes("test")) return true;
  if ((base === "dotnet" || base === "swift") && first === "test") return true;
  if (base === "make" && first === "test") return true;
  return false;
}
function isBuildSegment(seg) {
  const w = words(seg);
  if (!w.length) return false;
  let i = 0;
  while (i < w.length && /^[A-Z_][A-Z0-9_]*=/.test(w[i])) i++;
  const cmd0 = w[i] ?? "";
  const base = cmd0.split("/").pop() ?? cmd0;
  const rest = w.slice(i + 1);
  const first = rest[0] ?? "";
  if (["npm", "pnpm", "yarn", "bun"].includes(base) && first === "run") {
    const script = rest[1] ?? "";
    return /^(build|typecheck|lint|compile|check)/.test(script);
  }
  if (base === "npx") return BUILD_TOOLS.includes(first);
  if (base === "tsc") return !rest.includes("--version");
  if (BUILD_TOOLS.includes(base)) return true;
  if (base === "go" && (first === "build" || first === "vet")) return true;
  if (base === "cargo" && (first === "build" || first === "check" || first === "clippy")) return true;
  if (base === "make" && first !== "test") return true;
  if (base === "gradle" && (first === "build" || first === "assemble")) return true;
  if (base === "mvn" && ["package", "compile", "install", "verify"].includes(first)) return true;
  if ((base === "dotnet" || base === "next" || base === "vite") && first === "build") return true;
  return false;
}
function classifyCommand(cmd) {
  for (const seg of segments(cmd)) {
    if (isTestSegment(seg)) return "test";
  }
  for (const seg of segments(cmd)) {
    if (isBuildSegment(seg)) return "build";
  }
  return null;
}
function hasCommit(cmd) {
  return segments(cmd).some((seg) => {
    const w = words(seg);
    const base = (w[0] ?? "").split("/").pop();
    return base === "git" && w[1] === "commit";
  });
}
function hasPrCreate(cmd) {
  return segments(cmd).some((seg) => {
    const w = words(seg);
    const base = (w[0] ?? "").split("/").pop();
    return base === "gh" && w[1] === "pr" && w[2] === "create";
  });
}
var CORRECTION_RE = /^(no[,.!\s]|nope|wrong|not that|that'?s not|incorrect|revert|undo|again[,.!]|still (broken|failing|wrong|not)|didn'?t work|doesn'?t work|you broke|why did you|stop[,.!]|don'?t do that|i said|as i said|i asked)/i;
function cmdOf(c) {
  const i = c.input;
  return typeof i?.["command"] === "string" ? i["command"] : "";
}
function pathOf(c) {
  const i = c.input;
  const p = i?.["file_path"] ?? i?.["notebook_path"] ?? i?.["path"];
  return typeof p === "string" ? p : void 0;
}
function analyzeFiles(s) {
  const map = /* @__PURE__ */ new Map();
  const editHistory = /* @__PURE__ */ new Map();
  const readsByContext = /* @__PURE__ */ new Map();
  for (const c of s.toolCalls) {
    const p = pathOf(c);
    if (!p) continue;
    const key = shortPath(p, s.meta.cwd);
    let f = map.get(key);
    if (!f) {
      f = { path: key, reads: 0, edits: 0, writes: 0, bytesRead: 0, turnIndexes: [], agentReads: 0, redundantReads: 0 };
      map.set(key, f);
    }
    if (!f.turnIndexes.includes(c.turnIndex)) f.turnIndexes.push(c.turnIndex);
    if (c.category === "read") {
      f.reads++;
      f.bytesRead += c.resultBytes ?? 0;
      if (c.agentId) f.agentReads++;
      const ctxKey = c.agentId ?? "main";
      const ctxMap = readsByContext.get(key) ?? /* @__PURE__ */ new Map();
      ctxMap.set(ctxKey, (ctxMap.get(ctxKey) ?? 0) + 1);
      readsByContext.set(key, ctxMap);
    } else if (c.category === "edit") {
      f.edits++;
      const i = c.input;
      const h = editHistory.get(key) ?? [];
      h.push(String(i["old_string"] ?? "").slice(0, 200) + "=>" + String(i["new_string"] ?? "").slice(0, 200));
      editHistory.set(key, h);
    } else if (c.category === "write") f.writes++;
  }
  let editedThenReverted = 0;
  for (const [, h] of editHistory) {
    for (let i = 1; i < h.length; i++) {
      const [a, b] = h[i].split("=>");
      const [pa, pb] = h[i - 1].split("=>");
      if (a && b && a === pb && b === pa) editedThenReverted++;
    }
  }
  for (const [key, ctxMap] of readsByContext) {
    let redundant = 0;
    for (const n2 of ctxMap.values()) redundant += Math.max(0, n2 - 1);
    const f = map.get(key);
    if (f) f.redundantReads = redundant;
  }
  const files2 = [...map.values()].sort((a, b) => b.reads + b.edits + b.writes - (a.reads + a.edits + a.writes));
  return { files: files2, mostReRead: topN(files2.filter((f) => f.redundantReads >= 1), 10, (f) => f.redundantReads), totalDistinct: files2.length, editedThenReverted };
}
function analyzeQuality(s, files2) {
  const testRuns = [];
  const buildRuns = [];
  const gitCommits = [];
  let webLookups = 0;
  for (const c of s.toolCalls) {
    if (c.category === "web") webLookups++;
    if (c.name !== "Bash") continue;
    const cmd = cmdOf(c);
    if (!cmd) continue;
    const kind = classifyCommand(cmd);
    if (kind === "test") testRuns.push({ turnIndex: c.turnIndex, command: cmd.slice(0, 120), ok: !c.isError, agentId: c.agentId });
    else if (kind === "build") buildRuns.push({ turnIndex: c.turnIndex, command: cmd.slice(0, 120), ok: !c.isError });
    if (hasCommit(cmd)) {
      const m = /-m\s+["']([^"']{0,80})/.exec(cmd);
      gitCommits.push({ turnIndex: c.turnIndex, ok: !c.isError, message: m?.[1] });
    }
  }
  const userCorrections = s.turns.filter((t) => t.kind === "human" && CORRECTION_RE.test(t.promptPreview)).map((t) => ({ turnIndex: t.index, preview: t.promptPreview.slice(0, 100) }));
  const interruptions = s.events.filter((e) => e.kind === "interrupt").length;
  const apiErrors = s.events.filter((e) => e.kind === "api_error").length;
  const toolErrors2 = s.toolCalls.filter((c) => c.isError).length;
  const toolErrorRate = s.toolCalls.length ? round(toolErrors2 / s.toolCalls.length, 4) : 0;
  const reworkFiles = files2.files.filter((f) => f.edits >= 4).length;
  const prLinks = s.events.filter((e) => e.kind === "pr_link").map((e) => ({ label: e.label, url: e.detail, turnIndex: e.turnIndex }));
  const prCreates = s.toolCalls.filter((c) => c.name === "Bash" && hasPrCreate(cmdOf(c)) && !c.isError);
  if (!prLinks.length && prCreates.length) for (const c of prCreates) prLinks.push({ label: "gh pr create", url: void 0, turnIndex: c.turnIndex });
  const outcomes = {
    prLinks,
    gitCommits: gitCommits.filter((g) => g.ok).length,
    testRuns: testRuns.length,
    testRunsFailed: testRuns.filter((t) => !t.ok).length,
    buildRuns: buildRuns.length,
    buildRunsFailed: buildRuns.filter((b) => !b.ok).length,
    filesRead: files2.files.filter((f) => f.reads > 0).length,
    filesEdited: files2.files.filter((f) => f.edits > 0).length,
    filesWritten: files2.files.filter((f) => f.writes > 0).length,
    webLookups
  };
  const lastTest = testRuns.length ? testRuns[testRuns.length - 1] : void 0;
  const signals = [
    { id: "tests", label: "Test runs", value: testRuns.length ? `${testRuns.length} (${testRuns.filter((t) => t.ok).length} passed)` : "none", tone: !testRuns.length ? "unknown" : lastTest?.ok ? "good" : "bad", detail: lastTest ? `last run ${lastTest.ok ? "passed" : "failed"}` : "no test command detected", evidenceTurnIndexes: [...new Set(testRuns.map((t) => t.turnIndex))] },
    { id: "builds", label: "Build / typecheck / lint runs", value: buildRuns.length ? `${buildRuns.length} (${buildRuns.filter((b) => b.ok).length} ok)` : "none", tone: !buildRuns.length ? "unknown" : buildRuns[buildRuns.length - 1].ok ? "good" : "bad", evidenceTurnIndexes: [...new Set(buildRuns.map((b) => b.turnIndex))] },
    { id: "commits", label: "Git commits", value: outcomes.gitCommits, tone: outcomes.gitCommits ? "good" : "neutral", evidenceTurnIndexes: gitCommits.map((g) => g.turnIndex) },
    { id: "prs", label: "Pull requests", value: prLinks.length, tone: prLinks.length ? "good" : "neutral", evidenceTurnIndexes: prLinks.map((p) => p.turnIndex) },
    { id: "tool-error-rate", label: "Tool error rate", value: `${round(toolErrorRate * 100, 1)}%`, tone: toolErrorRate > 0.15 ? "bad" : toolErrorRate > 0.05 ? "neutral" : "good", detail: `${toolErrors2} of ${s.toolCalls.length} tool calls errored` },
    { id: "corrections", label: "User corrections", value: userCorrections.length, tone: userCorrections.length >= 3 ? "bad" : userCorrections.length ? "neutral" : "good", detail: 'prompts that read as "no / wrong / again / revert"', evidenceTurnIndexes: userCorrections.map((u) => u.turnIndex) },
    { id: "interruptions", label: "Interruptions", value: interruptions, tone: interruptions >= 3 ? "bad" : interruptions ? "neutral" : "good" },
    { id: "api-errors", label: "API errors", value: apiErrors, tone: apiErrors ? "bad" : "good" },
    { id: "rework", label: "Files edited 4+ times", value: reworkFiles, tone: reworkFiles >= 3 ? "bad" : reworkFiles ? "neutral" : "good" },
    { id: "reverts", label: "Edit-then-revert pairs", value: files2.editedThenReverted, tone: files2.editedThenReverted ? "neutral" : "good" }
  ];
  return {
    quality: { signals, testRuns, buildRuns, gitCommits, userCorrections, interruptions, apiErrors, toolErrorRate, reworkFiles },
    outcomes
  };
}

// src/analyze/context.ts
function modelInfos(s) {
  return s.meta.models.map((id) => {
    const r = resolveModel(id);
    return { id, displayName: r.displayName, family: r.family, estimatedMatch: r.estimatedMatch && !r.synthetic, contextWindow: r.contextWindow };
  });
}
function analyzeContext(s) {
  const series = [];
  const cacheMisses = [];
  let peak = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalFresh = 0;
  let totalOutput = 0;
  let cw1h = 0;
  for (const u of s.usageEvents) {
    series.push({
      messageUuid: u.messageUuid,
      turnIndex: u.turnIndex,
      agentId: u.agentId,
      ts: u.ts,
      model: u.model,
      contextSize: u.contextSize,
      input: u.usage.input,
      cacheRead: u.usage.cacheRead,
      cacheWrite: u.usage.cacheWrite,
      cacheWrite1h: u.usage.cacheWrite1h,
      output: u.usage.output
    });
    if (u.cacheMissReason && !u.hiddenIteration) {
      cacheMisses.push({ messageUuid: u.messageUuid, turnIndex: u.turnIndex, agentId: u.agentId, ts: u.ts, model: u.model, type: u.cacheMissReason.type, missedInputTokens: u.cacheMissReason.missedInputTokens });
    }
    if (!u.agentId) {
      if (u.contextSize > peak) peak = u.contextSize;
    }
    totalCacheRead += u.usage.cacheRead;
    totalCacheWrite += u.usage.cacheWrite;
    totalFresh += u.usage.input;
    totalOutput += u.usage.output;
    cw1h += u.usage.cacheWrite1h;
  }
  const main2 = series.filter((p) => !p.agentId);
  const baseline = main2[0]?.contextSize ?? 0;
  const final = main2.length ? main2[main2.length - 1].contextSize : 0;
  const promptTokens = totalCacheRead + totalCacheWrite + totalFresh;
  const cacheHitRatio = promptTokens ? round(totalCacheRead / promptTokens, 4) : 0;
  const cacheWrite1hShare = totalCacheWrite ? round(cw1h / totalCacheWrite, 4) : 0;
  const reReadMultiplier = peak ? round(totalCacheRead / peak, 2) : 0;
  let contextWindow;
  for (const m of s.meta.models) {
    const cw = resolveModel(m).contextWindow;
    if (cw && (!contextWindow || cw > contextWindow)) contextWindow = cw;
  }
  const requestsPerCompaction = [];
  if (s.compactions.length) {
    let count = 0;
    let ci = 0;
    const comps = [...s.compactions].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
    for (const p of main2) {
      while (ci < comps.length && p.ts !== void 0 && (comps[ci].ts ?? Infinity) <= p.ts) {
        requestsPerCompaction.push(count);
        count = 0;
        ci++;
      }
      count++;
    }
    requestsPerCompaction.push(count);
  }
  const compactions = s.compactions.map((c) => {
    let before;
    let after;
    for (const p of main2) {
      if (p.ts === void 0 || c.ts === void 0) continue;
      if (p.ts <= c.ts) before = p.contextSize;
      else if (after === void 0) after = p.contextSize;
    }
    return { ts: c.ts, turnIndex: c.turnIndex, trigger: c.trigger, contextBefore: c.contextBefore ?? before, contextAfter: c.contextAfter ?? after };
  });
  return { series, cacheMisses, compactions, peak, baseline, final, contextWindow, cacheHitRatio, cacheWrite1hShare, reReadMultiplier, totalCacheRead, totalCacheWrite, totalFreshInput: totalFresh, totalOutput, requestsPerCompaction };
}
function analyzeTokens(s, turnTokens) {
  const byModelMap = /* @__PURE__ */ new Map();
  const byKind = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
  const serverToolRequests = { webSearch: 0, webFetch: 0 };
  let total = emptyUsage();
  let mainTokens = 0;
  let agentTokens = 0;
  const hidden = { count: 0, tokens: 0 };
  const catTokens = /* @__PURE__ */ new Map();
  for (const u of s.usageEvents) {
    const n2 = usageTotal(u.usage);
    if (u.hiddenIteration) {
      hidden.count++;
      hidden.tokens += n2;
    }
    total = addUsage(total, u.usage);
    if (u.agentId) agentTokens += n2;
    else mainTokens += n2;
    byKind.input += u.usage.input;
    byKind.output += u.usage.output;
    byKind.cacheRead += u.usage.cacheRead;
    byKind.cacheWrite5m += u.usage.cacheWrite5m;
    byKind.cacheWrite1h += u.usage.cacheWrite1h;
    serverToolRequests.webSearch += u.usage.webSearchRequests;
    serverToolRequests.webFetch += u.usage.webFetchRequests;
    const r = resolveModel(u.model);
    const e = byModelMap.get(u.model) ?? { tokens: emptyUsage(), estimatedMatch: false, requests: 0 };
    e.estimatedMatch = e.estimatedMatch || r.estimatedMatch && !r.synthetic;
    e.tokens = addUsage(e.tokens, u.usage);
    e.requests++;
    byModelMap.set(u.model, e);
  }
  const callsByMsg = /* @__PURE__ */ new Map();
  for (const c of s.toolCalls) {
    const arr2 = callsByMsg.get(c.messageUuid) ?? [];
    arr2.push(c.category);
    callsByMsg.set(c.messageUuid, arr2);
  }
  const msgById = new Map(s.messages.map((m) => [m.uuid, m]));
  const msgsByProviderId = /* @__PURE__ */ new Map();
  for (const m of s.messages) {
    if (!m.providerMessageId) continue;
    const arr2 = msgsByProviderId.get(m.providerMessageId);
    if (arr2) arr2.push(m.uuid);
    else msgsByProviderId.set(m.providerMessageId, [m.uuid]);
  }
  for (const u of s.usageEvents) {
    const m = msgById.get(u.messageUuid);
    const pid = m?.providerMessageId;
    const cats = [];
    if (pid) for (const uuid of msgsByProviderId.get(pid) ?? []) cats.push(...callsByMsg.get(uuid) ?? []);
    const key = cats.length ? cats.length === 1 ? cats[0] : "mixed" : "no-tool (text/thinking)";
    catTokens.set(key, (catTokens.get(key) ?? 0) + usageTotal(u.usage));
  }
  let cum = 0;
  const byTurn = turnTokens.map((t) => {
    cum += t.tokens;
    return { turnIndex: t.turnIndex, tokens: t.tokens, cumulativeTokens: cum };
  });
  return {
    total,
    totalTokens: usageTotal(total),
    byModel: [...byModelMap.entries()].map(([model, e]) => ({ model, displayName: resolveModel(model).displayName, tokens: e.tokens, totalTokens: usageTotal(e.tokens), estimatedMatch: e.estimatedMatch, requests: e.requests })).sort((a, b) => b.totalTokens - a.totalTokens),
    byKind,
    mainThread: mainTokens,
    agents: agentTokens,
    byTurn,
    byToolCategory: [...catTokens.entries()].map(([category, tokens]) => ({ category, tokens })).sort((a, b) => b.tokens - a.tokens),
    serverToolRequests,
    hiddenIterations: hidden
  };
}

// src/analyze/agents.ts
function analyzeAgents(s, turnOfToolUse) {
  const tokensByAgent = /* @__PURE__ */ new Map();
  for (const u of s.usageEvents) {
    if (!u.agentId) continue;
    tokensByAgent.set(u.agentId, (tokensByAgent.get(u.agentId) ?? 0) + usageTotal(u.usage));
  }
  const runs = s.agents.map((a) => {
    const errors = s.toolCalls.filter((c) => c.agentId === a.agentId && c.isError).length;
    const own = tokensByAgent.get(a.agentId);
    return {
      agentId: a.agentId,
      name: a.name,
      agentType: a.agentType,
      description: a.description,
      model: a.model,
      spawnDepth: a.spawnDepth,
      parentAgentId: a.parentAgentId,
      spawnedByToolUseId: a.spawnedByToolUseId,
      turnIndex: a.spawnedByToolUseId ? turnOfToolUse.get(a.spawnedByToolUseId) : void 0,
      startTs: a.startTs,
      endTs: a.endTs,
      durationMs: a.durationMs,
      messageCount: a.messageCount,
      toolCallCount: a.toolCallCount,
      toolErrors: errors,
      tokens: a.usage,
      totalTokens: own ?? usageTotal(a.usage),
      reportedTotalTokens: a.reportedTotalTokens,
      reportedDurationMs: a.reportedDurationMs,
      status: a.status,
      transcriptPath: a.transcriptPath,
      teamName: a.teamName,
      taskKind: a.taskKind,
      hasTranscript: a.messageCount > 0
    };
  });
  let tokens = emptyUsage();
  let dur = 0;
  let toolCalls = 0;
  for (const r of runs) {
    tokens = addUsage(tokens, r.tokens);
    dur += r.durationMs ?? 0;
    toolCalls += r.toolCallCount;
  }
  const byTypeMap = /* @__PURE__ */ new Map();
  const byModelMap = /* @__PURE__ */ new Map();
  for (const r of runs) {
    const t = r.agentType ?? "unknown";
    const e = byTypeMap.get(t) ?? { count: 0, tokens: 0, dur: [] };
    e.count++;
    e.tokens += usageTotal(r.tokens);
    if (r.durationMs !== void 0) e.dur.push(r.durationMs);
    byTypeMap.set(t, e);
    const m = r.model ?? "unknown";
    const me = byModelMap.get(m) ?? { count: 0, tokens: 0 };
    me.count++;
    me.tokens += usageTotal(r.tokens);
    byModelMap.set(m, me);
  }
  const iv = runs.filter((r) => r.startTs !== void 0 && r.endTs !== void 0).map((r) => [r.startTs, r.endTs]);
  const evs = [];
  for (const [a, b] of iv) {
    evs.push([a, 1]);
    evs.push([b, -1]);
  }
  evs.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let cur = 0;
  let maxC = 0;
  let concurrentMs = 0;
  let lastT = 0;
  for (const [t, d] of evs) {
    if (cur > 0) concurrentMs += t - lastT;
    cur += d;
    if (cur > maxC) maxC = cur;
    lastT = t;
  }
  const mainUsage = s.turns.reduce((u, t) => addUsage(u, t.usage), emptyUsage());
  const mainTokens = usageTotal(mainUsage);
  const agentTokens = usageTotal(tokens);
  return {
    runs,
    totals: { count: runs.length, tokens, totalTokens: agentTokens, durationMs: dur, toolCalls },
    byType: [...byTypeMap.entries()].map(([agentType, e]) => ({ agentType, count: e.count, tokens: e.tokens, avgDurationMs: e.dur.length ? round(sum(e.dur) / e.dur.length, 0) : 0 })).sort((a, b) => b.tokens - a.tokens),
    byModel: [...byModelMap.entries()].map(([model, e]) => ({ model, count: e.count, tokens: e.tokens })).sort((a, b) => b.tokens - a.tokens),
    maxDepth: runs.reduce((m, r) => Math.max(m, r.spawnDepth), 0),
    concurrentMs,
    maxConcurrency: maxC,
    mainThreadShare: { tokens: mainTokens + agentTokens ? round(mainTokens / (mainTokens + agentTokens), 4) : 1 }
  };
}
function analyzeSkills(s) {
  const byName = /* @__PURE__ */ new Map();
  for (const k of s.skills) {
    const e = byName.get(k.name) ?? { count: 0, via: /* @__PURE__ */ new Set(), turnIndexes: [] };
    e.count++;
    e.via.add(k.via);
    if (!e.turnIndexes.includes(k.turnIndex)) e.turnIndexes.push(k.turnIndex);
    byName.set(k.name, e);
  }
  return {
    invocations: s.skills.map((k) => ({ name: k.name, via: k.via, turnIndex: k.turnIndex, ts: k.ts, agentId: k.agentId, args: k.args })),
    byName: [...byName.entries()].map(([name, e]) => ({ name, count: e.count, via: [...e.via], turnIndexes: e.turnIndexes })).sort((a, b) => b.count - a.count)
  };
}
function analyzeHooks(s) {
  const byCmd = /* @__PURE__ */ new Map();
  const byEvent = /* @__PURE__ */ new Map();
  let totalMs = 0;
  let errors = 0;
  for (const h of s.hooks) {
    const key = h.command ?? h.hookName ?? h.hookEvent ?? "hook";
    const e = byCmd.get(key) ?? { count: 0, totalMs: 0, errors: 0, hookEvent: h.hookEvent };
    e.count++;
    e.totalMs += h.durationMs ?? 0;
    if (!h.ok) e.errors++;
    byCmd.set(key, e);
    totalMs += h.durationMs ?? 0;
    if (!h.ok) errors++;
    const ev = h.hookEvent ?? "unknown";
    byEvent.set(ev, (byEvent.get(ev) ?? 0) + 1);
  }
  return {
    runs: s.hooks.length,
    errors,
    totalMs,
    byCommand: [...byCmd.entries()].map(([command, e]) => ({ command, ...e })).sort((a, b) => b.totalMs - a.totalMs),
    events: [...byEvent.entries()].map(([hookEvent, count]) => ({ hookEvent, count }))
  };
}
function unionMs(iv) {
  if (!iv.length) return 0;
  const sorted = [...iv].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curStart = sorted[0][0];
  let curEnd = sorted[0][1];
  for (let i = 1; i < sorted.length; i++) {
    const [a, b] = sorted[i];
    if (a <= curEnd) {
      if (b > curEnd) curEnd = b;
    } else {
      total += curEnd - curStart;
      curStart = a;
      curEnd = b;
    }
  }
  total += curEnd - curStart;
  return total;
}
function analyzeTime(s, turns, agents, hooksMs) {
  const activeMs = sum(turns.map((t) => t.durationMs ?? 0));
  const humanWaitMs = sum(turns.map((t) => t.humanGapMs ?? 0));
  const toolIv = [];
  let unanchoredToolMs = 0;
  for (const c of s.toolCalls) {
    if (c.agentId || c.name === "Agent" || c.name === "Task") continue;
    if (c.durationMs === void 0) continue;
    if (c.startTs !== void 0) toolIv.push([c.startTs, c.startTs + c.durationMs]);
    else unanchoredToolMs += c.durationMs;
  }
  const toolMs = Math.min(unionMs(toolIv) + unanchoredToolMs, activeMs);
  const agentMs = Math.min(agents.concurrentMs, activeMs);
  const modelMs = Math.max(0, activeMs - toolMs - agentMs);
  const fr = turns.map((t) => t.firstResponseMs).filter((x) => x !== void 0);
  return {
    wallMs: s.meta.wallMs,
    activeMs,
    humanWaitMs,
    toolMs,
    agentMs,
    modelMs,
    longestTurns: [...turns].sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0)).slice(0, 5).map((t) => ({ turnIndex: t.index, durationMs: t.durationMs ?? 0, preview: t.promptPreview })),
    longestGaps: [...turns].filter((t) => t.humanGapMs !== void 0).sort((a, b) => (b.humanGapMs ?? 0) - (a.humanGapMs ?? 0)).slice(0, 5).map((t) => ({ turnIndex: t.index, gapMs: t.humanGapMs ?? 0 })),
    firstResponse: { p50: percentile(fr, 50), p95: percentile(fr, 95), max: fr.length ? Math.max(...fr) : 0 },
    hooksMs
  };
}

// src/analyze/insights.ts
var BYTES_PER_TOKEN = 4;
function capSavings(ctx, tokens) {
  const cap = ctx.tokens.totalTokens * 0.6;
  return cap > 0 ? Math.min(tokens, cap) : tokens;
}
var seq = 0;
function mk(partial) {
  seq++;
  return { id: `${partial.ruleId}-${seq}`, ...partial };
}
function resetInsightIds() {
  seq = 0;
}
var rereadFiles = (ctx) => {
  const out3 = [];
  const rr = ctx.files.mostReRead.filter((f) => f.redundantReads >= 2);
  if (!rr.length) return out3;
  const top = rr.slice(0, 5);
  const wastedBytes = top.reduce((a, f) => a + f.bytesRead / Math.max(1, f.reads) * f.redundantReads, 0);
  const wastedTokens = Math.round(wastedBytes / BYTES_PER_TOKEN);
  const laterRequests = Math.max(1, ctx.context.series.filter((p) => !p.agentId).length / 2);
  const carriedTokens = capSavings(ctx, Math.round(wastedTokens + wastedTokens * laterRequests));
  const totalReReads = rr.reduce((a, f) => a + f.redundantReads, 0);
  out3.push(
    mk({
      ruleId: "reread-files",
      severity: totalReReads >= 10 ? "high" : totalReReads >= 5 ? "medium" : "low",
      axis: "tokens",
      title: `${rr.length} file${rr.length > 1 ? "s" : ""} re-read within one context (${totalReReads} redundant reads, ${fmtTokens(carriedTokens)} tokens)`,
      detail: top.map((f) => `${f.path} \xD7${f.reads} (${f.redundantReads} redundant${f.agentReads ? `, ${f.agentReads} in agents` : ""})`).join("; "),
      recommendation: "A file already in context does not need re-reading; the re-read is sent again as fresh input and then carried in every later request. Read once, keep notes, or use Grep with line ranges; for large files read only the needed offset/limit. Sub-agents cannot see the parent context, so reads inside agents are expected.",
      evidence: { files: top.map((f) => ({ path: f.path, reads: f.reads, redundantReads: f.redundantReads, bytesRead: f.bytesRead, turns: f.turnIndexes.slice(0, 20) })), wastedTokensEstimate: wastedTokens, carriedTokensEstimate: carriedTokens },
      turnIndexes: [...new Set(top.flatMap((f) => f.turnIndexes))].slice(0, 30),
      savings: { tokens: carriedTokens, estimated: true },
      personas: ["developer", "lead"]
    })
  );
  return out3;
};
var repeatedCommands = (ctx) => {
  const counts = /* @__PURE__ */ new Map();
  for (const c of ctx.s.toolCalls) {
    if (c.name !== "Bash") continue;
    const cmd = String(c.input?.["command"] ?? "").trim();
    if (!cmd || cmd.length < 6) continue;
    const e = counts.get(cmd) ?? { n: 0, turns: [], errors: 0 };
    e.n++;
    if (!e.turns.includes(c.turnIndex)) e.turns.push(c.turnIndex);
    if (c.isError) e.errors++;
    counts.set(cmd, e);
  }
  const rep = [...counts.entries()].filter(([, e]) => e.n >= 4).sort((a, b) => b[1].n - a[1].n).slice(0, 5);
  if (!rep.length) return [];
  return [
    mk({
      ruleId: "repeated-commands",
      severity: rep[0][1].n >= 8 ? "medium" : "low",
      axis: "time",
      title: `${rep.length} identical shell command${rep.length > 1 ? "s" : ""} repeated 4+ times`,
      detail: rep.map(([cmd, e]) => `"${cmd.slice(0, 60)}${cmd.length > 60 ? "\u2026" : ""}" \xD7${e.n}${e.errors ? ` (${e.errors} failed)` : ""}`).join("; "),
      recommendation: "Repeated identical commands are usually a verify loop (tests/build) or a polling loop. Verify loops are healthy when each run follows a change; polling should use a wait/monitor primitive instead of re-running. If the same command keeps failing, fix the environment once rather than retrying.",
      evidence: { commands: rep.map(([cmd, e]) => ({ command: cmd.slice(0, 200), count: e.n, errors: e.errors, turns: e.turns.slice(0, 20) })) },
      turnIndexes: [...new Set(rep.flatMap(([, e]) => e.turns))].slice(0, 30),
      personas: ["developer"]
    })
  ];
};
var toolErrors = (ctx) => {
  const out3 = [];
  const total = ctx.s.toolCalls.length;
  const errs = ctx.s.toolCalls.filter((c) => c.isError);
  if (!errs.length) return out3;
  const rate = errs.length / Math.max(1, total);
  const groups = ctx.tools.errorGroups.filter((g) => g.count >= 3).slice(0, 5);
  if (rate >= 0.1 || groups.length) {
    out3.push(
      mk({
        ruleId: "tool-errors",
        severity: rate >= 0.2 || (groups[0]?.count ?? 0) >= 6 ? "high" : rate >= 0.1 || groups.length ? "medium" : "low",
        axis: "quality",
        title: `${errs.length} tool errors (${round(rate * 100, 1)}% of ${total} calls)${groups.length ? `, ${groups.length} recurring signature${groups.length > 1 ? "s" : ""}` : ""}`,
        detail: groups.length ? groups.map((g) => `${g.name}: "${g.signature}" \xD7${g.count}`).join("; ") : `most in ${errs[0].name}`,
        recommendation: "A recurring error signature is an environment or instruction problem, not bad luck: fix the root cause once (missing dependency, wrong path, permission, flaky command) or add the correct invocation to CLAUDE.md so the agent stops rediscovering it. Each failed call still burns its output tokens plus a retry turn.",
        evidence: { errorRate: round(rate, 4), groups },
        turnIndexes: [...new Set(errs.map((c) => c.turnIndex))].slice(0, 30),
        savings: { tokens: Math.round(errs.reduce((a, c) => a + (c.resultBytes ?? 0), 0) / BYTES_PER_TOKEN), estimated: true },
        personas: ["developer", "qa"]
      })
    );
  }
  return out3;
};
var oversizedResults = (ctx) => {
  const big = ctx.s.toolCalls.filter((c) => (c.resultBytes ?? 0) >= 4e4).sort((a, b) => (b.resultBytes ?? 0) - (a.resultBytes ?? 0));
  if (!big.length) return [];
  const bytes = big.reduce((a, c) => a + (c.resultBytes ?? 0), 0);
  const tokens = Math.round(bytes / BYTES_PER_TOKEN);
  const mainBytes = big.filter((c) => !c.agentId).reduce((a, c) => a + (c.resultBytes ?? 0), 0);
  const mainTokens = Math.round(mainBytes / BYTES_PER_TOKEN);
  const laterRequests = Math.max(1, ctx.context.series.filter((p) => !p.agentId).length / 3);
  const carriedTokens = capSavings(ctx, Math.round(mainTokens + mainTokens * laterRequests));
  const top = big.slice(0, 5);
  return [
    mk({
      ruleId: "oversized-tool-results",
      severity: bytes > 4e5 ? "high" : bytes > 15e4 ? "medium" : "low",
      axis: "context",
      title: `${big.length} tool result${big.length > 1 ? "s" : ""} over 40 KB, ${fmtTokens(tokens)} tokens carried in context`,
      detail: top.map((c) => `${c.inputSummary} \u2192 ${Math.round((c.resultBytes ?? 0) / 1024)} KB${c.agentId ? " (agent)" : ""}`).join("; "),
      recommendation: "Large outputs stay in context for the rest of the session and are re-read on every request. Trim at the source: pipe through head/tail/grep, use --limit/offset on Read, ask for summaries, or run the noisy step inside a subagent whose context is discarded.",
      evidence: { calls: top.map((c) => ({ tool: c.name, summary: c.inputSummary, bytes: c.resultBytes, turnIndex: c.turnIndex, agentId: c.agentId })), totalBytes: bytes, carriedTokensEstimate: carriedTokens },
      turnIndexes: [...new Set(top.map((c) => c.turnIndex))],
      savings: { tokens: carriedTokens, estimated: true },
      personas: ["developer"]
    })
  ];
};
var sequentialReads = (ctx) => {
  const out3 = [];
  const runsPerTurn = /* @__PURE__ */ new Map();
  const byTurn = /* @__PURE__ */ new Map();
  for (const c of ctx.s.toolCalls) {
    if (c.agentId) continue;
    const arr2 = byTurn.get(c.turnIndex) ?? [];
    arr2.push(c);
    byTurn.set(c.turnIndex, arr2);
  }
  let totalRuns = 0;
  let totalCalls = 0;
  let ms2 = 0;
  for (const [ti, calls] of byTurn) {
    let run = 0;
    let runMs = 0;
    const flush = () => {
      if (run >= 4) {
        totalRuns++;
        totalCalls += run;
        ms2 += runMs;
        runsPerTurn.set(ti, (runsPerTurn.get(ti) ?? 0) + 1);
      }
      run = 0;
      runMs = 0;
    };
    for (const c of calls) {
      const isLightCall = (c.category === "read" || c.category === "search") && c.parallelGroupSize === 1;
      if (isLightCall) {
        run++;
        runMs += c.durationMs ?? 0;
      } else flush();
    }
    flush();
  }
  if (!totalRuns) return out3;
  out3.push(
    mk({
      ruleId: "sequential-reads",
      severity: totalCalls >= 20 ? "medium" : "low",
      axis: "time",
      title: `${totalCalls} read/search calls issued one-by-one in ${totalRuns} run${totalRuns > 1 ? "s" : ""} of 4+`,
      detail: `Each sequential call is a full model round-trip. Turns: ${[...runsPerTurn.keys()].slice(0, 12).join(", ")}`,
      recommendation: "Independent reads and searches can be issued in one message (parallel tool calls) or delegated to an Explore subagent that returns a summary. That removes one model round-trip per call and keeps the raw file contents out of the main context.",
      evidence: { runs: totalRuns, calls: totalCalls, turns: [...runsPerTurn.entries()] },
      turnIndexes: [...runsPerTurn.keys()].slice(0, 30),
      savings: { ms: Math.round(ms2 * 0.6), estimated: true },
      personas: ["developer"]
    })
  );
  return out3;
};
var contextPressure = (ctx) => {
  const out3 = [];
  const win = ctx.context.contextWindow;
  const peak = ctx.context.peak;
  const comps = ctx.s.compactions.length;
  if (comps) {
    out3.push(
      mk({
        ruleId: "compactions",
        severity: comps >= 3 ? "high" : comps >= 2 ? "medium" : "low",
        axis: "context",
        title: `${comps} context compaction${comps > 1 ? "s" : ""}${win ? ` (peak ${fmtTokens(peak)} of ${fmtTokens(win)})` : ""}`,
        detail: ctx.context.compactions.map((c) => `turn ${c.turnIndex}${c.contextBefore ? ` at ${fmtTokens(c.contextBefore)}` : ""}${c.contextAfter ? ` \u2192 ${fmtTokens(c.contextAfter)}` : ""}`).join("; "),
        recommendation: "Every compaction throws away working memory and the agent re-derives it (extra reads, repeated commands). Split long efforts into sessions with a written handover, keep tool outputs small, push exploration into subagents, and compact deliberately at a milestone rather than letting auto-compact hit mid-task.",
        evidence: { compactions: ctx.context.compactions, requestsPerSegment: ctx.context.requestsPerCompaction },
        turnIndexes: ctx.context.compactions.map((c) => c.turnIndex),
        personas: ["developer", "anyone"]
      })
    );
  } else if (win && peak > win * 0.7) {
    out3.push(
      mk({
        ruleId: "context-near-limit",
        severity: "medium",
        axis: "context",
        title: `Context reached ${round(peak / win * 100, 0)}% of the ${fmtTokens(win)} window`,
        detail: `peak ${fmtTokens(peak)} tokens; baseline (system prompt + tools + CLAUDE.md) ${fmtTokens(ctx.context.baseline)}`,
        recommendation: "You are close to auto-compaction. Wrap up the current milestone, write a handover note, and start a fresh session for the next chunk; or trim large tool outputs.",
        evidence: { peak, window: win, baseline: ctx.context.baseline },
        turnIndexes: [],
        personas: ["developer", "anyone"]
      })
    );
  }
  return out3;
};
var preambleWeight = (ctx) => {
  const base = ctx.context.baseline;
  const reqs = ctx.context.series.filter((p) => !p.agentId).length;
  if (base < 25e3 || reqs < 5) return [];
  const carried = base * reqs;
  return [
    mk({
      ruleId: "preamble-weight",
      severity: base > 6e4 ? "medium" : "low",
      axis: "tokens",
      title: `Every request starts from a ${fmtTokens(base)}-token baseline (system prompt, tools, CLAUDE.md, skills)`,
      detail: `${reqs} requests \xD7 ${fmtTokens(base)} \u2248 ${fmtTokens(carried)} cache-read tokens just to carry the preamble`,
      recommendation: "The baseline is small per request (it is re-read from cache, not re-sent) but it multiplies by every request. Trim CLAUDE.md to rules that bind, defer long docs to on-demand reads, prune MCP servers and skills you do not use in this repo, and check for large SessionStart hook output.",
      evidence: { baselineTokens: base, requests: reqs, carriedTokens: carried },
      turnIndexes: [0],
      savings: { tokens: Math.round(carried * 0.3), estimated: true },
      personas: ["developer", "lead"]
    })
  ];
};
var cacheHealth = (ctx) => {
  const out3 = [];
  const reqs = ctx.context.series.filter((p) => !p.agentId).length;
  if (reqs < 8) return out3;
  const ratio = ctx.context.cacheHitRatio;
  if (ratio < 0.6) {
    out3.push(
      mk({
        ruleId: "low-cache-hit",
        severity: ratio < 0.4 ? "high" : "medium",
        axis: "tokens",
        title: `Prompt cache hit ratio is ${round(ratio * 100, 0)}%`,
        detail: `${fmtTokens(ctx.context.totalCacheRead)} read from cache vs ${fmtTokens(ctx.context.totalCacheWrite)} written and ${fmtTokens(ctx.context.totalFreshInput)} fresh input`,
        recommendation: "A low ratio means the prompt prefix keeps changing, or requests are spaced beyond the cache TTL (5 min by default, 1 h when enabled), so the context is re-written instead of re-read. Avoid editing the system prompt/CLAUDE.md mid-session, keep working steadily during a task, and expect low ratios in short sessions.",
        evidence: { cacheHitRatio: ratio, totalCacheRead: ctx.context.totalCacheRead, totalCacheWrite: ctx.context.totalCacheWrite, freshInput: ctx.context.totalFreshInput },
        turnIndexes: [],
        personas: ["developer", "lead"]
      })
    );
  }
  return out3;
};
var humanWait = (ctx) => {
  const wall = ctx.time.wallMs ?? 0;
  if (wall < 10 * 6e4) return [];
  const share = ctx.time.humanWaitMs / wall;
  if (share < 0.5) return [];
  return [
    mk({
      ruleId: "human-wait-dominates",
      severity: "info",
      axis: "time",
      title: `${round(share * 100, 0)}% of the ${fmtMs(wall)} wall time was waiting for the human`,
      detail: `assistant active ${fmtMs(ctx.time.activeMs)}; longest gap ${fmtMs(ctx.time.longestGaps[0]?.gapMs ?? 0)} before turn ${ctx.time.longestGaps[0]?.turnIndex ?? "-"}`,
      recommendation: "Not a problem by itself; it means the agent was mostly idle. If you want more throughput, batch requests, run background agents, or hand the agent a longer autonomous brief with clear stop conditions.",
      evidence: { wallMs: wall, activeMs: ctx.time.activeMs, humanWaitMs: ctx.time.humanWaitMs },
      turnIndexes: ctx.time.longestGaps.map((g) => g.turnIndex),
      personas: ["anyone", "lead"]
    })
  ];
};
var agentEconomics = (ctx) => {
  const out3 = [];
  const a = ctx.agents;
  if (!a.runs.length) return out3;
  const share = ctx.tokens.totalTokens ? a.totals.totalTokens / ctx.tokens.totalTokens : 0;
  const idle = a.runs.filter((r) => r.hasTranscript && r.toolCallCount === 0 && r.messageCount <= 2);
  const noTranscript = a.runs.filter((r) => !r.hasTranscript).length;
  out3.push(
    mk({
      ruleId: "agent-fanout",
      severity: "info",
      axis: "tokens",
      title: `${a.runs.length} subagent run${a.runs.length > 1 ? "s" : ""} = ${round(share * 100, 0)}% of the session's tokens (${fmtTokens(a.totals.totalTokens)}), max ${a.maxConcurrency} in parallel`,
      detail: a.byType.slice(0, 5).map((t) => `${t.agentType} \xD7${t.count} ${fmtTokens(t.tokens)}`).join("; ") + (noTranscript ? `; ${noTranscript} run${noTranscript > 1 ? "s" : ""} without a local transcript (usage from parent summary only)` : ""),
      recommendation: "Subagents keep exploration out of your main context and can run in parallel; they are worth it when the returned summary is much smaller than what they read. Watch for agents that re-read what the parent already knew, and for agents whose brief makes them read far more than they report back.",
      evidence: { byType: a.byType, byModel: a.byModel, concurrentMs: a.concurrentMs, maxConcurrency: a.maxConcurrency },
      turnIndexes: [...new Set(a.runs.map((r) => r.turnIndex).filter((x) => x !== void 0))].slice(0, 30),
      personas: ["developer", "lead"]
    })
  );
  if (idle.length) {
    out3.push(
      mk({
        ruleId: "idle-agents",
        severity: "low",
        axis: "tokens",
        title: `${idle.length} subagent${idle.length > 1 ? "s" : ""} did no tool calls`,
        detail: idle.slice(0, 5).map((r) => r.agentType ?? r.name ?? r.agentId).join(", "),
        recommendation: "An agent that only answers from its prompt could have been a plain model call in the main thread; or its brief was too thin to act on. Give agents concrete files/commands to act on.",
        evidence: { agents: idle.map((r) => ({ agentId: r.agentId, type: r.agentType, tokens: r.tokens })) },
        turnIndexes: [],
        personas: ["developer"]
      })
    );
  }
  return out3;
};
var hooksOverhead = (ctx) => {
  const h = ctx.hooks;
  const out3 = [];
  if (h.errors) {
    out3.push(
      mk({
        ruleId: "hook-errors",
        severity: h.errors >= 5 ? "medium" : "low",
        axis: "quality",
        title: `${h.errors} hook error${h.errors > 1 ? "s" : ""}`,
        detail: h.byCommand.filter((c) => c.errors).slice(0, 5).map((c) => `${c.command.slice(0, 50)} \xD7${c.errors}`).join("; "),
        recommendation: "Failing hooks add noise to every turn and can block continuation. Fix or remove them in settings.json.",
        evidence: { byCommand: h.byCommand.filter((c) => c.errors) },
        turnIndexes: [],
        personas: ["developer"]
      })
    );
  }
  if (h.totalMs > 6e4 || ctx.time.activeMs && h.totalMs > ctx.time.activeMs * 0.05) {
    out3.push(
      mk({
        ruleId: "hook-latency",
        severity: "low",
        axis: "time",
        title: `Hooks consumed ${fmtMs(h.totalMs)} across ${h.runs} runs`,
        detail: h.byCommand.slice(0, 5).map((c) => `${c.command.slice(0, 50)} ${fmtMs(c.totalMs)}`).join("; "),
        recommendation: "Slow Stop/PostToolUse hooks run on every turn. Make them async (background &), cache their work, or scope them to the events that need them.",
        evidence: { totalMs: h.totalMs, byCommand: h.byCommand.slice(0, 5) },
        turnIndexes: [],
        savings: { ms: Math.round(h.totalMs * 0.8), estimated: true },
        personas: ["developer"]
      })
    );
  }
  return out3;
};
var interruptionsAndErrors = (ctx) => {
  const out3 = [];
  const q = ctx.quality;
  if (q.interruptions >= 2) {
    out3.push(
      mk({
        ruleId: "interruptions",
        severity: q.interruptions >= 4 ? "medium" : "low",
        axis: "quality",
        title: `${q.interruptions} interruptions by the user`,
        detail: "the agent was stopped mid-turn; work in flight was discarded",
        recommendation: "Frequent interruptions usually mean the brief was under-specified or the agent went off-plan. Ask for a short plan first, or set explicit stop conditions.",
        evidence: { interruptions: q.interruptions },
        turnIndexes: ctx.s.events.filter((e) => e.kind === "interrupt").map((e) => e.turnIndex),
        personas: ["anyone"]
      })
    );
  }
  if (q.userCorrections.length >= 2) {
    out3.push(
      mk({
        ruleId: "user-corrections",
        severity: q.userCorrections.length >= 4 ? "high" : "medium",
        axis: "quality",
        title: `${q.userCorrections.length} correction prompts ("no / wrong / again / revert")`,
        detail: q.userCorrections.slice(0, 4).map((c) => `turn ${c.turnIndex}: ${c.preview.slice(0, 60)}`).join("; "),
        recommendation: "Each correction is a wasted round trip and a signal the instructions or the agent's verification loop are weak. Add the missed rule to CLAUDE.md, require the agent to run the check before claiming done, or use a reviewer subagent.",
        evidence: { corrections: q.userCorrections },
        turnIndexes: q.userCorrections.map((c) => c.turnIndex),
        personas: ["anyone", "lead"]
      })
    );
  }
  if (q.apiErrors) {
    out3.push(
      mk({
        ruleId: "api-errors",
        severity: q.apiErrors >= 5 ? "medium" : "low",
        axis: "time",
        title: `${q.apiErrors} API error${q.apiErrors > 1 ? "s" : ""} / retries`,
        detail: ctx.s.events.filter((e) => e.kind === "api_error").slice(0, 3).map((e) => `${e.label}${e.detail ? ": " + e.detail.slice(0, 60) : ""}`).join("; "),
        recommendation: "Rate limits and overloads are outside your control; a model fallback silently changes which model answered for the rest of the turn. Check the model column in the timeline.",
        evidence: { apiErrors: q.apiErrors },
        turnIndexes: ctx.s.events.filter((e) => e.kind === "api_error").map((e) => e.turnIndex),
        personas: ["developer"]
      })
    );
  }
  const fb = ctx.s.events.filter((e) => e.kind === "model_fallback");
  if (fb.length) {
    out3.push(
      mk({
        ruleId: "model-fallback",
        severity: "medium",
        axis: "quality",
        title: `Model fell back ${fb.length} time${fb.length > 1 ? "s" : ""}`,
        detail: [...new Set(fb.map((e) => e.label))].join("; "),
        recommendation: "A fallback means the model you chose was unavailable; the replacement may behave differently. Re-run quality-critical steps on the intended model when it is back.",
        evidence: { events: fb },
        turnIndexes: fb.map((e) => e.turnIndex),
        personas: ["developer", "lead"]
      })
    );
  }
  return out3;
};
var outputHeavyWrites = (ctx) => {
  let bytes = 0;
  const big = [];
  for (const c of ctx.s.toolCalls) {
    if (c.category !== "write" && c.category !== "edit") continue;
    bytes += c.inputBytes;
    if (c.inputBytes >= 2e4) big.push({ summary: c.inputSummary, bytes: c.inputBytes, turnIndex: c.turnIndex });
  }
  if (!big.length) return [];
  const tokens = Math.round(big.reduce((a, b) => a + b.bytes, 0) / BYTES_PER_TOKEN);
  return [
    mk({
      ruleId: "large-writes",
      /* savings capped below */
      severity: tokens > 4e4 ? "medium" : "low",
      axis: "tokens",
      title: `${big.length} large Write/Edit call${big.length > 1 ? "s" : ""} generated ${fmtTokens(tokens)} output tokens`,
      detail: big.slice(0, 5).map((b) => `${b.summary} ${Math.round(b.bytes / 1024)} KB`).join("; "),
      recommendation: "Every byte of a generated file is an output token the model had to produce, and output is the slowest thing it does. Prefer targeted Edits over rewriting whole files, generate boilerplate with a script or template, and never paste large data through the model.",
      evidence: { calls: big.slice(0, 10), totalWriteBytes: bytes, outputTokensEstimate: tokens },
      turnIndexes: [...new Set(big.map((b) => b.turnIndex))],
      savings: { tokens: Math.round(capSavings(ctx, tokens * 0.5)), estimated: true },
      personas: ["developer"]
    })
  ];
};
var slowFirstResponse = (ctx) => {
  const p95 = ctx.time.firstResponse.p95;
  if (!p95 || p95 < 3e4 || ctx.turns.length < 5) return [];
  return [
    mk({
      ruleId: "slow-first-response",
      severity: "low",
      axis: "time",
      title: `p95 time-to-first-response is ${fmtMs(p95)}`,
      detail: `p50 ${fmtMs(ctx.time.firstResponse.p50)}, max ${fmtMs(ctx.time.firstResponse.max)}; large contexts and long thinking both add latency before the first token`,
      recommendation: "Latency grows with context size and effort level. Keep the context lean, lower effort for mechanical steps, and use a faster model for trivial turns.",
      evidence: ctx.time.firstResponse,
      turnIndexes: [],
      personas: ["developer"]
    })
  ];
};
var unresolvedTools = (ctx) => {
  const un = ctx.s.toolCalls.filter((c) => c.unresolved);
  if (!un.length || ctx.s.meta.possiblyLive) return [];
  return [
    mk({
      ruleId: "unresolved-tool-calls",
      severity: "low",
      axis: "quality",
      title: `${un.length} tool call${un.length > 1 ? "s" : ""} never received a result`,
      detail: un.slice(0, 5).map((c) => c.inputSummary).join("; "),
      recommendation: "Usually an interruption or a crash mid-tool. If it recurs with the same tool, look for a hanging command (missing timeout, interactive prompt).",
      evidence: { calls: un.slice(0, 10).map((c) => ({ tool: c.name, summary: c.inputSummary, turnIndex: c.turnIndex })) },
      turnIndexes: [...new Set(un.map((c) => c.turnIndex))],
      personas: ["developer"]
    })
  ];
};
var unverifiedEdits = (ctx) => {
  const q = ctx.quality;
  if (ctx.s.meta.possiblyLive) return [];
  const edited = ctx.files.files.filter((f) => f.edits > 0);
  const mainTests = q.testRuns.filter((t) => !t.agentId);
  const lastTest = mainTests.length ? mainTests[mainTests.length - 1] : void 0;
  if (lastTest && !lastTest.ok) {
    return [
      mk({
        ruleId: "unverified-edits",
        severity: "high",
        axis: "quality",
        title: "The last test run failed and the session ended",
        detail: `"${lastTest.command}" (turn ${lastTest.turnIndex}) was the final main-thread test run; ${mainTests.filter((t) => t.ok).length} of ${mainTests.length} main-thread test runs passed; ${edited.length} file${edited.length === 1 ? "" : "s"} edited`,
        recommendation: 'The session closed on a red test, so whatever was delivered is unverified. Re-open, make the suite green (or record why the failure is expected), and make "tests pass" an explicit stop condition in the brief.',
        evidence: { lastTest, testRuns: mainTests.length, testRunsFailed: mainTests.filter((t) => !t.ok).length, filesEdited: edited.length },
        turnIndexes: [lastTest.turnIndex],
        personas: ["qa", "developer", "pm"]
      })
    ];
  }
  if (edited.length && !q.testRuns.length && !q.buildRuns.length) {
    const top = edited.slice(0, 5);
    return [
      mk({
        ruleId: "unverified-edits",
        severity: "medium",
        axis: "quality",
        title: `${edited.length} file${edited.length === 1 ? "" : "s"} edited but no test or build ran`,
        detail: top.map((f) => `${f.path} (${f.edits} edit${f.edits === 1 ? "" : "s"})`).join("; "),
        recommendation: "Edits that were never exercised by a test, build or typecheck are unverified. Ask the agent to run the project's check after editing (and put that command in CLAUDE.md so it does not have to rediscover it).",
        evidence: { filesEdited: edited.length, files: top.map((f) => ({ path: f.path, edits: f.edits })), testRuns: 0, buildRuns: 0 },
        turnIndexes: [...new Set(top.flatMap((f) => f.turnIndexes))].slice(0, 30),
        personas: ["qa", "developer", "pm"]
      })
    ];
  }
  return [];
};
var editChurn = (ctx) => {
  const TEN_MIN = 10 * 6e4;
  const MIN_ANCHOR = 24;
  const history = /* @__PURE__ */ new Map();
  const quick = /* @__PURE__ */ new Map();
  const edits = /* @__PURE__ */ new Map();
  for (const c of ctx.s.toolCalls) {
    if (c.category !== "edit") continue;
    const i = c.input;
    const p = typeof i?.["file_path"] === "string" ? i["file_path"] : typeof i?.["notebook_path"] === "string" ? i["notebook_path"] : void 0;
    if (!p || p.endsWith(".md")) continue;
    const path = shortPath(p, ctx.s.meta.cwd);
    const key = (c.agentId ?? "main") + "\0" + path;
    const e = edits.get(key) ?? { path, edits: 0, turnIndexes: [] };
    e.edits++;
    if (!e.turnIndexes.includes(c.turnIndex)) e.turnIndexes.push(c.turnIndex);
    edits.set(key, e);
    const oldStr = String(i?.["old_string"] ?? "");
    const newStr = String(i?.["new_string"] ?? "");
    const h = history.get(key) ?? [];
    if (oldStr.length >= MIN_ANCHOR) {
      for (const prev of h) {
        if (prev.ts !== void 0 && c.startTs !== void 0 && c.startTs - prev.ts <= TEN_MIN && prev.newString.includes(oldStr)) {
          quick.set(key, (quick.get(key) ?? 0) + 1);
          break;
        }
      }
    }
    h.push({ newString: newStr, ts: c.startTs });
    if (h.length > 20) h.shift();
    history.set(key, h);
  }
  const pathOfKey = (key) => key.slice(key.indexOf("\0") + 1);
  const quickByPath = /* @__PURE__ */ new Map();
  for (const [key, n2] of quick) {
    const path = pathOfKey(key);
    quickByPath.set(path, Math.max(quickByPath.get(path) ?? 0, n2));
  }
  const churned = [...edits.values()].filter((e) => e.edits >= 6).sort((a, b) => b.edits - a.edits);
  const thrashed = [...quick.entries()].filter(([, n2]) => n2 >= 3).map(([key, n2]) => [pathOfKey(key), n2]);
  if (!churned.length && !thrashed.length) return [];
  const top = churned.slice(0, 5);
  return [
    mk({
      ruleId: "edit-churn",
      severity: thrashed.length ? "medium" : "low",
      axis: "quality",
      title: churned.length ? `${churned.length} file${churned.length === 1 ? "" : "s"} edited 6+ times by one context${thrashed.length ? `, ${thrashed.length} re-edited within 10 min` : ""}` : `${thrashed.length} file${thrashed.length === 1 ? "" : "s"} re-edited 3+ times within 10 minutes`,
      detail: (top.length ? top : thrashed.map(([path, n2]) => ({ path, edits: n2, turnIndexes: [] }))).map((f) => `${f.path} \xD7${f.edits} edit${f.edits === 1 ? "" : "s"}${quickByPath.get(f.path) ? ` (${quickByPath.get(f.path)} quick re-edit${quickByPath.get(f.path) === 1 ? "" : "s"})` : ""}`).join("; "),
      recommendation: "Repeated edits to the same file, especially re-touching lines written minutes earlier, mean the change was designed while typing. Plan the change first (or ask for a short plan), then write the whole block once; churn burns output tokens and review attention. (Edits are counted per context: many agents each touching a file once is fan-out, not churn; .md living documents are not counted.)",
      evidence: { files: top.map((f) => ({ path: f.path, edits: f.edits, quickReEdits: quickByPath.get(f.path) ?? 0 })), thrashedFiles: thrashed.map(([path, n2]) => ({ path, quickReEdits: n2 })) },
      turnIndexes: [...new Set(top.flatMap((f) => f.turnIndexes))].slice(0, 30),
      personas: ["developer", "qa"]
    })
  ];
};
var WORKTREE_PATH_RE = /\/\.?worktrees?\/|\/worktree-/;
function revertHits(cmd, opts) {
  const hits = [];
  for (const seg of cmd.split(/&&|\|\||[;\n]/)) {
    const w = seg.trim().split(/\s+/).filter(Boolean);
    const base = (w[0] ?? "").split("/").pop();
    if (base !== "git") continue;
    const sub = w[1];
    const isBaseRef = (x) => x === "main" || x === "master" || x?.startsWith("origin/") === true;
    if (sub === "revert") hits.push({ kind: "revert" });
    else if (sub === "restore") {
      if (!w.includes("--staged")) hits.push({ kind: "restore" });
    } else if (sub === "reset" && w.includes("--hard")) {
      const target = w.slice(2).find((x) => !x.startsWith("-"));
      if (!(isBaseRef(target) && (opts.worktreeCtx || opts.earlyTurn))) hits.push({ kind: "reset-hard" });
    } else if (sub === "checkout") {
      const dd = w.indexOf("--");
      if (dd === -1) continue;
      const ref = w.slice(2, dd).find((x) => !x.startsWith("-"));
      if (ref !== void 0 && !/^HEAD(~\d*|\^+)?$/.test(ref)) continue;
      hits.push({ kind: "checkout", pathspec: w.slice(dd + 1).join(" ") || void 0 });
    } else if (sub === "stash" && (w[2] === void 0 || w[2] === "push")) {
      if (opts.sawEdit && !opts.worktreeCtx) hits.push({ kind: "stash" });
    }
  }
  return hits;
}
function hasStashReapply(cmd) {
  return cmd.split(/&&|\|\||[;\n]/).some((seg) => {
    const w = seg.trim().split(/\s+/).filter(Boolean);
    const base = (w[0] ?? "").split("/").pop();
    return base === "git" && w[1] === "stash" && (w[2] === "pop" || w[2] === "apply");
  });
}
var reverts = (ctx) => {
  const pairs = ctx.files.editedThenReverted;
  const failedTestTurns = new Set(ctx.quality.testRuns.filter((t) => !t.ok).map((t) => t.turnIndex));
  const worktreeCwd = WORKTREE_PATH_RE.test(ctx.s.meta.cwd ?? "");
  const seenFailedTest = /* @__PURE__ */ new Set();
  const candidates = [];
  let sawEdit = false;
  let stashReapplied = false;
  const checkoutPathspecCount = /* @__PURE__ */ new Map();
  for (const c of ctx.s.toolCalls) {
    if (c.category === "edit" || c.category === "write") sawEdit = true;
    if (c.name !== "Bash") continue;
    const cmd = String(c.input?.["command"] ?? "");
    if (!cmd) continue;
    if (hasStashReapply(cmd)) stashReapplied = true;
    const hits = revertHits(cmd, { worktreeCtx: worktreeCwd || WORKTREE_PATH_RE.test(cmd), earlyTurn: c.turnIndex < 3, sawEdit });
    if (hits.length) {
      candidates.push({ command: cmd.slice(0, 120), turnIndex: c.turnIndex, afterFailedTest: seenFailedTest.has(c.turnIndex), hits });
      for (const h of hits) if (h.kind === "checkout" && h.pathspec) checkoutPathspecCount.set(h.pathspec, (checkoutPathspecCount.get(h.pathspec) ?? 0) + 1);
    }
    if (c.isError && failedTestTurns.has(c.turnIndex)) seenFailedTest.add(c.turnIndex);
  }
  const revertCalls = candidates.filter(
    (r) => r.hits.some((h) => {
      if (h.kind === "stash" && stashReapplied) return false;
      if (h.kind === "checkout" && h.pathspec && (checkoutPathspecCount.get(h.pathspec) ?? 0) >= 3) return false;
      return true;
    })
  );
  const afterFail = revertCalls.filter((r) => r.afterFailedTest);
  if (pairs * 2 + revertCalls.length < 2 && !afterFail.length) return [];
  return [
    mk({
      ruleId: "reverts",
      severity: afterFail.length ? "medium" : "low",
      axis: "quality",
      title: `${pairs + revertCalls.length} revert${pairs + revertCalls.length === 1 ? "" : "s"} (${pairs} edit-then-revert pair${pairs === 1 ? "" : "s"}, ${revertCalls.length} git revert-like command${revertCalls.length === 1 ? "" : "s"})${afterFail.length ? " after a failed test" : ""}`,
      detail: revertCalls.slice(0, 5).map((r) => `turn ${r.turnIndex}: "${r.command.slice(0, 60)}"${r.afterFailedTest ? " (after a failed test)" : ""}`).join("; ") || "an Edit restored the exact string a previous Edit replaced",
      recommendation: "Reverted work is done twice: once to write it, once to undo it. A revert right after a failed test means the change shipped before it was checked. Have the agent run the test before committing to an approach, or try it in a worktree/branch it can throw away. (Not counted here, as setup or protocol rather than undo: git restore --staged; stashes before anything was edited, in a worktree context, or later popped/applied; checkout -- from a named branch ref (content transplant); the same pathspec checkout-restored 3+ times (regenerated-file ritual); and git reset --hard main/origin/* in a worktree or the session\u2019s opening turns.)",
      evidence: { editedThenReverted: pairs, revertCommands: revertCalls.slice(0, 10).map((r) => ({ command: r.command, turnIndex: r.turnIndex, afterFailedTest: r.afterFailedTest })), afterFailedTest: afterFail.length },
      turnIndexes: [...new Set(revertCalls.map((r) => r.turnIndex))].slice(0, 30),
      personas: ["qa", "developer"]
    })
  ];
};
var cacheDominatesTokens = (ctx) => {
  const k = ctx.tokens.byKind;
  const total = ctx.tokens.totalTokens;
  const peak = ctx.context.peak;
  if (!total || !peak) return [];
  const carried = ctx.context.reReadMultiplier;
  if (carried < 100) return [];
  const cacheTokens = k.cacheRead + k.cacheWrite5m + k.cacheWrite1h;
  const share = cacheTokens / total;
  return [
    mk({
      ruleId: "cache-dominates-tokens",
      severity: total >= 75e7 ? "high" : "info",
      axis: "tokens",
      title: `The context was carried through the model ${round(carried, 0)}\xD7: ${fmtTokens(total)} tokens, ${round(share * 100, 0)}% of them context re-read or re-written`,
      detail: `cache read ${fmtTokens(k.cacheRead)} + cache write ${fmtTokens(k.cacheWrite5m + k.cacheWrite1h)} against a ${fmtTokens(peak)}-token peak; output is only ${round(k.output / total * 100, 1)}% of the total, because every call re-reads the whole context before it writes a single token`,
      recommendation: "Each API call re-reads the whole context, so context size, not output, is where your tokens go. Fewer, larger steps (batch tool calls), subagents with a fresh small context for scans, and a deliberate /compact when the work changes shape are the levers.",
      evidence: { byKind: k, reReadMultiplier: carried, cacheShare: round(share, 4), outputShare: round(k.output / total, 4), peakContext: peak, totalTokens: total },
      turnIndexes: [],
      personas: ["developer", "pm", "anyone"]
    })
  ];
};
var slowTools = (ctx) => {
  const slow = ctx.tools.byName.filter((t) => t.category !== "agent" && t.category !== "task" && t.count >= 5 && t.p95Ms > 3e4).sort((a, b) => b.p95Ms - a.p95Ms);
  if (!slow.length) return [];
  const top = slow[0];
  return [
    mk({
      ruleId: "slow-tool",
      severity: "low",
      axis: "time",
      title: `${top.name} is slow: p95 ${fmtMs(top.p95Ms)} over ${top.count} calls`,
      detail: slow.slice(0, 3).map((t) => `${t.name}: p95 ${fmtMs(t.p95Ms)}, max ${fmtMs(t.maxMs)}, ${fmtMs(t.totalMs)} total across ${t.count} calls`).join("; "),
      recommendation: "A consistently slow tool stalls every turn that touches it. Time the command outside the session, cache or pre-build what it recomputes, narrow its scope, or run it in the background and poll instead of blocking the turn.",
      evidence: { tools: slow.slice(0, 5).map((t) => ({ name: t.name, count: t.count, p95Ms: t.p95Ms, maxMs: t.maxMs, totalMs: t.totalMs })) },
      turnIndexes: [],
      personas: ["developer"]
    })
  ];
};
var agentHealth = (ctx) => {
  const out3 = [];
  const hardFailed = ctx.agents.runs.filter((r) => r.status !== void 0 && /error|fail/i.test(r.status));
  const killed = ctx.agents.runs.filter((r) => r.status === "killed");
  const failed = [...hardFailed, ...killed];
  if (failed.length) {
    out3.push(
      mk({
        ruleId: "failed-agents",
        severity: hardFailed.length >= 2 ? "medium" : "low",
        axis: "quality",
        title: `${failed.length} subagent run${failed.length === 1 ? "" : "s"} did not finish (${killed.length ? `${killed.length} killed` : ""}${killed.length && hardFailed.length ? ", " : ""}${hardFailed.length ? `${hardFailed.length} errored` : ""})`,
        detail: failed.slice(0, 5).map((r) => `${r.agentType ?? r.name ?? r.agentId} (${r.status}${r.toolErrors ? `, ${r.toolErrors} tool errors` : ""}) ${fmtTokens(r.totalTokens)}`).join("; "),
        recommendation: "An agent that was killed or errored spends its tokens without a usable result, and the parent usually redoes the work inline. Read the agent's last output, tighten its brief (concrete files, commands, stop conditions), and surface the failure reason instead of retrying blind. A deliberate kill of a stale background agent is fine. This is a pointer, not an alarm.",
        evidence: { failed: failed.slice(0, 10).map((r) => ({ agentId: r.agentId, agentType: r.agentType, name: r.name, status: r.status, toolErrors: r.toolErrors, tokens: r.totalTokens })) },
        turnIndexes: [...new Set(failed.map((r) => r.turnIndex).filter((x) => x !== void 0))].slice(0, 30),
        personas: ["developer", "qa"]
      })
    );
  }
  if (ctx.agents.maxDepth >= 3) {
    out3.push(
      mk({
        ruleId: "deep-fanout",
        severity: "info",
        axis: "tokens",
        title: `Agents spawned agents ${ctx.agents.maxDepth} levels deep`,
        detail: `${ctx.agents.runs.length} run${ctx.agents.runs.length === 1 ? "" : "s"}, max depth ${ctx.agents.maxDepth}, max ${ctx.agents.maxConcurrency} concurrent`,
        recommendation: "Deep agent trees multiply context baselines and make failures hard to attribute. Prefer a flat fan-out from the main thread with a tight brief per agent; reserve depth for genuinely recursive work.",
        evidence: { maxDepth: ctx.agents.maxDepth, runs: ctx.agents.runs.length, maxConcurrency: ctx.agents.maxConcurrency },
        turnIndexes: [],
        personas: ["developer", "lead"]
      })
    );
  }
  return out3;
};
var skillTokenWeight = (ctx) => {
  if (!ctx.s.skills.length) return [];
  const humanTurnTokens = ctx.turns.filter((t) => t.kind === "human").map((t) => t.totalTokens).sort((a, b) => a - b);
  if (humanTurnTokens.length < 3) return [];
  const mid = humanTurnTokens.length % 2 ? humanTurnTokens[(humanTurnTokens.length - 1) / 2] : (humanTurnTokens[humanTurnTokens.length / 2 - 1] + humanTurnTokens[humanTurnTokens.length / 2]) / 2;
  if (mid <= 0) return [];
  const norm2 = (name) => name.split(":").pop() ?? name;
  const counts = /* @__PURE__ */ new Map();
  for (const k of ctx.s.skills) counts.set(norm2(k.name), (counts.get(norm2(k.name)) ?? 0) + 1);
  const tokensBySkill = /* @__PURE__ */ new Map();
  for (const u of ctx.s.usageEvents) {
    const name = u.attribution?.skill;
    if (!name) continue;
    tokensBySkill.set(norm2(name), (tokensBySkill.get(norm2(name)) ?? 0) + usageTotal(u.usage));
  }
  const heavy = [];
  for (const [name, tokens] of tokensBySkill) {
    const invocations = Math.max(1, counts.get(name) ?? 1);
    const per = tokens / invocations;
    if (per > 2 * mid) heavy.push({ name, invocations, tokens, perInvocationTokens: Math.round(per) });
  }
  if (!heavy.length) return [];
  heavy.sort((a, b) => b.perInvocationTokens - a.perInvocationTokens);
  const top = heavy[0];
  return [
    mk({
      ruleId: "skill-token-weight",
      severity: "low",
      axis: "tokens",
      title: `Skill ${top.name} moves ${fmtTokens(top.perInvocationTokens)} tokens per invocation, over 2\xD7 the median turn (${fmtTokens(Math.round(mid))})`,
      detail: heavy.slice(0, 5).map((c) => `${c.name}: ${fmtTokens(c.tokens)} over ${c.invocations} invocation${c.invocations === 1 ? "" : "s"} (${fmtTokens(c.perInvocationTokens)} each)`).join("; "),
      recommendation: "A heavy skill usually means its body (and the files it loads) bloats the context for every step it runs. Trim the skill's instructions, defer its reference docs to on-demand reads, or give it a smaller model / lower effort in its frontmatter.",
      evidence: { skills: heavy.slice(0, 10), medianHumanTurnTokens: Math.round(mid) },
      turnIndexes: [],
      personas: ["developer", "lead"]
    })
  ];
};
var timeBudget = (ctx) => {
  const active = ctx.time.activeMs;
  if (active < 6e4) return [];
  const parts = [
    { key: "tool execution", ms: ctx.time.toolMs },
    { key: "subagents", ms: ctx.time.agentMs }
  ].map((p) => ({ ...p, share: Math.min(1, p.ms / active) })).filter((p) => p.share >= 0.75);
  if (!parts.length) return [];
  const dominant = parts.sort((a, b) => b.share - a.share)[0];
  const rec = dominant.key === "tool execution" ? "Tool execution dominates the active time: the model is mostly waiting on commands. Look at the slowest tools (timeouts, caching, narrower scope) or run long commands in the background." : "Subagent wall time dominates: spawn agents in parallel or async so the parent keeps working, and tighten agent briefs so they finish sooner.";
  return [
    mk({
      ruleId: "time-budget",
      severity: "info",
      axis: "time",
      title: `${round(dominant.share * 100, 0)}% of the ${fmtMs(active)} active time went to ${dominant.key}`,
      detail: `tools ${fmtMs(ctx.time.toolMs)} \xB7 subagents ${fmtMs(ctx.time.agentMs)} \xB7 model ${fmtMs(ctx.time.modelMs)} \xB7 active ${fmtMs(active)}`,
      recommendation: rec,
      evidence: { activeMs: active, toolMs: ctx.time.toolMs, agentMs: ctx.time.agentMs, modelMs: ctx.time.modelMs, dominant: dominant.key },
      turnIndexes: [],
      personas: ["pm", "developer", "anyone"]
    })
  ];
};
var ACTIONABLE_MISS = /* @__PURE__ */ new Set(["tools_changed", "model_changed", "system_changed", "messages_changed"]);
var cacheInvalidation = (ctx) => {
  const misses = ctx.context.cacheMisses;
  if (!misses.length) return [];
  const tokenEvents = misses.filter((e) => (e.missedInputTokens ?? 0) > 0);
  const actionable = misses.filter((e) => ACTIONABLE_MISS.has(e.type));
  if (!tokenEvents.length && !actionable.length) return [];
  const byType = /* @__PURE__ */ new Map();
  for (const e of misses) {
    const g = byType.get(e.type) ?? { events: 0, missedTokens: 0 };
    g.events++;
    g.missedTokens += e.missedInputTokens ?? 0;
    byType.set(e.type, g);
  }
  const missedTotal = tokenEvents.reduce((a, e) => a + (e.missedInputTokens ?? 0), 0);
  const maxMissed = tokenEvents.reduce((a, e) => Math.max(a, e.missedInputTokens ?? 0), 0);
  const countable = (/* @__PURE__ */ new Set([...tokenEvents, ...actionable])).size;
  const severity = maxMissed > 3e5 || countable > 3 && missedTotal >= 5e4 ? "high" : maxMissed >= 5e4 || countable > 3 ? "medium" : "low";
  return [
    mk({
      ruleId: "cache-invalidation",
      severity,
      axis: "tokens",
      title: `${misses.length} cache invalidation event${misses.length === 1 ? "" : "s"} re-wrote ${fmtTokens(missedTotal)} tokens into the cache`,
      detail: [...byType.entries()].sort((a, b) => b[1].missedTokens - a[1].missedTokens).map(([t, g]) => `${t} \xD7${g.events}${g.missedTokens ? ` (${fmtTokens(g.missedTokens)} tokens)` : ""}`).join("; "),
      recommendation: "Switching models (/model) or loading new tools mid-session invalidates the prompt cache: the whole context has to be written again instead of read back, and a re-write is slower than a cache hit. Load MCP tools at the start, avoid model switches inside a long session, or start a fresh session for a different model. `unavailable` and `previous_message_not_found` misses are on the provider side. There is nothing to change.",
      evidence: {
        byType: [...byType.entries()].map(([type, g]) => ({ type, events: g.events, missedTokens: g.missedTokens })),
        events: misses.slice(0, 10).map((e) => ({ turnIndex: e.turnIndex, type: e.type, missedInputTokens: e.missedInputTokens, model: e.model, agentId: e.agentId })),
        missedTokensTotal: missedTotal
      },
      turnIndexes: [...new Set(misses.map((e) => e.turnIndex))].slice(0, 30),
      personas: ["developer", "lead"]
    })
  ];
};
var cacheTtlChurn = (ctx) => {
  const k = ctx.tokens.byKind;
  const writes = k.cacheWrite5m + k.cacheWrite1h;
  if (writes < 1e5) return [];
  const share = k.cacheWrite1h / writes;
  if (share <= 0.75) return [];
  const gaps = ctx.s.turns.map((t) => t.humanGapMs).filter((x) => x !== void 0).sort((a, b) => a - b);
  const medianGap = gaps.length ? gaps.length % 2 ? gaps[(gaps.length - 1) / 2] : (gaps[gaps.length / 2 - 1] + gaps[gaps.length / 2]) / 2 : void 0;
  const quickCadence = gaps.length >= 3 && medianGap !== void 0 && medianGap < 5 * 6e4;
  return [
    mk({
      ruleId: "cache-ttl-churn",
      severity: quickCadence ? "medium" : "info",
      axis: "tokens",
      title: `${round(share * 100, 0)}% of the ${fmtTokens(writes)} tokens written to cache went to the 1-hour tier`,
      detail: `${fmtTokens(k.cacheWrite1h)} on the 1h tier vs ${fmtTokens(k.cacheWrite5m)} on the 5m tier${medianGap !== void 0 ? `; median gap between turns ${fmtMs(medianGap)}` : ""}`,
      recommendation: "Claude Code can hold your context in the cache for 5 minutes or for 1 hour. Both write the same tokens, so this changes nothing about your usage. But when your turns come faster than every 5 minutes, the short tier keeps the cache just as warm. Nothing to change in the transcript; this is a harness setting worth knowing about.",
      evidence: { cacheWrite1hTokens: k.cacheWrite1h, cacheWrite5mTokens: k.cacheWrite5m, cacheWrites: writes, cacheWrite1hShareOfWrites: round(share, 4), medianTurnGapMs: medianGap, quickCadence },
      turnIndexes: [],
      personas: ["lead", "pm", "developer"]
    })
  ];
};
var blockingQuestions = (ctx) => {
  const FIVE_MIN = 5 * 6e4;
  const asks = ctx.s.toolCalls.filter((c) => c.name === "AskUserQuestion" && (c.durationMs ?? 0) > FIVE_MIN);
  if (!asks.length) return [];
  const overlapsAgent = (a) => ctx.s.agents.some((r) => r.startTs !== void 0 && r.endTs !== void 0 && a.startTs !== void 0 && a.endTs !== void 0 && r.startTs < a.endTs && r.endTs > a.startTs);
  let severity = "low";
  for (const a of asks) {
    const ms2 = a.durationMs ?? 0;
    if (ms2 > 2 * 36e5 && !overlapsAgent(a)) severity = "high";
    else if (ms2 > 30 * 6e4 && severity !== "high") severity = "medium";
  }
  const totalMs = asks.reduce((a, c) => a + (c.durationMs ?? 0), 0);
  const longest = asks.reduce((a, b) => (b.durationMs ?? 0) > (a.durationMs ?? 0) ? b : a);
  return [
    mk({
      ruleId: "blocking-questions",
      severity,
      axis: "time",
      title: `${asks.length} question${asks.length === 1 ? "" : "s"} to the human blocked the run for ${fmtMs(totalMs)} (longest ${fmtMs(longest.durationMs ?? 0)})`,
      detail: asks.slice(0, 5).map((c) => `turn ${c.turnIndex}: ${fmtMs(c.durationMs ?? 0)}${overlapsAgent(c) ? " (subagents kept working)" : ""}`).join("; "),
      recommendation: "A blocking question stops the whole run until someone answers. Front-load the decisions into the brief, give the agent a default (\u201Cif unsure, do X\u201D), or have it park the question and continue on independent work.",
      evidence: { asks: asks.slice(0, 10).map((c) => ({ turnIndex: c.turnIndex, durationMs: c.durationMs, backgroundWork: overlapsAgent(c) })), totalBlockedMs: totalMs },
      turnIndexes: [...new Set(asks.map((c) => c.turnIndex))].slice(0, 30),
      savings: { ms: totalMs, estimated: true },
      personas: ["pm", "developer", "anyone"]
    })
  ];
};
var truncatedReadsRule = (ctx) => {
  const trunc = ctx.s.toolCalls.filter((c) => c.truncated);
  if (!trunc.length) return [];
  const byFile = /* @__PURE__ */ new Map();
  for (const c of trunc) {
    const i = c.input;
    const raw = typeof i?.["file_path"] === "string" ? i["file_path"] : c.inputSummary;
    const path = shortPath(raw, ctx.s.meta.cwd);
    const e = byFile.get(path) ?? { count: 0, turnIndexes: [] };
    e.count++;
    if (!e.turnIndexes.includes(c.turnIndex)) e.turnIndexes.push(c.turnIndex);
    byFile.set(path, e);
  }
  const repeat = [...byFile.entries()].filter(([, e]) => e.count >= 2);
  return [
    mk({
      ruleId: "truncated-reads",
      severity: repeat.length ? "medium" : "low",
      axis: "context",
      title: `${trunc.length} Read result${trunc.length === 1 ? "" : "s"} hit the token cap${repeat.length ? `; ${repeat.length} file${repeat.length === 1 ? "" : "s"} capped twice` : ""}`,
      detail: [...byFile.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 5).map(([p, e]) => `${p} \xD7${e.count}`).join("; "),
      recommendation: "A capped Read spent its tokens and still did not deliver the whole file; re-reading the same file capped again doubles that. Use offset/limit or grep to fetch the slice you need.",
      evidence: { files: [...byFile.entries()].slice(0, 10).map(([path, e]) => ({ path, count: e.count })), truncationNotices: ctx.s.meta.truncatedReads },
      turnIndexes: [...new Set(trunc.map((c) => c.turnIndex))].slice(0, 30),
      personas: ["developer"]
    })
  ];
};
var hiddenIterationsRule = (ctx) => {
  const hidden = ctx.s.usageEvents.filter((u) => u.hiddenIteration);
  if (!hidden.length) return [];
  const fallbacks = hidden.filter((u) => u.hiddenIteration.type === "fallback_message");
  const sessionScoped = ctx.s.messages.some((m) => m.systemSubtype === "model_refusal_fallback");
  const severity = sessionScoped ? "high" : fallbacks.length ? "medium" : "info";
  const tokens = hidden.reduce((a, u) => a + usageTotal(u.usage), 0);
  return [
    mk({
      ruleId: "hidden-iterations",
      severity,
      axis: "tokens",
      title: `${hidden.length} hidden iteration${hidden.length === 1 ? "" : "s"} used ${fmtTokens(tokens)} tokens you never saw as a message${sessionScoped ? ": a refusal switched the model for the rest of the session" : ""}`,
      detail: hidden.slice(0, 5).map((u) => `turn ${u.turnIndex}: ${u.hiddenIteration.type ?? "iteration"} on ${u.model}`).join("; "),
      recommendation: sessionScoped ? "A safety classifier declined one request and Claude Code fell back to another model for the rest of the session. That is not the model you chose, and not necessarily the same quality. If you wanted the original model, start a new session." : "These attempts used tokens but never appeared as messages (a refused or retried first try). Nothing to fix per event; recurring fallbacks are worth a look at the model column in the timeline.",
      evidence: { count: hidden.length, tokens, fallbackMessages: fallbacks.length, sessionScopedFallback: sessionScoped, rollup: ctx.tokens.hiddenIterations },
      turnIndexes: [...new Set(hidden.map((u) => u.turnIndex))].slice(0, 30),
      personas: ["developer", "pm"]
    })
  ];
};
var binaryAttachments = (ctx) => {
  const big = [];
  for (const m of ctx.s.messages) {
    for (const b of m.blocks) {
      if ((b.kind === "image" || b.kind === "document") && b.bytes > 5e5) big.push({ kind: b.kind, bytes: b.bytes, turnIndex: m.turnIndex });
    }
  }
  if (!big.length) return [];
  const bytes = big.reduce((a, b) => a + b.bytes, 0);
  const tokens = Math.round(bytes / BYTES_PER_TOKEN);
  return [
    mk({
      ruleId: "binary-attachments",
      severity: "medium",
      axis: "context",
      title: `${big.length} binary attachment${big.length === 1 ? "" : "s"} over 500 KB in the transcript (${Math.round(bytes / 1024)} KB total)`,
      detail: big.slice(0, 5).map((b) => `${b.kind} ${Math.round(b.bytes / 1024)} KB at turn ${b.turnIndex}`).join("; "),
      recommendation: "A pasted PDF/image is re-sent with every call. Convert it to text (or extract the pages you need) before pasting, and keep large binaries out of the conversation.",
      evidence: { blocks: big.slice(0, 10), totalBytes: bytes, estimatedTokens: tokens },
      turnIndexes: [...new Set(big.map((b) => b.turnIndex))].slice(0, 30),
      savings: { tokens, estimated: true },
      personas: ["developer", "anyone"]
    })
  ];
};
var queuedPrompts = (ctx) => {
  const q = ctx.s.meta.queueOperations;
  const enqueued = q?.["enqueue"] ?? 0;
  const human = ctx.s.meta.enqueueKinds?.human ?? enqueued;
  const notification = ctx.s.meta.enqueueKinds?.notification ?? 0;
  const away = ctx.s.events.filter((e) => e.kind === "away_summary").length;
  if (human < 20) return [];
  return [
    mk({
      ruleId: "queued-prompts",
      severity: "info",
      axis: "time",
      title: `${human} prompt${human === 1 ? "" : "s"} queued while the agent worked${away ? `; ${away} away summar${away === 1 ? "y" : "ies"}` : ""}`,
      detail: `queue operations: ${Object.entries(q ?? {}).map(([op, n2]) => `${op} \xD7${n2}`).join(", ") || "none"}${notification ? `; ${notification} machine notification${notification === 1 ? "" : "s"} (task/system) not counted as prompts` : ""}`,
      recommendation: "Queueing prompts keeps the agent busy instead of idle between your visits. This is the session working well, not a problem. Away summaries mean Claude Code caught you up after time away.",
      evidence: { queueOperations: q ?? {}, humanEnqueues: human, notificationEnqueues: notification, awaySummaries: away },
      turnIndexes: [],
      personas: ["pm", "anyone"]
    })
  ];
};
var MECHANICAL_TOOLS = /* @__PURE__ */ new Set(["TaskUpdate", "TaskCreate", "Read", "Glob", "Grep", "ToolSearch", "ListAgents"]);
var READONLY_BASH_RE = /^\s*(ls|cat|head|tail|wc|grep|rg|find|pwd|echo)\b|^\s*git\s+(status|log|diff|show|branch)\b|^\s*gh\s+(pr|run)\s+(view|list)\b/;
var thinkingOnMechanical = (ctx) => {
  const usesByProviderMsg = /* @__PURE__ */ new Map();
  const msgByUuid = new Map(ctx.s.messages.map((m) => [m.uuid, m]));
  for (const m of ctx.s.messages) {
    if (m.role !== "assistant" || !m.providerMessageId) continue;
    for (const b of m.blocks) {
      if (b.kind !== "tool_use") continue;
      const arr2 = usesByProviderMsg.get(m.providerMessageId) ?? [];
      arr2.push({ name: b.name, input: b.input });
      usesByProviderMsg.set(m.providerMessageId, arr2);
    }
  }
  const hits = [];
  let totalThinking = 0;
  for (const u of ctx.s.usageEvents) {
    if (u.hiddenIteration) continue;
    totalThinking += u.thinkingTokens ?? 0;
    if ((u.thinkingTokens ?? 0) <= 2e3) continue;
    const m = msgByUuid.get(u.messageUuid);
    const uses = m?.providerMessageId ? usesByProviderMsg.get(m.providerMessageId) ?? [] : [];
    if (uses.length !== 1) continue;
    const t = uses[0];
    const cmd = String(t.input?.["command"] ?? "");
    const mechanical = MECHANICAL_TOOLS.has(t.name) || t.name === "Bash" && READONLY_BASH_RE.test(cmd);
    if (mechanical) hits.push({ turnIndex: u.turnIndex, tool: t.name, thinkingTokens: u.thinkingTokens ?? 0 });
  }
  if (!hits.length) return [];
  const wasted = hits.reduce((a, h) => a + h.thinkingTokens, 0);
  return [
    mk({
      ruleId: "thinking-on-mechanical",
      severity: "low",
      axis: "tokens",
      title: `${hits.length} mechanical single-tool call${hits.length === 1 ? "" : "s"} spent over 2k thinking tokens each (${fmtTokens(wasted)} total)`,
      detail: hits.slice(0, 5).map((h) => `turn ${h.turnIndex}: ${h.tool} with ${fmtTokens(h.thinkingTokens)} thinking tokens`).join("; "),
      recommendation: "Thinking tokens are output tokens: the model generates them one at a time, so they add latency as well as volume, and a routine Read or status check rarely needs them. Lower the effort for mechanical steps (/effort medium, or effort in an agent\u2019s frontmatter); keep high effort for the hard ones, where thinking is the point.",
      evidence: { calls: hits.slice(0, 10), wastedThinkingTokens: wasted, sessionThinkingTokens: totalThinking },
      turnIndexes: [...new Set(hits.map((h) => h.turnIndex))].slice(0, 30),
      savings: { tokens: Math.round(capSavings(ctx, wasted)), estimated: true },
      personas: ["developer"]
    })
  ];
};
var outputBurst = (ctx) => {
  const EDIT_TOOLS = /* @__PURE__ */ new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
  const bursts = ctx.s.usageEvents.filter((u) => !u.hiddenIteration && u.usage.output > 8e3);
  if (bursts.length < 10) return [];
  const msgByUuid = new Map(ctx.s.messages.map((m) => [m.uuid, m]));
  const editToolByProviderMsg = /* @__PURE__ */ new Map();
  for (const m of ctx.s.messages) {
    if (m.role !== "assistant" || !m.providerMessageId) continue;
    for (const b of m.blocks) if (b.kind === "tool_use" && EDIT_TOOLS.has(b.name)) editToolByProviderMsg.set(m.providerMessageId, b.name);
  }
  const rows = bursts.map((u) => {
    const pid = msgByUuid.get(u.messageUuid)?.providerMessageId;
    return { turnIndex: u.turnIndex, outputTokens: u.usage.output, model: u.model, writeTool: pid ? editToolByProviderMsg.get(pid) : void 0, agentId: u.agentId };
  });
  const scripted = rows.filter((r) => r.writeTool);
  return [
    mk({
      ruleId: "output-burst",
      severity: scripted.length >= 3 ? "low" : "info",
      axis: "tokens",
      title: `${bursts.length} message${bursts.length === 1 ? "" : "s"} wrote over 8k output tokens${scripted.length ? ` (${scripted.length} generating file content)` : ""}`,
      detail: rows.sort((a, b) => b.outputTokens - a.outputTokens).slice(0, 5).map((r) => `turn ${r.turnIndex}: ${fmtTokens(r.outputTokens)} tokens${r.writeTool ? ` (${r.writeTool})` : ""}`).join("; "),
      recommendation: "Output is the one kind of token the model has to produce one at a time, so a burst is also the slowest part of a turn. A burst that is mostly generated file content (a big Write/Edit) can often come from a script or template instead; a burst of prose or plan text is usually the work itself.",
      evidence: { bursts: rows.slice(0, 10), writeBursts: scripted.length },
      turnIndexes: [...new Set(rows.map((r) => r.turnIndex))].slice(0, 30),
      personas: ["developer", "lead"]
    })
  ];
};
var mcpDefinitionWeight = (ctx) => {
  const TOKENS_PER_LISTED_TOOL = 25;
  const roster = (ctx.s.meta.deferredToolNames ?? []).filter((n2) => n2.startsWith("mcp__"));
  if (!roster.length) return [];
  const called = /* @__PURE__ */ new Map();
  for (const c of ctx.s.toolCalls) {
    if (!c.name.startsWith("mcp__")) continue;
    const server = c.name.split("__")[1] ?? c.name;
    called.set(server, (called.get(server) ?? 0) + 1);
  }
  const listed = /* @__PURE__ */ new Map();
  for (const n2 of roster) {
    const server = n2.split("__")[1] ?? n2;
    listed.set(server, (listed.get(server) ?? 0) + 1);
  }
  const idle = [...listed.entries()].filter(([server, n2]) => n2 >= 5 && !(called.get(server) ?? 0)).sort((a, b) => b[1] - a[1]);
  if (!idle.length) return [];
  const idleTools = idle.reduce((a, [, n2]) => a + n2, 0);
  const mainRequests = ctx.context.series.filter((p) => !p.agentId).length;
  const estTokens = idleTools * TOKENS_PER_LISTED_TOOL * mainRequests;
  if (estTokens < 5e5) return [];
  return [
    mk({
      ruleId: "mcp-definition-weight",
      severity: "info",
      axis: "context",
      title: `${idle.length} MCP server${idle.length === 1 ? "" : "s"} listed ${idleTools} tools that were never called (\u2248 ${fmtTokens(estTokens)} tokens carried, estimated)`,
      detail: idle.slice(0, 5).map(([server, n2]) => `${server}: ${n2} tools, 0 calls`).join("; "),
      recommendation: "Every connected MCP server puts its tool listing into the session, and loading its schemas adds more on top. Disable servers you do not use in this repo (project .mcp.json / settings), or keep them deferred and unloaded.",
      evidence: { servers: idle.map(([server, tools]) => ({ server, tools, calls: 0 })), listedMcpTools: roster.length, mainRequests, estimatedCarriedTokens: estTokens, estimatedTokensPerRequest: idleTools * TOKENS_PER_LISTED_TOOL, estimated: true },
      turnIndexes: [],
      personas: ["developer", "lead"]
    })
  ];
};
var scriptCandidate = (ctx) => {
  const ctxTurn = (r) => `${r.agentId ?? ""}|${r.turnIndex}`;
  const turnOf = (k) => Number(k.slice(k.lastIndexOf("|") + 1));
  const templates = /* @__PURE__ */ new Map();
  for (const c of ctx.s.toolCalls) {
    if (c.name !== "Bash") continue;
    const cmd = String(c.input?.["command"] ?? "").trim();
    if (!cmd || cmd.length < 6) continue;
    const t = bashTemplate(cmd);
    const e = templates.get(t) ?? { count: 0, raws: /* @__PURE__ */ new Set(), turns: /* @__PURE__ */ new Set(), sample: cmd };
    e.count++;
    if (e.raws.size < 12) e.raws.add(cmd);
    e.turns.add(ctxTurn(c));
    templates.set(t, e);
  }
  const tpl = [...templates.entries()].filter(([, e]) => e.count >= 5 && e.raws.size >= 2).sort((a, b) => b[1].count - a[1].count).slice(0, 3);
  const byCtxKey = /* @__PURE__ */ new Map();
  for (const c of ctx.s.toolCalls) {
    const k = c.agentId ?? "";
    const arr2 = byCtxKey.get(k);
    if (arr2) arr2.push(c);
    else byCtxKey.set(k, [c]);
  }
  const gramBest = /* @__PURE__ */ new Map();
  for (const calls of byCtxKey.values()) {
    const syms = calls.map((c) => c.name);
    for (const h of repeatedNgrams(syms, 3, 4)) {
      if (new Set(h.gram).size < 2) continue;
      const cats = h.gram.map((_, j) => calls[h.starts[0] + j].category);
      if (cats.some((cat) => cat === "agent" || cat === "ask" || cat === "plan")) continue;
      if (cats.every((cat) => cat === "read" || cat === "search" || cat === "task")) continue;
      const key = h.gram.join("\u2192");
      const prev = gramBest.get(key);
      if (prev && prev.count >= h.count) continue;
      const turns = /* @__PURE__ */ new Set();
      for (const start of h.starts) for (let j = 0; j < h.gram.length; j++) turns.add(ctxTurn(calls[start + j]));
      gramBest.set(key, { gram: key, count: h.count, turns });
    }
  }
  const grams = [...gramBest.values()].sort((a, b) => b.count - a.count || (a.gram < b.gram ? -1 : 1)).slice(0, 3);
  const topCount = Math.max(tpl[0]?.[1].count ?? 0, grams[0]?.count ?? 0);
  if (topCount < 15) return [];
  const tokensInTurns = (turns) => {
    let inTok = 0;
    let outTok = 0;
    for (const u of ctx.s.usageEvents) {
      if (u.hiddenIteration || !turns.has(ctxTurn(u))) continue;
      inTok += u.usage.input;
      outTok += u.usage.output;
    }
    return { inTok, outTok };
  };
  let saveIn = 0;
  let saveOut = 0;
  const unionTurns = /* @__PURE__ */ new Set();
  const items = [
    ...tpl.map(([, e]) => ({ turns: e.turns, n: e.count })),
    ...grams.map((g) => ({ turns: g.turns, n: g.count }))
  ];
  for (const it of items) {
    const { inTok, outTok } = tokensInTurns(it.turns);
    const f = (it.n - 1) / it.n;
    saveIn += inTok * f;
    saveOut += outTok * f;
    for (const t of it.turns) unionTurns.add(t);
  }
  const union = tokensInTurns(unionTurns);
  saveIn = Math.min(saveIn, union.inTok);
  saveOut = Math.min(saveOut, union.outTok);
  const tokens = Math.round(capSavings(ctx, saveIn + saveOut));
  const parts = [];
  if (tpl.length) parts.push(`${tpl.length} Bash template${tpl.length > 1 ? "s" : ""} \xD7${tpl[0][1].count}`);
  if (grams.length) parts.push(`${grams.length} tool sequence${grams.length > 1 ? "s" : ""} \xD7${grams[0].count}`);
  return [
    mk({
      ruleId: "script-candidate",
      severity: topCount >= 30 ? "medium" : "low",
      axis: "tokens",
      title: `Scriptable repetition: ${parts.join(", ")}; a script could run the batch in one turn`,
      detail: [
        ...tpl.map(([t, e]) => `"${t.slice(0, 80)}${t.length > 80 ? "\u2026" : ""}" \xD7${e.count} (${e.raws.size >= 12 ? "12+" : e.raws.size} variants)`),
        ...grams.map((g) => `${g.gram} \xD7${g.count}`)
      ].join("; "),
      recommendation: "The same command shape or tool sequence executed n times is a script waiting to be written: generate it once (a loop over the varying path/number), run it as one Bash call, and spend one model turn instead of n. The agent can write the script itself, so ask for it.",
      evidence: {
        templates: tpl.map(([t, e]) => ({ template: t, count: e.count, distinctCommands: e.raws.size, sample: e.sample.slice(0, 160), turns: [...new Set([...e.turns].map(turnOf))].slice(0, 20) })),
        sequences: grams.map((g) => ({ gram: g.gram, count: g.count, turns: [...new Set([...g.turns].map(turnOf))].slice(0, 20) })),
        estimatedRepeatedTokens: tokens
      },
      turnIndexes: [...new Set([...unionTurns].map(turnOf))].slice(0, 30),
      savings: { tokens, estimated: true },
      personas: ["developer"]
    })
  ];
};
var AGENT_SPAWN_TOOLS = /* @__PURE__ */ new Set(["Agent", "Task"]);
var fanoutOpportunity = (ctx) => {
  const norm2 = (s) => s.replace(/\s+/g, " ").trim();
  const runBySpawn = /* @__PURE__ */ new Map();
  for (const r of ctx.s.agents) if (r.spawnedByToolUseId) runBySpawn.set(r.spawnedByToolUseId, r);
  const timing = (c) => {
    const run = runBySpawn.get(c.toolUseId);
    if (!run) return { startTs: c.startTs, endTs: c.endTs, durationMs: c.durationMs };
    return { startTs: run.startTs ?? c.startTs, endTs: run.endTs ?? c.endTs, durationMs: run.durationMs ?? run.reportedDurationMs ?? c.durationMs };
  };
  const dependsOn = (later, earlier) => {
    const spawned = earlier.call.spawnedAgentId;
    if (spawned && later.prompt.includes(spawned)) return true;
    const nm = String(earlier.call.input?.["name"] ?? "");
    if (nm.length >= 4 && later.prompt.includes(nm)) return true;
    if (earlier.preview.length >= 16) {
      for (let i = 0; i + 16 <= earlier.preview.length; i++) if (later.prompt.includes(earlier.preview.slice(i, i + 16))) return true;
    }
    return false;
  };
  const byTurn = /* @__PURE__ */ new Map();
  for (const c of ctx.s.toolCalls) {
    if (c.agentId || !AGENT_SPAWN_TOOLS.has(c.name)) continue;
    const arr2 = byTurn.get(c.turnIndex);
    if (arr2) arr2.push(c);
    else byTurn.set(c.turnIndex, [c]);
  }
  const runs = [];
  for (const calls of byTurn.values()) {
    let run = [];
    const flush = () => {
      if (run.length >= 3) runs.push(run);
      run = [];
    };
    for (const c of calls) {
      if (c.parallelGroupSize !== 1 || c.unresolved) {
        flush();
        continue;
      }
      const input = c.input;
      const item = { call: c, prompt: norm2(String(input?.["prompt"] ?? "")), preview: norm2(String(c.resultPreview ?? "")), ...timing(c) };
      const prev = run[run.length - 1];
      const overlapsPrev = !!prev && prev.endTs !== void 0 && item.startTs !== void 0 && item.startTs < prev.endTs;
      if (overlapsPrev || run.some((e) => dependsOn(item, e))) flush();
      run.push(item);
    }
    flush();
  }
  if (!runs.length) return [];
  let serialMs = 0;
  let parallelMs = 0;
  const agentsInRuns = runs.reduce((a, r) => a + r.length, 0);
  const measured = runs.map((r) => {
    const durs = r.map((e) => e.durationMs ?? 0);
    const total = durs.reduce((a, d) => a + d, 0);
    const max = Math.max(...durs);
    serialMs += total;
    parallelMs += max;
    return {
      turnIndex: r[0].call.turnIndex,
      agents: r.map((e) => ({ type: String(e.call.input?.["subagent_type"] ?? ""), promptChars: e.prompt.length, durationMs: e.durationMs })),
      serialMs: total,
      longestMs: max
    };
  });
  const evRuns = measured.slice(0, 5);
  const savedMs = Math.max(0, serialMs - parallelMs);
  return [
    mk({
      ruleId: "fanout-opportunity",
      severity: "low",
      axis: "time",
      title: `${agentsInRuns} subagents ran one-after-another in ${runs.length} run${runs.length > 1 ? "s" : ""} with no visible dependency; a parallel fan-out would cut the wait`,
      detail: evRuns.map((r) => `turn ${r.turnIndex}: ${r.agents.length} serial spawns (${r.agents.map((a) => a.type || "agent").join(", ")}), ${fmtMs(r.serialMs)} serial vs ${fmtMs(r.longestMs)} longest`).join("; "),
      recommendation: "Independent subagents can be spawned in one message (parallel tool calls) or with run_in_background. The wall-clock time becomes the longest run instead of the sum. Keep serial spawning for agents that consume an earlier agent\u2019s result.",
      evidence: {
        runs: evRuns,
        heuristic: "independence = no 16-char overlap between a later prompt and an earlier result preview (~200 chars), and no reference to an earlier agent id/name; stripped results (no preview) are treated as independent; ids/lengths only, never full-content matching. Timing is the spawned agent run (start, end, duration), falling back to the spawn call span when no run is linked"
      },
      turnIndexes: [...new Set(runs.map((r) => r[0].call.turnIndex))].slice(0, 30),
      savings: { ms: savedMs, estimated: true },
      personas: ["developer", "lead"]
    })
  ];
};
var modelForTask = (ctx) => {
  if (!ctx.s.agents.length) return [];
  const typeById = new Map(ctx.s.agents.map((a) => [a.agentId, a.agentType ?? "unknown"]));
  const msgByUuid = new Map(ctx.s.messages.map((m) => [m.uuid, m]));
  const toolUsesByPid = /* @__PURE__ */ new Map();
  for (const m of ctx.s.messages) {
    if (m.role !== "assistant" || !m.providerMessageId) continue;
    let n2 = 0;
    for (const b of m.blocks) if (b.kind === "tool_use") n2++;
    if (n2) toolUsesByPid.set(m.providerMessageId, (toolUsesByPid.get(m.providerMessageId) ?? 0) + n2);
  }
  const groups = /* @__PURE__ */ new Map();
  for (const u of ctx.s.usageEvents) {
    if (!u.agentId || u.hiddenIteration) continue;
    const r = resolveModel(u.model);
    if (r.family === "haiku" || r.family === "none" || r.synthetic) continue;
    const agentType = typeById.get(u.agentId) ?? "unknown";
    const key = agentType + "|" + u.model;
    const g = groups.get(key) ?? { agentType, model: u.model, requests: 0, mech: 0, mechTokens: 0 };
    g.requests++;
    const pid = msgByUuid.get(u.messageUuid)?.providerMessageId;
    const tools = pid ? toolUsesByPid.get(pid) ?? 0 : 0;
    if (tools === 1 && u.usage.output < 200 && (u.thinkingTokens ?? 0) === 0) {
      g.mech++;
      g.mechTokens += usageTotal(u.usage);
    }
    groups.set(key, g);
  }
  const qual = [...groups.values()].filter((g) => g.mech >= 10 && g.mech / g.requests >= 0.6).sort((a, b) => b.mechTokens - a.mechTokens || a.agentType.localeCompare(b.agentType));
  if (!qual.length) return [];
  const top = qual[0];
  return [
    mk({
      ruleId: "model-for-task",
      severity: "info",
      axis: "tokens",
      title: `Agent type '${top.agentType}' is ${round(top.mech / top.requests * 100, 0)}% mechanical on ${resolveModel(top.model).displayName} (${fmtTokens(top.mechTokens)} tokens in those requests)`,
      detail: qual.slice(0, 5).map((g) => `${g.agentType} on ${resolveModel(g.model).displayName}: ${g.mech}/${g.requests} mechanical requests, ${fmtTokens(g.mechTokens)} tokens`).join("; "),
      recommendation: "A mostly-mechanical agent type (single tool call, tiny output, no thinking) does not need the frontier model: set model: haiku in that agent\u2019s frontmatter or the Agent call. It will send the same tokens either way. What you get back is a faster turn and the big model left free for the judgment-heavy agents.",
      evidence: {
        agentTypes: qual.slice(0, 5).map((g) => ({
          agentType: g.agentType,
          model: g.model,
          requests: g.requests,
          mechanicalRequests: g.mech,
          mechanicalShare: round(g.mech / g.requests, 3),
          mechanicalTokens: g.mechTokens
        })),
        criteria: "mechanical = exactly 1 tool_use, < 200 output tokens, no reported thinking; grouped per agent type \xD7 model; fires at >= 10 mechanical and >= 60% share on a non-haiku model"
      },
      turnIndexes: [],
      personas: ["lead", "developer"]
    })
  ];
};
var writeNotEdit = (ctx) => {
  const lastRead = /* @__PURE__ */ new Map();
  const rewrites = [];
  for (const c of ctx.s.toolCalls) {
    const input = c.input;
    const path = typeof input?.["file_path"] === "string" ? input["file_path"] : void 0;
    if (!path) continue;
    const key = (c.agentId ?? "") + "|" + path;
    if (c.name === "Read") {
      if (!c.isError && (c.resultBytes ?? 0) >= 1e3) lastRead.set(key, c.resultBytes);
      else lastRead.delete(key);
      continue;
    }
    if (c.name !== "Write" || c.isError) continue;
    const content = input?.["content"];
    if (typeof content !== "string") continue;
    const rb = lastRead.get(key);
    if (rb === void 0) continue;
    if (content.length >= rb * 0.7 && content.length <= rb * 1.3) rewrites.push({ path, turnIndex: c.turnIndex, readBytes: rb, writtenChars: content.length });
  }
  if (rewrites.length < 2) return [];
  const tokens = Math.round(rewrites.reduce((a, r) => a + r.writtenChars, 0) / BYTES_PER_TOKEN * 0.6);
  const saved = Math.round(capSavings(ctx, tokens));
  return [
    mk({
      ruleId: "write-not-edit",
      severity: "low",
      axis: "tokens",
      title: `${rewrites.length} Write call${rewrites.length > 1 ? "s" : ""} rewrote a file already read, at roughly the same length`,
      detail: rewrites.slice(0, 5).map((r) => `${shortPath(r.path)}: read ${Math.round(r.readBytes / 1024)} KB \u2192 wrote ${Math.round(r.writtenChars / 1024)} KB (turn ${r.turnIndex})`).join("; "),
      recommendation: "Edit beats Write for modifications: Write re-emits the whole file as output tokens, which the model has to generate one at a time, while Edit sends only the changed hunk. Reserve Write for new files and genuine full rewrites.",
      evidence: { rewrites: rewrites.slice(0, 10), tolerance: "written length within \xB130% of the last read length, reads >= 1 KB, same context (main thread or the same agent)" },
      turnIndexes: [...new Set(rewrites.map((r) => r.turnIndex))].slice(0, 30),
      savings: { tokens: saved, estimated: true },
      personas: ["developer"]
    })
  ];
};
var RULES = [
  rereadFiles,
  repeatedCommands,
  toolErrors,
  oversizedResults,
  sequentialReads,
  contextPressure,
  preambleWeight,
  cacheHealth,
  humanWait,
  agentEconomics,
  hooksOverhead,
  interruptionsAndErrors,
  outputHeavyWrites,
  slowFirstResponse,
  unresolvedTools,
  unverifiedEdits,
  editChurn,
  reverts,
  cacheDominatesTokens,
  slowTools,
  agentHealth,
  skillTokenWeight,
  timeBudget,
  cacheInvalidation,
  cacheTtlChurn,
  blockingQuestions,
  truncatedReadsRule,
  hiddenIterationsRule,
  binaryAttachments,
  queuedPrompts,
  thinkingOnMechanical,
  outputBurst,
  mcpDefinitionWeight,
  scriptCandidate,
  fanoutOpportunity,
  modelForTask,
  writeNotEdit
];
var SEV_ORDER = { high: 3, medium: 2, low: 1, info: 0 };
function runRules(ctx, rules = RULES) {
  resetInsightIds();
  const out3 = [];
  for (const r of rules) {
    try {
      out3.push(...r(ctx));
    } catch {
    }
  }
  out3.sort((a, b) => (SEV_ORDER[b.severity] ?? 0) - (SEV_ORDER[a.severity] ?? 0) || (b.savings?.tokens ?? 0) - (a.savings?.tokens ?? 0));
  return out3;
}

// src/analyze/analyze.ts
function analyzeSession(s, opts = {}) {
  const now = opts.now ?? Date.now();
  const version = opts.version ?? "0.0.0";
  const toolsByTurn = /* @__PURE__ */ new Map();
  const turnOfToolUse = /* @__PURE__ */ new Map();
  for (const c of s.toolCalls) {
    turnOfToolUse.set(c.toolUseId, c.turnIndex);
    if (c.agentId) continue;
    const arr2 = toolsByTurn.get(c.turnIndex) ?? [];
    arr2.push(c);
    toolsByTurn.set(c.turnIndex, arr2);
  }
  const ctxEndByTurn = /* @__PURE__ */ new Map();
  const usageByTurn = /* @__PURE__ */ new Map();
  for (const u of s.usageEvents) {
    if (u.agentId) continue;
    ctxEndByTurn.set(u.turnIndex, u.contextSize);
    const arr2 = usageByTurn.get(u.turnIndex);
    if (arr2) arr2.push(u);
    else usageByTurn.set(u.turnIndex, [u]);
  }
  const turns = s.turns.map((t) => {
    const calls = toolsByTurn.get(t.index) ?? [];
    const counts = /* @__PURE__ */ new Map();
    for (const c of calls) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
    const activity = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([n2, k]) => k > 1 ? `${n2}\xD7${k}` : n2).join(" ");
    return {
      index: t.index,
      kind: t.kind,
      isCommand: t.isCommand,
      commandName: t.commandName,
      promptPreview: t.promptPreview,
      promptChars: t.promptChars,
      startTs: t.startTs,
      endTs: t.endTs,
      durationMs: t.durationMs,
      reportedDurationMs: t.reportedDurationMs,
      firstResponseMs: t.firstResponseMs,
      humanGapMs: t.humanGapMs,
      autoContinuations: t.autoContinuations,
      interrupted: t.interrupted,
      toolCalls: calls.length,
      toolErrors: calls.filter((c) => c.isError).length,
      toolMs: sum(calls.map((c) => c.durationMs ?? 0)),
      agents: t.agentIds,
      models: t.models,
      tokens: t.usage,
      totalTokens: usageTotal(t.usage),
      contextEnd: ctxEndByTurn.get(t.index),
      insightIds: [],
      activity
    };
  });
  const tools = analyzeTools(s);
  const files2 = analyzeFiles(s);
  const { quality, outcomes } = analyzeQuality(s, files2);
  const context = analyzeContext(s);
  const agents = analyzeAgents(s, turnOfToolUse);
  const skills = analyzeSkills(s);
  const hooks = analyzeHooks(s);
  const time = analyzeTime(s, turns, agents, hooks.totalMs);
  const agentTokensByTurn = /* @__PURE__ */ new Map();
  const turnAtTime = (ts2) => {
    if (ts2 === void 0) return void 0;
    for (const t of s.turns) {
      const start = t.startTs;
      const end = t.endTs ?? Number.POSITIVE_INFINITY;
      if (start !== void 0 && ts2 >= start && ts2 <= end) return t.index;
    }
    let best;
    for (const t of s.turns) if (t.startTs !== void 0 && t.startTs <= ts2) best = t.index;
    return best;
  };
  for (const r of agents.runs) {
    const ti = r.turnIndex ?? turnAtTime(r.startTs);
    if (ti !== void 0) agentTokensByTurn.set(ti, (agentTokensByTurn.get(ti) ?? 0) + r.totalTokens);
  }
  for (const t of turns) t.totalTokens = usageTotal(t.tokens) + (agentTokensByTurn.get(t.index) ?? 0);
  const tokenAnalysis = analyzeTokens(
    s,
    turns.map((t) => ({ turnIndex: t.index, tokens: t.totalTokens }))
  );
  const insights = runRules({ s, turns, tools, files: files2, context, tokens: tokenAnalysis, agents, hooks, time, quality }, opts.rules);
  for (const ins of insights) for (const ti of ins.turnIndexes) turns[ti]?.insightIds.push(ins.id);
  let tokens = emptyUsage();
  for (const u of s.usageEvents) tokens = addUsage(tokens, u.usage);
  const humanTurns = s.turns.filter((t) => t.kind === "human").length;
  const summary = {
    turns: s.turns.length,
    humanTurns,
    messages: s.messages.length,
    assistantMessages: s.messages.filter((m) => m.role === "assistant").length,
    toolCalls: s.toolCalls.length,
    toolErrors: s.toolCalls.filter((c) => c.isError).length,
    agents: s.agents.length,
    skills: s.skills.length,
    compactions: s.compactions.length,
    wallMs: s.meta.wallMs,
    activeMs: time.activeMs,
    humanWaitMs: time.humanWaitMs,
    tokens,
    totalTokens: usageTotal(tokens),
    contextPeak: context.peak,
    cacheHitRatio: context.cacheHitRatio,
    outcomes,
    topInsightIds: insights.slice(0, 3).map((i) => i.id),
    narrative: "",
    ending: sessionEnding(s, quality)
  };
  summary.narrative = narrative(s, summary, insights.slice(0, 2).map((i) => i.title));
  const usageEventsTotal = usageTotal(tokens);
  const turnsPlusAgents = usageTotal(s.turns.reduce((u, t) => addUsage(u, t.usage), emptyUsage())) + usageTotal(agents.totals.tokens);
  const diffPct = usageEventsTotal ? Math.abs(usageEventsTotal - turnsPlusAgents) / usageEventsTotal * 100 : 0;
  return {
    schemaVersion: ANALYSIS_SCHEMA_VERSION,
    generator: { name: "orangu", version, generatedAt: now, modelCatalogUpdatedAt: catalogInfo().updatedAt },
    session: {
      id: s.meta.sessionId,
      title: s.meta.title,
      source: s.meta.source,
      path: s.meta.path,
      subagentPaths: s.meta.subagentPaths,
      cwd: s.meta.cwd,
      projectSlug: s.meta.projectSlug,
      gitBranches: s.meta.gitBranches,
      clientVersions: s.meta.clientVersions,
      entrypoints: s.meta.entrypoints,
      permissionModes: s.meta.permissionModes,
      models: modelInfos(s),
      effortLevels: s.meta.effortLevels,
      startedAt: s.meta.startedAt,
      endedAt: s.meta.endedAt,
      live: s.meta.possiblyLive
    },
    summary,
    turns,
    tools,
    agents,
    skills,
    hooks,
    context,
    tokens: tokenAnalysis,
    time,
    files: files2,
    quality,
    insights,
    events: s.events.map((e) => ({ kind: e.kind, ts: e.ts, turnIndex: e.turnIndex, agentId: e.agentId, label: e.label, detail: e.detail })),
    parse: { ...s.parseReport, reconciliation: { usageEventsTotal, turnsPlusAgentsTotal: turnsPlusAgents, matchesWithinPct: round(diffPct, 3), ok: diffPct <= 1 } }
  };
}
function sessionEnding(s, quality) {
  const last = s.turns[s.turns.length - 1];
  if (last?.interrupted) return "interrupted";
  let lastRun;
  for (const r of [...quality.testRuns, ...quality.buildRuns]) if (!lastRun || r.turnIndex >= lastRun.turnIndex) lastRun = r;
  if (!lastRun) return "unknown";
  return lastRun.ok ? "clean" : "failing";
}
function narrative(s, sum2, top) {
  const parts = [];
  const what = s.meta.title ? `\u201C${s.meta.title.slice(0, 80)}\u201D` : "this session";
  parts.push(`In ${what}, the human made ${sum2.humanTurns} request${sum2.humanTurns === 1 ? "" : "s"}${sum2.turns > sum2.humanTurns ? ` (${sum2.turns} turns incl. commands/automation)` : ""} over ${sum2.wallMs ? fmtMs(sum2.wallMs) : "an unknown span"}; the agent was busy for ${fmtMs(sum2.activeMs)} of that.`);
  parts.push(`It made ${sum2.toolCalls} tool calls${sum2.toolErrors ? ` (${sum2.toolErrors} failed)` : ""}${sum2.agents ? `, ran ${sum2.agents} subagent${sum2.agents > 1 ? "s" : ""}` : ""}${sum2.skills ? `, used ${sum2.skills} skill/command invocation${sum2.skills > 1 ? "s" : ""}` : ""}, and processed ${fmtTokens(usageTotal(sum2.tokens))} tokens.`);
  const o = sum2.outcomes;
  const outs = [];
  if (o.prLinks.length) outs.push(`${o.prLinks.length} PR${o.prLinks.length > 1 ? "s" : ""}`);
  if (o.gitCommits) outs.push(`${o.gitCommits} commit${o.gitCommits > 1 ? "s" : ""}`);
  if (o.filesEdited || o.filesWritten) outs.push(`${o.filesEdited + o.filesWritten} file${o.filesEdited + o.filesWritten > 1 ? "s" : ""} changed`);
  if (o.testRuns) outs.push(`${o.testRuns} test run${o.testRuns > 1 ? "s" : ""}${o.testRunsFailed ? ` (${o.testRunsFailed} failed)` : ""}`);
  parts.push(outs.length ? `Visible outcomes: ${outs.join(", ")}.` : "No commits, PRs or test runs were detected.");
  if (top.length) parts.push(`Biggest things to look at: ${top.join("; ")}.`);
  return parts.join(" ");
}

// src/util/home.ts
import { homedir as homedir2 } from "node:os";
import { join as join4 } from "node:path";
function oranguHome(env = process.env) {
  const explicit = env["ORANGU_HOME"];
  if (explicit) return explicit;
  const xdg = env["XDG_DATA_HOME"];
  if (xdg) return join4(xdg, "orangu");
  return join4(homedir2(), ".orangu");
}

// src/util/stable-file.ts
import { constants as constants5 } from "node:fs";
import { lstat as lstat3, open as open5, realpath as realpath3 } from "node:fs/promises";
import { resolve as resolve3 } from "node:path";
function snapshot(stat8) {
  return { dev: stat8.dev, ino: stat8.ino, mode: stat8.mode, size: stat8.size, mtimeNs: stat8.mtimeNs, ctimeNs: stat8.ctimeNs };
}
function same(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
async function prevalidateStableTextFile(path, maxBytes, label) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error(`${label} byte cap must be a positive integer`);
  const requestedPath = resolve3(path);
  let requested;
  try {
    requested = await lstat3(requestedPath, { bigint: true });
  } catch {
    throw new Error(`${label} not found: ${requestedPath}`);
  }
  if (requested.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  if (!requested.isFile()) throw new Error(`${label} must be a regular file`);
  if (requested.size > BigInt(maxBytes)) throw new Error(`${label} exceeds ${maxBytes} bytes`);
  const canonicalPath = await realpath3(requestedPath);
  const canonical = await lstat3(canonicalPath, { bigint: true });
  const expected = snapshot(requested);
  if (canonical.isSymbolicLink() || !canonical.isFile() || !same(expected, snapshot(canonical))) {
    throw new Error(`${label} changed during prevalidation`);
  }
  return { requestedPath, canonicalPath, maxBytes, label, snapshot: expected };
}
async function readStableTextManifest(manifest) {
  const { requestedPath, canonicalPath, maxBytes, label, snapshot: expected } = manifest;
  let handle;
  try {
    handle = await open5(canonicalPath, constants5.O_RDONLY | (constants5.O_NOFOLLOW ?? 0));
  } catch {
    throw new Error(`${label} changed before it was read`);
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(maxBytes) || !same(expected, snapshot(before))) {
      throw new Error(`${label} changed before it was read`);
    }
    const buffer = Buffer.allocUnsafe(Number(before.size));
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const [after, requestedAfter, canonicalAfter] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat3(requestedPath, { bigint: true }),
      realpath3(requestedPath)
    ]);
    if (offset !== buffer.length || requestedAfter.isSymbolicLink() || canonicalAfter !== canonicalPath || !same(expected, snapshot(after)) || !same(expected, snapshot(requestedAfter))) {
      throw new Error(`${label} changed while it was being read`);
    }
    return buffer.toString("utf8");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${label} changed`)) throw error;
    throw new Error(`${label} changed while it was being read`);
  } finally {
    await handle.close();
  }
}
async function readStableTextFile(path, maxBytes, label) {
  return readStableTextManifest(await prevalidateStableTextFile(path, maxBytes, label));
}

// src/cache/index.ts
var MAX_ANALYSIS_CACHE_ENTRY_BYTES = 256 * 1024 * 1024;
var PRIVATE_DIRECTORY_MODE = 448;
var PRIVATE_FILE_MODE = 384;
var SIMPLE_SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/;
function sameInode(a, b) {
  return a.dev === b.dev && a.ino === b.ino;
}
function modeBits(stat8) {
  return Number(stat8.mode & 0o777n);
}
async function ensurePrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const requested = await lstat4(path, { bigint: true });
  if (requested.isSymbolicLink() || !requested.isDirectory()) throw new Error(`cache directory must be a real directory: ${path}`);
  const handle = await open6(path, constants6.O_RDONLY | (constants6.O_DIRECTORY ?? 0) | (constants6.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isDirectory() || !sameInode(requested, before)) throw new Error(`cache directory changed while opening: ${path}`);
    if (modeBits(before) !== PRIVATE_DIRECTORY_MODE) await handle.chmod(PRIVATE_DIRECTORY_MODE);
    const [after, requestedAfter, canonicalPath] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat4(path, { bigint: true }),
      realpath4(path)
    ]);
    if (!after.isDirectory() || requestedAfter.isSymbolicLink() || !requestedAfter.isDirectory() || !sameInode(after, requestedAfter) || modeBits(after) !== PRIVATE_DIRECTORY_MODE || modeBits(requestedAfter) !== PRIVATE_DIRECTORY_MODE) {
      throw new Error(`cache directory changed while securing: ${path}`);
    }
    return { path, canonicalPath, dev: after.dev, ino: after.ino };
  } finally {
    await handle.close();
  }
}
async function assertPrivateDirectoriesStable(directories) {
  for (const expected of directories) {
    const [current, canonicalPath] = await Promise.all([lstat4(expected.path, { bigint: true }), realpath4(expected.path)]);
    if (current.isSymbolicLink() || !current.isDirectory() || current.dev !== expected.dev || current.ino !== expected.ino || canonicalPath !== expected.canonicalPath || modeBits(current) !== PRIVATE_DIRECTORY_MODE) {
      throw new Error(`cache directory changed during access: ${expected.path}`);
    }
  }
}
async function prevalidateAnalysisCacheEntry(path) {
  const requested = await lstat4(path, { bigint: true });
  if (requested.isSymbolicLink()) throw new Error("cache entry must not be a symbolic link");
  if (!requested.isFile()) throw new Error("cache entry must be a regular file");
  if (requested.size > BigInt(MAX_ANALYSIS_CACHE_ENTRY_BYTES)) {
    throw new Error(`cache entry exceeds ${MAX_ANALYSIS_CACHE_ENTRY_BYTES} bytes`);
  }
  const handle = await open6(path, constants6.O_RDONLY | (constants6.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameInode(requested, opened) || opened.size > BigInt(MAX_ANALYSIS_CACHE_ENTRY_BYTES)) {
      throw new Error("cache entry changed while opening");
    }
    if (modeBits(opened) !== PRIVATE_FILE_MODE) await handle.chmod(PRIVATE_FILE_MODE);
  } finally {
    await handle.close();
  }
  return prevalidateStableTextFile(path, MAX_ANALYSIS_CACHE_ENTRY_BYTES, "cache entry");
}
async function readAnalysisCacheEntry(manifest) {
  return readStableTextManifest(manifest);
}
function manifestCacheKey(manifest) {
  return createHash2("sha1").update(`manifest-v1|${manifest.fingerprint}`).digest("hex");
}
var AnalysisCache = class {
  layoutDirectories;
  dir;
  enabled;
  validVersion;
  hits = 0;
  misses = 0;
  writes = 0;
  constructor(opts) {
    const home = resolve4(oranguHome());
    const cacheRoot = resolve4(opts.dir ?? join5(home, "cache"));
    const versionSegment = `${ANALYSIS_SCHEMA_VERSION}-${opts.version}`;
    this.validVersion = SIMPLE_SEGMENT.test(versionSegment);
    this.dir = join5(cacheRoot, versionSegment);
    this.layoutDirectories = opts.dir === void 0 ? [home, cacheRoot, this.dir] : [cacheRoot, this.dir];
    this.enabled = opts.enabled !== false;
  }
  file(key) {
    if (!this.validVersion || !SIMPLE_SEGMENT.test(key)) return void 0;
    return join5(this.dir, `${key}.json`);
  }
  async ensurePrivateLayout() {
    const identities = [];
    for (const path of this.layoutDirectories) identities.push(await ensurePrivateDirectory(path));
    return identities;
  }
  /** miss on absent/corrupt/version mismatch; never throws */
  async get(key) {
    if (!this.enabled) {
      this.misses++;
      return void 0;
    }
    try {
      const path = this.file(key);
      if (!path) throw new Error("invalid cache key");
      const directories = await this.ensurePrivateLayout();
      const manifest = await prevalidateAnalysisCacheEntry(path);
      await assertPrivateDirectoriesStable(directories);
      const raw = await readAnalysisCacheEntry(manifest);
      await assertPrivateDirectoriesStable(directories);
      const a = JSON.parse(raw);
      if (!a || typeof a !== "object" || a.schemaVersion !== ANALYSIS_SCHEMA_VERSION || !a.generator) {
        this.misses++;
        return void 0;
      }
      this.hits++;
      return a;
    } catch {
      this.misses++;
      return void 0;
    }
  }
  /** atomic tmp+rename; stores WITHOUT generator.generatedAt (set to 0) */
  async put(key, a) {
    if (!this.enabled) return;
    let tmp;
    try {
      const stored = { ...a, generator: { ...a.generator, generatedAt: 0 } };
      const path = this.file(key);
      if (!path) return;
      const bytes = Buffer.from(JSON.stringify(stored), "utf8");
      if (bytes.byteLength > MAX_ANALYSIS_CACHE_ENTRY_BYTES) return;
      const directories = await this.ensurePrivateLayout();
      tmp = `${path}.tmp-${process.pid}-${randomBytes(12).toString("hex")}`;
      const handle = await open6(
        tmp,
        constants6.O_WRONLY | constants6.O_CREAT | constants6.O_EXCL | (constants6.O_NOFOLLOW ?? 0),
        PRIVATE_FILE_MODE
      );
      try {
        await handle.writeFile(bytes);
        await handle.chmod(PRIVATE_FILE_MODE);
      } finally {
        await handle.close();
      }
      await assertPrivateDirectoriesStable(directories);
      await rename(tmp, path);
      tmp = void 0;
      await assertPrivateDirectoriesStable(directories);
      const final = await lstat4(path, { bigint: true });
      if (!final.isFile() || final.isSymbolicLink() || modeBits(final) !== PRIVATE_FILE_MODE) {
        throw new Error("cache entry changed after its atomic write");
      }
      this.writes++;
    } catch {
    } finally {
      if (tmp) {
        try {
          await unlink(tmp);
        } catch {
        }
      }
    }
  }
  stats() {
    return { hits: this.hits, misses: this.misses, writes: this.writes };
  }
};
async function analyzeRefCached(ref, o) {
  return withStableSessionRead(ref.path, { maxBytes: MAX_LOCAL_SESSION_BYTES }, async (first) => {
    let manifest = first;
    if (o.cache) {
      let key = manifestCacheKey(manifest);
      const hit = await o.cache.get(key);
      if (hit) {
        await assertEvidenceSessionManifestStable(manifest);
        hit.generator.generatedAt = o.now;
        return hit;
      }
      manifest = await prevalidateEvidenceSession(ref.path, { maxBytes: MAX_LOCAL_SESSION_BYTES });
      key = manifestCacheKey(manifest);
      const loaded2 = await readEvidenceSessionManifest(manifest);
      const session2 = await parseClaudeCodeSession(loaded2.parseInput);
      const a = analyzeSession(session2, { version: o.version, now: o.now });
      await o.cache.put(key, a);
      return a;
    }
    const loaded = await readEvidenceSessionManifest(manifest);
    const session = await parseClaudeCodeSession(loaded.parseInput);
    return analyzeSession(session, { version: o.version, now: o.now });
  });
}

// src/cache/pool.ts
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { cpus } from "node:os";
var POOL_FLAG = "__oranguPoolWorker";
function isPoolWorker() {
  if (isMainThread) return false;
  const wd = workerData;
  return !!wd && wd[POOL_FLAG] === true;
}
function runPoolWorker() {
  const init = workerData;
  const cache2 = init.cacheEnabled ? new AnalysisCache({ version: init.version }) : null;
  parentPort.on("message", (job) => {
    void (async () => {
      const hitsBefore = cache2?.stats().hits ?? 0;
      try {
        const analysis = await analyzeRefCached(job.ref, { cache: cache2, version: init.version, now: job.now });
        const msg = { idx: job.idx, ok: true, analysis, cacheHit: (cache2?.stats().hits ?? 0) > hitsBefore };
        parentPort.postMessage(msg);
      } catch (e) {
        const msg = { idx: job.idx, ok: false, error: String(e instanceof Error ? e.message : e) };
        parentPort.postMessage(msg);
      }
    })();
  });
}
function defaultJobs() {
  return Math.max(1, cpus().length - 1);
}
async function analyzeAllPooled(refs, o) {
  const results = new Array(refs.length);
  let failed = 0;
  let hits = 0;
  let next = 0;
  let done = 0;
  const n2 = Math.max(1, Math.min(o.jobs, refs.length));
  await new Promise((resolveAll, rejectAll) => {
    let alive = 0;
    const finishIfDone = () => {
      if (done >= refs.length) {
        resolveAll();
        return true;
      }
      return false;
    };
    for (let i = 0; i < n2; i++) {
      const w = new Worker(o.entry, { workerData: { [POOL_FLAG]: true, version: o.version, cacheEnabled: o.cacheEnabled } });
      alive++;
      let currentIdx = -1;
      const assign = () => {
        if (next >= refs.length) {
          currentIdx = -1;
          void w.terminate();
          return;
        }
        currentIdx = next++;
        w.postMessage({ idx: currentIdx, ref: refs[currentIdx], now: o.now });
      };
      w.on("message", (msg) => {
        if (msg.ok) {
          results[msg.idx] = msg.analysis;
          if (msg.cacheHit) hits++;
        } else failed++;
        done++;
        if (finishIfDone()) {
          void w.terminate();
          return;
        }
        assign();
      });
      w.on("error", (err3) => {
        if (currentIdx >= 0 && results[currentIdx] === void 0) {
          failed++;
          done++;
        }
        alive--;
        void w.terminate();
        if (finishIfDone()) return;
        if (alive === 0) rejectAll(err3 instanceof Error ? err3 : new Error(String(err3)));
      });
      assign();
    }
    finishIfDone();
  });
  const analyses = results.filter((a) => a !== void 0);
  return { analyses, failed, hits, misses: refs.length - failed - hits };
}

// src/cli/watch.ts
import { watch as fsWatch } from "node:fs";
import { stat as stat3 } from "node:fs/promises";

// src/serve/tail.ts
import { constants as constants7 } from "node:fs";
import { lstat as lstat5, open as open7 } from "node:fs/promises";
function newTailState(path) {
  return { path, nextByte: 0, records: [], trailingPartial: false, badLines: 0, totalLines: 0, bytes: 0, sidecars: /* @__PURE__ */ new Map() };
}
function sidecarBytes(st, except) {
  let total = 0;
  for (const [path, sidecar] of st.sidecars) {
    if (path !== except) total += sidecar.bytes + sidecar.metaBytes;
  }
  return total;
}
function sidecarRecords(st, except) {
  let total = 0;
  for (const [path, sidecar] of st.sidecars) {
    if (path !== except) total += sidecar.totalLines;
  }
  return total;
}
function identityChanged(previous, next) {
  if (!previous) return false;
  return !next || previous.device !== next.device || previous.inode !== next.inode;
}
function sameMetaIdentity(previous, next) {
  return !!previous && !!next && previous.device === next.device && previous.inode === next.inode && previous.size === next.size && previous.mtimeNs === next.mtimeNs && previous.ctimeNs === next.ctimeNs;
}
function remainingBudget(limit, used, kind) {
  const remaining = limit - used;
  if (remaining < 0) throw new Error(`session tail exceeds ${limit} ${kind}`);
  return remaining;
}
function metaIdentity(st) {
  if (st.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("metadata is too large to address safely");
  return {
    device: String(st.dev),
    inode: String(st.ino),
    size: Number(st.size),
    mtimeNs: String(st.mtimeNs),
    ctimeNs: String(st.ctimeNs)
  };
}
async function readSidecarMeta(path, remainingBytes) {
  const handle = await open7(path, constants7.O_RDONLY | constants7.O_NOFOLLOW);
  try {
    const st = await handle.stat({ bigint: true });
    if (!st.isFile()) throw new Error(`session sidecar metadata must be a regular file: ${path}`);
    const before = metaIdentity(st);
    if (before.size > MAX_EVIDENCE_META_BYTES) throw new Error(`session sidecar metadata exceeds ${MAX_EVIDENCE_META_BYTES} bytes: ${path}`);
    if (before.size > remainingBytes) throw new Error(`session tail exceeds ${MAX_LOCAL_SESSION_BYTES} bytes`);
    const buffer = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < before.size) {
      const read = await handle.read(buffer, offset, before.size - offset, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    if (offset !== before.size) throw new Error(`session sidecar metadata changed while it was being read: ${path}`);
    const after = metaIdentity(await handle.stat({ bigint: true }));
    const current = await lstat5(path, { bigint: true });
    if (!current.isFile() || current.isSymbolicLink()) {
      throw new Error(`session sidecar metadata must remain a regular non-symlink file: ${path}`);
    }
    const pathIdentity = metaIdentity(current);
    if (!sameMetaIdentity(before, after) || !sameMetaIdentity(after, pathIdentity)) {
      throw new Error(`session sidecar metadata changed while it was being read: ${path}`);
    }
    try {
      const value = JSON.parse(buffer.toString("utf8"));
      return {
        ...value && typeof value === "object" && !Array.isArray(value) ? { meta: value } : {},
        bytes: before.size,
        identity: before
      };
    } catch {
      return { bytes: before.size, identity: before };
    }
  } finally {
    await handle.close();
  }
}
function isMissing2(error) {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
async function tailOnce(st, ref, read = readJsonlFile) {
  let changed = false;
  let fullReparse = false;
  const prevPartial = st.trailingPartial;
  const activeSidecars = new Set(ref.subagentFiles);
  for (const path of st.sidecars.keys()) {
    if (!activeSidecars.has(path)) {
      st.sidecars.delete(path);
      changed = true;
    }
  }
  let mainFileBudget = remainingBudget(MAX_LOCAL_SESSION_BYTES, sidecarBytes(st), "bytes");
  let mainRecordBudget = remainingBudget(MAX_EVIDENCE_SESSION_RECORDS, sidecarRecords(st) + st.totalLines, "records");
  let r = await read(st.path, {
    fromByte: st.nextByte,
    maxBytes: mainFileBudget,
    maxFileBytes: mainFileBudget,
    maxRecords: mainRecordBudget,
    noFollow: true
  });
  if (st.fileIdentity && !r.fileIdentity) throw new Error(`session main transcript identity became unavailable: ${st.path}`);
  const firstMainIdentity = r.fileIdentity;
  const mainIdentityChanged = identityChanged(st.fileIdentity, r.fileIdentity);
  if (r.fileSize < st.nextByte || mainIdentityChanged) {
    fullReparse = true;
    if (mainIdentityChanged) st.sidecars.clear();
    st.records = [];
    st.nextByte = 0;
    st.badLines = 0;
    st.totalLines = 0;
    st.trailingPartial = false;
    mainFileBudget = remainingBudget(MAX_LOCAL_SESSION_BYTES, sidecarBytes(st), "bytes");
    mainRecordBudget = remainingBudget(MAX_EVIDENCE_SESSION_RECORDS, sidecarRecords(st), "records");
    r = await read(st.path, {
      fromByte: 0,
      maxBytes: mainFileBudget,
      maxFileBytes: mainFileBudget,
      maxRecords: mainRecordBudget,
      noFollow: true
    });
    if (identityChanged(firstMainIdentity, r.fileIdentity)) throw new Error(`session main transcript changed during tail reset: ${st.path}`);
  }
  const partial = r.trailingPartial ? 1 : 0;
  if (r.records.length) {
    st.records.push(...r.records);
    changed = true;
  }
  st.totalLines += Math.max(0, r.totalLines - partial);
  st.badLines += Math.max(0, r.badLines - partial);
  st.trailingPartial = r.trailingPartial;
  st.nextByte = r.nextByte;
  st.bytes = r.fileSize;
  st.fileIdentity = r.fileIdentity;
  if (fullReparse || st.trailingPartial !== prevPartial) changed = true;
  for (const p of activeSidecars) {
    let sc = st.sidecars.get(p);
    if (!sc) {
      sc = { nextByte: 0, records: [], bytes: 0, metaBytes: 0, totalLines: 0 };
      st.sidecars.set(p, sc);
      changed = true;
    }
    try {
      const loaded = await readSidecarMeta(
        p.replace(/\.jsonl$/, ".meta.json"),
        remainingBudget(MAX_LOCAL_SESSION_BYTES, st.bytes + sidecarBytes(st) - sc.metaBytes, "bytes")
      );
      if (!sameMetaIdentity(sc.metaIdentity, loaded.identity)) changed = true;
      sc.metaBytes = loaded.bytes;
      sc.metaIdentity = loaded.identity;
      sc.meta = loaded.meta;
    } catch (error) {
      if (!isMissing2(error)) throw error;
      if (sc.metaBytes !== 0 || sc.meta !== void 0 || sc.metaIdentity !== void 0) changed = true;
      sc.metaBytes = 0;
      sc.meta = void 0;
      sc.metaIdentity = void 0;
    }
    try {
      const sideFileBudget = remainingBudget(
        MAX_LOCAL_SESSION_BYTES,
        st.bytes + sidecarBytes(st, p) + sc.metaBytes,
        "bytes"
      );
      let sideRecordBudget = remainingBudget(
        MAX_EVIDENCE_SESSION_RECORDS,
        st.totalLines + sidecarRecords(st, p) + sc.totalLines,
        "records"
      );
      let sr = await read(p, {
        fromByte: sc.nextByte,
        maxBytes: sideFileBudget,
        maxFileBytes: sideFileBudget,
        maxRecords: sideRecordBudget,
        noFollow: true
      });
      if (sc.fileIdentity && !sr.fileIdentity) throw new Error(`session sidecar identity became unavailable: ${p}`);
      const firstSideIdentity = sr.fileIdentity;
      if (sr.fileSize < sc.nextByte || identityChanged(sc.fileIdentity, sr.fileIdentity)) {
        sc.records = [];
        sc.nextByte = 0;
        sc.totalLines = 0;
        sc.bytes = 0;
        sideRecordBudget = remainingBudget(MAX_EVIDENCE_SESSION_RECORDS, st.totalLines + sidecarRecords(st, p), "records");
        sr = await read(p, {
          fromByte: 0,
          maxBytes: sideFileBudget,
          maxFileBytes: sideFileBudget,
          maxRecords: sideRecordBudget,
          noFollow: true
        });
        if (identityChanged(firstSideIdentity, sr.fileIdentity)) throw new Error(`session sidecar changed during tail reset: ${p}`);
        fullReparse = true;
        changed = true;
      }
      if (sr.records.length) {
        sc.records.push(...sr.records);
        changed = true;
      }
      sc.nextByte = sr.nextByte;
      sc.bytes = sr.fileSize;
      sc.fileIdentity = sr.fileIdentity;
      sc.totalLines += Math.max(0, sr.totalLines - (sr.trailingPartial ? 1 : 0));
    } catch (error) {
      const detail = error instanceof Error ? `: ${error.message}` : "";
      throw new Error(`session sidecar could not be read safely: ${p}${detail}`, { cause: error });
    }
  }
  return { changed, fullReparse };
}
function sessionFromTail(st) {
  return parseClaudeCodeSession({
    path: st.path,
    records: st.records,
    subagents: [...st.sidecars.entries()].map(([path, s]) => ({ path, records: s.records, meta: s.meta })),
    trailingPartial: st.trailingPartial,
    bytes: st.bytes,
    badLines: st.badLines,
    totalLines: st.totalLines
  });
}

// src/cli/private-output.ts
import { constants as constants8 } from "node:fs";
import { lstat as lstat6, open as open8 } from "node:fs/promises";
import { resolve as resolve5 } from "node:path";
var PRIVATE_FILE_MODE2 = 384;
var PrivateOutputError = class extends Error {
  name = "PrivateOutputError";
};
function sameInode2(a, b) {
  return a.dev === b.dev && a.ino === b.ino;
}
function assertSafeOutput(stat8, path) {
  if (!stat8.isFile()) throw new PrivateOutputError(`private output target must be a regular file: ${path}`);
  if (stat8.nlink !== 1n) throw new PrivateOutputError(`private output target must not have multiple hard links: ${path}`);
}
async function assertPathStillNamesHandle(path, opened) {
  const current = await lstat6(path, { bigint: true });
  if (current.isSymbolicLink() || !current.isFile() || !sameInode2(current, opened)) {
    throw new PrivateOutputError(`private output target changed during access: ${path}`);
  }
}
async function openOutput(path) {
  const baseFlags = constants8.O_WRONLY | (constants8.O_NOFOLLOW ?? 0) | (constants8.O_NONBLOCK ?? 0);
  try {
    return await open8(path, baseFlags | constants8.O_CREAT | constants8.O_EXCL, PRIVATE_FILE_MODE2);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  try {
    return await open8(path, baseFlags);
  } catch (error) {
    if (error.code === "ELOOP") {
      throw new PrivateOutputError(`private output target must not be a symbolic link: ${path}`);
    }
    throw error;
  }
}
async function writePrivateOutput(path, data) {
  const outputPath = resolve5(path);
  try {
    const handle = await openOutput(outputPath);
    try {
      const opened = await handle.stat({ bigint: true });
      assertSafeOutput(opened, outputPath);
      await assertPathStillNamesHandle(outputPath, opened);
      if (process.platform !== "win32") await handle.chmod(PRIVATE_FILE_MODE2);
      const secured = await handle.stat({ bigint: true });
      assertSafeOutput(secured, outputPath);
      if (process.platform !== "win32" && Number(secured.mode & 0o777n) !== PRIVATE_FILE_MODE2) {
        throw new PrivateOutputError(`private output permissions could not be secured: ${outputPath}`);
      }
      await assertPathStillNamesHandle(outputPath, secured);
      await handle.truncate(0);
      await handle.writeFile(data);
      const written = await handle.stat({ bigint: true });
      assertSafeOutput(written, outputPath);
      await assertPathStillNamesHandle(outputPath, written);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof PrivateOutputError) throw error;
    throw new PrivateOutputError(`private output could not be written safely: ${outputPath}`);
  }
}

// src/cli/tty.ts
import { hostname } from "node:os";
import { pathToFileURL } from "node:url";
var MACHINE_CAPS = { tty: false, color: 0, animate: false, hyperlinks: false, columns: 80, unicode: true };
function ciSet(env) {
  const ci = env["CI"];
  return ci !== void 0 && ci !== "" && ci !== "false";
}
function detectCaps(stream, env = process.env, opts = {}) {
  const platform2 = opts.platform ?? process.platform;
  const tty = Boolean(stream.isTTY);
  const dumb = env["TERM"] === "dumb";
  const ci = ciSet(env);
  let color = 0;
  if (!opts.machine) {
    const noColor = env["NO_COLOR"];
    const force = env["FORCE_COLOR"];
    if (noColor !== void 0 && noColor !== "") color = 0;
    else if (force !== void 0) color = force === "0" || force === "false" ? 0 : force === "2" ? 2 : force === "3" ? 3 : 1;
    else if (tty && !dumb) {
      const depth = typeof stream.getColorDepth === "function" ? stream.getColorDepth(env) : 4;
      color = depth >= 24 ? 3 : depth >= 8 ? 2 : depth >= 4 ? 1 : 0;
    }
  }
  const animate = tty && !dumb && !ci && !opts.machine && env["ORANGU_NO_ANIMATION"] !== "1";
  const unicode = platform2 !== "win32" ? env["TERM"] !== "linux" : Boolean(env["WT_SESSION"] || env["TERM_PROGRAM"] === "vscode" || env["ConEmuTask"]);
  const columns = Math.max(40, Number.isFinite(stream.columns) && stream.columns > 0 ? stream.columns : 80);
  const hyperlinks = !opts.machine && supportsHyperlinks(stream, env, ci);
  return { tty, color, animate, hyperlinks, columns, unicode };
}
function supportsHyperlinks(stream, env, ci = ciSet(env)) {
  const force = env["FORCE_HYPERLINK"];
  if (force !== void 0) return !(force === "0" || force === "false" || force === "");
  if (!stream.isTTY || ci || env["TERM"] === "dumb" || env["TEAMCITY_VERSION"]) return false;
  if (env["WT_SESSION"]) return true;
  if (/^(screen|tmux)/.test(env["TERM"] ?? "")) return false;
  const prog = env["TERM_PROGRAM"];
  const ver = env["TERM_PROGRAM_VERSION"] ?? "";
  const major = Number(ver.split(".")[0]);
  const minor = Number(ver.split(".")[1] ?? 0);
  if (prog === "iTerm.app") return major > 3 || major === 3 && minor >= 1;
  if (prog === "vscode") return major > 1 || major === 1 && minor >= 72 || major === 0;
  if (prog === "WezTerm" || prog === "ghostty" || prog === "zed") return true;
  if (env["VTE_VERSION"]) return Number(env["VTE_VERSION"]) >= 5e3 && env["VTE_VERSION"] !== "5000";
  if (env["TERM"] === "xterm-kitty" || env["TERM"] === "alacritty") return true;
  return false;
}
var ACCENT = { 0: "", 1: "33", 2: "38;5;209", 3: "38;2;217;119;87" };
var SGR = { dim: "2", bold: "1", good: "32", warn: "33", bad: "31" };
function paint(caps, style, s) {
  if (caps.color === 0 || s === "") return s;
  const styles = Array.isArray(style) ? style : [style];
  const codes = styles.map((st) => st === "accent" ? ACCENT[caps.color] : SGR[st]).filter(Boolean);
  if (!codes.length) return s;
  return `\x1B[${codes.join(";")}m${s}\x1B[0m`;
}
var UNICODE_GLYPHS = { ok: "\u2713", mark: "\u25CF", sep: " \xB7 ", ellipsis: "\u2026", up: "\u2191", down: "\u2193" };
var ASCII_GLYPHS = { ok: "ok", mark: "*", sep: " | ", ellipsis: "...", up: "up", down: "down" };
function glyphs(caps) {
  return caps.unicode ? UNICODE_GLYPHS : ASCII_GLYPHS;
}
var ANSI_OR_OSC = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
var ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}\p{Cc}\p{Default_Ignorable_Code_Point}]/u;
var EMOJI = new RegExp("\\p{Emoji_Presentation}|\\uFE0F", "u");
var WIDE_RANGES = [
  [4352, 4447],
  [11904, 42191],
  [44032, 55203],
  [63744, 64255],
  [65072, 65103],
  [65280, 65376],
  [65504, 65510],
  [127744, 128591],
  [129280, 129535],
  [131072, 262141]
];
var isWide = (cp) => WIDE_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
var segmenter = new Intl.Segmenter(void 0, { granularity: "grapheme" });
function stripAnsi(s) {
  return s.replace(ANSI_OR_OSC, "");
}
function displayWidth(s) {
  let w = 0;
  for (const { segment } of segmenter.segment(stripAnsi(s))) {
    const cp = segment.codePointAt(0);
    if (cp >= 32 && cp <= 126) {
      w += 1;
      continue;
    }
    if (ZERO_WIDTH.test(segment)) continue;
    w += EMOJI.test(segment) || isWide(cp) ? 2 : 1;
  }
  return w;
}
function truncate(s, budget, caps) {
  const plain = stripAnsi(s);
  if (displayWidth(plain) <= budget) return plain;
  const ell = glyphs(caps).ellipsis;
  const room = budget - displayWidth(ell);
  if (room <= 0) return ell.slice(0, Math.max(0, budget));
  let out3 = "";
  let w = 0;
  for (const { segment } of segmenter.segment(plain)) {
    const sw = displayWidth(segment);
    if (w + sw > room) break;
    out3 += segment;
    w += sw;
  }
  return out3 + ell;
}
function padCell(s, width, align = "l") {
  const pad = Math.max(0, width - displayWidth(s));
  return align === "l" ? s + " ".repeat(pad) : " ".repeat(pad) + s;
}
function fileLink(absPath, caps, host = hostname()) {
  if (!caps.hyperlinks) return absPath;
  const u = pathToFileURL(absPath);
  const uri = `file://${host}${u.pathname}`.replace(/;/g, "%3B");
  return `\x1B]8;;${uri}\x1B\\${absPath}\x1B]8;;\x1B\\`;
}
var HIDE_CURSOR = "\x1B[?25l";
var SHOW_CURSOR = "\x1B[?25h";
var CLEAR_LINE = "\r\x1B[2K";
var CURSOR = {
  hide: HIDE_CURSOR,
  show: SHOW_CURSOR,
  /** move up n lines (nothing for n <= 0) */
  up: (n2) => n2 > 0 ? `\x1B[${n2}A` : "",
  /** erase from the cursor to the end of the screen */
  eraseDown: "\x1B[0J",
  /** carriage return */
  home: "\r"
};
function decodeKey(chunk) {
  if (chunk === "") return { key: "cancel" };
  if (chunk === "\x1B") return { key: "escape" };
  if (chunk === "\r" || chunk === "\n") return { key: "enter" };
  if (chunk === "q" || chunk === "Q" || chunk === "") return { key: "quit" };
  if (chunk === "j" || chunk === "\x1B[B" || chunk === "\x1BOB") return { key: "down" };
  if (chunk === "k" || chunk === "\x1B[A" || chunk === "\x1BOA") return { key: "up" };
  if (chunk === "g" || chunk === "\x1B[H" || chunk === "\x1BOH" || chunk === "\x1B[1~") return { key: "home" };
  if (chunk === "G" || chunk === "\x1B[F" || chunk === "\x1BOF" || chunk === "\x1B[4~") return { key: "end" };
  if (chunk === "\x1B[5~") return { key: "pageup" };
  if (chunk === "\x1B[6~") return { key: "pagedown" };
  if (/^[1-9]$/.test(chunk)) return { key: "digit", digit: Number(chunk) };
  return { key: "other" };
}
function rewriteLine(stream, caps, text2) {
  stream.write(caps.animate ? CLEAR_LINE + text2 : text2 + "\n");
}
var FRAMES_UNICODE = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"];
var FRAMES_ASCII = ["-", "\\", "|", "/"];
var EXIT_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
function onceOnExit(fn, proc = process) {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    fn();
  };
  const onSignal = (sig) => {
    run();
    for (const s of EXIT_SIGNALS) proc.removeListener(s, onSignal);
    proc.removeListener("exit", run);
    proc.kill(proc.pid, sig);
  };
  proc.once("exit", run);
  for (const s of EXIT_SIGNALS) proc.on(s, onSignal);
  return {
    dispose() {
      run();
      proc.removeListener("exit", run);
      for (const s of EXIT_SIGNALS) proc.removeListener(s, onSignal);
    }
  };
}
function spinner(caps, stream = process.stderr, opts = {}) {
  const frames = caps.unicode ? FRAMES_UNICODE : FRAMES_ASCII;
  const ms2 = opts.intervalMs ?? (caps.unicode ? 80 : 130);
  let i = 0;
  let text2 = "";
  let timer;
  let hook;
  const draw = () => {
    const frame = paint(caps, "accent", frames[i++ % frames.length]);
    stream.write(CLEAR_LINE + frame + " " + truncate(text2, caps.columns - 4, caps));
  };
  const clear = () => {
    if (!timer) return;
    clearInterval(timer);
    timer = void 0;
    stream.write(CLEAR_LINE + SHOW_CURSOR);
  };
  return {
    start(t) {
      text2 = t;
      if (!caps.animate || timer) return;
      hook = hook ?? onceOnExit(clear, opts.proc);
      stream.write(HIDE_CURSOR);
      draw();
      timer = setInterval(draw, ms2);
      timer.unref();
    },
    update(t) {
      text2 = t;
      if (timer) draw();
    },
    pause: clear,
    stop(final) {
      clear();
      hook?.dispose();
      hook = void 0;
      if (final !== void 0) stream.write(final + "\n");
    }
  };
}

// src/cli/watch.ts
async function watchSession(ref, flags, deps) {
  const path = deps.outPath(ref.sessionId);
  const err3 = detectCaps(process.stderr, process.env, { machine: flagBool(flags, "quiet") || flagBool(flags, "no-color") });
  const sep3 = glyphs(err3).sep;
  let building = false;
  let dirty = true;
  let lastSize = -1;
  let renders = 0;
  const st = newTailState(ref.path);
  const rebuild = async () => {
    if (building || !dirty) return;
    building = true;
    while (dirty) {
      dirty = false;
      try {
        try {
          ref.subagentFiles = (await discoverSubagentFiles(ref.path)).map((s2) => s2.path);
        } catch (error) {
          ref.subagentFiles = [];
          throw error;
        }
        await tailOnce(st, ref);
        const session = await sessionFromTail(st);
        const analysis = analyzeSession(session, { version: deps.version, now: Date.now() });
        const { html } = renderReport(analysis, { watch: true, redact: flagBool(flags, "no-redact") ? false : { scrub: true, stripText: !flagBool(flags, "include-text") } });
        await writePrivateOutput(path, html);
        renders++;
        const s = analysis.summary;
        rewriteLine(
          process.stderr,
          err3,
          `${paint(err3, "accent", glyphs(err3).mark)} watching ${ref.sessionId.slice(0, 8)}${sep3}${s.turns} turns${sep3}${s.toolCalls} tools${sep3}${fmtTokens(s.totalTokens)} tok${sep3}ctx ${fmtTokens(s.contextPeak)}${sep3}${fmtMs(s.wallMs)}  ${paint(err3, "dim", `(render #${renders})`)}`
        );
      } catch (error) {
        if (error instanceof PrivateOutputError) throw error;
        dirty = true;
        break;
      }
    }
    building = false;
  };
  await rebuild();
  process.stderr.write(`${err3.animate ? "\n" : ""}  report: ${path}
`);
  if (!flagBool(flags, "no-open")) deps.openInBrowser(path);
  const poll = setInterval(async () => {
    try {
      const st2 = await stat3(ref.path);
      if (st2.size !== lastSize) {
        lastSize = st2.size;
        dirty = true;
        void rebuild();
      }
    } catch {
    }
  }, 1500);
  try {
    const w = fsWatch(ref.path, { persistent: true }, () => {
      dirty = true;
      void rebuild();
    });
    process.on("SIGINT", () => {
      w.close();
      clearInterval(poll);
      process.stderr.write("\n  stopped.\n");
      process.exit(0);
    });
  } catch {
    process.on("SIGINT", () => {
      clearInterval(poll);
      process.exit(0);
    });
  }
  await new Promise(() => {
  });
}

// src/cli/summary.ts
import { basename as basename6 } from "node:path";

// src/harness/crosswalk.ts
import { basename as basename5 } from "node:path";

// src/harness/types.ts
var HARNESS_SCHEMA_VERSION = "1";
var HARNESS_ROW_CAP = 50;

// src/harness/crosswalk.ts
var SCOPE_PRECEDENCE = ["repo-local", "repo", "global-local", "global"];
var approxTokens = (bytes) => Math.ceil(bytes / 4);
function statusOf(declared2, observations) {
  if (!declared2) return "undeclared";
  return observations > 0 ? "used" : "idle";
}
function ranked(rows, n2, k) {
  return rows.slice().sort((a, b) => n2(b) - n2(a) || (k(a) < k(b) ? -1 : k(a) > k(b) ? 1 : 0)).slice(0, HARNESS_ROW_CAP);
}
function parseMcpToolName(name) {
  if (!name.startsWith("mcp__")) return null;
  const parts = name.split("__");
  if (parts.length < 3) return null;
  const server = parts[1] ?? "";
  const tool = parts.slice(2).join("__");
  return server && tool ? { server, tool } : null;
}
var norm = (p) => p.replace(/\\/g, "/");
var isAbs = (p) => p.startsWith("/") || /^[A-Za-z]:\//.test(p);
function expandHome(p, home) {
  const s = norm(p);
  if (!home) return s;
  const h = norm(home).replace(/\/+$/, "");
  if (s === "~") return h;
  if (s.startsWith("~/")) return h + s.slice(1);
  return s;
}
function resolveSessionPath(p, sessionCwd, home) {
  const s = expandHome(p, home);
  if (isAbs(s)) return s;
  if (s.startsWith("~")) return null;
  if (!sessionCwd) return null;
  return norm(sessionCwd).replace(/\/+$/, "") + "/" + s;
}
function declared(inv, pick) {
  for (const scope of SCOPE_PRECEDENCE) {
    for (const s of inv.settings) {
      if (s.scope !== scope) continue;
      const v = pick(s);
      if (v !== void 0 && v !== "") return v;
    }
  }
  return void 0;
}
function sameEffort(a, b) {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
function stripModelTag(m) {
  return m.trim().toLowerCase().replace(/\[[^\]]*\]$/, "").trim();
}
var MODEL_FAMILY_ALIASES = /* @__PURE__ */ new Set(["opus", "sonnet", "haiku"]);
function sameModel(configured, seen) {
  const c = stripModelTag(configured);
  const s = stripModelTag(seen);
  if (c === s) return true;
  return MODEL_FAMILY_ALIASES.has(c) && s.split("-").includes(c);
}
function crosswalk(inv, analyses, agg, opts = {}) {
  const installedSkills = new Map(inv.skills.map((s) => [s.name, s]));
  const canonicalSkill = (observed) => {
    if (installedSkills.has(observed)) return observed;
    const colon = observed.lastIndexOf(":");
    if (colon > 0) {
      const bare = observed.slice(colon + 1);
      const entry = installedSkills.get(bare);
      if (entry && (entry.plugin === void 0 || pluginName(entry.plugin) === observed.slice(0, colon))) return bare;
    }
    return observed;
  };
  const pluginName = (key) => key.split("@")[0] ?? key;
  const skillObs = /* @__PURE__ */ new Map();
  const skillObsAt = (rawName) => {
    const name = canonicalSkill(rawName);
    let e = skillObs.get(name);
    if (!e) skillObs.set(name, e = { invocations: 0, sessions: 0, viaTool: 0, viaCommand: 0 });
    return e;
  };
  for (const a of analyses) {
    const here = /* @__PURE__ */ new Set();
    for (const s of a.skills.byName) {
      const e = skillObsAt(s.name);
      e.invocations += s.count;
      here.add(canonicalSkill(s.name));
    }
    for (const i of a.skills.invocations) {
      const e = skillObsAt(i.name);
      if (i.via === "tool") e.viaTool++;
      else e.viaCommand++;
      here.add(canonicalSkill(i.name));
    }
    for (const n2 of here) skillObsAt(n2).sessions++;
  }
  for (const r of agg.bySkill) {
    const uses = r.extra?.["uses"] ?? 0;
    if (uses > 0 && !skillObs.has(canonicalSkill(r.key))) skillObsAt(r.key).invocations += uses;
  }
  const skillRows = [];
  for (const name of /* @__PURE__ */ new Set([...installedSkills.keys(), ...skillObs.keys()])) {
    const o = skillObs.get(name);
    const entry = installedSkills.get(name);
    skillRows.push({
      name,
      ...entry ? { origin: entry.plugin ? `plugin:${entry.plugin}` : entry.origin } : {},
      installed: !!entry,
      invocations: o?.invocations ?? 0,
      sessions: o?.sessions ?? 0,
      viaTool: o?.viaTool ?? 0,
      viaCommand: o?.viaCommand ?? 0,
      status: statusOf(!!entry, o?.invocations ?? 0)
    });
  }
  const mcpObs = /* @__PURE__ */ new Map();
  const mcpObsAt = (name) => {
    let e = mcpObs.get(name);
    if (!e) mcpObs.set(name, e = { toolCalls: 0, tools: /* @__PURE__ */ new Set(), sessions: 0 });
    return e;
  };
  for (const a of analyses) {
    const here = /* @__PURE__ */ new Set();
    for (const t of a.tools.byName) {
      const parsed = parseMcpToolName(t.name);
      if (!parsed) continue;
      const e = mcpObsAt(parsed.server);
      e.toolCalls += t.count;
      e.tools.add(parsed.tool);
      here.add(parsed.server);
    }
    for (const n2 of here) mcpObsAt(n2).sessions++;
  }
  for (const r of agg.byTool) {
    const calls = r.extra?.["calls"] ?? 0;
    const parsed = parseMcpToolName(r.key);
    if (calls > 0 && parsed && !mcpObs.has(parsed.server)) {
      const e = mcpObsAt(parsed.server);
      e.toolCalls += calls;
      e.tools.add(parsed.tool);
    }
  }
  const configuredMcp = new Map(inv.mcpServers.map((m) => [m.name, m]));
  const mcpRows = [];
  for (const name of /* @__PURE__ */ new Set([...configuredMcp.keys(), ...mcpObs.keys()])) {
    const o = mcpObs.get(name);
    mcpRows.push({
      name,
      configured: configuredMcp.has(name),
      toolCalls: o?.toolCalls ?? 0,
      distinctTools: o?.tools.size ?? 0,
      sessions: o?.sessions ?? 0,
      status: statusOf(configuredMcp.has(name), o?.toolCalls ?? 0)
    });
  }
  const agentObs = /* @__PURE__ */ new Map();
  const agentObsAt = (name) => {
    let e = agentObs.get(name);
    if (!e) agentObs.set(name, e = { dispatches: 0, sessions: 0, models: /* @__PURE__ */ new Set() });
    return e;
  };
  for (const a of analyses) {
    const here = /* @__PURE__ */ new Set();
    for (const t of a.agents.byType) {
      const e = agentObsAt(t.agentType);
      e.dispatches += t.count;
      here.add(t.agentType);
    }
    for (const r of a.agents.runs) {
      if (!r.agentType) continue;
      const e = agentObsAt(r.agentType);
      if (r.model) e.models.add(r.model);
      here.add(r.agentType);
    }
    for (const n2 of here) agentObsAt(n2).sessions++;
  }
  for (const r of agg.byAgentType) {
    const runs = r.extra?.["runs"] ?? 0;
    if (runs > 0 && !agentObs.has(r.key)) agentObsAt(r.key).dispatches += runs;
  }
  const definedAgents = new Map(inv.agents.map((a) => [a.name, a]));
  const agentRows = [];
  for (const name of /* @__PURE__ */ new Set([...definedAgents.keys(), ...agentObs.keys()])) {
    const o = agentObs.get(name);
    const entry = definedAgents.get(name);
    agentRows.push({
      name,
      ...entry ? { origin: entry.plugin ? `plugin:${entry.plugin}` : entry.origin } : {},
      defined: !!entry,
      dispatches: o?.dispatches ?? 0,
      sessions: o?.sessions ?? 0,
      models: [...o?.models ?? []].sort(),
      status: statusOf(!!entry, o?.dispatches ?? 0)
    });
  }
  const hookObs = /* @__PURE__ */ new Map();
  const hookObsAt = (name) => {
    let e = hookObs.get(name);
    if (!e) hookObs.set(name, e = { runs: 0, errors: 0, totalMs: 0, events: /* @__PURE__ */ new Set() });
    return e;
  };
  for (const a of analyses) {
    for (const h of a.hooks.byCommand) {
      const name = basename5((h.command ?? "").trim().split(/\s+/)[0] ?? "");
      if (!name) continue;
      const e = hookObsAt(name);
      e.runs += h.count;
      e.errors += h.errors;
      e.totalMs += h.totalMs;
      if (h.hookEvent) e.events.add(h.hookEvent);
    }
  }
  const configuredHooks = /* @__PURE__ */ new Map();
  for (const s of inv.settings) for (const h of s.hooks) for (const b of h.commandBasenames) if (!configuredHooks.has(b)) configuredHooks.set(b, h.event);
  const hookRows = [];
  for (const name of /* @__PURE__ */ new Set([...configuredHooks.keys(), ...hookObs.keys()])) {
    const o = hookObs.get(name);
    const event = configuredHooks.get(name) ?? [...o?.events ?? []].sort()[0];
    hookRows.push({
      ...event ? { event } : {},
      commandBasename: name,
      configured: configuredHooks.has(name),
      runs: o?.runs ?? 0,
      errors: o?.errors ?? 0,
      totalMs: Math.round(o?.totalMs ?? 0),
      // exact from exposed data: Σ totalMs ÷ Σ runs. No percentile is claimed; see HarnessHookRow.meanMs
      meanMs: o && o.runs > 0 ? Math.round(o.totalMs / o.runs) : 0,
      status: statusOf(configuredHooks.has(name), o?.runs ?? 0)
    });
  }
  const modelObs = /* @__PURE__ */ new Map();
  for (const a of analyses) {
    const here = /* @__PURE__ */ new Set();
    for (const m of a.tokens.byModel) {
      const e = modelObs.get(m.model) ?? { requests: 0, sessions: 0 };
      e.requests += m.requests;
      modelObs.set(m.model, e);
      here.add(m.model);
    }
    for (const n2 of here) modelObs.get(n2).sessions++;
  }
  const configuredModel = declared(inv, (s) => s.model);
  const modelsSeen = ranked(
    [...modelObs].map(([model, v]) => ({ model, requests: v.requests, sessions: v.sessions })),
    (x) => x.requests,
    (x) => x.model
  );
  const effortObs = /* @__PURE__ */ new Map();
  for (const a of analyses) for (const e of new Set(a.session.effortLevels)) effortObs.set(e, (effortObs.get(e) ?? 0) + 1);
  let slashEffortCommands = 0;
  for (const a of analyses) {
    for (const t of a.turns) {
      const c = t.commandName;
      if (c && c.replace(/^\//, "").toLowerCase() === "effort") slashEffortCommands++;
    }
  }
  const configuredEffort = declared(inv, (s) => s.effortLevel);
  const effortSeen = ranked(
    [...effortObs].map(([effort, sessions]) => ({ effort, sessions })),
    (x) => x.sessions,
    (x) => x.effort
  );
  let promptEvents = 0;
  let promptSessions = 0;
  for (const a of analyses) {
    const n2 = a.events.filter((e) => e.kind === "permission_prompt").length;
    promptEvents += n2;
    if (n2 > 0) promptSessions++;
  }
  const memoryIndex = /* @__PURE__ */ new Map();
  const ambiguous = /* @__PURE__ */ new Set();
  inv.claudeMd.forEach((f, i) => {
    const abs = expandHome(f.file, opts.home);
    if (!isAbs(abs)) return;
    if (memoryIndex.has(abs)) ambiguous.add(abs);
    else memoryIndex.set(abs, i);
  });
  for (const a of ambiguous) memoryIndex.delete(a);
  const memoryHits = inv.claudeMd.map(() => ({ reads: 0, sessions: 0 }));
  for (const a of analyses) {
    const here = /* @__PURE__ */ new Set();
    for (const s of a.files.files) {
      const abs = resolveSessionPath(s.path, a.session.cwd, opts.home);
      if (abs === null) continue;
      const i = memoryIndex.get(abs);
      if (i === void 0) continue;
      memoryHits[i].reads += s.reads;
      if (s.reads > 0) here.add(i);
    }
    for (const i of here) memoryHits[i].sessions++;
  }
  const memoryRows = inv.claudeMd.map((f, i) => ({
    file: f.file,
    bytes: f.bytes,
    approxTokens: f.approxTokens,
    reads: memoryHits[i].reads,
    sessions: memoryHits[i].sessions,
    approxTokensCarried: f.approxTokens * memoryHits[i].reads
  }));
  const listingObs = /* @__PURE__ */ new Map();
  for (const a of analyses) {
    for (const [type, bytes] of Object.entries(a.parse.attachmentBytes ?? {})) {
      const e = listingObs.get(type) ?? { bytes: 0, sessions: 0 };
      e.bytes += bytes;
      e.sessions++;
      listingObs.set(type, e);
    }
  }
  const listingRows = [...listingObs].map(([type, v]) => {
    const tokens = approxTokens(v.bytes);
    return { type, sessions: v.sessions, bytes: v.bytes, approxTokens: tokens, approxTokensPerSession: v.sessions > 0 ? Math.ceil(tokens / v.sessions) : 0 };
  });
  const starts = analyses.map((a) => a.session.startedAt).filter((t) => typeof t === "number");
  return {
    window: {
      ...starts.length ? { firstStartedAt: Math.min(...starts) } : {},
      ...starts.length ? { lastStartedAt: Math.max(...starts) } : {}
    },
    skills: ranked(skillRows, (x) => x.invocations, (x) => x.name),
    mcpServers: ranked(mcpRows, (x) => x.toolCalls, (x) => x.name),
    agents: ranked(agentRows, (x) => x.dispatches, (x) => x.name),
    hooks: ranked(hookRows, (x) => x.runs, (x) => x.commandBasename),
    models: {
      ...configuredModel ? { configured: configuredModel } : {},
      seen: modelsSeen,
      matchesConfigured: configuredModel === void 0 ? true : modelsSeen.some((m) => sameModel(configuredModel, m.model))
    },
    effort: {
      ...configuredEffort ? { configured: configuredEffort } : {},
      seen: effortSeen,
      slashEffortCommands,
      matchesConfigured: configuredEffort === void 0 ? true : effortSeen.some((e) => sameEffort(e.effort, configuredEffort))
    },
    permissions: {
      allowRules: inv.settings.reduce((n2, s) => n2 + s.permissions.allow, 0),
      denyRules: inv.settings.reduce((n2, s) => n2 + s.permissions.deny, 0),
      askRules: inv.settings.reduce((n2, s) => n2 + s.permissions.ask, 0),
      ...declared(inv, (s) => s.permissions.defaultMode) ? { defaultMode: declared(inv, (s) => s.permissions.defaultMode) } : {},
      promptEvents,
      promptSessions
    },
    claudeMd: ranked(memoryRows, (x) => x.approxTokensCarried, (x) => x.file),
    injectedListings: ranked(listingRows, (x) => x.approxTokens, (x) => x.type)
  };
}

// src/harness/report.ts
function plural(n2, one) {
  return `${n2} ${one}${n2 === 1 ? "" : "s"}`;
}
function buildNotes(inv, x, sessionsScanned, sessionsUnreadable) {
  const notes = [];
  const declaredNothing = inv.settings.length === 0 && inv.skills.length === 0 && inv.agents.length === 0 && inv.plugins.length === 0 && inv.mcpServers.length === 0 && inv.claudeMd.length === 0;
  if (declaredNothing) notes.push("no harness config found under the scanned roots. Nothing to cross-reference");
  if (!inv.usageCounters) {
    notes.push("~/.claude.json was not read, so client-side usage counters are omitted; declared vs used is classified from session evidence only");
  }
  if (inv.unreadable.length > 0) {
    notes.push(`${plural(inv.unreadable.length, "configured path")} could not be read. See inventory.unreadable for the reason of each`);
  }
  if (sessionsScanned === 0) {
    notes.push("no sessions in scope, so every crosswalk row is config-only and nothing can be classified used");
  }
  if (sessionsUnreadable > 0) {
    notes.push(`${plural(sessionsUnreadable, "session")} could not be analyzed and ${sessionsUnreadable === 1 ? "is" : "are"} not reflected in the crosswalk`);
  }
  if (x.models.configured && !x.models.matchesConfigured) {
    notes.push(`configured model "${x.models.configured}" does not appear among the models these sessions used`);
  }
  if (x.effort.configured && !x.effort.matchesConfigured) {
    notes.push(`configured effort "${x.effort.configured}" does not appear among the effort levels these sessions used`);
  }
  const undeclared = x.skills.filter((s) => s.status === "undeclared").length + x.mcpServers.filter((m) => m.status === "undeclared").length + x.agents.filter((a) => a.status === "undeclared").length + x.hooks.filter((h) => h.status === "undeclared").length;
  if (undeclared > 0) {
    notes.push(`${plural(undeclared, "row")} marked undeclared: observed in sessions but not found in the config that was read (a source outside this scope, or drift)`);
  }
  return notes;
}
function buildHarnessReport(inv, analyses, agg, o) {
  const home = o.scope.home || process.env["HOME"] || process.env["USERPROFILE"] || void 0;
  const rel = (p) => redactValue(p, home ? { home } : {});
  const sessionsUnreadable = o.scope.sessionsUnreadable ?? 0;
  const x = crosswalk(inv, analyses, agg, home ? { home } : {});
  return {
    schemaVersion: HARNESS_SCHEMA_VERSION,
    generator: { name: "orangu", version: o.version, generatedAt: o.now },
    scope: {
      cwd: rel(o.scope.cwd),
      roots: o.scope.roots.map(rel),
      global: o.scope.global,
      limit: o.scope.limit,
      sessionsScanned: analyses.length,
      sessionsUnreadable
    },
    inventory: inv,
    crosswalk: x,
    notes: buildNotes(inv, x, analyses.length, sessionsUnreadable)
  };
}

// src/report/client/format.ts
function plural2(n2, one, many = one + "s") {
  return `${num2(n2)} ${n2 === 1 ? one : many}`;
}
function num2(n2) {
  return n2.toLocaleString("en-US");
}

// src/report/client/derive.ts
function outcomeHeadline(s) {
  if (s.ending === "interrupted") return `Stopped by you after ${plural2(s.turns, "turn")}`;
  const parts = outcomeBits(s);
  if (parts.length) return parts.join(" \xB7 ");
  const requests = plural2(s.humanTurns, "request");
  if (s.toolCalls > 0) return `${requests}, ${s.agents ? plural2(s.agents, "subagent") + ", " : ""}nothing committed`;
  return `${requests}, no tool calls recorded`;
}
function outcomeBits(s) {
  const o = s.outcomes;
  const parts = [];
  if (o.prLinks.length) parts.push(plural2(o.prLinks.length, "PR"));
  if (o.gitCommits) parts.push(plural2(o.gitCommits, "commit"));
  const changed = o.filesEdited + o.filesWritten;
  if (changed) parts.push(plural2(changed, "file") + " changed");
  if (o.buildRunsFailed) parts.push(`${o.buildRunsFailed} of ${plural2(o.buildRuns, "build run")} failed`);
  if (o.testRuns) parts.push(o.testRunsFailed ? `${o.testRunsFailed} of ${plural2(o.testRuns, "test run")} failed` : `${plural2(o.testRuns, "test run")} green`);
  return parts;
}

// src/suggest/id.ts
function utf8(s) {
  return new TextEncoder().encode(s);
}
function sha1Hex(input) {
  const msg = utf8(input);
  const ml = msg.length;
  const withPad = (ml + 8 >> 6) + 1;
  const words2 = new Uint32Array(withPad * 16);
  for (let i = 0; i < ml; i++) words2[i >> 2] |= msg[i] << 24 - (i & 3) * 8;
  words2[ml >> 2] |= 128 << 24 - (ml & 3) * 8;
  const bits = ml * 8;
  words2[withPad * 16 - 1] = bits >>> 0;
  words2[withPad * 16 - 2] = Math.floor(bits / 4294967296) >>> 0;
  let h0 = 1732584193;
  let h1 = 4023233417;
  let h2 = 2562383102;
  let h3 = 271733878;
  let h4 = 3285377520;
  const w = new Uint32Array(80);
  const rotl = (x, n2) => x << n2 | x >>> 32 - n2;
  for (let blk = 0; blk < words2.length; blk += 16) {
    for (let t = 0; t < 16; t++) w[t] = words2[blk + t];
    for (let t = 16; t < 80; t++) w[t] = rotl(w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16], 1);
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let t = 0; t < 80; t++) {
      let f;
      let k;
      if (t < 20) {
        f = b & c | ~b & d;
        k = 1518500249;
      } else if (t < 40) {
        f = b ^ c ^ d;
        k = 1859775393;
      } else if (t < 60) {
        f = b & c | b & d | c & d;
        k = 2400959708;
      } else {
        f = b ^ c ^ d;
        k = 3395469782;
      }
      const tmp = rotl(a, 5) + f + e + k + w[t] >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30) >>> 0;
      b = a;
      a = tmp;
    }
    h0 = h0 + a >>> 0;
    h1 = h1 + b >>> 0;
    h2 = h2 + c >>> 0;
    h3 = h3 + d >>> 0;
    h4 = h4 + e >>> 0;
  }
  const hex = (n2) => n2.toString(16).padStart(8, "0");
  return hex(h0) + hex(h1) + hex(h2) + hex(h3) + hex(h4);
}
function normalizeSessionIds(sessionIds) {
  return [...new Set(sessionIds.map((id) => id.trim().replace(/\\/g, "/")).filter(Boolean))].sort();
}
function sessionCohortFingerprint(sessionIds) {
  return sha1Hex(JSON.stringify(normalizeSessionIds(sessionIds))).slice(0, 16);
}
function assertCohortBinding(finding, label = "finding") {
  const fingerprint = finding.cohortFingerprint;
  if (finding.scope === "session") {
    if (fingerprint !== void 0) throw new Error(`${label} session scope must omit cohortFingerprint`);
    return;
  }
  if (typeof fingerprint !== "string" || !/^[0-9a-f]{16}$/.test(fingerprint)) {
    throw new Error(`${label} repo/global scope requires a 16-hex cohortFingerprint`);
  }
}
function suggestionKey(finding, source) {
  assertCohortBinding(finding);
  return {
    v: 2,
    source,
    scope: finding.scope,
    ruleId: finding.ruleId,
    sessionIds: normalizeSessionIds(finding.sessionIds),
    ...finding.insightId ? { insightId: finding.insightId } : {},
    ...finding.cohortFingerprint ? { cohortFingerprint: finding.cohortFingerprint } : {}
  };
}
function suggestionIdV2(key) {
  const canonical = JSON.stringify({
    v: 2,
    source: key.source,
    scope: key.scope,
    ruleId: key.ruleId,
    sessionIds: normalizeSessionIds(key.sessionIds),
    insightId: key.insightId ?? null,
    ...key.cohortFingerprint ? { cohortFingerprint: key.cohortFingerprint } : {}
  });
  return "sg_" + sha1Hex(canonical).slice(0, 12);
}
function suggestionId(source, ruleId, sessionIds) {
  const ids = [...sessionIds].sort();
  return "sg_" + sha1Hex(source + "|" + ruleId + "|" + ids.join(",")).slice(0, 12);
}
function isSuggestionId(value) {
  return typeof value === "string" && /^sg_[0-9a-f]{12}$/.test(value);
}
function base64UrlEncode(bytes) {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join("")).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64UrlDecode(token) {
  if (!/^[A-Za-z0-9_-]*$/.test(token)) throw new Error("finding token is not base64url");
  const raw = atob(token.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(token.length / 4) * 4, "="));
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}
function canonicalJson(value) {
  return JSON.stringify(
    value,
    (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item
  );
}
var MAX_FINDING_TOKEN_CHARS = 256 * 1024;
function encodeFinding(finding, source = "report") {
  assertCohortBinding(finding);
  const normalized = { ...finding, sessionIds: normalizeSessionIds(finding.sessionIds) };
  const envelope = { v: 2, source, finding: normalized };
  return base64UrlEncode(utf8(canonicalJson(envelope)));
}
function decodeFinding(token) {
  if (!token || token.length > MAX_FINDING_TOKEN_CHARS) throw new Error("finding token is empty or too large");
  let value;
  try {
    value = JSON.parse(new TextDecoder().decode(base64UrlDecode(token)));
  } catch (e) {
    throw new Error(`invalid finding token: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!value || typeof value !== "object") throw new Error("invalid finding token: expected object");
  const env = value;
  const f = env.finding;
  if (env.v !== 2 || env.source !== "report" && env.source !== "skill" || !f || typeof f.ruleId !== "string" || !f.ruleId.trim() || typeof f.title !== "string" || !f.title.trim() || f.scope !== "session" && f.scope !== "repo" && f.scope !== "global" || !Array.isArray(f.sessionIds) || !f.sessionIds.length || !f.sessionIds.every((id) => typeof id === "string" && id.trim()) || !f.evidence || typeof f.evidence !== "object" || Array.isArray(f.evidence) || typeof f.evidence.estimated !== "boolean" || f.insightId !== void 0 && typeof f.insightId !== "string" || (f.scope === "session" ? f.cohortFingerprint !== void 0 : typeof f.cohortFingerprint !== "string" || !/^[0-9a-f]{16}$/.test(f.cohortFingerprint))) {
    throw new Error("invalid finding token: incomplete v2 finding");
  }
  return {
    v: 2,
    source: env.source,
    finding: { ...f, sessionIds: normalizeSessionIds(f.sessionIds) }
  };
}
function kickoffArgs(rec, mode) {
  if (mode === "serve") return rec.id;
  if (rec.title && rec.evidence) {
    const finding = {
      ruleId: rec.ruleId,
      title: rec.title,
      scope: rec.scope,
      sessionIds: rec.sessionIds,
      ...rec.insightId ? { insightId: rec.insightId } : {},
      ...rec.cohortFingerprint ? { cohortFingerprint: rec.cohortFingerprint } : {},
      evidence: rec.evidence
    };
    return `${rec.id} --finding ${encodeFinding(finding, rec.source ?? "report")}`;
  }
  const ids = [...rec.sessionIds].sort().join(",");
  return `${rec.id} --rule ${rec.ruleId} --scope ${rec.scope} --session ${ids}`;
}
function kickoffCommands(rec, mode) {
  const args = kickoffArgs(rec, mode);
  return { claude: `claude "/orangu:improve ${args}"`, codex: `$orangu-improve ${args}` };
}
function kickoffCommand(rec, mode) {
  return kickoffCommands(rec, mode).claude;
}

// src/report/client/suggest-rows.ts
var PLUGIN_INSTALL = "/plugin marketplace add NissanOhana/orangu \xB7 /plugin install orangu";
function titleForRule(ruleId) {
  const words2 = ruleId.trim().replace(/[-_]+/g, " ") || "finding";
  return words2[0].toUpperCase() + words2.slice(1);
}
var DETAIL_HIDDEN_BY_REDACTION = "Details hidden by redaction (they quote commands and result previews); re-run with --include-text to see them.";
function safeCopy(ruleId, title, detail) {
  return {
    title: title.trim() || titleForRule(ruleId),
    detail: detail.trim() || DETAIL_HIDDEN_BY_REDACTION
  };
}
function planRowForInsight(i, sessionId) {
  const copy = safeCopy(i.ruleId, i.title, i.detail);
  return {
    ruleId: i.ruleId,
    ...copy,
    recommendation: i.recommendation,
    savings: i.savings,
    sessionIds: sessionId ? [sessionId] : [],
    insightId: i.id,
    severity: i.severity
  };
}
function findingForRow(row2, scope) {
  return {
    ruleId: row2.ruleId,
    title: row2.title,
    scope,
    sessionIds: row2.sessionIds,
    ...row2.insightId ? { insightId: row2.insightId } : {},
    ...row2.cohortFingerprint ? { cohortFingerprint: row2.cohortFingerprint } : {},
    evidence: {
      estimated: row2.savings?.estimated ?? true,
      sessions: row2.sessions ?? 1,
      ...row2.savings?.tokens !== void 0 ? { savingsTokens: row2.savings.tokens } : {},
      ...row2.savings?.ms !== void 0 ? { savingsMs: row2.savings.ms } : {}
    }
  };
}

// src/cli/summary.ts
var LAYOUT_MAX = 80;
var INDENT = "  ";
var LABEL_WIDTH = 8;
var GUTTER = INDENT.length + LABEL_WIDTH + 1;
function layoutWidth(caps) {
  return Math.min(caps.columns, LAYOUT_MAX);
}
function valueBudget(caps) {
  return layoutWidth(caps) - GUTTER;
}
function row(caps, label, value, o = {}) {
  const v = o.raw ? value : truncate(value, valueBudget(caps), caps);
  return INDENT + padCell(label, LABEL_WIDTH) + " " + (o.style ? paint(caps, o.style, v) : v);
}
function continuation(caps, value, style) {
  const v = truncate(value, valueBudget(caps), caps);
  return " ".repeat(GUTTER) + (style ? paint(caps, style, v) : v);
}
function fit(caps, line) {
  return truncate(line, layoutWidth(caps), caps);
}
function fmtBytes(bytes) {
  return (bytes / 1e6).toFixed(1) + " MB";
}
function doneLine(caps, o) {
  const g = glyphs(caps);
  let s = `analyzed ${fmtBytes(o.sizeBytes)} in ${fmtMs(o.elapsedMs)}`;
  if (o.redactions) s += `${g.sep}${plural(o.redactions, "redaction")}`;
  return INDENT + paint(caps, "good", g.ok) + " " + truncate(s, layoutWidth(caps) - INDENT.length - displayWidth(g.ok) - 1, caps);
}
function nextStepLines(caps, step) {
  if (!step.finding) return [row(caps, "finding", "none: this session ran clean", { style: "good" })];
  const lines = [row(caps, "finding", step.finding, { style: "bold" })];
  if (step.storeNote) {
    const head = "unavailable: ";
    const tail = "; long form follows";
    const reason = truncate(step.storeNote, valueBudget(caps) - head.length - tail.length, caps);
    lines.push(row(caps, "store", head + reason + tail, { style: "warn", raw: true }));
  }
  if (step.next) lines.push(row(caps, "next", step.next, { raw: true }));
  const [add, install] = PLUGIN_INSTALL.split(" \xB7 ");
  lines.push(row(caps, "plugin", add ?? PLUGIN_INSTALL, { raw: true }));
  if (install) {
    const note = "(once, inside Claude Code)";
    const fits = install.length + 4 + note.length <= valueBudget(caps);
    lines.push(continuation(caps, install) + (fits ? "    " + paint(caps, "dim", note) : ""));
  }
  return lines;
}
function betaLine(caps, context) {
  return row(caps, "beta", `orangu feedback --context ${context}`, { style: "dim" });
}
function reportFooter(caps, o) {
  const link = fileLink(o.path, caps);
  const value = link === o.path ? paint(caps, "accent", o.path) : link;
  const note = o.opened && displayWidth(o.path) + 10 <= valueBudget(caps) ? paint(caps, "dim", "  (opened)") : "";
  const lines = [INDENT + padCell("report", LABEL_WIDTH) + " " + value + note];
  return [...lines, ...nextStepLines(caps, o.step), betaLine(caps, "report")];
}
function header(caps, title, sub) {
  const w = layoutWidth(caps);
  return [
    "",
    paint(caps, ["bold", "accent"], "orangu") + "  " + paint(caps, "bold", truncate(title, w - 8, caps)),
    "        " + paint(caps, "dim", truncate(sub, w - 8, caps)),
    ""
  ];
}
function qualityLine(a, sep3) {
  const o = a.summary.outcomes;
  const bits = [];
  if (o.prLinks.length) bits.push(`${o.prLinks.length} PR`);
  if (o.gitCommits) bits.push(`${o.gitCommits} commits`);
  if (o.testRuns) bits.push(`${o.testRuns} test runs${o.testRunsFailed ? " (" + o.testRunsFailed + " failed)" : ""}`);
  if (o.filesEdited + o.filesWritten) bits.push(`${o.filesEdited + o.filesWritten} files changed`);
  return bits.join(sep3) || "no commits/PRs/tests detected";
}
function findingRow(caps, ins) {
  const g = glyphs(caps);
  const w = layoutWidth(caps);
  const save = ins.savings?.tokens ? `save ~${fmtTokens(ins.savings.tokens)} tokens` : ins.savings?.ms ? `save ~${fmtMs(ins.savings.ms)}` : "";
  const lead = "    ";
  const budget = w - lead.length - 2 - (save ? displayWidth(save) + 2 : 0);
  const title = truncate(ins.title, budget, caps);
  const mark2 = paint(caps, ins.severity === "high" ? "bad" : ins.severity === "medium" ? "warn" : "dim", g.mark);
  const gap = save ? " ".repeat(Math.max(2, w - lead.length - 2 - displayWidth(title) - displayWidth(save))) : "";
  return lead + mark2 + " " + title + gap + paint(caps, "accent", save);
}
function analysisBlock(caps, a, title) {
  const s = a.summary;
  const sep3 = glyphs(caps).sep;
  const lines = header(caps, title, `${a.session.source}${sep3}${a.session.id}`);
  lines.push(row(caps, "quality", qualityLine(a, sep3)));
  lines.push(row(caps, "time", `${fmtMs(s.wallMs)} wall${sep3}${fmtMs(s.activeMs)} active${sep3}${fmtMs(s.humanWaitMs)} waiting`));
  lines.push(row(caps, "tokens", `${fmtTokens(s.totalTokens)}${sep3}${(s.cacheHitRatio * 100).toFixed(0)}% cache${sep3}${fmtTokens(a.tokens.byKind.output)} output`));
  lines.push(row(caps, "turns", `${s.turns} (${s.humanTurns} human)`));
  lines.push(row(caps, "tools", `${s.toolCalls} calls${sep3}${s.toolErrors} errors`));
  if (s.agents) lines.push(row(caps, "agents", `${s.agents} runs${sep3}${a.agents.maxConcurrency} max parallel${sep3}${fmtTokens(a.tokens.agents)} tokens`));
  lines.push(row(caps, "context", `peak ${fmtTokens(s.contextPeak)}${a.context.contextWindow ? " of " + fmtTokens(a.context.contextWindow) : ""}${sep3}${plural(s.compactions, "compaction")}`));
  lines.push("", paint(caps, "bold", INDENT + "findings"));
  if (!a.insights.length) lines.push(paint(caps, "good", "    clean: no findings"));
  for (const ins of a.insights.slice(0, 6)) lines.push(findingRow(caps, ins));
  lines.push("", paint(caps, "dim", fit(caps, `${INDENT}run 'orangu report ${a.session.id.slice(0, 8)}' for the full visual report`)));
  if (!a.parse.reconciliation.ok) lines.push(paint(caps, "warn", fit(caps, `${INDENT}warning: token totals reconcile within ${a.parse.reconciliation.matchesWithinPct}%`)));
  return lines;
}
function briefBlock(caps, a, title, step, o) {
  const s = a.summary;
  const sep3 = glyphs(caps).sep;
  const lines = header(caps, title, `latest${sep3}${a.session.id.slice(0, 8)}${sep3}${s.turns} turns${sep3}${fmtTokens(s.totalTokens)} tokens${sep3}${fmtMs(s.activeMs)} active`);
  lines.push(fit(caps, INDENT + outcomeHeadline(s)), "");
  lines.push(...nextStepLines(caps, step));
  if (o.hint) lines.push("", paint(caps, "dim", fit(caps, `${INDENT}orangu report for the full picture${sep3}orangu --help for every command`)));
  return lines;
}
function listRows(caps, refs, o) {
  const w = layoutWidth(caps);
  const lines = ["", paint(caps, "bold", `${plural(o.total, "session")}${o.global ? " (all roots)" : ""}`), ""];
  for (const s of refs) {
    const when = new Date(s.mtimeMs).toISOString().slice(0, 16).replace("T", " ");
    const size = padCell(fmtBytes(s.sizeBytes), 8, "r");
    const agents = padCell(s.hasSidecarDir ? `agents ${s.subagentFiles.length}` : "", 10);
    const lead = `${INDENT}${s.sessionId.slice(0, 8)}  ${when}  ${size}  ${agents}  `;
    const project = truncate(basename6(s.projectSlug), Math.max(8, w - displayWidth(lead)), caps);
    lines.push(`${INDENT}${paint(caps, "accent", s.sessionId.slice(0, 8))}  ${paint(caps, "dim", when)}  ${size}  ${paint(caps, "dim", agents)}  ${project}`);
  }
  if (!o.total) lines.push(paint(caps, "dim", fit(caps, `${INDENT}No sessions found. Is Claude Code installed?`)), paint(caps, "dim", fit(caps, `${INDENT}A transcript path also works: orangu report <path.jsonl>`)));
  else lines.push("", paint(caps, "dim", fit(caps, `${INDENT}orangu report <id>${glyphs(caps).sep}orangu analyze <id>${glyphs(caps).sep}orangu harness`)));
  return lines;
}
function fmtAge(mtimeMs, now) {
  const s = Math.max(0, now - mtimeMs) / 1e3;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.min(99, Math.floor(s / 86400))}d`;
}
var AGE_WIDTH = 4;
var SIZE_WIDTH = 8;
var RUNNING = "running";
var TITLE_MIN = 12;
function pickCells(caps, r, now, leadWidth) {
  const w = layoutWidth(caps);
  const id = r.sessionId.slice(0, 8);
  let showProject = true;
  let showSize = true;
  let showRunning = true;
  const fixed = () => leadWidth + 8 + 2 + (showProject ? 16 : 0) + 2 + AGE_WIDTH + (showSize ? 2 + SIZE_WIDTH : 0) + (showRunning ? 2 + RUNNING.length : 0);
  if (w - fixed() < TITLE_MIN) showProject = false;
  if (w - fixed() < TITLE_MIN) showSize = false;
  if (w - fixed() < TITLE_MIN) showRunning = false;
  const titleWidth = Math.max(4, w - fixed());
  const title = padCell(truncate(r.title ?? "(no title)", titleWidth, caps), titleWidth);
  const cells = [paint(caps, "accent", id), r.title ? title : paint(caps, "dim", title)];
  if (showProject) cells.push(paint(caps, "dim", padCell(truncate(r.project, 14, caps), 14)));
  cells.push(paint(caps, "dim", padCell(fmtAge(r.mtimeMs, now), AGE_WIDTH, "r")));
  if (showSize) cells.push(padCell(fmtBytes(r.sizeBytes), SIZE_WIDTH, "r"));
  if (showRunning) cells.push(r.running ? paint(caps, "good", RUNNING) : " ".repeat(RUNNING.length));
  return cells.join("  ");
}
function pickHeader(caps, counts) {
  const w = layoutWidth(caps);
  const left = paint(caps, ["bold", "accent"], "orangu") + "  " + paint(caps, "bold", "choose a session");
  const right = `${plural(counts.total, "session")}, ${counts.running} running`;
  const gap = w - INDENT.length - displayWidth(left) - displayWidth(right);
  return INDENT + left + (gap >= 2 ? " ".repeat(gap) + paint(caps, "dim", right) : "");
}
function pickFrame(caps, rows, view, counts, now) {
  const g = glyphs(caps);
  const lines = [pickHeader(caps, counts), ""];
  const end = Math.min(rows.length, view.start + view.size);
  for (let i = view.start; i < end; i++) {
    const r = rows[i];
    const cursor = i === view.cursor;
    const mark2 = r.running ? paint(caps, "good", g.mark) : " ";
    const lead = `${INDENT}${cursor ? paint(caps, "accent", ">") : " "} ${mark2} `;
    lines.push(lead + pickCells(caps, r, now, INDENT.length + 4));
  }
  if (view.start > 0 || end < rows.length) lines.push(paint(caps, "dim", `${INDENT}    ${g.up}${g.down} ${rows.length - (end - view.start)} more`));
  else lines.push("");
  const keys = caps.unicode ? "\u2191\u2193 or j k move \xB7 enter opens the report \xB7 q quits" : "up/down or j k move | enter opens the report | q quits";
  lines.push(paint(caps, "dim", truncate(INDENT + keys, layoutWidth(caps), caps)));
  return lines;
}
function pickList(caps, rows, counts, now) {
  const g = glyphs(caps);
  const numWidth = String(rows.length).length + 2;
  const lines = [pickHeader(caps, counts), ""];
  rows.forEach((r, i) => {
    const mark2 = r.running ? paint(caps, "good", g.mark) : " ";
    const lead = `${INDENT}${padCell(`[${i + 1}]`, numWidth)} ${mark2} `;
    lines.push(lead + pickCells(caps, r, now, INDENT.length + numWidth + 3));
  });
  lines.push("", paint(caps, "dim", truncate(`${INDENT}run: orangu report <id>${g.sep}the picker is interactive on a terminal`, layoutWidth(caps), caps)));
  return lines;
}

// src/suggest/store.ts
import { randomBytes as randomBytes2 } from "node:crypto";
import { constants as constants9 } from "node:fs";
import { lstat as lstat7, mkdir as mkdir2, open as open9, realpath as realpath5, rmdir, unlink as unlink2 } from "node:fs/promises";
import { dirname as dirname4, isAbsolute as isAbsolute4, join as join6 } from "node:path";

// src/suggest/change-classes.ts
var CHANGE_CLASS_DEFINITIONS = [
  { id: "instruction", label: "Instruction files", description: "Persistent project guidance and conventions." },
  { id: "script-cli", label: "Scripts and CLIs", description: "Repeatable actions with checkable output." },
  { id: "hook", label: "Hooks", description: "Guaranteed actions at lifecycle boundaries." },
  { id: "skill-create", label: "Skills to create", description: "Reusable knowledge and workflows specific to this setup." },
  { id: "skill-discover", label: "Skills to discover", description: "Existing capabilities to evaluate before installing." },
  { id: "subagent-agent", label: "Subagents and agents", description: "Isolated or specialized work with clear ownership." },
  { id: "mcp", label: "MCP servers", description: "External tools and data the work actually needs." },
  { id: "plugin", label: "Plugins", description: "A reusable package of related extensions." },
  { id: "workflow-config", label: "Workflow and configuration", description: "How work is sequenced, checked, and repeated." }
];
var CHANGE_CLASSES = new Set(CHANGE_CLASS_DEFINITIONS.map((definition) => definition.id));
function isChangeClass(value) {
  return CHANGE_CLASSES.has(value);
}

// src/suggest/reviewed-path.ts
import { isAbsolute as isAbsolute3 } from "node:path";
var WINDOWS_RESERVED_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
var CONTROL_CHARACTER = /[\x00-\x1f\x7f]/;
function inspectReviewedPath(file) {
  if (CONTROL_CHARACTER.test(file)) return { violation: "must not contain control characters or newlines" };
  if (isAbsolute3(file) || /^[\\/]/.test(file)) return { violation: "must be relative to the target repository" };
  if (file.includes(":")) return { violation: "must not contain a colon or Windows alternate data stream" };
  const canonical = file.replace(/\\/g, "/");
  const parts = canonical.split("/");
  if (parts.some((part) => part === "")) return { violation: "must not contain empty path components or a trailing separator" };
  if (parts.some((part) => part === ".")) return { violation: "must not contain dot path components" };
  if (parts.some((part) => part === "..")) return { violation: "must not escape the target repository" };
  for (const part of parts) {
    const windowsName = part.replace(/[. ]+$/g, "");
    if (windowsName.toLowerCase() === ".git") return { violation: "must not modify .git, including Windows aliases" };
    if (windowsName !== part) return { violation: "must not contain a component ending in a dot or space" };
    const basename12 = windowsName.split(".")[0].replace(/[. ]+$/g, "");
    if (WINDOWS_RESERVED_DEVICE.test(basename12)) return { violation: "must not use a reserved Windows device name" };
  }
  return { path: canonical };
}
function canonicalReviewedPath(file) {
  return inspectReviewedPath(file).path;
}
function reviewedPathKey(file) {
  return canonicalReviewedPath(file)?.toLowerCase();
}
function reviewedPathViolation(file) {
  return inspectReviewedPath(file).violation;
}

// src/suggest/catalog.json
var catalog_default2 = {
  catalogVersion: 1,
  updatedAt: "2026-08-23",
  note: "L2 curated catalog. Deterministic match, curated content. Every entry is offline-verifiable from this repo's research docs; URLs only from the public docs Research-found additions at suggest time are candidates: verifiedAt null.",
  entries: [
    {
      id: "cli-pdf-extract",
      changeClass: "script-cli",
      pattern: { signal: "file-ext:.pdf" },
      tool: "pdftotext / pdfplumber",
      url: null,
      verifiedAt: "2026-08-23",
      note: "Extract PDF text with a CLI before it enters context: pdftotext for plain text, pdfplumber when tables matter (one default, not a menu, per the public docs)."
    },
    {
      id: "cli-jq",
      changeClass: "script-cli",
      pattern: { signal: "file-ext:.json" },
      tool: "jq",
      url: null,
      verifiedAt: "2026-08-23",
      note: "Slice large JSON at the source (jq '.field', jq -r) instead of reading the whole file into context; same pipe-through guidance as the public docs (head/grep/jq)."
    },
    {
      id: "cli-ripgrep",
      changeClass: "script-cli",
      pattern: { signal: "bash-search-loop" },
      tool: "ripgrep (rg)",
      url: null,
      verifiedAt: "2026-08-23",
      note: "Repeated grep/find loops over a tree are what ripgrep is for: it is fast, gitignore-aware, and produces bounded text evidence that a later proposal can verify."
    },
    {
      id: "cli-ast-grep",
      changeClass: "script-cli",
      pattern: { signal: "bash-search-loop" },
      tool: "ast-grep",
      url: null,
      verifiedAt: "2026-08-23",
      note: "When the repeated search is structural (find every call site / pattern in code, not a string), ast-grep matches the syntax tree instead of text."
    },
    {
      id: "script-xlsx-extract",
      changeClass: "script-cli",
      pattern: { signal: "file-ext:.xlsx" },
      tool: "in-repo extraction script",
      url: null,
      verifiedAt: "2026-08-23",
      note: "Spreadsheet content should never be pasted into context: commit a small script that extracts the needed sheet/cells once and re-run it, so the session reads a short text result."
    },
    {
      id: "cache-tools-changed",
      changeClass: "mcp",
      pattern: { signal: "cache-miss:tools_changed" },
      feature: "stable tool prefix (MCP pruning / deferred tools)",
      url: "https://code.claude.com/docs/en/prompt-caching.md",
      verifiedAt: "2026-08-23",
      note: "cache_miss_reason tools_changed: the tool-definition block heads the cached prefix, so an MCP server connecting, reconnecting, or loading tools mid-session re-writes the whole context into the cache instead of reading it back. Load MCP servers at session start and prune churn-prone ones; deferred MCP tools (the default) do not disturb the cached prefix."
    },
    {
      id: "cache-system-changed",
      changeClass: "hook",
      pattern: { signal: "cache-miss:system_changed" },
      feature: "system-prompt stability (hook output stability)",
      url: "https://code.claude.com/docs/en/prompt-caching.md",
      verifiedAt: "2026-08-23",
      note: "cache_miss_reason system_changed: the system prompt (core instructions, tool definitions, output style) should only change when the loaded tool set changes or the client upgrades. Hook-injected content that varies run-to-run re-writes the prefix. Keep hook additionalContext byte-stable (no timestamps or counters)."
    },
    {
      id: "cache-messages-changed",
      changeClass: "workflow-config",
      pattern: { signal: "cache-miss:messages_changed" },
      feature: "prompt-prefix stability",
      url: "https://platform.claude.com/docs/en/build-with-claude/prompt-caching",
      verifiedAt: "2026-08-23",
      note: "cache_miss_reason messages_changed: the API caches by exact prefix match, ordered tools \u2192 system \u2192 messages, so a rewritten or interleaved earlier message invalidates everything after it. Avoid resuming one session in two terminals (messages interleave into one transcript) and avoid mid-session model/effort switches. Both are part of the cache key."
    },
    {
      id: "fix-reread-files",
      changeClass: "instruction",
      pattern: { ruleId: "reread-files" },
      feature: "read-once discipline + auto memory",
      url: "https://code.claude.com/docs/en/memory.md",
      verifiedAt: "2026-08-23",
      note: "A file already in context does not need re-reading. Each redundant read is sent again as fresh input and then carried in every later request. Keep durable facts in auto memory / CLAUDE.md instead of re-deriving them, and use offset/limit reads on big files."
    },
    {
      id: "script-repeated-commands",
      changeClass: "script-cli",
      pattern: { ruleId: "repeated-commands" },
      tool: "committed script",
      url: "https://code.claude.com/docs/en/skills.md",
      verifiedAt: "2026-08-23",
      note: "A deterministic command sequence re-typed 4+ times belongs in a committed script (repo scripts/ or a skill's bundled script; bundled scripts execute without ever entering context, per the public docs). One script call replaces the whole repeated block."
    },
    {
      id: "parallel-sequential-reads",
      changeClass: "subagent-agent",
      pattern: { ruleId: "sequential-reads" },
      feature: "parallel tool calls / subagent fan-out",
      url: "https://code.claude.com/docs/en/agents.md",
      verifiedAt: "2026-08-23",
      note: "Independent reads and searches can be issued as one parallel batch in a single message, or fanned out to subagents whose contexts are discarded; serial single-call turns pay a full model round-trip each."
    },
    {
      id: "trim-preamble",
      changeClass: "instruction",
      pattern: { ruleId: "preamble-weight" },
      feature: "CLAUDE.md trim",
      url: "https://code.claude.com/docs/en/memory.md",
      verifiedAt: "2026-08-23",
      note: "The baseline preamble (system prompt + tool definitions + CLAUDE.md + memory) is re-sent with every request for the whole session. Trim sections that never change an outcome; move rarely-needed procedure into skills that load on demand."
    },
    {
      id: "prune-mcp-servers",
      changeClass: "mcp",
      pattern: { ruleId: "mcp-definition-weight" },
      feature: "MCP server pruning",
      url: "https://code.claude.com/docs/en/mcp.md",
      verifiedAt: "2026-08-23",
      note: "MCP servers whose tools are listed but never called still add their definition tokens to every main-thread request. Remove or scope idle servers; deferred tools stay out of the cached prefix until fetched."
    },
    {
      id: "cache-warm-cadence",
      changeClass: "workflow-config",
      pattern: { ruleId: "low-cache-hit" },
      feature: "prompt-cache TTL awareness (the cache cliff)",
      url: "https://code.claude.com/docs/en/prompt-caching.md",
      verifiedAt: "2026-08-23",
      note: "After a long idle gap, a large resumed context can require a fresh cache write. Batch related work while context is reusable, or start a focused session after a long break; verify the effect from the next run rather than assuming a saving."
    },
    {
      id: "extract-binary-attachments",
      changeClass: "script-cli",
      pattern: { ruleId: "binary-attachments" },
      tool: "text extraction before attaching",
      url: null,
      verifiedAt: "2026-08-23",
      note: "Base64 attachments are carried in context at their full token weight. Extract the text or table with a CLI first (pdftotext/pdfplumber for PDFs, an in-repo script for spreadsheets) and attach the extraction instead."
    },
    {
      id: "discover-existing-skill",
      changeClass: "skill-discover",
      pattern: { ruleId: "harness:skill-discover" },
      skill: "skills.sh candidate discovery",
      url: "https://skills.sh/",
      verifiedAt: "2026-08-25",
      note: "For a recurring, broadly reusable capability, evaluate an existing skill before creating one. Propose a specific skills.sh or `npx skills find <query>` search for the user to run; compare source reputation, repository evidence, and install count, but never install or fetch from the deterministic catalog runtime. Every discovered skill remains a candidate until reviewed."
    },
    {
      id: "package-related-extensions",
      changeClass: "plugin",
      pattern: { ruleId: "harness:plugin" },
      feature: "plugin packaging for related extensions",
      url: "https://code.claude.com/docs/en/plugins",
      verifiedAt: "2026-08-25",
      note: "When repo or global evidence shows several related skills, agents, hooks, or MCP definitions must travel together, a plugin can package that set. A heavy skill alone is not enough evidence: confirm the related surfaces in the harness inventory before proposing packaging."
    }
  ]
};

// src/suggest/features.json
var features_default = {
  catalogVersion: 1,
  updatedAt: "2026-08-23",
  note: "Claude Code feature \u2192 detectable signal \u2192 finding it addresses. Same entry shape as catalog.json; /orangu:improve may refresh from the changelog online, adding candidates with verifiedAt null. All URLs from the public docs",
  entries: [
    {
      id: "feat-output-styles",
      changeClass: "instruction",
      pattern: { ruleId: "output-burst" },
      feature: "output styles",
      url: null,
      verifiedAt: "2026-08-23",
      note: "An output style is part of the system prompt (cached in the prefix, survives compaction, per the public docs). A style that constrains verbosity addresses repeated \u22658k-token output bursts; output tokens are the ones the model has to generate one at a time."
    },
    {
      id: "feat-context-fork",
      changeClass: "skill-create",
      pattern: { ruleId: "skill-token-weight" },
      feature: "skill frontmatter context: fork",
      url: "https://code.claude.com/docs/en/skills.md",
      verifiedAt: "2026-08-23",
      note: "context: fork (+ agent, background) runs a skill in a subagent instead of the main thread; fork subagents inherit the conversation and reuse the prompt cache, so a heavy skill stops inflating the main context. Addresses a skill whose per-invocation token weight is a multiple of the median turn."
    },
    {
      id: "feat-effort-frontmatter",
      changeClass: "workflow-config",
      pattern: { ruleId: "thinking-on-mechanical" },
      feature: "effort frontmatter (low|medium|high|xhigh|max)",
      url: "https://code.claude.com/docs/en/skills.md",
      verifiedAt: "2026-08-23",
      note: "Skills, agents, and --effort accept an effort level; set it low for mechanical steps where thinking tokens are being spent on single-tool requests. Each effort level has its own cache for the same model, so set it per agent/skill rather than toggling mid-session."
    },
    {
      id: "feat-background-agents",
      changeClass: "subagent-agent",
      pattern: { ruleId: "slow-tool" },
      feature: "run_in_background (Bash) / background agents",
      url: "https://code.claude.com/docs/en/sub-agents.md",
      verifiedAt: "2026-08-23",
      note: "Long-running commands can run detached (Bash run_in_background) and agents can carry background frontmatter, so a slow tool stops blocking the turn. Addresses tools with p95 over 30 s that the session waits on serially."
    },
    {
      id: "feat-workflows",
      changeClass: "workflow-config",
      pattern: { ruleId: "deep-fanout" },
      feature: "dynamic workflows",
      url: "https://code.claude.com/docs/en/workflows.md",
      verifiedAt: "2026-08-23",
      note: "Agent trees three levels deep are leaner to run and easier to reason about as a declared workflow: wf_ runs are first-class, with per-run artifacts stored under the session directory, instead of ad-hoc nested spawns."
    },
    {
      id: "feat-skills-over-pasted-prompts",
      changeClass: "skill-create",
      pattern: { ruleId: "repeated-commands" },
      feature: "skills (vs pasted prompts)",
      url: "https://code.claude.com/docs/en/skills.md",
      verifiedAt: "2026-08-23",
      note: "A procedure re-typed every session belongs in a skill: description-gated loading keeps it out of context until needed, bundled scripts execute without entering context at all, and invoked bodies survive compaction (capped 5k tokens each, per the public docs)."
    },
    {
      id: "feat-hooks-verification",
      changeClass: "hook",
      pattern: { ruleId: "unverified-edits" },
      feature: "hooks (PostToolUse verification)",
      url: "https://code.claude.com/docs/en/hooks.md",
      verifiedAt: "2026-08-23",
      note: "A PostToolUse hook can run the project's test/build gate automatically after edits (hooks run as code, not context), addressing sessions that end with edited files and no test or build run."
    }
  ]
};

// src/suggest/catalog.ts
function catalogEntries() {
  return catalog_default2.entries;
}
function featureEntries() {
  return features_default.entries;
}
function allEntries() {
  return [...catalogEntries(), ...featureEntries()];
}
var SIZE_RULES = /* @__PURE__ */ new Set(["oversized-tool-results", "truncated-reads", "binary-attachments", "large-writes", "reread-files"]);
var STRING_SCAN_CAP = 500;
function collectStrings(v, out3, depth = 0) {
  if (out3.length >= STRING_SCAN_CAP || depth > 6 || v == null) return;
  if (typeof v === "string") {
    out3.push(v);
    return;
  }
  if (Array.isArray(v)) {
    for (const x of v) collectStrings(x, out3, depth + 1);
    return;
  }
  if (typeof v === "object") {
    for (const x of Object.values(v)) collectStrings(x, out3, depth + 1);
  }
}
function detectFileExt(ext, a) {
  const re = new RegExp(ext.replace(".", "\\.") + "(?![a-z0-9])", "i");
  for (const ins of a.insights) {
    if (!SIZE_RULES.has(ins.ruleId)) continue;
    const strings = [];
    collectStrings(ins.evidence, strings);
    const hit = strings.find((s) => re.test(s));
    if (hit !== void 0) return `${ins.ruleId}: ${hit.slice(0, 120)}`;
  }
  const rr = a.files?.mostReRead?.find((f) => f.path !== void 0 && re.test(f.path));
  if (rr?.path !== void 0) return `re-read file ${rr.path.slice(0, 120)}`;
  return void 0;
}
function detectCacheMiss(type, a) {
  for (const ins of a.insights) {
    if (ins.ruleId !== "cache-invalidation") continue;
    const byType = ins.evidence?.byType;
    if (!Array.isArray(byType)) continue;
    for (const g of byType) {
      const t = g ?? {};
      if (t.type === type) return `cache_miss_reason ${type} \xD7${typeof t.events === "number" ? t.events : "?"}`;
    }
  }
  const misses = a.context?.cacheMisses?.filter((m) => m.type === type) ?? [];
  if (misses.length) return `cache_miss_reason ${type} \xD7${misses.length}`;
  return void 0;
}
var SEARCH_CMD = /(^|[\s|;&(])(grep|egrep|fgrep|find)\s/;
function detectBashSearchLoop(a) {
  for (const ins of a.insights) {
    if (ins.ruleId !== "repeated-commands") continue;
    const commands = ins.evidence?.commands;
    if (!Array.isArray(commands)) continue;
    for (const c of commands) {
      const cmd = c ?? {};
      if (typeof cmd.command === "string" && SEARCH_CMD.test(cmd.command)) {
        return `repeated search command "${cmd.command.slice(0, 120)}"${typeof cmd.count === "number" ? ` \xD7${cmd.count}` : ""}`;
      }
    }
  }
  return void 0;
}
function detectSignal(signal, a) {
  if (signal.startsWith("file-ext:")) return detectFileExt(signal.slice("file-ext:".length), a);
  if (signal.startsWith("cache-miss:")) return detectCacheMiss(signal.slice("cache-miss:".length), a);
  if (signal === "bash-search-loop") return detectBashSearchLoop(a);
  return void 0;
}
function matchRule(ruleId, analyses = []) {
  const out3 = [];
  const seen = /* @__PURE__ */ new Set();
  for (const entry of allEntries()) {
    if (entry.pattern.ruleId === ruleId) {
      out3.push({ entry, evidence: `finding ruleId=${ruleId}` });
      seen.add(entry.id);
    }
  }
  for (const a of analyses) {
    const scoped = {
      insights: a.insights.filter((i) => i.ruleId === ruleId),
      ...ruleId === "reread-files" && a.files !== void 0 ? { files: a.files } : {},
      ...ruleId === "cache-invalidation" && a.context !== void 0 ? { context: a.context } : {}
    };
    for (const entry of allEntries()) {
      if (seen.has(entry.id) || entry.pattern.signal === void 0) continue;
      const evidence = detectSignal(entry.pattern.signal, scoped);
      if (evidence !== void 0) {
        out3.push({ entry, evidence });
        seen.add(entry.id);
      }
    }
  }
  return out3;
}

// src/suggest/source-provenance.ts
var MAX_SOURCES = 24;
var MAX_LABEL = 300;
var MAX_URL = 2e3;
var CATALOG_BY_LABEL = new Map(
  allEntries().map((entry) => [`catalog: ${entry.id}`, entry])
);
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function boundedText(value, max) {
  if (typeof value !== "string") return void 0;
  const text2 = value.trim();
  return text2 && text2.length <= max && !/[\x00-\x1f\x7f]/.test(text2) ? text2 : void 0;
}
function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = /* @__PURE__ */ new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}
function httpsUrl(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL) return void 0;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" ? parsed.href : void 0;
  } catch {
    return void 0;
  }
}
function inferenceSource(source, label, index) {
  if (source["url"] !== void 0 || source["verifiedAt"] !== void 0) {
    return { error: `sources[${index}] inference must not include url or verifiedAt` };
  }
  return { source: { kind: "inference", label } };
}
function researchSource(source, label, index) {
  const url = httpsUrl(source["url"]);
  if (!url) return { error: `sources[${index}].url must be a valid HTTPS URL` };
  if (!validDate(source["verifiedAt"])) {
    return { error: `sources[${index}].verifiedAt must be a non-null valid YYYY-MM-DD date` };
  }
  return { source: { kind: "research", label, url, verifiedAt: source["verifiedAt"] } };
}
function catalogSource(source, label, index) {
  if (source["label"] !== label) {
    return { error: `sources[${index}].label must be exactly "catalog: <catalog id>" for a shipped catalog entry` };
  }
  const entry = CATALOG_BY_LABEL.get(label);
  if (!entry) return { error: `sources[${index}].label must be exactly "catalog: <catalog id>" for a shipped catalog entry` };
  if (source["url"] !== void 0) {
    const suppliedUrl = httpsUrl(source["url"]);
    const catalogUrl = entry.url === null ? void 0 : httpsUrl(entry.url);
    if (!suppliedUrl || suppliedUrl !== catalogUrl) return { error: `sources[${index}].url does not match catalog entry ${entry.id}` };
  }
  if (source["verifiedAt"] !== void 0 && source["verifiedAt"] !== entry.verifiedAt) {
    return { error: `sources[${index}].verifiedAt does not match catalog entry ${entry.id}` };
  }
  return {
    source: {
      kind: "catalog",
      label,
      ...entry.url !== null ? { url: entry.url } : {},
      verifiedAt: entry.verifiedAt
    }
  };
}
function normalizeProposalSource(value, index) {
  const source = record(value);
  if (!source) return { error: `sources[${index}] must be an object` };
  const label = boundedText(source["label"], MAX_LABEL);
  if (!label) return { error: `sources[${index}].label must contain 1-${MAX_LABEL} safe characters` };
  if (source["kind"] === "inference") return inferenceSource(source, label, index);
  if (source["kind"] === "research") return researchSource(source, label, index);
  if (source["kind"] === "catalog") return catalogSource(source, label, index);
  return { error: `sources[${index}].kind is not supported` };
}
function normalizeProposalSources(value) {
  if (value === void 0) return {};
  if (!Array.isArray(value) || value.length > MAX_SOURCES) {
    return { error: `sources must contain 0-${MAX_SOURCES} entries` };
  }
  const sources = [];
  for (let index = 0; index < value.length; index++) {
    const normalized = normalizeProposalSource(value[index], index);
    if (normalized.error) return { error: normalized.error };
    if (!normalized.source) return { error: `sources[${index}] could not be normalized` };
    sources.push(normalized.source);
  }
  return { sources };
}
function proposalSourcesAreCanonical(value) {
  if (value === void 0) return true;
  const normalized = normalizeProposalSources(value);
  if (normalized.error !== void 0 || !Array.isArray(value) || !normalized.sources || value.length !== normalized.sources.length) return false;
  return value.every((raw, index) => {
    const source = record(raw);
    const canonical = record(normalized.sources?.[index]);
    if (!source || !canonical) return false;
    const sourceKeys = Object.keys(source).sort();
    const canonicalKeys = Object.keys(canonical).sort();
    return JSON.stringify(sourceKeys) === JSON.stringify(canonicalKeys) && sourceKeys.every((key) => source[key] === canonical[key]);
  });
}

// src/suggest/types.ts
var TRANSITIONS = {
  new: ["kicked-off", "rejected"],
  "kicked-off": ["proposed", "failed", "rejected"],
  proposed: ["applied", "rejected"],
  applied: ["verified", "rejected"],
  verified: ["rejected"],
  rejected: [],
  failed: ["kicked-off", "rejected"]
};
var SUGGESTION_VERIFICATION_METRICS = [
  "avgTotalTokens",
  "avgToolCalls",
  "avgToolErrors",
  "avgActiveMs",
  "avgContextPeak",
  "avgTestRunsFailed",
  "avgBuildRunsFailed",
  "avgInterruptions"
];
var SUGGESTION_VERIFICATION_COMPARISONS = ["decreased", "not-increased", "increased", "not-decreased", "equal"];
var ESTIMATE_TOKEN_THRESHOLD = 5e3;

// src/suggest/verification-policy.ts
function verificationIntentKey(intent) {
  return `${intent.metric}:${intent.comparison}`;
}
function hasUniqueVerificationIntents(intents) {
  return new Set(intents.map(verificationIntentKey)).size === intents.length;
}
function sameVerificationIntentSet(left, right) {
  if (left.length !== right.length) return false;
  const leftKeys = left.map(verificationIntentKey).sort();
  const rightKeys = right.map(verificationIntentKey).sort();
  return leftKeys.every((key, index) => key === rightKeys[index]);
}
function sameVerificationIntentSequence(left, right) {
  return left.length === right.length && left.every((intent, index) => verificationIntentKey(intent) === verificationIntentKey(right[index]));
}
function verificationCheckName(intent) {
  return `${intent.metric} ${intent.comparison}`;
}
function verificationReceiptSummary(intents) {
  return `Later-session comparison passed: ${intents.map(verificationCheckName).join("; ")}.`;
}
function isIntent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const intent = value;
  return SUGGESTION_VERIFICATION_METRICS.includes(intent.metric) && SUGGESTION_VERIFICATION_COMPARISONS.includes(intent.comparison);
}
function numericMapMatches(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  const wanted = Object.entries(expected);
  return entries.length === wanted.length && wanted.every(([key, number]) => value[key] === number);
}
function isTrustedComputedVerification(record2) {
  if (record2.status !== "verified" || record2.verificationTrust !== "computed-v1" || record2.scope !== "session") return false;
  const proposal = record2.proposal;
  const application = record2.application;
  const receipt = record2.verificationReceipt;
  const effect = record2.effect;
  if (proposal?.v !== 1 || !proposal.workspace?.cwd || !Array.isArray(proposal.verificationChecks) || proposal.verificationChecks.length === 0 || !proposal.verificationChecks.every(isIntent) || !hasUniqueVerificationIntents(proposal.verificationChecks) || application?.v !== 1 || receipt?.v !== 1 || !effect || !Array.isArray(receipt.checks) || receipt.checks.length !== proposal.verificationChecks.length || !Array.isArray(receipt.measuredSessionIds) || receipt.measuredSessionIds.length === 0 || JSON.stringify(receipt.measuredSessionIds) !== JSON.stringify(effect.measuredSessionIds)) return false;
  if (receipt.summary !== verificationReceiptSummary(proposal.verificationChecks)) return false;
  for (let index = 0; index < proposal.verificationChecks.length; index++) {
    const intent = proposal.verificationChecks[index];
    const check = receipt.checks[index];
    if (!check || check.ok !== true || check.metric !== intent.metric || check.comparison !== intent.comparison || check.name !== verificationCheckName(intent) || !Number.isFinite(check.before) || !Number.isFinite(check.after) || typeof check.evidence !== "string" || !check.evidence) return false;
  }
  const before = Object.fromEntries(receipt.checks.map((check) => [check.metric, check.before]));
  const after = Object.fromEntries(receipt.checks.map((check) => [check.metric, check.after]));
  return numericMapMatches(effect.before, before) && numericMapMatches(effect.after, after);
}

// src/suggest/store.ts
var LOCK_STALE_MS = 1e4;
var LOCK_TIMEOUT_MS = 5e3;
var MAX_SUGGESTION_STORE_BYTES = 64 * 1024 * 1024;
var MAX_SUGGESTION_RECORD_BYTES = 4 * 1024 * 1024;
var MAX_SUGGESTION_STORE_LINES = 1e5;
var LOCK_OWNER_FILE = "owner.json";
var MAX_LOCK_OWNER_BYTES = 1024;
var PRIVATE_DIRECTORY_MODE2 = 448;
var PRIVATE_FILE_MODE3 = 384;
function errno(error) {
  return error.code;
}
function sameInode3(a, b) {
  return a.dev === b.dev && a.ino === b.ino;
}
function modeBits2(stat8) {
  return Number(stat8.mode & 0o777n);
}
function fileSnapshot(stat8) {
  return {
    dev: stat8.dev,
    ino: stat8.ino,
    mode: stat8.mode,
    nlink: stat8.nlink,
    size: stat8.size,
    mtimeNs: stat8.mtimeNs,
    ctimeNs: stat8.ctimeNs
  };
}
function sameFileSnapshot(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
async function securePrivateDirectory(path, label) {
  const requested = await lstat7(path, { bigint: true });
  if (requested.isSymbolicLink() || !requested.isDirectory()) throw new Error(`${label} must be a real directory: ${path}`);
  const handle = await open9(path, constants9.O_RDONLY | (constants9.O_DIRECTORY ?? 0) | (constants9.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isDirectory() || !sameInode3(requested, before)) throw new Error(`${label} changed while opening: ${path}`);
    if (process.platform !== "win32" && modeBits2(before) !== PRIVATE_DIRECTORY_MODE2) await handle.chmod(PRIVATE_DIRECTORY_MODE2);
    const [after, requestedAfter, canonicalPath] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat7(path, { bigint: true }),
      realpath5(path)
    ]);
    if (!after.isDirectory() || requestedAfter.isSymbolicLink() || !requestedAfter.isDirectory() || !sameInode3(after, requestedAfter) || process.platform !== "win32" && (modeBits2(after) !== PRIVATE_DIRECTORY_MODE2 || modeBits2(requestedAfter) !== PRIVATE_DIRECTORY_MODE2)) {
      throw new Error(`${label} changed while securing: ${path}`);
    }
    return { path, canonicalPath, dev: after.dev, ino: after.ino };
  } finally {
    await handle.close();
  }
}
async function ensurePrivateDirectory2(path, label) {
  await mkdir2(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE2 });
  return securePrivateDirectory(path, label);
}
async function secureExistingPrivateDirectory(path, label) {
  try {
    return await securePrivateDirectory(path, label);
  } catch (error) {
    if (errno(error) === "ENOENT") return void 0;
    throw error;
  }
}
async function assertPrivateDirectoriesStable2(directories) {
  await Promise.all(directories.map(async (expected) => {
    const [current, canonicalPath] = await Promise.all([lstat7(expected.path, { bigint: true }), realpath5(expected.path)]);
    if (current.isSymbolicLink() || !current.isDirectory() || current.dev !== expected.dev || current.ino !== expected.ino || canonicalPath !== expected.canonicalPath || process.platform !== "win32" && modeBits2(current) !== PRIVATE_DIRECTORY_MODE2) {
      throw new Error(`suggestion store directory changed during access: ${expected.path}`);
    }
  }));
}
function validLockOwner(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const owner = value;
  return owner.v === 1 && typeof owner.pid === "number" && Number.isSafeInteger(owner.pid) && owner.pid > 0 && typeof owner.token === "string" && /^[0-9a-f]{64}$/.test(owner.token) && typeof owner.createdAt === "number" && Number.isFinite(owner.createdAt);
}
async function createLockOwner(lock, token) {
  const path = join6(lock.path, LOCK_OWNER_FILE);
  const bytes = Buffer.from(`${JSON.stringify({ v: 1, pid: process.pid, token, createdAt: Date.now() })}
`, "utf8");
  await assertPrivateDirectoriesStable2([lock]);
  const handle = await open9(
    path,
    constants9.O_WRONLY | constants9.O_CREAT | constants9.O_EXCL | (constants9.O_NOFOLLOW ?? 0),
    PRIVATE_FILE_MODE3
  );
  try {
    await handle.writeFile(bytes);
    if (process.platform !== "win32") await handle.chmod(PRIVATE_FILE_MODE3);
    const [opened, requested] = await Promise.all([handle.stat({ bigint: true }), lstat7(path, { bigint: true })]);
    await assertPrivateDirectoriesStable2([lock]);
    if (!opened.isFile() || opened.nlink !== 1n || requested.isSymbolicLink() || !requested.isFile() || requested.nlink !== 1n || opened.size !== BigInt(bytes.byteLength) || !sameFileSnapshot(fileSnapshot(opened), fileSnapshot(requested)) || process.platform !== "win32" && (modeBits2(opened) !== PRIVATE_FILE_MODE3 || modeBits2(requested) !== PRIVATE_FILE_MODE3)) {
      throw new Error(`suggestion store lock owner changed while creating: ${path}`);
    }
    return { path, snapshot: fileSnapshot(opened) };
  } finally {
    await handle.close();
  }
}
async function inspectLockOwner(lock) {
  const path = join6(lock.path, LOCK_OWNER_FILE);
  let requested;
  try {
    requested = await lstat7(path, { bigint: true });
  } catch (error) {
    if (errno(error) === "ENOENT") return void 0;
    throw error;
  }
  if (requested.isSymbolicLink() || !requested.isFile()) throw new Error(`suggestion store lock owner must be a regular, non-symlink file: ${path}`);
  if (requested.nlink !== 1n) throw new Error(`suggestion store lock owner must have exactly one hard link: ${path}`);
  if (requested.size > BigInt(MAX_LOCK_OWNER_BYTES)) throw new Error(`suggestion store lock owner exceeds ${MAX_LOCK_OWNER_BYTES} bytes: ${path}`);
  await assertPrivateDirectoriesStable2([lock]);
  const handle = await open9(path, constants9.O_RDONLY | (constants9.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || opened.size > BigInt(MAX_LOCK_OWNER_BYTES) || !sameFileSnapshot(fileSnapshot(requested), fileSnapshot(opened))) {
      throw new Error(`suggestion store lock owner changed while opening: ${path}`);
    }
    const expected = fileSnapshot(opened);
    const bytes = Buffer.allocUnsafe(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const [after, pathAfter] = await Promise.all([handle.stat({ bigint: true }), lstat7(path, { bigint: true })]);
    await assertPrivateDirectoriesStable2([lock]);
    if (offset !== bytes.length || after.nlink !== 1n || pathAfter.isSymbolicLink() || !pathAfter.isFile() || pathAfter.nlink !== 1n || !sameFileSnapshot(expected, fileSnapshot(after)) || !sameFileSnapshot(expected, fileSnapshot(pathAfter))) {
      throw new Error(`suggestion store lock owner changed while reading: ${path}`);
    }
    let value;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      void error;
    }
    return {
      identity: { path, snapshot: expected },
      ...validLockOwner(value) ? { owner: value } : {}
    };
  } finally {
    await handle.close();
  }
}
function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errno(error) === "EPERM";
  }
}
async function assertLockOwned(guard) {
  await assertPrivateDirectoriesStable2([guard.parent, guard.lock]);
  const inspected = await inspectLockOwner(guard.lock);
  if (!inspected?.owner || !sameFileSnapshot(guard.owner.snapshot, inspected.identity.snapshot) || inspected.owner.pid !== guard.pid || inspected.owner.token !== guard.token) {
    throw new Error(`suggestion store lock ownership lost: ${guard.lock.path}`);
  }
}
async function unlinkExactPrivateFile(identity, label) {
  const current = await lstat7(identity.path, { bigint: true });
  if (current.isSymbolicLink() || !current.isFile() || current.nlink !== 1n || !sameFileSnapshot(identity.snapshot, fileSnapshot(current))) {
    throw new Error(`${label} changed before removal: ${identity.path}`);
  }
  await unlink2(identity.path);
}
async function breakStaleSuggestionLock(parent, lock, inspected) {
  if (inspected?.owner && processIsAlive(inspected.owner.pid)) return false;
  await assertPrivateDirectoriesStable2([parent, lock]);
  if (inspected) await unlinkExactPrivateFile(inspected.identity, "suggestion store lock owner");
  await assertPrivateDirectoriesStable2([parent, lock]);
  await rmdir(lock.path);
  await assertPrivateDirectoriesStable2([parent]);
  return true;
}
async function readPrivateSuggestionStore(path, directories) {
  let requested;
  try {
    requested = await lstat7(path, { bigint: true });
  } catch (error) {
    if (errno(error) === "ENOENT") return void 0;
    throw error;
  }
  if (requested.isSymbolicLink()) throw new Error(`suggestion store must not be a symbolic link: ${path}`);
  if (!requested.isFile()) throw new Error(`suggestion store must be a regular file: ${path}`);
  if (requested.nlink !== 1n) throw new Error(`suggestion store must have exactly one hard link: ${path}`);
  if (requested.size > BigInt(MAX_SUGGESTION_STORE_BYTES)) {
    throw new Error(`suggestion store exceeds ${MAX_SUGGESTION_STORE_BYTES} bytes: ${path}`);
  }
  await assertPrivateDirectoriesStable2(directories);
  const handle = await open9(path, constants9.O_RDONLY | (constants9.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !sameInode3(requested, opened) || opened.size > BigInt(MAX_SUGGESTION_STORE_BYTES)) {
      throw new Error(`suggestion store changed while opening: ${path}`);
    }
    if (process.platform !== "win32" && modeBits2(opened) !== PRIVATE_FILE_MODE3) await handle.chmod(PRIVATE_FILE_MODE3);
    const [secured, requestedAfter] = await Promise.all([handle.stat({ bigint: true }), lstat7(path, { bigint: true })]);
    if (!secured.isFile() || requestedAfter.isSymbolicLink() || !requestedAfter.isFile() || secured.nlink !== 1n || requestedAfter.nlink !== 1n || !sameInode3(secured, requestedAfter) || secured.size > BigInt(MAX_SUGGESTION_STORE_BYTES) || process.platform !== "win32" && (modeBits2(secured) !== PRIVATE_FILE_MODE3 || modeBits2(requestedAfter) !== PRIVATE_FILE_MODE3)) {
      throw new Error(`suggestion store changed while securing: ${path}`);
    }
    const expected = fileSnapshot(secured);
    const buffer = Buffer.allocUnsafe(Number(secured.size));
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const [after, pathAfter] = await Promise.all([handle.stat({ bigint: true }), lstat7(path, { bigint: true })]);
    await assertPrivateDirectoriesStable2(directories);
    if (offset !== buffer.length || pathAfter.isSymbolicLink() || !pathAfter.isFile() || after.nlink !== 1n || pathAfter.nlink !== 1n || !sameFileSnapshot(expected, fileSnapshot(after)) || !sameFileSnapshot(expected, fileSnapshot(pathAfter))) {
      throw new Error(`suggestion store changed while reading: ${path}`);
    }
    return buffer;
  } finally {
    await handle.close();
  }
}
async function appendPrivateSuggestionRecord(path, record2, directories, assertOwnership) {
  const recordBytes = Buffer.from(`${JSON.stringify(record2)}
`, "utf8");
  if (recordBytes.byteLength - 1 > MAX_SUGGESTION_RECORD_BYTES) {
    throw new Error(`suggestion record exceeds ${MAX_SUGGESTION_RECORD_BYTES} bytes`);
  }
  let requested;
  try {
    requested = await lstat7(path, { bigint: true });
  } catch (error) {
    if (errno(error) !== "ENOENT") throw error;
  }
  if (requested?.isSymbolicLink()) throw new Error(`suggestion store must not be a symbolic link: ${path}`);
  if (requested && !requested.isFile()) throw new Error(`suggestion store must be a regular file: ${path}`);
  if (requested && requested.nlink !== 1n) throw new Error(`suggestion store must have exactly one hard link: ${path}`);
  await assertPrivateDirectoriesStable2(directories);
  const createFlags = requested ? 0 : constants9.O_CREAT | constants9.O_EXCL;
  const handle = await open9(
    path,
    constants9.O_RDWR | constants9.O_APPEND | createFlags | (constants9.O_NOFOLLOW ?? 0),
    PRIVATE_FILE_MODE3
  );
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || requested && !sameInode3(requested, opened)) {
      throw new Error(`suggestion store changed while opening: ${path}`);
    }
    if (process.platform !== "win32" && modeBits2(opened) !== PRIVATE_FILE_MODE3) await handle.chmod(PRIVATE_FILE_MODE3);
    const [secured, pathBeforeWrite] = await Promise.all([handle.stat({ bigint: true }), lstat7(path, { bigint: true })]);
    if (!secured.isFile() || pathBeforeWrite.isSymbolicLink() || !pathBeforeWrite.isFile() || secured.nlink !== 1n || pathBeforeWrite.nlink !== 1n || !sameInode3(secured, pathBeforeWrite) || process.platform !== "win32" && (modeBits2(secured) !== PRIVATE_FILE_MODE3 || modeBits2(pathBeforeWrite) !== PRIVATE_FILE_MODE3)) {
      throw new Error(`suggestion store changed before append: ${path}`);
    }
    let needsSeparator = false;
    if (secured.size > 0n) {
      const tail = Buffer.allocUnsafe(1);
      const result = await handle.read(tail, 0, 1, Number(secured.size - 1n));
      if (result.bytesRead !== 1) throw new Error(`suggestion store changed while inspecting its tail: ${path}`);
      needsSeparator = tail[0] !== 10;
    }
    const bytes = needsSeparator ? Buffer.concat([Buffer.from("\n"), recordBytes]) : recordBytes;
    if (secured.size + BigInt(bytes.byteLength) > BigInt(MAX_SUGGESTION_STORE_BYTES)) {
      throw new Error(`suggestion store exceeds ${MAX_SUGGESTION_STORE_BYTES} bytes: ${path}`);
    }
    const beforeWrite = fileSnapshot(secured);
    const [tailAfter, pathAfterTail] = await Promise.all([handle.stat({ bigint: true }), lstat7(path, { bigint: true })]);
    if (pathAfterTail.isSymbolicLink() || !pathAfterTail.isFile() || tailAfter.nlink !== 1n || pathAfterTail.nlink !== 1n || !sameFileSnapshot(beforeWrite, fileSnapshot(tailAfter)) || !sameFileSnapshot(beforeWrite, fileSnapshot(pathAfterTail))) {
      throw new Error(`suggestion store changed while inspecting its tail: ${path}`);
    }
    const expectedSize = secured.size + BigInt(bytes.byteLength);
    await assertPrivateDirectoriesStable2(directories);
    await assertOwnership();
    await handle.writeFile(bytes);
    await assertOwnership();
    const [after, pathAfter] = await Promise.all([handle.stat({ bigint: true }), lstat7(path, { bigint: true })]);
    await assertPrivateDirectoriesStable2(directories);
    if (!after.isFile() || pathAfter.isSymbolicLink() || !pathAfter.isFile() || after.nlink !== 1n || pathAfter.nlink !== 1n || !sameInode3(after, pathAfter) || after.size !== expectedSize || pathAfter.size !== expectedSize || process.platform !== "win32" && (modeBits2(after) !== PRIVATE_FILE_MODE3 || modeBits2(pathAfter) !== PRIVATE_FILE_MODE3)) {
      throw new Error(`suggestion store changed during append: ${path}`);
    }
  } finally {
    await handle.close();
  }
}
var PATCH_FIELDS = ["proposal", "application", "verificationReceipt", "kickoff", "effect"];
var ALLOWED_PATCH_FIELDS = {
  new: [],
  "kicked-off": ["kickoff"],
  proposed: ["proposal"],
  applied: ["application"],
  verified: ["verificationReceipt", "effect"],
  rejected: [],
  failed: ["kickoff"]
};
function recordMatchesFinding(record2, finding, source) {
  return record2.source === source && record2.scope === finding.scope && record2.ruleId === finding.ruleId && (record2.insightId ?? "") === (finding.insightId ?? "") && (record2.cohortFingerprint ?? record2.key?.cohortFingerprint ?? "") === (finding.cohortFingerprint ?? "") && JSON.stringify(normalizeSessionIds(record2.sessionIds)) === JSON.stringify(normalizeSessionIds(finding.sessionIds));
}
function sameEvidence(a, b) {
  const canonical = (v) => JSON.stringify(
    v,
    (_k, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([x], [y]) => x < y ? -1 : x > y ? 1 : 0)) : item
  );
  return canonical(a) === canonical(b);
}
function assertSafeFindingIdentity(finding) {
  const values = [finding.ruleId, finding.insightId, ...finding.sessionIds].filter((value) => typeof value === "string");
  if (values.some((value) => redactValue(value, { scrub: true }) !== value)) {
    throw new Error("suggestion identity contains sensitive material; redact the identifier before creating it");
  }
}
function lifecycleError(to, message) {
  return new Error(`invalid transition patch for ${to}: ${message}`);
}
function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function safeReviewedFile(value) {
  return nonEmptyString(value) && reviewedPathViolation(value) === void 0 && canonicalReviewedPath(value) === value;
}
function hasUniqueReviewedFiles(files2) {
  const keys = files2.map((file) => reviewedPathKey(file));
  return keys.every((key) => key !== void 0) && new Set(keys).size === keys.length;
}
function stringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function isPersistedSuggestionRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record2 = value;
  if (typeof record2.id !== "string" || !isSuggestionId(record2.id) || record2.v !== 1 && record2.v !== 2 || typeof record2.createdAt !== "number" || !Number.isFinite(record2.createdAt) || record2.source !== "report" && record2.source !== "skill" || record2.scope !== "session" && record2.scope !== "repo" && record2.scope !== "global" || !stringArray(record2.sessionIds) || !nonEmptyString(record2.ruleId) || typeof record2.title !== "string" || !record2.evidence || typeof record2.evidence !== "object" || Array.isArray(record2.evidence) || typeof record2.status !== "string" || !Object.hasOwn(TRANSITIONS, record2.status) || typeof record2.statusAt !== "number" || !Number.isFinite(record2.statusAt) || record2.legacyIds !== void 0 && (!stringArray(record2.legacyIds) || !record2.legacyIds.every(isSuggestionId)) || record2.insightId !== void 0 && typeof record2.insightId !== "string" || record2.cohortFingerprint !== void 0 && typeof record2.cohortFingerprint !== "string") {
    return false;
  }
  if (record2.v === 2) {
    const key = record2.key;
    if (!key || typeof key !== "object" || key.v !== 2 || key.source !== "report" && key.source !== "skill" || key.scope !== "session" && key.scope !== "repo" && key.scope !== "global" || !nonEmptyString(key.ruleId) || !stringArray(key.sessionIds) || key.insightId !== void 0 && typeof key.insightId !== "string" || key.cohortFingerprint !== void 0 && typeof key.cohortFingerprint !== "string") {
      return false;
    }
  }
  return true;
}
function assertProposal(value, to) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw lifecycleError(to, "proposal is required");
  const proposal = value;
  if (!nonEmptyString(proposal.title) || !nonEmptyString(proposal.change) || !nonEmptyString(proposal.proposalPath)) {
    throw lifecycleError(to, "proposal must include title, change, and proposalPath");
  }
  if (proposal.effort !== "S" && proposal.effort !== "M" && proposal.effort !== "L") {
    throw lifecycleError(to, "proposal effort must be S, M, or L");
  }
}
function assertStructuredProposal(value, to) {
  assertProposal(value, to);
  if (value.v !== 1 || !nonEmptyString(value.manifestPath) || !value.changeClass || !isChangeClass(value.changeClass) || !nonEmptyString(value.evidence) || !nonEmptyString(value.expectedEffect) || !nonEmptyString(value.risk) || !nonEmptyString(value.verification) || !value.workspace || !isAbsolute4(value.workspace.cwd) || !/^\d+$/.test(value.workspace.device) || !/^\d+$/.test(value.workspace.inode) || !Array.isArray(value.files) || value.files.length === 0 || value.files.length > 64 || !value.files.every(safeReviewedFile) || !hasUniqueReviewedFiles(value.files) || !proposalSourcesAreCanonical(value.sources) || !Array.isArray(value.verificationChecks) || value.verificationChecks.length === 0 || value.verificationChecks.length > 32 || !value.verificationChecks.every(
    (check) => check && typeof check === "object" && SUGGESTION_VERIFICATION_METRICS.includes(check.metric) && SUGGESTION_VERIFICATION_COMPARISONS.includes(check.comparison)
  ) || !hasUniqueVerificationIntents(value.verificationChecks)) {
    throw lifecycleError(to, "a structured proposal with a manifest, reviewed files, and bounded unique verificationChecks is required");
  }
}
function assertApplication(value, to) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw lifecycleError(to, "application receipt is required");
  const application = value;
  if (application.v !== 1 || !nonEmptyString(application.summary) || !nonEmptyString(application.receiptPath) || !Array.isArray(application.files) || application.files.length === 0 || application.files.length > 64 || !application.files.every(safeReviewedFile) || !hasUniqueReviewedFiles(application.files) || !Array.isArray(application.checks) || application.checks.length === 0 || application.checks.length > 32 || !application.checks.every(
    (check) => check && typeof check === "object" && check.ok === true && nonEmptyString(check.name) && (check.command === void 0 || nonEmptyString(check.command))
  )) {
    throw lifecycleError(to, "application receipt must be structured, name changed files, and contain successful checks");
  }
}
function assertVerification(value, to) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw lifecycleError(to, "verification receipt is required");
  const verification = value;
  if (verification.v !== 1 || !nonEmptyString(verification.summary) || !nonEmptyString(verification.receiptPath) || !Array.isArray(verification.measuredSessionIds) || verification.measuredSessionIds.length === 0 || verification.measuredSessionIds.length > 50 || !verification.measuredSessionIds.every(nonEmptyString) || new Set(verification.measuredSessionIds).size !== verification.measuredSessionIds.length || !Array.isArray(verification.checks) || verification.checks.length === 0 || verification.checks.length > 32 || !verification.checks.every(
    (check) => check && typeof check === "object" && check.ok === true && nonEmptyString(check.name) && SUGGESTION_VERIFICATION_METRICS.includes(check.metric) && SUGGESTION_VERIFICATION_COMPARISONS.includes(check.comparison) && typeof check.before === "number" && Number.isFinite(check.before) && typeof check.after === "number" && Number.isFinite(check.after) && nonEmptyString(check.evidence)
  )) {
    throw lifecycleError(to, "verification receipt must be structured and contain measured sessions and successful checks");
  }
  if (!hasUniqueVerificationIntents(verification.checks) || verification.checks.some((check) => check.name !== verificationCheckName(check)) || verification.summary !== verificationReceiptSummary(verification.checks)) {
    throw lifecycleError(to, "verification receipt summary and check names must be deterministic from unique metric/comparison pairs");
  }
}
function assertVerificationEffect(value, receipt, to) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw lifecycleError(to, "computed verification effect is required");
  const effect = value;
  if (!effect.before || typeof effect.before !== "object" || Array.isArray(effect.before) || !effect.after || typeof effect.after !== "object" || Array.isArray(effect.after)) {
    throw lifecycleError(to, "computed verification effect must contain before and after maps");
  }
  if (!Array.isArray(effect.measuredSessionIds) || JSON.stringify(effect.measuredSessionIds) !== JSON.stringify(receipt.measuredSessionIds)) {
    throw lifecycleError(to, "verification effect session ids must exactly match the receipt");
  }
  const expectedBefore = Object.fromEntries(receipt.checks.map((check) => [check.metric, check.before]));
  const expectedAfter = Object.fromEntries(receipt.checks.map((check) => [check.metric, check.after]));
  const canonical = (record2) => JSON.stringify(Object.entries(record2).sort(([a], [b]) => a.localeCompare(b)));
  if (canonical(effect.before) !== canonical(expectedBefore) || canonical(effect.after) !== canonical(expectedAfter)) {
    throw lifecycleError(to, "verification effect values must exactly match the computed receipt checks");
  }
}
function validateTransitionPatch(current, to, rawPatch) {
  if (rawPatch !== void 0 && (!rawPatch || typeof rawPatch !== "object" || Array.isArray(rawPatch))) {
    throw lifecycleError(to, "patch must be an object");
  }
  const patch = rawPatch ?? {};
  const keys = Object.keys(patch);
  const unknown = keys.find((key) => !PATCH_FIELDS.includes(key));
  if (unknown) throw lifecycleError(to, `field "${unknown}" is not a lifecycle artifact`);
  const allowed = ALLOWED_PATCH_FIELDS[to];
  const unrelated = keys.find((key) => !allowed.includes(key));
  if (unrelated) throw lifecycleError(to, `field "${unrelated}" is not valid for this transition`);
  if (to === "proposed") {
    assertProposal(patch.proposal, to);
    if (patch.proposal.v === 1) assertStructuredProposal(patch.proposal, to);
  } else if (to === "applied") {
    if (current.scope === "global") {
      throw lifecycleError(to, "global suggestions cannot be applied; create a repo- or session-scoped suggestion for a concrete change instead");
    }
    assertStructuredProposal(current.proposal, to);
    assertApplication(patch.application, to);
    const reviewed = [...new Set(current.proposal.files)].sort();
    const changed = [...new Set(patch.application.files)].sort();
    if (JSON.stringify(reviewed) !== JSON.stringify(changed)) {
      throw lifecycleError(to, "application files must exactly match the reviewed proposal files");
    }
  } else if (to === "verified") {
    if (current.scope !== "session") {
      throw lifecycleError(to, "repo/global suggestions cannot be verified; verify a session-scoped suggestion against later supported sessions instead");
    }
    assertStructuredProposal(current.proposal, to);
    assertApplication(current.application, to);
    assertVerification(patch.verificationReceipt, to);
    if (!sameVerificationIntentSequence(current.proposal.verificationChecks, patch.verificationReceipt.checks)) {
      throw lifecycleError(to, "verification receipt checks must exactly match the reviewed proposal verificationChecks");
    }
    assertVerificationEffect(patch.effect, patch.verificationReceipt, to);
  }
  return patch;
}
var SuggestionStore = class {
  path;
  proposalsDir;
  now;
  /** in-process write queue: mutations run strictly one after another */
  chain = Promise.resolve();
  constructor(o = {}) {
    const home = o.home ?? oranguHome();
    this.path = join6(home, "suggestions.jsonl");
    this.proposalsDir = join6(home, "proposals");
    this.now = o.now ?? Date.now;
  }
  get lockPath() {
    return this.path + ".lock";
  }
  /** Atomic directory lock with token/PID ownership; only dead stale owners may be broken. */
  async acquireLock() {
    const parent = await ensurePrivateDirectory2(dirname4(this.path), "suggestion store directory");
    const t0 = Date.now();
    const token = randomBytes2(32).toString("hex");
    for (; ; ) {
      let created = false;
      try {
        await mkdir2(this.lockPath, { mode: PRIVATE_DIRECTORY_MODE2 });
        created = true;
      } catch (error) {
        if (errno(error) !== "EEXIST") throw error;
      }
      if (created) {
        let lock;
        let guard;
        try {
          lock = await securePrivateDirectory(this.lockPath, "suggestion store lock");
          const owner = await createLockOwner(lock, token);
          guard = { parent, lock, owner, pid: process.pid, token };
          await assertLockOwned(guard);
          return guard;
        } catch (error) {
          if (guard) await this.releaseLock(guard);
          throw error;
        }
      }
      let held;
      try {
        held = await secureExistingPrivateDirectory(this.lockPath, "suggestion store lock");
        if (!held) continue;
        const st = await lstat7(this.lockPath);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          await assertPrivateDirectoriesStable2([parent, held]);
          const inspected = await inspectLockOwner(held);
          if (await breakStaleSuggestionLock(parent, held, inspected)) continue;
        }
      } catch (error) {
        if (errno(error) === "ENOENT") continue;
        throw error;
      }
      if (Date.now() - t0 > LOCK_TIMEOUT_MS) throw new Error(`suggestion store lock timed out: ${this.lockPath}`);
      await new Promise((r) => setTimeout(r, 15));
    }
  }
  async releaseLock(guard) {
    try {
      await assertLockOwned(guard);
      await unlinkExactPrivateFile(guard.owner, "suggestion store lock owner");
      await assertPrivateDirectoriesStable2([guard.parent, guard.lock]);
      await rmdir(this.lockPath);
      await assertPrivateDirectoriesStable2([guard.parent]);
    } catch (error) {
      void error;
    }
  }
  /** every mutation = in-process queue → cross-process lock → replay+validate+append inside */
  serialized(fn) {
    const run = async () => {
      const guard = await this.acquireLock();
      try {
        await assertLockOwned(guard);
        const result = await fn(guard);
        await assertLockOwned(guard);
        return result;
      } finally {
        await this.releaseLock(guard);
      }
    };
    const p = this.chain.then(run, run);
    this.chain = p.then(
      () => void 0,
      () => void 0
    );
    return p;
  }
  /**
   * Replay the log; last line per canonical id wins; corrupt lines are skipped.
   * A migrated v2 record is also indexed by each legacy id so old links and CLI
   * commands keep resolving without duplicating it in `all()`.
   */
  async replay(parent) {
    const canonical = /* @__PURE__ */ new Map();
    const root = parent ?? await secureExistingPrivateDirectory(dirname4(this.path), "suggestion store directory");
    if (!root) return canonical;
    await assertPrivateDirectoriesStable2([root]);
    const proposals = await secureExistingPrivateDirectory(this.proposalsDir, "suggestion proposals directory");
    const directories = proposals ? [root, proposals] : [root];
    const bytes = await readPrivateSuggestionStore(this.path, directories);
    if (bytes === void 0) return canonical;
    let offset = 0;
    let lines = 0;
    while (offset < bytes.length) {
      lines++;
      if (lines > MAX_SUGGESTION_STORE_LINES) {
        throw new Error(`suggestion store exceeds ${MAX_SUGGESTION_STORE_LINES} lines: ${this.path}`);
      }
      const newline = bytes.indexOf(10, offset);
      const end = newline === -1 ? bytes.length : newline;
      if (end - offset > MAX_SUGGESTION_RECORD_BYTES) {
        throw new Error(`suggestion store record exceeds ${MAX_SUGGESTION_RECORD_BYTES} bytes: ${this.path}`);
      }
      if (end > offset) {
        const trimmed = bytes.toString("utf8", offset, end).trim();
        if (trimmed) {
          try {
            const rec = JSON.parse(trimmed);
            if (isPersistedSuggestionRecord(rec)) canonical.set(rec.id, rec);
          } catch (error) {
            void error;
          }
        }
      }
      if (newline === -1) break;
      offset = newline + 1;
    }
    const byId = new Map(canonical);
    for (const rec of canonical.values()) {
      for (const legacyId of rec.legacyIds ?? []) {
        if (isSuggestionId(legacyId)) byId.set(legacyId, rec);
      }
    }
    return byId;
  }
  async append(rec, guard) {
    await assertLockOwned(guard);
    const parent = guard.parent;
    const proposals = await ensurePrivateDirectory2(this.proposalsDir, "suggestion proposals directory");
    await appendPrivateSuggestionRecord(this.path, rec, [parent, proposals], () => assertLockOwned(guard));
  }
  async all() {
    const unique = /* @__PURE__ */ new Map();
    const records = await this.replay();
    for (const rec of records.values()) unique.set(rec.id, rec);
    return [...unique.values()].sort((a, b) => b.statusAt - a.statusAt);
  }
  async get(id) {
    return (await this.replay()).get(id);
  }
  /**
   * Create-or-get: a re-click refreshes a still-new record; once lifecycle work
   * starts, statusAt remains the transition timestamp. An explicit file-handoff
   * id must hash to the canonical identity or the exact legacy report identity.
   */
  async upsertNew(f, source, explicitId) {
    return this.serialized((guard) => this.upsertNewLocked(f, source, explicitId, guard));
  }
  async upsertNewLocked(f, source, explicitId, guard) {
    assertSafeFindingIdentity(f);
    const key = suggestionKey(f, source);
    const canonicalId = suggestionIdV2(key);
    const legacyId = suggestionId(source, f.ruleId, f.sessionIds);
    const acceptsLegacyId = source === "report" && !f.cohortFingerprint;
    if (explicitId && explicitId !== canonicalId && !(acceptsLegacyId && explicitId === legacyId)) {
      throw new Error(`suggestion id identity mismatch: expected ${canonicalId}${acceptsLegacyId ? ` or legacy ${legacyId}` : ""}, got ${explicitId}`);
    }
    const id = explicitId ?? canonicalId;
    const records = await this.replay(guard.parent);
    const existing = records.get(id);
    const ts2 = this.now();
    if (existing) {
      if (!recordMatchesFinding(existing, f, source)) {
        throw new Error(`suggestion id identity mismatch: ${id} belongs to a different finding`);
      }
      if (existing.status !== "new") return { record: existing, created: false };
      if (existing.title === f.title && sameEvidence(existing.evidence, f.evidence)) return { record: existing, created: false };
      const refreshed = { ...existing, title: f.title, evidence: f.evidence, statusAt: ts2 };
      await this.append(refreshed, guard);
      return { record: refreshed, created: false };
    }
    if (id === canonicalId && !f.cohortFingerprint) {
      const legacy = records.get(legacyId);
      const sameLegacyFinding = legacy?.v === 1 && recordMatchesFinding(legacy, f, source);
      if (legacy && sameLegacyFinding) {
        const migrated = {
          ...legacy,
          id: canonicalId,
          v: 2,
          key,
          legacyIds: [.../* @__PURE__ */ new Set([...legacy.legacyIds ?? [], legacy.id])].sort(),
          source,
          scope: f.scope,
          sessionIds: key.sessionIds,
          ruleId: f.ruleId,
          title: f.title,
          ...f.insightId ? { insightId: f.insightId } : {},
          ...f.cohortFingerprint ? { cohortFingerprint: f.cohortFingerprint } : {},
          evidence: f.evidence,
          // Migration changes identity, not lifecycle state. Preserve the
          // applied timestamp because later verification is ordered against it.
          statusAt: Number.isFinite(legacy.statusAt) && legacy.statusAt > 0 ? legacy.statusAt : ts2
        };
        await this.append(migrated, guard);
        return { record: migrated, created: false };
      }
    }
    const isCanonical = id === canonicalId;
    const record2 = {
      id,
      v: isCanonical ? 2 : 1,
      ...isCanonical ? { key } : {},
      createdAt: ts2,
      source,
      scope: f.scope,
      sessionIds: isCanonical ? key.sessionIds : [...f.sessionIds].sort(),
      ruleId: f.ruleId,
      title: f.title,
      ...f.insightId ? { insightId: f.insightId } : {},
      ...f.cohortFingerprint ? { cohortFingerprint: f.cohortFingerprint } : {},
      evidence: f.evidence,
      status: "new",
      statusAt: ts2
    };
    await this.append(record2, guard);
    return { record: record2, created: true };
  }
  async transition(id, to, patch) {
    return this.serialized((guard) => this.transitionLocked(id, to, guard, patch));
  }
  async transitionLocked(id, to, guard, patch) {
    const current = (await this.replay(guard.parent)).get(id);
    if (!current) throw new Error(`suggestion ${id} not found in ${this.path}`);
    const allowed = TRANSITIONS[current.status] ?? [];
    if (!allowed.includes(to)) {
      throw new Error(`illegal transition ${current.status} \u2192 ${to} for ${id} (allowed: ${allowed.join(", ") || "none"})`);
    }
    const safePatch = validateTransitionPatch(current, to, patch);
    const next = {
      ...current,
      ...safePatch,
      ...to === "verified" ? { verificationTrust: "computed-v1" } : {},
      status: to,
      statusAt: this.now()
    };
    await this.append(next, guard);
    return next;
  }
};

// src/cli/next-step.ts
async function persistNextStep(a, redact, deps = {}) {
  const top = a.insights.find((i) => i.id === a.summary.topInsightIds[0]) ?? a.insights[0];
  if (!top) return {};
  const row2 = planRowForInsight(top, a.session.id);
  const title = redact ? redactValue(row2.title, { scrub: redact.scrub, stripPaths: redact.stripPaths }) : row2.title;
  const finding = findingForRow({ ...row2, title }, "session");
  try {
    const store = deps.store ? deps.store() : new SuggestionStore();
    const { record: record2 } = await store.upsertNew(finding, "report");
    return { finding: title, next: kickoffCommands(record2, "serve").claude };
  } catch (e) {
    const key = suggestionKey(finding, "report");
    const id = suggestionIdV2(key);
    const reason = (e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "unknown error";
    return {
      finding: title,
      storeNote: reason,
      next: kickoffCommands({ id, ...finding, sessionIds: key.sessionIds, source: "report" }, "file").claude
    };
  }
}

// src/serve/server.ts
import { randomBytes as randomBytes3, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { cpus as cpus2 } from "node:os";

// src/serve/api.ts
import { homedir as homedir3 } from "node:os";

// src/harness/collect.ts
import { readdir as readdir2, readFile, stat as stat4 } from "node:fs/promises";
import { basename as basename7, join as join7 } from "node:path";
var DEFAULT_MAX_FILE_BYTES = 1e6;
var MAX_WALK_DEPTH = 6;
var CLAUDE_JSON_KEYS = ["mcpServers", "projects", "skillUsage", "pluginUsage"];
var CLAUDE_JSON_PROJECT_KEYS = ["mcpServers", "enabledMcpjsonServers", "disabledMcpjsonServers"];
function reasonOf(e) {
  const code = e?.code;
  if (code === "ENOENT" || code === "ENOTDIR") return "enoent";
  if (code === "EACCES" || code === "EPERM") return "eacces";
  return "other";
}
function cleanPath(ctx, p) {
  return redactValue(p, ctx.home ? { home: ctx.home } : {});
}
function cleanName(s) {
  return scrubStr(s);
}
function mark(ctx, path, reason) {
  const p = cleanPath(ctx, path);
  const key = `${p}::${reason}`;
  if (ctx.seen.has(key)) return;
  ctx.seen.add(key);
  ctx.unreadable.push({ path: p, reason });
}
async function readText(ctx, path) {
  let size;
  try {
    const st = await stat4(path);
    if (!st.isFile()) return null;
    size = st.size;
  } catch (e) {
    const r = reasonOf(e);
    if (r !== "enoent") mark(ctx, path, r);
    return null;
  }
  if (size > ctx.maxFileBytes) {
    mark(ctx, path, "too-large");
    return null;
  }
  try {
    const text2 = await readFile(path, "utf8");
    ctx.filesRead++;
    ctx.bytesRead += size;
    return text2;
  } catch (e) {
    mark(ctx, path, reasonOf(e));
    return null;
  }
}
async function readJson(ctx, path) {
  const text2 = await readText(ctx, path);
  if (text2 === null) return null;
  try {
    const v = JSON.parse(text2);
    if (!v || typeof v !== "object" || Array.isArray(v)) {
      mark(ctx, path, "bad-json");
      return null;
    }
    return v;
  } catch {
    mark(ctx, path, "bad-json");
    return null;
  }
}
async function listDir(ctx, path, required = false) {
  try {
    const entries = await readdir2(path, { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, dir: e.isDirectory() })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  } catch (e) {
    const r = reasonOf(e);
    if (r !== "enoent" || required) mark(ctx, path, r);
    return [];
  }
}
async function walkMarkdown(ctx, dir, depth = 0) {
  if (depth > MAX_WALK_DEPTH) return [];
  const out3 = [];
  for (const e of await listDir(ctx, dir)) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const p = join7(dir, e.name);
    if (e.dir) out3.push(...await walkMarkdown(ctx, p, depth + 1));
    else if (e.name.endsWith(".md")) out3.push(p);
  }
  return out3;
}
async function isDir(path) {
  try {
    return (await stat4(path)).isDirectory();
  } catch {
    return false;
  }
}
var approxTokens2 = (bytes) => Math.ceil(bytes / 4);
function lineCount(text2) {
  if (text2 === "") return 0;
  const parts = text2.split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts.length;
}
function headingCount(text2) {
  let n2 = 0;
  for (const l of text2.split("\n")) if (/^#{1,6}\s/.test(l)) n2++;
  return n2;
}
function argv0Basename(command) {
  const first = command.trim().split(/\s+/)[0] ?? "";
  return basename7(first.replace(/^['"]|['"]$/g, ""));
}
var FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/;
function parseFrontmatter(text2) {
  const m = FRONTMATTER.exec(text2);
  if (!m) return { fm: {}, body: text2 };
  const fm = {};
  for (const raw of (m[1] ?? "").split(/\r?\n/)) {
    if (/^\s/.test(raw)) continue;
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim();
    if (val.length > 1 && (val.startsWith('"') && val.endsWith('"') || val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    fm[key] = val;
  }
  return { fm, body: text2.slice(m[0].length) };
}
function splitList(value) {
  if (value === void 0) return null;
  let s = value.trim();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  const out3 = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth <= 0) {
      const t2 = cur.trim();
      if (t2) out3.push(t2);
      cur = "";
      continue;
    }
    cur += ch;
  }
  const t = cur.trim();
  if (t) out3.push(t);
  return out3.map((x) => x.replace(/^['"]|['"]$/g, ""));
}
var asRecord = (v) => v && typeof v === "object" && !Array.isArray(v) ? v : null;
var asArray = (v) => Array.isArray(v) ? v : [];
var asString = (v) => typeof v === "string" && v ? v : void 0;
var asNumber = (v) => typeof v === "number" && Number.isFinite(v) ? v : 0;
var byKey = (pick) => (a, b) => {
  const x = pick(a);
  const y = pick(b);
  return x < y ? -1 : x > y ? 1 : 0;
};
function settingsEnv(raw) {
  const env = asRecord(raw["env"]);
  if (!env) return { count: 0, names: [] };
  const names = Object.keys(env).map(cleanName).sort();
  return { count: names.length, names };
}
function settingsHooks(raw) {
  const hooks = asRecord(raw["hooks"]);
  if (!hooks) return [];
  const out3 = [];
  for (const event of Object.keys(hooks).sort()) {
    const matchers = asArray(hooks[event]);
    const names = /* @__PURE__ */ new Set();
    let commands = 0;
    for (const m of matchers) {
      for (const h of asArray(asRecord(m)?.["hooks"])) {
        const cmd = asString(asRecord(h)?.["command"]);
        if (cmd === void 0) continue;
        commands++;
        const b = argv0Basename(cmd);
        if (b) names.add(cleanName(b));
      }
    }
    out3.push({ event: cleanName(event), matchers: matchers.length, commands, commandBasenames: [...names].sort() });
  }
  return out3;
}
function enabledPluginKeys(raw) {
  const v = raw["enabledPlugins"];
  if (Array.isArray(v)) return v.filter((x) => typeof x === "string").map(cleanName).sort();
  const rec = asRecord(v);
  if (!rec) return [];
  return Object.keys(rec).filter((k) => rec[k] !== false).map(cleanName).sort();
}
function parseSettings(ctx, scope, file, raw) {
  const perms = asRecord(raw["permissions"]);
  return {
    scope,
    file: cleanPath(ctx, file),
    keys: Object.keys(raw).map(cleanName).sort(),
    ...asString(raw["model"]) ? { model: cleanName(asString(raw["model"])) } : {},
    ...asString(raw["effortLevel"]) ? { effortLevel: cleanName(asString(raw["effortLevel"])) } : {},
    permissions: {
      allow: asArray(perms?.["allow"]).length,
      deny: asArray(perms?.["deny"]).length,
      ask: asArray(perms?.["ask"]).length,
      ...asString(perms?.["defaultMode"]) ? { defaultMode: cleanName(asString(perms["defaultMode"])) } : {}
    },
    hooks: settingsHooks(raw),
    env: settingsEnv(raw),
    statusLine: raw["statusLine"] != null,
    ...typeof raw["cleanupPeriodDays"] === "number" ? { cleanupPeriodDays: raw["cleanupPeriodDays"] } : {},
    enabledPlugins: enabledPluginKeys(raw)
  };
}
async function readSkillDir(ctx, dir, origin, plugin) {
  const out3 = [];
  for (const e of await listDir(ctx, dir)) {
    if (!e.dir || e.name.startsWith(".")) continue;
    const file = join7(dir, e.name, "SKILL.md");
    const text2 = await readText(ctx, file);
    if (text2 === null) continue;
    const { fm, body } = parseFrontmatter(text2);
    const bytes = Buffer.byteLength(text2, "utf8");
    out3.push({
      name: cleanName(fm["name"] ?? e.name),
      origin,
      ...plugin ? { plugin: cleanName(plugin) } : {},
      file: cleanPath(ctx, file),
      bytes,
      approxTokens: approxTokens2(bytes),
      descriptionChars: (fm["description"] ?? "").length,
      allowedTools: splitList(fm["allowed-tools"] ?? fm["allowedTools"])?.map(cleanName) ?? null,
      bodyLines: lineCount(body),
      hasReferences: await isDir(join7(dir, e.name, "references"))
    });
  }
  return out3;
}
async function readAgentDir(ctx, dir, origin, plugin) {
  const out3 = [];
  for (const file of await walkMarkdown(ctx, dir)) {
    const text2 = await readText(ctx, file);
    if (text2 === null) continue;
    const { fm } = parseFrontmatter(text2);
    const bytes = Buffer.byteLength(text2, "utf8");
    out3.push({
      name: cleanName(fm["name"] ?? basename7(file, ".md")),
      origin,
      ...plugin ? { plugin: cleanName(plugin) } : {},
      file: cleanPath(ctx, file),
      bytes,
      approxTokens: approxTokens2(bytes),
      descriptionChars: (fm["description"] ?? "").length,
      ...fm["model"] ? { model: cleanName(fm["model"]) } : {},
      ...fm["effort"] ? { effort: cleanName(fm["effort"]) } : {},
      tools: splitList(fm["tools"])?.map(cleanName) ?? null,
      disallowedTools: splitList(fm["disallowedTools"] ?? fm["disallowed-tools"])?.map(cleanName) ?? null
    });
  }
  return out3;
}
async function readMemory(ctx, file, scope) {
  const text2 = await readText(ctx, file);
  if (text2 === null) return null;
  const bytes = Buffer.byteLength(text2, "utf8");
  return { scope, file: cleanPath(ctx, file), bytes, approxTokens: approxTokens2(bytes), lines: lineCount(text2), headings: headingCount(text2) };
}
function mcpFromRecord(rec, scope, enabled = true) {
  if (!rec) return [];
  const out3 = [];
  for (const name of Object.keys(rec).sort()) {
    const srv = asRecord(rec[name]);
    const command = asString(srv?.["command"]);
    const transport = asString(srv?.["type"]) ?? (asString(srv?.["url"]) ? "http" : command ? "stdio" : "unknown");
    out3.push({
      name: cleanName(name),
      scope,
      transport: cleanName(transport),
      ...command ? { commandBasename: cleanName(argv0Basename(command)) } : {},
      enabled
    });
  }
  return out3;
}
async function walkPlugin(ctx, installPath, key) {
  const skills = await readSkillDir(ctx, join7(installPath, "skills"), "plugin", key);
  const agents = await readAgentDir(ctx, join7(installPath, "agents"), "plugin", key);
  const commands = (await walkMarkdown(ctx, join7(installPath, "commands"))).length;
  let hooks = 0;
  const hooksJson = await readJson(ctx, join7(installPath, "hooks", "hooks.json"));
  const hookEvents = asRecord(hooksJson?.["hooks"]) ?? hooksJson;
  if (hookEvents) {
    for (const event of Object.keys(hookEvents)) {
      for (const m of asArray(hookEvents[event])) hooks += asArray(asRecord(m)?.["hooks"]).length;
    }
  }
  const mcpJson = await readJson(ctx, join7(installPath, ".mcp.json"));
  const mcpServers = mcpFromRecord(asRecord(mcpJson?.["mcpServers"]), "plugin");
  return { skills, agents, mcpServers, commands, hooks };
}
async function collectInventory(opts) {
  if (typeof opts.cwd !== "string" || typeof opts.home !== "string" || !Array.isArray(opts.roots)) {
    throw new TypeError("collectInventory: cwd and home must be strings and roots an array");
  }
  const ctx = {
    home: opts.home,
    maxFileBytes: opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    unreadable: [],
    seen: /* @__PURE__ */ new Set(),
    filesRead: 0,
    bytesRead: 0
  };
  const claudeMd = [];
  const settings = [];
  const skills = [];
  const agents = [];
  const plugins = [];
  const mcpServers = [];
  if (await isDir(opts.cwd)) {
    for (const name of ["CLAUDE.md", "AGENTS.md"]) {
      const m2 = await readMemory(ctx, join7(opts.cwd, name), "repo");
      if (m2) claudeMd.push(m2);
    }
    const dotClaude = join7(opts.cwd, ".claude");
    const m = await readMemory(ctx, join7(dotClaude, "CLAUDE.md"), "repo");
    if (m) claudeMd.push(m);
    for (const [file, scope] of [
      [join7(dotClaude, "settings.json"), "repo"],
      [join7(dotClaude, "settings.local.json"), "repo-local"]
    ]) {
      const raw = await readJson(ctx, file);
      if (raw) settings.push(parseSettings(ctx, scope, file, raw));
    }
    skills.push(...await readSkillDir(ctx, join7(dotClaude, "skills"), "repo"));
    agents.push(...await readAgentDir(ctx, join7(dotClaude, "agents"), "repo"));
    const mcpJson = await readJson(ctx, join7(opts.cwd, ".mcp.json"));
    mcpServers.push(...mcpFromRecord(asRecord(mcpJson?.["mcpServers"]), "repo-file"));
  } else {
    mark(ctx, opts.cwd, "enoent");
  }
  const liveRoots = [];
  for (const root of opts.roots) {
    if (!await isDir(root)) {
      try {
        await stat4(root);
        mark(ctx, root, "other");
      } catch (e) {
        mark(ctx, root, reasonOf(e));
      }
      continue;
    }
    liveRoots.push(root);
    const m = await readMemory(ctx, join7(root, "CLAUDE.md"), "global");
    if (m) claudeMd.push(m);
    for (const [file, scope] of [
      [join7(root, "settings.json"), "global"],
      [join7(root, "settings.local.json"), "global-local"]
    ]) {
      const raw = await readJson(ctx, file);
      if (raw) settings.push(parseSettings(ctx, scope, file, raw));
    }
    skills.push(...await readSkillDir(ctx, join7(root, "skills"), "global"));
    agents.push(...await readAgentDir(ctx, join7(root, "agents"), "global"));
  }
  const enabled = new Set(settings.flatMap((s) => s.enabledPlugins));
  for (const root of liveRoots) {
    const installed = await readJson(ctx, join7(root, "plugins", "installed_plugins.json"));
    const byName = asRecord(installed?.["plugins"]);
    if (!byName) continue;
    for (const key of Object.keys(byName).sort()) {
      const entry = asArray(byName[key]).map(asRecord).find((e) => e && asString(e["installPath"]));
      if (!entry) continue;
      const installPath = asString(entry["installPath"]);
      const at = key.lastIndexOf("@");
      const walk2 = await walkPlugin(ctx, installPath, key);
      skills.push(...walk2.skills);
      agents.push(...walk2.agents);
      mcpServers.push(...walk2.mcpServers);
      plugins.push({
        key: cleanName(key),
        name: cleanName(at > 0 ? key.slice(0, at) : key),
        marketplace: cleanName(at > 0 ? key.slice(at + 1) : ""),
        scope: cleanName(asString(entry["scope"]) ?? "unknown"),
        ...asString(entry["version"]) ? { version: cleanName(asString(entry["version"])) } : {},
        enabled: enabled.has(key),
        skills: walk2.skills.length,
        agents: walk2.agents.length,
        commands: walk2.commands,
        hooks: walk2.hooks,
        mcpServers: walk2.mcpServers.length
      });
    }
  }
  let usageCounters;
  const claudeJsonPath = join7(opts.home, ".claude.json");
  const rawClaudeJson = await readJson(ctx, claudeJsonPath);
  if (rawClaudeJson) {
    const picked = {};
    for (const k of CLAUDE_JSON_KEYS) if (k in rawClaudeJson) picked[k] = rawClaudeJson[k];
    mcpServers.push(...mcpFromRecord(asRecord(picked["mcpServers"]), "global"));
    const project = asRecord(asRecord(picked["projects"])?.[opts.cwd]);
    if (project) {
      const proj = {};
      for (const k of CLAUDE_JSON_PROJECT_KEYS) if (k in project) proj[k] = project[k];
      mcpServers.push(...mcpFromRecord(asRecord(proj["mcpServers"]), "project"));
      for (const [list, on] of [
        [asArray(proj["enabledMcpjsonServers"]), true],
        [asArray(proj["disabledMcpjsonServers"]), false]
      ]) {
        for (const raw of list) {
          const name = asString(raw);
          if (!name) continue;
          const clean = cleanName(name);
          const existing = mcpServers.filter((m) => m.name === clean);
          if (existing.length) for (const row2 of existing) row2.enabled = row2.enabled && on;
          else mcpServers.push({ name: clean, scope: "repo-file", transport: "unknown", enabled: on });
        }
      }
    }
    const skillUsage = asRecord(picked["skillUsage"]);
    const pluginUsage = asRecord(picked["pluginUsage"]);
    usageCounters = {
      skills: Object.keys(skillUsage ?? {}).sort().map((name) => ({ name: cleanName(name), usageCount: asNumber(asRecord(skillUsage[name])?.["usageCount"]), lastUsedAt: asNumber(asRecord(skillUsage[name])?.["lastUsedAt"]) })),
      plugins: Object.keys(pluginUsage ?? {}).sort().map((key) => ({ key: cleanName(key), usageCount: asNumber(asRecord(pluginUsage[key])?.["usageCount"]), lastUsedAt: asNumber(asRecord(pluginUsage[key])?.["lastUsedAt"]) }))
    };
  }
  claudeMd.sort((a, b) => a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  settings.sort((a, b) => a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  skills.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  agents.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  plugins.sort(byKey((p) => p.key));
  mcpServers.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0);
  ctx.unreadable.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0);
  return {
    claudeMd,
    settings,
    skills,
    agents,
    plugins,
    mcpServers,
    ...usageCounters ? { usageCounters } : {},
    totals: {
      filesRead: ctx.filesRead,
      bytesRead: ctx.bytesRead,
      claudeMdBytes: claudeMd.reduce((n2, m) => n2 + m.bytes, 0),
      claudeMdApproxTokens: claudeMd.reduce((n2, m) => n2 + m.approxTokens, 0),
      skills: skills.length,
      agents: agents.length,
      plugins: plugins.length,
      // distinct NAMES: one server declared by `.mcp.json` and named again by a toggle list is one server
      mcpServers: new Set(mcpServers.map((m) => m.name)).size,
      hookCommands: settings.reduce((n2, s) => n2 + s.hooks.reduce((k, h) => k + h.commands, 0), 0)
    },
    unreadable: ctx.unreadable
  };
}

// src/feedback/diagnostics.ts
import { arch, platform } from "node:os";
function osFamily(value) {
  if (value === "darwin") return "macOS";
  if (value === "win32") return "Windows";
  if (value === "linux") return "Linux";
  return "other";
}
function safeArch(value) {
  return value === "arm64" || value === "x64" ? value : "other";
}
function feedbackDiagnostics(version, context) {
  return {
    version,
    nodeMajor: process.versions.node.split(".")[0] ?? "unknown",
    osFamily: osFamily(platform()),
    arch: safeArch(arch()),
    context,
    surface: "localhost"
  };
}
function feedbackBootstrap(version) {
  const { context: _context, ...bootstrap } = feedbackDiagnostics(version, "app");
  return bootstrap;
}

// src/serve/http-security.ts
var HTML_ANTI_FRAMING_HEADERS = {
  "Content-Security-Policy": "frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer"
};

// src/serve/registry.ts
import { watch as fsWatch2 } from "node:fs";
import { stat as stat5 } from "node:fs/promises";
import { join as join8 } from "node:path";
var DEFAULT_MAX_LIVE = 8;
var LAST_EVENTS_MAX = 5;
var Registry = class {
  o;
  emitFn;
  nowFn;
  analyzeFn;
  readFn;
  minTickMs;
  maxLive;
  watched = /* @__PURE__ */ new Map();
  queue = [];
  running = 0;
  timers = [];
  watchers = [];
  stopped = false;
  rescanSoon;
  constructor(o, emit2) {
    this.o = o;
    this.emitFn = emit2;
    this.nowFn = o.now ?? Date.now;
    this.analyzeFn = o.analyze ?? analyzeSession;
    this.readFn = o.read;
    this.minTickMs = o.minTickMs ?? 500;
    this.maxLive = Math.max(1, o.opts.maxLive ?? DEFAULT_MAX_LIVE);
  }
  discoverOpts() {
    const s = this.o.opts;
    const d = {};
    if (s.roots && s.roots.length) d.roots = s.roots;
    else if (s.configDir) d.configDir = s.configDir;
    if (s.cwd) d.cwd = s.cwd;
    return d;
  }
  /** Start timers + fs watchers. Tests drive rescanOnce/pollOnce/markDirty directly instead. */
  async start() {
    await this.rescanOnce();
    const rescanMs = this.o.rescanMs ?? 1e4;
    const pollMs = this.o.pollMs ?? 1500;
    const t1 = setInterval(() => void this.rescanOnce().catch(() => {
    }), rescanMs);
    const t2 = setInterval(() => void this.pollOnce().catch(() => {
    }), pollMs);
    t1.unref?.();
    t2.unref?.();
    this.timers.push(t1, t2);
    const roots = this.o.opts.roots?.length ? this.o.opts.roots : this.o.opts.configDir ? [this.o.opts.configDir] : [];
    for (const root of roots) {
      try {
        const w = fsWatch2(join8(root, "projects"), { recursive: true }, (_ev, filename) => this.onFsEvent(String(filename ?? "")));
        this.watchers.push(w);
      } catch {
      }
    }
  }
  async stop() {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    if (this.rescanSoon) clearTimeout(this.rescanSoon);
    for (const w of this.watchers) w.close();
    this.timers = [];
    this.watchers = [];
    this.queue = [];
    for (const w of this.watched.values()) w.queued = false;
    await this.settle();
  }
  onFsEvent(filename) {
    for (const [id, w] of this.watched) {
      if (!w.tail) continue;
      if (filename.endsWith(`${id}.jsonl`) || filename.includes(`${id}/`) || filename.includes(`${id}\\`)) {
        this.markDirty(id);
        return;
      }
    }
    if (filename.endsWith(".jsonl") && !this.rescanSoon) {
      this.rescanSoon = setTimeout(() => {
        this.rescanSoon = void 0;
        void this.rescanOnce().catch(() => {
        });
      }, 500);
      this.rescanSoon.unref?.();
    }
  }
  /** Full discovery pass: newcomers, refreshed refs, badge changes, tailing set. */
  async rescanOnce() {
    const refs = await listSessions(this.discoverOpts());
    for (const ref of refs) {
      const existing = this.watched.get(ref.sessionId);
      if (!existing) {
        const { badge } = badgeFor(ref.mtimeMs, this.nowFn());
        const w = { ref, badge, dirty: false, queued: false, inFlight: false, lastTickMs: 0, pinned: false, force: false, seq: 0 };
        this.watched.set(ref.sessionId, w);
        this.emitFn({ type: "session-added", row: this.rowFor(w) });
      } else {
        const grown = ref.mtimeMs !== existing.ref.mtimeMs || ref.sizeBytes !== existing.ref.sizeBytes || ref.subagentFiles.length !== existing.ref.subagentFiles.length;
        existing.ref = ref;
        if (grown && existing.tail) this.markDirty(ref.sessionId);
      }
    }
    this.checkBadges();
    this.ensureTailing();
  }
  /** Cheap per-tailed-session stat poll (fallback for missed fs events) + badge recompute. */
  async pollOnce() {
    for (const [id, w] of this.watched) {
      if (!w.tail) continue;
      try {
        const st = await stat5(w.ref.path);
        if (st.size !== w.ref.sizeBytes || st.mtimeMs !== w.ref.mtimeMs) {
          w.ref.sizeBytes = st.size;
          w.ref.mtimeMs = st.mtimeMs;
          this.markDirty(id);
        }
      } catch {
      }
    }
    this.checkBadges();
    this.ensureTailing();
  }
  /** Recompute badges from mtime; emit session-live on change; queue the final tick on → ended. */
  checkBadges() {
    const now = this.nowFn();
    for (const [id, w] of this.watched) {
      const { badge, ageMs } = badgeFor(w.ref.mtimeMs, now);
      if (badge !== w.badge) {
        w.badge = badge;
        this.emitFn({ type: "session-live", id, badge, ageMs });
        if (badge === "ended" && w.tail) {
          w.force = true;
          this.markDirty(id);
        }
      }
    }
  }
  /** Keep the tailed set = top-maxLive candidates (badge ≠ ended ∪ pinned) by most-recent mtime. */
  ensureTailing() {
    const candidates = [...this.watched.values()].filter((w) => w.badge !== "ended" || w.pinned).sort((a, b) => b.ref.mtimeMs - a.ref.mtimeMs);
    const keep = new Set(candidates.slice(0, this.maxLive).map((w) => w.ref.sessionId));
    for (const [id, w] of this.watched) {
      if (keep.has(id) && !w.tail) {
        w.tail = newTailState(w.ref.path);
        this.markDirty(id);
      } else if (!keep.has(id) && w.tail && !w.force && !w.inFlight && !w.queued) {
        w.tail = void 0;
      }
    }
  }
  /** counts for the fleet header ("watching X of N") and tests */
  tailedIds() {
    return [...this.watched.entries()].filter(([, w]) => w.tail).map(([id]) => id);
  }
  markDirty(id) {
    const w = this.watched.get(id);
    if (!w || !w.tail) return;
    w.dirty = true;
    this.enqueue(id);
  }
  enqueue(id) {
    const w = this.watched.get(id);
    if (!w || w.queued || w.inFlight) return;
    w.queued = true;
    this.queue.push(id);
    this.pump();
  }
  pump() {
    while (!this.stopped && this.running < this.o.concurrency && this.queue.length) {
      const id = this.queue.shift();
      void this.runTick(id);
    }
  }
  async runTick(id) {
    const w = this.watched.get(id);
    if (!w || !w.tail) {
      if (w) w.queued = false;
      return;
    }
    w.queued = false;
    w.inFlight = true;
    this.running++;
    try {
      const wait = w.lastTickMs + this.minTickMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      w.lastTickMs = Date.now();
      w.dirty = false;
      await this.tickInner(w);
    } catch {
    } finally {
      w.inFlight = false;
      this.running--;
      if (w.badge === "ended" && !w.pinned) {
        w.force = false;
        w.tail = void 0;
        w.dirty = false;
      } else if (w.dirty && !this.stopped) this.enqueue(id);
      this.pump();
    }
  }
  /** public single-tick entry (PLAN): mark dirty and wait for the queue to drain this session */
  async tick(id) {
    this.markDirty(id);
    await this.settle();
  }
  /** wait until no tick is queued, scheduled or in flight (tests + shutdown) */
  async settle(timeoutMs = 5e3) {
    const t0 = Date.now();
    for (; ; ) {
      const busy = this.running > 0 || !this.stopped && (this.queue.length > 0 || [...this.watched.values()].some((w) => w.tail && (w.dirty || w.queued || w.inFlight)));
      if (!busy || Date.now() - t0 > timeoutMs) return;
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  async tickInner(w) {
    if (!w.tail) return;
    try {
      const st = await stat5(w.ref.path);
      w.ref.sizeBytes = st.size;
      w.ref.mtimeMs = st.mtimeMs;
    } catch {
      return;
    }
    try {
      const subs = await discoverSubagentFiles(w.ref.path);
      w.ref.subagentFiles = subs.map((s) => s.path);
    } catch (error) {
      w.ref.subagentFiles = [];
      throw error;
    }
    const { changed } = await tailOnce(w.tail, w.ref, this.readFn);
    if (!changed && w.analysis && !w.force) return;
    const session = await sessionFromTail(w.tail);
    w.analysis = this.analyzeFn(session, { version: this.o.opts.version, now: this.nowFn() });
    w.seq++;
    this.emitFn({ type: "session-updated", id: w.ref.sessionId, seq: w.seq, row: this.rowFor(w) });
  }
  /**
   * Rows are built from the raw analysis, and every consumer (list() → /api/sessions and
   * /api/app, plus the session-added/session-updated SSE frames) sends them off-process, so the
   * row is redacted HERE, at its single construction point, with the /api/session/:id policy
   * (scrub on; text stripped unless --include-text).
   */
  rowFor(w) {
    const now = this.nowFn();
    const { badge, ageMs } = badgeFor(w.ref.mtimeMs, now);
    if (w.analysis) {
      const row2 = rowFromAnalysis(w.analysis, now);
      row2.badge = badge;
      row2.ageMs = ageMs;
      row2.mtimeMs = w.ref.mtimeMs;
      row2.sizeBytes = w.ref.sizeBytes;
      row2.possiblyLive = badge !== "ended" && w.analysis.session.live;
      row2.agentsRunning = badge === "ended" ? 0 : w.analysis.agents.runs.filter((r) => r.status === "running").length;
      row2.lastEvents = w.analysis.tools.calls.slice(-LAST_EVENTS_MAX).map((c) => ({ ts: c.startTs, name: c.name, category: c.category, summary: c.summary }));
      return redactValue(row2, { scrub: true, stripText: !this.o.opts.includeText });
    }
    return redactValue(
      {
        id: w.ref.sessionId,
        projectSlug: w.ref.projectSlug,
        path: w.ref.path,
        source: "claude-code",
        sizeBytes: w.ref.sizeBytes,
        mtimeMs: w.ref.mtimeMs,
        badge,
        ageMs,
        possiblyLive: false
      },
      { scrub: true, stripText: !this.o.opts.includeText }
    );
  }
  list() {
    return [...this.watched.values()].sort((a, b) => b.ref.mtimeMs - a.ref.mtimeMs).map((w) => this.rowFor(w));
  }
  /** tailed → the live analysis; otherwise analyze on demand through the cache (ended sessions). */
  async analysis(id) {
    const w = this.watched.get(id);
    if (!w) return void 0;
    if (w.analysis) return w.analysis;
    try {
      w.analysis = await analyzeRefCached(w.ref, { cache: this.o.cache, version: this.o.opts.version, now: this.nowFn() });
      return w.analysis;
    } catch {
      return void 0;
    }
  }
  pin(id) {
    const w = this.watched.get(id);
    if (!w) return;
    w.pinned = true;
    this.ensureTailing();
  }
};

// src/serve/api.ts
function json(res, status, body) {
  const s = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(s);
}
function publicSuggestion(record2) {
  const view = {
    ...record2,
    // Always overwrite any unknown JSONL property with the computed result.
    // JSON.stringify omits undefined, so untrusted records expose no claim.
    verificationTrusted: isTrustedComputedVerification(record2) ? true : void 0
  };
  return redactValue(view, { scrub: true });
}
function publicSuggestions(records) {
  return records.map(publicSuggestion);
}
function capabilitiesOf(ctx) {
  return { live: true, aggregates: true, kickoffRun: false, exportHtml: true, includeText: ctx.opts.includeText };
}
function redacted(ctx, a) {
  const r = redactAnalysis(a, { scrub: true, stripText: !ctx.opts.includeText });
  return { analysis: r.analysis, applied: r.report.applied, strippedText: r.report.strippedText, strippedPaths: r.report.strippedPaths };
}
var MAX_REPO_CWD_BYTES = 4096;
var MAX_AGGREGATE_JOBS = 16;
var MAX_AGGREGATE_CONCURRENCY = 2;
function aggregateRegistryFingerprint(rows) {
  return rows.map((row2) => JSON.stringify([row2.source, row2.id, row2.path, row2.mtimeMs, row2.sizeBytes, row2.cwd ?? ""])).sort().join("\n");
}
var AggregateRunner = class {
  constructor(ctx) {
    this.ctx = ctx;
  }
  ctx;
  jobs = /* @__PURE__ */ new Map();
  queue = [];
  active = 0;
  cwdCache;
  cwdRefresh;
  fingerprint(rows = this.ctx.registry.list()) {
    return aggregateRegistryFingerprint(rows);
  }
  evictIdleJob() {
    let oldest;
    for (const candidate of this.jobs.values()) {
      if (candidate.computing) continue;
      if (!oldest || candidate.lastAccessed < oldest.lastAccessed) oldest = candidate;
    }
    if (!oldest) return false;
    this.jobs.delete(oldest.key);
    return true;
  }
  getOrCreateJob(key) {
    const existing = this.jobs.get(key);
    if (existing) {
      existing.lastAccessed = Date.now();
      return existing;
    }
    while (this.jobs.size >= MAX_AGGREGATE_JOBS) {
      if (!this.evictIdleJob()) return void 0;
    }
    const created = { key, done: 0, total: 0, computing: false, fingerprint: "", computedAt: 0, lastAccessed: Date.now() };
    this.jobs.set(key, created);
    return created;
  }
  schedule(job, scope, cwd, fingerprint) {
    job.computing = true;
    this.queue.push({ job, scope, cwd, fingerprint });
    this.pump();
  }
  pump() {
    while (this.active < MAX_AGGREGATE_CONCURRENCY && this.queue.length) {
      const task = this.queue.shift();
      this.active++;
      void this.compute(task.job, task.scope, task.cwd, task.fingerprint).catch(() => {
      }).finally(() => {
        task.job.computing = false;
        this.active--;
        this.pump();
      });
    }
  }
  async aliasesForDiscoveredCwds() {
    const rows = this.ctx.registry.list();
    const fingerprint = this.fingerprint(rows);
    if (this.cwdCache?.fingerprint === fingerprint) return this.cwdCache.aliases;
    if (this.cwdRefresh?.fingerprint === fingerprint) return this.cwdRefresh.promise;
    const promise = (async () => {
      const aliases = /* @__PURE__ */ new Map();
      const add = (alias, raw) => {
        if (!alias) return;
        const prior = aliases.get(alias);
        aliases.set(alias, prior === void 0 || prior === raw ? raw : null);
      };
      for (const row2 of rows) {
        const analysis = await this.ctx.registry.analysis(row2.id);
        const raw = analysis?.session.cwd;
        if (!raw) continue;
        add(raw, raw);
        if (row2.cwd) add(row2.cwd, raw);
        add(redactValue(raw, { scrub: true }), raw);
      }
      this.cwdCache = { fingerprint, aliases };
      return aliases;
    })();
    this.cwdRefresh = { fingerprint, promise };
    try {
      return await promise;
    } finally {
      if (this.cwdRefresh?.promise === promise) this.cwdRefresh = void 0;
    }
  }
  async handleRepo(res, requestedCwd) {
    if (!requestedCwd) return json(res, 400, { error: "repo cwd is required" });
    if (Buffer.byteLength(requestedCwd, "utf8") > MAX_REPO_CWD_BYTES) return json(res, 400, { error: "repo cwd is too long" });
    const cwd = (await this.aliasesForDiscoveredCwds()).get(requestedCwd);
    if (!cwd) return json(res, 404, { error: "unknown repo cwd" });
    return this.handle(res, "repo", cwd);
  }
  async handle(res, scope, cwd) {
    const key = scope + "|" + (cwd ?? "");
    const job = this.getOrCreateJob(key);
    if (!job) return json(res, 503, { error: "aggregate capacity reached" });
    const fp = this.fingerprint();
    if (!job.computing && (!job.result || job.fingerprint !== fp && Date.now() - job.computedAt > 3e4)) {
      this.schedule(job, scope, cwd, fp);
    }
    if (job.result) return json(res, 200, job.result);
    return json(res, 202, { progress: { done: job.done, total: job.total } });
  }
  async compute(job, scope, cwd, fp) {
    const rows = this.ctx.registry.list();
    job.total = rows.length;
    job.done = 0;
    const analyses = [];
    for (const row2 of rows) {
      const a = await this.ctx.registry.analysis(row2.id);
      job.done++;
      if (!a) continue;
      if (scope === "repo" && cwd && a.session.cwd !== cwd) continue;
      analyses.push(a);
    }
    const label = scope === "repo" ? `repo ${cwd ?? this.ctx.opts.cwd ?? ""}`.trim() : "global";
    job.result = redactValue(aggregate(analyses, label, this.ctx.now()), { scrub: true, stripText: !this.ctx.opts.includeText });
    job.fingerprint = fp;
    job.computedAt = Date.now();
  }
};
var HarnessRunner = class {
  constructor(ctx) {
    this.ctx = ctx;
  }
  ctx;
  result;
  fingerprint = "";
  computedAt = 0;
  computing = false;
  done = 0;
  total = 0;
  async handle(res) {
    const fp = aggregateRegistryFingerprint(this.ctx.registry.list());
    if (!this.computing && (!this.result || this.fingerprint !== fp && Date.now() - this.computedAt > 3e4)) {
      this.computing = true;
      void this.compute(fp).catch(() => {
      }).finally(() => {
        this.computing = false;
      });
    }
    if (this.result) return json(res, 200, this.result);
    return json(res, 202, { progress: { done: this.done, total: this.total } });
  }
  async compute(fp) {
    const rows = this.ctx.registry.list();
    this.total = rows.length;
    this.done = 0;
    const analyses = [];
    let unreadable = 0;
    for (const row2 of rows) {
      const a = await this.ctx.registry.analysis(row2.id);
      this.done++;
      if (a) analyses.push(a);
      else unreadable++;
    }
    const home = homedir3();
    const repoCwd = this.ctx.opts.cwd;
    const cwd = repoCwd ?? process.cwd();
    const roots = this.ctx.opts.roots ?? [this.ctx.opts.configDir ?? defaultConfigDir()];
    const now = this.ctx.now();
    const inventory = await collectInventory({ cwd, roots, home });
    const report = buildHarnessReport(inventory, analyses, aggregate(analyses, repoCwd ? `repo ${repoCwd}` : "global", now), {
      version: this.ctx.opts.version,
      now,
      scope: { cwd, roots, global: !repoCwd, limit: rows.length, sessionsUnreadable: unreadable, home }
    });
    this.result = redactValue(report, { scrub: true, home });
    this.fingerprint = fp;
    this.computedAt = Date.now();
  }
};
function coreRoutes(ctx, hub) {
  const aggs = new AggregateRunner(ctx);
  const harness = new HarnessRunner(ctx);
  const maxLive = ctx.opts.maxLive ?? DEFAULT_MAX_LIVE;
  const appData = async (s) => {
    const rows = ctx.registry.list();
    const selectedId = s && rows.some((r) => r.id === s) ? s : rows[0]?.id;
    const raw = selectedId ? await ctx.registry.analysis(selectedId) : void 0;
    const red = raw ? redacted(ctx, raw) : void 0;
    return {
      v: APP_DATA_VERSION,
      mode: "serve",
      version: ctx.opts.version,
      generatedAt: ctx.now(),
      capabilities: capabilitiesOf(ctx),
      selectedId,
      session: red?.analysis,
      sessions: rows,
      aggregates: {},
      suggestions: publicSuggestions(await ctx.store.all()),
      redaction: red ? { applied: red.applied, strippedText: red.strippedText, strippedPaths: red.strippedPaths } : void 0
    };
  };
  return [
    {
      method: "GET",
      path: "/",
      handler: async (_m, _req, res) => {
        const html = renderShell({ version: ctx.opts.version, capabilities: capabilitiesOf(ctx), maxLive, feedback: feedbackBootstrap(ctx.opts.version) });
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...HTML_ANTI_FRAMING_HEADERS });
        res.end(html);
      }
    },
    {
      method: "GET",
      path: "/api/app",
      handler: async (m, _req, res) => json(res, 200, await appData(m.query.get("s") ?? void 0))
    },
    {
      method: "GET",
      path: "/api/sessions",
      handler: async (_m, _req, res) => json(res, 200, ctx.registry.list())
    },
    {
      method: "GET",
      path: "/api/session/:id",
      handler: async (m, _req, res) => {
        const a = await ctx.registry.analysis(m.params["id"]);
        if (!a) return json(res, 404, { error: "unknown session" });
        json(res, 200, redacted(ctx, a).analysis);
      }
    },
    {
      method: "GET",
      path: "/api/repo",
      handler: async (m, _req, res) => {
        const values = m.query.getAll("cwd");
        if (values.length > 1) return json(res, 400, { error: "repo cwd must be singular" });
        return aggs.handleRepo(res, values[0] ?? ctx.opts.cwd);
      }
    },
    {
      method: "GET",
      path: "/api/global",
      handler: async (_m, _req, res) => aggs.handle(res, "global", void 0)
    },
    {
      method: "GET",
      path: "/api/harness",
      handler: async (_m, _req, res) => harness.handle(res)
    },
    {
      method: "GET",
      path: "/api/suggestions",
      handler: async (_m, _req, res) => json(res, 200, publicSuggestions(await ctx.store.all()))
    },
    {
      method: "POST",
      path: "/api/suggestions/:id/status",
      handler: async (m, _req, res) => {
        const body = m.body ?? {};
        const id = m.params["id"];
        if (!body.status) return json(res, 400, { error: "status required" });
        if (body.status !== "rejected") return json(res, 400, { error: "the browser may only set status to rejected" });
        const existing = await ctx.store.get(id);
        if (!existing) return json(res, 404, { error: "unknown suggestion" });
        try {
          const rec = await ctx.store.transition(id, body.status);
          if (ctx.noteSuggestion) ctx.noteSuggestion(rec);
          else ctx.emit({ type: "suggestion-updated", id: rec.id, status: rec.status });
          json(res, 200, publicSuggestion(rec));
        } catch (e) {
          json(res, 400, { error: String(e instanceof Error ? e.message : e) });
        }
      }
    },
    {
      method: "GET",
      path: "/events",
      handler: async (_m, req, res) => {
        const lastId = typeof req.headers["last-event-id"] === "string" ? req.headers["last-event-id"] : void 0;
        hub.add(res, lastId, { type: "hello", serverId: String(process.pid), capabilities: capabilitiesOf(ctx) });
      }
    }
  ];
}

// src/serve/export.ts
var exportRoutes = (ctx) => [
  {
    method: "GET",
    path: "/export/:id.html",
    handler: async (m, _req, res) => {
      const id = m.params.id ?? "";
      const analysis = await ctx.registry.analysis(id);
      if (!analysis) {
        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: `unknown session: ${id}` }));
        return;
      }
      const { html } = ctx.renderReport(analysis, { redact: { scrub: true, stripText: !ctx.opts.exportIncludeText } });
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Disposition": `attachment; filename="orangu-${id}.html"`,
        ...HTML_ANTI_FRAMING_HEADERS
      });
      res.end(html);
    }
  }
];

// src/serve/kickoff.ts
var SCOPES = /* @__PURE__ */ new Set(["session", "repo", "global"]);
var MODES = /* @__PURE__ */ new Set(["copy", "run"]);
function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}
function parseKickoffRequest(body) {
  if (typeof body !== "object" || body === null) return null;
  const b = body;
  if (typeof b.mode !== "string" || !MODES.has(b.mode)) return null;
  const f = b.finding;
  if (typeof f !== "object" || f === null) return null;
  const fo = f;
  if (typeof fo.ruleId !== "string" || !fo.ruleId.trim()) return null;
  if (typeof fo.title !== "string" || !fo.title.trim()) return null;
  if (typeof fo.scope !== "string" || !SCOPES.has(fo.scope)) return null;
  if (!Array.isArray(fo.sessionIds) || fo.sessionIds.length === 0 || !fo.sessionIds.every((s) => typeof s === "string" && s.trim())) return null;
  if (typeof fo.evidence !== "object" || fo.evidence === null || Array.isArray(fo.evidence)) return null;
  if (typeof fo.evidence.estimated !== "boolean") return null;
  if (fo.insightId !== void 0 && typeof fo.insightId !== "string") return null;
  if (fo.scope === "session" ? fo.cohortFingerprint !== void 0 : typeof fo.cohortFingerprint !== "string" || !/^[0-9a-f]{16}$/.test(fo.cohortFingerprint)) return null;
  const identityValues = [fo.ruleId, fo.insightId, ...fo.sessionIds].filter((value) => typeof value === "string");
  if (identityValues.some((value) => redactValue(value, { scrub: true }) !== value)) return null;
  if (b.confirm !== void 0 && typeof b.confirm !== "boolean") return null;
  if (b.suggestionId !== void 0 && typeof b.suggestionId !== "string") return null;
  const finding = {
    ruleId: fo.ruleId,
    title: fo.title,
    scope: fo.scope,
    sessionIds: fo.sessionIds,
    ...typeof fo.insightId === "string" ? { insightId: fo.insightId } : {},
    ...typeof fo.cohortFingerprint === "string" ? { cohortFingerprint: fo.cohortFingerprint } : {},
    evidence: fo.evidence
  };
  return {
    finding,
    mode: b.mode,
    ...typeof b.confirm === "boolean" ? { confirm: b.confirm } : {},
    ...typeof b.suggestionId === "string" ? { suggestionId: b.suggestionId } : {}
  };
}
var kickoffRoutes = (ctx) => [
  {
    method: "POST",
    path: "/api/kickoff",
    handler: async (m, _req, res) => {
      const parsed = parseKickoffRequest(m.body);
      if (!parsed) {
        sendJson(res, 400, { error: 'invalid kickoff request: need { finding: { ruleId, title, scope, sessionIds[], evidence }, mode: "copy"|"run" }' });
        return;
      }
      const id = suggestionIdV2(suggestionKey(parsed.finding, "report"));
      const legacyId = suggestionId("report", parsed.finding.ruleId, parsed.finding.sessionIds);
      const acceptsLegacyId = !parsed.finding.cohortFingerprint && parsed.suggestionId === legacyId;
      if (parsed.suggestionId && parsed.suggestionId !== id && !acceptsLegacyId) {
        sendJson(res, 400, { error: `suggestionId mismatch: finding hashes to ${id}` });
        return;
      }
      const { record: record2 } = await ctx.store.upsertNew(parsed.finding, "report");
      const commands = kickoffCommands(record2, "serve");
      const command = commands.claude;
      const annotated = { ...record2, kickoff: { mode: "serve", command } };
      const publicRecord = redactValue(annotated, { scrub: true });
      ctx.noteSuggestion?.(record2);
      if (parsed.mode === "run") {
        sendJson(res, 403, {
          record: publicRecord,
          commands,
          command,
          spawned: false,
          error: "automatic model launch is disabled; copy the command into Claude Code or use $orangu-improve in Codex"
        });
        return;
      }
      sendJson(res, 200, { record: publicRecord, commands, command, spawned: false });
    }
  }
];

// src/serve/routes-extra.ts
var extraRoutes = [kickoffRoutes, exportRoutes];

// src/serve/sse.ts
var RING_SIZE = 200;
var SseHub = class {
  clients = /* @__PURE__ */ new Set();
  ring = [];
  seq = 0;
  ping;
  constructor(o = {}) {
    const pingMs = o.pingMs ?? 15e3;
    if (pingMs > 0) {
      this.ping = setInterval(() => {
        for (const res of this.clients) this.write(res, ": ping\n\n");
      }, pingMs);
      this.ping.unref?.();
    }
  }
  write(res, chunk) {
    try {
      res.write(chunk);
    } catch {
      this.clients.delete(res);
    }
  }
  frame(seq2, ev) {
    return `id: ${seq2}
event: ${ev.type}
data: ${JSON.stringify(ev)}

`;
  }
  /** Attach a response; replays ring events with seq > lastEventId. `hello` (id-less) greets this client only. */
  add(res, lastEventId, hello) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });
    this.write(res, ": connected\n\n");
    if (hello) this.write(res, `event: ${hello.type}
data: ${JSON.stringify(hello)}

`);
    const after = lastEventId !== void 0 && /^\d+$/.test(lastEventId) ? Number(lastEventId) : void 0;
    if (after !== void 0) {
      for (const e of this.ring) if (e.seq > after) this.write(res, e.frame);
    }
    this.clients.add(res);
    res.on("close", () => this.clients.delete(res));
  }
  /** Broadcast one event to every client and remember it in the ring. */
  emit(ev) {
    const seq2 = ++this.seq;
    const frame = this.frame(seq2, ev);
    this.ring.push({ seq: seq2, frame });
    if (this.ring.length > RING_SIZE) this.ring.splice(0, this.ring.length - RING_SIZE);
    for (const res of this.clients) this.write(res, frame);
  }
  size() {
    return this.clients.size;
  }
  /** Close every stream and stop the ping timer (server shutdown). */
  stop() {
    if (this.ping) clearInterval(this.ping);
    for (const res of this.clients) {
      try {
        res.end();
      } catch {
      }
    }
    this.clients.clear();
  }
};

// src/serve/suggestion-watcher.ts
var DEFAULT_POLL_MS = 250;
function versionOf(rec) {
  return JSON.stringify({
    id: rec.id,
    status: rec.status,
    statusAt: rec.statusAt,
    proposalPath: rec.proposal?.proposalPath ?? null,
    kickoffExit: rec.kickoff?.exitCode ?? null,
    kickoffError: rec.kickoff?.error ?? null
  });
}
var SuggestionWatcher = class {
  constructor(store, emit2, pollMs = DEFAULT_POLL_MS) {
    this.store = store;
    this.emit = emit2;
    this.pollMs = pollMs;
  }
  store;
  emit;
  pollMs;
  seen = /* @__PURE__ */ new Map();
  timer;
  pending;
  stopped = false;
  observedGeneration = 0;
  /** Seed current state without replaying it as new SSE traffic, then poll. */
  async start() {
    this.stopped = false;
    await this.pollOnce(false);
    if (this.pollMs <= 0) return;
    this.timer = setInterval(() => void this.pollOnce().catch(() => {
    }), this.pollMs);
    this.timer.unref?.();
  }
  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = void 0;
    await this.pending;
  }
  /** Record and broadcast an in-process mutation without waiting for the poll. */
  observe(rec) {
    this.observedGeneration++;
    this.seen.set(rec.id, versionOf(rec));
    this.emit({ type: "suggestion-updated", id: rec.id, status: rec.status });
  }
  /** Public seam for deterministic unit/E2E tests and an optional explicit refresh. */
  async pollOnce(emitChanges = true) {
    if (this.pending) return this.pending;
    const run = async () => {
      const generation = this.observedGeneration;
      const records = await this.store.all();
      if (generation !== this.observedGeneration) return;
      const next = /* @__PURE__ */ new Map();
      for (const rec of records) {
        const version = versionOf(rec);
        next.set(rec.id, version);
        if (emitChanges && this.seen.get(rec.id) !== version && !this.stopped) {
          this.emit({ type: "suggestion-updated", id: rec.id, status: rec.status });
        }
      }
      this.seen.clear();
      for (const [id, version] of next) this.seen.set(id, version);
    };
    this.pending = run().finally(() => {
      this.pending = void 0;
    });
    return this.pending;
  }
};

// src/serve/server.ts
var BODY_LIMIT = 1 << 20;
var CAPABILITY_BYTES = 32;
var CAPABILITY_PATH_PREFIX = "/_orangu/";
var CAPABILITY_RE = /^[A-Za-z0-9_-]{43}$/;
function makeCapability(injected) {
  const capability = injected ?? randomBytes3(CAPABILITY_BYTES).toString("base64url");
  if (!CAPABILITY_RE.test(capability)) throw new Error("serve capability must be a 32-byte base64url token");
  return capability;
}
function capabilityMatches(presented, expected) {
  const actual = Buffer.from(presented);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}
function authenticatedRoutePath(pathname, capability) {
  if (!pathname.startsWith(CAPABILITY_PATH_PREFIX)) return void 0;
  const remainder = pathname.slice(CAPABILITY_PATH_PREFIX.length);
  const slash = remainder.indexOf("/");
  const presented = slash < 0 ? remainder : remainder.slice(0, slash);
  if (!capabilityMatches(presented, capability)) return void 0;
  if (slash < 0 || slash === remainder.length - 1) return "/";
  return remainder.slice(slash);
}
function rejectCapability(res) {
  res.writeHead(403, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end('{"error":"serve capability required"}');
}
function matchRoute(routes, method, pathname) {
  const segs = pathname.split("/").filter((s) => s.length);
  for (const route of routes) {
    if (route.method !== method) continue;
    const psegs = route.path.split("/").filter((s) => s.length);
    if (route.path === "/" && segs.length === 0) return { route, params: {} };
    if (psegs.length !== segs.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < psegs.length; i++) {
      const p = psegs[i];
      const s = decodeURIComponent(segs[i]);
      if (p.startsWith(":")) {
        const m = /^:([A-Za-z0-9_]+)(.*)$/.exec(p);
        const suffix = m[2];
        if (suffix && !s.endsWith(suffix)) {
          ok = false;
          break;
        }
        params[m[1]] = suffix ? s.slice(0, -suffix.length) : s;
      } else if (p !== s) {
        ok = false;
        break;
      }
    }
    if (ok) return { route, params };
  }
  return void 0;
}
async function readBody(req) {
  const chunks = [];
  let len = 0;
  for await (const c of req) {
    len += c.length;
    if (len > BODY_LIMIT) throw new Error("body too large");
    chunks.push(c);
  }
  if (!len) return void 0;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return void 0;
  }
}
function requestHost(req) {
  return typeof req.headers.host === "string" ? req.headers.host.toLowerCase() : "";
}
function rejectUntrustedHost(req) {
  if (!/^(?:127\.0\.0\.1|localhost)(?::\d{1,5})?$/.test(requestHost(req)))
    return { status: 403, error: "request host must be loopback" };
  return void 0;
}
function rejectUntrustedMutation(req) {
  const hostRejection = rejectUntrustedHost(req);
  if (hostRejection) return hostRejection;
  const host = requestHost(req);
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : void 0;
  if (origin) {
    try {
      const parsed = new URL(origin);
      if (parsed.protocol !== "http:" || parsed.host.toLowerCase() !== host)
        return { status: 403, error: "cross-origin mutation blocked" };
    } catch {
      return { status: 403, error: "cross-origin mutation blocked" };
    }
  }
  const contentType = typeof req.headers["content-type"] === "string" ? req.headers["content-type"].split(";", 1)[0].trim().toLowerCase() : "";
  if (contentType !== "application/json") return { status: 415, error: "POST requests require application/json" };
  return void 0;
}
function rejectCrossSiteBrowserGet(req) {
  const hostRejection = rejectUntrustedHost(req);
  if (hostRejection) return hostRejection;
  const fetchSite = typeof req.headers["sec-fetch-site"] === "string" ? req.headers["sec-fetch-site"].trim().toLowerCase() : "";
  if (fetchSite === "cross-site") return { status: 403, error: "cross-site browser GET blocked" };
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : void 0;
  if (!origin) return void 0;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:" || parsed.host.toLowerCase() !== requestHost(req))
      return { status: 403, error: "cross-site browser GET blocked" };
  } catch {
    return { status: 403, error: "cross-site browser GET blocked" };
  }
  return void 0;
}
async function startServe(opts, deps = {}) {
  const capability = makeCapability(deps.capability);
  const authenticatedBasePath = CAPABILITY_PATH_PREFIX + capability;
  const now = deps.now ?? Date.now;
  const cache2 = deps.cache !== void 0 ? deps.cache : opts.noCache ? null : new AnalysisCache({ version: opts.version });
  const store = deps.store ?? new SuggestionStore();
  const hub = new SseHub();
  const suggestionWatcher = new SuggestionWatcher(store, (ev) => hub.emit(ev), deps.suggestionPollMs);
  const registry = deps.registry ?? new Registry(
    { opts, cache: cache2, concurrency: Math.max(1, cpus2().length - 1), now: deps.now, analyze: deps.analyze, read: deps.read, pollMs: deps.pollMs, rescanMs: deps.rescanMs },
    (ev) => hub.emit(ev)
  );
  const ctx = {
    opts,
    registry,
    store,
    emit: (ev) => hub.emit(ev),
    noteSuggestion: (record2) => suggestionWatcher.observe(record2),
    now,
    renderReport
  };
  const routes = [...coreRoutes(ctx, hub), ...extraRoutes.flatMap((f) => f(ctx))];
  const handler = async (req, res) => {
    let logPath = "[malformed request path]";
    if (!deps.quiet) res.on("finish", () => process.stderr.write(`${req.method} ${logPath} ${res.statusCode}
`));
    res.setHeader("Referrer-Policy", "no-referrer");
    const hostRejection = rejectUntrustedHost(req);
    if (hostRejection) {
      res.writeHead(hostRejection.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: hostRejection.error }));
      return;
    }
    let url;
    let routePath;
    let m;
    try {
      url = new URL(req.url ?? "/", "http://127.0.0.1");
      const authenticated = authenticatedRoutePath(url.pathname, capability);
      if (authenticated === void 0) {
        logPath = "[unauthorized]";
        rejectCapability(res);
        return;
      }
      routePath = authenticated;
      logPath = routePath;
      m = matchRoute(routes, req.method ?? "GET", routePath);
    } catch {
      res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end('{"error":"malformed request path"}');
      return;
    }
    if (req.method === "GET") {
      const readRejection = rejectCrossSiteBrowserGet(req);
      if (readRejection) {
        res.writeHead(readRejection.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: readRejection.error }));
        return;
      }
    }
    if (!m) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end('{"error":"not found"}');
      return;
    }
    let body;
    if (req.method === "POST") {
      const rejection = rejectUntrustedMutation(req);
      if (rejection) {
        res.writeHead(rejection.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: rejection.error }));
        return;
      }
      try {
        body = await readBody(req);
      } catch {
        res.writeHead(413, { "content-type": "application/json" });
        res.end('{"error":"body too large"}');
        return;
      }
    }
    try {
      await m.route.handler({ params: m.params, query: url.searchParams, body }, req, res);
    } catch (e) {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(e instanceof Error ? e.message : e) }));
      } else res.end();
    }
  };
  const server = createServer((req, res) => void handler(req, res));
  await new Promise((resolve11, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", resolve11);
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : opts.port ?? 0;
  await registry.start();
  await suggestionWatcher.start();
  return {
    url: `http://127.0.0.1:${port}${authenticatedBasePath}`,
    port,
    registry,
    hub,
    suggestionWatcher,
    close: async () => {
      await suggestionWatcher.stop();
      hub.stop();
      await registry.stop();
      server.closeAllConnections?.();
      await new Promise((resolve11) => server.close(() => resolve11()));
    }
  };
}

// src/report/client/mascot.ts
var MASCOT_ASCII = String.raw`
.-"""-.
/  o o  \   orangu
|  \___/()o  see what your agent did
\_______/`;

// src/suggest/evidence.ts
var EVIDENCE_SCHEMA_VERSION = "1";
var DEFAULT_EVIDENCE_LIMIT = 12;
var MAX_EVIDENCE_LIMIT = 50;
var MAX_EVIDENCE_ARTIFACT_BYTES = 8 * 1024 * 1024;
var MAX_EVIDENCE_OUTPUT_BYTES = 256 * 1024;
var MAX_EVIDENCE_INPUT_FINDINGS = 500;
var MAX_EVIDENCE_INPUT_SESSIONS = 1e3;
var MAX_RULE_ID_CHARS = 128;
var MAX_INSIGHT_ID_CHARS = 256;
var MAX_SESSION_ID_CHARS = 2048;
var MAX_TITLE_CHARS = 1e3;
var MAX_INPUT_TEXT_CHARS = 16384;
var MAX_OUTPUT_DETAIL_CHARS = 2e3;
var MAX_OUTPUT_CATALOG_TEXT_CHARS = 1e3;
var MAX_TURN_INDEXES = 500;
var MAX_SESSION_IDS_PER_FINDING = 50;
var MAX_CATALOG_MATCHES_PER_FINDING = 16;
var MAX_EVIDENCE_VALUE_ITEMS = 500;
var MAX_EVIDENCE_VALUE_NODES = 5e3;
var MAX_EVIDENCE_VALUE_DEPTH = 8;
var SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]*$/;
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function boundedString(value, label, max, allowEmpty = false) {
  if (typeof value !== "string" || !allowEmpty && !value.trim()) throw new Error(`${label} must be a non-empty string`);
  if (value.length > max) throw new Error(`${label} exceeds ${max} characters`);
  return value;
}
function boundedId(value, label, max) {
  const id = boundedString(value, label, max);
  if (!SAFE_ID.test(id)) throw new Error(`${label} contains unsupported characters`);
  if (redactValue(id, { scrub: true }) !== id) throw new Error(`${label} contains sensitive material`);
  return id;
}
function finiteNonNegative(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${label} must be a finite non-negative number`);
  return value;
}
function insightAxis(value, label) {
  if (value === "quality" || value === "time" || value === "tokens" || value === "context") return value;
  throw new Error(`${label} is unsupported`);
}
function insightSeverity(value, label) {
  if (value === "info" || value === "low" || value === "medium" || value === "high") return value;
  throw new Error(`${label} is unsupported`);
}
function insightPersona(value, label) {
  if (value === "developer" || value === "lead" || value === "pm" || value === "qa" || value === "anyone") return value;
  throw new Error(`${label} is unsupported`);
}
function boundedArray(value, label, max) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (value.length > max) throw new Error(`${label} exceeds ${max} items`);
  return value;
}
function requireRecords(value, keys, label) {
  for (const key of keys) if (!isRecord(value[key])) throw new Error(`${label}.${key} must be an object`);
}
function requireArrays(value, keys, label) {
  for (const key of keys) if (!Array.isArray(value[key])) throw new Error(`${label}.${key} must be an array`);
}
function validateBoundedValue(value, label, state = { nodes: 0, seen: /* @__PURE__ */ new WeakSet() }, depth = 0) {
  state.nodes++;
  if (state.nodes > MAX_EVIDENCE_VALUE_NODES) throw new Error(`${label} exceeds ${MAX_EVIDENCE_VALUE_NODES} values`);
  if (depth > MAX_EVIDENCE_VALUE_DEPTH) throw new Error(`${label} exceeds ${MAX_EVIDENCE_VALUE_DEPTH} levels`);
  if (typeof value === "string") {
    boundedString(value, label, MAX_INPUT_TEXT_CHARS, true);
    return;
  }
  if (value == null || typeof value === "boolean" || value === void 0) return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} must contain only finite numbers`);
    return;
  }
  if (typeof value !== "object") throw new Error(`${label} contains an unsupported value`);
  if (state.seen.has(value)) throw new Error(`${label} must not contain cycles`);
  state.seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > MAX_EVIDENCE_VALUE_ITEMS) throw new Error(`${label} exceeds ${MAX_EVIDENCE_VALUE_ITEMS} items`);
    for (let i = 0; i < value.length; i++) validateBoundedValue(value[i], `${label}[${i}]`, state, depth + 1);
  } else {
    const entries = Object.entries(value);
    if (entries.length > MAX_EVIDENCE_VALUE_ITEMS) throw new Error(`${label} exceeds ${MAX_EVIDENCE_VALUE_ITEMS} fields`);
    for (const [key, item] of entries) validateBoundedValue(item, `${label}.${key}`, state, depth + 1);
  }
  state.seen.delete(value);
}
function validateSessionIds(value, label) {
  const raw = boundedArray(value, label, MAX_SESSION_IDS_PER_FINDING);
  if (!raw.length) throw new Error(`${label} must not be empty`);
  return normalizeSessionIds(raw.map((id, index) => boundedId(id, `${label}[${index}]`, MAX_SESSION_ID_CHARS)));
}
function validateInsight(value, index) {
  if (!isRecord(value)) throw new Error(`insights[${index}] must be an object`);
  const id = boundedId(value["id"], `insights[${index}].id`, MAX_INSIGHT_ID_CHARS);
  const ruleId = boundedId(value["ruleId"], `insights[${index}].ruleId`, MAX_RULE_ID_CHARS);
  const title = boundedString(value["title"], `insights[${index}].title`, MAX_TITLE_CHARS, true);
  const detail = boundedString(value["detail"], `insights[${index}].detail`, MAX_INPUT_TEXT_CHARS, true);
  const recommendation = boundedString(value["recommendation"], `insights[${index}].recommendation`, MAX_INPUT_TEXT_CHARS, true);
  const axis = insightAxis(value["axis"], `insights[${index}].axis`);
  const severity = insightSeverity(value["severity"], `insights[${index}].severity`);
  const evidence = value["evidence"];
  if (!isRecord(evidence)) throw new Error(`insights[${index}].evidence must be an object`);
  validateBoundedValue(evidence, `insights[${index}].evidence`);
  const rawTurns = boundedArray(value["turnIndexes"], `insights[${index}].turnIndexes`, MAX_TURN_INDEXES);
  const turnIndexes = [];
  for (let i = 0; i < rawTurns.length; i++) {
    const turn = rawTurns[i];
    if (typeof turn !== "number" || !Number.isInteger(turn) || turn < 0) throw new Error(`insights[${index}].turnIndexes[${i}] must be a non-negative integer`);
    turnIndexes.push(turn);
  }
  const rawPersonas = boundedArray(value["personas"], `insights[${index}].personas`, 32);
  const personas = rawPersonas.map((persona, personaIndex) => insightPersona(persona, `insights[${index}].personas[${personaIndex}]`));
  let savings;
  const rawSavings = value["savings"];
  if (rawSavings !== void 0) {
    if (!isRecord(rawSavings) || typeof rawSavings["estimated"] !== "boolean") {
      throw new Error(`insights[${index}].savings must include estimated`);
    }
    savings = {
      estimated: rawSavings["estimated"],
      ...rawSavings["tokens"] !== void 0 ? { tokens: finiteNonNegative(rawSavings["tokens"], `insights[${index}].savings.tokens`) } : {},
      ...rawSavings["ms"] !== void 0 ? { ms: finiteNonNegative(rawSavings["ms"], `insights[${index}].savings.ms`) } : {}
    };
  }
  return { id, ruleId, title, detail, recommendation, axis, severity, evidence, turnIndexes, ...savings ? { savings } : {}, personas };
}
function matchableFiles(value) {
  const files2 = value["files"];
  if (!isRecord(files2)) throw new Error("Analysis.files must be an object");
  const raw = boundedArray(files2["mostReRead"], "Analysis.files.mostReRead", MAX_EVIDENCE_VALUE_ITEMS);
  return {
    mostReRead: raw.map((item, index) => {
      if (!isRecord(item)) throw new Error(`Analysis.files.mostReRead[${index}] must be an object`);
      const path = item["path"];
      return path === void 0 ? {} : { path: boundedString(path, `Analysis.files.mostReRead[${index}].path`, MAX_INPUT_TEXT_CHARS) };
    })
  };
}
function matchableContext(value) {
  const context = value["context"];
  if (!isRecord(context)) throw new Error("Analysis.context must be an object");
  const misses = context["cacheMisses"];
  if (misses === void 0) return {};
  const raw = boundedArray(misses, "Analysis.context.cacheMisses", MAX_EVIDENCE_VALUE_ITEMS);
  return {
    cacheMisses: raw.map((item, index) => {
      if (!isRecord(item)) throw new Error(`Analysis.context.cacheMisses[${index}] must be an object`);
      const type = item["type"];
      return type === void 0 ? {} : { type: boundedString(type, `Analysis.context.cacheMisses[${index}].type`, MAX_RULE_ID_CHARS) };
    })
  };
}
function validateAnalysis(value) {
  if (value["schemaVersion"] !== ANALYSIS_SCHEMA_VERSION) {
    throw new Error(`Analysis schemaVersion must be current (${ANALYSIS_SCHEMA_VERSION})`);
  }
  if (!isRecord(value["generator"]) || value["generator"]["name"] !== "orangu") throw new Error('Analysis.generator.name must be "orangu"');
  if (!isRecord(value["session"])) throw new Error("Analysis.session must be an object");
  const sessionId = boundedId(value["session"]["id"], "Analysis.session.id", MAX_SESSION_ID_CHARS);
  const insights = boundedArray(value["insights"], "Analysis.insights", MAX_EVIDENCE_INPUT_FINDINGS);
  const validatedInsights = insights.map(validateInsight);
  const slim = value["slim"] === true;
  if (slim) {
    requireRecords(value, ["summary", "tools", "files", "tokens", "agents", "context", "quality", "parse"], "SlimAnalysis");
  } else {
    if (value["slim"] !== void 0) throw new Error("Analysis.slim must be absent; use true for SlimAnalysis");
    requireRecords(value, ["summary", "tools", "files", "agents", "skills", "hooks", "context", "tokens", "time", "quality", "parse"], "Analysis");
    requireArrays(value, ["turns", "events"], "Analysis");
  }
  return {
    kind: slim ? "slim-analysis" : "analysis",
    value: {
      schemaVersion: ANALYSIS_SCHEMA_VERSION,
      session: { id: sessionId },
      insights: validatedInsights,
      files: matchableFiles(value),
      context: matchableContext(value)
    }
  };
}
function validateCrossFinding(value, index) {
  if (!isRecord(value)) throw new Error(`Aggregate.crossFindings[${index}] must be an object`);
  const ruleId = boundedId(value["ruleId"], `Aggregate.crossFindings[${index}].ruleId`, MAX_RULE_ID_CHARS);
  const title = boundedString(value["title"], `Aggregate.crossFindings[${index}].title`, MAX_TITLE_CHARS, true);
  const sessions = finiteNonNegative(value["sessions"], `Aggregate.crossFindings[${index}].sessions`);
  if (!Number.isInteger(sessions) || sessions < 1 || sessions > MAX_EVIDENCE_INPUT_SESSIONS) {
    throw new Error(`Aggregate.crossFindings[${index}].sessions is out of range`);
  }
  const totalSavingsTokens = finiteNonNegative(value["totalSavingsTokens"], `Aggregate.crossFindings[${index}].totalSavingsTokens`);
  const totalSavingsMs = finiteNonNegative(value["totalSavingsMs"], `Aggregate.crossFindings[${index}].totalSavingsMs`);
  const boundedSavingsTokens = value["boundedSavingsTokens"] === void 0 ? totalSavingsTokens : finiteNonNegative(value["boundedSavingsTokens"], `Aggregate.crossFindings[${index}].boundedSavingsTokens`);
  const boundedSavingsMs = value["boundedSavingsMs"] === void 0 ? totalSavingsMs : finiteNonNegative(value["boundedSavingsMs"], `Aggregate.crossFindings[${index}].boundedSavingsMs`);
  const axis = insightAxis(value["axis"], `Aggregate.crossFindings[${index}].axis`);
  const severity = insightSeverity(value["severity"], `Aggregate.crossFindings[${index}].severity`);
  const exampleSessionIds = validateSessionIds(value["exampleSessionIds"], `Aggregate.crossFindings[${index}].exampleSessionIds`);
  return { ruleId, title, sessions, totalSavingsTokens, totalSavingsMs, boundedSavingsTokens, boundedSavingsMs, axis, severity, exampleSessionIds };
}
function validateAggregate(value) {
  if (value["schemaVersion"] !== AGGREGATE_SCHEMA_VERSION) {
    throw new Error(`Aggregate schemaVersion must be current (${AGGREGATE_SCHEMA_VERSION})`);
  }
  boundedString(value["scope"], "Aggregate.scope", MAX_INPUT_TEXT_CHARS, true);
  finiteNonNegative(value["generatedAt"], "Aggregate.generatedAt");
  const sessionCount = finiteNonNegative(value["sessionCount"], "Aggregate.sessionCount");
  if (!Number.isInteger(sessionCount) || sessionCount > MAX_EVIDENCE_INPUT_SESSIONS) throw new Error("Aggregate.sessionCount is out of range");
  requireRecords(value, ["totals", "averages"], "Aggregate");
  requireArrays(value, ["sessions", "topSessions", "byWeek"], "Aggregate");
  const sessions = boundedArray(value["sessions"], "Aggregate.sessions", MAX_EVIDENCE_INPUT_SESSIONS);
  if (sessions.length !== sessionCount) throw new Error("Aggregate.sessionCount must equal Aggregate.sessions.length");
  for (let i = 0; i < sessions.length; i++) {
    const session = sessions[i];
    if (!isRecord(session)) throw new Error(`Aggregate.sessions[${i}] must be an object`);
    boundedId(session["id"], `Aggregate.sessions[${i}].id`, MAX_SESSION_ID_CHARS);
  }
  const sessionIds = normalizeSessionIds(sessions.map((session) => session["id"]));
  if (sessionIds.length !== sessions.length) throw new Error("Aggregate.sessions ids must be distinct");
  const findings = boundedArray(value["crossFindings"], "Aggregate.crossFindings", MAX_EVIDENCE_INPUT_FINDINGS).map(validateCrossFinding);
  const cohort = new Set(sessionIds);
  for (let index = 0; index < findings.length; index++) {
    const finding = findings[index];
    if (finding.sessions > sessionCount) {
      throw new Error(`Aggregate.crossFindings[${index}].sessions must not exceed Aggregate.sessionCount`);
    }
    if (finding.exampleSessionIds.length > finding.sessions) {
      throw new Error(`Aggregate.crossFindings[${index}].exampleSessionIds must not exceed its recurrence count`);
    }
    if (finding.exampleSessionIds.some((id) => !cohort.has(id))) {
      throw new Error(`Aggregate.crossFindings[${index}].exampleSessionIds must belong to Aggregate.sessions`);
    }
  }
  return {
    kind: "aggregate",
    value: { schemaVersion: AGGREGATE_SCHEMA_VERSION, sessionCount, sessionIds, crossFindings: findings }
  };
}
function validateInput(value) {
  if (!isRecord(value)) throw new Error("evidence input must be a JSON object");
  if (Array.isArray(value["crossFindings"])) return validateAggregate(value);
  if (Array.isArray(value["insights"])) return validateAnalysis(value);
  throw new Error("input is not a current Orangu Analysis, SlimAnalysis, or Aggregate");
}
function outputText(value, max) {
  const redacted2 = redactValue(value, { scrub: true });
  return redacted2.length <= max ? redacted2 : redacted2.slice(0, Math.max(0, max - 1)) + "\u2026";
}
function titleForRule2(ruleId) {
  const words2 = ruleId.trim().replace(/[-_]+/g, " ") || "finding";
  return words2.charAt(0).toUpperCase() + words2.slice(1);
}
function safeTitle(ruleId, title) {
  return outputText(title, MAX_TITLE_CHARS).trim() || titleForRule2(ruleId);
}
function findingFromInsight(insight, sessionId) {
  return {
    ruleId: insight.ruleId,
    title: safeTitle(insight.ruleId, insight.title),
    scope: "session",
    sessionIds: normalizeSessionIds([sessionId]),
    insightId: insight.id,
    evidence: {
      estimated: insight.savings?.estimated ?? true,
      sessions: 1,
      ...insight.savings?.tokens !== void 0 ? { savingsTokens: insight.savings.tokens } : {},
      ...insight.savings?.ms !== void 0 ? { savingsMs: insight.savings.ms } : {}
    }
  };
}
function findingFromCrossFinding(finding, scope, cohortFingerprint) {
  return {
    ruleId: finding.ruleId,
    title: safeTitle(finding.ruleId, finding.title),
    scope,
    cohortFingerprint,
    sessionIds: validateSessionIds(finding.exampleSessionIds, `Aggregate.crossFindings.${finding.ruleId}.exampleSessionIds`),
    evidence: {
      estimated: true,
      sessions: finding.sessions,
      ...finding.totalSavingsTokens ? { savingsTokens: finding.totalSavingsTokens } : {},
      ...finding.totalSavingsMs ? { savingsMs: finding.totalSavingsMs } : {}
    }
  };
}
function rowsFromAnalysis(a) {
  return a.insights.map((insight) => ({
    finding: findingFromInsight(insight, a.session.id),
    axis: insight.axis,
    severity: insight.severity,
    detail: outputText(insight.detail, MAX_OUTPUT_DETAIL_CHARS),
    recommendation: outputText(insight.recommendation, MAX_OUTPUT_DETAIL_CHARS),
    turnIndexes: [...insight.turnIndexes],
    catalogMatches: matchRule(insight.ruleId, [a]).slice(0, MAX_CATALOG_MATCHES_PER_FINDING)
  }));
}
function rowsFromAggregate(a, scope) {
  const cohortFingerprint = sessionCohortFingerprint(a.sessionIds);
  return [...a.crossFindings].sort(compareCrossFindings).map((finding) => ({
    finding: findingFromCrossFinding(finding, scope, cohortFingerprint),
    axis: finding.axis,
    severity: finding.severity,
    detail: `Recurs in ${finding.sessions} session${finding.sessions === 1 ? "" : "s"}.`,
    catalogMatches: matchRule(finding.ruleId).slice(0, MAX_CATALOG_MATCHES_PER_FINDING)
  }));
}
function catalogOutput(suggestionId2, match) {
  const entry = match.entry;
  return {
    suggestionId: suggestionId2,
    id: entry.id,
    changeClass: entry.changeClass,
    ...entry.tool !== void 0 ? { tool: entry.tool } : {},
    ...entry.skill !== void 0 ? { skill: entry.skill } : {},
    ...entry.feature !== void 0 ? { feature: entry.feature } : {},
    url: entry.url,
    verifiedAt: entry.verifiedAt,
    note: outputText(entry.note, MAX_OUTPUT_CATALOG_TEXT_CHARS),
    evidence: outputText(match.evidence, MAX_OUTPUT_CATALOG_TEXT_CHARS)
  };
}
function utf8Bytes(value) {
  return new TextEncoder().encode(value).byteLength;
}
function evidenceLimit(limit) {
  if (limit === void 0) return DEFAULT_EVIDENCE_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EVIDENCE_LIMIT) {
    throw new Error(`--limit must be an integer from 1 to ${MAX_EVIDENCE_LIMIT}`);
  }
  return limit;
}
function projectEvidence(value, options = {}) {
  const input = validateInput(value);
  const limit = evidenceLimit(options.limit);
  if (input.kind === "aggregate" && options.scope === void 0) throw new Error("Aggregate evidence requires explicit --scope repo|global");
  if (input.kind !== "aggregate" && options.scope !== void 0) throw new Error("--scope is only valid for Aggregate evidence");
  let scope = "session";
  let rows;
  if (input.kind === "aggregate") {
    const aggregateScope2 = options.scope;
    if (aggregateScope2 === void 0) throw new Error("Aggregate evidence requires explicit --scope repo|global");
    scope = aggregateScope2;
    rows = rowsFromAggregate(input.value, aggregateScope2);
  } else {
    rows = rowsFromAnalysis(input.value);
  }
  const seen = /* @__PURE__ */ new Set();
  for (const row2 of rows) {
    const id = suggestionIdV2(suggestionKey(row2.finding, "report"));
    if (seen.has(id)) throw new Error(`duplicate canonical suggestion identity ${id}`);
    seen.add(id);
  }
  const sessions = input.kind === "aggregate" ? input.value.sessionCount : 1;
  const bundle = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    source: {
      kind: input.kind,
      schemaVersion: input.value.schemaVersion,
      scope,
      sessions,
      ...input.kind === "aggregate" ? { cohortFingerprint: sessionCohortFingerprint(input.value.sessionIds) } : {}
    },
    totalFindings: rows.length,
    selectedFindings: 0,
    truncated: rows.length > 0,
    catalogMatches: [],
    findings: []
  };
  for (const row2 of rows.slice(0, limit)) {
    const suggestionId2 = suggestionIdV2(suggestionKey(row2.finding, "report"));
    const matches = row2.catalogMatches.map((match) => catalogOutput(suggestionId2, match));
    const finding = {
      suggestionId: suggestionId2,
      findingToken: encodeFinding(row2.finding, "report"),
      finding: row2.finding,
      axis: row2.axis,
      severity: row2.severity,
      detail: row2.detail,
      ...row2.recommendation !== void 0 ? { recommendation: row2.recommendation } : {},
      ...row2.turnIndexes !== void 0 ? { turnIndexes: row2.turnIndexes } : {},
      catalogMatchIds: matches.map((match) => match.id)
    };
    const catalogStart = bundle.catalogMatches.length;
    bundle.catalogMatches.push(...matches);
    bundle.findings.push(finding);
    bundle.selectedFindings = bundle.findings.length;
    bundle.truncated = bundle.selectedFindings < rows.length;
    if (utf8Bytes(JSON.stringify(bundle)) > MAX_EVIDENCE_OUTPUT_BYTES) {
      bundle.catalogMatches.splice(catalogStart);
      bundle.findings.pop();
      bundle.selectedFindings = bundle.findings.length;
      bundle.truncated = true;
      break;
    }
  }
  return bundle;
}
function parseEvidenceArtifact(text2, options = {}) {
  const bytes = utf8Bytes(text2);
  if (bytes > MAX_EVIDENCE_ARTIFACT_BYTES) throw new Error(`evidence artifact exceeds ${MAX_EVIDENCE_ARTIFACT_BYTES} bytes`);
  let value;
  try {
    value = JSON.parse(text2);
  } catch (error) {
    throw new Error(`invalid evidence JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return projectEvidence(value, options);
}
function estimateEvidence(bundle) {
  const bytes = utf8Bytes(JSON.stringify(bundle));
  const approxTokens3 = Math.ceil(bytes / 4);
  return {
    bytes,
    approxTokens: approxTokens3,
    thresholdTokens: ESTIMATE_TOKEN_THRESHOLD,
    overThreshold: approxTokens3 > ESTIMATE_TOKEN_THRESHOLD
  };
}

// src/suggest/estimate.ts
var evidenceBytes = (a) => Buffer.byteLength(JSON.stringify(projectEvidence(redactAnalysis(a, { scrub: true, stripText: true }).analysis)));
async function estimateFor(sessionIds, load, size = evidenceBytes) {
  let bytes = 0;
  let sessions = 0;
  let files2 = 0;
  const skipped = [];
  for (const id of sessionIds) {
    const loaded = await load(id);
    if (!loaded.ok) {
      skipped.push({ selector: id, reason: loaded.reason });
      continue;
    }
    const a = loaded.analysis;
    sessions++;
    files2 += 1 + a.session.subagentPaths.length;
    bytes += size(a);
  }
  const approxTokens3 = Math.ceil(bytes / 4);
  return { bytes, approxTokens: approxTokens3, sessions, files: files2, overThreshold: approxTokens3 > ESTIMATE_TOKEN_THRESHOLD, skipped };
}

// src/suggest/receipt.ts
import { createHash as createHash3, createPrivateKey, createPublicKey, generateKeyPairSync, sign as signBytes, verify as verifyBytes } from "node:crypto";
var CONFIRMATION_PUBLIC_KEY_ENV = "ORANGU_CONFIRMATION_PUBLIC_KEY";
var CONFIRMATION_RECEIPT_TTL_MS = 10 * 6e4;
var MAX_RECEIPT_TTL_MS = 15 * 6e4;
var MAX_RECEIPT_CHARS = 2048;
var CLOCK_SKEW_MS = 3e4;
function hash(value) {
  return createHash3("sha256").update(value).digest("base64url");
}
function sessionsHash(record2) {
  return hash(JSON.stringify(normalizeSessionIds(record2.sessionIds)));
}
function estimateHash(estimate) {
  return hash(
    JSON.stringify({
      bytes: estimate.bytes,
      approxTokens: estimate.approxTokens,
      sessions: estimate.sessions,
      files: estimate.files,
      overThreshold: estimate.overThreshold
    })
  );
}
function invalid(reason) {
  return { valid: false, reason };
}
function verifyConfirmationReceipt(o) {
  if (!o.publicKey) return invalid("confirmation public key unavailable");
  if (!o.token || o.token.length > MAX_RECEIPT_CHARS) return invalid("receipt is empty or too large");
  const parts = o.token.split(".");
  if (parts.length !== 2) return invalid("receipt format is invalid");
  const [payload, signature] = parts;
  if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]{86}$/.test(signature)) return invalid("receipt format is invalid");
  const payloadBytes = Buffer.from(payload, "base64url");
  const signatureBytes = Buffer.from(signature, "base64url");
  if (payloadBytes.toString("base64url") !== payload || signatureBytes.toString("base64url") !== signature)
    return invalid("receipt encoding is not canonical");
  try {
    const key = createPublicKey({ key: Buffer.from(o.publicKey, "base64url"), format: "der", type: "spki" });
    if (!verifyBytes(null, Buffer.from(payload), key, signatureBytes)) return invalid("receipt signature is invalid");
  } catch {
    return invalid("receipt public key is invalid");
  }
  let claims;
  try {
    claims = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    return invalid("receipt payload is invalid");
  }
  if (claims?.v !== 1 || typeof claims.suggestionId !== "string" || !["session", "repo", "global"].includes(claims.scope) || typeof claims.sessionsHash !== "string" || typeof claims.estimateHash !== "string" || !Number.isFinite(claims.issuedAt) || !Number.isFinite(claims.expiresAt) || claims.expiresAt <= claims.issuedAt || claims.expiresAt - claims.issuedAt > MAX_RECEIPT_TTL_MS) {
    return invalid("receipt claims are invalid");
  }
  if (claims.issuedAt > o.now + CLOCK_SKEW_MS) return invalid("receipt was issued in the future");
  if (claims.expiresAt < o.now) return invalid("receipt has expired");
  if (claims.suggestionId !== o.record.id) return invalid("receipt suggestion does not match");
  if (claims.scope !== o.record.scope) return invalid("receipt scope does not match");
  if (claims.sessionsHash !== sessionsHash(o.record)) return invalid("receipt sessions do not match");
  if (claims.estimateHash !== estimateHash(o.estimate)) return invalid("receipt estimate does not match");
  if (!o.estimate.overThreshold) return invalid("fresh estimate is no longer over threshold");
  return { valid: true, expiresAt: claims.expiresAt };
}

// src/suggest/slim.ts
function slimAnalysis(a) {
  return {
    schemaVersion: a.schemaVersion,
    generator: a.generator,
    slim: true,
    session: a.session,
    summary: a.summary,
    insights: a.insights,
    tools: { byName: a.tools.byName, errorGroups: a.tools.errorGroups },
    files: { mostReRead: a.files.mostReRead },
    tokens: { total: a.tokens.total, totalTokens: a.tokens.totalTokens, byModel: a.tokens.byModel, byKind: a.tokens.byKind },
    agents: { totals: a.agents.totals, byType: a.agents.byType },
    context: {
      peak: a.context.peak,
      baseline: a.context.baseline,
      final: a.context.final,
      contextWindow: a.context.contextWindow,
      cacheHitRatio: a.context.cacheHitRatio,
      reReadMultiplier: a.context.reReadMultiplier,
      compactions: a.context.compactions
    },
    quality: { signals: a.quality.signals },
    parse: { reconciliation: a.parse.reconciliation }
  };
}

// src/cli/commands/harness.ts
import { homedir as homedir4 } from "node:os";
import { basename as basename8, resolve as resolve6 } from "node:path";
var VERSION = true ? "0.6.0" : "0.0.0-dev";
var out = MACHINE_CAPS;
var err = MACHINE_CAPS;
function detectStreams(flags) {
  const machine = flagBool(flags, "json") || flagBool(flags, "quiet") || flagBool(flags, "no-color");
  out = detectCaps(process.stdout, process.env, { machine });
  err = detectCaps(process.stderr, process.env, { machine });
}
var n = (x) => x.toLocaleString("en-US");
var kb = (bytes) => (bytes / 1024).toFixed(1) + " KB";
async function runHarness(flags) {
  detectStreams(flags);
  const isGlobal = flagBool(flags, "global");
  const configArg = flagStr(flags, "root", "r");
  const cwd = flags["cwd"] ? resolve6(String(flags["cwd"])) : process.cwd();
  let refs;
  let roots;
  let scopeLabel;
  if (isGlobal) {
    roots = await claudeRoots(configArg);
    refs = await listSessions({ roots });
    scopeLabel = `global (${roots.length} roots)`;
  } else {
    roots = [configArg ?? defaultConfigDir()];
    refs = await listSessions(configArg ? { configDir: configArg, cwd } : { cwd });
    scopeLabel = `repo ${basename8(cwd)}`;
  }
  const limitDefault = isGlobal ? 500 : 200;
  const limitRaw = flagStr(flags, "limit");
  const limitParsed = limitRaw === void 0 ? limitDefault : Number(limitRaw);
  const limit = Number.isFinite(limitParsed) && limitParsed >= 0 ? Math.floor(limitParsed) : limitDefault;
  const use = refs.slice(0, limit);
  const now = Date.now();
  const analyses = [];
  let failed = 0;
  const cacheEnabled = !(flags["no-cache"] !== void 0 || process.env["ORANGU_NO_CACHE"] === "1");
  const jobsStr = flagStr(flags, "jobs", "j");
  const jobsN = jobsStr !== void 0 ? Math.max(1, Math.floor(Number(jobsStr)) || 1) : defaultJobs();
  const bundledEntry = /\.(m?js)$/.test(new URL(import.meta.url).pathname);
  if (jobsN > 1 && use.length > 1 && bundledEntry) {
    const r = await analyzeAllPooled(use, { entry: new URL(import.meta.url), jobs: jobsN, version: VERSION, now, cacheEnabled });
    analyses.push(...r.analyses);
    failed = r.failed;
  } else {
    const cache2 = cacheEnabled ? new AnalysisCache({ version: VERSION }) : null;
    for (const ref of use) {
      try {
        analyses.push(await analyzeRefCached(ref, { cache: cache2, version: VERSION, now }));
      } catch {
        failed++;
      }
    }
  }
  if (!flagBool(flags, "quiet")) process.stderr.write(paint(err, "dim", `analyzed ${plural(analyses.length, "session")}: declared vs used`) + "\n");
  const home = homedir4();
  const inventory = await collectInventory({ cwd, roots, home });
  const agg = aggregate(analyses, scopeLabel, now);
  const report = buildHarnessReport(inventory, analyses, agg, {
    version: VERSION,
    now,
    scope: { cwd, roots, global: isGlobal, limit, sessionsUnreadable: failed, home }
  });
  if (flagBool(flags, "no-redact")) return report;
  return redactValue(report, { scrub: true, stripPaths: flagBool(flags, "strip-paths"), home });
}
async function cmdHarness(_positionals, flags) {
  const report = await runHarness(flags);
  const outFile = flagStr(flags, "o", "out");
  if (outFile) {
    await writePrivateOutput(resolve6(outFile), JSON.stringify(report, null, 2));
    process.stderr.write(paint(err, "good", glyphs(err).ok) + ` harness written to ${resolve6(outFile)}
`);
    if (!flagBool(flags, "json")) return;
  }
  if (flagBool(flags, "json")) {
    process.stdout.write(JSON.stringify(report, null, flagBool(flags, "quiet") ? 0 : 2) + "\n");
    return;
  }
  printHarness(report);
}
function printHarness(r) {
  const w = (s = "") => process.stdout.write(s + "\n");
  const inv = r.inventory;
  const x = r.crosswalk;
  const scopeLabel = r.scope.global ? `global (${r.scope.roots.length} roots)` : `repo ${basename8(r.scope.cwd)}`;
  w();
  w(paint(out, ["bold", "accent"], "orangu") + "  " + paint(out, "bold", "harness \xB7 " + scopeLabel));
  w(paint(out, "dim", `  ${n(r.scope.sessionsScanned)} session${r.scope.sessionsScanned === 1 ? "" : "s"} scanned`));
  w();
  const nothing = inv.settings.length === 0 && inv.skills.length === 0 && inv.agents.length === 0 && inv.plugins.length === 0 && inv.mcpServers.length === 0 && inv.claudeMd.length === 0;
  if (nothing) {
    w(`  no harness config found under ${r.scope.roots.join(", ")}. Nothing to cross-reference`);
    w(paint(out, "dim", `
  looked for: settings.json \xB7 skills/ \xB7 agents/ \xB7 plugins/ \xB7 .mcp.json \xB7 CLAUDE.md
`));
    return;
  }
  const line = (l, v) => w("  " + l.padEnd(22) + v);
  line("inventory", `${plural(inv.totals.skills, "skill")} \xB7 ${plural(inv.totals.agents, "agent")} \xB7 ${plural(inv.totals.plugins, "plugin")} \xB7 ${plural(inv.totals.mcpServers, "MCP server")} \xB7 ${plural(inv.totals.hookCommands, "hook command")}`);
  if (inv.claudeMd.length) {
    const carried = x.claudeMd.reduce((s, c) => s + c.approxTokensCarried, 0);
    line("CLAUDE.md", `${kb(inv.totals.claudeMdBytes)} \xB7 \u2248${n(inv.totals.claudeMdApproxTokens)} tokens \xB7 \u2248${n(carried)} tokens carried across the window`);
  }
  const noSessions = r.scope.sessionsScanned === 0;
  const NO_EVIDENCE = "no sessions in scope: nothing can be classified";
  const idleSkills = x.skills.filter((s) => s.status === "idle");
  const idleMcp = x.mcpServers.filter((m) => m.status === "idle");
  const idleAgents = x.agents.filter((a) => a.status === "idle");
  const classified = (total) => total > 0 && !noSessions;
  line(
    "idle skills",
    inv.totals.skills === 0 ? "no skills installed" : noSessions ? NO_EVIDENCE : idleSkills.length ? `${idleSkills.length} of ${inv.totals.skills} never fired` : "none: every installed skill fired"
  );
  if (classified(inv.totals.skills) && idleSkills.length) w(paint(out, "dim", "    " + idleSkills.slice(0, 8).map((s) => s.name).join(", ")));
  line(
    "idle MCP",
    inv.totals.mcpServers === 0 ? "no MCP servers configured" : noSessions ? NO_EVIDENCE : idleMcp.length ? `${idleMcp.length} of ${inv.totals.mcpServers} never called` : "none: every configured server was called"
  );
  if (classified(inv.totals.mcpServers) && idleMcp.length) w(paint(out, "dim", "    " + idleMcp.slice(0, 8).map((m) => m.name).join(", ")));
  const undeclared = [
    ...x.skills.filter((s) => s.status === "undeclared").map((s) => "skill " + s.name),
    ...x.mcpServers.filter((m) => m.status === "undeclared").map((m) => "mcp " + m.name),
    ...x.agents.filter((a) => a.status === "undeclared").map((a) => "agent " + a.name),
    ...x.hooks.filter((h) => h.status === "undeclared").map((h) => "hook " + h.commandBasename)
  ];
  line("undeclared", undeclared.length ? `${undeclared.length} observed but not in the config read` : "none");
  if (undeclared.length) w(paint(out, "dim", "    " + undeclared.slice(0, 8).join(", ")));
  const usedAgents = x.agents.filter((a) => a.status === "used").length;
  const undeclaredAgents = x.agents.filter((a) => a.status === "undeclared").length;
  const undeclaredClause = undeclaredAgents ? ` \xB7 ${undeclaredAgents} undeclared` : "";
  line(
    "agents",
    inv.totals.agents === 0 ? "none defined" + undeclaredClause : noSessions ? NO_EVIDENCE : `${usedAgents} of ${inv.totals.agents} dispatched \xB7 ${idleAgents.length} never` + undeclaredClause
  );
  const hooksRun = x.hooks.reduce((s, h) => s + h.runs, 0);
  const hookErrors = x.hooks.reduce((s, h) => s + h.errors, 0);
  const meanMs = hooksRun > 0 ? Math.round(x.hooks.reduce((s, h) => s + h.totalMs, 0) / hooksRun) : 0;
  line("hooks (configured / runs / errors / mean ms)", "");
  w(paint(out, "dim", `    ${inv.totals.hookCommands} / ${n(hooksRun)} / ${hookErrors ? paint(out, "warn", String(hookErrors)) : "0"} / ${n(meanMs)} ms`));
  const modelDrift = x.models.configured && !x.models.matchesConfigured;
  const effortDrift = x.effort.configured && !x.effort.matchesConfigured;
  if (noSessions) line("drift", NO_EVIDENCE);
  else line("drift", `model ${x.models.configured ?? "(unset)"} ${modelDrift ? "\u2260" : "="} seen \xB7 effort ${x.effort.configured ?? "(unset)"} ${effortDrift ? "\u2260" : "="} seen \xB7 ${n(x.effort.slashEffortCommands)} /effort commands`);
  line("permissions", `${x.permissions.allowRules} allow / ${x.permissions.denyRules} deny / ${x.permissions.askRules} ask rules \xB7 ${n(x.permissions.promptEvents)} prompt events in ${x.permissions.promptSessions} sessions`);
  if (x.injectedListings.length) {
    w();
    w(paint(out, "bold", "  injected listings (recurring context weight, per session)"));
    for (const l of x.injectedListings.slice(0, 6)) w(`    ${l.type.padEnd(20)} \u2248${n(l.approxTokensPerSession).padStart(8)} tokens/session  ${paint(out, "dim", `(${l.sessions} sessions)`)}`);
  }
  if (r.notes.length) {
    w();
    w(paint(out, "bold", "  notes"));
    for (const note of r.notes) w(paint(out, "dim", "    \xB7 " + note));
  }
  w(paint(out, "dim", "\n  add --json for the machine-readable inventory and declared-vs-used rows\n"));
}

// src/cli/commands/estimate.ts
var SLIM_HARNESS = "--slim sizes a session projection; orangu estimate harness sizes the harness report";
var DEPTH_RETIRED = "orangu estimate has one canonical projection (the evidence bundle); --depth was retired. Use --slim to size an `analyze --json --slim` read.";
var slimBytes = (a) => Buffer.byteLength(JSON.stringify(slimAnalysis(a)));
async function loadAnalysisResult(sel, analyzeOptions = { version: "evidence", now: 0 }) {
  const value = sel.trim();
  const pathSelector = value.endsWith(".jsonl") || value.includes("/") || value.includes("\\");
  let ref;
  try {
    ref = await resolveSession(value, pathSelector ? {} : { roots: await claudeRoots() });
  } catch (err3) {
    return { ok: false, reason: `session lookup failed: ${err3.message}` };
  }
  if (!ref) return { ok: false, reason: "no such session" };
  try {
    const loaded = await readStableEvidenceSession(ref.path);
    const session = await parseClaudeCodeSession(loaded.parseInput);
    return { ok: true, analysis: analyzeSession(session, analyzeOptions) };
  } catch (err3) {
    return { ok: false, reason: err3.message };
  }
}
async function loadAnalysisBySelector(sel, analyzeOptions) {
  const loaded = await loadAnalysisResult(sel, analyzeOptions);
  return loaded.ok ? loaded.analysis : void 0;
}
async function currentSessionPath(flags) {
  const found = await resolveCurrentSession({ roots: await claudeRoots() }, process.env);
  if (found.note && !flagBool(flags, "quiet") && !flagBool(flags, "json")) process.stderr.write(`  ${found.note}
`);
  return found.ref.path;
}
async function latestSessionPath() {
  const latest = await findLatestSession({});
  if (!latest) throw new Error("No sessions found. Try: orangu list");
  return latest.path;
}
async function expandSelector(sel, flags) {
  if (sel === "current") return currentSessionPath(flags);
  if (sel === "latest") return latestSessionPath();
  return sel;
}
async function targetSessionIds(positionals, flags) {
  const suggestionId2 = flagStr(flags, "suggestion");
  if (suggestionId2) {
    const rec = await new SuggestionStore().get(suggestionId2);
    if (!rec) throw new Error(`suggestion ${suggestionId2} not found (see: orangu suggest --list)`);
    return rec.sessionIds;
  }
  if (flags["session"] === true || flags["s"] === true) throw new Error("--session needs a session selector (id, prefix, path, latest, current, or a comma list)");
  const sessionsFlag = flagStr(flags, "session", "s");
  if (sessionsFlag) {
    const out3 = [];
    for (const sel of sessionsFlag.split(",").map((s) => s.trim()).filter(Boolean)) out3.push(await expandSelector(sel, flags));
    return out3;
  }
  if (positionals[0] === "global" || positionals[0] === "all") {
    return (await listSessions({})).map((r) => r.path);
  }
  if (positionals[0] === "repo") {
    return (await listSessions({ cwd: flagStr(flags, "cwd") ?? process.cwd() })).map((r) => r.path);
  }
  if (positionals.length > 0) {
    const sel = (positionals[0] ?? "").trim();
    if (!sel) throw new Error("session selector is empty");
    return [await expandSelector(sel, flags)];
  }
  return [await latestSessionPath()];
}
var fmtKb = (bytes) => (bytes / 1024).toFixed(1) + " KB";
async function cmdEstimate(positionals, flags) {
  if (flags["depth"] !== void 0) throw new Error(DEPTH_RETIRED);
  const slim = flagBool(flags, "slim");
  if (positionals[0] === "harness") {
    if (slim) throw new Error(SLIM_HARNESS);
    const report = await runHarness({ ...flags, quiet: true });
    const bytes = Buffer.byteLength(JSON.stringify(report));
    const approxTokens3 = Math.ceil(bytes / 4);
    const est2 = {
      sessions: report.scope.sessionsScanned,
      files: report.inventory.totals.filesRead,
      bytes,
      approxTokens: approxTokens3,
      overThreshold: approxTokens3 > ESTIMATE_TOKEN_THRESHOLD
    };
    if (flagBool(flags, "json")) {
      process.stdout.write(JSON.stringify(est2, null, flagBool(flags, "quiet") ? 0 : 2) + "\n");
      return;
    }
    printEstimate(est2, "harness");
    return;
  }
  const receiptToken = flagStr(flags, "receipt");
  const suggestionSelector = flagStr(flags, "suggestion");
  if (receiptToken && !suggestionSelector) throw new Error("--receipt requires --suggestion <id>");
  let receiptRecord;
  if (receiptToken && suggestionSelector) {
    receiptRecord = await new SuggestionStore().get(suggestionSelector);
    if (!receiptRecord) throw new Error(`suggestion ${suggestionSelector} not found (see: orangu suggest --list)`);
  }
  const ids = await targetSessionIds(positionals, flags);
  const est = await estimateFor(ids, (id) => loadAnalysisResult(id), slim ? slimBytes : void 0);
  if (est.sessions === 0 && est.skipped && est.skipped.length > 0) {
    throw new Error(`no session could be projected:
${est.skipped.map((s) => `  ${s.selector}: ${s.reason}`).join("\n")}`);
  }
  const confirmationReceipt = receiptToken && receiptRecord ? verifyConfirmationReceipt({
    token: receiptToken,
    record: receiptRecord,
    estimate: est,
    publicKey: process.env[CONFIRMATION_PUBLIC_KEY_ENV],
    now: Date.now()
  }) : void 0;
  const result = confirmationReceipt ? { ...est, confirmationReceipt } : est;
  if (flagBool(flags, "json")) {
    process.stdout.write(JSON.stringify(result, null, flagBool(flags, "quiet") ? 0 : 2) + "\n");
    return;
  }
  printEstimate(est, slim ? "slim" : "evidence");
  if (confirmationReceipt) {
    process.stdout.write(
      confirmationReceipt.valid ? `  confirmation receipt valid until ${new Date(confirmationReceipt.expiresAt).toISOString()}

` : `  confirmation receipt not accepted: ${confirmationReceipt.reason ?? "unknown reason"}

`
    );
  }
}
function printEstimate(est, label) {
  const w = (s) => process.stdout.write(s + "\n");
  w("");
  w(`estimate (${label})  ${est.sessions} session${est.sessions === 1 ? "" : "s"} \xB7 ${est.files} file${est.files === 1 ? "" : "s"}`);
  w(`  read size     ${fmtKb(est.bytes)}`);
  w(`  \u2248 tokens      ${est.approxTokens.toLocaleString("en-US")}  (4 bytes/token)`);
  if (est.overThreshold) {
    w(`  \u26A0 over the ~${ESTIMATE_TOKEN_THRESHOLD.toLocaleString("en-US")}-token gate. Ask the user before reading this into an LLM`);
  } else {
    w(`  under the ~${ESTIMATE_TOKEN_THRESHOLD.toLocaleString("en-US")}-token gate, small enough to read`);
  }
  if (est.skipped && est.skipped.length > 0) {
    w(`  \u26A0 ${est.skipped.length} session${est.skipped.length === 1 ? "" : "s"} could not be projected and ${est.skipped.length === 1 ? "is" : "are"} not counted above:`);
    for (const s of est.skipped) w(`      ${s.selector}: ${s.reason}`);
  }
  w("");
}

// src/cli/commands/evidence.ts
import { extname, resolve as resolve7 } from "node:path";
function aggregateScope(flags) {
  const raw = flags["scope"];
  if (raw === void 0) return void 0;
  if (raw !== "repo" && raw !== "global") throw new Error("--scope must be repo|global and is required for Aggregate JSON");
  return raw;
}
function requestedLimit(flags) {
  const raw = flags["limit"];
  if (raw === void 0) return evidenceLimit(void 0);
  if (typeof raw !== "string" || !raw.trim()) throw new Error("--limit requires an integer value");
  return evidenceLimit(Number(raw));
}
async function selectorOptions(flags) {
  const configDir = flagStr(flags, "root", "config", "r");
  const cwd = flagStr(flags, "cwd");
  if (flagBool(flags, "global")) return { roots: await claudeRoots(configDir), ...cwd ? { cwd } : {} };
  return { ...configDir ? { configDir } : {}, ...cwd ? { cwd } : {} };
}
async function resolveEvidenceSession(selector, flags) {
  const options = await selectorOptions(flags);
  if (selector === "latest") {
    const latest = await findLatestSession(options);
    if (!latest) throw new Error("No sessions found. Is Claude Code installed? Try: orangu list");
    return latest;
  }
  if (selector === "current") {
    const found = await resolveCurrentSession(options, process.env);
    if (found.note && !flagBool(flags, "quiet")) process.stderr.write(`  ${found.note}
`);
    return found.ref;
  }
  const resolved = await resolveSession(selector, options);
  if (resolved) return resolved;
  const candidates = await candidatesForPrefix(selector, options);
  if (candidates.length > 1) throw new Error(`Ambiguous session "${selector}". ${candidates.length} matches`);
  throw new Error(`No session matches "${selector}". Try: orangu list`);
}
async function bundleFromJsonFile(path, options) {
  const absolute = resolve7(path);
  const text2 = await readStableTextFile(absolute, MAX_EVIDENCE_ARTIFACT_BYTES, "evidence JSON");
  return parseEvidenceArtifact(text2, options);
}
async function bundleFromSession(selector, flags, options) {
  const ref = await resolveEvidenceSession(selector, flags);
  const loaded = await readStableEvidenceSession(ref.path);
  const session = await parseClaudeCodeSession(loaded.parseInput);
  const analysis = analyzeSession(session, { version: "evidence", now: 0 });
  const { analysis: redacted2 } = redactAnalysis(analysis, { scrub: true, stripText: !flagBool(flags, "include-text") });
  return projectEvidence(redacted2, options);
}
async function cmdEvidence(positionals, flags) {
  if (positionals.length !== 1) {
    throw new Error("usage: orangu evidence <session|latest|current|path.jsonl|analysis.json> [--scope repo|global] [--limit <n>] [--estimate] [--include-text]");
  }
  if (flagBool(flags, "no-redact")) throw new Error("evidence output is always redacted; --no-redact is not supported");
  if (flags["depth"] !== void 0) throw new Error("orangu evidence has one canonical bounded projection; --depth is not supported");
  const input = positionals[0];
  if (input === void 0) throw new Error("evidence input is required");
  const options = { limit: requestedLimit(flags), scope: aggregateScope(flags) };
  const bundle = extname(input).toLowerCase() === ".json" ? await bundleFromJsonFile(input, options) : await bundleFromSession(input, flags, options);
  const output = flagBool(flags, "estimate") ? estimateEvidence(bundle) : bundle;
  process.stdout.write(JSON.stringify(output, null, flagBool(flags, "quiet") ? 0 : 2) + "\n");
}

// src/cli/commands/suggest.ts
import { realpath as realpath8, stat as stat7 } from "node:fs/promises";

// src/suggest/artifacts.ts
import { constants as constants10 } from "node:fs";
import { chmod, lstat as lstat8, open as open10, realpath as realpath6, stat as stat6 } from "node:fs/promises";
import { basename as basename9, isAbsolute as isAbsolute5, relative as relative3, resolve as resolve8 } from "node:path";
var MAX_JSON_BYTES = 64 * 1024;
var MAX_MARKDOWN_BYTES = 256 * 1024;
var MAX_FILES = 64;
var MAX_CHECKS = 32;
var MAX_VERIFICATION_SESSIONS = 50;
var ID_RE = /^sg_[0-9a-f]{12}$/;
function artifactError(message) {
  return new Error(`invalid suggestion artifact: ${message}`);
}
function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw artifactError(`${label} must be an object`);
  return value;
}
function text(value, label, max) {
  if (typeof value !== "string") throw artifactError(`${label} must be a string`);
  const result = value.trim();
  if (!result || result.length > max || result.includes("\0")) throw artifactError(`${label} must contain 1-${max} safe characters`);
  return result;
}
function optionalText(value, label, max) {
  return value === void 0 ? void 0 : text(value, label, max);
}
function versionAndId(value, id) {
  if (value["v"] !== 1) throw artifactError("v must be 1");
  if (!ID_RE.test(id) || value["id"] !== id) throw artifactError(`id must exactly match ${id}`);
}
function safeRepoFile(value, label) {
  if (typeof value !== "string" || !value.trim() || value.length > 500 || value.includes("\0")) {
    throw artifactError(`${label} must contain 1-500 safe characters`);
  }
  const violation = reviewedPathViolation(value);
  if (violation) throw artifactError(`${label} ${violation}`);
  const canonical = canonicalReviewedPath(value);
  if (!canonical) throw artifactError(`${label} could not be canonicalized`);
  return canonical;
}
function files(value, label, required) {
  if (value === void 0 && !required) return [];
  if (!Array.isArray(value) || value.length > MAX_FILES || required && value.length === 0) {
    throw artifactError(`${label} must contain ${required ? "1-" : "0-"}${MAX_FILES} file paths`);
  }
  const result = value.map((item, index) => safeRepoFile(item, `${label}[${index}]`));
  if (new Set(result.map((file) => reviewedPathKey(file))).size !== result.length) {
    throw artifactError(`${label} must not contain duplicate or platform-aliased paths`);
  }
  return result;
}
function checks(value, parse) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_CHECKS) {
    throw artifactError(`checks must contain 1-${MAX_CHECKS} successful checks`);
  }
  return value.map((item, index) => parse(object(item, `checks[${index}]`), index));
}
function inside(root, candidate) {
  const rel = relative3(root, candidate);
  return rel === "" || !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && rel !== ".." && !isAbsolute5(rel);
}
function artifactSnapshot(stat8) {
  return {
    dev: stat8.dev,
    ino: stat8.ino,
    mode: stat8.mode,
    nlink: stat8.nlink,
    size: stat8.size,
    mtimeNs: stat8.mtimeNs,
    ctimeNs: stat8.ctimeNs
  };
}
function sameArtifactSnapshot(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
async function readArtifact(proposalsDir, path, expectedName, maxBytes) {
  const root = resolve8(proposalsDir);
  const candidate = resolve8(path);
  if (!inside(root, candidate) || basename9(candidate) !== expectedName) {
    throw artifactError(`${expectedName} must be inside ${root}`);
  }
  let rootStat;
  let stat8;
  try {
    ;
    [rootStat, stat8] = await Promise.all([lstat8(root, { bigint: true }), lstat8(candidate, { bigint: true })]);
  } catch {
    throw artifactError(`${expectedName} does not exist`);
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw artifactError(`proposals directory must be a regular directory`);
  if (!stat8.isFile() || stat8.isSymbolicLink()) throw artifactError(`${expectedName} must be a regular, non-symlink file`);
  if (stat8.nlink !== 1n) throw artifactError(`${expectedName} must have exactly one hard link`);
  if (stat8.size > BigInt(maxBytes)) throw artifactError(`${expectedName} exceeds ${maxBytes} bytes`);
  if (process.platform !== "win32") await chmod(root, 448);
  const [realRoot, realCandidate] = await Promise.all([realpath6(root), realpath6(candidate)]);
  if (!inside(realRoot, realCandidate)) throw artifactError(`${expectedName} resolves outside ${realRoot}`);
  const initial = artifactSnapshot(stat8);
  let handle;
  try {
    handle = await open10(realCandidate, constants10.O_RDONLY | (constants10.O_NOFOLLOW ?? 0));
  } catch {
    throw artifactError(`${expectedName} changed before it was read`);
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || !sameArtifactSnapshot(initial, artifactSnapshot(before))) {
      throw artifactError(`${expectedName} changed before it was read`);
    }
    if (process.platform !== "win32") await handle.chmod(384);
    const [secured, securedPath, securedReal] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat8(candidate, { bigint: true }),
      realpath6(candidate)
    ]);
    if (secured.nlink !== 1n || securedPath.nlink !== 1n || securedPath.isSymbolicLink() || securedReal !== realCandidate || !sameArtifactSnapshot(artifactSnapshot(secured), artifactSnapshot(securedPath))) {
      throw artifactError(`${expectedName} changed before it was read`);
    }
    const expected = artifactSnapshot(secured);
    const buffer = Buffer.allocUnsafe(Number(before.size));
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const [after, pathAfter, realAfter] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat8(candidate, { bigint: true }),
      realpath6(candidate)
    ]);
    if (offset !== buffer.length || after.nlink !== 1n || pathAfter.nlink !== 1n || pathAfter.isSymbolicLink() || realAfter !== realCandidate || !sameArtifactSnapshot(expected, artifactSnapshot(after)) || !sameArtifactSnapshot(expected, artifactSnapshot(pathAfter))) {
      throw artifactError(`${expectedName} changed while it was being read`);
    }
    return { path: candidate, body: buffer.toString("utf8") };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("invalid suggestion artifact:")) throw error;
    throw artifactError(`${expectedName} changed while it was being read`);
  } finally {
    await handle.close();
  }
}
async function readJsonArtifact(proposalsDir, path, expectedName) {
  const loaded = await readArtifact(proposalsDir, path, expectedName, MAX_JSON_BYTES);
  let parsed;
  try {
    parsed = JSON.parse(loaded.body);
  } catch {
    throw artifactError(`${expectedName} is not valid JSON`);
  }
  return { path: loaded.path, value: object(parsed, expectedName) };
}
async function loadProposalArtifacts(proposalsDir, id, proposalPath, manifestPath, workspace) {
  const markdown = await readArtifact(proposalsDir, proposalPath, `${id}.md`, MAX_MARKDOWN_BYTES);
  if (!manifestPath) {
    return { title: id, change: `see ${markdown.path}`, effort: "M", proposalPath: markdown.path };
  }
  const { path, value } = await readJsonArtifact(proposalsDir, manifestPath, `${id}.json`);
  if (!workspace || !isAbsolute5(workspace.cwd) || !/^\d+$/.test(workspace.device) || !/^\d+$/.test(workspace.inode)) {
    throw artifactError("structured proposals require a canonical workspace identity");
  }
  versionAndId(value, id);
  const changeClass = text(value["changeClass"], "changeClass", 50);
  if (!isChangeClass(changeClass)) throw artifactError(`changeClass "${changeClass}" is not supported`);
  const effort = value["effort"];
  if (effort !== "S" && effort !== "M" && effort !== "L") throw artifactError("effort must be S, M, or L");
  const proposalFiles = files(value["files"], "files", true);
  const verificationChecks = verificationPairs(value["verificationChecks"], "verificationChecks");
  const rank = value["rank"];
  if (rank !== void 0 && (!Number.isInteger(rank) || rank < 1 || rank > 100)) {
    throw artifactError("rank must be an integer from 1-100");
  }
  const normalizedSources = normalizeProposalSources(value["sources"]);
  if (normalizedSources.error) throw artifactError(normalizedSources.error);
  const sources = normalizedSources.sources;
  return {
    v: 1,
    title: text(value["title"], "title", 200),
    change: text(value["change"], "change", 8e3),
    effort,
    files: proposalFiles,
    proposalPath: markdown.path,
    manifestPath: path,
    changeClass,
    evidence: text(value["evidence"], "evidence", 12e3),
    expectedEffect: text(value["expectedEffect"], "expectedEffect", 4e3),
    risk: text(value["risk"], "risk", 4e3),
    verification: text(value["verification"], "verification", 4e3),
    verificationChecks,
    ...sources ? { sources } : {},
    ...rank !== void 0 ? { rank } : {},
    workspace
  };
}
async function loadApplicationReceipt(proposalsDir, id, receiptPath, reviewedFiles) {
  const { path, value } = await readJsonArtifact(proposalsDir, receiptPath, `${id}.applied.json`);
  versionAndId(value, id);
  const applicationChecks = checks(value["checks"], (item, index) => {
    if (item["ok"] !== true) throw artifactError(`checks[${index}].ok must be true`);
    return {
      name: text(item["name"], `checks[${index}].name`, 300),
      ...item["command"] !== void 0 ? { command: text(item["command"], `checks[${index}].command`, 2e3) } : {},
      ok: true
    };
  });
  const appliedFiles = files(value["files"], "files", true);
  if (JSON.stringify([...appliedFiles].sort()) !== JSON.stringify([...reviewedFiles].sort())) {
    throw artifactError("application files must exactly match the reviewed proposal files");
  }
  return {
    v: 1,
    summary: text(value["summary"], "summary", 4e3),
    files: appliedFiles,
    checks: applicationChecks,
    receiptPath: path
  };
}
async function loadVerificationReceipt(proposalsDir, id, receiptPath, context) {
  const { path, value } = await readJsonArtifact(proposalsDir, receiptPath, `${id}.verified.json`);
  versionAndId(value, id);
  if (!Number.isFinite(context.applicationStatusAt) || context.applicationStatusAt <= 0) {
    throw artifactError("application status timestamp is missing or invalid");
  }
  optionalText(value["summary"], "summary", 4e3);
  const baselineSelectors = sessionSelectors(context.baselineSessionIds, "baselineSessionIds");
  const laterSelectors = sessionSelectors(value["measuredSessionIds"], "measuredSessionIds");
  const intents = verificationIntents(value, context.expectedChecks);
  const workspaceCwd = await canonicalWorkspace(context.workspace);
  const baseline = await resolveAnalyses(baselineSelectors, "baselineSessionIds", workspaceCwd, context.loadAnalysis);
  const later = await resolveAnalyses(laterSelectors, "measuredSessionIds", workspaceCwd, context.loadAnalysis);
  await canonicalWorkspace(context.workspace);
  const measuredSessionIds = validateVerificationTimeline(baseline, later, context.applicationStatusAt);
  const computed = computeVerificationChecks(intents, baseline, later);
  return {
    receipt: {
      v: 1,
      summary: verificationReceiptSummary(computed.checks),
      measuredSessionIds,
      checks: computed.checks,
      receiptPath: path
    },
    effect: { before: computed.before, after: computed.after, measuredSessionIds }
  };
}
function verificationPairs(value, label) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_CHECKS) {
    throw artifactError(`${label} must contain 1-${MAX_CHECKS} metric/comparison pairs`);
  }
  const result = value.map((raw, index) => {
    const item = object(raw, `${label}[${index}]`);
    const metric = item["metric"];
    if (!isVerificationMetric(metric)) throw artifactError(`${label}[${index}].metric is not supported`);
    const comparison = item["comparison"];
    if (!isVerificationComparison(comparison)) throw artifactError(`${label}[${index}].comparison is not supported`);
    return { metric, comparison };
  });
  if (!hasUniqueVerificationIntents(result)) throw artifactError(`${label} must not contain duplicate metric/comparison pairs`);
  return result;
}
function verificationIntents(value, expectedChecks) {
  if (value["before"] !== void 0 || value["after"] !== void 0) {
    throw artifactError("before and after must be omitted; Orangu computes metrics from resolved sessions");
  }
  if (Array.isArray(value["checks"])) {
    value["checks"].forEach((raw, index) => {
      const item = object(raw, `checks[${index}]`);
      const selfAttested = ["ok", "before", "after", "evidence"].find((field) => item[field] !== void 0);
      if (selfAttested) throw artifactError(`checks[${index}] must omit ok, before, after, and evidence; Orangu computes them`);
      optionalText(item["name"], `checks[${index}].name`, 300);
    });
  }
  const intents = verificationPairs(value["checks"], "checks");
  const reviewed = verificationPairs(expectedChecks, "expected verificationChecks");
  if (!sameVerificationIntentSet(intents, reviewed)) {
    throw artifactError("checks must exactly match the reviewed proposal verificationChecks");
  }
  return reviewed;
}
function validateVerificationTimeline(baseline, later, applicationStatusAt) {
  if (new Set(baseline.map((entry) => entry.id)).size !== baseline.length) {
    throw artifactError("baselineSessionIds must resolve to distinct sessions");
  }
  const baselineIds = new Set(baseline.map((entry) => entry.id));
  if (later.some((entry) => baselineIds.has(entry.id))) {
    throw artifactError("measuredSessionIds must resolve to later evidence, not a baseline session");
  }
  if (new Set(later.map((entry) => entry.id)).size !== later.length) {
    throw artifactError("measuredSessionIds must resolve to distinct sessions");
  }
  const baselineEndTimes = baseline.map((entry) => completedSessionEnd(entry, "baseline"));
  later.forEach((entry) => completedSessionEnd(entry, "measured"));
  const baselineMaxStartedAt = Math.max(...baseline.map((entry) => entry.startedAt));
  if (baselineMaxStartedAt > applicationStatusAt) {
    throw artifactError("baseline sessions must start no later than the application transition");
  }
  const baselineMaxEndedAt = Math.max(...baselineEndTimes);
  if (baselineMaxEndedAt > applicationStatusAt) {
    throw artifactError("baseline sessions must end no later than the application transition");
  }
  const notLater = later.find((entry) => entry.startedAt <= Math.max(applicationStatusAt, baselineMaxEndedAt));
  if (notLater) {
    throw artifactError(`measured session ${notLater.id} must start after the application transition and every baseline session`);
  }
  return later.map((entry) => entry.id).sort();
}
function completedSessionEnd(entry, label) {
  if (entry.live !== false) {
    throw artifactError(`${label} session ${entry.id} is live and cannot be used for verification`);
  }
  if (typeof entry.endedAt !== "number" || !Number.isFinite(entry.endedAt) || entry.endedAt <= 0) {
    throw artifactError(`${label} session ${entry.id} has no valid session end timestamp`);
  }
  if (entry.endedAt < entry.startedAt) {
    throw artifactError(`${label} session ${entry.id} ends before it starts`);
  }
  return entry.endedAt;
}
function computeVerificationChecks(intents, baseline, later) {
  const entries = intents.map((intent, index) => {
    const before = averageMetric(baseline, intent.metric);
    const after = averageMetric(later, intent.metric);
    if (!compareMetric(before, after, intent.comparison)) {
      throw artifactError(`checks[${index}] did not pass: ${intent.metric} ${intent.comparison} (before ${before}, after ${after})`);
    }
    const check = {
      name: verificationCheckName(intent),
      metric: intent.metric,
      comparison: intent.comparison,
      before,
      after,
      evidence: `${intent.metric}: ${before} \u2192 ${after} (${intent.comparison})`,
      ok: true
    };
    return check;
  });
  return {
    checks: entries,
    before: Object.fromEntries(entries.map((check) => [check.metric, check.before])),
    after: Object.fromEntries(entries.map((check) => [check.metric, check.after]))
  };
}
function sessionSelectors(value, label) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_VERIFICATION_SESSIONS) {
    throw artifactError(`${label} must contain 1-${MAX_VERIFICATION_SESSIONS} session selectors`);
  }
  const selectors = value.map((selector, index) => text(selector, `${label}[${index}]`, 2048));
  if (new Set(selectors).size !== selectors.length) throw artifactError(`${label} must not contain duplicate selectors`);
  return selectors;
}
function isVerificationMetric(value) {
  return SUGGESTION_VERIFICATION_METRICS.some((metric) => metric === value);
}
function isVerificationComparison(value) {
  return SUGGESTION_VERIFICATION_COMPARISONS.some((comparison) => comparison === value);
}
async function resolveAnalyses(selectors, label, workspaceCwd, loadAnalysis) {
  const loaded = [];
  for (let index = 0; index < selectors.length; index++) {
    const selector = selectors[index];
    let analysis;
    try {
      analysis = await loadAnalysis(selector);
    } catch {
      throw artifactError(`${label}[${index}] could not be resolved and analyzed`);
    }
    if (!analysis) throw artifactError(`${label}[${index}] could not be resolved and analyzed`);
    if (analysis.session.source !== "claude-code") throw artifactError(`${label}[${index}] is not a supported Claude session`);
    let analysisCwd;
    try {
      if (typeof analysis.session.cwd !== "string" || !isAbsolute5(analysis.session.cwd)) throw new Error("missing cwd");
      analysisCwd = await realpath6(analysis.session.cwd);
    } catch {
      throw artifactError(`${label}[${index}] has no resolvable workspace cwd`);
    }
    if (analysisCwd !== workspaceCwd) throw artifactError(`${label}[${index}] belongs to a different workspace`);
    const id = text(analysis.session.id, `${label}[${index}] canonical id`, 500).toLowerCase();
    const startedAt = analysis.session.startedAt;
    if (typeof startedAt !== "number" || !Number.isFinite(startedAt) || startedAt <= 0) {
      throw artifactError(`${label}[${index}] has no valid session start timestamp`);
    }
    loaded.push({
      id,
      startedAt,
      endedAt: analysis.session.endedAt,
      live: analysis.session.live,
      metrics: Object.fromEntries(SUGGESTION_VERIFICATION_METRICS.map((metric) => [metric, metricValue(analysis, metric)]))
    });
  }
  return loaded;
}
async function canonicalWorkspace(value) {
  try {
    if (!value || typeof value.cwd !== "string" || !isAbsolute5(value.cwd) || !/^\d+$/.test(value.device) || !/^\d+$/.test(value.inode)) {
      throw new Error("invalid identity");
    }
    const cwd = await realpath6(value.cwd);
    const current = await stat6(cwd, { bigint: true });
    if (!current.isDirectory() || cwd !== value.cwd || String(current.dev) !== value.device || String(current.ino) !== value.inode) {
      throw new Error("identity mismatch");
    }
    return cwd;
  } catch {
    throw artifactError("reviewed proposal workspace identity no longer matches the current workspace");
  }
}
function averageMetric(analyses, metric) {
  const total = analyses.reduce((sum2, entry) => sum2 + entry.metrics[metric], 0);
  return Number((total / analyses.length).toFixed(6));
}
function metricValue(analysis, metric) {
  const values = {
    avgTotalTokens: analysis.summary.totalTokens,
    avgToolCalls: analysis.summary.toolCalls,
    avgToolErrors: analysis.summary.toolErrors,
    avgActiveMs: analysis.summary.activeMs,
    avgContextPeak: analysis.summary.contextPeak,
    avgTestRunsFailed: analysis.summary.outcomes.testRunsFailed,
    avgBuildRunsFailed: analysis.summary.outcomes.buildRunsFailed,
    avgInterruptions: analysis.turns.filter((turn) => turn.interrupted).length
  };
  const value = values[metric];
  if (!Number.isFinite(value) || value < 0) throw artifactError(`resolved Analysis has an invalid ${metric} value`);
  return value;
}
function compareMetric(before, after, comparison) {
  if (comparison === "decreased") return after < before;
  if (comparison === "not-increased") return after <= before;
  if (comparison === "increased") return after > before;
  if (comparison === "not-decreased") return after >= before;
  return after === before;
}

// src/adapters/claude-code/discovered-analysis.ts
import { realpath as realpath7 } from "node:fs/promises";
import { isAbsolute as isAbsolute6, resolve as resolve9 } from "node:path";
var MAX_VERIFICATION_DISCOVERED_SESSIONS = 1e4;
var MIN_VERIFICATION_QUIET_MS = 30 * 6e4;
async function discoveredInventory() {
  const refs = (await listSessions({ roots: await claudeRoots(), maxSessions: MAX_VERIFICATION_DISCOVERED_SESSIONS })).filter((ref) => SESSION_ID_RE.test(ref.sessionId));
  if (refs.length > MAX_VERIFICATION_DISCOVERED_SESSIONS) {
    throw new Error(`verification discovery exceeds ${MAX_VERIFICATION_DISCOVERED_SESSIONS} sessions`);
  }
  const byCanonicalPath = /* @__PURE__ */ new Map();
  for (const ref of refs) {
    try {
      const canonical = await realpath7(ref.path);
      const prior = byCanonicalPath.get(canonical);
      if (prior === void 0) byCanonicalPath.set(canonical, ref);
      else if (prior !== null && resolve9(prior.path) !== resolve9(ref.path)) byCanonicalPath.set(canonical, null);
    } catch {
    }
  }
  return { refs, byCanonicalPath };
}
async function exactDiscoveredRef(selector, inventory) {
  const value = selector.trim();
  if (!value) return void 0;
  let matches;
  if (SESSION_ID_RE.test(value)) {
    matches = inventory.refs.filter((ref) => ref.sessionId.toLowerCase() === value.toLowerCase());
  } else if (value.endsWith(".jsonl") || value.includes("/") || value.includes("\\")) {
    let canonical;
    try {
      canonical = await realpath7(isAbsolute6(value) ? value : resolve9(process.cwd(), value));
    } catch {
      return void 0;
    }
    const indexed = inventory.byCanonicalPath.get(canonical);
    matches = indexed ? [indexed] : [];
  } else {
    return void 0;
  }
  const unique = new Map(matches.map((ref) => [resolve9(ref.path), ref]));
  return unique.size === 1 ? [...unique.values()][0] : void 0;
}
function createDiscoveredClaudeAnalysisLoader(maxTotalBytes = MAX_EVIDENCE_SESSION_BYTES, options = {}) {
  if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 1 || maxTotalBytes > MAX_EVIDENCE_SESSION_BYTES) {
    throw new Error(`verification read budget must be an integer from 1-${MAX_EVIDENCE_SESSION_BYTES} bytes`);
  }
  let remainingBytes = maxTotalBytes;
  const inventory = discoveredInventory();
  return async (selector) => {
    try {
      if (remainingBytes < 1) return void 0;
      const ref = await exactDiscoveredRef(selector, await inventory);
      if (!ref) return void 0;
      const loaded = await withStableSessionRead(ref.path, void 0, async (manifest) => {
        if (options.requireQuiet) {
          const changedAt = evidenceManifestLatestChangeMs(manifest);
          const observedAt = (options.now ?? Date.now)();
          if (changedAt === void 0 || !Number.isFinite(observedAt) || observedAt < changedAt || observedAt - changedAt < MIN_VERIFICATION_QUIET_MS) return void 0;
        }
        return readEvidenceSessionManifest(manifest, remainingBytes);
      });
      if (!loaded) return void 0;
      remainingBytes -= loaded.bytesRead;
      if (options.requireQuiet && (loaded.parseInput.trailingPartial || loaded.parseInput.subagents?.some((sidecar) => sidecar.trailingPartial))) return void 0;
      const session = await parseClaudeCodeSession(loaded.parseInput);
      const analysis = analyzeSession(session, { version: "verification", now: 0 });
      if (analysis.session.source !== "claude-code" || analysis.session.id.toLowerCase() !== ref.sessionId.toLowerCase()) return void 0;
      return analysis;
    } catch {
      return void 0;
    }
  };
}

// src/version.ts
var VERSION2 = true ? "0.6.0" : "0.0.0-dev";

// src/cli/commands/suggest.ts
async function currentWorkspaceIdentity() {
  const cwd = await realpath8(process.cwd());
  const info = await stat7(cwd, { bigint: true });
  if (!info.isDirectory()) throw new Error(`current workspace is not a directory: ${cwd}`);
  return { cwd, device: String(info.dev), inode: String(info.ino) };
}
async function assertEvidenceWorkspace(rec, workspace) {
  if (rec.scope === "global") return;
  const load = createDiscoveredClaudeAnalysisLoader();
  for (const selector of rec.sessionIds) {
    const analysis = await load(selector);
    if (!analysis) {
      throw new Error(`suggestion ${rec.id} evidence session ${selector} could not be resolved from supported Claude roots`);
    }
    const cwd = analysis.session.cwd;
    if (!cwd) throw new Error(`suggestion ${rec.id} evidence session ${selector} has no workspace identity`);
    let canonical;
    try {
      canonical = await realpath8(cwd);
    } catch {
      throw new Error(`suggestion ${rec.id} evidence workspace no longer exists: ${cwd}`);
    }
    if (canonical !== workspace.cwd) {
      throw new Error(`suggestion ${rec.id} evidence belongs to workspace ${canonical}; create the proposal from that exact workspace`);
    }
    if (rec.source === "report" && rec.scope === "session") {
      const rebound = projectEvidence(analysis, { limit: MAX_EVIDENCE_LIMIT }).findings.find((finding) => finding.suggestionId === rec.id);
      const sameSnapshot2 = rebound && canonicalJson2(rebound.finding) === canonicalJson2({
        ruleId: rec.ruleId,
        title: rec.title,
        scope: rec.scope,
        sessionIds: rec.sessionIds,
        ...rec.insightId ? { insightId: rec.insightId } : {},
        evidence: rec.evidence
      });
      if (!sameSnapshot2) {
        throw new Error(`suggestion ${rec.id} does not match the canonical finding recomputed from its discovered session`);
      }
    } else if (rec.source === "report" && rec.scope === "repo" && !analysis.insights.some((insight) => insight.ruleId === rec.ruleId)) {
      throw new Error(`suggestion ${rec.id} example session does not contain the claimed recurring rule ${rec.ruleId}`);
    }
  }
}
function canonicalJson2(value) {
  return JSON.stringify(
    value,
    (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) : item
  );
}
async function assertWorkspaceMatch(rec) {
  if (rec.scope === "global") {
    throw new Error(`suggestion ${rec.id} is global and proposal-only; global apply is not supported`);
  }
  if (rec.status !== "proposed" || rec.proposal?.v !== 1 || !rec.proposal.manifestPath || !rec.proposal.files?.length) {
    throw new Error(`suggestion ${rec.id} is not an apply-ready structured proposal`);
  }
  if (!rec.proposal.workspace) throw new Error(`suggestion ${rec.id} is a legacy unbound proposal and cannot be applied`);
  const workspace = await currentWorkspaceIdentity();
  if (workspace.cwd !== rec.proposal.workspace.cwd || workspace.device !== rec.proposal.workspace.device || workspace.inode !== rec.proposal.workspace.inode) {
    throw new Error(`suggestion ${rec.id} belongs to workspace ${rec.proposal.workspace.cwd}; run apply from that exact workspace`);
  }
  return rec.proposal;
}
var SCOPES2 = ["session", "repo", "global"];
var STATUSES = ["new", "kicked-off", "proposed", "applied", "verified", "rejected", "failed"];
var emit = (v, flags) => process.stdout.write(JSON.stringify(v, null, flagBool(flags, "quiet") ? 0 : 2) + "\n");
function visible(value, flags) {
  return flagBool(flags, "no-redact") ? value : redactValue(value, { scrub: true });
}
function terminal(value) {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}
function printRecord(rec) {
  const w = (s) => process.stdout.write(s + "\n");
  const status = rec.status === "verified" && !isTrustedComputedVerification(rec) ? "legacy-unverified" : rec.status;
  w(`  ${terminal(rec.id)}  [${terminal(status)}]  ${terminal(rec.title)}`);
  w(`    rule ${terminal(rec.ruleId)} \xB7 scope ${terminal(rec.scope)} \xB7 sessions ${rec.sessionIds.map((s) => terminal(s.slice(0, 8))).join(", ")}`);
  if (rec.proposal) w(`    proposal: ${terminal(rec.proposal.proposalPath)}`);
}
function printCatalog(matches) {
  const w = (s) => process.stdout.write(s + "\n");
  for (const m of matches) {
    const what = m.entry.tool ? `tool ${m.entry.tool}` : m.entry.skill ? `skill ${m.entry.skill}` : `feature ${m.entry.feature}`;
    w(`    catalog ${m.entry.id}: ${what}${m.entry.url ? ` \xB7 ${m.entry.url}` : ""}${m.entry.verifiedAt ? ` \xB7 verified ${m.entry.verifiedAt}` : " \xB7 candidate (unverified)"}`);
  }
}
async function cmdList(store, flags) {
  const scope = flagStr(flags, "scope");
  let all = await store.all();
  if (scope) all = all.filter((r) => r.scope === scope);
  if (flagBool(flags, "json")) return emit(visible(all, flags), flags);
  if (!all.length) {
    process.stdout.write("no suggestions yet. Create one from a report finding or: orangu suggest --rule <r> --scope session --session <id>\n");
    return;
  }
  for (const rec of all) printRecord(visible(rec, flags));
}
async function cmdShow(store, id, flags) {
  const rec = await store.get(id);
  if (!rec) throw new Error(`suggestion ${id} not found (see: orangu suggest --list)`);
  const forApply = flagBool(flags, "for-apply");
  const forProposal = flagBool(flags, "for-proposal");
  if (forApply && forProposal) throw new Error("--for-proposal and --for-apply are mutually exclusive");
  if (forApply) await assertWorkspaceMatch(rec);
  if (forProposal && rec.scope !== "global") await assertEvidenceWorkspace(rec, await currentWorkspaceIdentity());
  const sessions = [];
  const missing = [];
  for (const sel of rec.sessionIds) {
    const a = await loadAnalysisBySelector(sel, { version: VERSION2, now: Date.now() });
    if (!a) {
      missing.push(sel);
      continue;
    }
    const body = flagBool(flags, "no-redact") ? a : redactAnalysis(a, { scrub: true }).analysis;
    sessions.push(slimAnalysis(body));
  }
  const catalog = matchRule(rec.ruleId, sessions);
  if (flagBool(flags, "json")) {
    return emit(visible({
      record: rec,
      sessions,
      catalog,
      missingSessionIds: missing,
      ...rec.status === "verified" ? { verificationTrusted: isTrustedComputedVerification(rec) } : {},
      ...forApply ? { workspaceMatchesCurrent: true } : {},
      ...forProposal ? { proposalEligibility: rec.scope === "global" ? "global-proposal-only" : "workspace-bound" } : {}
    }, flags), flags);
  }
  printRecord(visible(rec, flags));
  printCatalog(catalog);
  process.stdout.write(`  evidence: ${sessions.length} session(s) loaded${missing.length ? `, ${missing.length} unresolvable` : ""}. Add --json for the slim data
`);
}
async function cmdSet(store, id, positionals, flags) {
  const status = positionals[0];
  if (!status || !STATUSES.includes(status)) throw new Error(`usage: orangu suggest --set <id> <${STATUSES.join("|")}>`);
  const proposalPath = flagStr(flags, "proposal");
  const manifestPath = flagStr(flags, "manifest");
  const applicationPath = flagStr(flags, "application");
  const verificationPath = flagStr(flags, "verification");
  const artifactNames = ["proposal", "manifest", "application", "verification"];
  for (const name of artifactNames) {
    if (flags[name] !== void 0 && typeof flags[name] !== "string") throw new Error(`--${name} requires a file path`);
  }
  const rec = await store.get(id);
  if (!rec) throw new Error(`suggestion ${id} not found (see: orangu suggest --list)`);
  if (!(TRANSITIONS[rec.status] ?? []).includes(status)) {
    throw new Error(`illegal transition ${rec.status} \u2192 ${status} for ${id} (allowed: ${(TRANSITIONS[rec.status] ?? []).join(", ") || "none"})`);
  }
  const allowedArtifacts = status === "proposed" ? /* @__PURE__ */ new Set(["proposal", "manifest"]) : status === "applied" ? /* @__PURE__ */ new Set(["application"]) : status === "verified" ? /* @__PURE__ */ new Set(["verification"]) : /* @__PURE__ */ new Set();
  const unexpectedArtifact = artifactNames.find((name) => flags[name] !== void 0 && !allowedArtifacts.has(name));
  if (unexpectedArtifact) throw new Error(`--${unexpectedArtifact} is not valid when setting ${status}`);
  let patch;
  if (status === "proposed") {
    if (!proposalPath) throw new Error("--proposal <id>.md is required when setting proposed");
    const workspace = await currentWorkspaceIdentity();
    if (manifestPath) await assertEvidenceWorkspace(rec, workspace);
    const proposal = await loadProposalArtifacts(store.proposalsDir, rec.id, proposalPath, manifestPath, workspace);
    patch = {
      proposal: manifestPath ? proposal : { ...proposal, title: rec.title, change: `see ${proposal.proposalPath}` }
    };
  } else if (status === "applied") {
    if (!applicationPath) throw new Error("--application <id>.applied.json is required when setting applied");
    const proposal = await assertWorkspaceMatch(rec);
    patch = { application: await loadApplicationReceipt(store.proposalsDir, rec.id, applicationPath, proposal.files) };
  } else if (status === "verified") {
    if (!verificationPath) throw new Error("--verification <id>.verified.json is required when setting verified");
    if (rec.scope !== "session") {
      throw new Error(`suggestion ${id} has ${rec.scope} scope; later verification is currently supported only for one-session suggestions`);
    }
    if (!rec.application) throw new Error(`suggestion ${id} has no validated application receipt to verify`);
    if (!rec.proposal?.verificationChecks?.length) {
      throw new Error(`suggestion ${id} has no reviewed structured verification checks`);
    }
    if (!rec.proposal.workspace) throw new Error(`suggestion ${id} has no canonical proposal workspace`);
    const verified = await loadVerificationReceipt(store.proposalsDir, rec.id, verificationPath, {
      baselineSessionIds: rec.sessionIds,
      applicationStatusAt: rec.statusAt,
      expectedChecks: rec.proposal.verificationChecks,
      workspace: rec.proposal.workspace,
      loadAnalysis: createDiscoveredClaudeAnalysisLoader(void 0, { requireQuiet: true })
    });
    patch = { verificationReceipt: verified.receipt, effect: verified.effect };
  }
  const next = await store.transition(id, status, patch);
  if (flagBool(flags, "json")) return emit(visible(next, flags), flags);
  printRecord(visible(next, flags));
}
async function cmdCreate(store, positionals, flags) {
  const explicitId = positionals[0];
  if (explicitId !== void 0 && !/^sg_[0-9a-f]{12}$/.test(explicitId)) {
    throw new Error(`"${explicitId}" is not a suggestion id (sg_ + 12 hex chars). See: orangu suggest --list`);
  }
  const token = flagStr(flags, "finding");
  let finding;
  let source;
  if (token) {
    const decoded = decodeFinding(token);
    finding = decoded.finding;
    source = decoded.source;
    const canonicalId = suggestionIdV2(suggestionKey(finding, source));
    if (explicitId && explicitId !== canonicalId) {
      throw new Error(`suggestion id mismatch: encoded finding hashes to ${canonicalId}`);
    }
  } else {
    const ruleId = flagStr(flags, "rule");
    const scope = flagStr(flags, "scope") ?? "session";
    const sessions = (flagStr(flags, "session", "s") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    if (!ruleId || !sessions.length) {
      throw new Error("usage: orangu suggest [<sg_id>] --finding <token> OR --rule <ruleId> --scope session|repo|global --session <a,b> [--cohort <16hex>]");
    }
    if (!SCOPES2.includes(scope)) throw new Error(`--scope must be ${SCOPES2.join("|")}, got "${scope}"`);
    const cohort = flags["cohort"];
    if (cohort !== void 0 && (typeof cohort !== "string" || !/^[0-9a-f]{16}$/.test(cohort))) {
      throw new Error("--cohort must be exactly 16 lowercase hexadecimal characters");
    }
    if (scope === "session" && cohort !== void 0) throw new Error("--cohort is valid only with --scope repo|global");
    const cohortFingerprint = scope === "session" ? void 0 : cohort ?? sessionCohortFingerprint(sessions);
    finding = {
      ruleId,
      title: flagStr(flags, "title") ?? ruleId,
      scope,
      sessionIds: sessions,
      ...flagStr(flags, "insight") ? { insightId: flagStr(flags, "insight") } : {},
      ...cohortFingerprint ? { cohortFingerprint } : {},
      evidence: { estimated: true }
    };
    source = explicitId ? "report" : "skill";
  }
  const { record: record2, created } = await store.upsertNew(finding, source, explicitId);
  const command = kickoffCommand(record2, "serve");
  const catalog = matchRule(record2.ruleId);
  if (flagBool(flags, "json")) return emit(visible({ record: record2, created, command, catalog }, flags), flags);
  printRecord(visible(record2, flags));
  printCatalog(catalog);
  process.stdout.write(`  ${created ? "created" : "already existed"}. Continue with:
    ${command}
`);
}
async function cmdSuggest(positionals, flags) {
  const store = new SuggestionStore();
  if (flagBool(flags, "list")) return cmdList(store, flags);
  const show = flagStr(flags, "show");
  if (show) return cmdShow(store, show, flags);
  const set = flagStr(flags, "set");
  if (set) return cmdSet(store, set, positionals, flags);
  return cmdCreate(store, positionals, flags);
}

// src/cli/commands/feedback.ts
import { join as join9 } from "node:path";
import { tmpdir } from "node:os";

// src/cli/open-browser.ts
import { spawn } from "node:child_process";
function openInBrowser(target) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", target] : [target];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("error", () => {
    });
    child.unref();
  } catch {
  }
}

// src/feedback/model.ts
var FEEDBACK_CONTEXTS = ["session", "repo", "global", "report", "app"];
function isFeedbackContext(value) {
  return typeof value === "string" && FEEDBACK_CONTEXTS.includes(value);
}

// src/cli/commands/feedback.ts
var EmptySuggestionStore = class {
  async all() {
    return [];
  }
  async get(_id) {
    return void 0;
  }
  async upsertNew(_finding, _source, _id) {
    throw new Error("suggestion mutations are unavailable in feedback-only mode");
  }
  async transition(_id, _to) {
    throw new Error("suggestion mutations are unavailable in feedback-only mode");
  }
};
function feedbackContext(flags) {
  if (flags["context"] === true) throw new Error(`--context requires one of: ${FEEDBACK_CONTEXTS.join("|")}`);
  const raw = flagStr(flags, "context") ?? "app";
  if (!isFeedbackContext(raw)) throw new Error(`--context must be one of: ${FEEDBACK_CONTEXTS.join("|")}`);
  return raw;
}
function feedbackPort(flags) {
  if (flags["port"] === true) throw new Error("--port requires an integer 0\u201365535");
  const raw = flagStr(flags, "port");
  if (raw === void 0) return void 0;
  if (!/^\d+$/.test(raw)) throw new Error("--port must be an integer 0\u201365535");
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be an integer 0\u201365535");
  return port;
}
function feedbackOptions(flags) {
  const allowed = /* @__PURE__ */ new Set(["context", "port", "no-open"]);
  const unsupported = Object.keys(flags).find((name) => !allowed.has(name));
  if (unsupported) throw new Error(`unsupported feedback option --${unsupported}`);
  if (flags["no-open"] !== void 0 && flags["no-open"] !== true) throw new Error("--no-open does not accept a value");
  const context = feedbackContext(flags);
  const port = feedbackPort(flags);
  return port === void 0 ? { context } : { context, port };
}
async function cmdFeedback(positionals, flags) {
  if (positionals.length) throw new Error("usage: orangu feedback --context session|repo|global|report|app [--port <n>] [--no-open]");
  const { context, port } = feedbackOptions(flags);
  const emptyConfigDir = join9(tmpdir(), `orangu-feedback-empty-${process.pid}-${Date.now()}`);
  const server = await startServe(
    {
      port,
      open: false,
      includeText: false,
      configDir: emptyConfigDir,
      noCache: true,
      version: VERSION2,
      maxLive: 1
    },
    { cache: null, quiet: true, store: new EmptySuggestionStore() }
  );
  const url = `${server.url}/#feedback?context=${encodeURIComponent(context)}`;
  process.stderr.write(`orangu feedback (beta) \xB7 ${url}
  loopback + private capability \xB7 no sessions attached \xB7 ctrl-c stops
`);
  if (!flagBool(flags, "no-open")) openInBrowser(url);
  await new Promise((resolve11) => {
    let closing = false;
    const close = () => {
      if (closing) return;
      closing = true;
      void server.close().finally(resolve11);
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  });
  process.stderr.write("  stopped.\n");
}

// src/cli/commands/index.ts
var EXTRA_COMMANDS = {
  feedback: cmdFeedback,
  evidence: cmdEvidence,
  estimate: cmdEstimate,
  harness: cmdHarness,
  suggest: cmdSuggest
};
var EXTRA_HELP = [
  // Each entry may span lines (main.ts joins entries with '\n'); keep every line <= 80 columns.
  [
    "  orangu feedback              private localhost beta-feedback form",
    "                                 (--context session|repo|global|report|app",
    "                                  [--port <n>] [--no-open])"
  ].join("\n"),
  [
    "  orangu evidence <input>      bounded, redacted findings + matching known fixes",
    "                               for a session/.jsonl or current Orangu JSON",
    "                                 ([--scope repo|global] [--limit <n>]",
    "                                  [--estimate] [--json])"
  ].join("\n"),
  [
    "  orangu estimate [<session>|repo|global|harness]",
    "                               size what a skill would read: bytes and ~tokens",
    "                                 (--suggestion <id> [--receipt <token>]",
    "                                  | --rule <r> --session <a,b>;",
    "                                  --slim sizes an analyze --json --slim read)"
  ].join("\n"),
  [
    "  orangu harness               what your config declares vs what your sessions",
    "                               used: skills/MCP/agents/hooks",
    "                               used|idle|undeclared, in tokens",
    "                                 ([--json] [--cwd <dir>] [--root <dir>]",
    "                                  [--global] [--limit <n>] [-o|--out <file>]",
    "                                  [--no-redact] [--strip-paths] [--jobs <n>]",
    "                                  [--no-cache] [--quiet])"
  ].join("\n"),
  [
    "  orangu suggest               suggestion records in ~/.orangu",
    "                                 ([<sg_id>] --finding <token>",
    "                                  | [<sg_id>] --rule <r> --scope <s>",
    "                                    --session <a,b>",
    "                                  | --show <id> [--for-proposal|--for-apply]",
    "                                  | --set <id> <status> [--proposal <path>]",
    "                                    [--application <path>]",
    "                                    [--verification <path>]",
    "                                  | --list)"
  ].join("\n")
];

// src/cli/commands/pick.ts
import { basename as basename10 } from "node:path";

// src/cli/select.ts
var FRAME_CHROME_LINES = 5;
function windowFor(cursor, start, size, count) {
  if (count <= size) return 0;
  let s = start;
  if (cursor < s) s = cursor;
  if (cursor >= s + size) s = cursor - size + 1;
  return Math.max(0, Math.min(s, count - size));
}
function select(o) {
  const count = Math.max(1, o.count);
  const columns = () => Math.max(40, o.output.columns ?? o.caps.columns);
  const size = Math.max(1, Math.min(count, o.viewRows ?? Math.max(3, (o.output.rows ?? 24) - FRAME_CHROME_LINES)));
  let cursor = Math.max(0, Math.min(o.initial ?? 0, count - 1));
  let start = windowFor(cursor, 0, size, count);
  let drawn = 0;
  const frame = () => {
    const lines = o.render({ cursor, start, size, columns: columns() });
    drawn = lines.length;
    return lines.join("\n") + "\n";
  };
  const draw = () => {
    o.output.write(CURSOR.up(drawn) + CURSOR.home + CURSOR.eraseDown + frame());
  };
  return new Promise((resolve11) => {
    let done = false;
    const restore = () => {
      if (done) return;
      done = true;
      o.input.removeListener("data", onData);
      if (o.output.removeListener) o.output.removeListener("resize", onResize);
      try {
        o.input.setRawMode?.(false);
      } catch {
      }
      o.input.pause();
      o.output.write(CURSOR.show);
    };
    const hook = onceOnExit(restore, o.proc);
    const finish = (r) => {
      restore();
      hook.dispose();
      resolve11(r);
    };
    const move = (to) => {
      cursor = Math.max(0, Math.min(to, count - 1));
      start = windowFor(cursor, start, size, count);
      draw();
    };
    const onResize = () => draw();
    const onData = (chunk) => {
      const { key, digit } = decodeKey(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      switch (key) {
        case "cancel":
          return finish({ kind: "cancel", code: 130 });
        case "quit":
        case "escape":
          return finish({ kind: "cancel", code: 0 });
        case "enter":
          return finish({ kind: "pick", index: cursor });
        case "up":
          return move(cursor - 1);
        case "down":
          return move(cursor + 1);
        case "home":
          return move(0);
        case "end":
          return move(count - 1);
        case "pageup":
          return move(cursor - size);
        case "pagedown":
          return move(cursor + size);
        case "digit":
          return move((digit ?? 1) - 1);
        default:
          return;
      }
    };
    o.input.setEncoding?.("utf8");
    o.input.setRawMode?.(true);
    o.input.resume();
    o.input.on("data", onData);
    if (o.output.on) o.output.on("resize", onResize);
    o.output.write(CURSOR.hide + frame());
  });
}

// src/cli/commands/pick.ts
var DEFAULT_PICK_LIMIT = 20;
function interactivePrecondition(stdin, stdout, env, flags) {
  const ci = env["CI"];
  if (ci !== void 0 && ci !== "" && ci !== "false") return false;
  if (env["TERM"] === "dumb" || env["ORANGU_NO_ANIMATION"] === "1") return false;
  if (flagBool(flags, "json") || flagBool(flags, "plain") || flagBool(flags, "quiet")) return false;
  return Boolean(stdin.isTTY && stdout.isTTY && typeof stdin.setRawMode === "function");
}
async function discoverOptions(flags) {
  const configArg = flagStr(flags, "root", "config", "r");
  const opts = flagBool(flags, "global") ? { roots: await claudeRoots(configArg) } : configArg ? { configDir: configArg } : {};
  if (flags["cwd"]) opts.cwd = String(flags["cwd"]);
  return opts;
}
async function gatherPickRows(flags, deps = {}) {
  const now = deps.now ?? Date.now();
  const opts = await discoverOptions(flags);
  const refs = await listSessions(opts);
  let live = /* @__PURE__ */ new Map();
  try {
    live = await runningSessions(opts, deps.isAlive ? { isAlive: deps.isAlive } : {});
  } catch {
  }
  const isRunning = (r) => live.has(r.sessionId) || badgeFor(r.mtimeMs, now).badge !== "ended";
  const ordered = refs.map((r) => ({ r, running: isRunning(r) })).sort((a, b) => Number(b.running) - Number(a.running) || b.r.mtimeMs - a.r.mtimeMs);
  const limitStr = flagStr(flags, "limit", "l");
  const limit = limitStr !== void 0 && Number.isFinite(Number(limitStr)) && Number(limitStr) > 0 ? Math.floor(Number(limitStr)) : DEFAULT_PICK_LIMIT;
  const redact = !flagBool(flags, "no-redact");
  const rows = [];
  for (const { r, running } of ordered.slice(0, limit)) {
    const head = await peekHead(r.path);
    const title = head.title && redact ? redactValue(head.title, { scrub: true, stripPaths: flagBool(flags, "strip-paths") }) : head.title;
    const project = head.cwd ? basename10(head.cwd) : basename10(r.projectSlug);
    const row2 = { sessionId: r.sessionId, path: r.path, projectSlug: r.projectSlug, project, sizeBytes: r.sizeBytes, mtimeMs: r.mtimeMs, running };
    if (title) row2.title = title;
    rows.push(row2);
  }
  return { rows, counts: { total: refs.length, running: ordered.filter((x) => x.running).length } };
}
async function cmdPick(flags, deps) {
  const now = deps.now ?? Date.now();
  const { rows, counts } = await gatherPickRows(flags, { now, ...deps.isAlive ? { isAlive: deps.isAlive } : {} });
  if (flagBool(flags, "json")) deps.stdout.write(JSON.stringify(rows, null, 2) + "\n");
  if (!rows.length) throw new Error("No sessions found. Is Claude Code installed? Try: orangu list");
  if (flagBool(flags, "json")) return;
  if (!interactivePrecondition(deps.stdin, deps.stdout, deps.env, flags)) {
    deps.stdout.write(pickList(deps.out, rows, counts, now).join("\n") + "\n");
    return;
  }
  const result = await select({
    count: rows.length,
    render: (view) => pickFrame({ ...deps.out, columns: view.columns }, rows, view, counts, now),
    input: deps.stdin,
    output: deps.stdout,
    caps: deps.out,
    ...deps.proc ? { proc: deps.proc } : {}
  });
  if (result.kind === "cancel") {
    if (result.code) process.exitCode = result.code;
    else deps.stderr.write(paint(deps.err, "dim", "  cancelled") + "\n");
    return;
  }
  await deps.openReport(rows[result.index].sessionId);
}

// src/cli/json-out.ts
function renderAnalysisJson(a, flags) {
  let out3 = a;
  if (!flagBool(flags, "no-redact")) {
    out3 = redactAnalysis(a, { scrub: true, stripText: !flagBool(flags, "include-text"), stripPaths: flagBool(flags, "strip-paths") }).analysis;
  }
  const body = flagBool(flags, "slim") ? slimAnalysis(out3) : out3;
  return JSON.stringify(body, null, flagBool(flags, "quiet") ? 0 : 2) + "\n";
}
function emitAnalysisJson(a, flags) {
  process.stdout.write(renderAnalysisJson(a, flags));
}
function prepareAggregateForOutput(a, flags) {
  if (flagBool(flags, "no-redact")) return a;
  return redactValue(a, {
    scrub: true,
    stripText: !flagBool(flags, "include-text"),
    stripPaths: flagBool(flags, "strip-paths")
  });
}
function renderPreparedAggregateJson(a, flags, options = {}) {
  const body = JSON.stringify(a, null, options.pretty ?? !flagBool(flags, "quiet") ? 2 : 0);
  return body + (options.trailingNewline ?? true ? "\n" : "");
}

// src/cli/main.ts
var out2 = MACHINE_CAPS;
var err2 = MACHINE_CAPS;
var progress;
function detectStreams2(flags) {
  const machine = flagBool(flags, "json") || flagBool(flags, "quiet") || flagBool(flags, "no-color");
  out2 = detectCaps(process.stdout, process.env, { machine });
  err2 = detectCaps(process.stderr, process.env, { machine });
}
function offerBetaFeedback(context) {
  process.stderr.write(betaLine(err2, context) + "\n");
}
function nextStep(a, flags) {
  return persistNextStep(a, redactOptions(flags));
}
function redactOptions(flags) {
  if (flagBool(flags, "no-redact")) return false;
  return { scrub: true, stripText: !flagBool(flags, "include-text"), stripPaths: flagBool(flags, "strip-paths") };
}
function displayTitle(a, flags) {
  const title = a.session.title || a.session.id.slice(0, 12);
  const ro = redactOptions(flags);
  return ro ? redactValue(title, { scrub: ro.scrub, stripPaths: ro.stripPaths }) : title;
}
var SESSION_SELECTOR_VERBS = /* @__PURE__ */ new Set([void 0, "report", "html", "analyze", "a", "watch", "estimate", "evidence", "suggest"]);
var SELECTOR_FORMS = "an id, a unique prefix, a .jsonl path, latest, or current";
function sessionSelector(sel, flags) {
  const raw = flags["session"] ?? flags["s"];
  if (raw === void 0) return sel;
  if (typeof raw !== "string" || !raw.trim()) fail(`--session needs a session selector: ${SELECTOR_FORMS}`);
  const flag = raw.trim();
  if (flag.includes(",")) fail("--session takes one session here; comma lists belong to estimate and suggest");
  if (sel !== void 0 && sel !== flag) fail(`--session ${flag} and "${sel}" name different sessions; give one`);
  return flag;
}
async function selectSession(sel, flags) {
  sel = sessionSelector(sel, flags);
  const configArg = flagStr(flags, "root", "config", "r");
  let opts = configArg ? { configDir: configArg } : {};
  if (flagBool(flags, "global")) opts = { roots: await claudeRoots(configArg) };
  if (flags["cwd"]) opts.cwd = String(flags["cwd"]);
  if (!sel || sel === "latest") {
    const s = await findLatestSession(opts);
    if (!s) fail("No sessions found. Is Claude Code installed? Try: orangu list");
    return s;
  }
  if (sel === "current") {
    const found = await resolveCurrentSession(opts, process.env);
    if (found.note && !flagBool(flags, "quiet")) process.stderr.write("  " + paint(err2, "dim", found.note) + "\n");
    return found.ref;
  }
  const r = await resolveSession(sel, opts);
  if (r) return r;
  const cands = await candidatesForPrefix(sel, opts);
  if (cands.length > 1) {
    fail(`Ambiguous session "${sel}". ${cands.length} matches:
` + cands.slice(0, 8).map((c) => "  " + c.sessionId + "  " + basename11(c.projectSlug)).join("\n"));
  }
  fail(`No session matches "${sel}". Try: orangu list`);
  throw new Error("unreachable");
}
function fail(msg) {
  progress?.pause();
  process.stderr.write(paint(err2, "bad", "error: ") + msg + "\n");
  process.exit(1);
}
function makeCache(flags) {
  const disabled = flags["no-cache"] !== void 0 || process.env["ORANGU_NO_CACHE"] === "1";
  if (disabled) return null;
  return new AnalysisCache({ version: VERSION2 });
}
function printCacheStats(cache2, flags) {
  if (!cache2 || !flagBool(flags, "verbose") || flagBool(flags, "quiet")) return;
  const s = cache2.stats();
  process.stderr.write(row(err2, "cache", `${s.hits} hits, ${s.misses} misses`, { style: "dim" }) + "\n");
}
async function analyzeRef(ref, flags, cache2) {
  const c = cache2 !== void 0 ? cache2 : makeCache(flags);
  const analysis = await analyzeRefCached(ref, { cache: c, version: VERSION2, now: Date.now() });
  if (cache2 === void 0) printCacheStats(c, flags);
  return analysis;
}
async function analyzeWithProgress(ref, flags) {
  const quiet = flagBool(flags, "quiet") || flagBool(flags, "json");
  const t0 = performance.now();
  const sp = spinner(err2);
  progress = sp;
  if (!quiet) sp.start(`analyzing ${ref.sessionId.slice(0, 8)} ${fmtBytes(ref.sizeBytes)}`);
  try {
    const analysis = await analyzeRef(ref, flags);
    return { analysis, elapsedMs: performance.now() - t0 };
  } finally {
    sp.stop();
    progress = void 0;
  }
}
function outPath(flags, id, ext = "html") {
  const out3 = flagStr(flags, "o", "out");
  if (out3) return resolve10(out3);
  return join10(tmpdir2(), `orangu-${id.slice(0, 8)}.${ext}`);
}
async function cmdReport(sel, flags) {
  const ref = await selectSession(sel, flags);
  const { analysis, elapsedMs } = await analyzeWithProgress(ref, flags);
  const { html, redaction } = renderReport(analysis, { redact: redactOptions(flags) });
  if (flagBool(flags, "stdout")) {
    process.stdout.write(html);
    return;
  }
  const path = outPath(flags, ref.sessionId);
  await writePrivateOutput(path, html);
  const opened = !flagBool(flags, "no-open") && (flagBool(flags, "open") || out2.tty);
  if (opened) openInBrowser(path);
  process.stdout.write(path + "\n");
  if (!flagBool(flags, "quiet") && !flagBool(flags, "json")) {
    process.stderr.write(doneLine(err2, { sizeBytes: ref.sizeBytes, elapsedMs, redactions: redaction?.applied }) + "\n");
    const step = await nextStep(analysis, flags);
    process.stderr.write(reportFooter(err2, { path, opened, step }).join("\n") + "\n");
  }
  thresholdExit(analysis, flags);
}
async function cmdAnalyze(sel, flags) {
  const ref = await selectSession(sel, flags);
  const { analysis, elapsedMs } = await analyzeWithProgress(ref, flags);
  if (flagBool(flags, "json")) {
    emitAnalysisJson(analysis, flags);
    thresholdExit(analysis, flags);
    return;
  }
  process.stdout.write(analysisBlock(out2, analysis, displayTitle(analysis, flags)).join("\n") + "\n");
  if (!flagBool(flags, "quiet")) {
    process.stderr.write(doneLine(err2, { sizeBytes: ref.sizeBytes, elapsedMs }) + "\n");
    const step = await nextStep(analysis, flags);
    process.stderr.write(nextStepLines(err2, step).join("\n") + "\n");
    offerBetaFeedback("session");
  }
  thresholdExit(analysis, flags);
}
async function cmdBrief(flags) {
  const ref = await selectSession(void 0, flags);
  const { analysis } = await analyzeWithProgress(ref, flags);
  const step = await nextStep(analysis, flags);
  process.stdout.write(briefBlock(out2, analysis, displayTitle(analysis, flags), step, { hint: !flagBool(flags, "quiet") }).join("\n") + "\n");
  thresholdExit(analysis, flags);
}
var RETIRED_FLAGS = {
  "max-cost": "--max-cost was removed; use --max-tokens <n>"
};
var SESSION_GATE_FLAGS = ["max-tokens", "fail-on-hook-errors"];
var SESSION_GATE_VERBS = /* @__PURE__ */ new Set(["report", "html", "analyze", "a"]);
function rejectUnusableFlags(command, flags) {
  for (const [flag, message] of Object.entries(RETIRED_FLAGS)) if (flags[flag] !== void 0) fail(message);
  const unknown = unknownFlags(flags);
  if (unknown.length) fail(`unknown flag${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}. Run: orangu --help`);
  if (command !== void 0 && !SESSION_GATE_VERBS.has(command)) {
    for (const flag of SESSION_GATE_FLAGS) {
      if (flags[flag] !== void 0) fail(`--${flag} gates one session: use it with orangu analyze or orangu report`);
    }
  }
  if (!SESSION_SELECTOR_VERBS.has(command) && (flags["session"] !== void 0 || flags["s"] !== void 0)) {
    fail("--session selects one session: use it with report, analyze, watch, estimate or evidence");
  }
}
function thresholdExit(analysis, flags) {
  let bad = false;
  const maxTokensStr = flagStr(flags, "max-tokens");
  if (maxTokensStr !== void 0 && Number.isNaN(Number(maxTokensStr))) fail(`--max-tokens must be a number, got "${maxTokensStr}"`);
  const maxTokens = Number(maxTokensStr);
  if (maxTokensStr !== void 0 && !Number.isNaN(maxTokens) && analysis.summary.totalTokens > maxTokens) {
    process.stderr.write(paint(err2, "bad", `FAIL: ${fmtTokens(analysis.summary.totalTokens)} tokens > --max-tokens ${fmtTokens(maxTokens)}`) + "\n");
    bad = true;
  }
  if (flagBool(flags, "fail-on-hook-errors") && analysis.hooks.errors > 0) {
    process.stderr.write(paint(err2, "bad", `FAIL: ${analysis.hooks.errors} hook errors`) + "\n");
    bad = true;
  }
  if (bad) process.exit(2);
}
async function cmdList2(flags) {
  const configArg = flagStr(flags, "root", "config", "r");
  const all = flagBool(flags, "global") ? await listSessions({ roots: await claudeRoots(configArg) }) : await listSessions(configArg ? { configDir: configArg } : {});
  const limit = Number(flagStr(flags, "limit", "l") ?? "40");
  const rows = all.slice(0, Number.isNaN(limit) ? 40 : limit);
  if (flagBool(flags, "json")) {
    process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
    return;
  }
  process.stdout.write(listRows(out2, rows, { total: all.length, global: flagBool(flags, "global") }).join("\n") + "\n");
}
async function cmdAggregate(scope, selOrPath, flags) {
  let refs;
  let scopeLabel;
  if (scope === "global") {
    const roots = await claudeRoots(flagStr(flags, "root", "r"));
    refs = await listSessions({ roots });
    scopeLabel = `global (${plural(roots.length, "root")})`;
  } else {
    const cwd = selOrPath ? resolve10(selOrPath) : process.cwd();
    const rootArg = flagStr(flags, "root", "r");
    refs = await listSessions(rootArg ? { configDir: rootArg, cwd } : { cwd });
    scopeLabel = `repo ${basename11(cwd)}`;
  }
  if (!refs.length) fail(`No sessions found for ${scopeLabel}.`);
  const max = Number(flagStr(flags, "limit") ?? (scope === "global" ? "500" : "200"));
  const use = refs.slice(0, Number.isNaN(max) ? refs.length : max);
  const quiet = flagBool(flags, "quiet") || flagBool(flags, "json");
  const t0 = performance.now();
  const sp = spinner(err2);
  progress = sp;
  if (!quiet) sp.start(`analyzing ${plural(use.length, "session")}`);
  const jobsStr = flagStr(flags, "jobs", "j");
  const jobsN = jobsStr !== void 0 ? Math.max(1, Math.floor(Number(jobsStr)) || 1) : defaultJobs();
  const bundledEntry = /\.(m?js)$/.test(new URL(import.meta.url).pathname);
  let analyses = [];
  let failed = 0;
  if (jobsN > 1 && use.length > 1 && bundledEntry) {
    const cacheEnabled = !(flags["no-cache"] !== void 0 || process.env["ORANGU_NO_CACHE"] === "1");
    const r = await analyzeAllPooled(use, { entry: new URL(import.meta.url), jobs: jobsN, version: VERSION2, now: Date.now(), cacheEnabled });
    analyses = r.analyses;
    failed = r.failed;
    sp.stop(quiet ? void 0 : doneLine(err2, { sizeBytes: use.reduce((n2, ref) => n2 + ref.sizeBytes, 0), elapsedMs: performance.now() - t0 }));
    progress = void 0;
    if (!flagBool(flags, "quiet") && flagBool(flags, "verbose")) {
      process.stderr.write(row(err2, "jobs", String(jobsN), { style: "dim" }) + "\n");
      if (cacheEnabled) process.stderr.write(row(err2, "cache", `${r.hits} hits, ${r.misses} misses`, { style: "dim" }) + "\n");
    }
  } else {
    const cache2 = makeCache(flags);
    for (const ref of use) {
      try {
        analyses.push(await analyzeRef(ref, flags, cache2));
      } catch {
        failed++;
      }
    }
    sp.stop(quiet ? void 0 : doneLine(err2, { sizeBytes: use.reduce((n2, ref) => n2 + ref.sizeBytes, 0), elapsedMs: performance.now() - t0 }));
    progress = void 0;
    printCacheStats(cache2, flags);
  }
  const agg = aggregate(analyses, scopeLabel, Date.now());
  if (failed) agg.scope += ` (${failed} unreadable skipped)`;
  const outputAggregate = prepareAggregateForOutput(agg, flags);
  const outFile = flagStr(flags, "o", "out");
  if (outFile) {
    await writePrivateOutput(resolve10(outFile), renderPreparedAggregateJson(outputAggregate, flags, { pretty: true, trailingNewline: false }));
    if (!quiet) process.stderr.write(row(err2, "written", resolve10(outFile)) + "\n");
    if (!flagBool(flags, "json")) {
      if (!flagBool(flags, "quiet")) offerBetaFeedback(scope);
      return;
    }
  }
  if (flagBool(flags, "json")) {
    process.stdout.write(renderPreparedAggregateJson(outputAggregate, flags));
    return;
  }
  printAggregate(outputAggregate);
  if (!flagBool(flags, "quiet")) offerBetaFeedback(scope);
}
function printAggregate(a) {
  process.stdout.write("\n" + paint(out2, ["bold", "accent"], "orangu") + "  " + paint(out2, "bold", a.scope) + "\n");
  process.stdout.write(paint(out2, "dim", `  ${plural(a.sessionCount, "session")}

`));
  const line = (l, v) => process.stdout.write("  " + l.padEnd(20) + v + "\n");
  line("total tokens", fmtTokens(a.totals.tokens));
  line("tool calls", `${a.totals.toolCalls} (${a.totals.toolErrors} errors, ${(a.averages.toolErrorRate * 100).toFixed(1)}%)`);
  line("subagent runs", String(a.totals.agents));
  line("PRs / commits", `${a.totals.prs} / ${a.totals.commits}`);
  line("tokens / session", fmtTokens(a.averages.tokensPerSession));
  line("tokens / human turn", fmtTokens(a.averages.tokensPerHumanTurn));
  line("cache hit ratio", (a.averages.cacheHitRatio * 100).toFixed(1) + "%");
  if (a.byModel.length) {
    process.stdout.write("\n" + paint(out2, "bold", "  tokens by model\n"));
    for (const m of a.byModel.slice(0, 6)) process.stdout.write(`    ${m.key.padEnd(24)} ${fmtTokens(m.tokens).padStart(9)}  ${m.count} session${m.count === 1 ? "" : "s"}
`);
  }
  if (a.crossFindings.length) {
    process.stdout.write("\n" + paint(out2, "bold", "  recurring findings (across sessions)\n"));
    for (const f of a.crossFindings.slice(0, 8)) process.stdout.write(`    ${paint(out2, "accent", (f.boundedSavingsTokens ? "~" + fmtTokens(f.boundedSavingsTokens) : "\u2013").padStart(8))}  ${f.title}  ${paint(out2, "dim", "(" + plural(f.sessions, "session") + ")")}
`);
  }
  if (a.recurringErrors.length) {
    process.stdout.write("\n" + paint(out2, "bold", "  recurring tool errors (environment problems)\n"));
    const hidden = /* @__PURE__ */ new Map();
    for (const e of a.recurringErrors) {
      if (e.signature) continue;
      const h = hidden.get(e.tool) ?? { total: 0, groups: 0, sessions: 0 };
      h.total += e.total;
      h.groups += 1;
      h.sessions = Math.max(h.sessions, e.sessions);
      hidden.set(e.tool, h);
    }
    for (const e of a.recurringErrors.filter((e2) => e2.signature).slice(0, 6)) process.stdout.write(`    ${paint(out2, "bad", String(e.total).padStart(4))}\xD7  ${e.tool}: ${e.signature}  ${paint(out2, "dim", "(" + plural(e.sessions, "session") + ")")}
`);
    for (const [tool, h] of [...hidden].slice(0, 6)) process.stdout.write(`    ${paint(out2, "bad", String(h.total).padStart(4))}\xD7  ${tool}: ${plural(h.groups, "recurring signature")}, text hidden; use --include-text  ${paint(out2, "dim", "(" + plural(h.sessions, "session") + ")")}
`);
  }
  if (a.topReReadFiles.length) {
    process.stdout.write("\n" + paint(out2, "bold", "  most re-read files (context weight)\n"));
    for (const f of a.topReReadFiles.slice(0, 6)) process.stdout.write(`    ${String(f.totalReads).padStart(4)} reads  ${f.path}  ${paint(out2, "dim", "(" + plural(f.sessions, "session") + ")")}
`);
  }
  process.stdout.write("\n" + paint(out2, "bold", "  heaviest sessions (by tokens)\n"));
  for (const s of a.topSessions.slice(0, 8)) process.stdout.write(`    ${fmtTokens(s.tokens).padStart(9)}  ${s.id.slice(0, 8)}  ${paint(out2, "dim", s.title ? s.title.slice(0, 50) : "(title hidden; use --include-text)")}
`);
  process.stdout.write(paint(out2, "dim", `
  add --json for the full machine-readable aggregate
`));
}
async function cmdServe(flags) {
  const portStr = flagStr(flags, "port", "p");
  const port = portStr !== void 0 ? Number(portStr) : void 0;
  if (portStr !== void 0 && (!Number.isInteger(port) || port < 0 || port > 65535)) fail(`--port must be an integer 0\u201365535, got "${portStr}"`);
  const configArg = flagStr(flags, "root", "config", "r");
  const roots = flagBool(flags, "global") ? await claudeRoots(configArg) : void 0;
  const maxLiveStr = flagStr(flags, "max-live");
  const requestedAutomaticLaunch = flagBool(flags, "allow-claude");
  const opts = {
    port,
    // policy: open by default when TTY; --no-open suppresses
    open: !flagBool(flags, "no-open") && (flagBool(flags, "open") || out2.tty),
    // loopback + capability URL: the operator sees their own transcript by default; --no-include-text opts out
    includeText: !flagBool(flags, "no-include-text"),
    // the Export HTML download leaves the machine: redacted like `orangu report` unless --include-text
    exportIncludeText: flagBool(flags, "include-text"),
    configDir: roots ? void 0 : configArg,
    roots,
    cwd: flagStr(flags, "cwd"),
    noCache: flags["no-cache"] !== void 0 || process.env["ORANGU_NO_CACHE"] === "1",
    version: VERSION2,
    maxLive: maxLiveStr !== void 0 ? Math.max(1, Math.floor(Number(maxLiveStr)) || DEFAULT_MAX_LIVE) : void 0
  };
  if (requestedAutomaticLaunch) process.stderr.write("  --allow-claude is retired: the report now provides copy-only Claude/Codex handoffs.\n");
  const srv = await startServe(opts);
  process.stderr.write(
    paint(err2, ["bold", "accent"], "orangu serve") + ` \xB7 ${srv.url}
` + paint(err2, "dim", `  loopback + private capability \xB7 model handoff: copy-only \xB7 watching up to ${opts.maxLive ?? DEFAULT_MAX_LIVE} live sessions \xB7 ctrl-c stops
`)
  );
  if (opts.open) openInBrowser(srv.url);
  process.on("SIGINT", () => {
    void srv.close().then(() => {
      process.stderr.write("\n  stopped.\n");
      process.exit(0);
    });
  });
  await new Promise(() => {
  });
}
function printHelp() {
  process.stdout.write(`${out2.tty ? MASCOT_ASCII + "\n" : ""}
${paint(out2, "bold", "orangu")} v${VERSION2}: observe the run, then improve the next outcome.
Deterministic observability for Claude Code sessions. No network calls.

${paint(out2, "bold", "usage")}
  orangu                       analyze the latest session; print the next step
  orangu report  [<session>]   build a self-contained HTML report and open it
  orangu analyze [<session>]   print the analysis  (--json for the full object)
  orangu list                  list discoverable sessions  (--global: all roots)
  orangu pick                  choose an open session, open its report
                               (--json lists; --plain numbers; --limit <n>)
  orangu repo    [<path>]      aggregate every session for a repo (--json/--out)
  orangu global                aggregate every session everywhere    (--json)
  orangu watch   [<session>]   live-tail a session, refresh the report
  orangu serve                 local live viewer for every session (fleet, SSE)
                               --port <n> \xB7 --open/--no-open \xB7 --max-live <n>
                               --no-include-text \xB7 --global \xB7 --cwd <dir>${EXTRA_HELP.map((l) => "\n" + l).join("")}

${paint(out2, "bold", "session")}   a session id, a unique id prefix, a .jsonl path, "latest" (default),
          or "current" (the session Claude Code is running orangu from)

${paint(out2, "bold", "flags")}
  -s, --session <sel>    the session, as a flag (same forms as the positional)
  -o, --out <file>       write the report/JSON here (default: temp dir)
  --json                 machine-readable output (the stable API)
  --stdout               write the HTML report to stdout
  --open / --no-open     open (or don't) the report in a browser
  --no-redact            keep secrets/paths in the output (default: redacted)
  --slim                 with analyze --json: the slim projection LLMs read
  --include-text         keep prompt/result previews in report, analyze, watch,
                         evidence, repo/global output and serve's exported HTML
  --no-include-text      serve only: hide previews in the loopback viewer too
  --strip-paths          reduce absolute paths to basenames (home is ~ already)
  --global               scan all roots incl. Cowork/Desktop
  --root <dir>           scan only this Claude config dir (comma-separated list)
  --limit <n>            cap sessions scanned (repo/global) or listed
  --no-cache             skip the analysis cache under ~/.orangu/cache
  --verbose              also print the cache diagnostic (stderr)
  --plain                pick only: a numbered list instead of the prompt
  --no-color             plain output (NO_COLOR, FORCE_COLOR, TERM=dumb and CI
                         are honoured; ORANGU_NO_ANIMATION=1 stops the spinner)
  --jobs <n>             worker threads for repo/global scans (default: CPUs-1)
  --max-tokens <n>       exit 1 above this token total (CI: analyze/report)
  --fail-on-hook-errors  exit non-zero if any hook errored (CI; analyze, report)
  --version, --help

${paint(out2, "dim", "privacy: generated locally, zero network requests, secrets redacted by default.")}
`);
}
async function main() {
  const { command, positionals, flags } = parseArgs(process.argv.slice(2));
  if (typeof flags["no-cache"] === "string") {
    positionals.push(flags["no-cache"]);
    flags["no-cache"] = true;
  }
  detectStreams2(flags);
  if (flagBool(flags, "version")) {
    process.stdout.write(VERSION2 + "\n");
    return;
  }
  if (flagBool(flags, "help") || command === "help") {
    printHelp();
    return;
  }
  rejectUnusableFlags(command, flags);
  if (!command) {
    if (flagBool(flags, "json")) printHelp();
    else await cmdBrief(flags);
    return;
  }
  const sel = positionals[0];
  switch (command) {
    case "report":
    case "html":
      return cmdReport(sel, flags);
    case "analyze":
    case "a":
      return cmdAnalyze(sel, flags);
    case "list":
    case "ls":
      return cmdList2(flags);
    case "pick":
      return cmdPick(flags, {
        // Enter runs the same report path a user would type, opened in the browser
        openReport: (id) => cmdReport(id, { ...flags, open: true }),
        stdin: process.stdin,
        stdout: process.stdout,
        stderr: process.stderr,
        env: process.env,
        out: out2,
        err: err2
      });
    case "repo":
      return cmdAggregate("repo", sel, flags);
    case "global":
    case "all":
      return cmdAggregate("global", sel, flags);
    case "watch": {
      const ref = await selectSession(sel, flags);
      return watchSession(ref, flags, { version: VERSION2, openInBrowser, outPath: (id) => outPath(flags, id) });
    }
    case "serve":
      return cmdServe(flags);
    default: {
      const extra = Object.prototype.hasOwnProperty.call(EXTRA_COMMANDS, command) ? EXTRA_COMMANDS[command] : void 0;
      if (extra) return extra(positionals, flags);
      fail(`unknown command "${command}". Run: orangu --help`);
    }
  }
}
if (isPoolWorker()) {
  runPoolWorker();
} else {
  main().catch((e) => fail(e instanceof Error ? process.env["ORANGU_DEBUG"] === "1" ? e.stack ?? e.message : e.message : String(e)));
}
