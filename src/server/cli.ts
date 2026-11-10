// User management from the command line:
//   npm run user -- create <username> [--admin] [--name "Display Name"]
//   npm run user -- password <username>
//   npm run user -- list
//   npm run user -- delete <username>
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { openDb } from "./db.js";
import { createUser, deleteUserSessions, setPassword, type Role } from "./auth.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, "data"));
const db = openDb(path.join(DATA_DIR, "pulse.db"));

/** Reads a password without echoing it (or from stdin when piped). */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
    const out = rl as unknown as { _writeToOutput?: (s: string) => void };
    process.stdout.write(question);
    if (process.stdin.isTTY) out._writeToOutput = () => {};
    rl.question("", (answer) => {
      rl.close();
      if (process.stdin.isTTY) process.stdout.write("\n");
      resolve(answer);
    });
  });
}

async function askNewPassword(): Promise<string> {
  const pw = await promptHidden("Password (min 10 chars): ");
  if (process.stdin.isTTY) {
    const again = await promptHidden("Repeat password: ");
    if (pw !== again) throw new Error("Passwords don't match.");
  }
  return pw;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function findUser(username: string | undefined): { id: number; username: string } {
  if (!username) throw new Error("Username required.");
  const row = db.prepare("SELECT id, username FROM users WHERE username = ?").get(username) as { id: number; username: string } | undefined;
  if (!row) throw new Error(`No user named "${username}".`);
  return row;
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "create": {
      const username = args[0];
      if (!username || username.startsWith("--")) throw new Error("Usage: create <username> [--admin] [--name \"Display Name\"]");
      const role: Role = args.includes("--admin") ? "admin" : "author";
      const password = await askNewPassword();
      const user = await createUser(db, { username, password, displayName: flag(args, "--name"), role });
      console.log(`Created ${user.role} "${user.username}".`);
      break;
    }
    case "password": {
      const user = findUser(args[0]);
      await setPassword(db, user.id, await askNewPassword());
      deleteUserSessions(db, user.id);
      console.log(`Password updated for "${user.username}". Existing sessions were signed out.`);
      break;
    }
    case "list": {
      const rows = db.prepare("SELECT username, display_name, role, created_at FROM users ORDER BY id").all() as {
        username: string; display_name: string; role: string; created_at: number;
      }[];
      if (!rows.length) console.log("No users yet.");
      for (const r of rows) console.log(`${r.username.padEnd(20)} ${r.role.padEnd(7)} ${r.display_name}  (since ${new Date(r.created_at).toISOString().slice(0, 10)})`);
      break;
    }
    case "delete": {
      const user = findUser(args[0]);
      db.prepare("DELETE FROM users WHERE id = ?").run(user.id);
      console.log(`Deleted "${user.username}". Their articles remain, without an author.`);
      break;
    }
    default:
      console.log("Commands: create <username> [--admin] [--name \"Name\"] | password <username> | list | delete <username>");
      process.exitCode = cmd ? 1 : 0;
  }
}

main().catch((err: Error) => {
  console.error(`Error: ${err.message}`);
  process.exitCode = 1;
}).finally(() => db.close());
