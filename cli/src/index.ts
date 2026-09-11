#!/usr/bin/env node
/**
 * vvup — Video Vault bonded uploader.
 *
 * Uploads originals through the same API as the web app, but spreads the
 * multipart PUTs across EVERY working network interface on this machine
 * (Wi-Fi + tethered phone + ethernet + ...), aggregating their bandwidth
 * with no VPN or relay. Fully resumable: re-run the same command after any
 * interruption and only missing parts transfer.
 *
 *   vvup login --url https://vault.example.com --user admin
 *   vvup interfaces
 *   vvup upload ./sdcard --project "Himachal 2026" --folder Camera
 */
import { createReadStream } from 'node:fs';
import { chmod, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { request } from 'undici';
import { login, makeApi, type Session } from './api.js';
import { agentFor, listInterfaces, probe } from './net.js';
import { uploadAll, type LocalFile, type PartPutter } from './uploader.js';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'videovault');
const CONFIG_PATH = path.join(CONFIG_DIR, 'cli.json');

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mts': 'video/mp2t',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.heic': 'image/heic',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return undefined;
  return args[i + 1];
}

function fmtBytes(n: number): string {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

async function loadSession(): Promise<Session> {
  try {
    return JSON.parse(await readFile(CONFIG_PATH, 'utf8')) as Session;
  } catch {
    throw new Error(`Not logged in — run: vvup login --url <https://your-vault> --user <name>`);
  }
}

function prompt(question: string, hidden = false): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  if (hidden) {
    const anyRl = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WritableStream };
    const orig = anyRl._writeToOutput.bind(rl);
    anyRl._writeToOutput = (s: string) => {
      if (s.includes(question)) orig(s);
      else anyRl.output.write('*');
    };
  }
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim());
    }),
  );
}

async function collectFiles(paths: string[]): Promise<LocalFile[]> {
  const out: LocalFile[] = [];
  const visit = async (p: string): Promise<void> => {
    const st = await stat(p);
    if (st.isDirectory()) {
      for (const entry of await readdir(p)) {
        if (entry.startsWith('.')) continue;
        await visit(path.join(p, entry));
      }
    } else if (st.isFile() && st.size > 0) {
      const name = path.basename(p);
      out.push({
        path: p,
        name,
        size: st.size,
        mimeType: MIME[path.extname(name).toLowerCase()] ?? 'application/octet-stream',
      });
    }
  };
  for (const p of paths) await visit(p);
  return out;
}

const realPutter: PartPutter = {
  async put(url, file, start, length, ifaceIp) {
    const res = await request(url, {
      method: 'PUT',
      body: createReadStream(file.path, { start, end: start + length - 1 }),
      headers: { 'content-length': String(length) },
      dispatcher: agentFor(ifaceIp),
      headersTimeout: 30_000,
      // A 50 MB part on a slow link takes minutes; never cut the body off.
      bodyTimeout: 0,
    });
    await res.body.dump();
    if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`PUT failed: HTTP ${res.statusCode}`);
    const etag = res.headers.etag;
    const value = Array.isArray(etag) ? etag[0] : etag;
    if (!value) throw new Error('Storage did not return an ETag');
    return { etag: value };
  },
};

async function cmdLogin(args: string[]): Promise<void> {
  const url = flag(args, 'url') ?? (await prompt('Vault URL: '));
  const user = flag(args, 'user') ?? (await prompt('Username: '));
  const password = flag(args, 'password') ?? (await prompt('Password: ', true));
  const session = await login(url.replace(/\/$/, ''), user, password);
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(session, null, 2));
  await chmod(CONFIG_PATH, 0o600);
  console.log(`Logged in to ${session.url} as ${user}. Session saved to ${CONFIG_PATH}`);
}

async function cmdInterfaces(): Promise<void> {
  const session = await loadSession();
  const ifaces = listInterfaces();
  if (ifaces.length === 0) {
    console.log('No usable network interfaces found.');
    return;
  }
  console.log('Probing interfaces against', session.url, '…');
  for (const iface of ifaces) {
    const ok = await probe(session.url, iface.ip);
    console.log(`  ${ok ? '✓' : '✗'} ${iface.name.padEnd(10)} ${iface.ip} ${ok ? '' : '(cannot reach the vault)'}`);
  }
}

async function cmdUpload(args: string[]): Promise<void> {
  const session = await loadSession();
  const api = makeApi(session);

  const paths = args.filter((a, i) => !a.startsWith('--') && (i === 0 || !args[i - 1]!.startsWith('--')));
  if (paths.length === 0) throw new Error('Nothing to upload — pass files or folders');
  const projectName = flag(args, 'project');
  if (!projectName) throw new Error('--project <name> is required');
  const folderName = flag(args, 'folder');
  const perIface = Number(flag(args, 'per-iface') ?? 2);

  const projects = await api.listProjects();
  const project = projects.find(
    (p) => p.name.toLowerCase() === projectName.toLowerCase() || p.slug === projectName.toLowerCase(),
  );
  if (!project) throw new Error(`Project "${projectName}" not found. Available: ${projects.map((p) => p.name).join(', ')}`);

  let folderId: string | null = null;
  if (folderName) {
    const folders = await api.listFolders(project.id);
    const folder = folders.find(
      (f) => f.name.toLowerCase() === folderName.toLowerCase() || f.slug === folderName.toLowerCase(),
    );
    if (!folder) throw new Error(`Folder "${folderName}" not found in ${project.name}. Available: ${folders.map((f) => f.name).join(', ')}`);
    folderId = folder.id;
  }

  const files = await collectFiles(paths);
  if (files.length === 0) throw new Error('No files found at the given paths');
  const totalBytes = files.reduce((s, f) => s + f.size, 0);
  console.log(`Uploading ${files.length} file(s), ${fmtBytes(totalBytes)} → ${project.name}${folderName ? ` / ${folderName}` : ''}`);

  // Bond every interface that can actually reach the vault.
  let ifaceIps: (string | null)[];
  const flagIfaces = flag(args, 'ifaces');
  if (flagIfaces) {
    ifaceIps = flagIfaces.split(',').map((s) => s.trim());
  } else {
    const alive: string[] = [];
    for (const iface of listInterfaces()) {
      if (await probe(session.url, iface.ip)) alive.push(iface.ip);
    }
    ifaceIps = alive.length > 0 ? alive : [null];
  }
  console.log(
    ifaceIps.length > 1
      ? `Bonding ${ifaceIps.length} networks: ${ifaceIps.join(', ')} (${perIface} streams each)`
      : `Using 1 network path (${perIface * 2} streams)`,
  );
  if (ifaceIps.length === 1) ifaceIps = [ifaceIps[0]!, ifaceIps[0]!]; // keep 2 lanes on a single path

  const started = Date.now();
  let lastPrint = 0;
  const summary = await uploadAll(api, realPutter, files, { projectId: project.id, folderId }, ifaceIps, {
    perIface,
    maxAttempts: 5,
    backoffBaseMs: 1000,
    onProgress: (p) => {
      const now = Date.now();
      if (now - lastPrint < 500 && p.bytesDone < p.bytesTotal) return;
      lastPrint = now;
      const pct = p.bytesTotal > 0 ? Math.floor((p.bytesDone / p.bytesTotal) * 100) : 100;
      const speed = p.bytesDone / Math.max(1, (now - started) / 1000);
      const perIfaceStr = [...p.byIface.entries()].map(([ip, b]) => `${ip}:${fmtBytes(b)}`).join(' ');
      process.stdout.write(
        `\r[${p.fileIndex}/${p.fileCount}] ${pct}% · ${fmtBytes(p.bytesDone)}/${fmtBytes(p.bytesTotal)} · ${fmtBytes(speed)}/s · ${perIfaceStr}   `,
      );
    },
  });
  process.stdout.write('\n');

  if (summary.uploaded.length) console.log(`✓ uploaded: ${summary.uploaded.length}`);
  if (summary.adopted.length) console.log(`✓ resumed from another device: ${summary.adopted.length}`);
  if (summary.skipped.length) console.log(`- already uploaded, skipped: ${summary.skipped.length}`);
  for (const f of summary.failed) console.error(`✗ ${f.name}: ${f.error} — re-run to resume from the missing parts`);
  if (summary.failed.length > 0) process.exitCode = 1;
}

const [cmd, ...rest] = process.argv.slice(2);
const run = async () => {
  switch (cmd) {
    case 'login':
      return cmdLogin(rest);
    case 'interfaces':
      return cmdInterfaces();
    case 'upload':
      return cmdUpload(rest);
    default:
      console.log(`vvup — Video Vault bonded uploader

Commands:
  vvup login --url <https://vault> --user <name> [--password <pw>]
  vvup interfaces                              probe which networks can reach the vault
  vvup upload <files/dirs…> --project <name> [--folder <name>] [--ifaces ip1,ip2] [--per-iface 2]

Parts are spread across every reachable network interface (Wi-Fi + tethered
phones + ethernet), adding their bandwidth together. Re-running after any
interruption resumes from the exact missing parts.`);
  }
};

run().catch((err) => {
  console.error(`\nError: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
