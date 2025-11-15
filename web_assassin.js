// ==UserScript==
// @name        v4 test
// @namespace   Violentmonkey Scripts
// @match       *://example.org/*
// @grant       none
// @version     1.0
// @author      -
// @match        *://*/*
// @include      file:///*
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.deleteValue
// @grant        GM.listValues
// @grant        GM.info
// @grant        GM_registerMenuCommand
// @grant        GM.addValueChangeListener
// ==/UserScript==


(async function () {
    'use strict';

    /* -----------------------
       CONFIG & DEFAULTS
    ------------------------*/
    const SETTINGS_DEFAULTS = {
        debug_mode: false,
        accent_color: 'darkblue',
        theme_mode: 'light',
        notifications_active: true,
        ui_language: 'en',
        disable_script: false,
        disable_script_websites: "", // comma-separated domains to globally disable on
        deletion_rules: "",         // single GM key containing JSON array of rules
        mutation_debounce_interval: 250,
        url_debounce_interval: 1000,
        url_periodic_check: true,
        url_periodic_check_interval: 1000,
    };
    const INIT_FLAG_KEY = "__settings_initialized__";

    // Runtime config (does not include deletion_rules bulk by default)
    let CONFIG = {};
    let debug = false;

    // Runtime state
    const state = {
        // observers (MutationObservers)
        observers: [],
        // url watcher interval id
        urlWatcherId: null,
        // last seen url
        lastUrl: '',
        // pending nodes queues for observers
        pendingForever: new Set(),
        pendingOnce: new Set(),
        // processors (debounced)
        processForeverDebounced: null,
        processOnceDebounced: null,
        // currently active selector lists (normalized objects)
        foreverList: [],
        onceList: [],
        // concurrency guard
        isRunning: false,
        // for cleaning up history patch & listeners
        _historyPatched: false,
        _originalHistory: {},
        _urlListeners: [],
        // small mutation observers used for SPA detection (when periodic off)
        _spaObservers: []
    };

    // Global deletion counters (UI can read these)
    window.__vm_deletedOnceCount = 0;
    window.__vm_deletedForeverCount = 0;
    window.__vm_getDeletedCounts = () => ({ once: window.__vm_deletedOnceCount, forever: window.__vm_deletedForeverCount });

    /* -----------------------
       UTILITIES
    ------------------------*/
    function debugLog(...args) {
        if (debug) console.debug('[🪲 DEBUG]', ...args);
    }

    function debounce(fn, delay) {
        let tid = null;
        return (...args) => {
            if (tid) clearTimeout(tid);
            tid = setTimeout(() => {
                tid = null;
                try { fn(...args); } catch (e) { console.error(e); }
            }, delay);
        };
    }

    // Domain matching helper: supports wildcard *.example.com or plain substring/hostname checks
    function domainMatches(domainOfRule, pageDomain) {

        // --- Helpers ---------------------------------------------------------------

        function normalizeUrl(url) {
            try {
                const u = new URL(url);
                return u.hostname.toLowerCase().replace(/\/$/, "");
            } catch {
                return url.toLowerCase().replace(/\/$/, "");
            }
        }

        function isValidIpAddress(str) {
            return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(str);
        }

        function normalizeIp(ip) {
            return ip.split(":")[0];
        }

        function handleFilePathPattern(rulePath, pagePath) {
            const normalize = (p) => {
                let n = p.toLowerCase();
                if (n.startsWith("file:")) n = n.replace(/^file:(\/+)?/, "");
                if (n.startsWith("/") && n[2] === ":") n = n.slice(1);
                return n.replace(/\\/g, "/");
            };
            return normalize(rulePath) === normalize(pagePath);
        }

        function handleNonUrlPattern(rule, page) {
            const p = String(rule).trim().toLowerCase();
            const h = String(page).trim().toLowerCase();

            if (isValidIpAddress(p) && isValidIpAddress(h))
                return normalizeIp(h) === normalizeIp(p);

            if (p.includes(":") || h.includes(":"))
                return handleFilePathPattern(p, h);

            return p === h;
        }

        function extractHostFromPossibleUrl(s) {
            try {
                return new URL(s).hostname.toLowerCase();
            } catch {
                return null;
            }
        }

        // helper: wildcard match for patterns like '*.example.com'
        function wildcardMatches(pattern, host) {
            if (!pattern || !host) return false;
            pattern = String(pattern).trim().toLowerCase();
            host = String(host).trim().toLowerCase();
            if (pattern === "*") return true;
            if (pattern.startsWith("*.") && pattern.length > 2) {
                const core = pattern.slice(2);
                return host === core || host.endsWith("." + core);
            }
            return false;
        }

        // --- Main logic ------------------------------------------------------------

        if (!domainOfRule || !pageDomain) return false;
        if (String(domainOfRule).trim() === "*") return true;

        const pageStr = String(pageDomain).trim().toLowerCase();

        let url;
        try {
            // If pageStr looks like a full URL (contains protocol), this will succeed.
            url = new URL(pageStr);
        } catch {
            // pageDomain is NOT a URL – could be bare hostname, bare IP or file path
            const pageHostCandidate = pageStr; // bare host/IP/path

            // If the rule is itself a URL, extract its hostname and compare to the bare pageHostCandidate.
            const ruleHost = extractHostFromPossibleUrl(domainOfRule);
            if (ruleHost) {
                // If rule is a URL (e.g. "https://example.com" or "https://127.0.0.1")
                // Compare hostnames (ignore protocol)
                if (ruleHost === pageHostCandidate) return true;

                // also support wildcard in ruleHost? unlikely because ruleHost comes from URL.hostname,
                // but keep other checks below.
            }

            // If rule is a wildcard form or plain domain, handle it against the bare host:
            const ruleStr = String(domainOfRule).trim().toLowerCase();

            // 1) wildcard match like '*.example.com' against 'web.example.com'
            if (wildcardMatches(ruleStr, pageHostCandidate)) return true;

            // 2) direct domain match or base domain (example.com matches web.example.com)
            // strip any path from ruleStr (so 'example.com/s' -> 'example.com')
            const ruleDomainOnly = ruleStr.split("/")[0];
            if (ruleDomainOnly === pageHostCandidate) return true;
            if (pageHostCandidate.endsWith("." + ruleDomainOnly)) return true;

            // 3) fallback to existing non-URL matching (IPs, file paths, exact strings)
            return handleNonUrlPattern(domainOfRule, pageHostCandidate);
        }

        // File URL?
        if (url.protocol === "file:")
            return handleFilePathPattern(domainOfRule, pageDomain);

        // Standard web URL matching
        const normalizedPattern = normalizeUrl(domainOfRule);
        const hostname = url.hostname.toLowerCase();

        const normalizeIPv6 = (h) =>
            h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;

        const finalPattern = normalizeIPv6(normalizedPattern).split("/")[0];
        const finalHostname = normalizeIPv6(hostname);

        if (finalHostname === finalPattern) return true;

        if (finalPattern.startsWith("*.") && finalPattern.length > 2) {
            const core = finalPattern.slice(2);
            return finalHostname === core || finalHostname.endsWith("." + core);
        }

        if (finalHostname.endsWith("." + finalPattern)) return true;

        return false;
    }

    // Normalize a selector item to object { selector, name, ruleId, ruleName }
    function normalizeSelectorItem(item, rule = {}) {
        if (!item) return null;
        const selector = (typeof item === 'string') ? item : item.selector;
        if (!selector || typeof selector !== 'string') return null;
        const name = (item && item.name) ? item.name : selector;
        return {
            selector: selector.trim(),
            name: String(name),
            ruleId: rule.id || null,
            ruleName: rule.name || null
        };
    }

    // Deduplicate selectors by selector string
    function dedupeSelectors(list) {
        const map = new Map();
        for (const s of list) {
            if (!s || !s.selector) continue;
            if (!map.has(s.selector)) map.set(s.selector, s);
        }
        return Array.from(map.values());
    }

    // deleteElements: optimized combined selector with fallback per-selector; accepts normalized items or strings
    // NOTE: We increment deletion counters here and try to attribute each removed node to once/forever where possible.
    function deleteElements(selectors) {
        if (!selectors || selectors.length === 0) return;
        const valid = selectors.filter(s => s && (typeof s === 'string' || s.selector));
        if (valid.length === 0) return;

        // Build quick lookup sets of once/forever selectors (strings)
        const onceSet = new Set((state.onceList || []).map(s => s.selector));
        const foreverSet = new Set((state.foreverList || []).map(s => s.selector));

        // build combined selector if possible
        const selectorStrings = valid.map(s => (typeof s === 'string') ? s : s.selector);
        const combined = selectorStrings.join(', ');

        try {
            const nodes = document.querySelectorAll(combined);
            if (nodes.length > 0) {
                nodes.forEach(n => {
                    try {
                        // Try to attribute to once selectors first, then forever (cheap matches)
                        let attributed = false;
                        for (const sel of onceSet) {
                            try {
                                if (n.matches && n.matches(sel)) {
                                    window.__vm_deletedOnceCount++;  // Keep the count updated
                                    const deletedOnceEvent = new CustomEvent('vm-deleted-once', {
                                        detail: {
                                            ruleName: sel.ruleName,  // Pass rule name here
                                            deletionType: 'once',    // Specify it's 'once'
                                            count: window.__vm_deletedOnceCount,
                                        }
                                    });
                                    window.dispatchEvent(deletedOnceEvent);
                                    attributed = true;
                                    break;
                                }
                            } catch (e) { /* ignore invalid sel */ }
                        }

                        if (!attributed) {
                            for (const sel of foreverSet) {
                                try {
                                    if (n.matches && n.matches(sel)) {
                                        window.__vm_deletedForeverCount++;  // Keep the count updated
                                        const deletedForeverEvent = new CustomEvent('vm-deleted-forever', {
                                            detail: {
                                                ruleName: sel.ruleName,  // Pass rule name here
                                                deletionType: 'forever', // Specify it's 'forever'
                                                count: window.__vm_deletedForeverCount,
                                            }
                                        });
                                        window.dispatchEvent(deletedForeverEvent);
                                        attributed = true;
                                        break;
                                    }
                                } catch (e) { /* ignore invalid sel */ }
                            }
                        }

                        // If still not attributed, we won't guess — prefer not mis-attribute.
                        n.remove();
                    } catch (e) {
                        // defensive: still remove if possible
                        try { n.remove(); } catch (err) { }
                    }
                });
                debugLog(`🗑️ [Optimized] Removed ${nodes.length} node(s) for ${valid.length} selectors.`);
            }
            return;
        } catch (e) {
            debugLog('⚠️ Combined selector failed, falling back to single selectors.', e && e.message);
            for (let i = 0; i < valid.length; i++) {
                const s = valid[i];
                const sel = typeof s === 'string' ? s : s.selector;
                const name = (typeof s === 'object' && s.name) ? s.name : sel;
                try {
                    const nodes = document.querySelectorAll(sel);
                    if (nodes.length > 0) {
                        nodes.forEach(n => {
                            try { n.remove(); } catch (e) { }
                        });

                        // attribute based on which set the selector belongs to
                        if (onceSet.has(sel)) {
                            window.__vm_deletedOnceCount += nodes.length;
                            const deletedOnceEvent = new CustomEvent('vm-deleted-once', {
                                detail: {
                                    ruleName: name,  // Pass rule name here
                                    deletionType: 'once',  // Specify it's 'once'
                                    count: window.__vm_deletedOnceCount,
                                }
                            });
                            window.dispatchEvent(deletedOnceEvent);
                        } else if (foreverSet.has(sel)) {
                            window.__vm_deletedForeverCount += nodes.length;
                            const deletedForeverEvent = new CustomEvent('vm-deleted-forever', {
                                detail: {
                                    ruleName: name,  // Pass rule name here
                                    deletionType: 'forever',  // Specify it's 'forever'
                                    count: window.__vm_deletedForeverCount,
                                }
                            });
                            window.dispatchEvent(deletedForeverEvent);
                        }

                        debugLog(`🗑️ Removed ${nodes.length} node(s) for "${name}" — ${sel}`);
                    }
                } catch (err) {
                    console.warn(`⚠️ Invalid selector "${sel}"`, err && err.message);
                }
            }
        }
    }

    /* -----------------------
       STORAGE & SETTINGS
    ------------------------*/
    // Load settings (all keys except we intentionally do not pull deletion_rules into CONFIG)
    async function loadAndInitializeSettings() {
        const keys = Object.keys(SETTINGS_DEFAULTS);
        // Fetch all at once
        const values = await Promise.all(keys.map(k => GM.getValue(k)));
        const initFlag = await GM.getValue(INIT_FLAG_KEY);
        const needsInit = !initFlag;

        const toStore = {};
        keys.forEach((k, idx) => {
            const v = values[idx];
            const isInvalid = (x) => x === undefined || x === null;
            if (needsInit && isInvalid(v)) {
                CONFIG[k] = SETTINGS_DEFAULTS[k];
                toStore[k] = SETTINGS_DEFAULTS[k];
            } else {
                CONFIG[k] = isInvalid(v) ? SETTINGS_DEFAULTS[k] : v;
            }
        });

        if (Object.keys(toStore).length > 0) {
            await Promise.all(Object.entries(toStore).map(([k, v]) => GM.setValue(k, v)));
        }
        if (needsInit) await GM.setValue(INIT_FLAG_KEY, true);

        // don't keep deletion_rules in CONFIG to save memory; access it only during refresh/run
        delete CONFIG.deletion_rules;
        debug = CONFIG.debug_mode;
        debugLog('✅ Settings loaded (CONFIG):', CONFIG);
    }

    /* -----------------------
       CLEANUP & REFRESH
    ------------------------*/
    function cleanup() {
        // disconnect observers
        for (const obs of state.observers) {
            try { obs.disconnect(); } catch (e) { }
        }
        state.observers = [];

        // disconnect any SPA detection observers we added (they were also pushed into state.observers, but keep safety)
        for (const obs of state._spaObservers || []) {
            try { obs.disconnect(); } catch (e) { }
        }
        state._spaObservers = [];

        // restore patched history if needed
        if (state._historyPatched && state._originalHistory) {
            try {
                if (state._originalHistory.pushState) history.pushState = state._originalHistory.pushState;
                if (state._originalHistory.replaceState) history.replaceState = state._originalHistory.replaceState;
            } catch (e) { }
            state._historyPatched = false;
            state._originalHistory = {};
        }

        // remove url listeners
        if (state._urlListeners && state._urlListeners.length) {
            for (const { type, fn, opts } of state._urlListeners) {
                try { window.removeEventListener(type, fn, opts); } catch (e) { }
            }
            state._urlListeners = [];
        }

        // clear url watcher
        if (state.urlWatcherId) {
            clearInterval(state.urlWatcherId);
            state.urlWatcherId = null;
        }

        // clear pending sets
        state.pendingForever.clear();
        state.pendingOnce.clear();
        // clear current lists
        state.foreverList = [];
        state.onceList = [];

        // clear processors
        state.processForeverDebounced = null;
        state.processOnceDebounced = null;

        debugLog('🧹 Cleanup finished');
    }

    // Expose a global refresh function for UI to call later
    async function refreshEngine() {
        debugLog('🔁 Manual refresh requested');
        // re-load settings (in case user changed settings via UI)
        await loadAndInitializeSettings();
        runEngine(); // this will cleanup internally and re-run the lazy load
    }
    // attach to window
    window.__vm_refreshEngine = refreshEngine;

    /* -----------------------
       LAZY-RULE LOADING & ENGINE
    ------------------------*/

    // Helper: load deletion_rules key and return parsed array (may be empty)
    async function loadAllRulesArray() {
        const raw = await GM.getValue('deletion_rules');
        if (!raw) return [];
        try {
            const parsed = (typeof raw === 'string') ? JSON.parse(raw) : raw;
            if (!Array.isArray(parsed)) return [];
            return parsed;
        } catch (e) {
            console.error('⚠️ deletion_rules parse error', e);
            return [];
        }
    }

    // Process a single added node against a list of normalized selectors:
    // checks node itself and its descendants for matches (removes matched nodes).
    function processNodeAgainstSelectors(node, selectors) {
        if (!node || node.nodeType !== Node.ELEMENT_NODE) return;
        try {
            // check node itself first
            for (const s of selectors) {
                try {
                    if (node.matches && node.matches(s.selector)) {
                        node.remove();
                        // increment correct counter depending on which list this was
                        if (selectors === state.onceList) {
                            window.__vm_deletedOnceCount++;  // Keep the count updated
                            const deletedOnceEvent = new CustomEvent('vm-deleted-once', {
                                detail: {
                                    ruleName: s.ruleName,  // Pass rule name here
                                    deletionType: 'once',  // Specify it's 'once'
                                    count: window.__vm_deletedOnceCount,
                                }
                            });
                            window.dispatchEvent(deletedOnceEvent);
                        } else if (selectors === state.foreverList) {
                            window.__vm_deletedForeverCount++;  // Keep the count updated
                            const deletedForeverEvent = new CustomEvent('vm-deleted-forever', {
                                detail: {
                                    ruleName: s.ruleName,  // Pass rule name here
                                    deletionType: 'forever',  // Specify it's 'forever'
                                    count: window.__vm_deletedForeverCount,
                                }
                            });
                            window.dispatchEvent(deletedForeverEvent);
                        }
                        debugLog(`🗑️ Removed node (self) for "${s.name}" — ${s.selector}`);
                        return; // node removed; nothing more to check for this node
                    }
                } catch (e) {
                    // invalid selector may throw on matches in some contexts
                }
            }

            // check descendants
            for (const s of selectors) {
                try {
                    const found = node.querySelectorAll(s.selector);
                    if (found && found.length) {
                        found.forEach(el => {
                            try { el.remove(); } catch (e) { }
                        });
                        // attribute the count
                        if (selectors === state.onceList) {
                            window.__vm_deletedOnceCount += found.length;
                            const deletedOnceEvent = new CustomEvent('vm-deleted-once', {
                                detail: {
                                    ruleName: s.ruleName,  // Pass rule name here
                                    deletionType: 'once',  // Specify it's 'once'
                                    count: window.__vm_deletedOnceCount,
                                }
                            });
                            window.dispatchEvent(deletedOnceEvent);
                        } else if (selectors === state.foreverList) {
                            window.__vm_deletedForeverCount += found.length;
                            const deletedForeverEvent = new CustomEvent('vm-deleted-forever', {
                                detail: {
                                    ruleName: s.ruleName,  // Pass rule name here
                                    deletionType: 'forever',  // Specify it's 'forever'
                                    count: window.__vm_deletedForeverCount,
                                }
                            });
                            window.dispatchEvent(deletedForeverEvent);
                        }
                        debugLog(`🗑️ Removed ${found.length} descendant(s) for "${s.name}" — ${s.selector}`);
                    }
                } catch (e) {
                    // skip invalid selectors
                }
            }
        } catch (e) {
            // defensive
        }
    }


    // Process pending nodes for a given set and selectors
    function processPendingNodes(pendingSet, selectors) {
        if (pendingSet.size === 0) return;
        const nodes = Array.from(pendingSet);
        pendingSet.clear(); // clear early to avoid re-processing while we operate
        for (const node of nodes) {
            // ensure node remains in DOM
            if (!document.contains(node)) continue;
            processNodeAgainstSelectors(node, selectors);
        }
    }

    // Main engine runner (lazy loads rules and starts observers)
    async function runEngine() {
        // concurrency guard: avoid overlapping runs
        if (state.isRunning) {
            debugLog('runEngine already running — skipping');
            return;
        }
        state.isRunning = true;

        try {
            // cleanup first
            cleanup();

            // global disable
            if (CONFIG.disable_script === true) {
                console.warn('🚫 Script globally disabled. Engine will not run.');
                return;
            }

            // check per-domain global disable list
            const disableListRaw = CONFIG.disable_script_websites || "";
            if (disableListRaw && String(disableListRaw).trim()) {
                const parts = String(disableListRaw).split(',').map(x => x.trim()).filter(Boolean);
                for (const p of parts) {
                    if (domainMatches(p, window.location.href)) {
                        console.warn(`⛔ Deletion engine disabled for this domain via disable_script_websites: ${p}`);
                        return;
                    }
                }
            }

            // LOAD RULE INDEX: parse deletion_rules now (lazy: only on refresh/run)
            const allRules = await loadAllRulesArray(); // returns array of rule objects
            // Build a small index of rule metadata (domain, id, name, enabled)
            const ruleIndex = allRules.map(r => ({
                id: r.id || null,
                name: r.name || null,
                domain: r.domain || '',
                enabled: (r.enabled === undefined) ? true : Boolean(r.enabled)
            }));

            // determine matching rules for this URL (we will only "expand" those)
            const matchedRules = [];
            const currentHref = window.location.href;
            for (let i = 0; i < allRules.length; i++) {
                const r = allRules[i];
                if (!r) continue;
                const enabled = (r.enabled === undefined) ? true : Boolean(r.enabled);
                if (!enabled) continue; // skip disabled rules
                if (!r.domain) continue;
                if (domainMatches(r.domain, currentHref)) {
                    matchedRules.push(r);
                }
            }

            // update last seen URL so watchers can compare later
            state.lastUrl = currentHref;

            if (matchedRules.length === 0) {
                debugLog('ℹ️ No matching rules for this URL after lazy index check.');
                setupUrlWatcher(); // keep watching for URL changes
                return;
            }

            debugLog(`✅ Expanding ${matchedRules.length} matching rule(s) for this URL.`);

            // normalize selectors for matched rules
            // normalize selectors for matched rules (new format: rule.selectors[])
            const onceSel = [];
            const foreverSel = [];

            for (const r of matchedRules) {
                if (!Array.isArray(r.selectors)) continue;

                for (const item of r.selectors) {
                    const normalized = normalizeSelectorItem(item, r);
                    if (!normalized) continue;

                    if (item.mode === "once") {
                        onceSel.push(normalized);
                    } else {
                        // default to forever if unspecified
                        foreverSel.push(normalized);
                    }
                }
            }


            // dedupe
            const onceList = dedupeSelectors(onceSel);
            const foreverList = dedupeSelectors(foreverSel);

            state.onceList = onceList;
            state.foreverList = foreverList;

            // initial sweep (combined)
            const combined = [...onceList, ...foreverList];
            if (combined.length > 0) {
                debugLog(`🧹 Running initial sweep of ${combined.length} selectors.`);
                deleteElements(combined);
            }

            // Setup node-processing functions (debounced) that process pending sets
            const mutationDelay = Number(CONFIG.mutation_debounce_interval || SETTINGS_DEFAULTS.mutation_debounce_interval);

            // forever processor
            state.processForeverDebounced = debounce(() => processPendingNodes(state.pendingForever, state.foreverList), mutationDelay);

            // once processor
            state.processOnceDebounced = debounce(() => processPendingNodes(state.pendingOnce, state.onceList), mutationDelay);

            // small safety threshold for huge mutation records
            const MAX_MUTATION_NODES = 1000;

            // create forever observer only if needed
            if (state.foreverList.length > 0) {
                const foreverObserver = new MutationObserver((records) => {
                    try {
                        for (const rec of records) {
                            // safety guard
                            if (rec.addedNodes && rec.addedNodes.length > MAX_MUTATION_NODES) {
                                debugLog('⚠️ Skipping large mutation record (too many added nodes).');
                                continue;
                            }
                            if (rec.addedNodes && rec.addedNodes.length) {
                                for (const n of rec.addedNodes) {
                                    if (n.nodeType === Node.ELEMENT_NODE) state.pendingForever.add(n);
                                }
                            }
                            if (rec.type === 'attributes' && rec.target && rec.target.nodeType === Node.ELEMENT_NODE) {
                                state.pendingForever.add(rec.target);
                            }
                        }
                        // schedule processing via debounced function
                        if (state.processForeverDebounced) state.processForeverDebounced();
                    } catch (e) {
                        // defensive - don't let observer throw
                        debugLog('Error in foreverObserver callback', e && e.message);
                    }
                });
                try {
                    foreverObserver.observe(document.body || document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: [] });
                    state.observers.push(foreverObserver);
                    debugLog(`♻️ Forever observer started for ${state.foreverList.length} selectors.`);
                } catch (e) {
                    console.warn('⚠️ Failed to start forever observer', e);
                }
            }

            // create once observer only if needed
            if (state.onceList.length > 0) {
                const onceObserver = new MutationObserver((records) => {
                    try {
                        for (const rec of records) {
                            if (rec.addedNodes && rec.addedNodes.length > MAX_MUTATION_NODES) {
                                debugLog('⚠️ Skipping large mutation record (too many added nodes).');
                                continue;
                            }
                            if (rec.addedNodes && rec.addedNodes.length) {
                                for (const n of rec.addedNodes) {
                                    if (n.nodeType === Node.ELEMENT_NODE) state.pendingOnce.add(n);
                                }
                            }
                            if (rec.type === 'attributes' && rec.target && rec.target.nodeType === Node.ELEMENT_NODE) {
                                state.pendingOnce.add(rec.target);
                            }
                        }
                        if (state.processOnceDebounced) state.processOnceDebounced();
                    } catch (e) {
                        debugLog('Error in onceObserver callback', e && e.message);
                    }
                });
                try {
                    onceObserver.observe(document.body || document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: [] });
                    state.observers.push(onceObserver);
                    debugLog(`🕒 Once observer started for ${state.onceList.length} selectors.`);
                } catch (e) {
                    console.warn('⚠️ Failed to start once observer', e);
                }

                // ensure once observer stops after max 3 seconds
                setTimeout(() => {
                    try { onceObserver.disconnect(); } catch (e) { }
                    state.observers = state.observers.filter(o => o !== onceObserver);
                    state.pendingOnce.clear();
                    debugLog('🛑 Once observer stopped (max duration reached).');
                }, 3000);
            }

            // finally, start URL watcher
            setupUrlWatcher();
        } finally {
            state.isRunning = false;
        }
    }

    /* -----------------------
       URL WATCHER
    ------------------------*/
    function setupUrlWatcher() {
        // clear old watcher and listeners if exists (we rebuild index every refresh anyway)
        if (state.urlWatcherId) {
            clearInterval(state.urlWatcherId);
            state.urlWatcherId = null;
        }
        // remove any url listeners stored
        if (state._urlListeners && state._urlListeners.length) {
            for (const { type, fn, opts } of state._urlListeners) {
                try { window.removeEventListener(type, fn, opts); } catch (e) { }
            }
            state._urlListeners = [];
        }
        // disconnect any SPA observers we previously created & clear array (they're also kept in state.observers)
        for (const obs of state._spaObservers || []) {
            try { obs.disconnect(); } catch (e) { }
        }
        state._spaObservers = [];

        // helper to run when URL change is detected (debounced)
        const debMs = Number(CONFIG.url_debounce_interval || SETTINGS_DEFAULTS.url_debounce_interval);
        const onUrlChange = debounce(() => {
            try {
                if (window.location.href !== state.lastUrl) {
                    debugLog('🔄 Detected URL change — re-running engine (lazy reload).');
                    runEngine();
                }
            } catch (e) {
                debugLog('onUrlChange error', e && e.message);
            }
        }, Math.max(50, debMs));

        // If periodic check is enabled, use interval polling (original behavior)


        // If periodic check is disabled, we rely on event-based SPA detection:
        debugLog('URL periodic check disabled via settings. Using SPA/event-based detection.');

        // 1) popstate and hashchange
        const popFn = () => onUrlChange();
        window.addEventListener('popstate', popFn, true);
        window.addEventListener('hashchange', popFn, true);
        state._urlListeners.push({ type: 'popstate', fn: popFn, opts: true }, { type: 'hashchange', fn: popFn, opts: true });

        // 2) patch history.pushState/replaceState to detect SPA navigations
        tryPatchHistory(onUrlChange);

        // 3) lightweight MutationObservers:
        // - Observe <head> childList for title or head-based router changes
        // - Observe <body> attributes (class changes, data-route attributes) which some routers use
        try {
            const head = document.head || document.querySelector('head');
            if (head) {
                const headObserver = new MutationObserver((records) => {
                    for (const rec of records) {
                        // if title changed or nodes added/removed in head, check url
                        if (rec.type === 'childList') {
                            onUrlChange();
                        }
                    }
                });
                headObserver.observe(head, { childList: true, subtree: false });
                state._spaObservers.push(headObserver);
                state.observers.push(headObserver);
            }

            const body = document.body || document.documentElement;
            if (body) {
                const bodyAttrObserver = new MutationObserver((records) => {
                    for (const rec of records) {
                        // attribute changes may indicate SPA navigation (class/name/data-* changes)
                        if (rec.type === 'attributes') {
                            onUrlChange();
                        }
                    }
                });
                // Observe attributes on body only (cheap)
                bodyAttrObserver.observe(body, { attributes: true, attributeFilter: [], subtree: false });
                state._spaObservers.push(bodyAttrObserver);
                state.observers.push(bodyAttrObserver);
            }
        } catch (e) {
            debugLog('⚠️ Failed to setup SPA mutation observers', e && e.message);
        }
    }

    // helper to patch history methods (and store originals for cleanup)
    function tryPatchHistory(onUrlChangeFn) {
        try {
            if (!state._historyPatched) {
                state._originalHistory = {
                    pushState: history.pushState,
                    replaceState: history.replaceState
                };
                history.pushState = function (...args) {
                    // call original
                    const res = state._originalHistory.pushState.apply(this, args);
                    try { onUrlChangeFn(); } catch (e) { }
                    return res;
                };
                history.replaceState = function (...args) {
                    const res = state._originalHistory.replaceState.apply(this, args);
                    try { onUrlChangeFn(); } catch (e) { }
                    return res;
                };
                state._historyPatched = true;
            } else {
                // already patched; still call onUrlChange when needed
            }
        } catch (e) {
            debugLog('⚠️ Failed to patch history methods', e && e.message);
        }
    }

    // Self-contained UI module. Exposed as window.__vm_ui for external use.
    async function initUI() {
        const UI = (function () {
            const ROOT_ID = 'vm-ui-root';
            const FLOAT_BTN_ID = 'vm-floating-btn';
            const MAIN_WIN_ID = 'vm-main-window';
            const POPUP_CONTAINER_ID = 'vm-popup-container';
            const TOAST_CONTAINER_ID = 'vm-toast-container';
            const RULES_KEY = 'deletion_rules';
            const STYLE_ID = 'vm-ui-styles';
            const ANIM = { speed: 180 };
            const THEME_FADE_MS = 150;

            const el = (tag, attrs = {}, ...kids) => {
                const node = document.createElement(tag);
                for (const k of Object.keys(attrs || {})) {
                    if (k === 'style') Object.assign(node.style, attrs[k]);
                    else if (k.startsWith('on') && typeof attrs[k] === 'function') node.addEventListener(k.slice(2), attrs[k]);
                    else if (k === 'dataset') Object.assign(node.dataset, attrs[k]);
                    else node.setAttribute(k, attrs[k]);
                }
                for (const c of kids) {
                    if (c == null) continue;
                    if (typeof c === 'string' || typeof c === 'number') node.appendChild(document.createTextNode(String(c)));
                    else node.appendChild(c);
                }
                return node;
            };
            const q = s => document.querySelector(s);
            function clamp(val, min, max) { return Math.max(min, Math.min(max, val)); }
            // small debounce used by UI
            function simpleDebounce(fn, ms = 150) {
                let t = null;
                return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
            }


            function ensureStyles() {
                if (document.getElementById(STYLE_ID)) return;

                const css = `:root {
  --vm-accent: ${CONFIG.accent_color || 'darkblue'};
  /* GitHub Dark palette + light defaults */
  --vm-bg: ${CONFIG.theme_mode === 'dark' ? '#0d1117' : '#ffffff'};
  --vm-card: ${CONFIG.theme_mode === 'dark' ? '#161b22' : '#fbfbfd'};
  --vm-fg: ${CONFIG.theme_mode === 'dark' ? '#c9d1d9' : '#071018'};
  --vm-muted: ${CONFIG.theme_mode === 'dark' ? '#8b949e' : '#66787f'};
  --vm-border: ${CONFIG.theme_mode === 'dark' ? '#30363d' : 'rgba(0,0,0,0.06)'};
  --vm-shadow: rgba(3,7,18,0.18);
  --vm-radius: 12px;
  --vm-trans: ${ANIM.speed}ms;
  --vm-z: 2147483000;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial;
}
#${ROOT_ID} {
position: fixed;
inset: 0;
width: 0 !important;
height: 0 !important;
pointer-events: none;
overflow: visible;
z-index: var(--vm-z);
}


#${ROOT_ID} .vm-main-window,
#${ROOT_ID} .vm-popup-backdrop,
#${ROOT_ID} .vm-popup,
#${ROOT_ID} .toast-area,
#${ROOT_ID} .toast,
#${ROOT_ID} .vm-card,
#${ROOT_ID} .rules-list,
#${ROOT_ID} .rule-row,
#${ROOT_ID} button,
#${ROOT_ID} input,
#${ROOT_ID} select,
#${ROOT_ID} textarea {
pointer-events: auto !important;
}

#${ROOT_ID} * { box-sizing: border-box; }


.vm-floating-button {
  position: fixed;
  right: 22px;
  bottom: 22px;
  width: 56px;
  height: 56px;
  border-radius: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  pointer-events: auto;
  box-shadow: 0 8px 24px var(--vm-shadow);
  backdrop-filter: blur(6px);
  border: 1px solid rgba(0,0,0,0.06);
  transition: transform var(--vm-trans) ease, box-shadow var(--vm-trans) ease, background-color var(--vm-trans) ease;
  background-color: var(--vm-accent);
  color: white;
}
.vm-floating-button:hover { transform: translateY(-4px) scale(1.02); box-shadow: 0 12px 32px rgba(3,7,18,0.24); }


.vm-main-window {  position: fixed;  z-index: calc(var(--vm-z) + 100);  right: 22px;  bottom: 90px;  width: 740px;  max-width: calc(100vw - 48px);  height: 520px;  max-height: calc(100vh - 80px);  border-radius: var(--vm-radius);  background-color: var(--vm-bg);  color: var(--vm-fg);  pointer-events: auto;  overflow: hidden;  box-shadow: 0 20px 60px rgba(2,6,23,0.6);  display: flex;  flex-direction: column;  transform-origin: bottom right;  transform: scale(0.92);  opacity: 0;  transition: transform var(--vm-trans) cubic-bezier(.2,.9,.3,1), opacity var(--vm-trans) ease;  border: 1px solid var(--vm-border);}


.vm-main-window.vm-theme-fade { transition: opacity ${THEME_FADE_MS}ms ease; opacity: 0.6; }

.vm-main-window.open { transform: scale(1); opacity: 1; }


.vm-header, .vm-card, .vm-tab {
  transition: background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}

.vm-header {
  padding: 16px 18px;
  display: flex;
  align-items: center;
  gap: 12px;
  border-bottom: 1px solid var(--vm-border);
  background: linear-gradient(90deg, rgba(255,255,255,0.02), rgba(255,255,255,0.01));
}

.vm-title { font-weight: 700; font-size: 16px; color: var(--vm-fg); }
.vm-tabs { margin-left: auto; display:flex; gap:8px; }
.vm-tab {
  padding: 8px 12px; border-radius: 10px; font-size:13px; cursor: pointer;
  color: var(--vm-muted); background: transparent; border: none;
}
.vm-tab.active {
  background: rgba(255,255,255,0.02); color: var(--vm-fg); box-shadow: inset 0 -2px 0 var(--vm-accent);
}

.vm-body { padding: 14px; overflow: auto; display: grid; grid-template-columns: 1fr; gap:12px; }

.vm-card {
  background: var(--vm-card);
  border-radius: 10px;
  padding: 12px;
  box-shadow: 0 6px 18px rgba(2,6,23,0.15);
  border: 1px solid var(--vm-border);
}

/* status */
.vm-stats { display:flex; gap:12px; align-items:center; }
.stat { flex:1; padding:12px; border-radius:10px; background: linear-gradient(180deg, rgba(255,255,255,0.01), rgba(0,0,0,0.02)); }
.stat .num { font-size: 20px; font-weight:700; color:var(--vm-fg); }
.stat .label { font-size:12px; color:var(--vm-muted); }

/* rules list */
.rules-list { display:flex; flex-direction:column; gap:8px; max-height: 340px; overflow:auto; }
.rule-row { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:8px; border-radius:8px; background: rgba(0,0,0,0.01); }
.rule-meta { display:flex; gap:12px; align-items:center; }
.rule-title { font-weight:600; }
.rule-domain { font-size:12px; color:var(--vm-muted); }

/* settings layout */
.settings-grid { display:grid; grid-template-columns: 1fr 1fr; gap:12px; }
.setting { display:flex; flex-direction:column; gap:6px; }
.vm-controls { display:flex; gap:8px; align-items:center; }

/* buttons */
.vm-btn {
  padding:8px 12px; border-radius:8px; border:none; cursor:pointer; font-weight:600;
  background:var(--vm-accent); color:#fff;
  transition: transform var(--vm-trans) ease, opacity var(--vm-trans) ease;
}
.vm-btn.ghost { background: transparent; color: var(--vm-fg); border: 1px solid rgba(255,255,255,0.04); }

/* toggles - improved contrast and theme-aware visuals */
.vm-toggle {
  width:44px; height:26px; border-radius:14px; position:relative; cursor:pointer;
  display:inline-block; border: 1px solid var(--vm-border);
  transition: background-color 0.12s ease, border-color 0.12s ease;
  background: ${CONFIG.theme_mode === 'dark' ? '#30363d' : 'rgba(0,0,0,0.08)'};
}
.vm-toggle .knob {
  position:absolute; left:4px; top:3px; width:20px; height:20px; border-radius:11px;
  background: ${CONFIG.theme_mode === 'dark' ? '#f0f6fc' : '#4b5563'};
  transition: left var(--vm-trans) ease, background-color 0.12s ease, box-shadow 0.12s ease;
  box-shadow: 0 2px 6px rgba(2,6,23,0.12);
}
.vm-toggle.on { background: var(--vm-accent); }
.vm-toggle.on .knob { left: 20px; }

/* popup & toast */
#${POPUP_CONTAINER_ID} {
position: fixed;
right: 0; bottom: 0; left: 0; top: 0;
pointer-events: none;
z-index: calc(var(--vm-z) + 200);
}

.vm-popup-backdrop { position:absolute; inset:0; background: rgba(2,6,23,0.45); display:flex; align-items:center; justify-content:center; pointer-events:auto; }
.vm-popup { width:520px; max-width:calc(100% - 60px); border-radius:12px; padding:16px; background:var(--vm-card); color:var(--vm-fg); box-shadow: 0 30px 80px rgba(2,6,23,0.6); }


.toast-area { position: fixed; right: 22px; bottom: 22px; display:flex; flex-direction:column; gap:8px; align-items:flex-end; z-index: calc(var(--vm-z) + 3); pointer-events:none; }
.toast { padding:10px 14px; border-radius:10px; background: rgba(0,0,0,0.7); color:#fff; pointer-events:auto; transform-origin: right bottom; opacity:0; transform: translateY(12px); transition: transform 220ms ease, opacity 220ms ease; }
.toast.show { opacity:1; transform: translateY(0); }

/* Global input/textarea styling so text boxes follow theme (fix for white boxes in dark mode) */
#${ROOT_ID} input, #${ROOT_ID} textarea, #${ROOT_ID} select {
  background: var(--vm-card);
  color: var(--vm-fg);
  border: 1px solid var(--vm-border);
  padding: 8px;
  border-radius: 8px;
  transition: background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}
#${ROOT_ID} input:focus, #${ROOT_ID} textarea:focus, #${ROOT_ID} select:focus {
  outline: none;
  border-color: var(--vm-accent);
  box-shadow: 0 4px 18px rgba(31,78,216,0.06);
}


@media (max-width: 820px) {
  .vm-main-window { width: calc(100vw - 32px); right: 16px; left: 16px; bottom: 60px; }
}`;

                const s = document.createElement('style');
                s.id = STYLE_ID;
                s.textContent = css;
                document.head.appendChild(s);
            }
            function applyThemeVars({ fade = true } = {}) {
                const root = document.documentElement;
                root.style.setProperty('--vm-accent', CONFIG.accent_color || SETTINGS_DEFAULTS.accent_color);
                if (CONFIG.theme_mode === 'dark') {
                    root.style.setProperty('--vm-bg', '#0d1117');
                    root.style.setProperty('--vm-card', '#161b22');
                    root.style.setProperty('--vm-fg', '#c9d1d9');
                    root.style.setProperty('--vm-muted', '#8b949e');
                    root.style.setProperty('--vm-border', '#30363d');
                } else {
                    root.style.setProperty('--vm-bg', '#ffffff');
                    root.style.setProperty('--vm-card', '#fbfbfd');
                    root.style.setProperty('--vm-fg', '#071018');
                    root.style.setProperty('--vm-muted', '#66787f');
                    root.style.setProperty('--vm-border', 'rgba(0,0,0,0.06)');
                }

                const s = document.getElementById(STYLE_ID);
                if (s) {
                    let cssText = s.textContent;
                    cssText = cssText.replace(/(\.vm-toggle \{[\s\S]*?background:\s*)([^;]+)(;)/m, (m0, p1, p2, p3) => {
                        const newBg = (CONFIG.theme_mode === 'dark') ? '#30363d' : 'rgba(0,0,0,0.08)';
                        return p1 + newBg + p3;
                    });
                    cssText = cssText.replace(/(\.vm-toggle \.knob \{[\s\S]*?background:\s*)([^;]+)(;)/m, (m0, p1, p2, p3) => {
                        const newKnob = (CONFIG.theme_mode === 'dark') ? '#f0f6fc' : '#4b5563';
                        return p1 + newKnob + p3;
                    });
                    s.textContent = cssText;
                }

                if (fade) {
                    const win = document.getElementById(MAIN_WIN_ID);
                    if (win) {
                        win.classList.add('vm-theme-fade');
                        setTimeout(() => {
                            try { win.classList.remove('vm-theme-fade'); } catch (e) { }
                        }, THEME_FADE_MS);
                    }
                }
            }

            function ensureRoot() {
                let root = document.getElementById(ROOT_ID);
                if (root) return root;
                root = el('div', { id: ROOT_ID });
                const floatBtn = el('div', { id: FLOAT_BTN_ID, class: 'vm-floating-button', title: 'ViolentMonkey Deletion Engine' }, '☰');
                root.appendChild(floatBtn);
                const main = el('div', { id: MAIN_WIN_ID, class: 'vm-main-window' });
                root.appendChild(main);
                const popc = el('div', { id: POPUP_CONTAINER_ID });
                const toastc = el('div', { id: TOAST_CONTAINER_ID, class: 'toast-area' });
                root.appendChild(popc);
                root.appendChild(toastc);
                document.body.appendChild(root);
                return root;
            }

            function showToast(message, opts = {}) {
                try {
                    if (CONFIG.notifications_active === false) return;
                } catch (e) { /* fallthrough */ }

                const c = q(`#${ROOT_ID} #${TOAST_CONTAINER_ID}`) || q(`#${ROOT_ID} .toast-area`);
                if (!c) return;
                const t = el('div', { class: 'toast vm-card' }, message);
                c.appendChild(t);
                requestAnimationFrame(() => t.classList.add('show'));
                const timeout = (opts.timeout === undefined) ? 3500 : opts.timeout;
                const id = setTimeout(() => {
                    t.classList.remove('show');
                    setTimeout(() => t.remove(), 220);
                }, timeout);
                t.addEventListener('click', () => {
                    clearTimeout(id);
                    t.classList.remove('show');
                    setTimeout(() => t.remove(), 120);
                });
            }

            function openPopup({ title = '', content = null, actions = [] } = {}) {
                const popContainer = q(`#${ROOT_ID} #${POPUP_CONTAINER_ID}`) || q(`#${ROOT_ID}`);
                if (!popContainer) return;
                popContainer.innerHTML = '';
                const backdrop = el('div', { class: 'vm-popup-backdrop' });
                const box = el('div', { class: 'vm-popup' });
                if (title) box.appendChild(el('div', { style: { fontWeight: 700, marginBottom: '8px' } }, title));
                if (content) {
                    if (typeof content === 'string') box.appendChild(el('div', {}, content));
                    else box.appendChild(content);
                }
                const btnRow = el('div', { style: { marginTop: '12px', display: 'flex', gap: '8px', justifyContent: 'flex-end' } });
                actions.forEach(a => {
                    const cls = a.ghost ? 'vm-btn ghost' : 'vm-btn';
                    const b = el('button', { class: cls, onclick: async () => { try { await a.onClick(); } catch (e) { } closePopup(); } }, a.label || 'OK');
                    btnRow.appendChild(b);
                });
                box.appendChild(btnRow);
                backdrop.appendChild(box);
                popContainer.appendChild(backdrop);
                function closePopup() { try { backdrop.remove(); } catch (e) { } }
                backdrop.addEventListener('click', (ev) => { if (ev.target === backdrop) closePopup(); });
                return { close: () => backdrop.remove() };
            }

            function createButton(label, opts = {}) {
                const cls = opts.ghost ? 'vm-btn ghost' : 'vm-btn';
                const btn = el('button', { class: cls });
                btn.appendChild(document.createTextNode(label));
                if (opts.title) btn.title = opts.title;
                if (opts.onClick) btn.addEventListener('click', opts.onClick);
                return btn;
            }

            function createToggle(initial = false, onChange) {
                const wrap = el('div', { class: 'vm-toggle' });
                const knob = el('div', { class: 'knob' });
                wrap.appendChild(knob);
                function setOn(v) { if (v) wrap.classList.add('on'); else wrap.classList.remove('on'); }
                setOn(Boolean(initial));
                wrap.addEventListener('click', () => {
                    const newVal = !wrap.classList.contains('on');
                    setOn(newVal);
                    if (typeof onChange === 'function') onChange(newVal);
                });
                return { el: wrap, set: setOn };
            }
            function buildRuleRow(rule, idx, onEdit, onDelete, onToggle) {
                const row = el('div', { class: 'rule-row vm-card' });
                const meta = el('div', { class: 'rule-meta' });
                const title = el('div', { class: 'rule-title' }, rule.name || `Rule ${idx + 1}`);
                const domain = el('div', { class: 'rule-domain' }, rule.domain || '*');
                meta.appendChild(title);
                meta.appendChild(domain);

                // Add deletion counts to the UI
                const stats = el('div', { class: 'vm-stats' });
                const onceCount = el('div', { class: 'stat once-count' }, el('div', { class: 'num' }, 0), el('div', { class: 'label' }, 'Deleted (once)'));
                const foreverCount = el('div', { class: 'stat forever-count' }, el('div', { class: 'num' }, 0), el('div', { class: 'label' }, 'Deleted (forever)'));
                stats.appendChild(onceCount);
                stats.appendChild(foreverCount);
                row.appendChild(meta);
                row.appendChild(stats);

                const controls = el('div', { class: 'vm-controls' });
                const toggle = createToggle(Boolean(rule.enabled), (v) => { if (onToggle) onToggle(v); });
                controls.appendChild(toggle.el);
                controls.appendChild(createButton('Edit', { onClick: () => onEdit(rule, idx) }));
                const del = createButton('Delete', { ghost: true, onClick: () => onDelete(rule, idx) });
                controls.appendChild(del);

                row.appendChild(controls);
                return row;
            }

            function openRuleEditor({ rule = null, onSave } = {}) {
                const r = rule ? JSON.parse(JSON.stringify(rule)) : { id: null, name: '', domain: window.location.hostname || '', enabled: true, delete_once: [], delete_forever: [] };
                const container = el('div', {});
                const form = el('div', { style: { display: 'grid', gap: '8px' } });
                const nameInput = el('input', { style: { width: '100%', padding: '8px', borderRadius: '8px' }, value: r.name, placeholder: 'Rule name (optional)' });
                const domainInput = el('input', { style: { width: '100%', padding: '8px', borderRadius: '8px' }, value: r.domain || '', placeholder: 'domain match (e.g. example.com or *.example.com)' });
                const enabledToggleWrap = el('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } }, 'Enabled');
                const enabledToggle = createToggle(Boolean(r.enabled), v => r.enabled = v);
                enabledToggle.set(Boolean(r.enabled));
                enabledToggleWrap.appendChild(enabledToggle.el);
                if (!r.selectors) {
                    r.selectors = [
                        ...(r.selectors || []).map(s => ({ name: '', selector: s, mode: 'once' })),
                        ...(r.selectors || []).map(s => ({ name: '', selector: s, mode: 'forever' }))
                    ];
                }

                form.appendChild(el('div', {}, 'Name'));
                form.appendChild(nameInput);
                form.appendChild(el('div', {}, 'Domain (pattern)'));
                form.appendChild(domainInput);
                form.appendChild(enabledToggleWrap);
                const selectorList = el('div', {
                    className: 'selector-list',
                    style: { display: 'flex', flexDirection: 'column', gap: '8px' }
                });
                function createSelectorRow(sel, onDelete) {
                    const row = el('div', {
                        className: 'selector-row',
                        style: {
                            display: 'grid',
                            gridTemplateColumns: '1fr 1fr auto auto',
                            gap: '8px',
                            alignItems: 'center',
                            padding: '6px 0'
                        }
                    });
                    const nameInput = el('input', {
                        type: 'text',
                        value: sel.name || '',
                        placeholder: 'Name',
                        className: 'vm-input'
                    });
                    nameInput.oninput = () => sel.name = nameInput.value;
                    const selectorInput = el('input', {
                        type: 'text',
                        value: sel.selector || '',
                        placeholder: 'CSS selector',
                        className: 'vm-input'
                    });
                    selectorInput.oninput = () => sel.selector = selectorInput.value;
                    const modeToggle = (() => {
                        const btn = createButton('', {
                            onClick: () => {
                                sel.mode = sel.mode === 'forever' ? 'once' : 'forever';
                                update();
                            }
                        });
                        btn.style.padding = '6px 12px';
                        btn.style.fontSize = '13px';
                        btn.style.minWidth = '86px';

                        function update() {
                            if (sel.mode === 'forever') {
                                btn.textContent = 'Multiple';
                                btn.classList.remove('ghost');
                                btn.classList.add('primary'); // filled accent style
                            } else {
                                btn.textContent = 'Once';
                                btn.classList.add('ghost');
                                btn.classList.remove('primary');
                            }
                        }

                        update();
                        return { el: btn };
                    })();



                    // Delete icon
                    const deleteBtn = el('button', {
                        className: 'vm-btn ghost',
                        style: { padding: '4px 8px', color: 'var(--vm-red)' }
                    }, '🗑️');
                    deleteBtn.onclick = () => {
                        if (typeof onDelete === 'function') onDelete();
                    };

                    row.appendChild(nameInput);
                    row.appendChild(selectorInput);
                    row.appendChild(modeToggle.el);
                    row.appendChild(deleteBtn);

                    return row;
                }


                function renderSelectors() {
                    selectorList.innerHTML = '';
                    r.selectors.forEach((sel, index) => {
                        selectorList.appendChild(createSelectorRow(sel, () => {
                            r.selectors.splice(index, 1);
                            renderSelectors();
                        }));
                    });
                }

                const addSelectorBtn = el('button', { className: 'vm-btn ghost' }, 'Add selector');
                addSelectorBtn.onclick = () => {
                    r.selectors.push({ name: '', selector: '', mode: 'once' });
                    renderSelectors();
                };

                form.appendChild(el('div', {}, 'Selectors'));
                form.appendChild(selectorList);
                form.appendChild(addSelectorBtn);

                renderSelectors();

                container.appendChild(form);
                openPopup({
                    title: rule ? 'Edit Rule' : 'Add Rule',
                    content: container,
                    actions: [
                        { label: 'Cancel', ghost: true, onClick: async () => { } },
                        {
                            label: 'Save', onClick: async () => {
                                const domainVal = domainInput.value.trim();

                                // 1. Empty domain → highlight + message, block save
                                if (!domainVal) {
                                    domainInput.style.border = '2px solid red';
                                    showToast('Domain cannot be empty!', { timeout: 2000 });
                                    return;
                                } else {
                                    domainInput.style.border = '';
                                }

                                const newRule = {
                                    id: r.id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
                                    name: nameInput.value.trim() || null,
                                    domain: domainVal,
                                    enabled: Boolean(r.enabled),
                                    selectors: r.selectors.map(s => ({
                                        name: s.name?.trim() || '',
                                        selector: s.selector?.trim() || '',
                                        mode: s.mode === 'forever' ? 'forever' : 'once'
                                    }))
                                };

                                // Pass to next merge-handler
                                if (typeof onSave === 'function') await onSave(newRule);
                            }
                        }

                    ]
                });
            }

            // ---------- Rules management (load/save) ----------
            async function loadRules() {
                try {
                    const raw = await GM.getValue(RULES_KEY);
                    if (!raw) return [];
                    const parsed = (typeof raw === 'string') ? JSON.parse(raw) : raw;
                    if (!Array.isArray(parsed)) return [];
                    return parsed;
                } catch (e) { return []; }
            }
            async function saveRules(rules) {
                try {
                    await GM.setValue(RULES_KEY, JSON.stringify(rules));
                    showToast('Rules saved');
                    // refresh engine to immediately apply
                    try { if (window.__vm_refreshEngine) window.__vm_refreshEngine(); } catch (e) { }
                } catch (e) {
                    showToast('Failed to save rules', { timeout: 2000 });
                }
            }

            async function updateSetting(key, value, { show = true, refreshEngine = false } = {}) {
                try {
                    CONFIG[key] = value;
                    await GM.setValue(key, value);
                } catch (e) {
                }

                if (key === 'theme_mode' || key === 'accent_color') {
                    applyThemeVars({ fade: true });
                }
                if (key === 'mutation_debounce_interval') {
                    refreshEngine = true;
                }
                if (key === 'url_periodic_check' || key === 'url_periodic_check_interval') {
                    refreshEngine = true;
                }
                if (key === 'disable_script') {
                    refreshEngine = true;
                }
                if (key === 'debug_mode') {
                    debug = Boolean(CONFIG.debug_mode);
                }
                if (show && CONFIG.notifications_active !== false) {
                    try { showToast(`${key} set to ${String(value)}`, { timeout: 1100 }); } catch (e) { }
                }

                if (refreshEngine) {
                    try { if (window.__vm_refreshEngine) window.__vm_refreshEngine(); } catch (e) { }
                }
            }

            // ---------- Main window rendering ----------
            async function renderMainWindow() {
                ensureStyles();
                const root = ensureRoot();
                const main = q(`#${ROOT_ID} #${MAIN_WIN_ID}`);
                main.innerHTML = '';

                // header
                const header = el('div', { class: 'vm-header' });
                header.appendChild(el('div', { class: 'vm-title' }, 'VM Deletion Engine'));
                const tabs = el('div', { class: 'vm-tabs' });
                const tabNames = ['Status', 'Rules', 'Settings'];
                const tabEls = [];
                let active = 0;
                // content container
                const body = el('div', { class: 'vm-body' });

                function activateTab(i) {
                    active = i;
                    tabEls.forEach((t, idx) => {
                        if (idx === i) t.classList.add('active'); else t.classList.remove('active');
                    });
                    // render content
                    body.innerHTML = '';
                    if (i === 0) renderStatus(body);
                    if (i === 1) renderRules(body);
                    if (i === 2) renderSettings(body);
                }

                tabNames.forEach((name, i) => {
                    const t = el('button', { class: 'vm-tab' }, name);
                    t.addEventListener('click', () => activateTab(i));
                    tabs.appendChild(t);
                    tabEls.push(t);
                });

                header.appendChild(tabs);
                main.appendChild(header);
                main.appendChild(body);
                // open default tab
                activateTab(0);
                return { main, header, body, activateTab };
            }

            // ---------- Status tab ----------
            function renderStatus(container) {
                const statsCard = el('div', { class: 'vm-card' });
                const statsRow = el('div', { class: 'vm-stats' });

                const counts = window.__vm_getDeletedCounts ? window.__vm_getDeletedCounts() : { once: 0, forever: 0 };

                // Create stat elements with reference to .num elements for future updates
                const onceStat = el('div', { class: 'stat once-count' },
                    el('div', { class: 'num' }, counts.once),
                    el('div', { class: 'label' }, 'Deleted (once)')
                );
                const foreverStat = el('div', { class: 'stat forever-count' },
                    el('div', { class: 'num' }, counts.forever),
                    el('div', { class: 'label' }, 'Deleted (forever)')
                );

                const urlInfo = el('div', { class: 'stat' },
                    el('div', { style: { fontSize: '13px', fontWeight: '700' } }, 'Current URL'),
                    el('div', { class: 'rule-domain' }, window.location.href)
                );

                statsRow.appendChild(onceStat);
                statsRow.appendChild(foreverStat);
                statsRow.appendChild(urlInfo);

                statsCard.appendChild(statsRow);
                container.appendChild(statsCard);

                // Now we have references to the num elements for once and forever stats
                const onceCountElement = onceStat.querySelector('.num');
                const foreverCountElement = foreverStat.querySelector('.num');

                // Update the UI on deletion events
                window.addEventListener('vm-deleted-once', (event) => {
                    if (event.detail) {
                        onceCountElement.textContent = event.detail.count; // Update the once count
                    }
                });

                window.addEventListener('vm-deleted-forever', (event) => {
                    if (event.detail) {
                        foreverCountElement.textContent = event.detail.count; // Update the forever count
                    }
                });
            }


            function mergeSelectors(oldRule, newRule) {
                const merged = JSON.parse(JSON.stringify(oldRule));

                const map = new Map();

                // Load old selectors
                for (const sel of merged.selectors) {
                    const key = sel.selector.trim();
                    if (!key) continue;
                    map.set(key, { ...sel });
                }

                // Merge / override with new selectors
                for (const sel of newRule.selectors) {
                    const key = sel.selector.trim();
                    if (!key) continue;

                    // If same CSS selector exists, override entire entry (both once/forever)
                    map.set(key, { ...sel });
                }

                merged.selectors = Array.from(map.values());
                merged.enabled = newRule.enabled; // optional: sync enabled state

                return merged;
            }

            // ---------- Rules tab ----------
            async function renderRules(container) {
                const card = el('div', { class: 'vm-card' });
                const headerRow = el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' } });
                headerRow.appendChild(el('div', { style: { fontWeight: 700 } }, 'Rules'));
                const addBtn = createButton('Add Rule', {
                    onClick: async () => {
                        openRuleEditor({
                            rule: null, onSave: async (newRule) => {
                                const rules = await loadRules();
                                const existing = rules.find(r => r.domain === newRule.domain);
                                if (existing) {
                                    const merged = mergeSelectors(existing, newRule);
                                    const idx = rules.indexOf(existing);
                                    rules[idx] = merged;
                                    showToast('Merged with existing rule', { timeout: 1800 });
                                } else {
                                    rules.push(newRule);
                                }
                                await saveRules(rules);
                                await refreshRulesView();
                            }
                        });
                    }
                });
                headerRow.appendChild(addBtn);
                card.appendChild(headerRow);
                const listWrap = el('div', { class: 'rules-list' });
                card.appendChild(listWrap);
                container.appendChild(card);

                async function refreshRulesView() {
                    listWrap.innerHTML = '';
                    const rules = await loadRules();
                    if (rules.length === 0) {
                        listWrap.appendChild(el('div', { class: 'rule-row' }, 'No rules defined for this site.'));
                        return;
                    }
                    rules.forEach((r, idx) => {
                        const row = buildRuleRow(r, idx, async (rule, i) => {
                            openRuleEditor({
                                rule, onSave: async (updated) => {
                                    const all = await loadRules();
                                    all[i] = updated;
                                    await saveRules(all);
                                    await refreshRulesView();
                                }
                            });
                        }, async (rule, i) => {
                            openPopup({
                                title: 'Delete rule?',
                                content: el('div', {}, `Delete "${rule.name || rule.domain || 'rule'}"? This action cannot be undone.`),
                                actions: [
                                    { label: 'Cancel', ghost: true, onClick: async () => { } },
                                    {
                                        label: 'Delete', onClick: async () => {
                                            const all = await loadRules();
                                            all.splice(i, 1);
                                            await saveRules(all);
                                            await refreshRulesView();
                                        }
                                    }
                                ]
                            });
                        }, async (v) => {
                            const all = await loadRules();
                            if (all[idx]) {
                                all[idx].enabled = v;
                                await saveRules(all);
                                await refreshRulesView();
                            }
                        });

                        // Listen to the events and update the counts for each rule dynamically
                        window.addEventListener('vm-deleted-once', (event) => {
                            console.log('vm-deleted-once event triggered', event.detail);
                            if (event.detail.ruleName === r.name) {
                                const onceCountElement = row.querySelector('.once-count');
                                onceCountElement.querySelector('.num').textContent = event.detail.count;
                            }
                        });

                        window.addEventListener('vm-deleted-forever', (event) => {
                            console.log('vm-deleted-forever event triggered', event.detail);
                            if (event.detail.ruleName === r.name) {
                                const foreverCountElement = row.querySelector('.forever-count');
                                foreverCountElement.querySelector('.num').textContent = event.detail.count;
                            }
                        });

                        listWrap.appendChild(row);
                    });
                }

                await refreshRulesView();
            }


            // ---------- Settings tab ----------
            function renderSettings(container) {
                const card = el('div', { class: 'vm-card' });
                const grid = el('div', { class: 'settings-grid' });

                // helper to create a setting item
                function settingItem(labelText, controlEl, desc = '') {
                    const wrap = el('div', { class: 'setting' });
                    wrap.appendChild(el('div', { style: { fontWeight: 700 } }, labelText));
                    wrap.appendChild(controlEl);
                    if (desc) wrap.appendChild(el('div', { style: { fontSize: '12px', color: 'var(--vm-muted)' } }, desc));
                    return wrap;
                }

                // toggles: debug_mode, notifications_active, url_periodic_check, disable_script
                const toggles = ['debug_mode', 'notifications_active', 'url_periodic_check', 'disable_script'];
                toggles.forEach(key => {
                    const current = Boolean(CONFIG[key]);
                    const { el: tEl, set } = createToggle(current, async (v) => {
                        // use unified updateSetting to ensure instant effect + persistence
                        await updateSetting(key, v, { show: true, refreshEngine: (key === 'url_periodic_check' || key === 'disable_script') });
                    });
                    const s = settingItem(key.replace(/_/g, ' '), tEl, '');
                    grid.appendChild(s);
                });

                // theme_mode toggle (light/dark)
                const themeToggleWrap = el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } });
                const themeBtn = createButton(CONFIG.theme_mode === 'dark' ? 'Dark' : 'Light', {
                    onClick: async () => {
                        const next = CONFIG.theme_mode === 'dark' ? 'light' : 'dark';
                        await updateSetting('theme_mode', next, { show: true });
                        // update button label after apply
                        themeBtn.textContent = next === 'dark' ? 'Dark' : 'Light';
                    }
                });
                themeToggleWrap.appendChild(themeBtn);
                grid.appendChild(settingItem('Theme Mode', themeToggleWrap, 'Switch UI theme [Light / Dark]'));

                // accent color input (text color or color picker)
                const colorWrap = el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } });
                const colorInput = el('input', { type: 'color', value: (CONFIG.accent_color && isHex(CONFIG.accent_color)) ? CONFIG.accent_color : '#1f4ed8', style: { width: '48px', height: '34px', borderRadius: '8px', padding: '2px' } });
                const colorText = el('input', { style: { padding: '8px', borderRadius: '8px', flex: '1' }, value: CONFIG.accent_color || '' });
                colorWrap.appendChild(colorInput);
                colorWrap.appendChild(colorText);
                // sync color input and text - use updateSetting for instant application
                colorInput.addEventListener('input', simpleDebounce(async () => {
                    const v = colorInput.value;
                    colorText.value = v;
                    await updateSetting('accent_color', v, { show: true });
                }, 60));
                colorText.addEventListener('change', simpleDebounce(async () => {
                    const v = colorText.value || SETTINGS_DEFAULTS.accent_color;
                    colorInput.value = (isHex(v) ? v : SETTINGS_DEFAULTS.accent_color);
                    await updateSetting('accent_color', v, { show: true });
                }, 100));
                grid.appendChild(settingItem('Accent Color', colorWrap, 'Theme main color; use pallet to pick (hex or keyword)'));

                const urlDeb = el('input', { type: 'number', value: CONFIG.url_periodic_check_interval || SETTINGS_DEFAULTS.url_periodic_check_interval, style: { padding: '8px', borderRadius: '8px' } });
                urlDeb.addEventListener('change', simpleDebounce(async () => {
                    const v = clamp(Number(urlDeb.value) || SETTINGS_DEFAULTS.url_periodic_check_interval, 100, 60000);
                    await updateSetting('url_periodic_check_interval', v, { show: true, refreshEngine: true });
                }, 200));
                grid.appendChild(settingItem('URL Periodic Check Interval (ms)', urlDeb, 'Polling interval when periodic check is enabled'));

                const mutDeb = el('input', { type: 'number', value: CONFIG.mutation_debounce_interval || SETTINGS_DEFAULTS.mutation_debounce_interval, style: { padding: '8px', borderRadius: '8px' } });
                mutDeb.addEventListener('change', simpleDebounce(async () => {
                    const v = clamp(Number(mutDeb.value) || SETTINGS_DEFAULTS.mutation_debounce_interval, 20, 5000);
                    await updateSetting('mutation_debounce_interval', v, { show: true, refreshEngine: true });
                }, 200));
                grid.appendChild(settingItem('Page Changes Scan Interval (ms)', mutDeb, 'Delay before processing modified page contents'));

                const refreshWrap = el('div', { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' } });
                const refreshBtn = createButton('Refresh Engine', {
                    onClick: async () => {
                        try { await window.__vm_refreshEngine(); showToast('Engine refreshed'); } catch (e) { showToast('Refresh failed'); }
                    }
                });
                refreshWrap.appendChild(refreshBtn);
                card.appendChild(grid);
                card.appendChild(el('div', { style: { marginTop: '12px', display: 'flex', justifyContent: 'flex-end' } }, refreshBtn));
                container.appendChild(card);

                // small helper to detect hex color
                function isHex(v) { return /^#([0-9A-F]{3}){1,2}$/i.test(v); }
            }

            // ---------- Floating button behavior ----------
            function wireFloatingButton(mainUi) {
                const floatBtn = q(`#${ROOT_ID} #${FLOAT_BTN_ID}`);
                const main = q(`#${ROOT_ID} #${MAIN_WIN_ID}`);
                let open = false;
                function setOpen(v) { open = v; if (open) main.classList.add('open'); else main.classList.remove('open'); }
                floatBtn.addEventListener('click', (e) => { setOpen(!open); });
                // click outside to close
                document.addEventListener('click', (ev) => {
                    if (!main.contains(ev.target) && !floatBtn.contains(ev.target)) {
                        setOpen(false);
                    }
                });
            }

            // ---------- Bootstrapping the UI ----------
            async function start() {
                ensureStyles();
                applyThemeVars({ fade: false }); // initial apply, no fade on first render
                const root = ensureRoot();
                // render main window
                const rendered = await renderMainWindow();
                // wire floating button toggling
                wireFloatingButton(rendered);
                // expose a small API
                return {
                    showToast,
                    openPopup,
                    renderMainWindow: async () => {
                        await renderMainWindow();
                    }
                };
            }

            // ---------- Initialization ----------
            const apiPromise = start();
            // Expose API after done
            const exported = {};
            apiPromise.then(api => {
                Object.assign(exported, api);
            });
            return { start, get api() { return exported; } };
        })();

        // attach to window for external use
        window.__vm_ui = UI;

        // Start (initUI was awaited by bootstrap originally, keep same contract)
        await UI.start();
    }


    async function bootstrap() {
        debugLog('🚀 Bootstrapping...');
        await loadAndInitializeSettings();
        // run the engine once DOM is ready
        if (document.body) {
            runEngine();
        } else {
            document.addEventListener('DOMContentLoaded', runEngine, { once: true });
        }
        await initUI();
        debugLog('✅ Bootstrapped.');
    }

    // auto-start
    bootstrap().catch(console.error);

})();
