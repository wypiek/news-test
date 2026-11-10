import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

const TYPES = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
} as const;
type Ext = keyof typeof TYPES;

const NAME = /^([a-f0-9]{32})\.(jpg|png|webp|gif)$/;

/**
 * Detects the image type from its magic bytes. The client-declared
 * Content-Type is never trusted, and anything that isn't a known raster
 * image (SVG, HTML, …) is rejected.
 */
export function sniffImage(buf: Buffer): Ext | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  const head6 = buf.subarray(0, 6).toString("latin1");
  if (head6 === "GIF87a" || head6 === "GIF89a") return "gif";
  if (buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  return null;
}

export class Uploads {
  constructor(private readonly dir: string) {}

  async save(buf: Buffer): Promise<string | null> {
    const ext = sniffImage(buf);
    if (!ext) return null;
    await mkdir(this.dir, { recursive: true });
    const name = `${randomBytes(16).toString("hex")}.${ext}`;
    await writeFile(path.join(this.dir, name), buf, { flag: "wx", mode: 0o640 });
    return `/uploads/${name}`;
  }

  /** Reads an upload by its file name. Only names we generate are accepted, so paths can't escape the folder. */
  async read(name: string): Promise<{ body: Buffer; type: string } | null> {
    const m = NAME.exec(name);
    if (!m) return null;
    try {
      const body = await readFile(path.join(this.dir, name));
      return { body, type: TYPES[m[2] as Ext] };
    } catch {
      return null;
    }
  }
}
