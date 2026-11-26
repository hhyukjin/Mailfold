/**
 * .env를 이전 형식(MAILFOLD_ACCOUNT_<ID>_...)에서 새 형식(GMAIL1_EMAIL 등)으로 바꿉니다.
 * 로직은 src/config/migrate-env.ts에 있습니다.
 *
 * 실행: npm run migrate-env
 *
 * 원본은 .env.backup-<타임스탬프>로 먼저 복사합니다. 값(비밀번호, 이메일)은 화면에 출력하지 않습니다.
 */
import { FileConfigSource } from "../src/config/source.js";
import { migrateEnv } from "../src/config/migrate-env.js";

async function main() {
  const source = new FileConfigSource();
  const providers = await source.loadProviders();
  const result = migrateEnv({ envPath: source.envPath, accountsPath: source.accountsPath, providers });

  if (result.status === "nothing-to-do") {
    console.log("옮길 이전 형식(MAILFOLD_ACCOUNT_...) 키가 없습니다. 아무것도 바꾸지 않았습니다.");
    return;
  }

  console.log(`원본 백업: ${result.backupPath}`);
  console.log("계정 이름 바뀜 (옛 별칭 → 새 계정 ID):");
  for (const m of result.mapping) {
    const notes = [m.loginKept ? "LOGIN 유지" : "", ...m.movedToAccountsJson].filter(Boolean);
    console.log(`  ${m.from.padEnd(16)} → ${m.to}${notes.length > 0 ? `  (${notes.join(", ")})` : ""}`);
  }
  if (result.otherKeysKept > 0) console.log(`계정과 관계없는 키 ${result.otherKeysKept}개는 '기타' 구역에 그대로 두었습니다.`);
  console.log(`개인 설정 파일을 만들었습니다: ${result.accountsPath} (별칭 alias는 비어 있습니다. 원하면 직접 채우세요)`);

  // 새 설정이 실제로 읽히는지 마지막으로 확인합니다.
  const accounts = await source.loadAccounts();
  console.log(`새 설정으로 계정 ${accounts.length}개를 읽었습니다: ${accounts.map((a) => a.id).join(", ")}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
