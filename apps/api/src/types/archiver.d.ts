// Tipos mínimos de archiver 8 (ESM, sin tipos publicados): solo lo que usa la descarga ZIP.
declare module 'archiver' {
  import type { Writable } from 'node:stream';
  interface EntryData {
    name: string;
    /** true = sin comprimir (los mp4/png ya lo están). */
    store?: boolean;
    date?: Date;
  }
  export class ZipArchive {
    constructor(options?: { zlib?: { level?: number }; store?: boolean; comment?: string });
    pipe<T extends Writable>(dest: T): T;
    file(path: string, data: EntryData): this;
    append(source: string | Buffer, data: EntryData): this;
    finalize(): Promise<void>;
    abort(): this;
    pointer(): number;
    on(event: 'error' | 'warning', fn: (err: Error & { code?: string }) => void): this;
  }
}
