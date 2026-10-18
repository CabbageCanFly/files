// ==UserScript==
// @name         ChatGPT Temporary Chat Title
// @namespace    local
// @version      1.5
// @description  Labels temporary chats, warns before leaving, and removes ChatGPT UTM tags from outgoing links
// @match        https://chatgpt.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
    'use strict';

    const temporaryTitle = 'Temporary Chat';
    const normalTitle = 'ChatGPT';

    // Remove ONLY utm_source=chatgpt.com, keeping all other query
    // parameters (including any other utm_source values) in place.
    function cleanOutgoingURL(value) {
        if (typeof value !== 'string' && !(value instanceof URL)) {
            return value;
        }

        try {
            const url = new URL(String(value), window.location.href);
            if (
                !['http:', 'https:'].includes(url.protocol) ||
                !url.searchParams.getAll('utm_source').includes('chatgpt.com')
            ) {
                return value;
            }

            url.searchParams.delete('utm_source', 'chatgpt.com');
            return url.href;
        } catch {
            return value;
        }
    }

    function cleanClickedLink(event) {
        if (event.type === 'keydown' && event.key !== 'Enter') {
            return;
        }

        const target = event.target instanceof Element
            ? event.target
            : event.target?.parentElement;
        const link = target?.closest('a[href]');

        if (!link || link.hasAttribute('download')) {
            return;
        }

        const cleaned = cleanOutgoingURL(link.href);
        if (cleaned !== link.href) {
            // Change the link in place. The browser can then handle
            // ordinary, Ctrl/Cmd, middle, and target=_blank clicks.
            link.href = cleaned;
        }
    }

    // Capturing on window runs before most page click handlers.
    // Hover/focus also covers right-click menus and keyboard navigation.
    for (const type of [
        'pointerover', 'focusin', 'pointerdown', 'mousedown',
        'click', 'auxclick', 'contextmenu', 'keydown'
    ]) {
        window.addEventListener(type, cleanClickedLink, true);
    }

    // Some ChatGPT links may be opened via JavaScript instead of a
    // regular anchor click. This works when injected in page context.
    const originalOpen = window.open;
    window.open = function (...args) {
        if (args.length > 0) {
            args[0] = cleanOutgoingURL(args[0]);
        }
        return Reflect.apply(originalOpen, this, args);
    };

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
