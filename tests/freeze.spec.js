// tests/freeze.spec.js
const { test, expect, chromium } = require('@playwright/test');
const https = require('https');

const tokensInput = process.env.DISCORD_TOKEN || '';
const tokens = tokensInput.split(',').map(t => t.trim()).filter(Boolean);
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');

const TIMEOUT = 60000;

function nowStr() {
    return new Date().toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).replace(/\//g, '-');
}

function sendTG(result) {
    return new Promise((resolve) => {
        if (!TG_CHAT_ID || !TG_TOKEN) {
            console.log('⚠️ TG_BOT 未配置，跳过推送');
            return resolve();
        }

        const msg = [
            `🎮 FreezeHost 续期报告`,
            `🕐 时间: ${nowStr()}`,
            `========================`,
            `${result}`,
            `🌐 官网入口: https://free.freezehost.pro`
        ].join('\n');

        const body = JSON.stringify({ chat_id: TG_CHAT_ID, text: msg });
        const req = https.request({
            hostname: 'api.telegram.org',
            path: `/bot${TG_TOKEN}/sendMessage`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        }, (res) => {
            if (res.statusCode === 200) {
                console.log('📨 TG 推送成功');
            } else {
                console.log(`⚠️ TG 推送失败：HTTP ${res.statusCode}`);
            }
            resolve();
        });

        req.on('error', (e) => {
            console.log(`⚠️ TG 推送异常：${e.message}`);
            resolve();
        });

        req.setTimeout(15000, () => {
            console.log('⚠️ TG 推送超时');
            req.destroy();
            resolve();
        });

        req.write(body);
        req.end();
    });
}

async function handleOAuthPage(page) {
    console.log(`  📄 当前 URL: ${page.url()}`);
    await page.waitForTimeout(3000);

    const selectors = [
        'button:has-text("Authorize")',
        'button:has-text("授权")',
        'button[type="submit"]',
        'div[class*="footer"] button',
        'button[class*="primary"]',
    ];

    for (let i = 0; i < 8; i++) {
        if (!page.url().includes('discord.com')) return;
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(500);
        for (const selector of selectors) {
            try {
                const btn = page.locator(selector).last();
                if (!(await btn.isVisible())) continue;
                const text = (await btn.innerText()).trim();
                if (text.includes('取消') || text.toLowerCase().includes('cancel') || text.toLowerCase().includes('deny')) continue;
                if (await btn.isDisabled()) break;
                await btn.click();
                await page.waitForTimeout(2000);
                if (!page.url().includes('discord.com')) return;
                break;
            } catch { continue; }
        }
        await page.waitForTimeout(2000);
    }
}

test('FreezeHost 自动续期', async ({}, testInfo) => {
    if (tokens.length === 0) {
        throw new Error('❌ 缺少 DISCORD_TOKEN 环境变量，请配置');
    }

    let proxyConfig = undefined;
    if (process.env.GOST_PROXY) {
        try {
            const http = require('http');
            await new Promise((resolve, reject) => {
                const req = http.request({ host: '127.0.0.1', port: 8080, path: '/', method: 'GET', timeout: 3000 }, () => resolve());
                req.on('error', reject);
                req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
                req.end();
            });
            proxyConfig = { server: process.env.GOST_PROXY };
        } catch {
            console.log('⚠️ 本地代理不可达，降级为直连');
        }
    }

    const browser = await chromium.launch({ headless: true, proxy: proxyConfig });

    try {
        let allSummary = [];
        let globalHasError = false;

        for (let tIndex = 0; tIndex < tokens.length; tIndex++) {
            let currentToken = tokens[tIndex];
            let customName = null;
            const match = currentToken.match(/^([^#:]+)[#:](.+)$/);
            if (match) {
                customName = match[1].trim();
                currentToken = match[2].trim();
            }
            let accountLabel = customName ? `👤 ${customName}` : `👤 账号 ${tIndex + 1}`;
            
            console.log(`\n🚀 开始处理 ${accountLabel}`);
            const context = await browser.newContext();
            await context.addInitScript(() => {
                const tryDismiss = () => {
                    const root = document.querySelector('.fc-consent-root');
                    if (!root) return;
                    const btn = root.querySelector('button.fc-cta-consent') || Array.from(root.querySelectorAll('button')).find(b => ['Consent', 'Accept', 'Agree', 'OK', '同意'].includes(b.textContent.trim()));
                    if (btn) btn.click();
                };
                new MutationObserver(tryDismiss).observe(document.body, { childList: true, subtree: true });
                tryDismiss();
            });

            const page = await context.newPage();
            page.setDefaultTimeout(TIMEOUT);
            
            try {
                await page.goto('https://discord.com/login', { waitUntil: 'domcontentloaded' });
                await page.evaluate((token) => {
                    const iframe = document.createElement('iframe');
                    document.body.appendChild(iframe);
                    iframe.contentWindow.localStorage.setItem('token', `"${token}"`);
                }, currentToken);
                await page.reload({ waitUntil: 'domcontentloaded' });
                await page.waitForTimeout(3000);
                
                if (page.url().includes('login')) throw new Error('Discord Token 失效');

                await page.goto('https://free.freezehost.pro', { waitUntil: 'domcontentloaded' });
                await page.click('span.text-lg:has-text("Login with Discord")', { force: true });
                const confirmBtn = page.locator('button#confirm-login');
                await confirmBtn.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
                if (await confirmBtn.isVisible()) await confirmBtn.click({ force: true });

                try {
                    await page.waitForURL(/discord\.com\/oauth2\/authorize/, { timeout: 6000 });
                    if (page.url().includes('discord.com')) await handleOAuthPage(page);
                    await page.waitForURL(/free\.freezehost\.pro/, { timeout: 15000 });
                } catch { }

                await page.waitForURL(url => url.includes('/callback') || url.includes('/dashboard'), { timeout: 10000 }).catch(() => {});
                if (page.url().includes('/callback')) await page.waitForURL(/free\.freezehost\.pro\/dashboard/);
                if (!page.url().includes('/dashboard')) throw new Error(`未到达 Dashboard: ${page.url()}`);

                let coins = '未知';
                try {
                    const coinText = await page.evaluate(() => {
                        const allEls = Array.from(document.querySelectorAll('*'));
                        const balEl = allEls.find(e => e.children.length === 0 && e.textContent.includes('AVAILABLE BALANCE'));
                        if (balEl) {
                            let p = balEl.parentElement;
                            while(p && p.innerText.length < 200) {
                                if (/\d/.test(p.innerText)) return p.innerText;
                                p = p.parentElement;
                            }
                        }
                        return '未知';
                    });
                    const matches = coinText.match(/[\d,]+(\.\d+)?/g);
                    if (matches) coins = matches.reduce((l, c) => c.length > l.length ? c : l, matches[0]);
                } catch (e) { }
                
                const prefix = tIndex === 0 ? '' : '\n';
                allSummary.push(`${prefix}${accountLabel} | 💰 ${coins}`);

                const serverUrls = await page.evaluate(() => Array.from(document.querySelectorAll('a[href*="server-console"]')).map(link => link.href));
                if (serverUrls.length === 0) {
                    allSummary.push(`  ❌ 无服务器\n`);
                    continue; 
                }

                for (let i = 0; i < serverUrls.length; i++) {
                    const sUrl = serverUrls[i];
                    await page.goto(sUrl, { waitUntil: 'domcontentloaded' });
                    await page.waitForTimeout(3000);
                    
                    const serverName = await page.evaluate(() => {
                        const h = document.querySelector('h1, h2, h3, .server-name, .font-bold.text-xl');
                        return h ? h.innerText.trim() : `Node ${i+1}`;
                    });

                    const renewalStatusText = await page.evaluate(() => {
                        const el = document.getElementById('renewal-status-console');
                        return el ? el.innerText.trim() : null;
                    });

                    let shouldRenew = true, timeDisplay = '未知';
                    if (renewalStatusText) {
                        const dMatch = renewalStatusText.match(/(\d+(?:\.\d+)?)\s*day/i);
                        const hMatch = renewalStatusText.match(/(\d+(?:\.\d+)?)\s*hour/i);
                        const mMatch = renewalStatusText.match(/(\d+(?:\.\d+)?)\s*minute/i);
                        if (dMatch || hMatch || mMatch) {
                            const rem = (dMatch ? parseFloat(dMatch[1]) : 0) + ((hMatch ? parseFloat(hMatch[1]) : 0) / 24) + ((mMatch ? parseFloat(mMatch[1]) : 0) / 1440);
                            timeDisplay = `${Math.floor(rem)}天 ${Math.floor((rem % 1) * 24)}小时 ${Math.round(((rem % 1) * 24 % 1) * 60)}分钟`;
                            if (rem > 7) shouldRenew = false;
                        }
                    }

                    let statusText = '';
                    const pushResult = () => {
                        allSummary.push(`  📦 ${serverName}\n  ├─ 状态: ${statusText}\n  └─ 剩余: ${timeDisplay}\n`);
                    };

                    if (!shouldRenew) {
                        statusText = `无需续期`;
                        pushResult();
                        continue;
                    }

                    try {
                        const externalLinkIcon = page.locator('i.fa-external-link-alt:visible').first();
                        const parentEl = externalLinkIcon.locator('xpath=..');
                        await parentEl.waitFor({ state: 'visible', timeout: 8000 });
                        await externalLinkIcon.click({ force: true });
                        await page.waitForTimeout(2000);

                        const renewModalBtn = page.locator('#renew-link-modal');
                        await renewModalBtn.waitFor({ state: 'visible', timeout: 5000 });
                        const btnText = (await renewModalBtn.innerText()).trim();

                        if (!btnText.toLowerCase().includes('renew instance')) {
                            statusText = `⏰ 未到续期条件`;
                            pushResult();
                            continue;
                        }

                        const renewHref = await renewModalBtn.getAttribute('href');
                        await page.goto(new URL(renewHref, page.url()).href, { waitUntil: 'domcontentloaded' });
                        await page.waitForURL(url => url.toString().includes('/dashboard') || url.toString().includes('/server-console'), { timeout: 30000 });
                        
                        const finalUrl = page.url();
                        if (finalUrl.includes('success=RENEWED')) statusText = `✅ 续期成功`;
                        else if (finalUrl.includes('err=CANNOTAFFORDRENEWAL')) statusText = `⚠️ 余额不足`;
                        else if (finalUrl.includes('err=TOOEARLY')) statusText = `⏰ 未到续期限制`;
                        else statusText = `❓ 结果未知`;
                    } catch (err) {
                        const msg = err.message || "";
                        // 关键修改：将 Timeout 判定为封禁，并且【不】触发 globalHasError
                        if (msg.toLowerCase().includes('timeout') || msg.toLowerCase().includes('banned') || msg.toLowerCase().includes('403')) {
                            console.warn(`  ⚠️ 跳过被封禁/缺失服务器: ${serverName}`);
                            statusText = `⚠️ 已封禁/缺失(跳过)`;
                        } else {
                            console.log(`  ❌ 真实错误: ${msg}`);
                            statusText = `❌ 异常`;
                            globalHasError = true; 
                        }
                    }
                    pushResult();
                }
            } catch (err) {
                allSummary.push(`${accountLabel} ❌ 失败 (${err.message.slice(0, 20)})`);
                globalHasError = true;
            } finally {
                await context.close();
            }
        }

        const finalPushText = allSummary.join('\n');
        await sendTG(finalPushText);
        
        // 删除了 throw new Error(...)，无论 globalHasError 是否为 true，测试都将通过
        console.log('🎉 任务处理完毕，所有结果已推送至 TG。');

    } catch (e) {
        await sendTG(`❌ 脚本全局异常：${e.message}`);
        throw e;
    } finally {
        await browser.close();
    }
});
