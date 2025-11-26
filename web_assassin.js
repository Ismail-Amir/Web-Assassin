// ==UserScript==
// @name        Web Assassin
// @namespace   Violentmonkey Scripts
// @author      Ismail Amir
// @match       *://*/*
// @include     file:///*
// @grant       none
// @version     1.0
// @author      -
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.deleteValue
// @grant        GM.listValues
// @grant        GM.info
// @grant        GM_registerMenuCommand
// @grant        GM.addValueChangeListener
// ==/UserScript==

(() => {
    /**
     * Web Assassin UI IIFE
     * - Exposes initUI() on window as window.webAssassinInitUI
     * - Immediately bootstraps a single instance (window.webAssassinUI)
     * - All UI is inside a shadow root to avoid CSS collisions
     *
     * Key public events:
     * - window.dispatchEvent(new CustomEvent('web-assassin:refresh-engine'))
     * - window.dispatchEvent(new CustomEvent('web-assassin:settings-changed', { detail: settings }))
     * - UI listens for deletion events via window.addEventListener('web-assassin:deleted-element', ...)
     *
     * NOTE: This file includes placeholder/developer hooks for the deletion engine which should be implemented later.
     */

    // ----------------------
    // Defaults & schema
    // ----------------------
    const DEFAULT_SETTINGS = {
        theme: {
            mode: "light",
            light: {
                accent: "#5a8ead",
                background: "#ffffff",
                background2: "#f8fafc",
                background3: "#b0b6bb",
                foreground: "#0f172a",
                glass: "var(--vm-border)",
                border: "rgba(0,0,0,0.08)",
            },
            dark: {
                accent: "#4144be",
                background: "#0b1220",
                background2: "#111827",
                background3: "#1f2937",
                foreground: "#e6eef8",
                glass: "rgba(255,255,255,0.03)",
                border: "rgba(255,255,255,0.08)",
            },
            rounded: "12px",
            // modern, good-looking UI font stored under theme.font
            font: 'Inter, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
        },
        toastsEnabled: true,
        statsEnabled: false,
        ui: {
            lastTab: "rules",
            language: "en",
        },
        deletionSettings: {
            scriptDisabled: false,
            mutationObserverDebounceInterval: 250,
            peridoicURLCheck: false,
            peridoicURLCheckInterval: 5000,
            peridoicURLMutationDebounce: 250,
            deletionRules: [
                // sample rules left empty on init
            ],
            url_debounce_interval: 1000,
            temporaryDeletionMin: 500,
            temporaryDeletionMax: 3000,
        },
        // storage for aggregated totals if needed outside per-rule counters
        statistics: {},
    };

    const GM_KEY = "web_assassin_settings";

    // ----------------------
    // GM storage wrappers (fall back to localStorage for dev/testing)
    // ----------------------
    async function gmGet(key, fallback = null) {
        try {
            if (typeof GM?.getValue === "function") {
                return await GM.getValue(key, fallback);
            }
            // Violentmonkey/others may expose GM.getValue as promise; ignore for now.
            if (typeof GM?.getValue === "function") {
                return await GM.getValue(key, fallback);
            }

        } catch (e) {
            // ignore and fallback
        }
        try {
            const raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : fallback;
        } catch (e) {
            return fallback;
        }
    }

    async function gmSet(key, value) {
        try {
            if (typeof GM?.setValue === "function") {
                await GM.setValue(key, value);
                return;
            }
        } catch (e) {
            // fallback
        }
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch (e) {
            console.warn("Failed to persist settings to localStorage", e);
        }
    }

    // ----------------------
    // Utilities (domain parsing, id gen, CSS generation)
    // ----------------------
    function getDomain(URLInput) {
        // --- Helpers Extracted from Original Function ---

        // Helper to validate if a string is a standard IPv4 address.
        function isValidIpAddress(str) {
            return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(str);
        }

        // Helper to normalize file path strings (e.g., "file:///C:/..." or "C:\...").
        function normalizeFilePath(path) {
            let n = String(path).toLowerCase();
            // Strip "file:" protocol prefix and leading slashes
            if (n.startsWith("file:")) {
                n = n.replace(/^file:(\/+)?/, "");
            }
            // Handle Windows-style paths that might start with a slash (e.g., /C:/...)
            if (n.startsWith("/") && n[2] === ":") {
                n = n.slice(1);
            }
            // Unify path separators to forward slashes
            return n.replace(/\\/g, "/");
        }

        // --- Main Logic ---

        if (!URLInput) {
            return "";
        }

        const inputStr = String(URLInput).trim();

        // First, try to treat the input as a full URL.
        try {
            const url = new URL(inputStr);

            // Case 1: The URL is a file path.
            if (url.protocol === "file:") {
                // Use the dedicated file path normalizer on the original string,
                // as URL parsing can sometimes alter it.
                return normalizeFilePath(inputStr);
            }

            // Case 2: It's a standard web URL (http, https, etc.).
            let hostname = url.hostname.toLowerCase();

            // Normalize IPv6 addresses by removing brackets.
            if (hostname.startsWith("[") && hostname.endsWith("]")) {
                hostname = hostname.slice(1, -1);
            }
            return hostname;

        } catch {
            // If new URL() fails, the input is not a full, valid URL.
            // It could be a bare domain, IP address, or local file path string.
            const candidate = inputStr.toLowerCase();

            // The part of the string before a colon, for checking IPs like "127.0.0.1:8080".
            const baseCandidate = candidate.split(":")[0];

            // Case 3: It's an IP address (with or without a port).
            if (isValidIpAddress(baseCandidate)) {
                return baseCandidate; // Return only the IP part.
            }

            // Case 4: It's a file path string (e.g., "C:\Users\...").
            // The presence of a colon (after the IP check fails) or backslashes
            // is a strong indicator of a Windows file path.
            if (candidate.includes(":") || candidate.includes("\\")) {
                return normalizeFilePath(candidate);
            }

            // Case 5: It's a bare domain or hostname. Return it as is (trimmed and lowercased).
            // Note: A domain with a path like 'example.com/foo' will fall through to here.
            // The original function's logic only stripped the path from the 'domainOfRule',
            // not 'pageDomain' in this scenario, so we return the full candidate.
            return candidate.split("/")[0];
        }
    }


    // Domain matching: wildcard if ruleDomain contains '*', otherwise exact
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

    function genId(prefix = "rule") {
        const rnd = Math.random().toString(36).slice(2, 9);
        return `${prefix}-${Date.now().toString(36)}-${rnd}`;
    }

    function normalizeSelectorString(s) {
        if (!s) return "";
        return s.trim().replace(/\s+/g, " ");
    }

    function generateCssSelector(el) {
        // Robust, but simple generator:
        // - If element has ID and it's unique in document -> use #id
        // - else build path with tag + classes and nth-of-type as necessary
        if (!el || el.nodeType !== 1) return "";
        const doc = document;
        if (el.id) {
            const query = `#${CSS.escape(el.id)}`;
            try {
                const found = doc.querySelectorAll(query);
                if (found.length === 1) return query;
            } catch (e) {
                // ignore
            }
        }

        // build path of up to 5 segments
        const parts = [];
        let node = el;
        for (let depth = 0; node && node.nodeType === 1 && depth < 6; depth++, node = node.parentElement) {
            let part = node.tagName.toLowerCase();
            if (node.classList && node.classList.length) {
                // take only first two classes to keep selector readable
                const cls = Array.from(node.classList).slice(0, 2).map((c) => "." + CSS.escape(c)).join("");
                part += cls;
            }
            // nth-of-type fallback for uniqueness
            try {
                const siblings = node.parentElement ? Array.from(node.parentElement.children).filter((c) => c.tagName === node.tagName) : [];
                if (siblings.length > 1) {
                    const idx = siblings.indexOf(node) + 1;
                    part += `:nth-of-type(${idx})`;
                }
            } catch (e) { }
            parts.unshift(part);
            try {
                const sel = parts.join(" > ");
                if (doc.querySelectorAll(sel).length === 1) return sel;
            } catch (e) { }
        }
        // fallback to tag.class path
        try {
            const fallback = parts.join(" > ");
            if (fallback) return fallback;
        } catch (e) { }
        // ultimate fallback
        try {
            return el.tagName.toLowerCase();
        } catch (e) {
            return "";
        }
    }

    // ----------------------
    // Rule management core (isolated module)
    // ----------------------
    function RuleManager(initialSettings) {
        // state
        let settings = initialSettings || JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
        // ensure certain paths exist
        settings.deletionSettings = settings.deletionSettings || DEFAULT_SETTINGS.deletionSettings;
        settings.deletionSettings.deletionRules = settings.deletionSettings.deletionRules || [];

        function getAllRules() {
            return settings.deletionSettings.deletionRules;
        }

        function findRuleByDomain(domainOrUrl) {
            const target = getDomain(domainOrUrl);
            if (!target) return null;
            return getAllRules().find((r) => domainMatches(r.domain, target));
        }

        function findRuleByID(id) {
            return getAllRules().find((r) => r.ID === id) || null;
        }

        function addRule(ruleObj) {
            // assume ruleObj has domain; ensure unique ID
            if (!ruleObj.ID) ruleObj.ID = genId("rule");
            // ensure counters exist
            ruleObj.tempDeleteCount = ruleObj.tempDeleteCount || 0;
            ruleObj.permanentDeleteCount = ruleObj.permanentDeleteCount || 0;
            // normalize selectors
            ruleObj.tempSelectors = Array.isArray(ruleObj.tempSelectors) ? ruleObj.tempSelectors.map(normalizeSelectorItem) : [];
            ruleObj.permanentSelectors = Array.isArray(ruleObj.permanentSelectors) ? ruleObj.permanentSelectors.map(normalizeSelectorItem) : [];

            // ensure no duplicate selectors within this new rule
            ruleObj.tempSelectors = dedupeSelectorsArray(ruleObj.tempSelectors);
            ruleObj.permanentSelectors = dedupeSelectorsArray(ruleObj.permanentSelectors);

            // Ensure a selector does not exist in both temp and permanent for the same rule.
            // If a selector appears in both, prefer the permanent variant (store under perm only).
            const permSet = new Set((ruleObj.permanentSelectors || []).map(it => normalizeSelectorString(it.selector)));
            if (permSet.size) {
                ruleObj.tempSelectors = (ruleObj.tempSelectors || []).filter(it => !permSet.has(normalizeSelectorString(it.selector)));
            }

            // IMPORTANT: ensure deletionRules key exists and mirrors selector arrays.
            ruleObj.deletionRules = ruleObj.deletionRules || { enabled: true, temp: [], perm: [] };
            ruleObj.deletionRules.enabled = (ruleObj.deletionRules.enabled !== false); // default true
            ruleObj.deletionRules.temp = ruleObj.tempSelectors.map(it => ({ name: it.name || "", selector: it.selector }));
            ruleObj.deletionRules.perm = ruleObj.permanentSelectors.map(it => ({ name: it.name || "", selector: it.selector }));

            // Remove any selector collisions from other rules (merge semantics)
            for (const it of ruleObj.tempSelectors) removeSelectorFromOtherRules(it.selector, ruleObj.ID);
            for (const it of ruleObj.permanentSelectors) removeSelectorFromOtherRules(it.selector, ruleObj.ID);

            settings.deletionSettings.deletionRules.push(ruleObj);
            persist();
            return ruleObj;
        }

        function normalizeSelectorItem(item) {
            return {
                name: item.name ? String(item.name) : "",
                selector: normalizeSelectorString(item.selector || ""),
            };
        }

        // Add dedupeSelectorsArray helper (was accidentally removed)
        function dedupeSelectorsArray(arr) {
            const seen = new Set();
            const out = [];
            for (const it of arr || []) {
                const sel = normalizeSelectorString(it.selector);
                if (!sel) continue;
                if (seen.has(sel)) continue;
                seen.add(sel);
                out.push({ name: it.name || "", selector: sel });
            }
            return out;
        }

        // Remove a selector (normalized) from all rules except the optional excludeId
        function removeSelectorFromOtherRules(selector, excludeId = null) {
            const selNorm = normalizeSelectorString(selector);
            if (!selNorm) return;
            const rules = settings.deletionSettings.deletionRules || [];
            let changed = false;
            for (const r of rules) {
                if (!r || !r.ID) continue;
                if (excludeId && r.ID === excludeId) continue;
                // remove from tempSelectors
                if (Array.isArray(r.tempSelectors)) {
                    const before = r.tempSelectors.length;
                    r.tempSelectors = r.tempSelectors.filter((it) => normalizeSelectorString(it.selector) !== selNorm);
                    if (r.tempSelectors.length !== before) changed = true;
                }
                // remove from permanentSelectors
                if (Array.isArray(r.permanentSelectors)) {
                    const before = r.permanentSelectors.length;
                    r.permanentSelectors = r.permanentSelectors.filter((it) => normalizeSelectorString(it.selector) !== selNorm);
                    if (r.permanentSelectors.length !== before) changed = true;
                }
                // keep deletionRules in sync if present
                r.deletionRules = r.deletionRules || { enabled: true, temp: [], perm: [] };
                r.deletionRules.temp = (r.tempSelectors || []).map(it => ({ name: it.name || "", selector: it.selector }));
                r.deletionRules.perm = (r.permanentSelectors || []).map(it => ({ name: it.name || "", selector: it.selector }));
            }
            if (changed) persist();
        }

        function updateRuleByID(id, patchObj) {
            const r = findRuleByID(id);
            if (!r) return null;
            // update allowed fields
            r.name = patchObj.name !== undefined ? patchObj.name : r.name;
            r.domain = patchObj.domain !== undefined ? patchObj.domain : r.domain;

            // update selectors and keep deletionRules in sync
            if (patchObj.tempSelectors) {
                r.tempSelectors = patchObj.tempSelectors.map(normalizeSelectorItem);
                // dedupe within the rule
                r.tempSelectors = dedupeSelectorsArray(r.tempSelectors);
                // remove these selectors from other rules (merge)
                for (const it of r.tempSelectors) removeSelectorFromOtherRules(it.selector, r.ID);
                // ensure these temp selectors are NOT present in this rule's permanentSelectors
                const tempSet = new Set(r.tempSelectors.map(it => normalizeSelectorString(it.selector)));
                if (Array.isArray(r.permanentSelectors)) {
                    r.permanentSelectors = r.permanentSelectors.filter((it) => !tempSet.has(normalizeSelectorString(it.selector)));
                }
                r.deletionRules = r.deletionRules || { enabled: true, temp: [], perm: [] };
                r.deletionRules.temp = r.tempSelectors.map(it => ({ name: it.name || "", selector: it.selector }));
                r.deletionRules.perm = (r.permanentSelectors || []).map(it => ({ name: it.name || "", selector: it.selector }));
            }
            if (patchObj.permanentSelectors) {
                r.permanentSelectors = patchObj.permanentSelectors.map(normalizeSelectorItem);
                // dedupe within the rule
                r.permanentSelectors = dedupeSelectorsArray(r.permanentSelectors);
                // remove these selectors from other rules (merge)
                for (const it of r.permanentSelectors) removeSelectorFromOtherRules(it.selector, r.ID);
                // ensure these perm selectors are NOT present in this rule's tempSelectors
                const permSet2 = new Set(r.permanentSelectors.map(it => normalizeSelectorString(it.selector)));
                if (Array.isArray(r.tempSelectors)) {
                    r.tempSelectors = r.tempSelectors.filter((it) => !permSet2.has(normalizeSelectorString(it.selector)));
                }
                r.deletionRules = r.deletionRules || { enabled: true, temp: [], perm: [] };
                r.deletionRules.perm = r.permanentSelectors.map(it => ({ name: it.name || "", selector: it.selector }));
                r.deletionRules.temp = (r.tempSelectors || []).map(it => ({ name: it.name || "", selector: it.selector }));
            }

            if (patchObj.ruleEnabled !== undefined) r.ruleEnabled = !!patchObj.ruleEnabled;

            // allow toggling presence/enablement of deletionRules key (keeps key present)
            if (patchObj.deletionRulesEnabled !== undefined) {
                r.deletionRules = r.deletionRules || { enabled: true, temp: [], perm: [] };
                r.deletionRules.enabled = !!patchObj.deletionRulesEnabled;
            }

            // counters: keep as-is unless provided explicitly
            if (patchObj.tempDeleteCount !== undefined) r.tempDeleteCount = patchObj.tempDeleteCount;
            if (patchObj.permanentDeleteCount !== undefined) r.permanentDeleteCount = patchObj.permanentDeleteCount;
            persist();
            return r;
        }

        function removeRuleByID(id) {
            const idx = settings.deletionSettings.deletionRules.findIndex((r) => r.ID === id);
            if (idx === -1) return false;
            settings.deletionSettings.deletionRules.splice(idx, 1);
            persist();
            return true;
        }

        function incrementCounter(ruleID, mode = "temp", amount = 1) {
            const r = findRuleByID(ruleID);
            if (!r) return;
            if (mode === "temp") r.tempDeleteCount = (r.tempDeleteCount || 0) + amount;
            else r.permanentDeleteCount = (r.permanentDeleteCount || 0) + amount;
            persist();
        }

        function persist() {
            gmSet(GM_KEY, settings);
            // notify
            window.dispatchEvent(new CustomEvent("web-assassin:settings-changed", { detail: settings }));
        }

        function setSettings(newSettings) {
            settings = newSettings;
            // normalize missing fields
            settings.deletionSettings = settings.deletionSettings || DEFAULT_SETTINGS.deletionSettings;
            settings.deletionSettings.deletionRules = settings.deletionSettings.deletionRules || [];

            // ensure theme and theme.font exist so UI can always read theme.font
            settings.theme = settings.theme || {};
            settings.theme.mode = settings.theme.mode || DEFAULT_SETTINGS.theme.mode;
            settings.theme.light = settings.theme.light || DEFAULT_SETTINGS.theme.light;
            settings.theme.dark = settings.theme.dark || DEFAULT_SETTINGS.theme.dark;
            settings.theme.rounded = settings.theme.rounded || DEFAULT_SETTINGS.theme.rounded;
            settings.theme.font = settings.theme.font || DEFAULT_SETTINGS.theme.font;

            persist();
        }

        function getSettings() {
            return settings;
        }

        function mergeRules(savedRule, unsavedRule) {
            // Merge semantics per your spec:
            // - Append new unique elements (by selector string) from unsaved to saved
            // - If a selector exists in saved (either temp or permanent) and also in unsaved, remove old and replace with the version from unsaved
            // - Ignore counters (do not change saved counters)
            const s = savedRule;
            const u = unsavedRule;

            const existingSelectors = new Set();
            s.tempSelectors.forEach((it) => existingSelectors.add(normalizeSelectorString(it.selector)));
            s.permanentSelectors.forEach((it) => existingSelectors.add(normalizeSelectorString(it.selector)));

            // helper to remove selector string from saved arrays
            function removeFromSaved(selectorStr) {
                selectorStr = normalizeSelectorString(selectorStr);
                s.tempSelectors = s.tempSelectors.filter((it) => normalizeSelectorString(it.selector) !== selectorStr);
                s.permanentSelectors = s.permanentSelectors.filter((it) => normalizeSelectorString(it.selector) !== selectorStr);
            }

            // replace or append temp
            (u.tempSelectors || []).forEach((it) => {
                const sel = normalizeSelectorString(it.selector);
                if (!sel) return;
                // if exists in saved, remove old and append new
                removeFromSaved(sel);
                s.tempSelectors.push(normalizeSelectorItem(it));
            });

            (u.permanentSelectors || []).forEach((it) => {
                const sel = normalizeSelectorString(it.selector);
                if (!sel) return;
                removeFromSaved(sel);
                s.permanentSelectors.push(normalizeSelectorItem(it));
            });

            // ensure no duplicates within saved arrays
            s.tempSelectors = dedupeSelectorsArray(s.tempSelectors);
            s.permanentSelectors = dedupeSelectorsArray(s.permanentSelectors);

            // Keep deletionRules in sync and always present
            s.deletionRules = s.deletionRules || { enabled: true, temp: [], perm: [] };
            s.deletionRules.enabled = (s.deletionRules.enabled !== false);
            s.deletionRules.temp = s.tempSelectors.map(it => ({ name: it.name || "", selector: it.selector }));
            s.deletionRules.perm = s.permanentSelectors.map(it => ({ name: it.name || "", selector: it.selector }));

            persist();
            return s;
        }

        function saveRule(unsavedRule, mode = "add") {
            if (!unsavedRule) {
                return { status: "error", message: "No rule to save." };
            }

            // --- Normalize & Validate ---------------------------------------------

            const domainClean = getDomain(unsavedRule.domain);
            if (!domainClean) {
                return { status: "error", message: "Please provide a valid domain for the rule." };
            }

            const temp = (unsavedRule.tempSelectors || [])
                .map(normalizeSelectorItem)
                .filter(it => it.selector);

            const perm = (unsavedRule.permanentSelectors || [])
                .map(normalizeSelectorItem)
                .filter(it => it.selector);

            // dedupe incoming selectors to avoid duplicate CSS within same rule
            const tempD = dedupeSelectorsArray(temp);
            const permD = dedupeSelectorsArray(perm);

            if (temp.length + perm.length === 0) {
                return { status: "error", message: "Please add at least one selector." };
            }

            // --- Check duplicates --------------------------------------------------

            const existingByDomain = findRuleByDomain(domainClean);
            const existingById = unsavedRule.ID ? findRuleByID(unsavedRule.ID) : null;

            // ADD: domain duplication check
            if (mode === "add" && existingByDomain) {
                return {
                    status: "duplicate",
                    type: "domain",
                    existingRule: existingByDomain,
                    domain: domainClean
                };
            }

            // EDIT: domain changed to match another rule
            if (mode === "edit" && existingByDomain && existingByDomain.ID !== unsavedRule.ID) {
                return {
                    status: "duplicate",
                    type: "domain",
                    existingRule: existingByDomain,
                    domain: domainClean
                };
            }

            // --- Perform Save / Merge ----------------------------------------------

            const deletionRulesEnabled = (unsavedRule.deletionRulesEnabled !== undefined) ? !!unsavedRule.deletionRulesEnabled : true;

            if (mode === "add") {
                const newRule = {
                    ID: genId("rule"),
                    name: unsavedRule.name || "",
                    domain: domainClean,
                    tempSelectors: tempD,
                    permanentSelectors: permD,
                    tempDeleteCount: 0,
                    permanentDeleteCount: 0,
                    ruleEnabled: unsavedRule.ruleEnabled !== false,
                    // always include deletionRules key (enabled flag + arrays)
                    deletionRules: {
                        enabled: deletionRulesEnabled,
                        temp: tempD.map(it => ({ name: it.name || "", selector: it.selector })),
                        perm: permD.map(it => ({ name: it.name || "", selector: it.selector }))
                    }
                };
                // remove selector collisions from other rules (merge semantics)
                for (const it of newRule.tempSelectors) removeSelectorFromOtherRules(it.selector, newRule.ID);
                for (const it of newRule.permanentSelectors) removeSelectorFromOtherRules(it.selector, newRule.ID);

                addRule(newRule);

                return { status: "added", rule: newRule };
            }

            if (mode === "edit") {
                if (!existingById) {
                    // fallback to add
                    const newRule = {
                        ID: genId("rule"),
                        name: unsavedRule.name || "",
                        domain: domainClean,
                        tempSelectors: tempD,
                        permanentSelectors: permD,
                        tempDeleteCount: 0,
                        permanentDeleteCount: 0,
                        ruleEnabled: unsavedRule.ruleEnabled !== false,
                        deletionRules: {
                            enabled: deletionRulesEnabled,
                            temp: tempD.map(it => ({ name: it.name || "", selector: it.selector })),
                            perm: permD.map(it => ({ name: it.name || "", selector: it.selector }))
                        }
                    };
                    for (const it of newRule.tempSelectors) removeSelectorFromOtherRules(it.selector, newRule.ID);
                    for (const it of newRule.permanentSelectors) removeSelectorFromOtherRules(it.selector, newRule.ID);
                    addRule(newRule);
                    return { status: "added", rule: newRule };
                }

                // Update with deduped selectors; updateRuleByID will handle merge removal
                updateRuleByID(existingById.ID, {
                    name: unsavedRule.name,
                    domain: domainClean,
                    tempSelectors: tempD,
                    permanentSelectors: permD,
                    ruleEnabled: !!unsavedRule.ruleEnabled,
                    deletionRulesEnabled: deletionRulesEnabled
                });

                return { status: "updated", rule: findRuleByID(existingById.ID) };
            }

            return { status: "error", message: "Unknown save mode." };
        }


        return {
            getSettings,
            setSettings,
            getAllRules,
            findRuleByDomain,
            findRuleByID,
            addRule,
            updateRuleByID,
            removeRuleByID,
            incrementCounter,
            persist,
            mergeRules,
            dedupeSelectorsArray,
            saveRule,
        };
    }

    // ----------------------
    // Deletion Engine Module
    // ----------------------
    // Place this AFTER RuleManager(...) and BEFORE initUI()
    function DeletionEngine(ruleManager) {
        if (!ruleManager) throw new Error("DeletionEngine requires a ruleManager instance");

        // -------------------------------------------------------------
        // Internal State
        // -------------------------------------------------------------
        let running = false;
        let permObserver = null;
        let urlObserversInstalled = false;
        let periodicUrlTimer = null;
        let lastUrl = location.href;

        let tempStopTimer = null;
        let tempStabilizeDebounce = null;
        let permDebounceTimer = null;

        // selector → Set(ruleIDs)
        let tempSelectorMap = new Map();
        let permSelectorMap = new Map();

        const doc = document;

        // -------------------------------------------------------------
        // Helpers (fast-path)
        // -------------------------------------------------------------
        const now = () => Date.now();
        const normSel = (sel) => normalizeSelectorString(sel || "");

        function addToSelectorMap(map, selector, ruleID) {
            if (!selector) return;
            let set = map.get(selector);
            if (!set) map.set(selector, (set = new Set()));
            set.add(ruleID);
        }

        function getDeletionConfig() {
            const s = ruleManager.getSettings();
            return s?.deletionSettings || {};
        }

        // -------------------------------------------------------------
        // Aggregation of Selectors
        // -------------------------------------------------------------
        function aggregateSelectorsForCurrentPage() {
            tempSelectorMap.clear();
            permSelectorMap.clear();

            const settings = ruleManager.getSettings();
            const rules = settings?.deletionSettings?.deletionRules || [];
            const pageURL = location.href;

            for (const r of rules) {
                if (!r || !r.domain || r.ruleEnabled === false) continue;
                if (!domainMatches(r.domain, pageURL)) continue;

                if (Array.isArray(r.tempSelectors)) {
                    for (const it of r.tempSelectors) {
                        const sel = normSel(it?.selector);
                        if (sel) addToSelectorMap(tempSelectorMap, sel, r.ID);
                    }
                }
                if (Array.isArray(r.permanentSelectors)) {
                    for (const it of r.permanentSelectors) {
                        const sel = normSel(it?.selector);
                        if (sel) addToSelectorMap(permSelectorMap, sel, r.ID);
                    }
                }
            }

            return {
                tempSelectors: [...tempSelectorMap.keys()],
                permSelectors: [...permSelectorMap.keys()],
            };
        }

        // -------------------------------------------------------------
        // Stats & Event Dispatch
        // -------------------------------------------------------------
        function handleDeletionCounts(countMap, type) {
            const s = ruleManager.getSettings();
            if (!s?.statsEnabled) return;

            for (const [ruleId, count] of countMap.entries()) {
                ruleManager.incrementCounter(
                    ruleId,
                    type === "permanent" ? "permanent" : "temp",
                    count
                );

                window.dispatchEvent(
                    new CustomEvent("web-assassin:elements-deleted", {
                        detail: { ruleID: ruleId, deletionType: type, count }
                    })
                );
            }
        }

        // -------------------------------------------------------------
        // TEMPORARY PASS
        // -------------------------------------------------------------
        function runTemporaryDeletion(selectors) {
            if (!selectors || selectors.length === 0)
                return Promise.resolve({ totalDeleted: 0, perRuleCounts: new Map() });

            const cfg = getDeletionConfig();
            const maxMs = Math.max(0, Number(cfg.temporaryDeletionMax || 3000));
            const minMs = Math.max(0, Number(cfg.temporaryDeletionMin || 500));
            const mutationDebounce = Math.max(
                50,
                Number(cfg.mutationObserverDebounceInterval || 250)
            );
            const stabilizeMs = Math.max(150, Math.floor((minMs + maxMs) / 6));

            const selectorToRules = new Map();
            for (const [sel, set] of tempSelectorMap.entries()) {
                selectorToRules.set(sel, new Set(set));
            }

            const removed = new Set();
            const perRuleCounts = new Map();

            function scan() {
                for (const sel of selectors) {
                    let nodeList;
                    try {
                        nodeList = doc.querySelectorAll(sel);
                    } catch {
                        continue; // invalid selector
                    }

                    for (const el of nodeList) {
                        if (!el || !el.isConnected || removed.has(el)) continue;
                        try {
                            el.remove();
                        } catch {
                            try { el.parentNode?.removeChild(el); } catch { }
                        }
                        removed.add(el);

                        const ruleIds = selectorToRules.get(sel);
                        if (ruleIds) {
                            for (const id of ruleIds) {
                                perRuleCounts.set(id, (perRuleCounts.get(id) || 0) + 1);
                            }
                        }
                    }
                }
            }

            return new Promise((resolve) => {
                let done = false;
                scan();

                const mo = new MutationObserver(() => {
                    clearTimeout(tempStabilizeDebounce);
                    tempStabilizeDebounce = setTimeout(scan, mutationDebounce);
                });

                try {
                    mo.observe(doc.documentElement, { childList: true, subtree: true });
                } catch {
                    try {
                        mo.observe(doc.body, { childList: true, subtree: true });
                    } catch { }
                }

                function finish() {
                    if (done) return;
                    done = true;
                    try { mo.disconnect(); } catch { }
                    clearTimeout(tempStabilizeDebounce);
                    clearTimeout(tempStopTimer);
                    handleDeletionCounts(perRuleCounts, "temp");
                    resolve({ totalDeleted: removed.size, perRuleCounts });
                }

                tempStabilizeDebounce = setTimeout(finish, stabilizeMs);
                tempStopTimer = setTimeout(finish, maxMs);
            });
        }

        // -------------------------------------------------------------
        // PERMANENT PASS
        // -------------------------------------------------------------
        function startPermanentObserver(selectors) {
            const cfg = getDeletionConfig();
            const debounceMs = Math.max(
                50,
                Number(cfg.peridoicURLMutationDebounce || cfg.mutationObserverDebounceInterval || 250)
            );

            const selectorToRules = new Map();
            for (const [sel, set] of permSelectorMap.entries()) {
                selectorToRules.set(sel, new Set(set));
            }

            let queue = new Set();

            function process() {
                if (!queue.size) return;

                const nodes = [...queue];
                queue.clear();

                const removed = new Set();
                const ruleCounts = new Map();

                for (const node of nodes) {
                    if (!node) continue;

                    const roots = node.nodeType === 1 ? [node] : [];

                    for (const sel of selectors) {
                        let ruleIds = selectorToRules.get(sel);
                        if (!ruleIds) continue;

                        // Check root
                        for (const root of roots) {
                            try {
                                if (root.matches?.(sel)) {
                                    if (!removed.has(root)) {
                                        try { root.remove(); } catch {
                                            try { root.parentNode?.removeChild(root); } catch { }
                                        }
                                        removed.add(root);
                                        for (const id of ruleIds)
                                            ruleCounts.set(id, (ruleCounts.get(id) || 0) + 1);
                                    }
                                }
                            } catch { }
                        }

                        // Query children
                        let matches;
                        try {
                            matches = node.querySelectorAll?.(sel);
                        } catch {
                            continue;
                        }

                        if (!matches) continue;

                        for (const m of matches) {
                            if (!m || !m.isConnected || removed.has(m)) continue;
                            try { m.remove(); } catch {
                                try { m.parentNode?.removeChild(m); } catch { }
                            }
                            removed.add(m);
                            for (const id of ruleIds)
                                ruleCounts.set(id, (ruleCounts.get(id) || 0) + 1);
                        }
                    }
                }

                handleDeletionCounts(ruleCounts, "permanent");
            }

            function schedule() {
                clearTimeout(permDebounceTimer);
                permDebounceTimer = setTimeout(process, debounceMs);
            }

            permObserver = new MutationObserver((mutations) => {
                for (const m of mutations) {
                    for (const n of m.addedNodes) queue.add(n);
                }
                schedule();
            });

            try {
                permObserver.observe(doc.documentElement, { childList: true, subtree: true });
            } catch {
                try { permObserver.observe(doc.body, { childList: true, subtree: true }); } catch { }
            }

            return () => {
                try { permObserver.disconnect(); } catch { }
                clearTimeout(permDebounceTimer);
                permObserver = null;
            };
        }

        // -------------------------------------------------------------
        // URL Change Handling
        // -------------------------------------------------------------
        let urlChangeDebounce = null;

        function scheduleUrlChange() {
            clearTimeout(urlChangeDebounce);
            urlChangeDebounce = setTimeout(() => {
                const newUrl = location.href;
                if (newUrl !== lastUrl) {
                    lastUrl = newUrl;
                    restart();
                }
            }, 120);
        }

        function installUrlObservers() {
            if (urlObserversInstalled) return;
            urlObserversInstalled = true;

            const origPush = history.pushState;
            const origReplace = history.replaceState;

            history.pushState = function (...args) {
                const result = origPush.apply(this, args);
                scheduleUrlChange();
                return result;
            };

            history.replaceState = function (...args) {
                const result = origReplace.apply(this, args);
                scheduleUrlChange();
                return result;
            };

            window.addEventListener("popstate", scheduleUrlChange);
            window.addEventListener("hashchange", scheduleUrlChange);

            const cfg = getDeletionConfig();
            if (cfg.peridoicURLCheck) {
                periodicUrlTimer = setInterval(() => {
                    if (location.href !== lastUrl) scheduleUrlChange();
                }, Math.max(500, Number(cfg.peridoicURLCheckInterval || 5000)));
            }
        }

        function uninstallUrlObservers() {
            if (!urlObserversInstalled) return;
            urlObserversInstalled = false;

            window.removeEventListener("popstate", scheduleUrlChange);
            window.removeEventListener("hashchange", scheduleUrlChange);

            if (periodicUrlTimer) {
                clearInterval(periodicUrlTimer);
                periodicUrlTimer = null;
            }
        }

        // -------------------------------------------------------------
        // Engine Core
        // -------------------------------------------------------------
        async function start() {
            if (running) return;
            running = true;
            lastUrl = location.href;

            const cfg = getDeletionConfig();
            if (cfg.scriptDisabled) return;

            const rules = ruleManager.getAllRules() || [];
            const pageURL = location.href;

            const matchesAny =
                rules.some(r => r?.ruleEnabled !== false && domainMatches(r.domain, pageURL));

            if (!matchesAny) {
                installUrlObservers();
                return;
            }

            const { tempSelectors, permSelectors } = aggregateSelectorsForCurrentPage();

            if ((!tempSelectors.length) && (!permSelectors.length)) {
                installUrlObservers();
                return;
            }

            try {
                await runTemporaryDeletion(tempSelectors);
            } catch { }

            const stopPerm = startPermanentObserver(permSelectors);

            installUrlObservers();

            // Handed to restart()
            cleanupPermanent = stopPerm;
        }

        let cleanupPermanent = null;

        function stop() {
            running = false;
            cleanupPermanent?.();
            cleanupPermanent = null;
            clearTimeout(tempStopTimer);
            clearTimeout(tempStabilizeDebounce);
            clearTimeout(permDebounceTimer);
        }

        function restart() {
            stop();
            start();
        }

        return { start, stop, restart };
    }


    // ----------------------
    // UI core: shadow root, factory helpers, and components
    // ----------------------
    async function initUI() {
        // Try to obtain the shared RuleManager and Engine from window.
        // If they're not present yet, wait briefly for the bootstrap to set them.
        // If still missing after waiting, create fallback instances from persisted settings.
        async function waitForGlobals(timeout = 1500, interval = 100) {
            const start = Date.now();
            while (Date.now() - start < timeout) {
                if (window.webAssassinRuleManager && window.webAssassinEngine) return;
                await new Promise((r) => setTimeout(r, interval));
            }
        }

        let ruleManager = window.webAssassinRuleManager;
        let engine = window.webAssassinEngine;

        if (!ruleManager || !engine) {
            // Wait a short time for the bootstrap code to set these globals (SPA / ordering races).
            await waitForGlobals(1500, 100);
            ruleManager = window.webAssassinRuleManager;
            engine = window.webAssassinEngine;
        }

        if (!ruleManager || !engine) {
            // As a last resort, attempt to instantiate fallback instances from persisted settings.
            try {
                const saved = await gmGet(GM_KEY, JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
                const rm = RuleManager(saved);
                const eng = DeletionEngine(rm);
                window.webAssassinRuleManager = rm;
                window.webAssassinEngine = eng;
                ruleManager = rm;
                engine = eng;
                // start engine unless explicitly disabled in settings
                if (!saved.deletionSettings?.scriptDisabled) {
                    try { eng.start(); } catch (e) { /* ignore start errors */ }
                }
            } catch (err) {
                console.warn("UI init aborted: RuleManager or Engine missing.", err);
                return null;
            }
        }

        // Local per-load counters for display (not persisted)
        const perLoadCounts = new Map();

        // Utils
        const cssEscape = (s) => (typeof CSS !== "undefined" && CSS.escape) ? CSS.escape(s) : s.replace(/([ #;.<>+~:,[\]\/])/g, "\\$1");

        function qS(root, sel) { return root.querySelector(sel); }
        function qSA(root, sel) { return Array.from(root.querySelectorAll(sel)); }

        // Get current settings from ruleManager
        function getSettings() { return ruleManager.getSettings(); }

        // Theme values
        function themeVars() {
            const s = getSettings();
            const theme = s.theme || {};
            const modeKey = theme.mode === "dark" ? "dark" : "light";
            const mode = (theme && theme[modeKey]) || theme.light || {};
            // Use font from theme.font (no top-level font)
            return {
                accent: mode.accent || "#3b82f6",
                background: mode.background || "#ffffff",
                background2: mode.background2 || "#f8fafc",
                background3: mode.background3 || "#eee",
                foreground: mode.foreground || "#0f172a",
                border: mode.border || "rgba(0,0,0,0.08)",
                rounded: (theme.rounded || "12px"),
                font: (theme.font || DEFAULT_SETTINGS.theme.font)
            };
        }

        // Create host element and attach shadow root
        const hostId = "web-assassin-ui-root";
        let host = document.getElementById(hostId);
        if (host) host.remove();
        host = document.createElement("div");
        host.id = hostId;
        host.style.all = "initial";
        document.documentElement.appendChild(host);
        const shadow = host.attachShadow({ mode: "open" });

        // Base HTML structure
        const root = document.createElement("div");
        root.className = "wa-root";

        // Inject styles (centralized)
        const style = document.createElement("style");

        function buildStyles() {
            const t = themeVars();

            return `
/* -------------------------------------------------------
   Base / Font Reset
------------------------------------------------------- */
:host {
  all: initial;
  font-family: ${t.font};
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

.wa-root,
.wa-panel,
.wa-header,
.wa-title,
.wa-card,
.wa-main,
.wa-sidebar,
.wa-content,
.wa-editor-window {
  font-family: ${t.font};
}

/* Controls + Explicit Font Targets */
.wa-btn,
button,
input,
textarea,
select,
.wa-input,
.wa-toggle,
.wa-small,
.wa-rule-meta,
.wa-tab,
.wa-title,
.wa-editor-id {
  font-family: ${t.font};
}

/* -------------------------------------------------------
   Scrollbars
------------------------------------------------------- */
.wa-root * {
  scrollbar-width: thin;
  scrollbar-color: ${t.accent} transparent;
}

.wa-root *::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

.wa-root *::-webkit-scrollbar-track {
  background: transparent;
}

.wa-root *::-webkit-scrollbar-thumb {
  background: ${t.accent};
  border-radius: 4px;
  transition: background-color 0.2s ease;
}

.wa-root *::-webkit-scrollbar-thumb:hover {
  background: ${t.accent}CC;
}

/* Root container */
.wa-root {
  position: fixed;
  z-index: 2147483647;
  pointer-events: none;
}

/* -------------------------------------------------------
   Floating Action Button
------------------------------------------------------- */
.web-assassin-fab {
  position: fixed;
  width: 52px;
  height: 52px;
  bottom: 24px;
  right: 24px;
  border-radius: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: grab;
  pointer-events: auto;
  font-weight: 600;
  font-size: 20px;

  color: white;
  background: linear-gradient(135deg, ${t.accent}, ${t.accent}CC);
  border: 1px solid ${t.border};
  box-shadow: 0 8px 24px rgba(0,0,0,0.15);

  transition: all 0.2s ease;
  backdrop-filter: blur(12px);
}

.web-assassin-fab:hover {
  transform: translateY(-2px);
  box-shadow: 0 12px 32px rgba(0,0,0,0.2);
}

.web-assassin-fab:active {
  cursor: grabbing;
  transform: scale(0.95);
}

/* -------------------------------------------------------
   Panel Window
------------------------------------------------------- */
.web-assassin-panel {
  position: fixed;
  width: 760px;
  height: 560px;
  min-width: 400px;
  min-height: 320px;

  bottom: 100px;
  right: 24px;

  display: none;
  pointer-events: auto;

  background: ${t.background};
  color: ${t.foreground};
  border-radius: 20px;
  border: 0 solid ${t.border};
  box-shadow:
    0 20px 60px rgba(0,0,0,0.2),
    0 0 0 1px ${t.border};

  overflow: hidden;
  resize: none;
  backdrop-filter: blur(20px);
}

.web-assassin-panel.show {
  display: block;
  animation: wa-panel-appear 0.3s ease-out;
}

@keyframes wa-panel-appear {
  from { opacity: 0; transform: translateY(20px) scale(0.98); }
  to   { opacity: 1; transform: translateY(0)    scale(1); }
}

/* -------------------------------------------------------
   Panel Header / Layout
------------------------------------------------------- */
.wa-header {
  height: 20px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 20px;

  background: linear-gradient(
    180deg,
    color-mix(in srgb, ${t.accent} 60%, black 40%),
    color-mix(in srgb, ${t.accent} 20%, black 80%)
  );

  border-bottom: 1px solid ${t.border};
  border-radius: 20px 20px 0 0;
  cursor: grab;
}

.wa-title {
  font-weight: 600;
  font-size: 16px;
  letter-spacing: -0.02em;
  color: #e6eef8;
}

.wa-toolbar {
  margin-left: auto;
  display: flex;
  gap: 10px;
  align-items: center;
}

.wa-content {
  display: flex;
  height: calc(100% - 60px);
  background: ${t.background};
}

.wa-sidebar {
  width: 180px;
  border-right: 1px solid ${t.border};
  padding: 16px;
  overflow: auto;

  box-sizing: border-box;
  background: ${t.background2};
  backdrop-filter: blur(10px);
}

.wa-main {
  flex: 1;
  padding: 16px;
  overflow: auto;
  background: ${t.background};
}

/* -------------------------------------------------------
   Tabs
------------------------------------------------------- */
.wa-tab {
  display: block;
  padding: 12px 14px;
  margin-bottom: 8px;
  border-radius: 12px;

  cursor: pointer;
  font-weight: 500;

  border: 1px solid transparent;
  transition: all 0.2s ease;
}

.wa-tab:hover {
  background: ${t.background3};
}

.wa-tab.active {
  background: ${t.accent};
  color: white;
  border-color: ${t.accent};
  box-shadow: 0 4px 12px rgba(0,0,0,0.1);
}

/* -------------------------------------------------------
   Cards
------------------------------------------------------- */
.wa-card {
  background: ${t.background2};
  border: 1px solid ${t.border};
  padding: 16px;
  border-radius: 16px;
  margin-bottom: 16px;
  transition: all 0.2s ease;
  backdrop-filter: blur(8px);
}

.wa-card:hover {
  border-color: ${t.accent}80;
  box-shadow: 0 8px 24px rgba(0,0,0,0.08);
}

/* -------------------------------------------------------
   Buttons
------------------------------------------------------- */
.wa-btn {
  padding: 10px 16px;
  border-radius: 12px;
  border: 1px solid ${t.border};
  cursor: pointer;

  background: ${t.background3};
  color: ${t.foreground};
  font-weight: 500;
  transition: all 0.2s ease;
}

.wa-btn:hover {
  background: ${t.background3}CC;
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(0,0,0,0.1);
}

.wa-btn.primary {
  background: ${t.accent};
  color: white;
  border-color: transparent;
}

.wa-btn.primary:hover {
  background: ${t.accent}CC;
  box-shadow: 0 6px 16px rgba(0,0,0,0.15);
}

.wa-btn.small {
  padding: 6px 12px;
  font-size: 13px;
}

/* -------------------------------------------------------
   Toggle
------------------------------------------------------- */
.wa-toggle {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
  padding: 8px;
  border-radius: 8px;
  transition: all 0.2s ease;
}

.wa-toggle:hover {
  background: ${t.background3};
}

.wa-toggle .toggle-switch {
  width: 44px;
  height: 24px;
  background: ${t.background3};
  border-radius: 12px;
  position: relative;
  transition: all 0.2s ease;
}

.wa-toggle .toggle-switch::after {
  content: '';
  position: absolute;
  width: 20px;
  height: 20px;
  top: 2px;
  left: 2px;

  background: ${t.foreground};
  border-radius: 10px;
  transition: all 0.2s ease;
}

.wa-toggle.checked .toggle-switch {
  background: ${t.accent};
}

.wa-toggle.checked .toggle-switch::after {
  left: 22px;
  background: white;
}

/* -------------------------------------------------------
   Lists & Rule Cards
------------------------------------------------------- */
.wa-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.wa-rule-card {
  display: flex;
  gap: 12px;
  align-items: center;
  justify-content: space-between;

  background: ${t.background2};
  padding: 14px;
  border-radius: 14px;

  border: 1px solid ${t.border};
  transition: all 0.2s ease;
}

.wa-rule-card:hover {
  border-color: ${t.accent}80;
  box-shadow: 0 4px 16px rgba(0,0,0,0.08);
  transform: translateY(-1px);
}

.wa-rule-meta {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1;
}

.wa-small {
  font-size: 13px;
  opacity: 0.7;
}

/* -------------------------------------------------------
   Editor Modal
------------------------------------------------------- */
.wa-editor-modal {
  position: fixed;
  inset: 0;

  display: flex;
  align-items: center;
  justify-content: center;

  background: rgba(0,0,0,0.5);
  backdrop-filter: blur(12px);

  z-index: 2147483650;
  pointer-events: auto;
}

.wa-editor-window {
  width: 800px;
  max-width: calc(100% - 48px);
  max-height: calc(100% - 48px);

  background: ${t.background};
  color: ${t.foreground};

  padding: 20px;
  overflow: auto;

  border: 1px solid ${t.border};
  border-radius: 20px;
  box-shadow: 0 30px 80px rgba(0,0,0,0.3);

  animation: wa-modal-appear 0.3s ease-out;
}

@keyframes wa-modal-appear {
  from { opacity: 0; transform: scale(0.95); }
  to   { opacity: 1; transform: scale(1); }
}

.wa-editor-header {
  display: flex;
  align-items: center;
  gap: 12px;

  margin-bottom: 16px;
  padding-bottom: 16px;

  border-bottom: 1px solid ${t.border};
}

.wa-form-row {
  display: flex;
  gap: 12px;
  margin-bottom: 16px;
  align-items: center;
}

/* Inputs */
.wa-input,
textarea {
  width: 100%;
  padding: 12px 14px;
  border-radius: 12px;
  border: 1px solid ${t.border};
  background: ${t.background2};
  color: ${t.foreground};

  font-family: ${t.font};
  transition: all 0.2s ease;
  box-sizing: border-box;
}

.wa-input:focus,
textarea:focus {
  outline: none;
  border-color: ${t.accent};
  box-shadow: 0 0 0 2px ${t.accent}40;
}

.wa-selector-item {
  display: flex;
  gap: 12px;
  align-items: center;

  padding: 12px;
  background: ${t.background2};
  border-radius: 12px;

  border: 1px solid ${t.border};
  transition: all 0.2s ease;
}

.wa-selector-item:hover {
  border-color: ${t.accent}80;
}

/* Resize Grip */
.wa-resize-grip {
  position: absolute;
  width: 20px;
  height: 20px;

  right: 8px;
  bottom: 8px;

  cursor: se-resize;

  background: linear-gradient(135deg, ${t.background3}, ${t.background2});
  border-radius: 4px;
  border: 1px solid ${t.border};
  transition: all 0.2s ease;
}

.wa-resize-grip:hover {
  background: linear-gradient(135deg, ${t.accent}, ${t.accent}80);
  border-color: ${t.accent};
}

/* Footer */
.wa-footer {
  display: flex;
  gap: 12px;
  justify-content: flex-end;

  margin-top: 20px;
  padding-top: 16px;

  border-top: 1px solid ${t.border};
}

/* -------------------------------------------------------
   Toasts
------------------------------------------------------- */
.wa-toast-wrap {
  position: fixed;
  right: 32px;
  bottom: 110px;

  display: flex;
  flex-direction: column;
  gap: 12px;

  pointer-events: none;
  z-index: 2147483655;
}

.wa-toast {
  pointer-events: auto;

  padding: 14px 18px;
  border-radius: 12px;

  color: white;
  font-family: ${t.font};

  border: 1px solid rgba(255,255,255,0.1);
  box-shadow: 0 8px 24px rgba(0,0,0,0.15);

  backdrop-filter: blur(12px);
  animation: wa-toast-appear 0.3s ease-out;
}

@keyframes wa-toast-appear {
  from { opacity: 0; transform: translateX(100%); }
  to   { opacity: 1; transform: translateX(0); }
}

.wa-toast.success {
  background: linear-gradient(135deg, #16a34a, #22c55e);
}

.wa-toast.error {
  background: linear-gradient(135deg, #dc2626, #ef4444);
}

.wa-confirm {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* -------------------------------------------------------
   Stats & Metrics
------------------------------------------------------- */
.wa-stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 16px;
  margin: 16px 0;
}

.wa-stat-card {
  background: ${t.background2};
  padding: 16px;
  border-radius: 12px;
  text-align: center;
  border: 1px solid ${t.border};
}

.wa-stat-value {
  font-size: 24px;
  font-weight: 600;
  color: ${t.accent};
  margin-bottom: 4px;
}

.wa-stat-label {
  font-size: 13px;
  opacity: 0.7;
}

/* Editor ID and Tables */
#wa-editor-id {
  font-family: ${t.font};
  font-size: 13px;
  opacity: 0.7;
}

.wa-main .wa-card #wa-stats-table,
.wa-main .wa-card #wa-stats-table * {
  color: ${t.foreground};
}
`;
        }


        style.textContent = buildStyles();
        shadow.appendChild(style);

        // Build floating FAB
        const fab = document.createElement("div");
        fab.className = "web-assassin-fab";
        fab.title = "Web Assassin";
        fab.innerHTML = `<span style="user-select:none;">WA</span>`;
        root.appendChild(fab);

        // Build panel
        const panel = document.createElement("div");
        panel.className = "web-assassin-panel";
        panel.innerHTML = `
    <div class="wa-header">
      <div class="wa-title">Web Assassin</div>
      <div class="wa-toolbar">
        <button class="wa-btn" data-action="refresh">Refresh</button>
        <button class="wa-btn" data-action="close">Close</button>
      </div>
    </div>
    <div class="wa-content">
      <div class="wa-sidebar">
        <div class="wa-tab" data-tab="status">Status</div>
        <div class="wa-tab" data-tab="rules">Rules</div>
        <div class="wa-tab" data-tab="stats">Statistics</div>
        <div class="wa-tab" data-tab="settings">Settings</div>
      </div>
      <div class="wa-main" data-pane>
        <!-- dynamic -->
      </div>
    </div>
    <div class="wa-resize-grip" title="Resize"></div>
  `;
        root.appendChild(panel);

        // Toast container
        const toastWrap = document.createElement("div");
        toastWrap.className = "wa-toast-wrap";
        root.appendChild(toastWrap);

        shadow.appendChild(root);

        // State
        let panelVisible = false;
        let currentTab = getSettings().ui?.lastTab || "rules";
        let editorOpen = false;
        let editorTemp = null;
        let editorMode = "add"; // add | edit
        let lastDrag = { x: 0, y: 0, dragging: false, panelDragging: false, fabDragging: false };
        let resizeState = { resizing: false, startW: 0, startH: 0, startX: 0, startY: 0 };

        // Position persistence keys
        const POS_KEY = "web_assassin_ui_pos";
        async function saveUIPos(pos) {
            try {
                const s = ruleManager.getSettings();
                s.ui = s.ui || {};
                s.ui._panelPos = pos;
                ruleManager.setSettings(s);
            } catch (e) { /* ignore */ }
        }
        function readUIPos() {
            try { const s = ruleManager.getSettings(); return s.ui?._panelPos || null; } catch (e) { return null; }
        }

        // Apply saved position if exists
        const savedPos = readUIPos();
        // ensure panel stays inside viewport
        function ensurePanelInViewport() {
            try {
                // clamp width / height
                const maxW = Math.max(360, window.innerWidth - 16);
                const maxH = Math.max(280, window.innerHeight - 16);
                const curW = panel.getBoundingClientRect().width;
                const curH = panel.getBoundingClientRect().height;
                if (curW > maxW) panel.style.width = maxW + "px";
                if (curH > maxH) panel.style.height = maxH + "px";

                const rect = panel.getBoundingClientRect();
                const width = rect.width;
                const height = rect.height;
                let left = rect.left;
                let top = rect.top;

                // if positioned with right/bottom, convert to left/top
                if (panel.style.right && !panel.style.left) {
                    left = window.innerWidth - (parseFloat(panel.style.right) || (window.innerWidth - rect.right)) - width;
                }
                if (panel.style.bottom && !panel.style.top) {
                    top = window.innerHeight - (parseFloat(panel.style.bottom) || (window.innerHeight - rect.bottom)) - height;
                }

                const clampedLeft = Math.min(Math.max(8, Math.round(left)), Math.max(8, Math.round(window.innerWidth - width - 8)));
                const clampedTop = Math.min(Math.max(8, Math.round(top)), Math.max(8, Math.round(window.innerHeight - height - 8)));

                panel.style.left = clampedLeft + "px";
                panel.style.top = clampedTop + "px";
                panel.style.right = "auto";
                panel.style.bottom = "auto";
            } catch (e) { /* ignore */ }
        }
        if (savedPos && typeof savedPos === "object") {
            if (savedPos.width) panel.style.width = savedPos.width;
            if (savedPos.height) panel.style.height = savedPos.height;
            if (savedPos.left !== undefined) panel.style.left = savedPos.left;
            if (savedPos.top !== undefined) panel.style.top = savedPos.top;
            else {
                if (savedPos.right !== undefined) panel.style.right = savedPos.right;
                if (savedPos.bottom !== undefined) panel.style.bottom = savedPos.bottom;
            }
            // clamp into viewport
            ensurePanelInViewport();
        }

        // Show/hide helpers
        function showPanel() { panel.classList.add("show"); panelVisible = true; renderCurrentTab(); }
        function hidePanel() { panel.classList.remove("show"); panelVisible = false; }
        function togglePanel() { panelVisible ? hidePanel() : showPanel(); }

        // FAB drag
        fab.addEventListener("mousedown", (ev) => {
            lastDrag.fabDragging = true;
            lastDrag.x = ev.clientX; lastDrag.y = ev.clientY;
            fab.style.transition = "none";
            ev.preventDefault();
        });
        document.addEventListener("mousemove", (ev) => {
            if (lastDrag.fabDragging) {
                const dx = ev.clientX - lastDrag.x;
                const dy = ev.clientY - lastDrag.y;
                lastDrag.x = ev.clientX;
                lastDrag.y = ev.clientY;

                // Update position
                const rect = fab.getBoundingClientRect();
                const newLeft = rect.left + dx; // Move left based on mouse movement
                const newTop = rect.top + dy;   // Move top based on mouse movement

                // Clamp to window boundaries
                const clampedLeft = Math.min(
                    Math.max(8, newLeft),
                    window.innerWidth - rect.width - 8
                );
                const clampedTop = Math.min(
                    Math.max(8, newTop),
                    window.innerHeight - rect.height - 8
                );

                // Apply the new position
                fab.style.left = `${clampedLeft}px`;
                fab.style.top = `${clampedTop}px`;
                fab.style.right = "auto";  // Remove right to avoid interference
                fab.style.bottom = "auto"; // Remove bottom to avoid interference

                // Persist position as UI state
                saveUIPos({ left: fab.style.left, top: fab.style.top });
            }

            if (lastDrag.panelDragging) {
                const dx = ev.clientX - lastDrag.x;
                const dy = ev.clientY - lastDrag.y;
                lastDrag.x = ev.clientX;
                lastDrag.y = ev.clientY;

                // Move panel using left/top and clamp to viewport
                const rect = panel.getBoundingClientRect();
                const newLeft = rect.left + dx;
                const newTop = rect.top + dy;
                const width = rect.width;
                const height = rect.height;

                const clampedLeft = Math.min(
                    Math.max(8, Math.round(newLeft)),
                    Math.max(8, Math.round(window.innerWidth - width - 8))
                );
                const clampedTop = Math.min(
                    Math.max(8, Math.round(newTop)),
                    Math.max(8, Math.round(window.innerHeight - height - 8))
                );

                panel.style.left = clampedLeft + "px";
                panel.style.top = clampedTop + "px";
                panel.style.right = "auto";  // Remove right to avoid interference
                panel.style.bottom = "auto"; // Remove bottom to avoid interference

                // Persist position as UI state
                saveUIPos({
                    left: panel.style.left,
                    top: panel.style.top,
                    width: panel.style.width,
                    height: panel.style.height
                });
            }

            if (resizeState.resizing) {
                const nx = ev.clientX;
                const ny = ev.clientY;
                const dw = nx - resizeState.startX;
                const dh = ny - resizeState.startY;
                const maxW = Math.max(360, window.innerWidth - 16);
                const maxH = Math.max(280, window.innerHeight - 16);
                const newW = Math.min(maxW, Math.max(360, resizeState.startW + dw));
                const newH = Math.min(maxH, Math.max(280, resizeState.startH + dh));
                panel.style.width = newW + "px";
                panel.style.height = newH + "px";
            }
        });

        document.addEventListener("mouseup", (ev) => {
            if (lastDrag.fabDragging) {
                lastDrag.fabDragging = false;
                fab.style.transition = "";
                saveUIPos({ right: fab.style.right, bottom: fab.style.bottom });
            }
            if (lastDrag.panelDragging) {
                lastDrag.panelDragging = false;
                // convert to left/top style for persistence
                ensurePanelInViewport();
                saveUIPos({ left: panel.style.left, top: panel.style.top, width: panel.style.width, height: panel.style.height });
            }
            if (resizeState.resizing) {
                resizeState.resizing = false;
                ensurePanelInViewport();
                saveUIPos({ left: panel.style.left, top: panel.style.top, width: panel.style.width, height: panel.style.height });
            }
        });

        // Toggle panel on FAB click
        fab.addEventListener("click", (ev) => {
            // prevent click if dragging
            if (lastDrag.fabDragging) return;
            togglePanel();
        });

        // Panel close / refresh
        qS(panel, '[data-action="close"]').addEventListener("click", () => hidePanel());
        qS(panel, '[data-action="refresh"]').addEventListener("click", async () => {
            await engine.restart?.();
            toast("Engine refreshed", "success");
        });

        // Make header draggable
        const header = qS(panel, ".wa-header");
        header.addEventListener("mousedown", (ev) => {
            lastDrag.panelDragging = true;
            lastDrag.x = ev.clientX; lastDrag.y = ev.clientY;
            ev.preventDefault();
        });

        // Resize grip
        const grip = qS(panel, ".wa-resize-grip");
        grip.addEventListener("mousedown", (ev) => {
            resizeState.resizing = true;
            resizeState.startW = panel.getBoundingClientRect().width;
            resizeState.startH = panel.getBoundingClientRect().height;
            resizeState.startX = ev.clientX;
            resizeState.startY = ev.clientY;
            ev.preventDefault();
        });

        // Tabs
        const tabs = qSA(panel, ".wa-tab");
        function setActiveTab(name) {
            currentTab = name;
            tabs.forEach(t => t.classList.toggle("active", t.dataset.tab === name));
            const s = getSettings();
            s.ui = s.ui || {};
            s.ui.lastTab = name;
            ruleManager.setSettings(s); // persist
            renderCurrentTab();
        }
        tabs.forEach(t => t.addEventListener("click", () => setActiveTab(t.dataset.tab)));
        // Initialize active tab
        setTimeout(() => {
            tabs.forEach(t => t.classList.toggle("active", t.dataset.tab === currentTab));
        }, 0);

        // Toast system
        function toast(msg, type = "info", ms = 3000) {
            try {
                const s = ruleManager.getSettings();
                if (!s?.toastsEnabled) return; // respect setting
            } catch (e) {
                // if settings read fails, fall back to showing toast
            }
            const el = document.createElement("div");
            el.className = `wa-toast ${type === "success" ? "success" : (type === "error" ? "error" : "")}`;
            el.textContent = msg;
            toastWrap.appendChild(el);
            setTimeout(() => {
                el.style.transition = "opacity 200ms";
                el.style.opacity = "0";
                setTimeout(() => el.remove(), 220);
            }, ms);
        }

        // Confirmation dialog (returns Promise<boolean>)
        function confirmDialog(title, message) {
            return new Promise((resolve) => {
                const modal = document.createElement("div");
                modal.className = "wa-editor-modal";
                modal.innerHTML = `
        <div class="wa-editor-window" style="width:420px;">
          <div class="wa-editor-header">
            <div style="font-weight:700;">${title}</div>
          </div>
          <div class="wa-card wa-confirm">
            <div>${message}</div>
            <div style="display:flex; gap:8px; justify-content:flex-end;">
              <button class="wa-btn" data-action="cancel">Cancel</button>
              <button class="wa-btn primary" data-action="ok">OK</button>
            </div>
          </div>
        </div>
      `;
                shadow.appendChild(modal);
                qS(modal, '[data-action="cancel"]').addEventListener("click", () => { modal.remove(); resolve(false); });
                qS(modal, '[data-action="ok"]').addEventListener("click", () => { modal.remove(); resolve(true); });
            });
        }

        // Render helpers for each main tab
        const mainPane = qS(panel, "[data-pane]");
        function clearMain() { mainPane.innerHTML = ""; }

        // Build Status tab
        function renderStatusTab() {
            clearMain();
            const s = getSettings();
            const cfg = s.deletionSettings || {};
            const domain = location.href;
            const container = document.createElement("div");
            const cardStatus = document.createElement("div");
            cardStatus.className = "wa-card";
            cardStatus.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;">
      <div>
        <div style="font-weight:700">Script</div>
        <div class="wa-small">Enable or disable deletion engine</div>
      </div>
      <div>
        <label class="wa-toggle">
          <input type="checkbox" id="wa-script-toggle" ${!cfg.scriptDisabled ? "checked" : ""}/>
          <span class="wa-small">${!cfg.scriptDisabled ? "Enabled" : "Disabled"}</span>
        </label>
      </div>
    </div>
  `;
            container.appendChild(cardStatus);

            qS(cardStatus, "#wa-script-toggle").addEventListener("change", async (ev) => {
                const checked = ev.target.checked;
                const st = ruleManager.getSettings();
                st.deletionSettings = st.deletionSettings || {};
                st.deletionSettings.scriptDisabled = !checked;
                ruleManager.setSettings(st);
                toast(`Script ${checked ? "enabled" : "disabled"}`, "success");
                if (checked) engine.start(); else engine.stop();
            });

            const cardRules = document.createElement("div");
            cardRules.className = "wa-card";
            cardRules.innerHTML = `<div style="font-weight:700;margin-bottom:8px">Active rules for page</div>`;
            const listWrap = document.createElement("div");
            listWrap.className = "wa-list";
            const allRules = ruleManager.getAllRules() || [];

            const activeRules = allRules.filter(r => r && domainMatches(r.domain, location.href));
            if (!activeRules.length) {
                listWrap.innerHTML = `<div class="wa-small">No rules match this page</div>`;
            } else {
                for (const r of activeRules) {
                    const rc = document.createElement("div");
                    rc.className = "wa-rule-card";
                    const meta = document.createElement("div");
                    meta.className = "wa-rule-meta";
                    const name = document.createElement("div"); name.textContent = r.name || r.domain || r.ID;
                    const counts = document.createElement("div"); counts.className = "wa-small";
                    // Show per-session count instead of total
                    const perLoad = perLoadCounts.get(r.ID) || 0;
                    counts.textContent = `Deleted this load: ${perLoad}`;
                    meta.appendChild(name); meta.appendChild(counts);

                    const controls = document.createElement("div");
                    controls.style.display = "flex"; controls.style.gap = "8px"; controls.style.alignItems = "center";
                    const toggle = document.createElement("input");
                    toggle.type = "checkbox";
                    toggle.checked = !!r.ruleEnabled;
                    toggle.title = "Enable/Disable this rule";
                    toggle.addEventListener("change", async (ev) => {
                        const newVal = !!ev.target.checked;

                        ruleManager.updateRuleByID(r.ID, { ruleEnabled: newVal });
                        toast(`Rule "${r.name || r.domain}" ${newVal ? "enabled" : "disabled"}`, "success");

                        await engine.restart?.();
                        renderCurrentTab();
                    });
                    controls.appendChild(toggle);
                    rc.appendChild(meta); rc.appendChild(controls);
                    listWrap.appendChild(rc);
                }
            }
            cardRules.appendChild(listWrap);
            container.appendChild(cardRules);

            mainPane.appendChild(container);
        }


        // Rules tab rendering: search + Add + Pick element + rule list
        function renderRulesTab() {
            clearMain();
            const container = document.createElement("div");

            // Top controls card
            const topCard = document.createElement("div");
            topCard.className = "wa-card";
            topCard.innerHTML = `
      <div style="display:flex;gap:8px;align-items:center;">
        <input class="wa-input" placeholder="Search rules..." id="wa-rule-search" />
        <button class="wa-btn primary" id="wa-add-rule">Add Rule</button>
        <button class="wa-btn" id="wa-pick-element">Pick Element</button>
      </div>
    `;
            container.appendChild(topCard);

            // Rule list card
            const listCard = document.createElement("div");
            listCard.className = "wa-card";
            listCard.innerHTML = `<div style="font-weight:700;margin-bottom:8px">Rules</div><div id="wa-rules-list" class="wa-list"></div>`;
            container.appendChild(listCard);

            mainPane.appendChild(container);

            // Hooks
            qS(topCard, "#wa-add-rule").addEventListener("click", () => openEditor("add", null));
            qS(topCard, "#wa-pick-element").addEventListener("click", async () => {
                // Start quick picker mode: highlight hover, click to capture selector and open editor with appended selector
                startElementPicker();
            });

            // Render list
            function refreshList(filter = "") {
                const listWrap = qS(listCard, "#wa-rules-list");
                listWrap.innerHTML = "";
                const allRules = (ruleManager.getAllRules() || []).slice().reverse(); // show newest first
                const f = String(filter || "").trim().toLowerCase();
                for (const r of allRules) {
                    if (!r) continue;
                    const nameStr = (r.name || r.domain || r.ID).toLowerCase();
                    if (f && !nameStr.includes(f) && !String(r.domain || "").toLowerCase().includes(f)) continue;
                    const el = document.createElement("div");
                    el.className = "wa-rule-card";
                    const meta = document.createElement("div"); meta.className = "wa-rule-meta";
                    meta.innerHTML = `<div style="font-weight:700">${r.name || r.domain}</div>
                          <div class="wa-small">${r.domain}</div>
                          <div class="wa-small">Temp: ${(r.tempSelectors || []).length} • Perm: ${(r.permanentSelectors || []).length}</div>`;
                    const actions = document.createElement("div");
                    actions.style.display = "flex"; actions.style.gap = "6px";
                    const toggle = document.createElement("input"); toggle.type = "checkbox"; toggle.checked = !!r.ruleEnabled;
                    toggle.title = "Enable/Disable rule";
                    toggle.addEventListener("change", async (ev) => {
                        const newVal = !!ev.target.checked;
                        ruleManager.updateRuleByID(r.ID, { ruleEnabled: newVal });
                        toast(`Rule "${r.name || r.domain}" ${newVal ? "enabled" : "disabled"}`, "success");
                        await engine.restart?.();
                        refreshList(qS(topCard, "#wa-rule-search").value);
                    });
                    const btnEdit = document.createElement("button"); btnEdit.className = "wa-btn"; btnEdit.textContent = "Edit";
                    btnEdit.addEventListener("click", () => openEditor("edit", r));
                    const btnDelete = document.createElement("button"); btnDelete.className = "wa-btn"; btnDelete.textContent = "Delete";
                    btnDelete.addEventListener("click", async () => {
                        const ok = await confirmDialog("Delete rule", `Delete rule "${r.name || r.domain}"?`);
                        if (!ok) return;
                        ruleManager.removeRuleByID(r.ID);
                        toast("Rule deleted", "success");
                        await engine.restart?.();
                        refreshList(qS(topCard, "#wa-rule-search").value);
                    });
                    actions.appendChild(toggle);
                    actions.appendChild(btnEdit);
                    actions.appendChild(btnDelete);
                    el.appendChild(meta); el.appendChild(actions);
                    listWrap.appendChild(el);
                }
            }

            qS(topCard, "#wa-rule-search").addEventListener("input", (ev) => refreshList(ev.target.value));
            refreshList();
        }

        // Stats tab
        function renderStatsTab() {
            clearMain();
            const s = getSettings();
            const container = document.createElement("div");

            const card1 = document.createElement("div"); card1.className = "wa-card";
            const totalDeleted = (ruleManager.getAllRules() || []).reduce((acc, r) => acc + (Number(r.tempDeleteCount || 0) + Number(r.permanentDeleteCount || 0)), 0);
            card1.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;">
        <div>
          <div style="font-weight:700">Statistics</div>
          <div class="wa-small">Enable/disable stats collection</div>
        </div>
        <div>
          <label class="wa-toggle">
            <input type="checkbox" id="wa-stats-toggle" ${s.statsEnabled ? "checked" : ""}/>
            <span class="wa-small">${s.statsEnabled ? "On" : "Off"}</span>
          </label>
        </div>
      </div>
      <div style="margin-top:8px;">Total deletions (all rules): <strong>${totalDeleted}</strong></div>
      <div style="margin-top:8px;"><button class="wa-btn" id="wa-reset-counters">Reset all counters</button></div>
    `;
            container.appendChild(card1);

            qS(card1, "#wa-stats-toggle").addEventListener("change", async (ev) => {
                const newVal = !!ev.target.checked;
                const st = ruleManager.getSettings();
                st.statsEnabled = newVal;
                ruleManager.setSettings(st);
                toast(`Stats ${newVal ? "enabled" : "disabled"}`, "success");
            });
            qS(card1, "#wa-reset-counters").addEventListener("click", async () => {
                const ok = await confirmDialog("Reset counters", "Reset all deletion counters to zero?");
                if (!ok) return;
                const all = ruleManager.getAllRules() || [];
                for (const r of all) {
                    ruleManager.updateRuleByID(r.ID, { tempDeleteCount: 0, permanentDeleteCount: 0 });
                }
                toast("Counters reset", "success");
                renderStatsTab();
            });

            // Table of rules and counts
            const card2 = document.createElement("div"); card2.className = "wa-card";
            card2.innerHTML = `<div style="font-weight:700;margin-bottom:8px">Per-rule counts</div><div id="wa-stats-table"></div>`;
            container.appendChild(card2);

            const table = document.createElement("table");
            table.style.width = "100%";
            table.innerHTML = `<thead><tr><th style="text-align:left">Name</th><th style="text-align:left">Domain</th><th style="text-align:right">Deletions</th></tr></thead>`;
            const tbody = document.createElement("tbody");
            const all = ruleManager.getAllRules() || [];
            for (const r of all) {
                const tr = document.createElement("tr");
                tr.innerHTML = `<td>${r.name || ""}</td><td class="wa-small">${r.domain || ""}</td><td style="text-align:right">${(Number(r.tempDeleteCount || 0) + Number(r.permanentDeleteCount || 0))}</td>`;
                tbody.appendChild(tr);
            }
            table.appendChild(tbody);
            qS(card2, "#wa-stats-table").appendChild(table);

            mainPane.appendChild(container);
        }

        // Settings tab
        function renderSettingsTab() {
            clearMain();
            const s = getSettings();
            const container = document.createElement("div");

            // -------------------------
            // General card
            // -------------------------
            const general = document.createElement("div");
            general.className = "wa-card";
            general.innerHTML = `
      <div style="font-weight:700">General</div>
      <div style="margin-top:8px;">
        <label class="wa-toggle">
          <input type="checkbox" id="wa-settings-script" ${!s.deletionSettings?.scriptDisabled ? "checked" : ""}/>
          <span class="wa-small">Script Enabled</span>
        </label>
      </div>
      <div style="margin-top:8px;">
        <label class="wa-toggle">
          <input type="checkbox" id="wa-settings-toasts" ${s.toastsEnabled ? "checked" : ""}/>
          <span class="wa-small">Toasts Enabled</span>
        </label>
      </div>
    `;
            container.appendChild(general);

            qS(general, "#wa-settings-script").addEventListener("change", async (ev) => {
                s.deletionSettings = s.deletionSettings || {};
                s.deletionSettings.scriptDisabled = !ev.target.checked;
                ruleManager.setSettings(s);
                if (ev.target.checked) engine.start(); else engine.stop();
                toast("General settings saved", "success");
            });

            qS(general, "#wa-settings-toasts").addEventListener("change", async (ev) => {
                s.toastsEnabled = !!ev.target.checked;
                ruleManager.setSettings(s);
                toast("Toasts setting saved", "success");
            });

            // -------------------------
            // THEME CARD (UPDATED)
            // -------------------------
            const themeCard = document.createElement("div");
            themeCard.className = "wa-card";

            const currentAccent =
                s.theme?.mode === "dark"
                    ? s.theme.dark.accent
                    : s.theme.light.accent;

            themeCard.innerHTML = `
      <div style="font-weight:700">Theme</div>

      <!-- Mode toggle -->
      <div class="wa-row" style="margin-top:8px;">
        <label class="wa-toggle">
          <input type="radio" name="wa-theme-mode" value="light" ${s.theme?.mode !== "dark" ? "checked" : ""}/>
          Light
        </label>

        <label class="wa-toggle" style="margin-left:8px;">
          <input type="radio" name="wa-theme-mode" value="dark" ${s.theme?.mode === "dark" ? "checked" : ""}/>
          Dark
        </label>
      </div>

      <!-- Accent + presets -->
      <div class="wa-row" style="margin-top:16px; align-items:center; gap:16px;">
        <div style="font-weight:700; white-space:nowrap;">Accent Color</div>

        <!-- Color picker -->
        <input
          type="color"
          id="wa-theme-accent"
          value="${currentAccent}"
          style="width:42px;height:32px;padding:0;border:none;border-radius:8px;"
        />

        <!-- Preset buttons -->
        <div style="display:flex; gap:8px; margin-left:auto; align-items:center;">
          <span class="wa-small">Presets:</span>

          <button class="wa-btn wa-preset-color" data-color="#5a8ead"
            style="width:26px;height:26px;padding:0;border:none;background:#5a8ead;"></button>

          <button class="wa-btn wa-preset-color" data-color="#ae79a7"
            style="width:26px;height:26px;padding:0;border:none;background:#ae79a7;"></button>

          <button class="wa-btn wa-preset-color" data-color="#662121"
            style="width:26px;height:26px;padding:0;border:none;background:#662121;"></button>

          <button class="wa-btn wa-preset-color" data-color="#4144be"
            style="width:26px;height:26px;padding:0;border:none;background:#4144be;"></button>
        </div>
      </div>
    `;

            container.appendChild(themeCard);

            // Theme mode switching
            qSA(themeCard, 'input[name="wa-theme-mode"]').forEach(r =>
                r.addEventListener("change", (ev) => {
                    s.theme = s.theme || {};
                    s.theme.mode = ev.target.value;
                    ruleManager.setSettings(s);
                    style.textContent = buildStyles();
                    toast("Theme updated", "success");
                })
            );

            // Accent color picker
            qS(themeCard, "#wa-theme-accent").addEventListener("input", (ev) => {
                const color = ev.target.value;

                if (s.theme.mode === "dark") s.theme.dark.accent = color;
                else s.theme.light.accent = color;

                ruleManager.setSettings(s);
                style.textContent = buildStyles();
                toast("Accent color updated", "success");
            });

            // Preset buttons
            qSA(themeCard, ".wa-preset-color").forEach(btn =>
                btn.addEventListener("click", () => {
                    const color = btn.dataset.color;

                    if (s.theme.mode === "dark") s.theme.dark.accent = color;
                    else s.theme.light.accent = color;

                    qS(themeCard, "#wa-theme-accent").value = color;

                    ruleManager.setSettings(s);
                    style.textContent = buildStyles();
                    toast("Accent color updated", "success");
                })
            );

            // -------------------------
            // Backup / Restore card
            // -------------------------
            const backup = document.createElement("div");
            backup.className = "wa-card";
            backup.innerHTML = `
      <div style="font-weight:700">Backup / Restore</div>
      <div style="margin-top:8px;">
        <button class="wa-btn" id="wa-export">Export JSON</button>
        <button class="wa-btn" id="wa-import">Import JSON</button>
        <input type="file" id="wa-import-file" style="display:none" accept="application/json"/>
      </div>
    `;
            container.appendChild(backup);

            qS(backup, "#wa-export").addEventListener("click", () => {
                const s = ruleManager.getSettings();
                const blob = new Blob([JSON.stringify(s, null, 2)], { type: "application/json" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url; a.download = "web_assassin_settings.json"; a.click();
                URL.revokeObjectURL(url);
                toast("Export started", "success");
            });

            qS(backup, "#wa-import").addEventListener("click", () =>
                qS(backup, "#wa-import-file").click()
            );

            qS(backup, "#wa-import-file").addEventListener("change", (ev) => {
                const f = ev.target.files && ev.target.files[0];
                if (!f) return;

                const reader = new FileReader();
                reader.onload = async (e) => {
                    try {
                        const parsed = JSON.parse(e.target.result);
                        const ok = await confirmDialog("Import settings", "This will overwrite settings. Continue?");
                        if (!ok) return;
                        ruleManager.setSettings(parsed);
                        toast("Settings imported", "success");
                        renderCurrentTab();
                    } catch (err) {
                        toast("Invalid JSON file", "error");
                    }
                };
                reader.readAsText(f);
            });

            // -------------------------
            // Deletion settings card
            // -------------------------
            const delCard = document.createElement("div");
            delCard.className = "wa-card";
            delCard.innerHTML = `
      <div style="font-weight:700">Deletion settings</div>
      <div style="margin-top:8px;">
        <label class="wa-small">Mutation debounce (ms)</label>
        <input class="wa-input" id="wa-mutation-debounce" type="number"
          value="${s.deletionSettings?.mutationObserverDebounceInterval || 250}" />
      </div>

      <div style="margin-top:8px;">
        <label class="wa-toggle">
          <input type="checkbox" id="wa-periodic-url-check" ${s.deletionSettings?.peridoicURLCheck ? "checked" : ""}/>
          periodic URL check
        </label>
      </div>

      <div style="margin-top:8px;">
        <label class="wa-small">Periodic URL check interval (ms)</label>
        <input class="wa-input" id="wa-periodic-url-interval" type="number"
          value="${s.deletionSettings?.peridoicURLCheckInterval || 5000}" />
      </div>

      <div style="margin-top:8px;">
        <button class="wa-btn primary" id="wa-save-deletion-settings">Save Deletion Settings</button>
      </div>
    `;
            container.appendChild(delCard);

            qS(delCard, "#wa-save-deletion-settings").addEventListener("click", () => {
                const s = ruleManager.getSettings();
                s.deletionSettings = s.deletionSettings || {};
                s.deletionSettings.mutationObserverDebounceInterval =
                    Number(qS(delCard, "#wa-mutation-debounce").value || 250);

                s.deletionSettings.peridoicURLCheck =
                    !!qS(delCard, "#wa-periodic-url-check").checked;

                s.deletionSettings.peridoicURLCheckInterval =
                    Number(qS(delCard, "#wa-periodic-url-interval").value || 5000);

                ruleManager.setSettings(s);
                toast("Deletion settings saved", "success");
            });

            mainPane.appendChild(container);
        }

        // Render current tab
        function renderCurrentTab() {
            switch (currentTab) {
                case "status": renderStatusTab(); break;
                case "rules": renderRulesTab(); break;
                case "stats": renderStatsTab(); break;
                case "settings": renderSettingsTab(); break;
                default: renderRulesTab(); break;
            }
        }

        // Editor: openEditor(mode, rule)
        function openEditor(mode = "add", rule = null, pickedSelector = null) {
            if (editorOpen) {
                // bring existing to front
                return;
            }
            editorOpen = true;
            editorMode = mode;

            // Create a temporary rule object (deep copy) and a unified selectors list
            let temp;
            if (mode === "edit" && rule) {
                temp = JSON.parse(JSON.stringify(rule));
                // Build unified selectors array with a type field (temp | perm).
                // Accept both stored temp/permanent arrays OR a prebuilt selectors array (from unsaved editor state).
                temp.selectors = [];
                if (Array.isArray(rule.selectors) && rule.selectors.length) {
                    rule.selectors.forEach(s => temp.selectors.push({ type: s.type || "temp", name: s.name || "", selector: s.selector || "" }));
                } else {
                    (rule.tempSelectors || []).forEach(s => temp.selectors.push({ type: "temp", name: s.name || "", selector: s.selector || "" }));
                    (rule.permanentSelectors || []).forEach(s => temp.selectors.push({ type: "perm", name: s.name || "", selector: s.selector || "" }));
                }
            } else {
                temp = {
                    ID: null,
                    name: "",
                    domain: location.hostname || location.href,
                    selectors: [],
                    ruleEnabled: true,
                    tempDeleteCount: 0,
                    permanentDeleteCount: 0,
                };
            }

            // If a selector is pre-picked, append it to unified selectors (default to temp)
            if (pickedSelector) {
                temp.selectors = temp.selectors || [];
                temp.selectors.push({ type: "temp", name: pickedSelector.name || "", selector: pickedSelector.selector || "" });
            }

            editorTemp = temp;

            // Build modal
            const modal = document.createElement("div");
            modal.className = "wa-editor-modal";
            modal.innerHTML = `
            <div class="wa-editor-window" role="dialog" aria-modal="true">
                <div class="wa-editor-header">
                    <div style="font-weight:700">${mode === "add" ? "Add Rule" : "Edit Rule"}</div>
                </div>
                <div style="display:flex;gap:12px;flex-direction:column;">
                    <div class="wa-form-row"><input class="wa-input" id="wa-editor-name" placeholder="Rule name" /></div>
                    <div class="wa-form-row"><input class="wa-input" id="wa-editor-domain" placeholder="Domain (e.g. example.com)" /></div>

                    <div>
                        <div style="font-weight:700">Selectors</div>
                        <div id="wa-editor-selectors" style="margin-top:8px;"></div>
                        <div style="margin-top:8px;"><button class="wa-btn" id="wa-add-selector">Add selector</button></div>
                        <div class="wa-small" style="margin-top:6px;opacity:0.8">Click the "Temp"/"Perm" button on a selector to toggle its deletion type.</div>
                    </div>

                    <div style="display:flex;gap:8px;align-items:center;">
                        <label class="wa-toggle"><input type="checkbox" id="wa-editor-enabled" /> <span class="wa-small">Rule enabled</span></label>
                        <label class="wa-toggle" style="margin-left:8px;"><input type="checkbox" id="wa-editor-deletionrules" /> <span class="wa-small">Include deletionRules key</span></label>
                        <div style="margin-left:auto;" class="wa-small">ID: <span id="wa-editor-id"></span></div>
                    </div>

                    <div class="wa-footer">
                        <button class="wa-btn" id="wa-editor-cancel">Cancel</button>
                        <button class="wa-btn primary" id="wa-editor-save">${mode === "add" ? "Add Rule" : "Save Changes"}</button>
                    </div>
                </div>
            </div>
        `;
            shadow.appendChild(modal);

            // Fill values
            qS(modal, "#wa-editor-name").value = temp.name || "";
            qS(modal, "#wa-editor-domain").value = temp.domain || "";
            qS(modal, "#wa-editor-enabled").checked = !!temp.ruleEnabled;
            // default deletionRules toggle: use existing rule value or true for new
            qS(modal, "#wa-editor-deletionrules").checked = (temp.deletionRules && temp.deletionRules.enabled !== undefined) ? !!temp.deletionRules.enabled : true;
            qS(modal, "#wa-editor-id").textContent = temp.ID || "(new)";

            // Render unified selector list
            // capture original snapshot for dirty-checking
            const originalSnapshot = {
                name: (rule && rule.name) || "",
                domain: (rule && rule.domain) || location.hostname,
                ruleEnabled: (rule && rule.ruleEnabled) || true,
                selectors: (rule ? [...(rule.tempSelectors || []).map(s => ({ type: "temp", name: s.name || "", selector: s.selector || "" })), ...(rule.permanentSelectors || []).map(s => ({ type: "perm", name: s.name || "", selector: s.selector || "" }))] : [])
            };

            function renderSelectorLists() {
                const wrapper = qS(modal, "#wa-editor-selectors");
                wrapper.innerHTML = "";
                (temp.selectors || []).forEach((it, idx) => {
                    const row = document.createElement("div"); row.className = "wa-selector-item";
                    // Show a toggle button for type so user can switch with one click
                    const typeLabel = it.type === "perm" ? "Perm" : "Temp";
                    row.innerHTML = `
                        <input class="wa-input" data-field="name" data-idx="${idx}" placeholder="Name" value="${(it.name || "").replace(/"/g, '&quot;')}" style="width:30%"/>
                        <input class="wa-input" data-field="selector" data-idx="${idx}" placeholder="CSS selector" value="${(it.selector || "").replace(/"/g, '&quot;')}" style="width:55%"/>
                        <button class="wa-btn" data-action="toggle-type" data-idx="${idx}">${typeLabel}</button>
                        <button class="wa-btn" data-action="del" data-idx="${idx}">Del</button>
                    `;
                    wrapper.appendChild(row);
                });

                // attach listeners to inputs & buttons
                qSA(modal, 'input[data-field]').forEach(inp => {
                    inp.addEventListener("input", (ev) => {
                        const idx = Number(ev.target.dataset.idx);
                        const field = ev.target.dataset.field;
                        if (!temp.selectors || !temp.selectors[idx]) return;
                        temp.selectors[idx][field] = ev.target.value;
                    });
                });
                qSA(modal, 'button[data-action="toggle-type"]').forEach(b => {
                    b.addEventListener("click", (ev) => {
                        const idx = Number(ev.target.dataset.idx);
                        if (!temp.selectors || !temp.selectors[idx]) return;
                        temp.selectors[idx].type = (temp.selectors[idx].type === "perm") ? "temp" : "perm";
                        renderSelectorLists();
                    });
                });
                qSA(modal, 'button[data-action="del"]').forEach(b => {
                    b.addEventListener("click", (ev) => {
                        const idx = Number(ev.target.dataset.idx);
                        if (!temp.selectors) return;
                        temp.selectors.splice(idx, 1);
                        renderSelectorLists();
                    });
                });
            }
            renderSelectorLists();

            // Add selector button
            qS(modal, "#wa-add-selector").addEventListener("click", () => {
                temp.selectors = temp.selectors || [];
                temp.selectors.push({ type: "temp", name: "", selector: "" });
                renderSelectorLists();
            });

            // Cancel button
            qS(modal, "#wa-editor-cancel").addEventListener("click", async () => {
                // check for dirty changes using unified selectors
                const nowTemp = {
                    name: qS(modal, "#wa-editor-name").value,
                    domain: qS(modal, "#wa-editor-domain").value,
                    ruleEnabled: qS(modal, "#wa-editor-enabled").checked,
                    selectors: (temp.selectors || []).map(it => ({ type: it.type, name: it.name, selector: it.selector }))
                };
                // simple dirty detection
                const isDirty = JSON.stringify(nowTemp) !== JSON.stringify(originalSnapshot);
                if (isDirty) {
                    const ok = await confirmDialog("Discard changes", "Discard unsaved changes?");
                    if (!ok) return;
                }
                modal.remove();
                editorOpen = false;
                editorTemp = null;
                renderCurrentTab();
            });

            // Save button
            qS(modal, "#wa-editor-save").addEventListener("click", async () => {
                // collect values
                temp.name = qS(modal, "#wa-editor-name").value.trim();
                temp.domain = qS(modal, "#wa-editor-domain").value.trim();
                temp.ruleEnabled = !!qS(modal, "#wa-editor-enabled").checked;
                // deletionRules toggle state stored on temp for save
                temp.deletionRules = temp.deletionRules || {};
                temp.deletionRules.enabled = !!qS(modal, "#wa-editor-deletionrules").checked;

                // ensure selectors arrays exist by splitting unified selectors
                temp.tempSelectors = (temp.selectors || []).filter(it => it.type !== "perm").map(it => ({ name: (it.name || "").trim(), selector: (it.selector || "").trim() })).filter(it => it.selector);
                temp.permanentSelectors = (temp.selectors || []).filter(it => it.type === "perm").map(it => ({ name: (it.name || "").trim(), selector: (it.selector || "").trim() })).filter(it => it.selector);

                if ((!temp.tempSelectors || temp.tempSelectors.length === 0) && (!temp.permanentSelectors || temp.permanentSelectors.length === 0)) {
                    toast("Please add at least one selector", "error");
                    return;
                }
                if (!temp.domain) {
                    toast("Please provide a valid domain", "error");
                    return;
                }
                // call ruleManager.saveRule with correct mode
                let payload = JSON.parse(JSON.stringify(temp));
                if (mode === "edit" && rule && rule.ID) {
                    payload.ID = rule.ID;
                }
                // ensure flag passed along for saveRule
                payload.deletionRulesEnabled = !!temp.deletionRules.enabled;

                try {
                    const result = ruleManager.saveRule(payload, mode === "edit" ? "edit" : "add");
                    if (!result || !result.status) {
                        toast("Failed to save rule", "error");
                        return;
                    }
                    if (result.status === "duplicate") {
                        // duplicate domain - offer merge into existing rule instead of silently failing
                        const existing = result.existingRule;
                        toast("Duplicate domain detected.", "error");
                        if (existing) {
                            // Ask user if they'd like to merge their unsaved changes into the existing rule
                            const ok = await confirmDialog("Merge rules?", `A rule already exists for domain \"${result.domain}\". Merge your changes into the existing rule? (OK = Merge, Cancel = Edit existing)`);
                            if (ok) {
                                try {
                                    // mergeRules will persist and return the merged saved rule
                                    const merged = ruleManager.mergeRules(existing, payload);
                                    toast("Rules merged", "success");
                                    // close editor and refresh UI + engine
                                    modal.remove(); editorOpen = false; editorTemp = null;
                                    renderCurrentTab();
                                    await engine.restart?.();
                                    return;
                                } catch (err) {
                                    console.error("Merge failed", err);
                                    toast("Merge failed", "error");
                                    return;
                                }
                            } else {
                                // Open existing rule for editing so the user can manually reconcile
                                openEditor("edit", existing);
                                modal.remove(); editorOpen = false; editorTemp = null;
                                return;
                            }
                        }
                        return;
                    }
                    if (result.status === "added" || result.status === "updated") {
                        toast(`Rule ${result.status}`, "success");
                        // ensure ruleEnabled is stored correctly (some flows add new rule)
                        const savedRule = result.rule;
                        if (savedRule && savedRule.ID) {
                            // if ruleEnabled not set, ensure default true
                            if (savedRule.ruleEnabled === undefined) {
                                ruleManager.updateRuleByID(savedRule.ID, { ruleEnabled: !!payload.ruleEnabled });
                            }
                        }
                        // refresh UI and restart engine
                        modal.remove();
                        editorOpen = false;
                        editorTemp = null;
                        renderCurrentTab();
                        await engine.restart?.();
                        return;
                    }
                    // other statuses
                    toast(result.message || "Unknown response from save", "error");
                } catch (err) {
                    console.error("Save failed", err);
                    toast("Error saving rule", "error");
                }
            });

            // expose a pick-to-editor method (used by element picker)
            return modal;
        }

        // Element picker: hover highlight & multi-click selector capture
        let pickerActive = false;
        let pickerOverlay = null;
        function startElementPicker() {
            if (pickerActive) return;
            pickerActive = true;
            toast("Element picker active: hover and click to pick elements. Press Esc to finish.", "info", 4000);

            pickerOverlay = document.createElement("div");
            pickerOverlay.style.position = "fixed";
            pickerOverlay.style.inset = "0";
            pickerOverlay.style.zIndex = "2147483649";
            // overlay must allow pointer events so we receive mousemove/click, but we'll use elementsFromPoint
            pickerOverlay.style.pointerEvents = "auto";
            pickerOverlay.style.cursor = "crosshair";
            // make overlay transparent
            pickerOverlay.style.background = "transparent";
            document.documentElement.appendChild(pickerOverlay);

            let lastEl = null;

            function isInOurUI(node) {
                try {
                    if (!node) return false;
                    // if node is within the host element or its shadow root, ignore
                    if (node.closest && node.closest(`#${hostId}`)) return true;
                    const root = node.getRootNode && node.getRootNode();
                    if (root && root.host && root.host.id === hostId) return true;
                } catch (e) { }
                return false;
            }

            function highlight(el) {
                if (!el) return;
                try {
                    el.__wa_old_outline = el.style.outline;
                    el.style.outline = "3px solid rgba(59,130,246,0.85)";
                } catch (e) { }
                lastEl = el;
            }
            function unhighlight(el) {
                if (!el) return;
                try { el.style.outline = el.__wa_old_outline || ""; delete el.__wa_old_outline; } catch (e) { }
                lastEl = null;
            }

            function findTopCandidate(x, y) {
                // elementsFromPoint returns top-down stack; pick first element that is not our overlay and not inside our UI
                const els = document.elementsFromPoint(x, y);
                if (!els || !els.length) return null;
                for (const e of els) {
                    if (!e) continue;
                    if (e === pickerOverlay) continue;
                    if (e === document.documentElement || e === document.body) continue;
                    if (isInOurUI(e)) continue;
                    return e;
                }
                return null;
            }

            function onMouseMove(ev) {
                const el = findTopCandidate(ev.clientX, ev.clientY);
                if (!el) {
                    if (lastEl) { unhighlight(lastEl); }
                    return;
                }
                if (lastEl && el !== lastEl) { unhighlight(lastEl); }
                if (el !== lastEl) highlight(el);
            }

            async function handlePickForElement(el, selector) {
                const pageDomain = location.hostname || location.href;   // raw host

                /* ------------------------------------------------------------------ */
                /* 1️⃣  Check if an existing rule matches the current domain.        */
                /* ------------------------------------------------------------------ */
                let matchedRule = null;
                try {
                    matchedRule = ruleManager.getAllRules().find(r => domainMatches(r.domain, pageDomain));
                } catch (e) { console.warn('domainMatches error', e); }

                /* ------------------------------------------------------------------ */
                /* 2️⃣  If we have a match – open the editor in edit mode.             */
                /* ------------------------------------------------------------------ */
                if (matchedRule) {
                    // Build a temporary copy of the rule that will be fed to the editor.
                    const ruleCopy = JSON.parse(JSON.stringify(matchedRule));

                    // Merge the newly picked selector into the temp selectors array
                    ruleCopy.tempSelectors = [...(ruleCopy.tempSelectors || []), { type: 'temp', name: '', selector }];

                    // Open the editor in *edit* mode (first argument is "edit").
                    openEditor('edit', ruleCopy, null);

                    toast('Selector added to existing rule editor', 'success', 2000);
                    stopPicker();                     // we’re done – let the user finish editing
                    return;
                }

                /* ------------------------------------------------------------------ */
                /* 3️⃣  No matching rule – start a brand‑new rule (add mode).         */
                /* ------------------------------------------------------------------ */
                const newRulePayload = {
                    selector,          // first selector of the new rule
                    name: '',          // no custom name yet
                };
                openEditor('add', null, newRulePayload);

                // pre‑fill the domain field – this is a one‑off after the modal is rendered.
                const modalEl = qS(shadow, '.wa-editor-modal');
                if (modalEl) {
                    try { qS(modalEl, '#wa-editor-domain').value = pageDomain; } catch (_) { }
                }

                toast('Selector added to new editor', 'success', 2000);
                stopPicker();                     // close the picker – user will finish editing
            }

            function onClick(ev) {
                ev.preventDefault();
                ev.stopPropagation();
                const el = findTopCandidate(ev.clientX, ev.clientY);
                if (!el) return; // ignore clicks that don't hit a candidate

                // generate selector (use existing generateCssSelector if available)
                let selector = "";
                try {
                    if (typeof generateCssSelector === "function") selector = generateCssSelector(el) || "";
                } catch (e) { /* ignore */ }
                if (!selector) {
                    // fallback: try id or classes
                    try {
                        if (el.id) selector = `#${cssEscape(el.id)}`;
                        else if (el.classList && el.classList.length) {
                            selector = el.tagName.toLowerCase() + "." + Array.from(el.classList).map(c => cssEscape(c)).join(".");
                        } else {
                            selector = el.tagName.toLowerCase();
                        }
                    } catch (e) { selector = ''; }
                }

                if (!selector) {
                    toast('Unable to compute selector for element', 'error');
                    return;
                }

                // Do NOT stop picker — allow multiple picks. Append selector to editor/modal.
                handlePickForElement(el, selector).catch(() => {/* swallow */ });
            }

            function onKey(ev) {
                if (ev.key === 'Escape') stopPicker();
            }

            function stopPicker() {
                pickerActive = false;
                try {
                    if (lastEl) unhighlight(lastEl);
                    pickerOverlay.removeEventListener('mousemove', onMouseMove);
                    pickerOverlay.removeEventListener('click', onClick, { capture: true });
                    window.removeEventListener('keydown', onKey);
                    document.documentElement.removeChild(pickerOverlay);
                } catch (e) { }
                pickerOverlay = null;
            }

            pickerOverlay.addEventListener('mousemove', onMouseMove);
            // attach click with capture so clicks on elements don't get swallowed by page handlers
            pickerOverlay.addEventListener('click', onClick, { capture: true });
            window.addEventListener('keydown', onKey);
        }

        // Hook deletion events from engine to update perLoadCounts and UI
        // Reworked: only attach stats listeners when statsEnabled === true,
        // and reconfigure when settings change.
        let statsEngineUnsubscribe = null;
        let statsWindowHandler = null;

        function configureStatsListeners() {
            // detach previous
            try {
                if (typeof statsEngineUnsubscribe === "function") {
                    statsEngineUnsubscribe();
                    statsEngineUnsubscribe = null;
                }
            } catch (e) { statsEngineUnsubscribe = null; }
            try {
                if (statsWindowHandler) {
                    window.removeEventListener("web-assassin:elements-deleted", statsWindowHandler);
                    statsWindowHandler = null;
                }
            } catch (e) { statsWindowHandler = null; }

            // Clear per-load counters when stats disabled
            const s = getSettings();
            if (!s?.statsEnabled) {
                perLoadCounts.clear();
                // refresh UI if visible
                if (panelVisible && (currentTab === "status" || currentTab === "stats")) {
                    renderCurrentTab();
                }
                return;
            }

            // statsEnabled === true: prefer engine.onDeleted if available (programmatic),
            // otherwise listen to window event.
            try {
                if (engine && typeof engine.onDeleted === "function") {
                    statsEngineUnsubscribe = engine.onDeleted((detail) => {
                        try {
                            const id = detail.ruleID;
                            const count = Number(detail.count || 1);
                            perLoadCounts.set(id, (perLoadCounts.get(id) || 0) + count);
                            if (panelVisible && currentTab === "status") renderStatusTab();
                            if (panelVisible && currentTab === "stats") renderStatsTab();
                        } catch (e) { /* swallow */ }
                    });
                    return;
                }
            } catch (e) { /* ignore and fallback */ }

            // fallback: window event
            statsWindowHandler = (e) => {
                try {
                    const detail = e.detail || {};
                    const id = detail.ruleID;
                    const count = Number(detail.count || 1);
                    perLoadCounts.set(id, (perLoadCounts.get(id) || 0) + count);
                    if (panelVisible && currentTab === "status") renderStatusTab();
                    if (panelVisible && currentTab === "stats") renderStatsTab();
                } catch (err) { /* swallow */ }
            };
            window.addEventListener("web-assassin:elements-deleted", statsWindowHandler);
        }

        // configure initially
        configureStatsListeners();

        // When settings change externally, re-render AND reconfigure stats listeners
        window.addEventListener("web-assassin:settings-changed", () => {
            style.textContent = buildStyles();
            renderCurrentTab();
            configureStatsListeners();
        });

        // Initial render and attach to shadow
        renderCurrentTab();

        // Do not auto-show panel on init. The UI is created lazily and the user opens it explicitly.
        // The panel will be shown when the user clicks the floating icon (handled by the lazy bootstrap below).

        // expose helper for tests/debug
        return {
            showPanel,
            hidePanel,
            togglePanel,
            openEditor,
        };
    }
    // ----------------------
    // CONTENT SCRIPT BOOTSTRAP — ALWAYS START ENGINE BEFORE UI
    // ----------------------
    (async () => {
        // Load settings
        let saved = await gmGet(GM_KEY, null);
        if (!saved) {
            saved = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
            await gmSet(GM_KEY, saved);
        }

        // Create rule manager (SHARED with UI)
        const ruleManager = RuleManager(saved);
        window.webAssassinRuleManager = ruleManager;

        // Create engine and attach to window
        const deletionEngine = DeletionEngine(ruleManager);
        window.webAssassinEngine = deletionEngine;

        if (!saved.scriptDisabled) {
            deletionEngine.start();
        }

        window.addEventListener("web-assassin:refresh-engine", () => {
            deletionEngine.restart?.();
        });
    })();


    // expose initUI to window and initialize immediately
    window.webAssassinInitUI = initUI;
    // Lazy UI bootstrap: create a lightweight global FAB that initializes the full shadow-root UI on first click.
    (function createLiteFab() {
        if (document.getElementById("web-assassin-fab-lite")) return;
        const lite = document.createElement("div");
        lite.id = "web-assassin-fab-lite";
        lite.className = "web-assassin-fab-lite";
        lite.title = "Web Assassin";
        lite.textContent = "WA";
        // inline styles so the lite FAB looks usable before the shadow UI exists
        lite.style.cssText = 'position:fixed; width:56px; height:56px; bottom:18px; right:18px; border-radius:50%; display:flex; align-items:center; justify-content:center; cursor:pointer; box-shadow:0 6px 18px rgba(0,0,0,0.25); background:#0078d4; color:white; font-weight:700; z-index:2147483647; pointer-events:auto;';
        document.documentElement.appendChild(lite);

        async function onClickOnce(ev) {
            try {
                // initialize full UI (which creates its own shadow-root FAB/panel)
                const ui = await initUI();
                window.webAssassinUI = ui;
                // remove lite FAB
                try { lite.remove(); } catch (e) { }
                // show the panel because user clicked the icon
                try { ui.showPanel && ui.showPanel(); } catch (e) { }
                console.info("Web Assassin UI initialized (lazy).");
            } catch (err) {
                console.error("Failed to initialize Web Assassin UI (lazy)", err);
            } finally {
                lite.removeEventListener("click", onClickOnce);
            }
        }

        lite.addEventListener("click", onClickOnce);
    })();
    // End of IIFE
})();
