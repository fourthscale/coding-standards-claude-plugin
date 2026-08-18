#!/usr/bin/env node
/**
 * Resolver for `/update-coding-rules` — composes `.claude/coding-rules.md` from
 * the sources declared in `.claude/coding-rules.config.yml`.
 *
 * The composed file is an INDEX, not a copy. Claude Code already loads
 * `.claude/rules/**\/*.md` as project instructions, so inlining those bodies into
 * the composed file put the same text in context twice. Instead the composed
 * file lists every selected module — id, title, category, pack, WARN-ONLY — and
 * pulls its text in with an `@` reference. Claude Code dedups imports against the
 * `.claude/rules` auto-scan by absolute path, so each module lands in context
 * exactly once, whichever way it got there.
 *
 * `@` references only work for stable paths inside the project, so rules that
 * live outside it — git/npm packs, which are cached under sha-named, gitignored
 * directories — are MATERIALIZED into `.claude/rule-packs/<pack>/…` first. That
 * directory is generated (and pruned) by this script; it deliberately sits
 * BESIDE `.claude/rules/` rather than inside it, so that `select:` stays the only
 * thing deciding what reaches the context.
 *
 * Unlike the Stop hook (which is deliberately dependency-free, offline and
 * token-free), this is a BUILD-TIME tool: it MAY hit the network (git / npm).
 * Its only library, js-yaml, is VENDORED as a single file in ./vendor/ — so the
 * plugin needs NO `npm install` / `node_modules` and stays install-and-go. The
 * hook never imports any of this; it only reads the composed markdown written here.
 *
 * Config schema (paths are relative to the config file's directory, i.e.
 * `.claude/`):
 *
 *   extends:                         # ordered list of rule-pack sources
 *     - "./rules"                    #   local: a string = a path (dir or .md)
 *     - local: ./more-rules          #   local (explicit form)
 *     - git:  github.com/acme/rules  #   git repo
 *       ref:  v1.2.0                  #     branch / tag / commit (default branch if omitted)
 *       path: rules                   #     sub-dir inside the repo (optional)
 *       include: ["security/*.md"]    #     glob filter, relative to root/path (optional)
 *     - npm:  "@acme/rules"           #   npm package
 *       version: "^1.3.0"             #     semver range (optional)
 *       path: rules                   #     sub-dir inside the package (optional)
 *       include: ["archi/*.md"]       #     glob filter (optional)
 *   select:                          # whitelist by frontmatter `category`
 *     archi: all                     #   all       → enforced normally
 *     conventions: warn-only         #   warn-only → indexed but marked non-blocking
 *   projectContext: |                # prepended to the composed index (optional)
 *     ...
 *   output: "./coding-rules.md"      # where to write (default: ./coding-rules.md)
 *
 * A rule file is a markdown file with YAML frontmatter:
 *   ---
 *   id: project-gotchas       # unique key ("last wins" across sources)
 *   category: gotchas         # matched against `select`
 *   title: L&G critical gotchas
 *   ---
 *   ...body with per-section `- Severity: **major**.` lines...
 */
import {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { join, dirname, resolve, relative, sep, isAbsolute, basename, extname } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
// Vendored single-file js-yaml bundle → no npm install, no node_modules.
import * as yaml from "./vendor/js-yaml.mjs";

function die(msg) {
  process.stderr.write(`update-coding-rules: ${msg}\n`);
  process.exit(1);
}

// --- constants -------------------------------------------------------------
const HASH_LEN = 16; // cache-key length taken from a sha256 hex digest
const MAX_BUFFER = 64 * 1024 * 1024; // 64 MB — tolerate large diffs / file trees
const CACHE_DIR_NAME = ".coding-rules-cache";
const PACKS_DIR_NAME = "rule-packs"; // materialized copies of out-of-project packs
const PACKS_STAMP = ".generated-by-coding-standards"; // marks the dir as ours to prune
const DEFAULT_OUTPUT = "./coding-rules.md";
const LOCAL_VERSION = "0.0.0"; // local-path packs have no version of their own
const SLUG_MAX = 60; // keep generated directory names readable

// Claude Code loads every `.md` under this directory as project instructions,
// recursively, whatever `select:` says. Rules living here are referenced in
// place; excluded ones can't be kept out of the context (we warn instead).
const AUTOLOADED_DIR = join(".claude", "rules");

// --- helpers ---------------------------------------------------------------
function sha(s) {
  return createHash("sha256").update(s).digest("hex").slice(0, HASH_LEN);
}

function toPosix(p) {
  return p.split(sep).join("/");
}

function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

// Run an external command with an explicit argument array (no shell) — avoids
// any quoting/escaping of interpolated refs, URLs, or package specs.
function run(cmd, args, cwd) {
  return execFileSync(cmd, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
  });
}

function errText(e) {
  return String((e && (e.stderr || e.message)) || e).trim();
}

// Minimal glob → RegExp (supports **, *, ?), matched against POSIX-style paths.
function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp("^" + re + "$");
}

function matchesAny(relPath, patterns) {
  if (!patterns || patterns.length === 0) return true;
  const p = toPosix(relPath);
  return patterns.some((pat) => globToRegExp(pat).test(p));
}

// Collect .md files under `root`. `skip` holds absolute paths this walk must not
// descend into — the generated packs dir and the composed index itself, so a
// source pointed at `.claude/` can't re-ingest our own output.
function walkMd(root, skip = new Set()) {
  const out = [];
  if (!existsSync(root) || skip.has(resolve(root))) return out;
  const st = statSync(root);
  if (st.isFile()) return root.endsWith(".md") ? [root] : [];
  const rec = (d) => {
    for (const name of readdirSync(d)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const full = join(d, name);
      if (skip.has(resolve(full))) continue;
      const s = statSync(full);
      if (s.isDirectory()) rec(full);
      else if (name.endsWith(".md")) out.push(full);
    }
  };
  rec(root);
  return out;
}

function parseRule(file) {
  const raw = readFileSync(file, "utf8");
  const m = raw.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null; // no frontmatter → not a rule file
  let fm;
  try {
    fm = yaml.load(m[1]) || {};
  } catch {
    return null;
  }
  if (!fm.id || !fm.category) return null;
  return {
    id: String(fm.id),
    category: String(fm.category),
    title: fm.title ? String(fm.title) : "",
    frontmatter: m[1], // kept verbatim so a materialized copy stays a valid module
    body: m[2].trim(),
  };
}

// --- source resolution -----------------------------------------------------
function normalizeGitUrl(u) {
  if (/^(https?:|git@|ssh:|git:)/.test(u)) return u;
  // bare "host/owner/repo" → https clone URL
  return "https://" + u.replace(/\.git$/, "") + ".git";
}

// Filesystem-safe, human-readable directory name for a pack.
function slugify(label) {
  const s = String(label)
    .replace(/^[a-z+]+:\/\//i, "")
    .replace(/\.git$/, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .toLowerCase();
  return (s || "pack").slice(0, SLUG_MAX);
}

function resolveLocal(spec, baseDir) {
  return {
    root: resolve(baseDir, spec),
    label: spec,
    version: LOCAL_VERSION,
    include: null,
    external: false,
  };
}

function resolveGit(entry, cacheDir) {
  const url = normalizeGitUrl(entry.git);
  const ref = entry.ref || "";
  const dest = join(cacheDir, "git", sha(url + "#" + ref));
  if (!existsSync(dest)) {
    mkdirSync(dirname(dest), { recursive: true });
    try {
      run("git", ["clone", "--filter=blob:none", "--quiet", url, dest]);
      if (ref) run("git", ["checkout", "--quiet", ref], dest);
    } catch (e) {
      die(`git source ${entry.git}${ref ? "@" + ref : ""} failed: ${errText(e)}`);
    }
  }
  const root = entry.path ? join(dest, entry.path) : dest;
  return {
    root,
    label: entry.git,
    version: ref || "HEAD",
    include: entry.include || null,
    external: true,
  };
}

function resolveNpm(entry, cacheDir) {
  const spec = entry.version ? `${entry.npm}@${entry.version}` : entry.npm;
  const dest = join(cacheDir, "npm", sha(spec));
  const pkgDir = join(dest, "package");
  if (!existsSync(pkgDir)) {
    mkdirSync(dest, { recursive: true });
    try {
      const out = run("npm", ["pack", spec, "--pack-destination", dest, "--json"], dest);
      const info = JSON.parse(out);
      const tgz = join(dest, info[0].filename);
      run("tar", ["-xzf", tgz, "-C", dest]);
    } catch (e) {
      die(`npm source ${spec} failed: ${errText(e)}`);
    }
  }
  let version = entry.version || "";
  try {
    version = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).version;
  } catch {}
  const root = entry.path ? join(pkgDir, entry.path) : pkgDir;
  return {
    root,
    label: entry.npm,
    version,
    include: entry.include || null,
    external: true,
  };
}

function resolveSource(entry, baseDir, cacheDir) {
  const src =
    typeof entry === "string"
      ? resolveLocal(entry, baseDir)
      : entry.local
        ? resolveLocal(entry.local, baseDir)
        : entry.git
          ? resolveGit(entry, cacheDir)
          : entry.npm
            ? resolveNpm(entry, cacheDir)
            : die(`unknown source entry: ${JSON.stringify(entry)}`);
  src.slug = slugify(src.label);
  return src;
}

// --- select semantics ------------------------------------------------------
const OFF = new Set(["off", "false", "none", "skip", "no"]);
function selectMode(select, category) {
  if (!(category in select)) return "exclude";
  const v = String(select[category]).toLowerCase();
  if (OFF.has(v)) return "exclude";
  if (v === "warn-only" || v === "warn") return "warn-only";
  return "enforce"; // "all", true, etc.
}

// --- compose ---------------------------------------------------------------
function findConfigPath() {
  const p = [
    resolve(process.cwd(), "coding-rules.config.yml"),
    resolve(process.cwd(), ".claude", "coding-rules.config.yml"),
  ].find(existsSync);
  if (!p) die("no coding-rules.config.yml found (looked in ./ and ./.claude/).");
  return p;
}

function loadConfig(configPath) {
  try {
    return yaml.load(readFileSync(configPath, "utf8")) || {};
  } catch (e) {
    die(`invalid YAML in ${relative(process.cwd(), configPath)}: ${e.message}`);
  }
}

// Walk every source, keep rules whose category is selected, and dedup by `id`
// (last source wins; the winner is emitted at its LAST position → stable order).
// Excluded rules that sit under `.claude/rules/` are reported back: Claude Code
// auto-loads that directory, so `select:` cannot actually keep them out.
function gatherRules(sources, select, projectRoot, skip) {
  const byId = new Map();
  const excludedButAutoloaded = [];
  const autoloadedDir = resolve(projectRoot, AUTOLOADED_DIR);
  let scanned = 0;
  for (const src of sources) {
    const files = walkMd(src.root, skip)
      .filter((f) => matchesAny(relative(src.root, f), src.include))
      .sort();
    for (const f of files) {
      const rule = parseRule(f);
      if (!rule) continue;
      scanned++;
      const mode = selectMode(select, rule.category);
      if (mode === "exclude") {
        if (isInside(autoloadedDir, f)) {
          excludedButAutoloaded.push({ file: f, category: rule.category });
        }
        continue;
      }
      byId.delete(rule.id);
      byId.set(rule.id, {
        ...rule,
        warnOnly: mode === "warn-only",
        pack: src.label,
        version: src.version,
        file: f,
        // Path inside the source, reused as the path inside the packs directory.
        relPath: relative(src.root, f) || basename(f),
        slug: src.slug,
        external: src.external,
      });
    }
  }
  return { rules: [...byId.values()], scanned, excludedButAutoloaded };
}

// --- materialization -------------------------------------------------------
// A rule can be referenced with `@` only if it lives at a stable path inside the
// project: Claude Code drops project-scope imports that resolve outside the
// working directory, and the git/npm cache uses sha-named, gitignored paths.
// Everything else is copied into `.claude/rule-packs/` first.
function needsMaterializing(rule, projectRoot) {
  return rule.external || !isInside(projectRoot, rule.file);
}

function listFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  const rec = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) rec(full);
      else out.push(full);
    }
  };
  rec(dir);
  return out;
}

function removeEmptyDirs(dir, root) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) removeEmptyDirs(join(dir, e.name), root);
  }
  if (dir !== root && readdirSync(dir).length === 0) rmSync(dir, { recursive: true });
}

// Keep interpolated labels from closing the comment they sit in.
function safeComment(s) {
  return String(s || "").replace(/-{2,}/g, "-").replace(/[\r\n]+/g, " ");
}

function materializedContent(rule) {
  const from = `${safeComment(rule.pack)}@${safeComment(rule.version)}`;
  return [
    `---\n${rule.frontmatter}\n---`,
    "",
    `<!-- Materialized by the coding-standards plugin from ${from}` +
      ` (${safeComment(toPosix(rule.relPath))}). Do not edit — regenerate with /update-coding-rules. -->`,
    "",
    rule.body,
    "",
  ].join("\n");
}

// Copy every out-of-project rule into the packs directory, repoint it there, and
// delete anything left over from a previous run. Refuses to touch a directory it
// didn't generate.
function materialize(rules, packsDir) {
  const toCopy = rules.filter((r) => r.materialize);
  const stamp = join(packsDir, PACKS_STAMP);
  const existed = existsSync(packsDir);
  if (existed && !existsSync(stamp)) {
    die(
      `${relative(process.cwd(), packsDir)} exists but was not generated by this tool ` +
        `(no ${PACKS_STAMP} marker) — move it aside and re-run.`
    );
  }
  if (toCopy.length === 0) {
    const pruned = existed ? listFiles(packsDir).filter((f) => resolve(f) !== resolve(stamp)).length : 0;
    if (existed) rmSync(packsDir, { recursive: true, force: true });
    return { written: 0, pruned };
  }

  const keep = new Set([resolve(stamp)]);
  for (const rule of toCopy) {
    let target = join(packsDir, rule.slug, rule.relPath);
    // Two sources sharing a slug can land on the same path; keep both.
    const ext = extname(rule.relPath);
    const stem = rule.relPath.slice(0, rule.relPath.length - ext.length);
    for (let n = 2; keep.has(resolve(target)); n++) {
      target = join(packsDir, rule.slug, `${stem}-${n}${ext}`);
    }
    keep.add(resolve(target));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, materializedContent(rule));
    rule.file = target; // the index references the copy, not the cache
  }

  writeFileSync(
    stamp,
    "Generated by the coding-standards plugin (/update-coding-rules).\n" +
      "Materialized copies of the git/npm rule packs declared in coding-rules.config.yml,\n" +
      "kept here so .claude/coding-rules.md can reference them at a stable path.\n" +
      "Edits are overwritten on the next run — change the pack at its source instead.\n"
  );

  let pruned = 0;
  for (const f of listFiles(packsDir)) {
    if (keep.has(resolve(f))) continue;
    rmSync(f);
    pruned++;
  }
  removeEmptyDirs(packsDir, packsDir);
  return { written: toCopy.length, pruned };
}

// --- index -----------------------------------------------------------------
// `@` is only an import when preceded by whitespace, so neutralize any stray one
// coming from a title or a pack label — otherwise it would resolve as a path.
function safeText(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .replace(/(^|\s)@/g, "$1(at) ")
    .trim();
}

function importPath(fromDir, file) {
  const rel = toPosix(relative(fromDir, file));
  return rel.startsWith("../") ? rel : "./" + rel;
}

function indexLine(rule, outDir) {
  // A local path has no version of its own — printing "@0.0.0" would be noise.
  const pack =
    rule.version === LOCAL_VERSION
      ? safeText(rule.pack)
      : `${safeText(rule.pack)}@${safeText(rule.version)}`;
  const bits = [
    `\`${safeText(rule.id)}\``,
    `category \`${safeText(rule.category)}\``,
    `pack \`${pack}\``,
  ];
  if (rule.warnOnly) bits.push("**WARN-ONLY**");
  const title = safeText(rule.title);
  const head = title ? `**${title}** — ` : "";
  // The reference must end the line: an `@` path runs until the next whitespace,
  // so trailing punctuation would become part of the filename.
  return `- ${head}${bits.join(" · ")} → @${importPath(outDir, rule.file)}`;
}

function compose(config, rules, outDir) {
  const parts = [
    "<!-- GENERATED by the coding-standards plugin — do not edit by hand. -->",
    "<!-- Regenerate with /update-coding-rules. Source of truth: coding-rules.config.yml -->",
    "",
  ];
  if (config.projectContext) {
    parts.push("# Project context", "", String(config.projectContext).trim(), "");
  }
  parts.push(
    "# Coding rules (index)",
    "",
    "Every rule module in force for this project, in resolution order — a later",
    "entry overrides an earlier one carrying the same id. Each `@` reference pulls",
    "that module's full text into context; the text is **not** copied here, so read",
    "the module file itself when you need the detail.",
    "",
    "Severity is declared per section inside a module",
    "(`- Severity: **critical|major|minor|info**.`). Fix **major** and **critical**",
    "violations; report **minor** and **info** ones. Modules tagged **WARN-ONLY**",
    "below never block — report their violations and move on.",
    ""
  );
  if (rules.length === 0) {
    parts.push("_No module selected — check `extends` and `select` in coding-rules.config.yml._", "");
  }
  for (const r of rules) parts.push(indexLine(r, outDir));
  parts.push("");
  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function writeIndex(outputPath, index) {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, index);
}

// --- main ------------------------------------------------------------------
function main() {
  const configPath = findConfigPath();
  const baseDir = dirname(configPath);
  const projectRoot = process.cwd();
  const config = loadConfig(configPath);

  const extendsList = Array.isArray(config.extends) ? config.extends : [];
  if (extendsList.length === 0) die("`extends` is empty — nothing to compose.");
  const select = config.select || {};
  const outputPath = resolve(baseDir, config.output || DEFAULT_OUTPUT);
  const cacheDir = join(baseDir, CACHE_DIR_NAME);
  const packsDir = join(baseDir, PACKS_DIR_NAME);
  // Never let a source scan swallow this script's own output.
  const skip = new Set([resolve(packsDir), resolve(outputPath)]);

  const sources = extendsList.map((e) => resolveSource(e, baseDir, cacheDir));
  const { rules, scanned, excludedButAutoloaded } = gatherRules(sources, select, projectRoot, skip);
  for (const rule of rules) rule.materialize = needsMaterializing(rule, projectRoot);

  const { written, pruned } = materialize(rules, packsDir);
  writeIndex(outputPath, compose(config, rules, dirname(outputPath)));

  const rel = (p) => relative(process.cwd(), p);
  process.stdout.write(
    `Wrote ${rel(outputPath)} — ${rules.length} module(s) indexed ` +
      `from ${sources.length} source(s) (${scanned} scanned).\n`
  );
  if (written || pruned) {
    process.stdout.write(
      `Packs in ${rel(packsDir)}: ${written} materialized, ${pruned} stale file(s) removed.\n`
    );
  }
  for (const { file, category } of excludedButAutoloaded) {
    process.stderr.write(
      `warning: ${rel(file)} (category "${category}") is not selected, but Claude Code ` +
        `auto-loads everything under ${AUTOLOADED_DIR}/ — move it outside that directory ` +
        `to actually keep it out of the context.\n`
    );
  }
}

try {
  main();
} catch (e) {
  die(e.stack || String(e));
}
