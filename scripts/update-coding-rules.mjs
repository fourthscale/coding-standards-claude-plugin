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
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
// Vendored single-file js-yaml bundle → no npm install, no node_modules.
import * as yaml from "./vendor/js-yaml.mjs";

function die(msg) {
  process.stderr.write(`update-coding-rules: ${msg}\n`);
  process.exit(1);
}

// --- helpers ---------------------------------------------------------------
function sha(s) {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

function q(s) {
  // POSIX single-quote escaping for execSync string commands.
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

function run(cmd, cwd) {
  return execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
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
  return { root: resolve(baseDir, spec), label: spec, version: "0.0.0", include: null };
}

function resolveGit(entry, cacheDir) {
  const url = normalizeGitUrl(entry.git);
  const ref = entry.ref || "";
  const dest = join(cacheDir, "git", sha(url + "#" + ref));
  if (!existsSync(dest)) {
    mkdirSync(dirname(dest), { recursive: true });
    try {
      run(`git clone --filter=blob:none --quiet ${q(url)} ${q(dest)}`);
      if (ref) run(`git checkout --quiet ${q(ref)}`, dest);
    } catch (e) {
      die(`git source ${entry.git}${ref ? "@" + ref : ""} failed: ${String(e.stderr || e.message).trim()}`);
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
      const out = run(`npm pack ${q(spec)} --pack-destination ${q(dest)} --json`, dest);
      const info = JSON.parse(out);
      const tgz = join(dest, info[0].filename);
      run(`tar -xzf ${q(tgz)} -C ${q(dest)}`);
    } catch (e) {
      die(`npm source ${spec} failed: ${String(e.stderr || e.message).trim()}`);
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

// --- main ------------------------------------------------------------------
async function main() {
  const configPath = [
    resolve(process.cwd(), "coding-rules.config.yml"),
    resolve(process.cwd(), ".claude", "coding-rules.config.yml"),
  ].find(existsSync);
  if (!configPath) {
    die("no coding-rules.config.yml found (looked in ./ and ./.claude/).");
  }

  const baseDir = dirname(configPath);
  let config;
  try {
    config = yaml.load(readFileSync(configPath, "utf8")) || {};
  } catch (e) {
    die(`invalid YAML in ${relative(process.cwd(), configPath)}: ${e.message}`);
  }

  const extendsList = Array.isArray(config.extends) ? config.extends : [];
  if (extendsList.length === 0) die("`extends` is empty — nothing to compose.");
  const select = config.select || {};
  const outputPath = resolve(baseDir, config.output || "./coding-rules.md");
  const cacheDir = join(baseDir, ".coding-rules-cache");

  const sources = extendsList.map((e) => resolveSource(e, baseDir, cacheDir));

  // Gather rules, filter by `select`, dedup by `id` (last source wins, and the
  // winning entry is emitted at its LAST position for a stable order).
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

  // Compose.
  const parts = [
    "<!-- GENERATED by the coding-standards plugin — do not edit by hand. -->",
    "<!-- Regenerate with /update-coding-rules. Source of truth: coding-rules.config.yml -->",
    "",
  ];
  if (config.projectContext) {
    parts.push("# Project context", "", String(config.projectContext).trim(), "");
  }
  parts.push("# Coding rules (composed)", "");
  for (const r of byId.values()) {
    parts.push(
      `<!-- module: ${r.id} · category: ${r.category} · pack: ${r.pack}@${r.version}${
        r.warnOnly ? " · WARN-ONLY" : ""
      } -->`
    );
    if (r.warnOnly) {
      parts.push("> ⚠️ **WARN-ONLY** — report violations, do not block.", "");
    }
    parts.push(r.body, "");
  }

  const composed = parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, composed);

  process.stdout.write(
    `Wrote ${relative(process.cwd(), outputPath)} — ${byId.size} rule file(s) ` +
      `from ${sources.length} source(s) (${scanned} scanned).\n`
  );
}

main().catch((e) => die(e.stack || String(e)));
