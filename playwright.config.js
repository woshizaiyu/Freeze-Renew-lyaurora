const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.js',
  timeout: 300000,
  retries: 0, // <--- 将这里的 2 改为 0，彻底关闭重试机制
  use: {
    headless: true,
  },
});
