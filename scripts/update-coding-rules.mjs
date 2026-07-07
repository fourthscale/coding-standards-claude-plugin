#!/usr/bin/env node
/**
 * Resolver for `/update-coding-rules` — composes `.claude/coding-rules.md` from
 * the sources declared in `.claude/coding-rules.config.yml`.
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
 *     conventions: warn-only         #   warn-only → composed but marked non-blocking
 *   projectContext: |                # prepended to the composed file (optional)
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
} from "node:fs";
import { join, dirname, resolve, relative, sep } from "node:path";
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
const DEFAULT_OUTPUT = "./coding-rules.md";
const LOCAL_VERSION = "0.0.0"; // local-path packs have no version of their own

// --- helpers ---------------------------------------------------------------
function sha(s) {
  return createHash("sha256").update(s).digest("hex").slice(0, HASH_LEN);
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
  const p = relPath.split(sep).join("/");
  return patterns.some((pat) => globToRegExp(pat).test(p));
}

function walkMd(root) {
  const out = [];
  if (!existsSync(root)) return out;
  const st = statSync(root);
  if (st.isFile()) return root.endsWith(".md") ? [root] : [];
  const rec = (d) => {
    for (const name of readdirSync(d)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const full = join(d, name);
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
    body: m[2].trim(),
  };
}

// --- source resolution -----------------------------------------------------
function normalizeGitUrl(u) {
  if (/^(https?:|git@|ssh:|git:)/.test(u)) return u;
  // bare "host/owner/repo" → https clone URL
  return "https://" + u.replace(/\.git$/, "") + ".git";
}

function resolveLocal(spec, baseDir) {
  return { root: resolve(baseDir, spec), label: spec, version: LOCAL_VERSION, include: null };
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
  return { root, label: entry.git, version: ref || "HEAD", include: entry.include || null };
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
  return { root, label: entry.npm, version, include: entry.include || null };
}

function resolveSource(entry, baseDir, cacheDir) {
  if (typeof entry === "string") return resolveLocal(entry, baseDir);
  if (entry.local) return resolveLocal(entry.local, baseDir);
  if (entry.git) return resolveGit(entry, cacheDir);
  if (entry.npm) return resolveNpm(entry, cacheDir);
  die(`unknown source entry: ${JSON.stringify(entry)}`);
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
function gatherRules(sources, select) {
  const byId = new Map();
  let scanned = 0;
  for (const src of sources) {
    const files = walkMd(src.root)
      .filter((f) => matchesAny(relative(src.root, f), src.include))
      .sort();
    for (const f of files) {
      const rule = parseRule(f);
      if (!rule) continue;
      scanned++;
      const mode = selectMode(select, rule.category);
      if (mode === "exclude") continue;
      byId.delete(rule.id);
      byId.set(rule.id, {
        ...rule,
        warnOnly: mode === "warn-only",
        pack: src.label,
        version: src.version,
      });
    }
  }
  return { rules: [...byId.values()], scanned };
}

function ruleHeader(r) {
  return `<!-- module: ${r.id} · category: ${r.category} · pack: ${r.pack}@${r.version}${
    r.warnOnly ? " · WARN-ONLY" : ""
  } -->`;
}

function compose(config, rules) {
  const parts = [
    "<!-- GENERATED by the coding-standards plugin — do not edit by hand. -->",
    "<!-- Regenerate with /update-coding-rules. Source of truth: coding-rules.config.yml -->",
    "",
  ];
  if (config.projectContext) {
    parts.push("# Project context", "", String(config.projectContext).trim(), "");
  }
  parts.push("# Coding rules (composed)", "");
  for (const r of rules) {
    parts.push(ruleHeader(r));
    if (r.warnOnly) {
      parts.push("> ⚠️ **WARN-ONLY** — report violations, do not block.", "");
    }
    parts.push(r.body, "");
  }
  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function writeComposite(outputPath, composed) {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, composed);
}

// --- main ------------------------------------------------------------------
function main() {
  const configPath = findConfigPath();
  const baseDir = dirname(configPath);
  const config = loadConfig(configPath);

  const extendsList = Array.isArray(config.extends) ? config.extends : [];
  if (extendsList.length === 0) die("`extends` is empty — nothing to compose.");
  const select = config.select || {};
  const outputPath = resolve(baseDir, config.output || DEFAULT_OUTPUT);
  const cacheDir = join(baseDir, CACHE_DIR_NAME);

  const sources = extendsList.map((e) => resolveSource(e, baseDir, cacheDir));
  const { rules, scanned } = gatherRules(sources, select);
  writeComposite(outputPath, compose(config, rules));

  process.stdout.write(
    `Wrote ${relative(process.cwd(), outputPath)} — ${rules.length} rule file(s) ` +
      `from ${sources.length} source(s) (${scanned} scanned).\n`
  );
}

try {
  main();
} catch (e) {
  die(e.stack || String(e));
}
