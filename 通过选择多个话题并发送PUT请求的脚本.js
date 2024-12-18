// ==UserScript==
// @name         多选话题并发送PUT请求（archiveMessage）
// @namespace    http://tampermonkey.net/
// @version      0.1
// @description  通过选择多个话题并发送PUT请求的脚本
// @author       You
// @match        https://linux.do/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// ==/UserScript==

(function() {
    'use strict';

    // 给页面添加复选框
    function addCheckboxes() {
        const rows = document.querySelectorAll('tr.topic-list-item');
        rows.forEach(row => {
            const topicId = row.getAttribute('data-topic-id');
            if (topicId) {
                const td = row.querySelector('.main-link');
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.value = topicId;
                checkbox.classList.add('topic-checkbox');
                // 增加样式，使复选框更大更美观
                checkbox.style.width = '25px';
                checkbox.style.height = '25px';
                checkbox.style.marginRight = '10px';
                checkbox.style.cursor = 'pointer';
                checkbox.style.transform = 'scale(1.2)';
                td.appendChild(checkbox);
            }
        });
    }

    // 添加一个按钮，点击后提交PUT请求
    function addSubmitButton() {
        const button = document.createElement('button');
        button.innerText = '提交选择';
        button.style.position = 'fixed';
        button.style.bottom = '20px';
        button.style.right = '20px';
        button.style.zIndex = '1000';
        button.style.padding = '10px 20px';
        button.style.backgroundColor = '#4CAF50';
        button.style.color = 'white';
        button.style.border = 'none';
        button.style.borderRadius = '5px';
        button.style.cursor = 'pointer';
        button.style.fontSize = '16px';
        button.style.boxShadow = '0px 4px 6px rgba(0, 0, 0, 0.2)';
        button.addEventListener('click', handleSubmit);
        document.body.appendChild(button);
    }

    // 获取当前页面的 CSRF Token 和 Cookie
    function getCSRFToken() {
        const token = document.querySelector('meta[name="csrf-token"]');
        return token ? token.content : '';
    }

    // 获取当前页面的 Cookie
    function getCookies() {
        return document.cookie; // 获取当前页面的所有cookie
    }

    // 获取 headers 中的其他必要参数
    function getAdditionalHeaders() {
        return {
            'x-requested-with': 'XMLHttpRequest',
            'discourse-logged-in': 'true',
            'discourse-present': 'true',
        };
    }

    // 发送 PUT 请求的封装方法
    function archiveMessage(topicId) {
        return new Promise((resolve, reject) => {
            const url = `/t/${topicId}/archive-message`;
            const refererUrl = `https://linux.do/t/topic/${topicId}`; // 动态生成 Referer

            const csrfToken = getCSRFToken();
            const cookies = getCookies();
            const additionalHeaders = getAdditionalHeaders();

            GM_xmlhttpRequest({
                method: 'PUT',
                url: url,
                headers: {
                    'Content-Type': 'application/json',
                    'Referer': refererUrl, // 添加 Referer 头
                    'X-CSRF-Token': csrfToken, // 添加 CSRF Token
                    'Cookie': cookies, // 添加 Cookie
                    ...additionalHeaders, // 添加额外的请求头
                },
                data: JSON.stringify({ message: '归档话题' }), // 请求的数据
                onload: function(response) {
                    if (response.status === 200) {
                        console.log(`话题 ${topicId} 已成功归档`);
                        resolve(response);
                    } else {
                        console.error(`归档话题 ${topicId} 失败`);
                        reject(response);
                    }
                },
                onerror: function(error) {
                    console.error(`请求失败: ${error}`);
                    reject(error);
                }
            });
        });
    }

    // 处理提交
    async function handleSubmit() {
        const selectedCheckboxes = document.querySelectorAll('.topic-checkbox:checked');
        const topicIds = Array.from(selectedCheckboxes).map(checkbox => checkbox.value);

        if (topicIds.length === 0) {
            alert('请至少选择一个话题！');
            return;
        }

        // 开始归档
        for (const topicId of topicIds) {
            try {
                await archiveMessage(topicId); // 调用归档函数
            } catch (error) {
                console.error(`话题 ${topicId} 归档失败: `, error);
            }
        }

        // 所有话题归档后自动刷新页面
        location.reload();
    }

    // 等待页面元素完全加载
    function init() {
        // 延迟初始化，确保页面所有元素加载完成
        setTimeout(() => {
            addCheckboxes();
            addSubmitButton();
        }, 1000);  // 延迟1秒

        // 或者使用 MutationObserver 监听页面元素变化，确保只有页面完全渲染后才执行操作
        /*
        const observer = new MutationObserver(() => {
            if (document.querySelectorAll('tr.topic-list-item').length > 0) {
                observer.disconnect();
                addCheckboxes();
                addSubmitButton();
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });*/
    }

    // 等待页面加载完成后初始化
    window.addEventListener('load', init);
    window.addEventListener('DOMContentLoaded', (event) => {
    // 获取当前页面的 URL
    const currentUrl = window.location.href;

    // 判断 URL 是否匹配 https://linux.do/u/*/messages
    if (currentUrl.match(/https:\/\/linux\.do\/u\/[^\/]+\/messages/)) {
        // 如果匹配，则显示复选框和按钮
        document.getElementById('checkbox').style.display = 'inline-block';
        document.getElementById('button').style.display = 'inline-block';
    } else {
        // 否则隐藏复选框和按钮
        document.getElementById('checkbox').style.display = 'none';
        document.getElementById('button').style.display = 'none';
        console.log(`hidden`);
    }
});

})();
