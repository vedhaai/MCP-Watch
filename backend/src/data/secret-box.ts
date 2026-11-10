import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FILE_MODE } from "./json-files.js";

const PREFIX = "enc:v1:";

// Encrypts the secrets kept in the data files (project keys, AI provider keys) with AES-256-GCM, so
// projects.json alone (a backup, a copied folder, a stray commit) doesn't give them away.
//
// The encryption key is MCPWATCH_DATA_KEY if set (keep it out of the data directory to make the files
// useless without it), else a random one generated once into `secret.key` in the data directory. In that
// second case it protects the file on its own, not against whoever can read the whole directory.
export class SecretBox {
  private readonly key: Buffer;
  readonly external: boolean;

  constructor(dir: string, env: NodeJS.ProcessEnv = process.env) {
    this.external = !!env.MCPWATCH_DATA_KEY;
    if (env.MCPWATCH_DATA_KEY) {
      this.key = scryptSync(env.MCPWATCH_DATA_KEY, "mcpwatch-data-key", 32);
      return;
    }
    const file = path.join(dir, "secret.key");
    if (existsSync(file)) {
      this.key = Buffer.from(readFileSync(file, "utf8").trim(), "hex");
      if (this.key.length !== 32) throw new Error(`${file} is damaged: delete it only if no project data needs it`);
    } else {
      this.key = randomBytes(32);
      writeFileSync(file, this.key.toString("hex"), { mode: FILE_MODE });
    }
  }

  isSealed(text: string): boolean {
    return text.startsWith(PREFIX);
  }

  seal(plain: string): string {
    if (!plain || this.isSealed(plain)) return plain;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return `${PREFIX}${[iv, cipher.getAuthTag(), body].map((b) => b.toString("base64url")).join(".")}`;
  }

  // Text that was never sealed (written by an older version) comes back as it is.
  open(text: string): string {
    if (!this.isSealed(text)) return text;
    try {
      const [iv, tag, body] = text.slice(PREFIX.length).split(".").map((s) => Buffer.from(s, "base64url"));
      const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
    } catch {
      throw new Error("could not decrypt the project keys: wrong MCPWATCH_DATA_KEY, or secret.key is missing");
    }
  }
}
