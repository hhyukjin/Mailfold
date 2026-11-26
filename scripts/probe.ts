/**
 * 0단계 연결 점검(probe) 실행 스크립트. 로직은 src/probe/probe.ts에 있습니다.
 *
 * 실행: npm run probe            (모든 계정)
 *       npm run probe -- naver1  (특정 계정만, 계정 ID나 별칭으로)
 */
import { writeFileSync } from "node:fs";
import { resolveAccount } from "../src/config/accounts.js";
import { FileConfigSource } from "../src/config/source.js";
import { probeAccount, type AccountProbe } from "../src/probe/probe.js";

const REPORT_PATH = "probe-report.json";

function printSummary({ account, imap, smtp }: AccountProbe) {
  const mark = (ok: boolean) => (ok ? "OK  " : "FAIL");
  const alias = account.alias ? ` 「${account.alias}」` : "";
  console.log(`\n=== ${account.id}${alias} (${account.provider}, ${account.email}) ===`);
  console.log(`  IMAP ${mark(imap.ok)} ${imap.error ?? ""}`);
  console.log(`  SMTP ${mark(smtp.ok)} ${smtp.error ?? ""}`);
  if (!imap.ok) return;

  const caps = imap.keyCapabilities ?? {};
  console.log(`  주요 CAPABILITY: ${Object.entries(caps).map(([k, v]) => `${k}=${v ? "O" : "X"}`).join(" ")}`);
  console.log("  폴더 (역할, 근거):");
  for (const f of imap.folders ?? []) {
    const role = f.role ? `${f.role} (${f.roleSource})` : "";
    const count = f.messages !== undefined ? `${f.messages}통` : "";
    console.log(`    ${f.path.padEnd(28)} ${role.padEnd(22)} ${count}${f.selectable ? "" : " [선택 불가]"}`);
  }
  if (imap.trash && "path" in imap.trash) {
    console.log(`  휴지통: ${imap.trash.path} (근거: ${imap.trash.source})`);
  } else if (imap.trash) {
    console.log(`  ⚠ 휴지통: ${imap.trash.error}`);
  }
  if (imap.inbox) {
    console.log(`  INBOX ${imap.inbox.exists}통, PERMANENTFLAGS: ${imap.inbox.permanentFlags.join(" ") || "(없음)"}`);
    console.log(`  사용자 정의 키워드(태그) 가능: ${imap.inbox.customKeywordsAllowed ? "예" : "아니오"}`);
  }
  if (imap.koreanSearch) {
    console.log(`  한글 검색: ${imap.koreanSearch.ok ? `OK (${imap.koreanSearch.matches}건)` : `FAIL ${imap.koreanSearch.error}`}`);
  }
  if (imap.gmailLabelsSample) {
    const s = imap.gmailLabelsSample;
    console.log(`  Gmail label 읽기: ${s.ok ? `OK ${JSON.stringify(s.labels)}` : `FAIL ${s.error}`}`);
  }
}

async function main() {
  const all = await new FileConfigSource().loadAccounts();
  const names = process.argv.slice(2);
  // 이름을 주면 계정 ID나 별칭으로 찾습니다. 없는 이름이면 있는 계정 목록을 안내하는 오류가 납니다.
  const accounts = names.length > 0 ? [...new Set(names.map((n) => resolveAccount(all, n)))] : all;

  if (accounts.length === 0) {
    console.error("점검할 계정이 없습니다. .env.example을 .env로 복사하고 계정 정보를 채워 주세요 (README 참고).");
    process.exit(1);
  }

  console.log(`계정 ${accounts.length}개를 점검합니다 (읽기 전용).`);
  const report: AccountProbe[] = [];
  for (const account of accounts) {
    const r = await probeAccount(account);
    printSummary(r);
    report.push(r);
  }

  writeFileSync(
    REPORT_PATH,
    JSON.stringify({ generatedAt: new Date().toISOString(), node: process.version, accounts: report }, null, 2),
  );
  console.log(`\n결과를 ${REPORT_PATH}에 저장했습니다. 비밀번호는 들어 있지 않습니다.`);
  if (report.some((r) => !r.imap.ok || !r.smtp.ok)) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
