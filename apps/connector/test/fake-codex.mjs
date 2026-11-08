import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const options = JSON.parse(process.env.FAKE_CODEX_OPTIONS || '{}');
if (process.argv.includes('--version')) { console.log(process.argv.find(v => v.startsWith('--fake-version='))?.slice('--fake-version='.length) || 'codex-cli 0.166.0-alpha.6'); process.exit(0); }
const dir = process.env.FAKE_CODEX_DIR;
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'args.json'), JSON.stringify(process.argv.slice(2)));
const id = '019a0000-0000-7000-8000-000000000001';
const path = join(dir, `rollout-${id}.jsonl`);
const report = { status: 'done', summary: 'Codex fake complete', answer: '42', changes: [], decisions: [], leftovers: [], tests: null, question: null, next: null };
const append = (type, payload) => appendFileSync(path, JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + '\n');
const emit = (value) => {
  const text = JSON.stringify(value) + '\n';
  if (options.fragment) { process.stdout.write(text.slice(0, 9)); process.stdout.write(text.slice(9)); }
  else process.stdout.write(text);
};
const notify = (method, params) => emit({ method, params: { threadId: id, ...params } });
let turn = 0;
let active;
function finish(turnId, status = 'completed') {
  const text = options.invalid ? '{"status":"done","summary":12}' : JSON.stringify(report);
  const item = { type: 'agentMessage', id: `message-${turnId}`, text, phase: 'final_answer' };
  if (status === 'completed') {
    append('response_item', { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text }] });
    append('event_msg', { type: 'task_complete', turn_id: turnId, last_agent_message: text });
    notify('item/completed', { turnId, item });
  } else append('event_msg', { type: 'turn_aborted', turn_id: turnId });
  notify('turn/completed', { turn: { id: turnId, status, error: status === 'failed' ? { message: options.error || '401 login required' } : null } });
  if (options.duplicate) notify('turn/completed', { turn: { id: turnId, status } });
  if (active === turnId) active = undefined;
  if (options.exitAfterTerminal) setTimeout(() => process.exit(0), 5);
}
function finishFirstTurnWhenReleased(turnId) {
  const releaseFile = join(dir, options.holdFirstUntilFile);
  const timer = setInterval(() => {
    if (active !== turnId) { clearInterval(timer); return; }
    if (existsSync(releaseFile)) { clearInterval(timer); finish(turnId, 'completed'); }
  }, 10);
  timer.unref();
}
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line);
  if (!req.method) { appendFileSync(join(dir, 'responses.jsonl'), line + '\n'); return; }
  appendFileSync(join(dir, 'requests.jsonl'), line + '\n');
  if (req.id === undefined) return;
  const reply = (result) => emit({ id: req.id, result });
  if (req.method === 'initialize') {
    writeFileSync(join(dir, 'env.json'), JSON.stringify({ home: !!process.env.HOME, path: !!process.env.PATH, override: process.env.FAKE_CODEX_DIR }));
    if (!options.initTimeout) reply({ userAgent: 'fake' });
  }
  else if (req.method === 'account/read') reply({ account: options.noAuth ? null : { type: 'chatgpt' }, requiresOpenaiAuth: true });
  else if (req.method === 'config/read') reply({ config: options.external ? { mcp_servers: { remote: {} } } : {} });
  else if (req.method === 'mcpServerStatus/list') reply({ data: [], nextCursor: null });
  else if (req.method === 'thread/read') reply({ thread: { id, turns: [{ id: `turn-${turn}`, status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: JSON.stringify(report) }] }] } });
  else if (['thread/start', 'thread/resume'].includes(req.method)) {
    if (req.method === 'thread/resume' && options.resumeError) { emit({ id: req.id, error: options.resumeError }); return; }
    if (req.method === 'thread/start') writeFileSync(path, JSON.stringify({ type: 'session_meta', payload: { id, cwd: process.cwd() } }) + '\n');
    else if (!readFileSync(path, 'utf8').includes(id)) throw Error('missing session');
    reply({ thread: { id, sessionId: 'different-session-tree-root', path: options.noPath ? null : path } });
  } else if (req.method === 'turn/start') {
    if (options.rejectStart) { emit({ id: req.id, error: { code: options.rejectStart, message: 'rejected start' } }); return; }
    if (options.detachedJob) {
      const job = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
      writeFileSync(join(dir, 'job-pid'), String(job.pid));
      job.unref();
    }
    if (options.malformed) { process.stdout.write('not-json\n'); return; }
    const turnId = `turn-${++turn}`; active = turnId;
    append('event_msg', { type: 'task_started', turn_id: turnId });
    append('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: req.params.input[0].text }] });
    if (options.exitBeforeReceipt) process.exit(0);
    if (options.delayActivity) setTimeout(() => notify('item/started', { turnId, item: { type: 'reasoning' } }), options.delayActivity);
    else notify('item/started', { turnId, item: { type: 'reasoning' } });
    if (options.early) { notify('turn/started', { turn: { id: turnId } }); finish(turnId); }
    if (options.latePrevious && turn > 1) notify('turn/completed', { turn: { id: `turn-${turn - 1}`, status: 'failed' } });
    reply({ turn: { id: turnId, status: 'inProgress' } });
    if (options.serverRequest) emit({ id: 'server-1', method: 'item/commandExecution/requestApproval', params: { threadId: id, turnId } });
    else if (!options.early && turn === 1 && options.holdFirstUntilFile) finishFirstTurnWhenReleased(turnId);
    else if (!options.hold && !options.early) setTimeout(() => finish(turnId, options.failed ? 'failed' : 'completed'), options.delay ?? 20);
  } else if (req.method === 'turn/steer') {
    if (options.rejectSteer) { emit({ id: req.id, error: { code: options.rejectSteer, message: 'rejected steer' } }); return; }
    if (req.params.expectedTurnId !== active) emit({ id: req.id, error: { code: -1, message: 'turn mismatch' } });
    else reply({ turnId: active });
  } else if (req.method === 'turn/interrupt') {
    if (options.missingTerminal) { emit({ id: req.id, error: { code: -1, message: 'no active turn to interrupt' } }); return; }
    if (options.completeAfterInterruptError) {
      emit({ id: req.id, error: { code: -1, message: 'no active turn to interrupt' } });
      setTimeout(() => finish(req.params.turnId), 20); return;
    }
    if (options.completeOnInterrupt) finish(active);
    reply({});
    if (!options.completeOnInterrupt) setTimeout(() => finish(req.params.turnId, 'interrupted'), 10);
  } else emit({ id: req.id, error: { code: -32601, message: req.method } });
});
