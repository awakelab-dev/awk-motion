import { parentPort, workerData } from 'node:worker_threads';
import { flattenPngFile, type FlattenOptions } from './flatten.js';

/** Hilo aparte para «Colores planos» (ADR-137): alisa un PNG y responde con las cifras. */
const { path, opts } = workerData as { path: string; opts?: FlattenOptions };
flattenPngFile(path, opts).then(
  (stats) => parentPort!.postMessage({ stats }),
  (e: Error) => parentPort!.postMessage({ error: e.message }),
);
