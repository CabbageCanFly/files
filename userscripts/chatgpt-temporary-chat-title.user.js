// ==UserScript==
// @name         ChatGPT Temporary Chat Title
// @namespace    local
// @version      1.4
// @description  Labels temporary chats and warns before leaving them
// @match        https://chatgpt.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
    'use strict';

    const temporaryTitle = 'Temporary Chat';
    const normalTitle = 'ChatGPT';

    // Prevent multiple confirmation dialogs from the same navigation.
    let navigationApprovedUntil = 0;

    function isTemporaryURL(url) {
        return url.searchParams.get('temporary-chat') === 'true';
    }

    function isTemporaryChat() {
        return isTemporaryURL(new URL(window.location.href));
    }

    function updateTitle() {
        // While in a temporary chat, always force the temporary title.
        if (isTemporaryChat()) {
            if (document.title !== temporaryTitle) {
                document.title = temporaryTitle;
            }
            return;
        }

        // The moment ?temporary-chat=true disappears, clear any stale
        // Temporary Chat title. After that, let ChatGPT manage the title.
        if (document.title === temporaryTitle) {
            document.title = normalTitle;
        }
    }

    function destinationLeavesTemporaryChat(destination) {
        if (!isTemporaryChat()) {
            return false;
        }

        try {
            const url = new URL(destination, window.location.href);
            return !isTemporaryURL(url);
        } catch {
            return false;
        }
    }

    function navigationAlreadyApproved() {
        return Date.now() < navigationApprovedUntil;
    }

    function approveNavigationBriefly() {
        // Covers the same navigation passing through multiple handlers
        // such as click -> pushState -> beforeunload.
        navigationApprovedUntil = Date.now() + 2000;
    }

    function confirmLeavingTemporaryChat() {
        if (navigationAlreadyApproved()) {
            return true;
        }

        const approved = window.confirm(
            'Leave Temporary Chat?\n\nThis temporary conversation may be lost.'
        );

        if (approved) {
            approveNavigationBriefly();
        }

        return approved;
    }


    // ------------------------------------------------------------
    // TITLE HANDLING
    // ------------------------------------------------------------

    updateTitle();

    const observer = new MutationObserver(updateTitle);

    observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        characterData: true
    });


    // ------------------------------------------------------------
    // CHATGPT INTERNAL LINK NAVIGATION
    // ------------------------------------------------------------

    document.addEventListener('click', event => {
        if (!isTemporaryChat()) {
            return;
        }

        // Don't interfere with Ctrl+click, middle-click, etc.
        // Those open another tab and leave this Temporary Chat intact.
        if (
            event.button !== 0 ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey ||
            event.altKey
        ) {
            return;
        }

        const link = event.target.closest('a[href]');

        if (!link) {
            return;
        }

        if (link.target === '_blank' || link.hasAttribute('download')) {
            return;
        }

        if (!destinationLeavesTemporaryChat(link.href)) {
            return;
        }

        if (!confirmLeavingTemporaryChat()) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    }, true);


    // ------------------------------------------------------------
    // CHATGPT SPA NAVIGATION
    // ------------------------------------------------------------

    const originalPushState = history.pushState;

    history.pushState = function (state, unused, url) {
        if (
            url != null &&
            destinationLeavesTemporaryChat(url) &&
            !confirmLeavingTemporaryChat()
        ) {
            return;
        }

        originalPushState.apply(this, arguments);
        updateTitle();
    };


    const originalReplaceState = history.replaceState;

    history.replaceState = function (state, unused, url) {
        if (
            url != null &&
            destinationLeavesTemporaryChat(url) &&
            !confirmLeavingTemporaryChat()
        ) {
            return;
        }

        originalReplaceState.apply(this, arguments);
        updateTitle();
    };


    // ------------------------------------------------------------
    // MODERN BROWSER NAVIGATION
    //
    // Helps cover browser back/forward and newer SPA navigation
    // behavior in Chromium-based browsers.
    // ------------------------------------------------------------

    if ('navigation' in window) {
        window.navigation.addEventListener('navigate', event => {
            if (!isTemporaryChat()) {
                return;
            }

            if (!destinationLeavesTemporaryChat(event.destination.url)) {
                return;
            }

            if (navigationAlreadyApproved()) {
                return;
            }

            if (!confirmLeavingTemporaryChat() && event.cancelable) {
                event.preventDefault();
            }
        });

        // Once navigation succeeds, immediately clear a stale
        // Temporary Chat title if the URL is no longer temporary.
        window.navigation.addEventListener('navigatesuccess', updateTitle);
    }


    // ------------------------------------------------------------
    // CLOSING TAB / WINDOW / RELOAD / ADDRESS-BAR NAVIGATION
    // ------------------------------------------------------------

    window.addEventListener('beforeunload', event => {
        if (!isTemporaryChat()) {
            return;
        }

        if (navigationAlreadyApproved()) {
            return;
        }

        event.preventDefault();

        // Required for compatibility with browsers.
        event.returnValue = '';
    });


    // Browser back/forward fallback.
    window.addEventListener('popstate', updateTitle);
})();
