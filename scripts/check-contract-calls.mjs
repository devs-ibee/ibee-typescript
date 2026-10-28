#!/usr/bin/env node
// Check B: the hand-written code calls nothing outside contract/ibee-cloud.yaml.
//
// The hand-written files are the .ts files listed in src/.fernignore; the generated
// code is covered by check A (scripts/check-generated.sh). This fails on
// - a generated resource-client method that is not a contract operation (operationId),
//   when the hand layer calls or overrides it: `super.x`, `this.x` and a method `x` in
//   a class that extends a generated client, and `new SomeClient(...).x`;
// - a string that names an API path (it starts with a top-level contract segment such
//   as `compute/`) and matches no contract path;
// - a route pattern in src/wrapper/Ibee.ts that drifted from the contract: KEYED_ROUTE
//   (writes) must match exactly the operations that declare X-Idempotency-Key,
//   UPGRADE_ROUTE (POST) exactly those that declare Idempotency-Key, CREATE_ROUTE (POST)
//   exactly VM create, NEVER_RETRY_ROUTE (GET) exactly getSecretIdentityAccess.
//
// Needs only the `typescript` dev dependency: node scripts/check-contract-calls.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "src");

const contract = fs.readFileSync(path.join(root, "contract/ibee-cloud.yaml"), "utf8");
const paths = contract.split("\npaths:\n")[1].split("\ncomponents:\n")[0];
const templates = [...paths.matchAll(/^ {2}(\/\S*):\s*$/gm)].map((m) => m[1].replace(/^\/|\/$/g, "").split("/"));
const operations = new Set([...paths.matchAll(/^\s+operationId:\s*(\S+)\s*$/gm)].map((m) => m[1]));
const topSegments = new Set(templates.map((t) => t[0]));

const matches = (segments, template) =>
    segments.length === template.length &&
    segments.every((s, i) => s === "{}" || template[i].startsWith("{") || s === template[i]);

/** The path segments when `value` names an API path, else undefined. */
function apiPath(value) {
    if (/\s/.test(value) || !value.includes("/")) return undefined;
    const segments = value
        .replace(/^https?:\/\/[^/]+/, "")
        .replace(/^\/?(v1\/)?/, "")
        .replace(/\/$/, "")
        .split("/");
    return topSegments.has(segments[0]) ? segments : undefined;
}

/** `(x as T)`, `x!` and `(x)` -> `x`. */
function unwrap(node) {
    while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) {
        node = node.expression;
    }
    return node;
}

function handFiles() {
    const files = [];
    for (const raw of fs.readFileSync(path.join(src, ".fernignore"), "utf8").split("\n")) {
        const entry = raw.trim();
        if (!entry || entry.startsWith("#")) continue;
        const full = path.join(src, entry);
        if (!fs.existsSync(full)) continue;
        if (fs.statSync(full).isDirectory()) {
            for (const name of fs.readdirSync(full, { recursive: true })) {
                if (String(name).endsWith(".ts")) files.push(path.join(full, String(name)));
            }
        } else if (entry.endsWith(".ts")) {
            files.push(full);
        }
    }
    return files;
}

function check(file) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const rel = path.relative(root, file);
    const problems = [];
    const line = (node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    const flag = (node, name, why = "is not a contract operation") => {
        if (!name.startsWith("_") && !operations.has(name)) problems.push(`${rel}:${line(node)}: ${name} ${why}`);
    };

    // Generated resource clients imported here (from .../api/resources/<resource>/client/Client.js).
    const generated = new Set();
    for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement) || !/\/api\/resources\//.test(statement.moduleSpecifier.text)) continue;
        for (const element of statement.importClause?.namedBindings?.elements ?? []) {
            if (element.name.text.endsWith("Client")) generated.add(element.name.text);
        }
    }

    const visit = (node, cls) => {
        if (ts.isClassDeclaration(node)) {
            const base = node.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
            const extendsGenerated = base && ts.isIdentifier(base.expression) && generated.has(base.expression.text);
            cls = extendsGenerated ? node : undefined;
            if (cls) {
                for (const member of node.members) {
                    if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
                        flag(member, member.name.text, "overrides no contract operation");
                    }
                }
            }
        }
        if (ts.isPropertyAccessExpression(node)) {
            const target = unwrap(node.expression);
            const name = node.name.text;
            if (cls && target.kind === ts.SyntaxKind.SuperKeyword) flag(node, name);
            if (cls && target.kind === ts.SyntaxKind.ThisKeyword) {
                const own = cls.members.some((m) => m.name && ts.isIdentifier(m.name) && m.name.text === name);
                if (!own) flag(node, name);
            }
            if (ts.isNewExpression(target) && ts.isIdentifier(target.expression) && generated.has(target.expression.text)) {
                flag(node, name);
            }
        }
        let value;
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) value = node.text;
        if (ts.isTemplateExpression(node)) {
            value = node.head.text + node.templateSpans.map((span) => "{}" + span.literal.text).join("");
        }
        const segments = value === undefined ? undefined : apiPath(value);
        if (segments && !templates.some((t) => matches(segments, t))) {
            problems.push(`${rel}:${line(node)}: '${value}' is not a contract path`);
        }
        ts.forEachChild(node, (child) => visit(child, cls));
    };
    visit(source, undefined);
    return problems;
}

/** Every contract operation with its method, path and the component parameters it uses. */
function contractOperations() {
    const ops = [];
    const pathParams = new Map();
    let currentPath;
    let section;
    for (const line of paths.split("\n")) {
        let m = line.match(/^ {2}(\/\S*):\s*$/);
        if (m) {
            currentPath = m[1];
            pathParams.set(currentPath, new Set());
            section = undefined;
            continue;
        }
        m = line.match(/^ {4}(get|put|post|patch|delete|head|options):/);
        if (m) {
            section = { path: currentPath, method: m[1].toUpperCase(), id: undefined, params: new Set() };
            ops.push(section);
            continue;
        }
        if (/^ {4}parameters:/.test(line)) {
            section = { params: pathParams.get(currentPath) };
            continue;
        }
        if (/^ {4}\S/.test(line)) section = undefined;
        if (!section) continue;
        m = line.match(/^\s+operationId:\s*(\S+)\s*$/);
        if (m && section.method) section.id = m[1];
        m = line.match(/#\/components\/parameters\/(\w+)/);
        if (m) section.params.add(m[1]);
    }
    for (const op of ops) for (const name of pathParams.get(op.path)) op.params.add(name);
    return ops;
}

/** The regular-expression constants `names` declared in `file`. */
function routePatterns(file, names) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const found = {};
    const visit = (node) => {
        if (
            ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            names.includes(node.name.text) &&
            node.initializer?.kind === ts.SyntaxKind.RegularExpressionLiteral
        ) {
            const text = node.initializer.text;
            const end = text.lastIndexOf("/");
            found[node.name.text] = new RegExp(text.slice(1, end), text.slice(end + 1));
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
}

/** Problems when a route pattern of src/wrapper/Ibee.ts and the contract disagree. */
function checkRoutes() {
    const file = path.join(src, "wrapper/Ibee.ts");
    const rel = path.relative(root, file);
    const rules = {
        KEYED_ROUTE: [(op) => op.method !== "GET", (op) => op.params.has("IdempotencyKey")],
        UPGRADE_ROUTE: [(op) => op.method === "POST", (op) => op.params.has("ContainerRegistryIdempotencyKey")],
        CREATE_ROUTE: [(op) => op.method === "POST", (op) => ["createCloudVm", "createGpuVm"].includes(op.id)],
        NEVER_RETRY_ROUTE: [(op) => op.method === "GET", (op) => op.id === "getSecretIdentityAccess"],
    };
    const patterns = routePatterns(file, Object.keys(rules));
    const problems = [];
    for (const [name, [applies, expected]] of Object.entries(rules)) {
        const pattern = patterns[name];
        if (!pattern) {
            problems.push(`${rel}: ${name} is not declared as a regular expression`);
            continue;
        }
        let matched = 0;
        for (const op of contractOperations()) {
            const url = "/v1" + op.path.replace(/\{[^}]+\}/g, "x1");
            const hit = applies(op) && pattern.test(url);
            if (hit) matched += 1;
            if (hit !== expected(op)) {
                problems.push(`${rel}: ${name} ${hit ? "matches" : "misses"} ${op.method} ${op.path} (${op.id})`);
            }
        }
        if (matched === 0) problems.push(`${rel}: ${name} matches no contract operation`);
    }
    return problems;
}

const problems = [...new Set([...handFiles().flatMap(check), ...checkRoutes()])].sort();
for (const problem of problems) console.error(problem);
if (problems.length) {
    console.error("Hand-written code calls outside contract/ibee-cloud.yaml.");
    process.exit(1);
}
console.log(
    `Hand-written code calls only contract operations and paths (${operations.size} operations, ${templates.length} paths); ` +
        `its idempotency and retry routes match the contract.`,
);
