#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(ROOT, 'manifest.json');
const IMAGES_DIR = path.join(ROOT, 'images');
const DATA_DIR = process.env.TBLAB_DATA_DIR || path.join(os.homedir(), '.thinkerbyte', 'bridge');
const STATE_PATH = path.join(DATA_DIR, 'state.json');
const TOKEN_PATH = path.join(DATA_DIR, 'pairing.token');

const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
const profiles = loadProfiles();
const startedAt = Date.now();

ensureDir(DATA_DIR);
let state = loadState();
let runtimeEngine = detectRuntimeEngine();
let pairingToken = loadOrCreateToken();
let cleanupBusy = false;

setInterval(() => {
  runCleanup().catch((err) => log('cleanup error: ' + err.message));
}, 60 * 1000).unref();

function loadProfiles() {
  const out = {};
  for (const file of fs.readdirSync(IMAGES_DIR)) {
    if (!file.endsWith('.json')) continue;
    const p = JSON.parse(fs.readFileSync(path.join(IMAGES_DIR, file), 'utf8'));
    out[p.id] = p;
  }
  return out;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    if (!parsed.sessions || typeof parsed.sessions !== 'object') throw new Error('invalid state');
    return parsed;
  } catch (_) {
    return { sessions: {}, createdAt: new Date().toISOString() };
  }
}

function saveState() {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function loadOrCreateToken() {
  try {
    return fs.readFileSync(TOKEN_PATH, 'utf8').trim();
  } catch (_) {
    const token = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(TOKEN_PATH, token, { mode: 0o600 });
    return token;
  }
}

function detectRuntimeEngine() {
  if (process.env.TBLAB_ENGINE) return process.env.TBLAB_ENGINE;
  if (commandWorks('docker', ['version'])) return 'docker';
  if (commandWorks('podman', ['version'])) return 'podman';
  return null;
}

function commandWorks(cmd, args) {
  try {
    const out = spawnSync(cmd, args, { stdio: 'ignore', timeout: 1500 });
    return out.status === 0;
  } catch (_) {
    return false;
  }
}

function json(res, code, payload, origin) {
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  };
  if (origin) headers['access-control-allow-origin'] = origin;
  res.writeHead(code, headers);
  res.end(JSON.stringify(payload));
}

function text(res, code, payload, origin) {
  const headers = {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  };
  if (origin) headers['access-control-allow-origin'] = origin;
  res.writeHead(code, headers);
  res.end(payload);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (buf) => {
      raw += buf;
      if (raw.length > 1024 * 512) {
        reject(new Error('payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error('invalid json body'));
      }
    });
    req.on('error', reject);
  });
}

function validateOrigin(req) {
  const origin = req.headers.origin || '';
  if (!origin) return { ok: true, origin: '*' };
  const allowed = (manifest.allowedOrigins || []).includes(origin);
  return { ok: allowed, origin: allowed ? origin : null };
}

function tokenRequired() {
  return process.env.TBLAB_REQUIRE_TOKEN === '1';
}

function validateToken(req) {
  if (!tokenRequired()) return true;
  const token = req.headers['x-thinkerbyte-token'];
  return token && token === pairingToken;
}

function nowIso() {
  return new Date().toISOString();
}

function genSessionId() {
  return 's_' + crypto.randomBytes(4).toString('hex');
}

function maxSessions() {
  return Number(manifest.defaults.maxConcurrentSessions || 6);
}

async function run(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(`${cmd} ${args.join(' ')} failed (${code}): ${stderr || stdout}`.trim()));
    });
  });
}

async function runResult(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function engineCmd() {
  if (!runtimeEngine) throw new Error('No container runtime found (docker/podman)');
  return runtimeEngine;
}

async function imageExists(image) {
  try {
    await run(engineCmd(), ['image', 'inspect', image]);
    return true;
  } catch (_) {
    return false;
  }
}

function runtimeImageTag(profile) {
  const versionTag = String(manifest.version || '0').replace(/[^a-zA-Z0-9._-]/g, '-');
  return `thinkerbyte/${profile.id}-cli:${versionTag}`;
}

function bootstrapInstallCommand(profile) {
  const pkgs = (profile.bootstrapPackages || []).join(' ');
  if (!pkgs) return 'true';
  if (profile.distroFamily === 'alpine') {
    return `apk update && apk add --no-cache ${pkgs}`;
  }
  if (profile.distroFamily === 'debian') {
    return `apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y ${pkgs} && apt-get clean`;
  }
  if (profile.distroFamily === 'fedora') {
    return `dnf -y install ${pkgs} && dnf clean all`;
  }
  return 'true';
}

async function buildRuntimeImage(profile) {
  const target = runtimeImageTag(profile);
  const temp = `tblab-build-${profile.id}-${Date.now()}`;
  const installCmd = bootstrapInstallCommand(profile);
  const banner = (profile.banner || 'ThinkerByte Lab').replace(/\"/g, '\\"');
  try {
    await run(engineCmd(), ['run', '-d', '--name', temp, profile.baseImage, '/bin/sh', '-lc', 'sleep 600']);
    await execIn(temp, installCmd);
    await execIn(temp, `echo \"${banner}\" > /etc/motd || true`);
    await run(engineCmd(), ['commit', temp, target]);
  } finally {
    try {
      await run(engineCmd(), ['rm', '-f', temp]);
    } catch (_) {}
  }
  return target;
}

async function ensureRuntimeImage(profile) {
  const target = runtimeImageTag(profile);
  if (await imageExists(target)) return target;
  return buildRuntimeImage(profile);
}

async function ensureImage(profileId) {
  const profile = profiles[profileId];
  if (!profile) throw new Error('Unknown profile: ' + profileId);
  const exists = await imageExists(profile.baseImage);
  if (!exists) {
    await run(engineCmd(), ['pull', profile.baseImage]);
  }
  profile.runtimeImage = await ensureRuntimeImage(profile);
  return profile;
}

async function listImages() {
  const result = [];
  for (const p of Object.values(profiles)) {
    const baseExists = await imageExists(p.baseImage);
    const runtimeImage = runtimeImageTag(p);
    const runtimeExists = await imageExists(runtimeImage);
    result.push({
      id: p.id,
      label: p.label,
      distroFamily: p.distroFamily,
      baseImage: p.baseImage,
      runtimeImage,
      packageManager: p.packageManager,
      exists: baseExists && runtimeExists,
      baseExists,
      runtimeExists,
      banner: p.banner,
    });
  }
  return result;
}

function sessionContainers(session) {
  return session.nodes.map((n) => n.containerName);
}

function securityPolicy() {
  return manifest.securityPolicy || {};
}

function useInternalNetworks(payload) {
  const policy = securityPolicy();
  const globalAllowEgress = Boolean(manifest.defaults && manifest.defaults.allowExternalEgress);
  const requestAllowEgress = Boolean(payload && payload.allowExternalEgress);
  if (requestAllowEgress && globalAllowEgress) return false;
  return policy.internalNetworks !== false;
}

function isExpired(session) {
  if (!session || !session.expiresAt) return false;
  const ts = new Date(session.expiresAt).getTime();
  if (Number.isNaN(ts)) return false;
  return Date.now() >= ts;
}

function seedFromSession(sessionId, attempt) {
  const digest = crypto.createHash('sha1').update(`${sessionId}:${attempt}`).digest();
  return ((digest[0] << 8) | digest[1]) & 0x0fff; // 0..4095
}

function netParts(seedOffset) {
  const seed = seedOffset & 0x0fff;
  const second = 16 + Math.floor(seed / 256); // 172.16..172.31
  const third = seed % 256;
  return { second, third };
}

function subnetFrom(parts) {
  return `172.${parts.second}.${parts.third}.0/24`;
}

function ipFrom(parts, host) {
  return `172.${parts.second}.${parts.third}.${host}`;
}

function isOverlapError(err) {
  if (!err || !err.message) return false;
  return /overlap|overlapping|invalid pool request|address pool/i.test(err.message);
}

async function createNetwork(name, subnet, internalOnly) {
  const args = ['network', 'create', '--driver', 'bridge'];
  if (internalOnly) args.push('--internal');
  if (subnet) args.push('--subnet', subnet);
  args.push(name);
  await run(engineCmd(), args);
}

async function removeNetwork(name) {
  try {
    await run(engineCmd(), ['network', 'rm', name]);
  } catch (_) {}
}

function defaultNodeCommand(profile) {
  const banner = profile.banner || 'ThinkerByte Lab';
  const prompt = profile.prompt || 'student@thinkerbyte:~$';
  const shCmd = [
    `echo \"${banner}\"`,
    `export PS1='${prompt} '`,
    'mkdir -p /workspace',
    'cd /workspace',
    'sleep infinity',
  ].join(' && ');
  return ['/bin/sh', '-lc', shCmd];
}

async function createContainer(node, profile, extraArgs) {
  const args = ['run', '-d', '--name', node.containerName, '--hostname', node.hostname || node.name];
  const policy = securityPolicy();
  if (policy.noNewPrivileges) args.push('--security-opt', 'no-new-privileges:true');
  if (policy.capDropAll) args.push('--cap-drop', 'ALL');
  if (policy.pidsLimit) args.push('--pids-limit', String(policy.pidsLimit));
  if (policy.memoryLimitMb) args.push('--memory', `${Number(policy.memoryLimitMb)}m`);
  if (extraArgs && extraArgs.length) args.push(...extraArgs);
  args.push(profile.runtimeImage || profile.baseImage);
  args.push(...defaultNodeCommand(profile));
  const out = await run(engineCmd(), args);
  return out.stdout.trim();
}

async function connectContainerNetwork(containerName, network, ip) {
  const args = ['network', 'connect'];
  if (ip) args.push('--ip', ip);
  args.push(network, containerName);
  await run(engineCmd(), args);
}

async function execIn(containerName, command) {
  await run(engineCmd(), ['exec', containerName, '/bin/sh', '-lc', command]);
}

async function execInResult(containerName, command) {
  return runResult(engineCmd(), ['exec', containerName, '/bin/sh', '-lc', command]);
}

function topologyTemplate(topology, seed) {
  const a = netParts(seed);
  const b = netParts(seed + 1);

  if (topology === 'single') {
    return {
      networks: [{ name: 'core', subnet: subnetFrom(a) }],
      nodes: [
        { name: 'student', networks: [{ name: 'core', ip: ipFrom(a, 10) }], caps: ['NET_ADMIN', 'NET_RAW'] },
      ],
      postConfig: [],
    };
  }

  if (topology === 'lan') {
    return {
      networks: [{ name: 'core', subnet: subnetFrom(a) }],
      nodes: [
        { name: 'student', networks: [{ name: 'core', ip: ipFrom(a, 10) }], caps: ['NET_ADMIN', 'NET_RAW'] },
        { name: 'server', networks: [{ name: 'core', ip: ipFrom(a, 20) }], caps: ['NET_ADMIN'] },
        { name: 'capture', networks: [{ name: 'core', ip: ipFrom(a, 99) }], caps: ['NET_ADMIN', 'NET_RAW'] },
      ],
      postConfig: [],
    };
  }

  return {
    networks: [
      { name: 'left', subnet: subnetFrom(a) },
      { name: 'right', subnet: subnetFrom(b) },
    ],
    nodes: [
      { name: 'student', networks: [{ name: 'left', ip: ipFrom(a, 10) }], caps: ['NET_ADMIN', 'NET_RAW'] },
      { name: 'router', networks: [{ name: 'left', ip: ipFrom(a, 1) }, { name: 'right', ip: ipFrom(b, 1) }], caps: ['NET_ADMIN', 'NET_RAW'] },
      { name: 'server', networks: [{ name: 'right', ip: ipFrom(b, 20) }], caps: ['NET_ADMIN'] },
      { name: 'capture', networks: [{ name: 'left', ip: ipFrom(a, 99) }], caps: ['NET_ADMIN', 'NET_RAW'] },
    ],
    postConfig: [
      { node: 'student', cmd: `ip route replace default via ${ipFrom(a, 1)}` },
      { node: 'server', cmd: `ip route replace default via ${ipFrom(b, 1)}` },
      { node: 'router', cmd: 'sysctl -w net.ipv4.ip_forward=1' },
      { node: 'router', cmd: 'iptables -P FORWARD ACCEPT || true' },
    ],
  };
}

async function createSession(payload) {
  const profileId = payload.profile || manifest.defaults.profile || 'alpine';
  const topology = payload.topology || manifest.defaults.topology || 'routed';
  const ttlMinutes = Number(payload.ttlMinutes || manifest.defaults.sessionTtlMinutes || 120);

  if (payload.resumeIfPossible) {
    const resumed = await resumeLatestSession({ profile: profileId, topology });
    if (resumed) return resumed;
  }

  if (Object.keys(state.sessions).filter((id) => state.sessions[id].status === 'running').length >= maxSessions()) {
    throw new Error('max concurrent sessions reached');
  }

  const profile = await ensureImage(profileId);
  const internalOnly = useInternalNetworks(payload);
  const sessionId = genSessionId();
  const prefix = `tblab-${sessionId}`;

  const session = {
    id: sessionId,
    name: payload.name || `thinkerbyte-${sessionId}`,
    profile: profileId,
    topology,
    ttlMinutes,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    expiresAt: new Date(Date.now() + ttlMinutes * 60000).toISOString(),
    status: 'creating',
    isolation: {
      internalNetworks: internalOnly,
      noNewPrivileges: Boolean(securityPolicy().noNewPrivileges),
      capDropAll: Boolean(securityPolicy().capDropAll),
    },
    networks: [],
    nodes: [],
  };
  state.sessions[sessionId] = session;
  saveState();

  const attemptLimit = 12;
  for (let attempt = 0; attempt < attemptLimit; attempt++) {
    const template = topologyTemplate(topology, seedFromSession(sessionId, attempt));
    try {
      for (const n of template.networks) {
        const fullName = `${prefix}-${n.name}`;
        await createNetwork(fullName, n.subnet, internalOnly);
        session.networks.push({ ...n, fullName, internalOnly });
      }

      for (const node of template.nodes) {
        const containerName = `${prefix}-${node.name}`;
        const baseNetwork = session.networks.find((n) => n.name === node.networks[0].name);
        if (!baseNetwork) throw new Error('invalid network mapping for node ' + node.name);

        const extra = ['--network', baseNetwork.fullName, '--ip', node.networks[0].ip];
        const caps = new Set(node.caps || []);
        for (const cap of caps) extra.push('--cap-add', cap);

        await createContainer({ ...node, containerName, hostname: `thinkerbyte-${node.name}` }, profile, extra);

        for (let i = 1; i < node.networks.length; i++) {
          const netDef = session.networks.find((n) => n.name === node.networks[i].name);
          if (netDef) await connectContainerNetwork(containerName, netDef.fullName, node.networks[i].ip);
        }

        session.nodes.push({
          name: node.name,
          hostname: `thinkerbyte-${node.name}`,
          containerName,
          addresses: node.networks,
        });
      }

      for (const step of template.postConfig) {
        const node = session.nodes.find((n) => n.name === step.node);
        if (node) await execIn(node.containerName, step.cmd);
      }

      session.status = 'running';
      session.updatedAt = nowIso();
      saveState();
      return session;
    } catch (err) {
      await destroySession(sessionId, true);
      if (!isOverlapError(err) || attempt === attemptLimit - 1) {
        throw err;
      }
      state.sessions[sessionId] = {
        ...session,
        status: 'creating',
        networks: [],
        nodes: [],
        updatedAt: nowIso(),
      };
      session.networks = [];
      session.nodes = [];
      saveState();
    }
  }

  throw new Error('unable to allocate non-overlapping lab networks');
}

async function startSession(sessionId) {
  const session = state.sessions[sessionId];
  if (!session) throw new Error('session not found');
  for (const name of sessionContainers(session)) {
    await run(engineCmd(), ['start', name]);
  }
  session.status = 'running';
  session.updatedAt = nowIso();
  saveState();
  return session;
}

async function stopSession(sessionId) {
  const session = state.sessions[sessionId];
  if (!session) throw new Error('session not found');
  for (const name of sessionContainers(session)) {
    try {
      await run(engineCmd(), ['stop', name]);
    } catch (_) {}
  }
  session.status = 'stopped';
  session.updatedAt = nowIso();
  saveState();
  return session;
}

async function destroySession(sessionId, silent) {
  const session = state.sessions[sessionId];
  if (!session) {
    if (silent) return null;
    throw new Error('session not found');
  }

  for (const name of sessionContainers(session)) {
    try {
      await run(engineCmd(), ['rm', '-f', name]);
    } catch (_) {}
  }

  for (const net of session.networks || []) {
    await removeNetwork(net.fullName);
  }

  delete state.sessions[sessionId];
  saveState();
  return { destroyed: sessionId };
}

async function execInSession(sessionId, nodeName, command) {
  const session = state.sessions[sessionId];
  if (!session) throw new Error('session not found');
  const node = session.nodes.find((n) => n.name === nodeName || n.containerName === nodeName);
  if (!node) throw new Error('node not found');
  const out = await execInResult(node.containerName, command);
  return {
    sessionId,
    node: node.name,
    containerName: node.containerName,
    command,
    exitCode: out.code,
    stdout: out.stdout,
    stderr: out.stderr,
  };
}

async function resumeLatestSession(filter) {
  const sorted = listSessions().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const target = sorted.find((s) => {
    if (isExpired(s)) return false;
    if (filter && filter.profile && s.profile !== filter.profile) return false;
    if (filter && filter.topology && s.topology !== filter.topology) return false;
    return true;
  });
  if (!target) return null;
  if (target.status === 'running') return target;
  try {
    return await startSession(target.id);
  } catch (_) {
    await destroySession(target.id, true);
    return null;
  }
}

async function enginePrune() {
  if (!runtimeEngine) return;
  if (!manifest.cleanupPolicy.pruneImages && !manifest.cleanupPolicy.pruneVolumes) return;
  const hours = Number(manifest.defaults.pruneUnusedImagesAfterHours || 48);
  const until = `${hours}h`;
  if (manifest.cleanupPolicy.pruneImages) {
    try {
      await run(engineCmd(), ['image', 'prune', '-f', '--filter', `until=${until}`]);
    } catch (_) {}
  }
  if (manifest.cleanupPolicy.pruneVolumes) {
    try {
      await run(engineCmd(), ['volume', 'prune', '-f']);
    } catch (_) {}
  }
  if (manifest.cleanupPolicy.removeStoppedContainers) {
    try {
      await run(engineCmd(), ['container', 'prune', '-f']);
    } catch (_) {}
  }
  await pruneOldRuntimeImages();
}

async function pruneOldRuntimeImages() {
  if (!runtimeEngine) return;
  let out;
  try {
    out = await run(engineCmd(), ['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}']);
  } catch (_) {
    return;
  }
  const lines = out.stdout.split('\\n').map((x) => x.trim()).filter(Boolean);
  const keep = new Set(Object.values(profiles).map((p) => runtimeImageTag(p)));
  for (const img of lines) {
    if (!img.startsWith('thinkerbyte/')) continue;
    if (!keep.has(img)) {
      try {
        await run(engineCmd(), ['image', 'rm', '-f', img]);
      } catch (_) {}
    }
  }
}

async function runCleanup() {
  if (cleanupBusy) return;
  cleanupBusy = true;
  try {
    const now = Date.now();
    const sessions = Object.values(state.sessions);
    for (const s of sessions) {
      if (!s.expiresAt) continue;
      const expires = new Date(s.expiresAt).getTime();
      if (!Number.isNaN(expires) && now >= expires) {
        await destroySession(s.id, true);
      }
    }
    await enginePrune();
  } finally {
    cleanupBusy = false;
  }
}

function listSessions() {
  return Object.values(state.sessions).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function installStatus() {
  return {
    ok: Boolean(runtimeEngine),
    bridge: manifest.name,
    version: manifest.version,
    runtimeEngine: runtimeEngine || 'none',
    tokenRequired: tokenRequired(),
    tokenHint: tokenRequired() ? 'set x-thinkerbyte-token header' : 'not required',
    dataDir: DATA_DIR,
    defaults: manifest.defaults,
    profileCount: Object.keys(profiles).length,
  };
}

function log(msg) {
  process.stdout.write(`[bridge] ${msg}\n`);
}

async function route(req, res, url, origin) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': origin || '*',
      'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
      'access-control-allow-headers': 'content-type,x-thinkerbyte-token',
      'access-control-max-age': '300',
    });
    return res.end();
  }

  if (url.pathname === '/health' && req.method === 'GET') {
    return json(res, 200, {
      ok: true,
      service: manifest.name,
      version: manifest.version,
      apiVersion: manifest.apiVersion,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      runtimeEngine: runtimeEngine || 'none',
      runtimeAvailable: Boolean(runtimeEngine),
      sessions: listSessions().length,
      defaults: manifest.defaults,
      cleanupPolicy: manifest.cleanupPolicy,
      resumeMode: true,
      isolation: {
        localhostOnly: true,
        internalNetworks: securityPolicy().internalNetworks !== false,
        noNewPrivileges: Boolean(securityPolicy().noNewPrivileges),
        capDropAll: Boolean(securityPolicy().capDropAll),
      },
    }, origin);
  }

  if (url.pathname === '/install-status' && req.method === 'GET') {
    return json(res, 200, installStatus(), origin);
  }

  if (url.pathname === '/images' && req.method === 'GET') {
    const images = await listImages();
    return json(res, 200, { ok: true, images }, origin);
  }

  if (url.pathname === '/images/pull' && req.method === 'POST') {
    if (!validateToken(req)) return json(res, 401, { ok: false, error: 'invalid token' }, origin);
    const body = await parseBody(req);
    const profile = await ensureImage(body.profile || manifest.defaults.profile);
    return json(res, 200, { ok: true, profile: profile.id, image: profile.baseImage }, origin);
  }

  if (url.pathname === '/sessions' && req.method === 'GET') {
    return json(res, 200, { ok: true, sessions: listSessions() }, origin);
  }

  if (url.pathname === '/sessions' && req.method === 'POST') {
    if (!validateToken(req)) return json(res, 401, { ok: false, error: 'invalid token' }, origin);
    const body = await parseBody(req);
    const session = await createSession(body);
    return json(res, 201, { ok: true, session }, origin);
  }

  if (url.pathname === '/sessions/resume' && req.method === 'POST') {
    if (!validateToken(req)) return json(res, 401, { ok: false, error: 'invalid token' }, origin);
    const body = await parseBody(req);
    const resumed = await resumeLatestSession({ profile: body.profile, topology: body.topology });
    if (!resumed) return json(res, 404, { ok: false, error: 'no resumable session found' }, origin);
    return json(res, 200, { ok: true, session: resumed, resumed: true }, origin);
  }

  if (url.pathname.match(/^\/sessions\/[^/]+\/start$/) && req.method === 'POST') {
    if (!validateToken(req)) return json(res, 401, { ok: false, error: 'invalid token' }, origin);
    const id = url.pathname.split('/')[2];
    const session = await startSession(id);
    return json(res, 200, { ok: true, session }, origin);
  }

  if (url.pathname.match(/^\/sessions\/[^/]+\/stop$/) && req.method === 'POST') {
    if (!validateToken(req)) return json(res, 401, { ok: false, error: 'invalid token' }, origin);
    const id = url.pathname.split('/')[2];
    const session = await stopSession(id);
    return json(res, 200, { ok: true, session }, origin);
  }

  if (url.pathname.match(/^\/sessions\/[^/]+\/exec$/) && req.method === 'POST') {
    if (!validateToken(req)) return json(res, 401, { ok: false, error: 'invalid token' }, origin);
    const id = url.pathname.split('/')[2];
    const body = await parseBody(req);
    if (!body.node || !body.command) return json(res, 400, { ok: false, error: 'node and command are required' }, origin);
    const out = await execInSession(id, String(body.node), String(body.command));
    return json(res, 200, { ok: true, result: out }, origin);
  }

  if (url.pathname.match(/^\/sessions\/[^/]+$/) && req.method === 'DELETE') {
    if (!validateToken(req)) return json(res, 401, { ok: false, error: 'invalid token' }, origin);
    const id = url.pathname.split('/')[2];
    const out = await destroySession(id, false);
    return json(res, 200, { ok: true, ...out }, origin);
  }

  if (url.pathname === '/repair' && req.method === 'POST') {
    if (!validateToken(req)) return json(res, 401, { ok: false, error: 'invalid token' }, origin);
    await runCleanup();
    return json(res, 200, { ok: true, cleanedAt: nowIso() }, origin);
  }

  if (url.pathname === '/pairing-token' && req.method === 'GET') {
    const expose = process.env.TBLAB_EXPOSE_TOKEN === '1';
    if (!expose) return json(res, 403, { ok: false, error: 'token exposure disabled' }, origin);
    return json(res, 200, { ok: true, token: pairingToken }, origin);
  }

  return text(res, 404, 'not found', origin);
}

const server = http.createServer(async (req, res) => {
  const originCheck = validateOrigin(req);
  if (!originCheck.ok) return json(res, 403, { ok: false, error: 'origin blocked' }, null);

  let url;
  try {
    url = new URL(req.url, `http://${manifest.listenHost}:${manifest.listenPort}`);
  } catch (err) {
    return json(res, 400, { ok: false, error: 'invalid request url' }, originCheck.origin);
  }

  try {
    await route(req, res, url, originCheck.origin);
  } catch (err) {
    log('request error: ' + err.message);
    json(res, 500, { ok: false, error: err.message }, originCheck.origin);
  }
});

server.listen(manifest.listenPort, manifest.listenHost, async () => {
  log(`ThinkerByte Local Bridge v${manifest.version} listening on http://${manifest.listenHost}:${manifest.listenPort}`);
  log(`runtime=${runtimeEngine || 'none'} tokenRequired=${tokenRequired()}`);
  await runCleanup();
});
