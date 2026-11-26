import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatEnvValue, migrateEnv, MigrateEnvError } from "../../src/config/migrate-env.js";
import { parseProviders } from "../../src/config/providers.js";
import { FileConfigSource } from "../../src/config/source.js";

const providers = parseProviders(readFileSync("config/providers.json", "utf8"));
const NOW = new Date(2026, 10, 26, 15, 30, 5);

// 실제 사용자 .env와 같은 모양의 가짜 파일 (값은 모두 가짜)
const LEGACY = `# Mailfold 계정 설정 예시
MAILFOLD_ACCOUNT_GMAIL_MAIN_PROVIDER=gmail
MAILFOLD_ACCOUNT_GMAIL_MAIN_EMAIL=main@gmail.com
MAILFOLD_ACCOUNT_GMAIL_MAIN_PASSWORD=aaaa bbbb cccc dddd

MAILFOLD_ACCOUNT_GMAIL_SUB_PROVIDER=gmail
MAILFOLD_ACCOUNT_GMAIL_SUB_EMAIL=sub@gmail.com
MAILFOLD_ACCOUNT_GMAIL_SUB_PASSWORD="eeee ffff gggg hhhh"

MAILFOLD_ACCOUNT_GMAIL_SCHOOL_PROVIDER=gmail
MAILFOLD_ACCOUNT_GMAIL_SCHOOL_EMAIL=me@school.ac.kr
MAILFOLD_ACCOUNT_GMAIL_SCHOOL_PASSWORD=iiiijjjjkkkkllll
MAILFOLD_ACCOUNT_GMAIL_SCHOOL_NAME=홍길동

MAILFOLD_ACCOUNT_NAVER_PROVIDER=naver
MAILFOLD_ACCOUNT_NAVER_EMAIL=first@naver.com
#MAILFOLD_ACCOUNT_NAVER_USER=first@naver.com
MAILFOLD_ACCOUNT_NAVER_PASSWORD='naver#pw one'

MAILFOLD_ACCOUNT_NAVER2_PROVIDER=naver
MAILFOLD_ACCOUNT_NAVER2_EMAIL=second@naver.com
MAILFOLD_ACCOUNT_NAVER2_USER=second@naver.com
MAILFOLD_ACCOUNT_NAVER2_PASSWORD=naverpw2
MAILFOLD_ACCOUNT_NAVER2_TRASH_FOLDER=휴지통
# MAILFOLD_ACCOUNT_OTHER_PROVIDER=imap
SOME_OTHER_SETTING=keep me
`;

const SECRETS = ["aaaa bbbb cccc dddd", "eeee ffff gggg hhhh", "iiiijjjjkkkkllll", "naver#pw one", "naverpw2"];

let dir: string;
let envPath: string;
let accountsPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mailfold-migrate-"));
  mkdirSync(join(dir, "config"));
  writeFileSync(join(dir, "config", "providers.json"), JSON.stringify(providers));
  envPath = join(dir, ".env");
  accountsPath = join(dir, "config", "accounts.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("migrateEnv: 이전 .env 형식 → 새 형식", () => {
  it("원본을 백업하고, provider별로 파일 순서대로 번호를 매기고, 값을 그대로 옮긴다", async () => {
    writeFileSync(envPath, LEGACY);
    const r = migrateEnv({ envPath, accountsPath, providers, now: NOW });
    if (r.status !== "migrated") throw new Error("migrated여야 합니다");

    // 매핑
    expect(r.mapping.map((m) => [m.from, m.to])).toEqual([
      ["gmail_main", "gmail1"],
      ["gmail_sub", "gmail2"],
      ["gmail_school", "gmail3"],
      ["naver", "naver1"],
      ["naver2", "naver2"],
    ]);

    // 백업: 원본과 같고, 이름이 .env.backup-<타임스탬프>, 권한 600
    expect(r.backupPath).toBe(`${envPath}.backup-20261126-153005`);
    expect(readFileSync(r.backupPath, "utf8")).toBe(LEGACY);
    expect(statSync(r.backupPath).mode & 0o777).toBe(0o600);

    // 새 .env: 서버별 구분 주석, 값 보존, 이전 키 없음
    const text = readFileSync(envPath, "utf8");
    expect(text).toContain("# ===== Gmail =====");
    expect(text).toContain("# ===== 네이버 =====");
    expect(text).toContain("# ===== 기타 =====");
    expect(text).not.toContain("MAILFOLD_ACCOUNT_");
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
    const env = parseEnv(text);
    expect(env).toEqual({
      GMAIL1_EMAIL: "main@gmail.com",
      GMAIL1_PASSWORD: "aaaa bbbb cccc dddd",
      GMAIL2_EMAIL: "sub@gmail.com",
      GMAIL2_PASSWORD: "eeee ffff gggg hhhh",
      GMAIL3_EMAIL: "me@school.ac.kr",
      GMAIL3_PASSWORD: "iiiijjjjkkkkllll",
      NAVER1_EMAIL: "first@naver.com",
      NAVER1_PASSWORD: "naver#pw one",
      NAVER2_EMAIL: "second@naver.com",
      NAVER2_PASSWORD: "naverpw2",
      NAVER2_LOGIN: "second@naver.com", // 기본 규칙(localpart)과 달라서 유지
      SOME_OTHER_SETTING: "keep me",
    });

    // accounts.json: 비밀이 아닌 값만, alias는 비움
    expect(JSON.parse(readFileSync(accountsPath, "utf8"))).toEqual({
      gmail1: { alias: null, displayName: null, trashFolder: null },
      gmail2: { alias: null, displayName: null, trashFolder: null },
      gmail3: { alias: null, displayName: "홍길동", trashFolder: null },
      naver1: { alias: null, displayName: null, trashFolder: null },
      naver2: { alias: null, displayName: null, trashFolder: "휴지통" },
    });

    // 새 로더로 그대로 읽힌다
    const accounts = await new FileConfigSource({ rootDir: dir }).loadAccounts();
    expect(accounts.map((a) => [a.id, a.user])).toEqual([
      ["gmail1", "main@gmail.com"],
      ["gmail2", "sub@gmail.com"],
      ["gmail3", "me@school.ac.kr"],
      ["naver1", "first"],
      ["naver2", "second@naver.com"],
    ]);
    expect(accounts.find((a) => a.id === "naver2")!.trashFolder).toBe("휴지통");
  });

  it("결과(화면 출력용)에 비밀번호나 이메일 값이 들어 있지 않다", () => {
    writeFileSync(envPath, LEGACY);
    const json = JSON.stringify(migrateEnv({ envPath, accountsPath, providers, now: NOW }));
    for (const s of [...SECRETS, "main@gmail.com", "first@naver.com"]) expect(json).not.toContain(s);
  });

  it("이미 새 형식 계정이 있으면 그 다음 번호부터 매기고, 기존 키는 그대로 둔다", () => {
    writeFileSync(envPath, "GMAIL1_EMAIL=old@gmail.com\nGMAIL1_PASSWORD=x\n" +
      "MAILFOLD_ACCOUNT_G_PROVIDER=gmail\nMAILFOLD_ACCOUNT_G_EMAIL=new@gmail.com\nMAILFOLD_ACCOUNT_G_PASSWORD=y\n");
    const r = migrateEnv({ envPath, accountsPath, providers, now: NOW });
    if (r.status !== "migrated") throw new Error("migrated여야 합니다");
    expect(r.mapping.map((m) => m.to)).toEqual(["gmail2"]);
    expect(parseEnv(readFileSync(envPath, "utf8"))).toEqual({
      GMAIL1_EMAIL: "old@gmail.com", GMAIL1_PASSWORD: "x", GMAIL2_EMAIL: "new@gmail.com", GMAIL2_PASSWORD: "y",
    });
  });

  it("옮길 것이 없으면 파일을 건드리지 않는다", () => {
    writeFileSync(envPath, "GMAIL1_EMAIL=a@gmail.com\nGMAIL1_PASSWORD=x\n");
    expect(migrateEnv({ envPath, accountsPath, providers, now: NOW })).toEqual({ status: "nothing-to-do" });
    expect(readdirSync(dir).sort()).toEqual([".env", "config"]);
  });

  const expectUntouched = (fn: () => unknown, pattern: RegExp) => {
    const before = readFileSync(envPath, "utf8");
    expect(fn).toThrow(pattern);
    expect(readFileSync(envPath, "utf8")).toBe(before);
    expect(readdirSync(dir).filter((f) => f.startsWith(".env.backup"))).toEqual([]);
    expect(existsSync(accountsPath)).toBe(false);
  };

  it("중복 키가 있으면 아무것도 바꾸지 않고, 값은 오류에 넣지 않는다", () => {
    writeFileSync(envPath, LEGACY + "MAILFOLD_ACCOUNT_NAVER2_PASSWORD=dup-secret\n");
    expectUntouched(() => migrateEnv({ envPath, accountsPath, providers }), /MAILFOLD_ACCOUNT_NAVER2_PASSWORD \(줄/);
    try {
      migrateEnv({ envPath, accountsPath, providers });
    } catch (e) {
      for (const s of [...SECRETS, "dup-secret"]) expect((e as Error).message).not.toContain(s);
    }
  });

  it("providers.json에 없는 서버나 서버 주소를 직접 쓴 계정은 옮기지 않는다", () => {
    writeFileSync(envPath, "MAILFOLD_ACCOUNT_D_PROVIDER=daum\nMAILFOLD_ACCOUNT_D_EMAIL=a@daum.net\nMAILFOLD_ACCOUNT_D_PASSWORD=x\n");
    expectUntouched(() => migrateEnv({ envPath, accountsPath, providers }), /provider "daum"/);
    writeFileSync(envPath, "MAILFOLD_ACCOUNT_O_PROVIDER=naver\nMAILFOLD_ACCOUNT_O_EMAIL=a@naver.com\nMAILFOLD_ACCOUNT_O_PASSWORD=x\nMAILFOLD_ACCOUNT_O_IMAP_HOST=h\n");
    expectUntouched(() => migrateEnv({ envPath, accountsPath, providers }), /IMAP_HOST/);
  });

  it("accounts.json이 이미 있으면 덮어쓰지 않는다", () => {
    writeFileSync(envPath, LEGACY);
    writeFileSync(accountsPath, "{}");
    const before = readFileSync(envPath, "utf8");
    expect(() => migrateEnv({ envPath, accountsPath, providers })).toThrow(/이미 있어 덮어쓰지 않았습니다/);
    expect(readFileSync(envPath, "utf8")).toBe(before);
    expect(readFileSync(accountsPath, "utf8")).toBe("{}");
  });
});

describe("formatEnvValue: 값을 .env 한 줄로 쓰기", () => {
  it("다시 읽으면 같은 값이 나온다", () => {
    const values = ["plain", "with space", "a#b", "it's", `say "hi"`, "back\\slash", "$HOME", "x=y", "", "공백 있는 한글"];
    for (const v of values) expect(parseEnv(`K=${formatEnvValue(v)}`).K ?? "").toBe(v);
  });

  it("여러 줄 값은 옮기지 않는다", () => {
    expect(() => formatEnvValue("a\nb")).toThrow(MigrateEnvError);
  });
});
