import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DuplicateEnvKeyError, findDuplicateEnvKeys, readEnvFile } from "../../src/config/env-file.js";

describe("findDuplicateEnvKeys: .env 중복 키 찾기", () => {
  it("같은 키가 두 번 이상 나오면 키 이름과 줄 번호를 돌려준다", () => {
    const text = [
      "# ===== Gmail =====",
      "GMAIL2_EMAIL=a@gmail.com",
      "GMAIL2_PASSWORD=one",
      "",
      "GMAIL2_EMAIL=b@school.ac.kr",
      "export GMAIL2_PASSWORD = two",
      "NAVER1_EMAIL=c@naver.com",
    ].join("\n");
    expect(findDuplicateEnvKeys(text)).toEqual([
      { key: "GMAIL2_EMAIL", lines: [2, 5] },
      { key: "GMAIL2_PASSWORD", lines: [3, 6] },
    ]);
  });

  it("주석 처리된 줄과 중복 없는 내용은 문제로 보지 않는다", () => {
    expect(findDuplicateEnvKeys("A=1\n# A=2\n  #A=3\nB=1\r\nC=1\r\n")).toEqual([]);
  });

  it("여러 줄에 걸친 따옴표 값 안의 KEY= 모양은 키로 세지 않는다", () => {
    expect(findDuplicateEnvKeys('CERT="line1\nA=inside\nend"\nA=1\n')).toEqual([]);
  });
});

describe("readEnvFile: .env 읽기", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    delete process.env.MAILFOLD_TEST_OK_KEY;
  });

  const writeEnv = (content: string) => {
    dir = mkdtempSync(join(tmpdir(), "mailfold-dotenv-"));
    const path = join(dir, ".env");
    writeFileSync(path, content);
    return path;
  };

  it("중복 키가 있으면 읽지 않고, 오류에 키 이름과 줄 번호만 넣는다", () => {
    const path = writeEnv("GMAIL1_PASSWORD=first-secret-value\nMAILFOLD_TEST_OK_KEY=x\nGMAIL1_PASSWORD=second-secret-value\n");
    let err: unknown;
    try {
      readEnvFile(path);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DuplicateEnvKeyError);
    const message = (err as Error).message;
    expect(message).toContain("GMAIL1_PASSWORD (줄 1, 3)");
    expect(message).not.toContain("first-secret-value");
    expect(message).not.toContain("second-secret-value");
  });

  it("중복이 없으면 키-값 객체로 돌려주고, process.env는 바꾸지 않는다", () => {
    const path = writeEnv("MAILFOLD_TEST_OK_KEY=hello\nQUOTED='a # b'\n");
    expect(readEnvFile(path)).toEqual({ MAILFOLD_TEST_OK_KEY: "hello", QUOTED: "a # b" });
    expect(process.env.MAILFOLD_TEST_OK_KEY).toBeUndefined();
  });

  it("파일이 없으면 빈 객체를 돌려준다", () => {
    expect(readEnvFile(join(tmpdir(), "mailfold-no-such-file.env"))).toEqual({});
  });
});
