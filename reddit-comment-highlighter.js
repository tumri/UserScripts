// ==UserScript==
// @name         Reddit Comment Highlighter
// @description  Highlights New Comments
// @version      0.1
// @icon         https://www.redditstatic.com/desktop2x/img/favicon/favicon-16x16.png
// @namespace    Tumri
// @author       Tumri
// @copyright    2020+, Tumri Ganguri (g.tumri@gmail.com)
// @downloadURL  https://raw.githubusercontent.com/tumri/UserScripts/master/reddit-comment-highlighter.js
// @updateURL    https://raw.githubusercontent.com/tumri/UserScripts/master/reddit-comment-highlighter.js
// @include      /^https?:\/\/([a-z]+\.)?reddit\.com\/r\/[a-zA-Z0-9_-]+\/comments\/[0-9a-z]+\/[^/]+\//
// @require      https://cdn.jsdelivr.net/npm/xxhashjs@0.2.2/build/xxhash.min.js
// @require      https://cdn.jsdelivr.net/npm/flatpickr@4.6.3/dist/flatpickr.min.js
// @resource     flatpickrCSS https://cdn.jsdelivr.net/npm/flatpickr@4.6.3/dist/themes/dark.css
// @grant        GM_addStyle
// @grant        GM_getResourceText
// ==/UserScript==

("use strict")

// Set by Header Script from reddit.com
/* globals r */

// Set by xxhash.min.js from @require
/* globals XXH */

// Set by flatpickr.min.js from @require
/* globals flatpickr */

const RCH = {
  Settings: {
    get cacheExpirationDays() { return 14 }, // The number of days to remember when you last visited a comment thread, cache is purged of older values with a matching prefix.
    get color() { return "#e1b000" }, // The color to use to highlight the border of new comments, #e1b000 is a bright yellow that typically looks okay.
    get prefix() { return "µRCH" }, // The prefix for tagging anything exposed publicly, like localStorage keys, "µ" is typically sorted lower and is unlikely to conflict.
    get hashSeed() { return 0x499602D2 }, // The hash seed used to generate obfuscated cache keys from user and comment thread identifiers, this is not guaranteed to be secure.
    get loggingEnabled() { return true }, // Enables logging to the console.
  },

  // Stateful Variables, will not be frozen.
  _STATE: {
    flatpickr: null,
    lastVisitUnix: null,
    customDateUnix: null,
  },

  // Getters/Setters for _STATE variables with validation & reconciliation, getters for variables that get pulled from reddit / globals, computed vars.
  State: {
    get flatpickr() {
      return RCH._STATE.flatpickr
    },
    set flatpickr(instance) {
      instance.setDate(RCH.State.highlightDate, false)
      RCH._STATE.flatpickr = instance
    },

    get lastVisitUnix() {
      return RCH._STATE.lastVisitUnix
    },
    set lastVisitUnix(update) {
      if (typeof update != 'number') { return }
      RCH._STATE.lastVisitUnix = update
      RCH.Document.reconcileState()
    },

    get customDateUnix() {
      return RCH._STATE.customDateUnix
    },
    set customDateUnix(update) {
      if (typeof update != 'number') { return }
      RCH._STATE.customDateUnix = update
      RCH.Document.reconcileState()
    },

    get highlightDate() {
      if (RCH.State.customDateUnix != null) {
        return new Date(RCH.State.customDateUnix)
      } else if (RCH.State.lastVisitUnix != null) {
        return new Date(RCH.State.lastVisitUnix)
      }
      return Date.now()
    },

    get userName() {
      return r?.config?.logged
        ?? "anonymous"
    },
    get userId() {
      return r?.config?.user_id
        ?? 0
    },
    get subreddit() {
      return r?.config.cur_listing
        ?? document.URL.match(RCH.Static.urlSubredditRegExp)?.[1]
    },
    get commentThreadId() {
      return r?.config?.cur_link?.match(RCH.Static.curLinkThreadIdRegExp)?.[1]
        ?? document.URL.match(RCH.Static.urlThreadIdRegExp)?.[1]
    },

    get cacheKeyHash() {
      return RCH.hashFromString(`${RCH.State.userName + RCH.State.subreddit}`)
        + RCH.hashFromString(`${RCH.State.userId + RCH.State.commentThreadId}`)
    },
    get cacheKey() {
      return `${RCH.Settings.prefix}.${RCH.State.cacheKeyHash}`
    },

    // Sets _STATE directly without setter side-effects, should only be called on init.
    setupInitialValues: () => {
      const lastVisitUnix = RCH.Cache.currentThreadEntryOrNull?.lastVisitUnix
      if (lastVisitUnix) {
        RCH._STATE.lastVisitUnix = lastVisitUnix
      } else {
        RCH._STATE.lastVisitUnix = Date.now()
      }
      RCH.log(
        `Looked in Cache with Parameters: `
        + ` User: ${RCH.State.userName}`
        + `, Subreddit: ${RCH.State.subreddit}`
        + `, Comment Thread: ${RCH.State.commentThreadId}`
        + `, Unix Timestamp: ${lastVisitUnix ?? "Not Found"}`
      )
    }
  },

  // Getters for Cached values, functions for interacting with the Cache.
  Cache: {
    get entryExpirationDate() {  return new Date().fp_incr(-RCH.Settings.cacheExpirationDays) },

    get allEntries() {
      return Object.entries(localStorage)
        .filter(([key]) => {
          return key.startsWith(RCH.Settings.prefix)
        })
        .map(([key, value]) => {
          return RCH.Cache.mapEntry({key: key, value: value})
        })
    },
    get currentThreadEntryOrNull() {
      const value = localStorage.getItem(RCH.State.cacheKey)
      return value
        ? RCH.Cache.mapEntry({key: RCH.State.cacheKey, value: value})
        : null
    },

    removeExpiredEntries: () => {
      // Purge values from cache which exceed the expirationDate.
      let purgedKeys = 0
      RCH.Cache.allEntries.forEach((entry) => {
        if (entry.lastVisitDate < RCH.Cache.entryExpirationDate) {
          localStorage.removeItem(entry.key)
          purgedKeys += 1
        }
      })
      if (purgedKeys > 0) {
        RCH.log(
          `Removed ${purgedKeys} localStorage Values older than ${RCH.Settings.cacheExpirationDays} days`
        )
      }
    },
    refreshCurrentThreadEntry: () => {
      // Set a localStorage value for the current reddit thread for the current user.
      const now = Date.now()
      RCH.log(
        `Setting localStorage Value for the current user, Unix Timestamp: ${now}`
      )
      localStorage.setItem(RCH.State.cacheKey, now)
    },

    mapEntry: ({key, value}) => {
      return {
        key: key,
        value: value,
        get lastVisitUnix() { return value && Number(value) },
        get lastVisitDate() { return value && Date(Number(value)) }
      }
    },
  },

  // Getters for DOM elements, functions that manipulate the DOM.
  Document: {
    get comments() {
      return Array.from(document.querySelectorAll(".comment > .entry"))
    },
    get highlightedComments() {
      return Array.from(document.querySelectorAll(`.comment > .${RCH.Static.highlightClass}`))
    },

    get stylesheetTargetElement() {
      return document.head
    },
    get containerTargetElement() {
      return document.querySelector(".commentarea > .menuarea")
    },

    get container() {
      return document.querySelector(`#${RCH.Static.containerDivId}`)
    },
    get flatpickrInput() {
      return document.querySelector(`#${RCH.Static.flatpickrInputId}`)
    },
    get resetButtonSpan() {
      return document.querySelector(`#${RCH.Static.resetButtonSpanId}`)
    },
    get highlightCounterSpan() {
      return document.querySelector(`#${RCH.Static.highlightCounterSpanId}`)
    },

    addStylesheet: () => {
      RCH.Document.stylesheetTargetElement.insertAdjacentHTML("beforeend", RCH.Static.stylesheetHTML)
    },
    addElements: () => {
      // Setup DOM elements.
      RCH.Document.containerTargetElement.insertAdjacentHTML("beforeend", RCH.Static.datePickerHTML)
    },
    setupDatePicker: () => {
      // Setup flatpickr and event listeners.
      RCH.State.flatpickr = flatpickr(
        RCH.Document.flatpickrInput,
        RCH.Static.flatPickrConfig
      )

      RCH.Document.resetButtonSpan
        .addEventListener(
          "click",
          () => {
            RCH.State.customDateUnix = Date.now()
            RCH.State.flatpickr.clear()
          }
        )
    },

    reconcileState: () => {
      if (!RCH.Document.container) {
        RCH.log(
          `RCH Container not found, reinitializing RCH Elements`
        )
        RCH.Document.addElements()
        RCH.Document.setupDatePicker()
      }

      RCH.log(
        `Highlighting Comments since ${RCH.State.highlightDate.toLocaleString()}`
      )

      const highlightedCommentCount = RCH.Document.comments
        .reduce((highlightCount, comment) => {
          const commentTimeElement = comment.querySelector("time")
          const commentDate = new Date(Date.parse(commentTimeElement.dateTime))
          // Skip older comments, removing the highlighting if necessary
          if (commentDate > RCH.State.highlightDate) {
            comment.classList.add(RCH.Static.highlightClass)
            highlightCount++
          } else {
            comment.classList.remove(RCH.Static.highlightClass)
          }
          return highlightCount
        }, 0)

      const highlightCounter = RCH.Document.highlightCounterSpan
      highlightCounter.textContent = `${highlightedCommentCount}`
      if (highlightedCommentCount > 0) {
        highlightCounter.classList.add(RCH.Static.highlightTextClass)
      } else {
        highlightCounter.classList.remove(RCH.Static.highlightTextClass)
      }
    },
  },

  // (Relatively) Static computed strings and functions.
  Static: {
    get urlSubredditRegExp() { return /\/r+\/([^\/]+)\/comments\/[^\/]+\/[^\/]+\/?/ },
    get urlThreadIdRegExp() { return /\/r+\/[^\/]+\/comments\/([^\/]+)\/[^\/]+\/?/ },
    get curLinkThreadIdRegExp() { return /[\S]+_+([\S]*)/ },

    get highlightClass() { return `${RCH.Settings.prefix}-highlight` },
    get highlightTextClass() { return `${RCH.Settings.prefix}-highlight-txt` },

    get containerDivId() { return `${RCH.Settings.prefix}-container` },
    get flatpickrInputId() { return `${RCH.Settings.prefix}-fp-input` },
    get descriptionTextSpanId() { return `${RCH.Settings.prefix}-desc-txt-span` },
    get resetButtonSpanId() { return `${RCH.Settings.prefix}-reset-btn-span` },
    get highlightCounterSpanId() { return `${RCH.Settings.prefix}-highlight-ct-span` },

    get datePickerHTML() {
      return `
        <div id="${RCH.Static.containerDivId}" class="spacer">
          <div style="display: inline-block;">
            <span id="${RCH.Static.descriptionTextSpanId}">highlight comments since: </span>
            <input id="${RCH.Static.flatpickrInputId}" type="text" placeholder="select" readonly="readonly">
            <span>(found: <span id="${RCH.Static.highlightCounterSpanId}"></span>)</span>
            <span id="${RCH.Static.resetButtonSpanId}">reset</span>
          </div>
        </div>
      `
    },
    get stylesheetHTML() {
      return `
        <style>
          ${GM_getResourceText("flatpickrCSS")}
          .flatpickr-current-month input.cur-year {
            background: transparent !important;
            color: inherit !important;
            border: 0 !important;
            border-radius: 0 !important;
          }
          .flatpickr-time input {
            background: transparent !important;
            border: 0 !important;
            border-radius: 0 !important;
            color: rgba(255,255,255,0.95) !important;
          }
          .${RCH.Static.highlightClass} {
            border: solid 1px ${RCH.Settings.color} !important;
            padding: 10px !important;
          }
          .${RCH.Static.highlightTextClass} {
            color: ${RCH.Settings.color};
          }
          #${RCH.Static.highlightCounterSpanId} {
            font-weight: bold;
          }
          #${RCH.Static.resetButtonSpanId} {
            font-weight: bold;
            cursor: pointer;
          }
        </style>
      `
    },

    get flatPickrConfig() {
      return {
        enableTime: true,
        dateFormat: "Z",
        altInput: true,
        altFormat: "m/d/y h:iK",
        maxDate: Date.now(),
        onChange: [
          function (selectedDates, dateStr, instance) {
            let unixTime = RCH.unixTimeFromString(dateStr)
            if (!unixTime) { return }
            RCH.log(
              `Custom date selected, Unix Timestamp: ${unixTime}`
            )
            RCH.State.customDateUnix = unixTime
          }
        ]
      }
    },
  },

  hashFromString: (string) => {
    return XXH.h32(`${string}`, RCH.Settings.hashSeed).toString(16)
  },
  unixTimeFromString: (value) => {
    const unixTime = Date.parse(value)
    return unixTime != NaN && unixTime > 0 && unixTime
  },

  log: (message) => {
    if (RCH.Settings.loggingEnabled) {
      console.log(`[RCH] ${message}`)
    }
  },

  init: () => {
    if (!RCH.State.commentThreadId) {
      RCH.log(
        "commentThreadId could not be found, aborting."
      )
      return
    }
    RCH.Document.addStylesheet()

    RCH.Document.addElements()

    RCH.Cache.removeExpiredEntries()

    RCH.State.setupInitialValues()

    RCH.Cache.refreshCurrentThreadEntry()

    RCH.Document.setupDatePicker()

    RCH.Document.reconcileState()
  }
}

Object.freeze(RCH.State)
Object.freeze(RCH.Cache)
Object.freeze(RCH.Static)
Object.freeze(RCH.Document)
Object.freeze(RCH)

/* ------- INIT ------- */

RCH.init()