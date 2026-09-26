// ==UserScript==
// @name         ChatGPT Temporary Chat Title
// @namespace    local
// @version      1.2
// @description  Forces temporary chats to use "Temporary Chat" and restores the normal new-chat title
// @match        https://chatgpt.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
    'use strict';

    const temporaryTitle = 'Temporary Chat';
    const normalNewChatTitle = 'ChatGPT';

    function isTemporaryChat() {
        return new URL(window.location.href)
            .searchParams
            .get('temporary-chat') === 'true';
    }

    function isNormalNewChat() {
        const url = new URL(window.location.href);

        return (
            url.pathname === '/' &&
            !isTemporaryChat()
        );
    }

    function updateTitle() {
        if (isTemporaryChat()) {
            if (document.title !== temporaryTitle) {
                document.title = temporaryTitle;
            }
            return;
        }

        if (isNormalNewChat()) {
            if (document.title !== normalNewChatTitle) {
                document.title = normalNewChatTitle;
            }
            return;
        }

        // Existing normal chats:
        // let ChatGPT manage its own title.
    }

    updateTitle();

    const observer = new MutationObserver(updateTitle);

    observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        characterData: true
    });

    const originalPushState = history.pushState;
    history.pushState = function (...args) {
        originalPushState.apply(this, args);
        updateTitle();
    };

    const originalReplaceState = history.replaceState;
    history.replaceState = function (...args) {
        originalReplaceState.apply(this, args);
        updateTitle();
    };

    window.addEventListener('popstate', updateTitle);
})();
