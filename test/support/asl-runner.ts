/**
 * A small, local Amazon States Language interpreter for tests. It supports what our pipeline
 * uses: Task, Pass, Choice, Parallel, Succeed, Fail, JSONPath Parameters, ResultSelector,
 * ResultPath, Retry, Catch, the $$ context object, and States.JsonToString. Retries do not sleep.
 */

type Json = any;

export interface TaskInvoker {
  (resource: string, input: Json): Promise<Json>;
}

export class StatesError extends Error {
  constructor(
    public readonly error: string,
    public readonly cause: string,
  ) {
    super(`${error}: ${cause}`);
  }
}

export interface RunResult {
  status: 'SUCCEEDED' | 'FAILED';
  output?: Json;
  error?: StatesError;
  /** Every state entered, in order, including those inside Parallel branches. */
  path: string[];
}

interface Context {
  Execution: { Id: string; Name: string; StartTime: string; Input: Json };
}

/** Turn a CloudFormation DefinitionString (Fn::Join with intrinsic tokens) into ASL JSON. */
export function resolveDefinition(definitionString: Json): Json {
  if (typeof definitionString === 'string') return JSON.parse(definitionString);
  const [sep, parts] = definitionString['Fn::Join'];
  const text = (parts as Json[])
    .map((p) => {
      if (typeof p === 'string') return p;
      if (p['Fn::GetAtt']) return `arn:local:${p['Fn::GetAtt'][0]}:${p['Fn::GetAtt'][1]}`;
      if (p.Ref) return `ref:${p.Ref}`;
      return 'unresolved';
    })
    .join(sep);
  return JSON.parse(text);
}

// ---------- JSONPath (the subset ASL needs) ----------

function tokenize(path: string): (string | number)[] {
  if (!path.startsWith('$')) throw new Error(`bad path ${path}`);
  const out: (string | number)[] = [];
  const re = /\.([A-Za-z0-9_-]+)|\[(\d+)\]/g;
  const rest = path.slice(1);
  let consumed = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rest))) {
    if (m.index !== consumed) throw new Error(`unsupported path ${path}`);
    consumed = m.index + m[0].length;
    out.push(m[1] !== undefined ? m[1] : Number(m[2]));
  }
  if (consumed !== rest.length) throw new Error(`unsupported path ${path}`);
  return out;
}

export function getPath(data: Json, path: string, ctx?: Context): Json {
  if (path.startsWith('$$')) return getPath(ctx, path.slice(1));
  let cur = data;
  for (const t of tokenize(path)) {
    if (cur === null || cur === undefined || !(t in Object(cur))) {
      throw new StatesError('States.Runtime', `path ${path} not found`);
    }
    cur = cur[t as keyof typeof cur];
  }
  return cur;
}

function setPath(data: Json, path: string | null | undefined, value: Json): Json {
  if (path === null) return data; // ResultPath: null discards the result
  if (path === undefined || path === '$') return value;
  const tokens = tokenize(path);
  const root = structuredClone(data ?? {});
  let cur = root;
  tokens.forEach((t, i) => {
    if (i === tokens.length - 1) cur[t] = value;
    else {
      if (typeof cur[t] !== 'object' || cur[t] === null) cur[t] = {};
      cur = cur[t];
    }
  });
  return root;
}

function evalIntrinsic(expr: string, data: Json, ctx: Context): Json {
  const m = /^States\.JsonToString\((.+)\)$/.exec(expr);
  if (m) return JSON.stringify(getPath(data, m[1].trim(), ctx));
  throw new Error(`unsupported intrinsic ${expr}`);
}

function applyTemplate(tpl: Json, data: Json, ctx: Context): Json {
  if (Array.isArray(tpl)) return tpl.map((x) => applyTemplate(x, data, ctx));
  if (tpl === null || typeof tpl !== 'object') return tpl;
  const out: Json = {};
  for (const [k, v] of Object.entries(tpl)) {
    if (k.endsWith('.$')) {
      const expr = v as string;
      out[k.slice(0, -2)] = expr.startsWith('States.') ? evalIntrinsic(expr, data, ctx) : getPath(data, expr, ctx);
    } else {
      out[k] = applyTemplate(v, data, ctx);
    }
  }
  return out;
}

// ---------- Choice rules ----------

function evalRule(rule: Json, data: Json, ctx: Context): boolean {
  if (rule.And) return rule.And.every((r: Json) => evalRule(r, data, ctx));
  if (rule.Or) return rule.Or.some((r: Json) => evalRule(r, data, ctx));
  if (rule.Not) return !evalRule(rule.Not, data, ctx);
  let value: Json;
  try {
    value = getPath(data, rule.Variable, ctx);
  } catch {
    if ('IsPresent' in rule) return rule.IsPresent === false;
    // Real Step Functions fails the execution when a Choice variable is missing.
    throw new StatesError('States.Runtime', `choice variable ${rule.Variable} not found`);
  }
  if ('IsPresent' in rule) return rule.IsPresent === true;
  if ('BooleanEquals' in rule) return value === rule.BooleanEquals;
  if ('StringEquals' in rule) return value === rule.StringEquals;
  if ('NumericEquals' in rule) return value === rule.NumericEquals;
  if ('NumericGreaterThanEquals' in rule) return value >= rule.NumericGreaterThanEquals;
  throw new Error(`unsupported choice rule ${JSON.stringify(rule)}`);
}

// ---------- Execution ----------

function matches(errorEquals: string[], error: string): boolean {
  // States.ALL does not catch States.Runtime in real Step Functions.
  return errorEquals.includes(error) || (errorEquals.includes('States.ALL') && error !== 'States.Runtime');
}

export class AslRunner {
  constructor(
    private readonly def: Json,
    private readonly invoke: TaskInvoker,
  ) {}

  async run(input: Json, name = 'test-execution'): Promise<RunResult> {
    const ctx: Context = {
      Execution: { Id: `arn:local:execution:${name}`, Name: name, StartTime: '2026-10-07T12:00:00.000Z', Input: input },
    };
    const path: string[] = [];
    try {
      const output = await this.runMachine(this.def, input, ctx, path);
      return { status: 'SUCCEEDED', output, path };
    } catch (err) {
      if (err instanceof StatesError) return { status: 'FAILED', error: err, path };
      throw err;
    }
  }

  private async runMachine(machine: Json, input: Json, ctx: Context, path: string[]): Promise<Json> {
    let name: string | undefined = machine.StartAt;
    let data = input;
    for (let steps = 0; name; steps++) {
      if (steps > 200) throw new Error('too many transitions');
      const state = machine.States[name];
      if (!state) throw new Error(`no state ${name}`);
      path.push(name);
      const { next, output } = await this.runState(name, state, data, ctx, path);
      data = output;
      name = next;
    }
    return data;
  }

  private async runState(name: string, state: Json, raw: Json, ctx: Context, path: string[]): Promise<{ next?: string; output: Json }> {
    const input = state.InputPath ? getPath(raw, state.InputPath, ctx) : raw;
    const finish = (result: Json) => {
      let r = result;
      if (state.ResultSelector) r = applyTemplate(state.ResultSelector, r, ctx);
      let out = state.ResultPath === undefined ? r : setPath(raw, state.ResultPath, r);
      if (state.OutputPath) out = getPath(out, state.OutputPath, ctx);
      return { next: state.End ? undefined : state.Next, output: out };
    };

    switch (state.Type) {
      case 'Pass':
        return finish(state.Parameters ? applyTemplate(state.Parameters, input, ctx) : (state.Result ?? input));
      case 'Succeed':
        return { output: input };
      case 'Fail':
        throw new StatesError(state.Error ?? 'States.Fail', state.Cause ?? '');
      case 'Choice': {
        const hit = (state.Choices as Json[]).find((c) => evalRule(c, input, ctx));
        const next = hit?.Next ?? state.Default;
        if (!next) throw new StatesError('States.NoChoiceMatched', name);
        return { next, output: input };
      }
      case 'Task':
      case 'Parallel': {
        const attempts = new Map<Json, number>();
        for (;;) {
          try {
            const effective = state.Parameters ? applyTemplate(state.Parameters, input, ctx) : input;
            const result =
              state.Type === 'Task'
                ? await this.invoke(state.Resource, effective)
                : await Promise.all((state.Branches as Json[]).map((b) => this.runMachine(b, effective, ctx, path)));
            return finish(result);
          } catch (err) {
            const se = err instanceof StatesError ? err : new StatesError((err as Error).name || 'Error', (err as Error).message);
            const retrier = (state.Retry ?? []).find((r: Json) => matches(r.ErrorEquals, se.error));
            if (retrier) {
              const used = attempts.get(retrier) ?? 0;
              if (used < (retrier.MaxAttempts ?? 3)) {
                attempts.set(retrier, used + 1);
                if (state.Type === 'Parallel') path.push(`${name} (retry ${used + 1})`);
                continue;
              }
            }
            const catcher = (state.Catch ?? []).find((c: Json) => matches(c.ErrorEquals, se.error));
            if (!catcher) throw se;
            return { next: catcher.Next, output: setPath(raw, catcher.ResultPath, { Error: se.error, Cause: se.cause }) };
          }
        }
      }
      default:
        throw new Error(`unsupported state type ${state.Type}`);
    }
  }
}
