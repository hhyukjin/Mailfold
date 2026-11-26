import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 20_000,
    // 실제 메일 계정은 절대 쓰지 않습니다. 통합 테스트는 프로세스 안에 띄운 가짜 IMAP/SMTP 서버만 씁니다.
    env: {},
  },
});
