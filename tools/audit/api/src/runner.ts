import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';

export type RunStatus = 'running' | 'passed' | 'failed' | 'cancelled';

export interface Run {
  id: string;
  label: string;
  command: string;
  cwd: string;
  status: RunStatus;
  startedAt: number;
  finishedAt?: number;
  exitCode?: number | null;
  lines: string[];
  listeners: Set<Response>;
  kill: () => void;
}

const runs = new Map<string, Run>();

/** Keep memory bounded; a fuzzing campaign can emit a great deal. */
const MAX_LINES = 4000;

export function getRun(id: string): Run | undefined {
  return runs.get(id);
}

export function listRuns(): Omit<Run, 'listeners' | 'kill'>[] {
  return [...runs.values()]
    .map(({ listeners: _l, kill: _k, ...rest }) => rest)
    .sort((a, b) => b.startedAt - a.startedAt);
}

function push(run: Run, line: string) {
  run.lines.push(line);
  if (run.lines.length > MAX_LINES) {
    run.lines.splice(0, run.lines.length - MAX_LINES);
  }
  for (const res of run.listeners) {
    res.write(`event: line\ndata: ${JSON.stringify(line)}\n\n`);
  }
}

function finish(run: Run, code: number | null) {
  run.status = run.status === 'cancelled' ? 'cancelled' : code === 0 ? 'passed' : 'failed';
  run.exitCode = code;
  run.finishedAt = Date.now();
  for (const res of run.listeners) {
    res.write(`event: done\ndata: ${JSON.stringify({ status: run.status, exitCode: code })}\n\n`);
    res.end();
  }
  run.listeners.clear();
}

/**
 * Start a command and stream its output.
 *
 * `cargo` writes almost everything a developer wants to see to **stderr** —
 * compiler diagnostics, test progress, libFuzzer statistics. Merging both
 * streams is not sloppiness; keeping them separate would show an empty log for
 * a failing build.
 */
export function startRun(opts: {
  label: string;
  cwd: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}): Run {
  const id = randomUUID();
  const child = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
  });

  const run: Run = {
    id,
    label: opts.label,
    command: `${opts.command} ${opts.args.join(' ')}`,
    cwd: opts.cwd,
    status: 'running',
    startedAt: Date.now(),
    lines: [],
    listeners: new Set(),
    kill: () => {
      run.status = 'cancelled';
      child.kill('SIGTERM');
    },
  };
  runs.set(id, run);

  let buf = '';
  const onData = (chunk: Buffer) => {
    buf += chunk.toString();
    const parts = buf.split('\n');
    buf = parts.pop() ?? '';
    for (const line of parts) push(run, line);
  };

  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  child.on('error', (err) => {
    push(run, `!! não foi possível executar: ${err.message}`);
    finish(run, -1);
  });
  child.on('close', (code) => {
    if (buf) push(run, buf);
    finish(run, code);
  });

  return run;
}

/** Attach an SSE listener, replaying everything emitted so far. */
export function attach(run: Run, res: Response) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  for (const line of run.lines) {
    res.write(`event: line\ndata: ${JSON.stringify(line)}\n\n`);
  }

  if (run.status !== 'running') {
    res.write(
      `event: done\ndata: ${JSON.stringify({ status: run.status, exitCode: run.exitCode })}\n\n`,
    );
    res.end();
    return;
  }

  run.listeners.add(res);
  res.on('close', () => run.listeners.delete(res));
}
