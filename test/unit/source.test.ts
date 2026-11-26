import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileConfigSource, type ConfigSource } from "../../src/config/source.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mailfold-source-"));
  mkdirSync(join(root, "config"));
  copyFileSync("config/providers.json", join(root, "config", "providers.json"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const env = (text: string) => writeFileSync(join(root, ".env"), text);
const accountsJson = (data: unknown) => writeFileSync(join(root, "config", "accounts.json"), JSON.stringify(data));

describe("FileConfigSource", () => {
  it("providers.json + .env로 계정을 읽고, accounts.json이 없어도 동작한다", async () => {
    env("# ===== Gmail =====\nGMAIL1_EMAIL=me@gmail.com\nGMAIL1_PASSWORD=p\n# ===== 네이버 =====\nNAVER1_EMAIL=me@naver.com\nNAVER1_PASSWORD=p\n");
    const source: ConfigSource = new FileConfigSource({ rootDir: root });
    const accounts = await source.loadAccounts();
    expect(accounts.map((a) => [a.id, a.providerLabel, a.user])).toEqual([
      ["gmail1", "Gmail", "me@gmail.com"],
      ["naver1", "네이버", "me"],
    ]);
  });

  it("accounts.json이 있으면 별칭 등을 더한다", async () => {
    env("NAVER1_EMAIL=me@naver.com\nNAVER1_PASSWORD=p\n");
    accountsJson({ naver1: { alias: "개인 네이버", displayName: "홍길동", trashFolder: null } });
    const [a] = await new FileConfigSource({ rootDir: root }).loadAccounts();
    expect(a).toMatchObject({ id: "naver1", alias: "개인 네이버", name: "홍길동" });
  });

  it("accounts.json에 .env에 없는 ID가 있으면 오류다", async () => {
    env("NAVER1_EMAIL=me@naver.com\nNAVER1_PASSWORD=p\n");
    accountsJson({ naver2: { alias: "x" } });
    await expect(new FileConfigSource({ rootDir: root }).loadAccounts()).rejects.toThrow(/naver2/);
  });

  it(".env의 중복 키는 오류다", async () => {
    env("NAVER1_EMAIL=a@naver.com\nNAVER1_PASSWORD=p\nNAVER1_EMAIL=b@naver.com\n");
    await expect(new FileConfigSource({ rootDir: root }).loadAccounts()).rejects.toThrow(/NAVER1_EMAIL \(줄 1, 3\)/);
  });

  it("providers.json이 없으면 오류다", async () => {
    rmSync(join(root, "config", "providers.json"));
    await expect(new FileConfigSource({ rootDir: root }).loadProviders()).rejects.toThrow(/메일 서버 정의 파일이 없습니다/);
  });

  it("저장소의 .env.example과 config/accounts.example.json은 새 로더로 그대로 읽힌다", async () => {
    copyFileSync(".env.example", join(root, ".env"));
    copyFileSync("config/accounts.example.json", join(root, "config", "accounts.json"));
    const accounts = await new FileConfigSource({ rootDir: root }).loadAccounts();
    expect(accounts.map((a) => [a.id, a.alias])).toEqual([
      ["gmail1", "개인 Gmail"],
      ["gmail2", undefined],
      ["naver1", "개인 네이버"],
    ]);
  });

  it(".env가 없으면 계정이 없다", async () => {
    expect(await new FileConfigSource({ rootDir: root }).loadAccounts()).toEqual([]);
  });
});
