import { describe, expect, it } from "vitest";
import { classifyFolders, resolveTrash, TrashNotFoundError, type ListedFolder } from "../../src/providers/folders.js";

const f = (path: string, extra: Partial<ListedFolder> = {}): ListedFolder => ({
  path,
  name: path.split("/").pop()!,
  delimiter: "/",
  flags: new Set(),
  ...extra,
});

describe("classifyFolders", () => {
  it("서버가 알려 준 special-use는 확정(server)으로 본다", () => {
    const out = classifyFolders([
      f("INBOX"),
      f("[Gmail]", { flags: new Set(["\\Noselect"]) }),
      f("[Gmail]/Trash", { specialUse: "\\Trash", specialUseSource: "extension" }),
      f("[Gmail]/All Mail", { specialUse: "\\All", specialUseSource: "extension" }),
    ]);
    expect(out.find((x) => x.path === "INBOX")).toMatchObject({ role: "inbox", roleSource: "server" });
    expect(out.find((x) => x.path === "[Gmail]/Trash")).toMatchObject({ role: "trash", roleSource: "server" });
    const parent = out.find((x) => x.path === "[Gmail]")!;
    expect(parent.selectable).toBe(false);
    expect(parent.role).toBeUndefined();
  });

  it("imapflow의 이름 추정과 한글 이름은 참고용(name-guess)으로만 표시한다", () => {
    const out = classifyFolders([
      f("INBOX"),
      f("Deleted Messages", { specialUse: "\\Trash", specialUseSource: "name" }),
      f("보낸메일함"),
      f("스팸메일함"),
    ]);
    expect(out.find((x) => x.path === "Deleted Messages")).toMatchObject({ role: "trash", roleSource: "name-guess" });
    expect(out.find((x) => x.path === "보낸메일함")).toMatchObject({ role: "sent", roleSource: "name-guess" });
    expect(out.find((x) => x.path === "스팸메일함")).toMatchObject({ role: "junk", roleSource: "name-guess" });
  });

  it("서버 확정 역할이 있으면 같은 역할의 이름 추정은 붙이지 않는다", () => {
    const out = classifyFolders([
      f("Trash"),
      f("Bin", { specialUse: "\\Trash", specialUseSource: "extension" }),
    ]);
    expect(out.filter((x) => x.role === "trash")).toEqual([expect.objectContaining({ path: "Bin", roleSource: "server" })]);
  });

  it("Gmail의 \\Important처럼 flags에만 있는 special-use 속성도 server로 본다", () => {
    // imapflow는 \Important를 specialUse로 옮기지 않고 flags에만 남깁니다 (실제 Gmail probe 결과와 같은 모양).
    const out = classifyFolders([
      f("INBOX"),
      f("[Gmail]", { flags: new Set(["\\HasChildren", "\\NonExistent", "\\Noselect"]) }),
      f("[Gmail]/중요", { flags: new Set(["\\HasNoChildren", "\\Important"]) }),
      f("[Gmail]/휴지통", { flags: new Set(["\\HasNoChildren", "\\Trash"]), specialUse: "\\Trash", specialUseSource: "extension" }),
    ]);
    expect(out.find((x) => x.path === "[Gmail]/중요")).toMatchObject({ role: "important", roleSource: "server" });
    expect(out.find((x) => x.path === "[Gmail]/휴지통")).toMatchObject({ role: "trash", roleSource: "server" });
    expect(out.find((x) => x.path === "[Gmail]")!.role).toBeUndefined();
  });

  it("flags의 special-use 속성은 대소문자를 가리지 않고, imapflow 이름 추정보다 우선한다", () => {
    const out = classifyFolders([
      f("INBOX"),
      f("Trash", { specialUse: "\\Trash", specialUseSource: "name" }),
      f("Papierkorb", { flags: new Set(["\\TRASH"]) }),
    ]);
    expect(out.find((x) => x.path === "Papierkorb")).toMatchObject({ role: "trash", roleSource: "server" });
    expect(out.find((x) => x.path === "Trash")!.role).toBeUndefined();
  });

  it("flags에 \\Inbox가 있어도 INBOX가 아닌 폴더를 inbox로 보지 않는다", () => {
    const out = classifyFolders([f("INBOX"), f("Other", { flags: new Set(["\\Inbox"]) })]);
    expect(out.filter((x) => x.role === "inbox").map((x) => x.path)).toEqual(["INBOX"]);
  });
});

describe("resolveTrash: 휴지통을 확정할 수 없으면 절대 추측하지 않는다", () => {
  it("서버의 \\Trash를 우선한다", () => {
    const folders = classifyFolders([f("INBOX"), f("Bin", { specialUse: "\\Trash", specialUseSource: "extension" })]);
    expect(resolveTrash("g", folders, "Other")).toEqual({ path: "Bin", source: "server" });
  });

  it("서버 정보가 없으면 사용자가 지정한 폴더를 쓴다 (실제로 있을 때만)", () => {
    const folders = classifyFolders([f("INBOX"), f("휴지통")]);
    expect(resolveTrash("naver", folders, "휴지통")).toEqual({ path: "휴지통", source: "config" });
    expect(() => resolveTrash("naver", folders, "없는폴더")).toThrow(TrashNotFoundError);
  });

  it("이름 추정만 있으면 에러를 내고, 후보를 안내한다", () => {
    const folders = classifyFolders([f("INBOX"), f("휴지통")]);
    try {
      resolveTrash("naver", folders);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(TrashNotFoundError);
      expect((e as TrashNotFoundError).candidate).toBe("휴지통");
      expect((e as Error).message).toContain("삭제하지 않았습니다");
    }
  });

  it("후보조차 없으면 에러를 낸다", () => {
    expect(() => resolveTrash("x", classifyFolders([f("INBOX")]))).toThrow(TrashNotFoundError);
  });
});
