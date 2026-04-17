import { exec } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, unlink, access, constants } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const run = promisify(exec);

// --- types ---

export type device = {
  name: string;
  usb: boolean;
  def: boolean;
  stat: string;
};

export type config = {
  copies?: number;
  media?: string;
  fit?: boolean;
  gray?: boolean;
  flags?: Record<string, string>;
};

// --- internals ---

const file = async <T>(
  buffer: Buffer,
  fn: (path: string) => Promise<T>
): Promise<T> => {
  const path = join(tmpdir(), `sticker-${randomUUID()}.png`);
  await writeFile(path, buffer);
  try {
    return await fn(path);
  } finally {
    unlink(path).catch(() => {});
  }
};

const parse = (list: string, devices: string): device[] => {
  const lines = devices.split("\n");
  const fallback = list.match(/system default destination: (.+)/)?.[1];

  return list
    .split("\n")
    .map((line) => line.match(/printer (.+?) (.*)/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map(([, name, stat]) => {
      const dev = lines.find((d) => d.includes(name));
      return {
        name,
        stat,
        usb: dev?.toLowerCase().includes("usb") ?? false,
        def: name === fallback,
      };
    });
};

// --- module ---

export default function thermal() {
  const scan = async (): Promise<device[]> => {
    try {
      const [ls, devs] = await Promise.all([
        run("lpstat -p -d"),
        run("lpstat -v"),
      ]);
      return parse(ls.stdout, devs.stdout);
    } catch {
      return [];
    }
  };

  const find = async (): Promise<device | null> => {
    const devs = await scan();
    return (
      devs.find((d) => d.usb && d.def) ||
      devs.find((d) => d.usb) ||
      null
    );
  };

  const fix = async (name: string): Promise<void> => {
    const { stdout } = await run(`lpstat -p "${name}"`);
    const bad = ["disabled", "paused"].some((s) =>
      stdout.toLowerCase().includes(s)
    );

    if (bad) {
      await Promise.all([
        run(`cupsenable "${name}"`),
        run(`cupsaccept "${name}"`),
      ]);
      console.log(`✨ healed: ${name}`);
    }
  };

  const print = async (
    target: string,
    input: Buffer | string,
    opts: config = {}
  ) => {
    const task = async (path: string) => {
      const args = [
        `-d "${target}"`,
        opts.copies && `-n ${opts.copies}`,
        opts.media && `-o media=${opts.media}`,
        opts.gray && "-o ColorModel=Gray",
        opts.fit && "-o fit-to-page",
        ...Object.entries(opts.flags || {}).map(([k, v]) => `-o ${k}=${v}`),
        `"${path}"`,
      ].filter(Boolean);

      const { stdout } = await run(`lp ${args.join(" ")}`);
      return stdout.match(/request id is .+-(\d+)/)?.[1] || "unknown";
    };

    if (Buffer.isBuffer(input)) {
      return file(input, task);
    }
    await access(input, constants.R_OK);
    return task(input);
  };

  const watch = async (signal: AbortSignal, delay = 2000) => {
    const tick = async () => {
      if (signal.aborted) return;

      const devs = await scan();
      const usb = devs.filter((d) => d.usb);
      await Promise.all(usb.map((d) => fix(d.name)));

      if (!signal.aborted) setTimeout(tick, delay);
    };
    tick();
  };

  return { scan, find, fix, print, watch };
}
