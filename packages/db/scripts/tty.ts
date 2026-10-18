import { createInterface } from 'node:readline/promises';

/** Pregunta visible (una línea). */
export async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** Pregunta oculta (no muestra lo que se escribe): para contraseñas. */
export function askHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return Promise.reject(new Error('Ejecuta este comando en una terminal interactiva (hace falta escribir la contraseña).'));
  return new Promise((resolve) => {
    process.stdout.write(question);
    let buf = '';
    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    const onData = (chunk: string) => {
      for (const c of chunk) {
        if (c === '\r' || c === '\n' || c === '\u0004') {
          cleanup();
          process.stdout.write('\n');
          resolve(buf);
          return;
        }
        if (c === '\u0003') {
          cleanup();
          process.stdout.write('\nCancelado.\n');
          process.exit(130);
        }
        if (c === '\u007f' || c === '\b') buf = buf.slice(0, -1);
        else buf += c;
      }
    };
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    stdin.on('data', onData);
  });
}
