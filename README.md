# 🥷 Web Assassin  
### *The Stealthiest, Smartest, Most Aggressive DOM-Slayer Ever Deployed*

Web Assassin is a **high-precision DOM elimination engine** disguised as a browser userscript.  
It stalks every webpage quietly… waiting for your command… then **strikes with surgical accuracy** to erase ads, elements, annoyances, or anything standing between you and a clean browsing experience.

This userscript is not just a script.  
It is a **mini-application**, armed with intelligent state machines, contextual UI, dynamic behaviors, and performance-oriented architecture built for future expansion.

---

## 🧠 Personality
Web Assassin behaves like a **disciplined ninja**:

- **Smart:** It evaluates your targets using selectors, rules, and heuristics.  
- **Aggressive:** When you mark a target, it eliminates it instantly.  
- **Stubborn:** It remembers your kill-patterns and enforces them across future visits.  
- **Silent:** Loads UI and engines lazily to minimize memory and stay invisible.

---

# ⚙️ Architectural Overview (Technical)

Web Assassin is built as a modular, scalable mini-application composed of **three primary components**:

---

## 🧩 1. Bootstrap (Lazy Loader & Core Orchestrator)
The bootstrap system is the script’s “strategist.” It decides **what to load**, **when to load**, and **how to load** it.

- It initializes instantly with **minimal overhead**, doing only essential checks.  
- Performs early tasks such as:
  - Detecting whether the current domain has matching rules.
  - Preparing the script’s internal state.
  - Delaying heavy module loading for optimal performance.
- The UI is **not** loaded immediately.  
  Instead, the bootstrap lazily loads the UI **only when the floating Assassin icon is clicked**.  
  This keeps memory usage extremely low until the user explicitly wants to interact.

---

## ⚔️ 2. Deletion Engine (Lazy, Domain-Aware DOM Assassin)
The Deletion Engine awakens **only** when needed.  
Its first task is domain scanning:

1. **Check the current page’s domain** against all saved rules in GM JSON storage.  
2. If **no rules match**, the engine stays dormant.  
3. If **rules exist**, the engine wakes and begins processing.

### 🧠 Rule-Based Element Aggregation
Matched selectors are categorized into two groups:

#### **`temp` group — temporary eliminations**
- For rules meant to clean initial page loads.  
- Engine monitors the DOM for **up to 3 seconds** after `document-start`.  
- If the DOM stabilizes earlier, the temp observers shut down automatically.  
- Designed for elements that appear once and never reappear.

#### **`perm` group — permanent eliminations**
- For stubborn, reappearing elements injected by scripts, ads, or dynamic UIs.  
- Engine creates **one global MutationObserver** per context (DOM or iframe).  
- This observer:
  - Watches *all* newly added nodes.
  - Matches them against the permanent selectors.
  - Eliminates them instantly on arrival.

### 🧲 Observer Efficiency Guarantee
No matter how many rules match the current page:

- Each DOM/iframe has **only 2 observers** maximum:
  - 1 temporary observer  
  - 1 permanent observer  

This architecture maintains extremely high performance even on heavily dynamic websites.

---

## 🎨 3. UI System (Fully Lazy-Loaded, Modular Interface)
The UI layer remains unloaded until the user engages with the floating icon.

Once triggered:

- The full UI loads dynamically.
- Components are assembled via a lightweight factory-style system.
- Supports custom themes and animations.
- Only loads once per session for maximum efficiency.

The bootstrap ensures **instant initial startup**, while still providing a complete, rich UI when needed.

---

# 🌟 Features & Advantages (Non-Technical)

### ⭐ Stealth Architecture
- Loads only what is needed when it is needed.
- Keeps memory usage extremely low.

### 🎯 Precision DOM Assassination
- Click-to-delete.
- Auto-detects selector patterns.
- Optionally remove all similar elements.

### 🔕 Notifications & Statistics (Optional)
Web Assassin includes:

- **Real-time activity notifications**
- **Deletion statistics**
- **Rule usage counters**

Everything can be individually **enabled or disabled** based on user preference.

### 🧾 Intelligent Rule System
Web Assassin includes a **smart, self-organizing rule engine**:

- Automatically **merges new rules** with existing ones when they share the same domain.
- Prevents **duplicate CSS selectors** within the same rule.
- Ensures that no redundant or overlapping rules are stored.
- Allows assigning:
  - **Custom names** for each rule  
  - **Custom names** for each CSS/selector entry  

This makes large rule sets easy to navigate and recall later.

### 🎨 Custom Themes
- Light, dark, assassin-style highlights.
- Fully customizable accent colors.

### 🔥 Future-Proof Design
- Modular code structure.
- Clean APIs.
- Built for expansion.



---

# 🛠️ Installation Guide (Tampermonkey & Violentmonkey)

## 1. Install a Userscript Manager
Choose one:

- **Violentmonkey** (recommended)  
- **Tampermonkey**  
- Greasemonkey (limited compatibility)

## 2. Install Web Assassin
1. Open your userscript manager.  
2. Click **Create New Script** or **Add Script**.  
3. Paste the full contents of `Web Assassin.js`.  
4. Save & enable the script.

---

# 🗡️ How to Use Web Assassin

### 🥷 Enter Assassin Mode
- Click the **Web Assassin panel button** on the page.  
- UI expands into assassin-themed control mode.

### 🎯 Target an Element
1. Enable **Target Mode** (crosshair icon).  
2. Hover over elements to preview.  
3. Click any element to eliminate it.

### 📝 Save a Persistent Rule
After eliminating an element:

- Choose selector type (exact / generalized / attribute-based).  
- Save the rule → applies automatically next time.

### 🧹 Manage Rules
- Open the **Rules tab**.  
- Enable, edit, delete, import, export rules.  

---

# 🧪 Developer Notes
Architecture follows a quasi-MVC pattern:

- **Model:** Rule Store  
- **View:** Lazy UI  
- **Controller:** Deletion Engine  

Includes:

- Custom event bus  
- DOM utilities  
- Selector normalizer  
- Rule persistence API  

---

# 🔥 Final Word  
**Web Assassin is your silent partner in the war against intrusive UI.**  
It does not negotiate.  
It does not hesitate.  
It eliminates—cleanly, quickly, and permanently.

---
