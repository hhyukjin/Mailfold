import { z } from "zod";
import type { ProviderStrategy, Providers, ServerEndpoint } from "./providers.js";

/**
 * 계정 설정.
 *
 * 세 곳에서 모읍니다 (0~3단계, 로컬 파일 방식. 4단계부터는 암호화된 저장소로 바뀝니다 → source.ts).
 * - config/providers.json : 메일 서버 정의 (git에 올림)
 * - .env                  : 계정별 이메일과 앱 비밀번호 (git 제외)
 *                           <PROVIDER><번호>_EMAIL, <PROVIDER><번호>_PASSWORD, 선택 <PROVIDER><번호>_LOGIN
 *                           예) GMAIL1_EMAIL, NAVER2_PASSWORD → 계정 ID gmail1, naver2
 * - config/accounts.json  : 계정별 개인 설정 (별칭, 보내는 사람 이름, 휴지통 폴더). 없어도 됩니다 (git 제외)
 */

export type { ServerEndpoint } from "./providers.js";

export interface AccountConfig {
  /** 계정 ID. .env 키에서 정해지며 소문자입니다 (예: gmail1, naver2). */
  id: string;
  /** providers.json의 키 (예: gmail, naver) */
  provider: string;
  /** providers.json의 label (예: Gmail, 네이버) */
  providerLabel: string;
  strategy: ProviderStrategy;
  email: string;
  /** 사용자가 붙인 별칭 (예: "개인 네이버"). ID 대신 이 이름으로도 계정을 가리킬 수 있습니다. */
  alias?: string;
  /** 표시 이름 (발송 시 From 이름) */
  name?: string;
  /** IMAP/SMTP 로그인 아이디 */
  user: string;
  /** 앱 비밀번호. 로그나 tool 응답에 절대 내보내지 않습니다. */
  password: string;
  imap: ServerEndpoint;
  smtp: ServerEndpoint;
  /** 서버가 휴지통(\Trash)을 알려 주지 않을 때 쓸 폴더 경로 (probe로 확인한 뒤 지정) */
  trashFolder?: string;
  /** 테스트 전용: 자체 서명 인증서를 허용합니다. 설정 파일로는 켤 수 없습니다. */
  insecureTls?: boolean;
}

export class AccountConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountConfigError";
  }
}

// ───────────────────────── .env 키 해석 ─────────────────────────

export const ACCOUNT_FIELDS = ["EMAIL", "PASSWORD", "LOGIN"] as const;
type AccountField = (typeof ACCOUNT_FIELDS)[number];

/** 이전 형식(MAILFOLD_ACCOUNT_<ID>_...)의 접두어 */
export const LEGACY_PREFIX = "MAILFOLD_ACCOUNT_";

/** <영문><숫자>_<필드> 모양. 예: GMAIL1_EMAIL */
const ACCOUNT_KEY_RE = /^([A-Za-z]+)(\d+)_([A-Za-z0-9_]+)$/;

interface RawEnvAccount {
  provider: string;
  number: number;
  fields: Partial<Record<AccountField, string>>;
}

/**
 * env에서 계정 키만 골라 계정별로 묶습니다.
 * - 무관한 변수(PATH, NODE_ENV, 번호 없는 키, 모양이 다른 키)는 무시합니다.
 * - provider가 providers.json에 없거나(필드는 EMAIL/PASSWORD/LOGIN) 필드 이름이 틀리면 키 이름을 담은 오류를 냅니다.
 *   오류에는 값이 절대 들어가지 않습니다.
 */
function groupEnvAccounts(env: Record<string, string | undefined>, providers: Providers) {
  const grouped = new Map<string, RawEnvAccount>();
  const errors: string[] = [];
  const legacy: string[] = [];
  const known = Object.keys(providers);

  for (const key of Object.keys(env).sort()) {
    const value = env[key];
    if (value === undefined) continue;
    if (key.startsWith(LEGACY_PREFIX)) {
      legacy.push(key);
      continue;
    }
    const m = ACCOUNT_KEY_RE.exec(key);
    if (!m) continue;
    const providerPart = m[1]!.toLowerCase();
    const numberPart = m[2]!;
    const fieldPart = m[3]!.toUpperCase();
    const isAccountField = (ACCOUNT_FIELDS as readonly string[]).includes(fieldPart);
    const isKnownProvider = Object.hasOwn(providers, providerPart);

    // 둘 다 아니면 Mailfold와 무관한 변수로 봅니다 (예: HTTP2_PROXY).
    if (!isAccountField && !isKnownProvider) continue;
    if (!isKnownProvider) {
      errors.push(`${key}: "${m[1]}"는 config/providers.json에 없는 메일 서버입니다 (있는 서버: ${known.join(", ")})`);
      continue;
    }
    if (!isAccountField) {
      errors.push(`${key}: 알 수 없는 필드 이름입니다 (쓸 수 있는 필드: ${ACCOUNT_FIELDS.join(", ")})`);
      continue;
    }
    if (!/^[1-9]\d*$/.test(numberPart)) {
      errors.push(`${key}: 계정 번호는 1부터 시작하고 앞에 0을 붙이지 않습니다 (예: ${m[1]}1_${fieldPart})`);
      continue;
    }

    const id = `${providerPart}${numberPart}`;
    const entry = grouped.get(id) ?? { provider: providerPart, number: Number(numberPart), fields: {} };
    if (entry.fields[fieldPart as AccountField] !== undefined) {
      // GMAIL1_EMAIL과 gmail1_email처럼 대소문자만 다른 키가 함께 있는 경우
      errors.push(`${key}: 계정 ${id}의 ${fieldPart}가 다른 키로 이미 지정되어 있습니다`);
      continue;
    }
    entry.fields[fieldPart as AccountField] = value.trim();
    grouped.set(id, entry);
  }

  return { grouped, errors, legacy };
}

export class LegacyEnvFormatError extends AccountConfigError {
  constructor(public readonly keys: string[]) {
    const shown = keys.slice(0, 5).join(", ") + (keys.length > 5 ? ` 외 ${keys.length - 5}개` : "");
    super(
      `.env에 이전 형식(MAILFOLD_ACCOUNT_...)의 키가 남아 있습니다: ${shown}\n` +
        `npm run migrate-env 를 실행하면 원본을 백업한 뒤 새 형식(GMAIL1_EMAIL 등)으로 바꿉니다.`,
    );
    this.name = "LegacyEnvFormatError";
  }
}

function loginFor(rule: "email" | "localpart", email: string): string {
  if (rule === "localpart") return email.split("@")[0]!;
  return email;
}

const EmailSchema = z.string().email();

/** env와 providers.json으로 계정 목록을 만듭니다 (accounts.json의 개인 설정은 applyAccountSettings에서 더합니다). */
export function accountsFromEnv(env: Record<string, string | undefined>, providers: Providers): AccountConfig[] {
  const { grouped, errors, legacy } = groupEnvAccounts(env, providers);
  if (legacy.length > 0) throw new LegacyEnvFormatError(legacy);

  const accounts: AccountConfig[] = [];
  const ordered = [...grouped.entries()].sort(
    ([, a], [, b]) => a.provider.localeCompare(b.provider) || a.number - b.number,
  );

  for (const [id, raw] of ordered) {
    const prefix = id.toUpperCase();
    const missing: string[] = [];
    const { EMAIL: email, PASSWORD: password, LOGIN: login } = raw.fields;
    if (!email) missing.push(`${prefix}_EMAIL`);
    else if (!EmailSchema.safeParse(email).success) missing.push(`${prefix}_EMAIL(이메일 형식이 아님)`);
    if (!password) missing.push(`${prefix}_PASSWORD`);
    if (login !== undefined && login === "") missing.push(`${prefix}_LOGIN(빈 값)`);
    if (missing.length > 0) {
      errors.push(`${id}: 값이 없거나 형식이 틀린 항목 → ${missing.join(", ")}`);
      continue;
    }

    const def = providers[raw.provider]!;
    accounts.push({
      id,
      provider: raw.provider,
      providerLabel: def.label,
      strategy: def.strategy,
      email: email!,
      user: login ?? loginFor(def.login, email!),
      // Google 앱 비밀번호는 "abcd efgh ..."처럼 공백이 섞여 보이므로 제거합니다.
      password: password!.replace(/\s+/g, ""),
      imap: { ...def.imap },
      smtp: { ...def.smtp },
    });
  }

  if (errors.length > 0) throw new AccountConfigError(`계정 설정 오류:\n  - ${errors.join("\n  - ")}`);
  return accounts;
}

// ───────────────────────── accounts.json (개인 설정) ─────────────────────────

const OptionalText = z
  .string()
  .nullish()
  .transform((v) => (v == null || v.trim() === "" ? undefined : v.trim()));

export const AccountSettingSchema = z
  .object({
    /** 별칭 (예: "개인 네이버"). 계정끼리 겹치면 안 됩니다. */
    alias: OptionalText,
    /** 보내는 사람 이름 */
    displayName: OptionalText,
    /** 휴지통 폴더 경로 (서버가 \Trash를 알려 주지 않을 때만 필요) */
    trashFolder: OptionalText,
  })
  .strict();
export type AccountSetting = z.infer<typeof AccountSettingSchema>;

export const AccountSettingsSchema = z.record(z.string(), AccountSettingSchema);
export type AccountSettings = z.infer<typeof AccountSettingsSchema>;

export function parseAccountSettings(input: unknown, source = "config/accounts.json"): AccountSettings {
  let data = input;
  if (typeof input === "string") {
    try {
      data = JSON.parse(input);
    } catch (e) {
      throw new AccountConfigError(`${source}가 올바른 JSON이 아닙니다: ${(e as Error).message}`);
    }
  }
  const parsed = AccountSettingsSchema.safeParse(data);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.length > 0 ? i.path.join(".") : "(전체)"}: ${i.message}`)
      .join("\n  - ");
    throw new AccountConfigError(`${source} 형식 오류:\n  - ${detail}`);
  }
  return parsed.data;
}

/** accounts.json의 개인 설정을 계정에 더합니다. 없는 계정 ID, 겹치는 별칭은 오류입니다. */
export function applyAccountSettings(
  accounts: AccountConfig[],
  settings: AccountSettings,
  source = "config/accounts.json",
): AccountConfig[] {
  const errors: string[] = [];
  const byId = new Map(accounts.map((a) => [a.id, a]));

  for (const id of Object.keys(settings)) {
    if (!byId.has(id)) {
      errors.push(
        `"${id}": .env에 없는 계정 ID입니다 (있는 계정: ${accounts.map((a) => a.id).join(", ") || "없음"}). ` +
          `ID는 소문자로 적습니다 (예: GMAIL1_EMAIL → gmail1).`,
      );
    }
  }

  const aliasOwner = new Map<string, string>();
  for (const [id, s] of Object.entries(settings)) {
    if (!s.alias || !byId.has(id)) continue;
    const key = s.alias.toLowerCase();
    const other = aliasOwner.get(key);
    if (other) errors.push(`별칭 "${s.alias}"가 ${other}와 ${id}에 함께 쓰였습니다. 별칭은 계정마다 달라야 합니다.`);
    else if (byId.has(key) && key !== id) errors.push(`${id}의 별칭 "${s.alias}"가 다른 계정 ID와 같습니다.`);
    else aliasOwner.set(key, id);
  }

  if (errors.length > 0) throw new AccountConfigError(`${source} 오류:\n  - ${errors.join("\n  - ")}`);

  return accounts.map((a) => {
    const s = settings[a.id];
    if (!s) return a;
    return {
      ...a,
      ...(s.alias ? { alias: s.alias } : {}),
      ...(s.displayName ? { name: s.displayName } : {}),
      ...(s.trashFolder ? { trashFolder: s.trashFolder } : {}),
    };
  });
}

// ───────────────────────── 조회, 출력 ─────────────────────────

/** 계정 ID나 별칭으로 계정을 찾습니다 (대소문자 무시). 없으면 있는 이름을 안내하는 오류를 냅니다. */
export function resolveAccount(accounts: AccountConfig[], name: string): AccountConfig {
  const q = name.trim().toLowerCase();
  const found = accounts.find((a) => a.id === q) ?? accounts.find((a) => a.alias?.toLowerCase() === q);
  if (found) return found;
  const names = accounts.map((a) => (a.alias ? `${a.id}(${a.alias})` : a.id)).join(", ");
  throw new AccountConfigError(`"${name}" 계정을 찾을 수 없습니다. 있는 계정: ${names || "없음"}`);
}

/** 로그·출력용: 비밀번호를 뺀 계정 정보 */
export function describeAccount(a: AccountConfig) {
  return {
    id: a.id,
    ...(a.alias ? { alias: a.alias } : {}),
    provider: a.provider,
    email: a.email,
    user: a.user,
    imap: `${a.imap.host}:${a.imap.port}`,
    smtp: `${a.smtp.host}:${a.smtp.port}`,
  };
}
