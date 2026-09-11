import os from 'node:os';
import { Agent, request } from 'undici';

export interface Iface {
  name: string;
  ip: string;
}

/** All non-internal IPv4 interfaces — candidates for bonded uploading. */
export function listInterfaces(): Iface[] {
  const out: Iface[] = [];
  const all = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(all)) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, ip: a.address });
    }
  }
  return out;
}

const agents = new Map<string, Agent>();

/** Dispatcher whose connections are bound to one local interface address. */
export function agentFor(ip: string | null): Agent {
  const key = ip ?? '(default)';
  let agent = agents.get(key);
  if (!agent) {
    // Per-request timeouts are set at the call sites; the agent only pins
    // the local interface address. undici forwards connect options straight
    // to net.connect, where localAddress selects the outbound interface —
    // its published option type just doesn't name the field, hence the cast.
    agent = ip
      ? new Agent({ connect: { localAddress: ip } as unknown as Agent.Options['connect'] })
      : new Agent();
    agents.set(key, agent);
  }
  return agent;
}

/** True when this interface can actually reach the server. */
export async function probe(baseUrl: string, ip: string): Promise<boolean> {
  try {
    const res = await request(new URL('/api/health', baseUrl), {
      dispatcher: agentFor(ip),
      headersTimeout: 5_000,
    });
    await res.body.dump();
    return res.statusCode === 200;
  } catch {
    return false;
  }
}
