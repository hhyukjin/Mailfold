import { ImapFlow } from "imapflow";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AccountConfig } from "../../src/config/accounts.js";
import { probeAccount } from "../../src/probe/probe.js";
import {
  gmailLikeStorage,
  naverLikeStorage,
  startFakeImap,
  startFakeSmtp,
  testAccount,
  TEST_PASS,
  TEST_USER,
  type FakeImap,
  type FakeSmtp,
} from "../support/fake-servers.js";

let smtp: FakeSmtp;
let imap: FakeImap | undefined;

beforeAll(async () => {
  smtp = await startFakeSmtp();
});
afterAll(async () => {
  await smtp.close();
});
afterEach(async () => {
  await imap?.close();
  imap = undefined;
});

/** probe 전후로 INBOX 상태(메일 수, 각 메일의 flag)를 비교하기 위한 스냅샷 */
async function inboxSnapshot(account: AccountConfig) {
  const c = new ImapFlow({
    host: "127.0.0.1",
    port: account.imap.port,
    secure: true,
    auth: { user: TEST_USER, pass: TEST_PASS },
    logger: false,
    tls: { rejectUnauthorized: false },
  });
  await c.connect();
  const lock = await c.getMailboxLock("INBOX", { readOnly: true });
  const out: Array<{ uid: number; flags: string[] }> = [];
  try {
    for await (const m of c.fetch("1:*", { uid: true, flags: true })) {
      out.push({ uid: m.uid, flags: [...(m.flags ?? [])].sort() });
    }
  } finally {
    lock.release();
    await c.logout();
  }
  return out;
}

describe("probe: Gmail 형태 서버", () => {
  it("로그인, CAPABILITY, 휴지통, label, 한글 검색을 확인한다", async () => {
    imap = await startFakeImap(gmailLikeStorage(), ["ID", "UIDPLUS", "MOVE", "SPECIAL-USE", "X-GM-EXT-1", "LIST-STATUS"]);
    const account = testAccount("gmail_main", "gmail", imap.port, smtp.port);

    const r = await probeAccount(account);

    expect(r.imap.error).toBeUndefined();
    expect(r.imap.ok).toBe(true);
    expect(r.smtp).toEqual({ ok: true });
    expect(r.imap.keyCapabilities).toMatchObject({ MOVE: true, "SPECIAL-USE": true, "X-GM-EXT-1": true });
    expect(r.imap.trash).toEqual({ path: "[Gmail]/Trash", source: "server" });
    expect(r.imap.inbox).toMatchObject({ exists: 2, customKeywordsAllowed: true });
    expect(r.imap.koreanSearch).toEqual({ ok: true, matches: 1 });
    expect(r.imap.gmailLabelsSample?.ok).toBe(true);
    expect(r.imap.gmailLabelsSample?.labels).toContain("\\Inbox");
  });
});

describe("probe: 네이버 형태 서버 (한글 폴더, special-use 없음)", () => {
  it("휴지통을 추측하지 않고, 후보만 안내한다", async () => {
    imap = await startFakeImap(naverLikeStorage(), ["ID", "UIDPLUS", "MOVE"]);
    const r = await probeAccount(testAccount("naver", "naver", imap.port, smtp.port));

    expect(r.imap.ok).toBe(true);
    expect(r.imap.keyCapabilities?.["SPECIAL-USE"]).toBe(false);
    expect(r.imap.trash).toMatchObject({ candidate: "휴지통" });
    expect(r.imap.trash && "error" in r.imap.trash && r.imap.trash.error).toContain("삭제하지 않았습니다");
    const sent = r.imap.folders?.find((f) => f.path === "보낸메일함");
    expect(sent).toMatchObject({ role: "sent", roleSource: "name-guess" });
    expect(r.imap.gmailLabelsSample).toBeUndefined();
  });

  it("사용자가 휴지통을 지정하면 그 폴더를 config 근거로 쓴다", async () => {
    imap = await startFakeImap(naverLikeStorage(), ["ID", "UIDPLUS", "MOVE"]);
    const r = await probeAccount(testAccount("naver", "naver", imap.port, smtp.port, { trashFolder: "휴지통" }));
    expect(r.imap.trash).toEqual({ path: "휴지통", source: "config" });
  });
});

describe("probe 안전성", () => {
  it("메일 수와 읽음 등 flag를 바꾸지 않고, 메일을 보내지 않는다", async () => {
    imap = await startFakeImap(gmailLikeStorage(), ["ID", "UIDPLUS", "MOVE", "SPECIAL-USE", "X-GM-EXT-1"]);
    const account = testAccount("gmail_main", "gmail", imap.port, smtp.port);
    const before = await inboxSnapshot(account);
    const sentBefore = smtp.received();

    await probeAccount(account);

    expect(await inboxSnapshot(account)).toEqual(before);
    expect(smtp.received()).toBe(sentBefore);
  });

  it("비밀번호가 틀리면 실패를 알려 주고, 오류 메시지에 비밀번호가 없다", async () => {
    imap = await startFakeImap(gmailLikeStorage(), ["ID", "SPECIAL-USE"]);
    const wrong = "wrong-secret-123";
    const r = await probeAccount(testAccount("gmail_main", "gmail", imap.port, smtp.port, { password: wrong }));

    expect(r.imap.ok).toBe(false);
    expect(r.smtp.ok).toBe(false);
    expect(r.imap.error).toContain("로그인 실패");
    expect(r.smtp.error).toContain("로그인 실패");
    expect(JSON.stringify(r)).not.toContain(wrong);
  });

  it("서버에 접속할 수 없으면 실패로 끝나고 멈추지 않는다", async () => {
    const r = await probeAccount(testAccount("x", "imap", 1, 1));
    expect(r.imap.ok).toBe(false);
    expect(r.smtp.ok).toBe(false);
  });
});
