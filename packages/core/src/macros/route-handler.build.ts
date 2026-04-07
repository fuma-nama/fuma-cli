import path from "node:path";
import MagicString from "magic-string";
import { Visitor } from "oxc-parser";
import type {
  Argument,
  CallExpression,
  Expression,
  ImportDeclaration,
  ObjectExpression,
  ParamPattern,
  Program,
  Statement,
} from "@oxc-project/types";
import type { Framework } from "@/constants";
import type { RouteHandlerHttpMethod, StaticInfo } from "./route-handler";
import { dedent, indent } from "@/utils/format";
import { collectMacroBindings } from "@/utils/ast";

const reactRouterLoaderMethods = new Set(["GET", "HEAD", "OPTIONS"]);
const reactRouterActionMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export type ParsedRouteInfo = StaticInfo<string, string | undefined>;

function collectRouteHandlerCalls(program: Program, locals: Set<string>): CallExpression[] {
  const calls: CallExpression[] = [];
  new Visitor({
    CallExpression(node: CallExpression) {
      if (node.callee.type !== "Identifier") return;
      if (!locals.has(node.callee.name)) return;
      calls.push(node);
    },
  }).visit(program);
  return calls;
}

function isSameCall(init: Expression | null | undefined, call: CallExpression): boolean {
  if (!init || init.type !== "CallExpression") return false;
  return init.start === call.start && init.end === call.end;
}

function findStatementSpanForCall(
  program: Program,
  call: CallExpression,
): { start: number; end: number } | null {
  for (const stmt of program.body) {
    const span = statementSpanIfContainsCall(stmt, call);
    if (span) return span;
  }
  return null;
}

function statementSpanIfContainsCall(
  stmt: Statement,
  call: CallExpression,
): { start: number; end: number } | null {
  if (stmt.type === "ExportNamedDeclaration" && stmt.declaration?.type === "VariableDeclaration") {
    for (const d of stmt.declaration.declarations) {
      if (isSameCall(d.init, call)) return { start: stmt.start, end: stmt.end };
    }
  }
  if (stmt.type === "VariableDeclaration") {
    for (const d of stmt.declarations) {
      if (isSameCall(d.init, call)) return { start: stmt.start, end: stmt.end };
    }
  }
  return null;
}

function objectPropertyKeyName(key: ObjectExpression["properties"][number]): string | null {
  if (key.type !== "Property") return null;
  const k = key.key;
  if (k.type === "Identifier") return k.name;
  if (k.type === "Literal" && typeof k.value === "string") return k.value;
  return null;
}

/**
 * Read `methods`, `params`, and optional `catchAll` from the `$routeHandler` info object literal (AST).
 */
function parseRouteInfoFromAst(info: ObjectExpression): ParsedRouteInfo {
  let methods: string[] | undefined;
  let params: string[] | undefined;
  let catchAll: string | undefined;

  for (const prop of info.properties) {
    if (prop.type !== "Property") continue;
    const name = objectPropertyKeyName(prop);
    if (name === "methods") {
      if (prop.value.type !== "ArrayExpression") {
        throw new Error(
          "route-handler.build: `methods` in $routeHandler info must be an array literal",
        );
      }
      const out: string[] = [];
      for (const el of prop.value.elements) {
        if (el == null) continue;
        if (el.type === "Literal" && typeof el.value === "string") {
          out.push(el.value);
          continue;
        }
        throw new Error(
          'route-handler.build: `methods` must be string literals (e.g. methods: ["GET", "POST"])',
        );
      }
      methods = out;
    }
    if (name === "params") {
      if (prop.value.type !== "ArrayExpression") {
        throw new Error("route-handler.build: `params` must be an array literal");
      }
      const out: string[] = [];
      for (const el of prop.value.elements) {
        if (el == null) continue;
        if (el.type === "Literal" && typeof el.value === "string") {
          out.push(el.value);
          continue;
        }
        throw new Error("route-handler.build: `params` must be string literals");
      }
      params = out;
    }
    if (name === "catchAll") {
      if (prop.value.type === "Literal" && typeof prop.value.value === "string") {
        catchAll = prop.value.value;
        continue;
      }
      throw new Error("route-handler.build: `catchAll` must be a string literal");
    }
  }

  if (!methods?.length) {
    throw new Error(
      "route-handler.build: $routeHandler info must include a non-empty `methods` array",
    );
  }
  if (!params) {
    throw new Error(
      "route-handler.build: $routeHandler info must include a `params` array literal",
    );
  }

  return { methods: methods as RouteHandlerHttpMethod[], params, catchAll };
}

function needsRouteParams(info: ParsedRouteInfo): boolean {
  return info.params.length > 0 || Boolean(info.catchAll);
}

function encodeKey(key: string): string {
  if (key.includes("-")) {
    return JSON.stringify(key);
  }
  return key;
}

function bindingNameFromParam(p: ParamPattern): string | null {
  if (p.type === "Identifier") return p.name;
  return null;
}

interface HandlerInfo {
  requestName: string;
  paramsName: string | null;
  bodyText: string;
}

function parseHandlerFromAst(s: MagicString, expr: Argument): HandlerInfo {
  const isFn = expr.type === "FunctionExpression";
  const isArrow = expr.type === "ArrowFunctionExpression";
  if (!isFn && !isArrow) {
    throw new Error(
      "route-handler.build: second argument to $routeHandler must be a function or async arrow function",
    );
  }
  const fn = expr;
  if (!fn.async) {
    throw new Error("route-handler.build: route handler must be async");
  }
  if (isFn && (!fn.body || fn.body.type !== "BlockStatement")) {
    throw new Error("route-handler.build: function handler must use a block body");
  }

  const p0 = fn.params[0];
  const p1 = fn.params[1];
  if (fn.params.length > 2) {
    throw new Error("route-handler.build: route handler must have at most two parameters");
  }

  const requestName = (p0 && bindingNameFromParam(p0)) || "request";
  const paramsName = p1 ? bindingNameFromParam(p1) : null;
  if (p1 && !paramsName) {
    throw new Error(
      "route-handler.build: unsupported parameter pattern; use a simple identifier for (request, params)",
    );
  }

  const body = fn.body;
  let bodyText: string;

  if (body == null) {
    throw new Error("route-handler.build: handler has no body");
  } else if (body.type === "BlockStatement") {
    bodyText = s.original
      .slice(body.start + 1, body.end - 1)
      .replace(/^\s*?\n/, "")
      .replace(/\n\s*?$/, "");
  } else if (fn.type === "ArrowFunctionExpression") {
    const expr = s.original.slice(body.start, body.end);
    bodyText = `return ${expr};`;
  } else {
    throw new Error("route-handler.build: could not extract handler body");
  }

  return { requestName, paramsName, bodyText };
}

function generateRequestDeclaration(framework: Framework, binding: string): string {
  switch (framework) {
    case "tanstack-start":
      return `const ${binding} = ctx.request;\n`;
    case "react-router":
      return `const ${binding} = args.request;\n`;
    default:
      return "";
  }
}

function generateParamsDeclaration(
  framework: Framework,
  info: ParsedRouteInfo,
  paramsBinding: string,
): string {
  let paramsIdentifier: string;
  let paramsCatchAllIdentifier: string;
  switch (framework) {
    // no renames
    case "next":
      return `const ${paramsBinding} = await ctx.params;\n`;
    case "waku":
      return `const ${paramsBinding} = context.params;\n`;
    case "react-router":
      paramsIdentifier = "args.params";
      paramsCatchAllIdentifier = "args.params['*']";
      break;
    case "tanstack-start":
      paramsIdentifier = "ctx.params";
      paramsCatchAllIdentifier = "ctx.params._splat";
      break;
    case "none":
      return "";
  }

  const parts: string[] = [];
  for (const k of info.params) {
    parts.push(`${encodeKey(k)}: ${paramsIdentifier}.${k}`);
  }

  if (info.catchAll) {
    parts.push(`${encodeKey(info.catchAll)}: ${paramsCatchAllIdentifier}`);
  }

  return `const ${paramsBinding} = {\n${indent(parts.join(",\n"))}\n};\n`;
}

function registryRouteToTanStackCreateFileRoutePath(route: string): string {
  const segments = route.split("/");
  const parts: string[] = [];

  for (const seg of segments) {
    if (/^\[\[\.\.\.[^/\]]+\]\]$/.test(seg) || /^\[\.\.\.[^/\]]+\]$/.test(seg)) {
      parts.push("$");
      continue;
    }

    const m = /^\[([^/\]]+)\]$/.exec(seg);
    if (m) {
      parts.push(`$${m[1]}`);
    } else {
      parts.push(seg);
    }
  }

  return `/${parts.join("/")}`;
}

/** URL path for `RouteContext` / `ApiContext` string literals (leading slash, App Router–style segments). */
function registryRouteToUrlPath(route: string): string {
  const t = route.replace(/^\/+/, "").replace(/\/+$/, "");
  return t ? `/${t}` : "/";
}

function generateImports(framework: Framework, routeFilePath: string): string {
  switch (framework) {
    case "tanstack-start":
      return `import { createFileRoute } from '@tanstack/react-router';\n`;
    case "waku":
      return `import type { ApiContext } from 'waku/router';\n`;
    case "react-router":
      // React Router typegen: `./+types/<segments>` relative to the route file (see `+types` next to `routes/`).
      return `import type { Route } from './+types/${path.basename(routeFilePath, path.extname(routeFilePath))}';\n`;
  }

  return "";
}

function generateDeclaration(
  framework: Framework,
  route: string,
  parsedInfo: ParsedRouteInfo,
  handler: HandlerInfo,
): string {
  const paramsBinding = needsRouteParams(parsedInfo) ? (handler.paramsName ?? "params") : null;
  let inner = dedent(handler.bodyText);
  if (paramsBinding) {
    inner = generateParamsDeclaration(framework, parsedInfo, paramsBinding) + inner;
  }
  inner = generateRequestDeclaration(framework, handler.requestName) + inner;

  const urlPath = registryRouteToUrlPath(route);
  const urlPathLiteral = JSON.stringify(urlPath);

  switch (framework) {
    case "next": {
      /** `RouteContext` is provided by Next.js typed routes / `next typegen` (global). */
      const ctxType = `RouteContext<${urlPathLiteral}>`;

      return parsedInfo.methods
        .map(
          (m) =>
            `export async function ${m}(${handler.requestName}: Request, ctx: ${ctxType}) {\n${indent(inner)}\n}`,
        )
        .join("\n\n");
    }
    case "waku": {
      const ctxType = `ApiContext<${urlPathLiteral}>`;
      return parsedInfo.methods
        .map(
          (m) =>
            `export async function ${m}(${handler.requestName}: Request, context: ${ctxType}) {\n${indent(inner)}\n}`,
        )
        .join("\n\n");
    }
    case "tanstack-start": {
      if (handler.requestName === "ctx") {
        throw new Error(
          "route-handler.build: name the request parameter something other than `ctx` for TanStack file routes",
        );
      }

      const fileRoutePath = JSON.stringify(registryRouteToTanStackCreateFileRoutePath(route));
      const entries = parsedInfo.methods
        .map((m) => `      ${m}: async (ctx) => {\n${indent(inner, 4)}\n      },`)
        .join("\n");
      return `export const Route = createFileRoute(${fileRoutePath})({\n  server: {\n    handlers: {\n${entries}\n    },\n  },\n});\n`;
    }
    case "react-router": {
      if (handler.requestName === "args") {
        throw new Error(
          "route-handler.build: name the request parameter something other than `args` for React Router resource routes",
        );
      }

      const includeLoader = parsedInfo.methods.some((x) => reactRouterLoaderMethods.has(x));
      const includeAction = parsedInfo.methods.some((x) => reactRouterActionMethods.has(x));
      if (!includeLoader && !includeAction) {
        throw new Error(
          "route-handler.build: react-router needs at least one method mapped to loader (GET/HEAD/OPTIONS) or action (POST/PUT/PATCH/DELETE)",
        );
      }
      const parts: string[] = [];
      if (includeLoader) {
        parts.push(`export async function loader(args: Route.LoaderArgs) {\n${indent(inner)}\n}`);
      }
      if (includeAction) {
        parts.push(`export async function action(args: Route.ActionArgs) {\n${indent(inner)}\n}`);
      }
      return `${parts.join("\n\n")}\n`;
    }
    case "none": {
      if (paramsBinding) {
        let pType = `{`;

        for (const param of parsedInfo.params) {
          pType += ` ${encodeKey(param)}: string;`;
        }

        if (parsedInfo.catchAll) {
          pType += ` ${encodeKey(parsedInfo.catchAll)}?: string[];`;
        }

        pType += " }";

        return parsedInfo.methods
          .map(
            (m) =>
              `export async function ${m}(${handler.requestName}: Request, ${paramsBinding}: ${pType}) {\n${indent(inner)}\n}`,
          )
          .join("\n\n");
      }

      return parsedInfo.methods
        .map(
          (m) =>
            `export async function ${m}(${handler.requestName}: Request) {\n${indent(inner)}\n}`,
        )
        .join("\n\n");
    }
  }
}

function removeMacroImport(s: MagicString, importDecl: ImportDeclaration): void {
  const start = importDecl.start;
  let end = importDecl.end;
  if (s.original[end] === "\n") end += 1;
  s.remove(start, end);
}

/**
 * Rewrites a module that calls `$routeHandler` into framework-native route code.
 *
 * Uses framework typegen where applicable: global `RouteContext` (Next typed routes), `ApiContext` (Waku),
 * inferred handler `ctx` (TanStack `createFileRoute`), `Route.LoaderArgs` / `Route.ActionArgs` (React Router `+types`).
 */
export function transformRouteHandler(
  route: string,
  routeFilePath: string,
  framework: Framework,
  program: Program,
  s: MagicString,
) {
  const macro = collectMacroBindings(program, "$routeHandler");
  if (!macro) return;

  const calls = collectRouteHandlerCalls(program, macro.locals);
  if (calls.length === 0) return;
  if (calls.length > 1) {
    throw new Error("route-handler.build: expected exactly one $routeHandler(...) call per file");
  }

  const call = calls[0]!;
  if (call.arguments.length !== 2) {
    throw new Error("route-handler.build: $routeHandler must be called with (info, handler)");
  }

  const [arg0, arg1] = call.arguments;
  if (arg0.type !== "ObjectExpression") {
    throw new Error(
      "route-handler.build: first argument to $routeHandler must be an object literal",
    );
  }

  const parsedInfo = parseRouteInfoFromAst(arg0);
  const handler = parseHandlerFromAst(s, arg1);

  const stmtSpan = findStatementSpanForCall(program, call);
  if (!stmtSpan) {
    throw new Error(
      "route-handler.build: $routeHandler(...) must be the initializer of a const (optionally exported)",
    );
  }

  for (const decl of macro.importDecls) {
    removeMacroImport(s, decl);
  }

  const extraImports = generateImports(framework, routeFilePath);
  if (extraImports) {
    const insertPos = findInsertPositionForNewImports(program);
    if (insertPos === 0) {
      s.prepend(extraImports);
    } else {
      s.appendLeft(insertPos, `\n${extraImports}`);
    }
  }

  s.overwrite(
    stmtSpan.start,
    stmtSpan.end,
    generateDeclaration(framework, route, parsedInfo, handler),
  );

  s.trim();
}

function findInsertPositionForNewImports(program: Program): number {
  const last = program.body.findLast(
    (stmt): stmt is ImportDeclaration => stmt.type === "ImportDeclaration",
  );

  if (last) return last.end;
  return 0;
}
