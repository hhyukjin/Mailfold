import { describe, expect, it } from "vitest";
import { decodeMessageRef, encodeMessageRef, InvalidMessageRefError } from "../../src/core/message-ref.js";

describe("MessageRef: 계정+폴더+UIDVALIDITY+UID 참조", () => {
  it("한글·특수문자 폴더 경로도 그대로 되돌린다", () => {
    for (const mailbox of ["INBOX", "[Gmail]/All Mail", "받은메일함/업무", "a:b:c"]) {
      const ref = { account: "naver", mailbox, uidValidity: "1700000000", uid: 42 };
      expect(decodeMessageRef(encodeMessageRef(ref))).toEqual(ref);
    }
  });

  it("손상되거나 형식이 틀린 참조는 거부한다", () => {
    for (const bad of ["", "naver:SU5CT1g:1", "NAVER:SU5CT1g:1:2", "naver:SU5CT1g:x:2", "naver:SU5CT1g:1:0", "naver:!!:1:2"]) {
      expect(() => decodeMessageRef(bad)).toThrow(InvalidMessageRefError);
    }
  });

  it("잘못된 값으로는 참조를 만들지 않는다", () => {
    expect(() => encodeMessageRef({ account: "Bad-Id", mailbox: "INBOX", uidValidity: "1", uid: 1 })).toThrow();
    expect(() => encodeMessageRef({ account: "a", mailbox: "INBOX", uidValidity: "1", uid: 0 })).toThrow();
  });
});
