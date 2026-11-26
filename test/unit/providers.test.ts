import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseProviders, ProvidersConfigError } from "../../src/config/providers.js";

const gmail = {
  label: "Gmail",
  strategy: "gmail",
  imap: { host: "imap.gmail.com", port: 993, secure: true },
  smtp: { host: "smtp.gmail.com", port: 465, secure: true },
  login: "email",
};

describe("parseProviders: config/providers.json 검증", () => {
  it("저장소의 config/providers.json은 올바르고 gmail, naver를 담고 있다", () => {
    const p = parseProviders(readFileSync("config/providers.json", "utf8"));
    expect(Object.keys(p)).toEqual(["gmail", "naver"]);
    expect(p.gmail).toMatchObject({ strategy: "gmail", login: "email", imap: { host: "imap.gmail.com", port: 993 } });
    expect(p.naver).toMatchObject({ strategy: "imap", login: "localpart", smtp: { host: "smtp.naver.com", port: 465 } });
  });

  it("새 서버는 항목만 추가하면 된다", () => {
    const p = parseProviders({
      gmail,
      daum: { ...gmail, label: "다음", strategy: "imap", imap: { host: "imap.daum.net", port: 993, secure: true } },
    });
    expect(p.daum!.imap.host).toBe("imap.daum.net");
  });

  it("provider 키는 소문자 영문만 허용한다", () => {
    for (const bad of ["Gmail", "gmail2", "my-mail", "my_mail"]) {
      expect(() => parseProviders({ [bad]: gmail })).toThrow(ProvidersConfigError);
    }
  });

  it("strategy, login, 포트, 빠진 항목, 모르는 항목을 검사하고 위치를 알려 준다", () => {
    expect(() => parseProviders({ gmail: { ...gmail, strategy: "pop3" } })).toThrow(/gmail\.strategy/);
    expect(() => parseProviders({ gmail: { ...gmail, login: "id" } })).toThrow(/gmail\.login/);
    expect(() => parseProviders({ gmail: { ...gmail, imap: { host: "h", port: 70000, secure: true } } })).toThrow(/gmail\.imap\.port/);
    const { smtp: _smtp, ...noSmtp } = gmail;
    expect(() => parseProviders({ gmail: noSmtp })).toThrow(/gmail\.smtp/);
    expect(() => parseProviders({ gmail: { ...gmail, pasword: "x" } })).toThrow(ProvidersConfigError);
  });

  it("빈 정의와 깨진 JSON은 오류다", () => {
    expect(() => parseProviders({})).toThrow(/provider가 하나도 없습니다/);
    expect(() => parseProviders("{ not json")).toThrow(/올바른 JSON이 아닙니다/);
  });
});
