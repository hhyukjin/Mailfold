import { chmodSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { parseEnv } from "node:util";
import { accountsFromEnv, applyAccountSettings, LEGACY_PREFIX, type AccountSetting } from "./accounts.js";
import { DuplicateEnvKeyError, findDuplicateEnvKeys, listEnvKeys, parseEnvText } from "./env-file.js";
import type { Providers } from "./providers.js";

/**
 * 이전 .env 형식(MAILFOLD_ACCOUNT_<ID>_<FIELD>)을 새 형식(<PROVIDER><번호>_<FIELD>)으로 바꿉니다.
 *
 * - 원본은 먼저 .env.backup-<타임스탬프>로 복사합니다 (.gitignore의 .env.* 규칙으로 git에서 빠집니다).
 * - 값은 그대로 옮기고, 어디에도 출력하지 않습니다. 결과로는 옛 이름 → 새 ID 매핑만 돌려줍니다.
 * - 번호는 provider별로 .env에 처음 나온 순서대로 매깁니다. 이미 새 형식 계정이 있으면 그 다음 번호부터 씁니다.
 * - 비밀이 아닌 값(NAME, TRASH_FOLDER)은 config/accounts.json으로 옮깁니다. 별칭(alias)은 비워 둡니다.
 * - 새 파일 내용이 새 로더로 정상적으로 읽히는지, 값이 모두 그대로인지 확인한 뒤에만 파일을 씁니다.
 */

const LEGACY_FIELDS = [
  "PROVIDER",
  "EMAIL",
  "USER",
  "PASSWORD",
  "NAME",
  "IMAP_HOST",
  "IMAP_PORT",
  "SMTP_HOST",
  "SMTP_PORT",
  "TRASH_FOLDER",
] as const;
type LegacyField = (typeof LEGACY_FIELDS)[number];

const NEW_KEY_RE = /^([A-Za-z]+)(\d+)_(EMAIL|PASSWORD|LOGIN)$/i;

export class MigrateEnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrateEnvError";
  }
}

export interface MigrationEntry {
  /** 옛 별칭 (소문자, 예: gmail_main) */
  from: string;
  /** 새 계정 ID (예: gmail1) */
  to: string;
  provider: string;
  /** LOGIN 키를 따로 만들었는지 (옛 USER 값이 기본 로그인 규칙과 다를 때) */
  loginKept: boolean;
  /** accounts.json으로 옮긴 비밀이 아닌 항목 이름 */
  movedToAccountsJson: string[];
}

export type MigrationResult =
  | { status: "nothing-to-do" }
  | {
      status: "migrated";
      mapping: MigrationEntry[];
      backupPath: string;
      accountsPath: string;
      /** 계정과 관계없는 키를 몇 개 그대로 두었는지 */
      otherKeysKept: number;
    };

export interface MigrateEnvOptions {
  envPath: string;
  accountsPath: string;
  providers: Providers;
  now?: Date;
}

function timestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 값을 .env 한 줄로 안전하게 씁니다. 쓴 뒤에 다시 읽어 값이 같은지 따로 확인합니다. */
export function formatEnvValue(v: string): string {
  if (v.includes("\n") || v.includes("\r")) throw new MigrateEnvError("여러 줄 값은 자동으로 옮길 수 없습니다");
  if (/^[^\s#"'`\\$=]*$/.test(v)) return v;
  if (!v.includes("'")) return `'${v}'`;
  if (!v.includes('"') && !v.includes("\\")) return `"${v}"`;
  if (!v.includes("`")) return `\`${v}\``;
  throw new MigrateEnvError("따옴표가 여러 종류 섞인 값은 자동으로 옮길 수 없습니다");
}

interface LegacyAccount {
  oldId: string;
  firstLine: number;
  fields: Partial<Record<LegacyField, string>>;
}

export function migrateEnv(opts: MigrateEnvOptions): MigrationResult {
  const { envPath, accountsPath, providers } = opts;
  if (!existsSync(envPath)) throw new MigrateEnvError(`${envPath} 파일이 없습니다.`);
  const text = readFileSync(envPath, "utf8");

  const dups = findDuplicateEnvKeys(text);
  if (dups.length > 0) throw new DuplicateEnvKeyError(envPath, dups);
  const env = parseEnv(text) as Record<string, string>;
  const keyLines = listEnvKeys(text);

  if (!keyLines.some((k) => k.key.startsWith(LEGACY_PREFIX))) return { status: "nothing-to-do" };

  // 1) 옛 키를 계정별로 묶습니다 (파일에 처음 나온 순서 유지).
  const legacy = new Map<string, LegacyAccount>();
  const errors: string[] = [];
  const fieldsByLength = [...LEGACY_FIELDS].sort((a, b) => b.length - a.length);
  for (const { key, line } of keyLines) {
    if (!key.startsWith(LEGACY_PREFIX)) continue;
    const rest = key.slice(LEGACY_PREFIX.length);
    const field = fieldsByLength.find((f) => rest.endsWith(`_${f}`));
    const oldId = field ? rest.slice(0, -(field.length + 1)) : "";
    if (!field || !/^[A-Z0-9_]+$/.test(oldId)) {
      errors.push(`${key}: 옛 형식으로 해석할 수 없는 키입니다`);
      continue;
    }
    const acc = legacy.get(oldId) ?? { oldId, firstLine: line, fields: {} };
    acc.fields[field] = env[key];
    legacy.set(oldId, acc);
  }

  // 2) 이미 새 형식으로 있는 계정 번호를 피합니다.
  const nextNumber = new Map<string, number>();
  const otherKeys: string[] = [];
  const existingNew = new Map<string, string[]>(); // provider → 키 목록 (파일 순서)
  for (const { key } of keyLines) {
    if (key.startsWith(LEGACY_PREFIX)) continue;
    const m = NEW_KEY_RE.exec(key);
    const provider = m?.[1]?.toLowerCase();
    if (m && provider && Object.hasOwn(providers, provider)) {
      nextNumber.set(provider, Math.max(nextNumber.get(provider) ?? 1, Number(m[2]) + 1));
      existingNew.set(provider, [...(existingNew.get(provider) ?? []), key]);
    } else {
      otherKeys.push(key);
    }
  }

  // 3) 계정마다 새 ID를 정합니다.
  const ordered = [...legacy.values()].sort((a, b) => a.firstLine - b.firstLine);
  const mapping: MigrationEntry[] = [];
  const newLines = new Map<string, string[]>(); // provider → "KEY=value" 줄
  const expected: Record<string, string> = {};
  const settings: Record<string, AccountSetting> = {};

  for (const acc of ordered) {
    const name = acc.oldId.toLowerCase();
    const f = acc.fields;
    const provider = f.PROVIDER?.trim().toLowerCase();
    if (!provider) {
      errors.push(`${LEGACY_PREFIX}${acc.oldId}_PROVIDER가 없어 어느 메일 서버인지 알 수 없습니다`);
      continue;
    }
    if (!Object.hasOwn(providers, provider)) {
      errors.push(
        `${name}: provider "${provider}"가 config/providers.json에 없습니다. 서버 정의를 먼저 추가한 뒤 다시 실행하세요.`,
      );
      continue;
    }
    const custom = (["IMAP_HOST", "IMAP_PORT", "SMTP_HOST", "SMTP_PORT"] as const).filter((k) => f[k] !== undefined);
    if (custom.length > 0) {
      errors.push(
        `${name}: 서버 주소(${custom.join(", ")})를 직접 지정한 계정은 자동으로 옮길 수 없습니다. ` +
          `config/providers.json에 서버를 추가한 뒤 손으로 옮겨 주세요.`,
      );
      continue;
    }
    if (!f.EMAIL || !f.PASSWORD) {
      errors.push(`${name}: EMAIL 또는 PASSWORD가 없습니다`);
      continue;
    }

    const n = nextNumber.get(provider) ?? 1;
    nextNumber.set(provider, n + 1);
    const id = `${provider}${n}`;
    const prefix = id.toUpperCase();
    const def = providers[provider]!;
    const defaultLogin = def.login === "localpart" ? f.EMAIL.trim().split("@")[0] : f.EMAIL.trim();
    const user = f.USER?.trim();
    const loginKept = !!user && user !== defaultLogin;

    const lines = newLines.get(provider) ?? [];
    const put = (field: string, value: string) => {
      lines.push(`${prefix}_${field}=${formatEnvValue(value)}`);
      expected[`${prefix}_${field}`] = value;
    };
    put("EMAIL", f.EMAIL);
    put("PASSWORD", f.PASSWORD);
    if (loginKept) put("LOGIN", f.USER!);
    newLines.set(provider, lines);

    const moved: string[] = [];
    if (f.NAME?.trim()) moved.push("NAME→displayName");
    if (f.TRASH_FOLDER?.trim()) moved.push("TRASH_FOLDER→trashFolder");
    settings[id] = {
      alias: undefined,
      displayName: f.NAME?.trim() || undefined,
      trashFolder: f.TRASH_FOLDER?.trim() || undefined,
    };
    mapping.push({ from: name, to: id, provider, loginKept, movedToAccountsJson: moved });
  }

  if (errors.length > 0) throw new MigrateEnvError(`옮기지 않았습니다 (파일은 그대로입니다):\n  - ${errors.join("\n  - ")}`);
  if (existsSync(accountsPath)) {
    throw new MigrateEnvError(
      `${accountsPath}가 이미 있어 덮어쓰지 않았습니다 (파일은 그대로입니다). 다른 이름으로 옮겨 둔 뒤 다시 실행하세요.`,
    );
  }

  // 4) 새 .env 내용을 만듭니다. 서버별 구분 주석을 두고, 이미 있던 새 형식 키와 기타 키는 값을 그대로 둡니다.
  const out: string[] = [
    "# Mailfold 비밀 값 (앱 비밀번호). git에 올라가지 않습니다.",
    "# 형식: <서버><번호>_EMAIL, <서버><번호>_PASSWORD, 선택 <서버><번호>_LOGIN",
    `# ${basename(envPath)}를 migrate-env가 ${new Date(opts.now ?? Date.now()).toISOString()}에 새 형식으로 바꿨습니다.`,
    "",
  ];
  for (const [provider, def] of Object.entries(providers)) {
    const kept = existingNew.get(provider) ?? [];
    const added = newLines.get(provider) ?? [];
    if (kept.length === 0 && added.length === 0) continue;
    out.push(`# ===== ${def.label} =====`);
    for (const key of kept) {
      out.push(`${key}=${formatEnvValue(env[key]!)}`);
      expected[key] = env[key]!;
    }
    out.push(...added, "");
  }
  if (otherKeys.length > 0) {
    out.push("# ===== 기타 =====");
    for (const key of otherKeys) {
      out.push(`${key}=${formatEnvValue(env[key]!)}`);
      expected[key] = env[key]!;
    }
    out.push("");
  }
  const newText = out.join("\n");

  // 5) 쓰기 전에 확인: 값이 모두 그대로인지, 새 로더로 계정이 모두 읽히는지.
  const reparsed = parseEnvText(newText, "새 .env");
  const changed = Object.keys(expected).filter((k) => reparsed[k] !== expected[k]);
  const extra = Object.keys(reparsed).filter((k) => !(k in expected));
  if (changed.length > 0 || extra.length > 0) {
    throw new MigrateEnvError(`새 .env를 다시 읽었을 때 값이 달라지는 키가 있어 중단했습니다: ${[...changed, ...extra].join(", ")}`);
  }
  const loaded = applyAccountSettings(accountsFromEnv(reparsed, providers), settings, "새 accounts.json");
  const missing = mapping.filter((m) => !loaded.some((a) => a.id === m.to));
  if (missing.length > 0) throw new MigrateEnvError(`새 형식으로 읽히지 않는 계정이 있어 중단했습니다: ${missing.map((m) => m.to).join(", ")}`);

  // 6) 백업 → 새 .env → accounts.json 순서로 씁니다.
  let backupPath = `${envPath}.backup-${timestamp(opts.now ?? new Date())}`;
  for (let i = 2; existsSync(backupPath); i++) backupPath = `${envPath}.backup-${timestamp(opts.now ?? new Date())}-${i}`;
  copyFileSync(envPath, backupPath, constants.COPYFILE_EXCL);
  chmodSync(backupPath, 0o600);

  writeFileSync(envPath, newText, { mode: 0o600 });
  chmodSync(envPath, 0o600);

  const json: Record<string, { alias: null; displayName: string | null; trashFolder: string | null }> = {};
  for (const m of mapping) {
    const s = settings[m.to]!;
    json[m.to] = { alias: null, displayName: s.displayName ?? null, trashFolder: s.trashFolder ?? null };
  }
  mkdirSync(dirname(accountsPath), { recursive: true });
  writeFileSync(accountsPath, JSON.stringify(json, null, 2) + "\n", { flag: "wx" });

  return { status: "migrated", mapping, backupPath, accountsPath, otherKeysKept: otherKeys.length };
}
