import { describe, expect, it } from "vitest";
import {
  accountsFromEnv,
  AccountConfigError,
  applyAccountSettings,
  describeAccount,
  LegacyEnvFormatError,
  parseAccountSettings,
  resolveAccount,
} from "../../src/config/accounts.js";
import { parseProviders } from "../../src/config/providers.js";

const providers = parseProviders({
  gmail: {
    label: "Gmail",
    strategy: "gmail",
    imap: { host: "imap.gmail.com", port: 993, secure: true },
    smtp: { host: "smtp.gmail.com", port: 465, secure: true },
    login: "email",
  },
  naver: {
    label: "네이버",
    strategy: "imap",
    imap: { host: "imap.naver.com", port: 993, secure: true },
    smtp: { host: "smtp.naver.com", port: 465, secure: true },
    login: "localpart",
  },
});

const baseEnv = {
  GMAIL1_EMAIL: "me@gmail.com",
  GMAIL1_PASSWORD: "abcd efgh ijkl mnop",
  NAVER2_EMAIL: "me@naver.com",
  NAVER2_PASSWORD: "pw",
};

/** 함수가 던진 오류 메시지를 돌려줍니다 (값이 들어 있지 않은지 검사하는 데 씁니다). */
function errorOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("오류가 나야 하는데 나지 않았습니다");
}

describe("accountsFromEnv: .env 키 해석", () => {
  it("<PROVIDER><번호>_EMAIL/PASSWORD로 계정을 만들고, providers.json의 서버 정보를 채운다", () => {
    const accounts = accountsFromEnv(baseEnv, providers);
    expect(accounts.map((a) => a.id)).toEqual(["gmail1", "naver2"]);
    const [gmail, naver] = accounts;
    expect(gmail).toMatchObject({
      provider: "gmail",
      providerLabel: "Gmail",
      strategy: "gmail",
      email: "me@gmail.com",
      user: "me@gmail.com", // login: email
      imap: { host: "imap.gmail.com", port: 993, secure: true },
      smtp: { host: "smtp.gmail.com", port: 465, secure: true },
    });
    expect(naver).toMatchObject({ provider: "naver", strategy: "imap", user: "me" }); // login: localpart
  });

  it("Google 앱 비밀번호의 공백을 제거한다", () => {
    const [a] = accountsFromEnv(baseEnv, providers);
    expect(a!.password).toBe("abcdefghijklmnop");
  });

  it("LOGIN을 주면 로그인 아이디 규칙을 덮어쓴다", () => {
    const [, naver] = accountsFromEnv({ ...baseEnv, NAVER2_LOGIN: "me@naver.com" }, providers);
    expect(naver!.user).toBe("me@naver.com");
  });

  it("PROVIDER 부분은 대소문자를 가리지 않고, 계정 ID는 소문자다", () => {
    const [a] = accountsFromEnv({ Gmail3_EMAIL: "a@gmail.com", Gmail3_PASSWORD: "p" }, providers);
    expect(a!.id).toBe("gmail3");
  });

  it("계정은 provider, 번호 순으로 정렬한다 (번호는 숫자로 비교)", () => {
    const env = {
      NAVER1_EMAIL: "a@naver.com", NAVER1_PASSWORD: "p",
      GMAIL10_EMAIL: "b@gmail.com", GMAIL10_PASSWORD: "p",
      GMAIL2_EMAIL: "c@gmail.com", GMAIL2_PASSWORD: "p",
    };
    expect(accountsFromEnv(env, providers).map((a) => a.id)).toEqual(["gmail2", "gmail10", "naver1"]);
  });

  it("무관한 환경변수(번호 없는 키, 다른 모양)는 무시한다", () => {
    const env = { ...baseEnv, PATH: "/bin", NODE_ENV: "test", GMAIL_EMAIL: "x", HTTP2_PROXY: "x", SOME1_URL: "x", MAILFOLD_OTHER: "x" };
    expect(accountsFromEnv(env, providers)).toHaveLength(2);
  });

  it("providers.json에 없는 메일 서버는 키 이름으로 알려 주고, 값은 넣지 않는다", () => {
    const secret = "unknown-provider-secret";
    const msg = errorOf(() => accountsFromEnv({ ...baseEnv, DAUM1_EMAIL: "a@daum.net", DAUM1_PASSWORD: secret }, providers));
    expect(msg).toContain("DAUM1_PASSWORD");
    expect(msg).toContain("providers.json에 없는 메일 서버");
    expect(msg).not.toContain(secret);
  });

  it("필드 이름이 틀리면 키 이름으로 알려 주고, 값은 넣지 않는다", () => {
    const secret = "typo-field-secret";
    const msg = errorOf(() => accountsFromEnv({ ...baseEnv, GMAIL1_PASSWROD: secret, NAVER2_USER: secret }, providers));
    expect(msg).toContain("GMAIL1_PASSWROD: 알 수 없는 필드 이름");
    expect(msg).toContain("NAVER2_USER: 알 수 없는 필드 이름");
    expect(msg).not.toContain(secret);
  });

  it("번호 0이나 앞자리 0은 오류다", () => {
    expect(() => accountsFromEnv({ GMAIL0_EMAIL: "a@gmail.com", GMAIL0_PASSWORD: "p" }, providers)).toThrow(/GMAIL0_EMAIL/);
    expect(() => accountsFromEnv({ GMAIL01_EMAIL: "a@gmail.com", GMAIL01_PASSWORD: "p" }, providers)).toThrow(/GMAIL01_EMAIL/);
  });

  it("대소문자만 다른 키가 같은 계정에 겹치면 오류다", () => {
    expect(() => accountsFromEnv({ ...baseEnv, gmail1_email: "x@gmail.com" }, providers)).toThrow(/gmail1_email/);
  });

  it("필수 값이 빠지거나 이메일 형식이 틀리면 어떤 키가 문제인지 알려 주고, 비밀번호는 넣지 않는다", () => {
    const secret = "missing-email-secret";
    const msg = errorOf(() => accountsFromEnv({ GMAIL1_PASSWORD: secret, NAVER1_EMAIL: "not-an-email", NAVER1_PASSWORD: "p" }, providers));
    expect(msg).toContain("GMAIL1_EMAIL");
    expect(msg).toContain("NAVER1_EMAIL(이메일 형식이 아님)");
    expect(msg).not.toContain(secret);
    expect(() => accountsFromEnv({ GMAIL1_EMAIL: "a@gmail.com" }, providers)).toThrow(/GMAIL1_PASSWORD/);
  });

  it("이전 형식(MAILFOLD_ACCOUNT_*)이 남아 있으면 migrate-env를 안내하고, 값은 넣지 않는다", () => {
    const secret = "legacy-secret";
    const env = { ...baseEnv, MAILFOLD_ACCOUNT_NAVER_PASSWORD: secret, MAILFOLD_ACCOUNT_NAVER_EMAIL: "x@naver.com" };
    expect(() => accountsFromEnv(env, providers)).toThrow(LegacyEnvFormatError);
    const msg = errorOf(() => accountsFromEnv(env, providers));
    expect(msg).toContain("migrate-env");
    expect(msg).toContain("MAILFOLD_ACCOUNT_NAVER_PASSWORD");
    expect(msg).not.toContain(secret);
  });
});

describe("accounts.json: 개인 설정", () => {
  const accounts = accountsFromEnv(baseEnv, providers);

  it("별칭, 보내는 사람 이름, 휴지통 폴더를 더한다 (null과 빈 문자열은 없는 것으로 본다)", () => {
    const settings = parseAccountSettings(
      JSON.stringify({
        gmail1: { alias: "개인 Gmail", displayName: "홍길동", trashFolder: null },
        naver2: { alias: "  ", trashFolder: "휴지통" },
      }),
    );
    const [g, n] = applyAccountSettings(accounts, settings);
    expect(g).toMatchObject({ alias: "개인 Gmail", name: "홍길동" });
    expect(g!.trashFolder).toBeUndefined();
    expect(n!.alias).toBeUndefined();
    expect(n!.trashFolder).toBe("휴지통");
  });

  it("파일이 비어 있으면({}) 그대로 둔다", () => {
    expect(applyAccountSettings(accounts, parseAccountSettings("{}"))).toEqual(accounts);
  });

  it(".env에 없는 계정 ID는 경고가 아니라 오류다", () => {
    expect(() => applyAccountSettings(accounts, parseAccountSettings({ gmail9: { alias: "x" } }))).toThrow(/"gmail9": \.env에 없는 계정 ID/);
    // 대문자로 적은 경우도 없는 ID로 봅니다 (ID는 소문자).
    expect(() => applyAccountSettings(accounts, parseAccountSettings({ GMAIL1: {} }))).toThrow(AccountConfigError);
  });

  it("별칭이 계정끼리 겹치면(대소문자 무시) 오류다", () => {
    const s = parseAccountSettings({ gmail1: { alias: "Main" }, naver2: { alias: "main" } });
    expect(() => applyAccountSettings(accounts, s)).toThrow(/별칭 "main"가 gmail1와 naver2에/);
  });

  it("별칭이 다른 계정의 ID와 같으면 오류다", () => {
    const s = parseAccountSettings({ gmail1: { alias: "naver2" } });
    expect(() => applyAccountSettings(accounts, s)).toThrow(/다른 계정 ID와 같습니다/);
  });

  it("모르는 항목이나 깨진 JSON은 오류다", () => {
    expect(() => parseAccountSettings({ gmail1: { aliass: "x" } })).toThrow(AccountConfigError);
    expect(() => parseAccountSettings("{")).toThrow(/올바른 JSON이 아닙니다/);
  });
});

describe("resolveAccount: ID나 별칭으로 계정 찾기", () => {
  const accounts = applyAccountSettings(
    accountsFromEnv(baseEnv, providers),
    parseAccountSettings({ naver2: { alias: "개인 네이버" } }),
  );

  it("계정 ID로 찾는다 (대소문자 무시)", () => {
    expect(resolveAccount(accounts, "GMAIL1").id).toBe("gmail1");
  });

  it("별칭으로 찾는다 (앞뒤 공백, 대소문자 무시)", () => {
    expect(resolveAccount(accounts, " 개인 네이버 ").id).toBe("naver2");
  });

  it("없으면 있는 계정 이름을 안내한다", () => {
    expect(() => resolveAccount(accounts, "daum1")).toThrow(/있는 계정: gmail1, naver2\(개인 네이버\)/);
  });
});

describe("describeAccount", () => {
  it("출력용 정보에는 비밀번호가 들어가지 않고, 별칭이 있으면 함께 담는다", () => {
    const [a] = applyAccountSettings(
      accountsFromEnv({ GMAIL1_EMAIL: "me@gmail.com", GMAIL1_PASSWORD: "supersecret" }, providers),
      parseAccountSettings({ gmail1: { alias: "개인" } }),
    );
    const d = describeAccount(a!);
    expect(d).toMatchObject({ id: "gmail1", alias: "개인", provider: "gmail" });
    expect(JSON.stringify(d)).not.toContain("supersecret");
  });
});
