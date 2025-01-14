/* -----------------------------
 * 1. Functional Lenses
 * -----------------------------
 */
export const lensProp = (prop) => ({
  get: (obj) => _.get(obj, prop),
  set: (val, obj) => {
    const clone = _.cloneDeep(obj);
    _.set(clone, prop, val);
    return clone;
  },
});

export const lensPath = (path) => ({
  get: (obj) => _.get(obj, path),
  set: (val, obj) => {
    const clone = _.cloneDeep(obj);
    _.set(clone, path, val);
    return clone;
  },
});

const styleDisplayLens = {
  get: (el) => el.style.display,
  set: (val, el) => {
    if (el.style.display !== val) el.style.display = val;
    return el;
  },
};

const innerHtmlLens = {
  get: (el) => el.innerHTML,
  set: (val, el) => {
    if (el.innerHTML !== val) el.innerHTML = val;
    return el;
  },
};

/* -----------------------------
 * 2. Reactive Signal (fine-grained)
 * -----------------------------
 */
class Signal {
  constructor(initialVal) {
    this.val = initialVal;
    this.deps = []; // Observers
  }
  set(updater) {
    const oldVal = this.val;
    const newVal = _.isFunction(updater) ? updater(oldVal) : updater;
    if (_.isEqual(newVal, oldVal)) return; // Skip if same
    this.val = newVal;
    // Notify each observer
    _.forEach(this.deps, (f) => f());
  }
}

/* -----------------------------
 * 3. Island Management
 * -----------------------------
 * We'll treat each island as a small "component" with its own signals.
 * We store them in an "islands" dictionary keyed by island ID or DOM node.
 */
const islands = new WeakMap(); 
// or a Map<HTMLElement, { signals, methods }> or something similar

// Each island will store:
//   signals: an object { [key: string]: Signal }
//   rootEl: the root DOM element
//   rebind: function to re-scan for data bindings
//   bindEvents: function to attach event listeners once

/* -----------------------------
 * 4. Helper: asFunc
 * -----------------------------
 */
const asFunc = (codeStr) =>
  new Function(`with({...arguments[0], ...arguments[1]}) { return ${codeStr} }`);

/* -----------------------------
 * 5. doFetch => non-blocking partial updates
 * -----------------------------
 * Instead of scanning entire DOM, we only bind new elements in the island sub-tree
 */
const createFragmentFromHTML = (html) => {
  const frag = document.createDocumentFragment();
  const temp = document.createElement("div");
  temp.innerHTML = html;
  while (temp.firstChild) {
    frag.appendChild(temp.firstChild);
  }
  return frag;
};

const doFetch = (island, el, { url, method, to }) => {
  const needsPayload = ["INPUT", "BUTTON"].includes(el.tagName);
  const payload = needsPayload ? { [el.name]: el.value } : {};

  const requestConfig = { method, url, data: payload };

  const fetchTask = () => {
    axios.request(requestConfig).then((resp) => {
      if (!to) return;
      const html = resp.data;
      if (to === "el") {
        innerHtmlLens.set(html, el);
        // Re-bind new children in el's sub-tree only
        island.rebind(el);
      } else {
        const parents = document.querySelectorAll(to.target);
        _.forEach(parents, (p) => {
          // If same, skip
          if (p.innerHTML === html && to.swap === "replace") return;
          const frag = createFragmentFromHTML(html);
          switch (to.swap) {
            case "prepend":
              p.insertBefore(frag, p.firstChild);
              break;
            case "append":
              p.appendChild(frag);
              break;
            default:
              // replace
              p.replaceChildren(createFragmentFromHTML(html));
          }
          // Re-bind only in this parent's sub-tree
          island.rebind(p);
        });
      }
    });
  };

  if ("requestIdleCallback" in window) {
    requestIdleCallback(fetchTask);
  } else {
    setTimeout(fetchTask, 0);
  }
};

/* -----------------------------
 * 6. Event Handler 
 * -----------------------------
 * Instead of binding events globally, each island
 * will add listeners to its own root (or document, if needed).
 */
const onEvent = (ev) => {
  // We discover which island this event belongs to by searching up the DOM
  const islandRoot = ev.target.closest("[data-island]");
  if (!islandRoot) return;

  const island = islands.get(islandRoot);
  if (!island) return;

  const { getConfigs } = island; 
  const configs = getConfigs(ev);
  if (_.isEmpty(configs)) return;

  _.forEach(configs, (cfg) => {
    if (cfg.before) {
      const canRun = asFunc(cfg.before)(island.signals, { $ev: ev });
      if (!canRun) return;
    }
    if (cfg.code) {
      asFunc(cfg.code)(island.signals, { $ev: ev });
    } else {
      doFetch(island, ev.target, cfg);
    }
  });
};

/* -----------------------------
 * 7. Functions to parse attributes & bind data
 * -----------------------------
 */
const parseEventConfigs = (ev) => {
  const { type, target, key } = ev;
  const attrKey = type === "keyup" ? `@${(key || "").toLowerCase()}` : `@${type}`;
  const attrVal = target.getAttribute(attrKey);
  if (!attrVal) return [];

  const before = target.getAttribute("before");
  if (_.includes(attrVal, ":/")) {
    const [method, url] = attrVal.split(":");
    const toAttr = _.find([...target.attributes], (x) => x.name.startsWith("to"));
    let cfg = { method, url, before };
    if (toAttr) {
      const [_, maybeSwap] = toAttr.name.split(":");
      cfg.to = { swap: maybeSwap || "replace", target: toAttr.value };
    }
    return [cfg];
  }
  return [{ code: attrVal, before }];
};

/**
 * bindDataAttr: sets up a function that updates an element's property
 * whenever the relevant signal(s) change.
 */
function bindDataAttr(island, el, attr) {
  const expr = attr.value; // e.g. "count" or "someSignal + 1"
  const eventOrProp = attr.name.slice(1); // remove the leading ':'
  const fn = asFunc(expr);

  // Each time the signal changes, run this:
  const update = () => {
    const val = fn(island.signals, {});
    switch (eventOrProp) {
      case "show":
        styleDisplayLens.set(val ? "" : "none", el);
        break;
      case "html":
        innerHtmlLens.set(val, el);
        break;
      default:
        // only set if changed
        if (el.getAttribute(eventOrProp) !== String(val)) {
          el.setAttribute(eventOrProp, val);
        }
    }
  };

  // Register with all signals read by fn
  // (We rely on the Proxy-based approach to attach deps automatically)
  let _tempReg = update;
  _tempReg(); // run once
  _tempReg = null;
}

/* -----------------------------
 * 8. Setting up an Island
 * -----------------------------
 * Each island has:
 *   - signals: { key: Signal }
 *   - rootEl
 *   - getConfigs: function to parse @... from an event
 *   - rebind: function to re-scan sub-tree for data bindings
 *   - bindEvents: attach event listeners at island root or doc
 */
function createIsland(rootEl) {
  // Build the signals map from any :state on the island root
  // or possibly child elements that declare :state
  // We'll gather them in an object: { [key]: Signal } 
  let signals = {};

  // We'll define a "read" approach that scans sub-tree for :state
  // purely, returning new signals each time, then merges them in signals object.
  function gatherState(el) {
    const st = el.getAttribute(":state");
    if (!st) return {};
    const jsonStr = st.replace(/(\w+):/g, '"$1":');
    const parsed = JSON.parse(jsonStr);
    // convert each key to a signal
    return _.mapValues(parsed, (val) => new Signal(val));
  }

  // We’ll do an initial pass for :state only on immediate children or itself.
  // (In advanced usage, you might look deeper. Up to you.)
  const childStates = rootEl.querySelectorAll("[data-island] [\\:state]");
  const allElems = [rootEl, ...childStates];
  _.forEach(allElems, (elem) => {
    const part = gatherState(elem);
    // merge with signals if not present
    _.forOwn(part, (v, k) => {
      if (!signals[k]) {
        signals[k] = v;
      }
    });
  });

  // Make signals a Proxy
  // => reading signals attaches a "dep" if we are in the middle of a registration function
  let regFn = null;
  const proxySignals = new Proxy({}, {
    get(target, prop) {
      if (typeof prop === "symbol") return;
      const sig = signals[prop];
      if (regFn && sig) sig.deps.push(regFn);
      return sig;
    },
    set() {
      // We typically don't set signals this way. We do signals[key].set(...)
      return true;
    },
  });

  // Fine-grained approach: we do not bind the entire sub-tree on every update.
  // We only do it once at init or after new DOM insertion.
  const rebind = (subRoot) => {
    // find all new elements with data-binding or events
    // inside `subRoot` (which might be an inserted fragment or the root)
    const items = subRoot.querySelectorAll("[\\:state], [\\@], [\\:]");
    // In a real “island,” you might only scan direct children or so.
    _.forEach(items, (el) => {
      // If there's :state, parse once
      if (el.hasAttribute(":state")) {
        const st = gatherState(el);
        // Merge signals
        _.forOwn(st, (val, key) => {
          if (!signals[key]) signals[key] = val;
        });
      }
      // Next, for each attribute that starts with ":", bind data
      _.forEach(el.attributes, (attr) => {
        if (attr.name.startsWith(":")) {
          // define a register function that updates
          regFn = () => bindDataAttr(island, el, attr);
          regFn(); 
          regFn = null;
        }
      });
    });
  };

  // Set up event-binding: we attach a single listener to the island root
  // capturing events in the sub-tree. This is more local than global doc.
  const bindEvents = () => {
    rootEl.addEventListener("click", onEvent, true);
    rootEl.addEventListener("keyup", onEvent, true);
    // You could add other event types as needed
  };

  // Return an object describing this island
  const island = {
    rootEl,
    signals: proxySignals,
    rebind: (el) => rebind(el || rootEl),
    bindEvents,
    getConfigs: parseEventConfigs,
  };
  return island;
}

/* -----------------------------
 * 9. Initialize all islands
 * -----------------------------
 */
function initIslands() {
  const islandRoots = document.querySelectorAll("[data-island]");
  _.forEach(islandRoots, (rootEl) => {
    // create island
    const island = createIsland(rootEl);
    islands.set(rootEl, island);
    // rebind the entire root once
    island.rebind(rootEl);
    // attach local event listeners
    island.bindEvents();
  });
}

/* -----------------------------
 * 10. Global init (non-blocking)
 * -----------------------------
 */
function init() {
  const initTask = () => initIslands();
  if ("requestIdleCallback" in window) {
    requestIdleCallback(initTask);
  } else {
    setTimeout(initTask, 0);
  }
}

// Kick off
init();

// Expose if needed
window.App = { islands };
