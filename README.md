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

Web Assassin internally behaves like a modular micro-application:

## 🧩 1. Lazy-Loaded UI Subsystem
- UI is constructed **only when needed**, reducing overhead.  
- Built with a lightweight pseudo–virtual DOM element factory.  
- Dynamic classes and CSS rules allow theme customization (light/dark/assassin mode).

## ⚔️ 2. Lazy-Loaded Deletion Engine
- Heavy selection & deletion logic loads only after entering **Assassin Mode**.  
- Supports multiple kill algorithms:  
  - Direct selector removal  
  - Pattern-based elimination  
  - Attribute-filter rules  
  - MutationObserver auto-kills  

## 🐒 3. Rule Manager & Persistence Layer
- Clean JSON registry stored via GM APIs.  
- Fast lookup tables for real-time matching.  
- Optimized string matching and DOM scanning.

## 🕵️ 4. Intelligent Target Selector
- Context-aware scoring for element selection.  
- Provides:  
  - Click-based targeting  
  - Selector preview  
  - DOM path extraction  
  - Sanitized, stable selectors  

## 🎨 5. Theme & Style Modules
- Modular, SCSS-style structure.  
- User-configurable colors and animations.  
- Signature “Assassin Glow” highlight.

## 🧲 6. Observer-Driven Auto-Elimination
- Mutation Observer monitors DOM for reappearing targets.  
- Automatically applies persistent kill-rules.  
- Defeats reinserting ads/popups.

---

# 🌟 Features & Advantages

### ⭐ Stealth Architecture
- Minimal runtime impact  
- Loads everything only when needed  

### 🎯 Precision DOM Assassination
- Click → eliminate instantly  
- Auto-extracts selectors  
- Remove a single element or all matches  

### 🧾 Persistent Rule System
- Save rules for future page loads  
- Edit, disable, export, import rules  

### 🎨 Custom Themes
- Select color palettes  
- Light/Dark/Assassin Mode  

### 🔥 Future-Proof
- Modular structure  
- Clean APIs  
- Extensible for upcoming features

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
