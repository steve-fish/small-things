import https from 'https';
import readline from 'readline';
import cliProgress from 'cli-progress';
import fs from 'fs/promises';
import path from 'path';
import { URL } from 'url';

// --- ⚙️ 配置信息 ---
const API_URL_TEMPLATE = 'https://api.bilibili.com/x/vas/dlc_act/lottery/detail?act_id={act_id}&lottery_id={lottery_id}';
const RETRY_DELAY = 2000; // 重试前等待2秒

// --- 命令行参数解析 (用于重试机制) ---
const retryArg = process.argv.find(arg => arg.startsWith('retry'));
let MAX_RETRIES = 1; // 默认不重试 (总共尝试1次)

if (retryArg) {
  const parts = retryArg.split('=');
  // 如果是 'retry=5'，则使用 5；如果是 'retry'，则使用默认值 3
  MAX_RETRIES = parseInt(parts[1], 10) || 3;
  console.log(`[⚙️ 机制] 已启用重试机制，每个失败任务最多尝试 ${MAX_RETRIES} 次。`);
}

// --- 🛠️ 工具函数 ---

/**
 * 清理文件名中的非法字符，使其在所有操作系统中都有效。
 * @param {string} filename - 原始文件名。
 * @returns {string} 清理后的安全文件名。
 */
function sanitizeFilename(filename) {
  return filename.replace(/[\\/*?:"<>|]/g, '_');
}

/**
 * 从 Bilibili 数字藏品 URL 中解析出 act_id 和 lottery_id。
 * @param {string} rawUrl - 原始链接。
 * @returns {{act_id: string, lottery_id: string}}
 */
function parseUrlForIds(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const act_id = url.searchParams.get('act_id');
    const lottery_id = url.searchParams.get('lottery_id');
    if (!act_id || !lottery_id) {
      throw new Error("URL 中缺少 'act_id' 或 'lottery_id' 参数。");
    }
    return { act_id, lottery_id };
  } catch (error) {
    throw new Error(`无效的 URL 格式: ${error.message}`);
  }
}


// --- 核心下载逻辑 (原 down.js) ---

/**
 * 根据给定的 URL 下载整个数字藏品集。
 * @param {string} jumpLink - 数字藏品的链接。
 * @param {cliProgress.MultiBar} multibar - 用于显示进度的 multibar 实例。
 * @returns {Promise<void>}
 */
async function downloadCollection(jumpLink, multibar) {
    let activityName = '未知藏品';
    let progressBar;

    try {
        const { act_id, lottery_id } = parseUrlForIds(jumpLink);
        const apiUrl = API_URL_TEMPLATE.replace('{act_id}', act_id).replace('{lottery_id}', lottery_id);

        const response = await fetch(apiUrl);
        if (!response.ok) throw new Error(`获取API信息失败，状态码: ${response.status}`);

        const data = await response.json();
        activityName = data?.data?.name;
        if (!activityName) throw new Error("无法从 API 响应中找到藏品名称。");

        const outputDir = sanitizeFilename(activityName);
        await fs.mkdir(outputDir, { recursive: true });

        const itemList = data?.data?.item_list;
        if (!itemList || itemList.length === 0) {
            console.log(`\n🤷‍♀️ '${activityName}' 中没有可下载的项目。`);
            return;
        }
        
        progressBar = multibar.create(itemList.length, 0, { name: activityName });

        const downloadPromises = itemList.map(async (item) => {
            try {
                const cardTypeInfo = item?.card_info?.card_type_info;
                const imageUrl = cardTypeInfo?.overview_image;
                const name = cardTypeInfo?.name;

                if (!imageUrl || !name) return; // 静默跳过数据不完整的项目

                const sanitizedName = sanitizeFilename(name);
                const extension = path.extname(new URL(imageUrl).pathname) || '.jpg';
                const filePath = path.join(outputDir, `${sanitizedName}${extension}`);

                try {
                    await fs.access(filePath); // 检查文件是否存在
                } catch (e) {
                    // 文件不存在，执行下载
                    const imageResponse = await fetch(imageUrl);
                    if (!imageResponse.ok) {
                        throw new Error(`下载 '${name}' 失败, 状态码: ${imageResponse.status}`);
                    }
                    const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
                    await fs.writeFile(filePath, imageBuffer);
                }
            } finally {
                if (progressBar) {
                    progressBar.increment();
                }
            }
        });

        await Promise.all(downloadPromises);

    } catch (error) {
        // 将错误重新抛出，并附带藏品名称，以便主循环提供更清晰的上下文
        throw new Error(`处理 '${activityName}' 时出错: ${error.message}`);
    }
}


// --- 核心搜索逻辑 (原 search.js) ---

/**
 * 从 Bilibili Garb API 获取单页搜索结果。
 * @param {string} keyword - 搜索关键词。
 * @param {number} pageSize - 每页结果数。
 * @param {number} pageNum - 要获取的页码。
 * @returns {Promise<{items: Array<any>, total: number}>}
 */
async function fetchBilibiliGarbPage(keyword, pageSize = 10, pageNum = 1) {
    const encodedKeyword = encodeURIComponent(keyword);
    const apiUrl = `https://api.bilibili.com/x/garb/v2/mall/home/search?key_word=${encodedKeyword}&ps=${pageSize}&pn=${pageNum}`;

    return new Promise((resolve, reject) => {
        https.get(apiUrl, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const parsedData = JSON.parse(data);
                    if (parsedData.code !== 0) {
                        reject(new Error(`API 返回错误: ${parsedData.message}`));
                        return;
                    }
                    resolve({
                        items: parsedData.data.list || [],
                        total: parsedData.data.total || 0
                    });
                } catch (e) {
                    reject(new Error('解析JSON数据失败。'));
                }
            });
        }).on('error', (err) => {
            reject(new Error(`请求失败: ${err.message}`));
        });
    });
}

/**
 * 主函数，用于搜索藏品并启动下载流程。
 * @param {string} keyword - 搜索关键词。
 * @param {number} desiredCount - 期望获取的结果总数。
 */
async function searchAndProcess(keyword, desiredCount = 20) {
    const PAGE_LIMIT = 10;
    const totalPagesToFetch = Math.ceil(desiredCount / PAGE_LIMIT);
    let allItems = [];

    console.log(`\n🎯 目标获取 ${desiredCount} 条结果，最多将发起 ${totalPagesToFetch} 次请求...`);

    for (let i = 1; i <= totalPagesToFetch; i++) {
        try {
            console.log(`📡 正在请求第 ${i} 页...`);
            const { items } = await fetchBilibiliGarbPage(keyword, PAGE_LIMIT, i);
            if (items.length === 0) {
                console.log(`🤷‍♀️ 第 ${i} 页没有更多结果了，提前结束。`);
                break;
            }
            allItems = allItems.concat(items);
        } catch (error) {
            console.error(`❌ 请求第 ${i} 页时发生错误: ${error.message}`);
            break;
        }
    }

    if (allItems.length === 0) {
        console.log("🚫 未找到任何相关结果。");
        return;
    }

    const finalItems = allItems.slice(0, desiredCount).filter(item =>
        item.jump_link && item.jump_link.startsWith('https://www.bilibili.com/h5/mall/digital-card/home')
    );

    if (finalItems.length === 0) {
        console.log("🤔 在返回的结果中未找到有效的数字藏品链接。");
        return;
    }

    console.log(`\n---------- 🚀 准备处理 ${finalItems.length} 个下载任务... ----------`);
    
    const multibar = new cliProgress.MultiBar({
        clearOnComplete: false,
        hideCursor: true,
        format: ' {bar} | {name} | {value}/{total}'
    }, cliProgress.Presets.shades_classic);

    const downloadTasks = finalItems.map((item) => {
        return async () => {
            let lastError = null;
            for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                try {
                    await downloadCollection(item.jump_link, multibar);
                    return; // 成功，退出重试循环
                } catch (error) {
                    lastError = error;
                    // 在多行进度条下方打印重试信息，避免扰乱进度条显示
                    console.log(`\n[🔁 重试] 任务 '${item.name}' 第 ${attempt}/${MAX_RETRIES} 次尝试失败。错误: ${error.message}`);
                    if (attempt < MAX_RETRIES) {
                        await new Promise(res => setTimeout(res, RETRY_DELAY));
                    }
                }
            }
            // 如果所有重试都失败了，抛出最后的错误
            throw new Error(`任务 '${item.name}' 在 ${MAX_RETRIES} 次尝试后最终失败。最后一次错误: ${lastError.message}`);
        };
    });

    const results = await Promise.allSettled(downloadTasks.map(task => task()));

    multibar.stop();
    
    results.forEach(result => {
        if (result.status === 'rejected') {
            console.error(`\n[‼️ 最终失败] ${result.reason.message}`);
        }
    });

    console.log("\n---------- ✅ 所有下载任务已处理完毕。 ----------");
}

/**
 * 创建交互式命令行界面，获取用户输入。
 */
function createInteractiveCLI() {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    rl.question('🤔 请输入搜索关键词 (例如: 星海): ', (keyword) => {
        if (!keyword.trim()) {
            console.log("😅 关键词不能为空！");
            rl.close();
            return;
        }

        rl.question('🔢 要获取多少条结果? [默认为 20]: ', (ps) => {
            const desiredCount = parseInt(ps, 10) || 20;
            searchAndProcess(keyword, desiredCount)
                .catch(err => console.error(err.message))
                .finally(() => rl.close());
        });
    });

    rl.on('close', () => {
        console.log('\n👋 程序结束。');
        process.exit(0);
    });
}

// --- 🚀 启动程序 ---
createInteractiveCLI();
