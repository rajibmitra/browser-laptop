/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

const urlParse = require('../../common/urlParse')
const appConfig = require('../../../js/constants/appConfig')
const _ = require('underscore')
const Immutable = require('immutable')
const {makeImmutable} = require('../../common/state/immutableUtil')
const {isUrl, aboutUrls, isNavigatableAboutPage, isSourceAboutUrl} = require('../../../js/lib/appUrlUtil')
const suggestionTypes = require('../../../js/constants/suggestionTypes')
const getSetting = require('../../../js/settings').getSetting
const settings = require('../../../js/constants/settings')
const config = require('../../../js/constants/config')
const top500 = require('../../../js/data/top500')
const fetchSearchSuggestions = require('./fetchSearchSuggestions')
const {getFrameByTabId, getTabsByWindowId} = require('../../common/state/tabState')
const {query} = require('./siteSuggestions')
const debounce = require('../../../js/lib/debounce')
const assert = require('assert')

const sigmoid = (t) => {
  return 1 / (1 + Math.pow(Math.E, -t))
}

const ONE_DAY = 1000 * 60 * 60 * 24

/*
 * Calculate the sorting priority for a history item based on number of
 * accesses and time since last access
 *
 * @param {number} count - The number of times this site has been accessed
 * @param {number} currentTime - Current epoch millisecnds
 * @param {boolean} lastAccessedTime - Epoch milliseconds of last access
 *
 */
const sortingPriority = (count, currentTime, lastAccessedTime, ageDecayConstant) => {
  count = Math.max(count, Number.EPSILON)
  // number of days since last access (with fractional component)
  const ageInDays = (currentTime - (lastAccessedTime || 1)) / ONE_DAY
  // Decay factor based on age, having a maximum of just less than 1 ensures the return will not be 0
  const ageFactor = 1 - ((Math.min(sigmoid(ageInDays / ageDecayConstant), 1 - Number.EPSILON) - 0.5) * 2)
  // sorting priority
  return count * ageFactor
}

/*
 * Sort two history items by priority
 *
 * @param {ImmutableObject} s1 - first history item
 * @param {ImmutableObject} s2 - second history item
 *
 * Return the relative order of two site entries taking into consideration
 * the number of times the site has been accessed and the length of time
 * since the last access.
 *
 * The base sort order is determined by the count attribute of the site
 * entry. A modifier is then computed based on the length of time since
 * the last access. A sigmoid function is used to weight more recent
 * entries higher than entries in the past. This is not a linear function,
 * entries in the far past with many counts will still be discounted
 * heavily as the sigmoid modifier will cancel most of the count
 * base parameter.
 *
 * Below is a sample comparison of two sites that have been accessed
 * recently (but not at the identical time). Each site is accessed
 * 9 times. The count is discounted by an aging factor calculated
 * using the sigmoid decay function.
 *
 *   http://www.gm.ca/gm/
 *
 *   ageInDays 0.17171469907407408
 *   ageFactor 0.9982828546969802
 *   count     9
 *   priority  0.9982828546969802
 *
 *   http://www.gm.com/index.html
 *
 *   ageInDays 0.17148791666666666
 *   ageFactor 0.9982851225143763
 *   count     9
 *   priority  0.9982851225143763
 *
 */
const sortByAccessCountWithAgeDecay = (s1, s2) => {
  const now = new Date()
  const s1Priority = sortingPriority(
    s1.count || 0,
    now.getTime(),
    s1.lastAccessedTime || 0,
    appConfig.urlSuggestions.ageDecayConstant
  )
  const s2Priority = sortingPriority(
    s2.count || 0,
    now.getTime(),
    s2.lastAccessedTime || 0,
    appConfig.urlSuggestions.ageDecayConstant
  )
  return s2Priority - s1Priority
}

/*
 * Return true1 the url is 'simple' as in without query, search or
 * hash components. Return false otherwise.
 *
 * @param {object} An already normalized simple URL
 *
 */
const isSimpleDomainNameValue = (site) => isParsedUrlSimpleDomainNameValue(urlParse(getURL(site)))
const isParsedUrlSimpleDomainNameValue = (parsed) => {
  if ((parsed.hash === null || parsed.hash === '#') &&
    parsed.search === null && parsed.query === null && parsed.pathname === '/') {
    return true
  } else {
    return false
  }
}

/*
 * Normalize a location for url suggestion sorting
 *
 * @param {string} location - history item location
 *
 */
const normalizeLocation = (location) => {
  if (typeof location === 'string') {
    location = location.replace(/www\./, '')
    location = location.replace(/^http:\/\//, '')
    location = location.replace(/^https:\/\//, '')
  }
  return location
}

/*
 * Determines based on user input if the location should
 * be normalized.  If the user is typing http prefix then
 * they are specifying something explicitly.
 *
 * @return true if urls being compared should be normalized
 */
const shouldNormalizeLocation = (input) => {
  const prefixes = ['http://', 'https://', 'www.']
  return prefixes.every((prefix) => {
    if (input.length > prefix.length) {
      return true
    }
    for (let i = 0; i < Math.min(prefix.length, input.length); i++) {
      if (input[i] !== prefix[i]) {
        return true
      }
    }
    return false
  })
}

/*
 * return a site representing the simple location for a
 * set of related sites without a history item for the
 * simple location.
 *
 * This is used to show a history suggestion for something
 * like www.google.com if it has not been visited but
 * there are two or more locations with that prefix containing
 * path info or parameters
 *
 * @param {Array[Object]} sites - array of similar sites
 */
var virtualSite = (sites) => {
  // array of sites without paths or query params
  var simple = sites.filter((parsed) => {
    return (parsed.hash === null && parsed.search === null && parsed.query === null && parsed.pathname === '/')
  })
  // if there are no simple locations then we will build and return one
  if (simple.length === 0) {
    // we need to create a virtual history item
    return {
      location: sites[0].protocol + '//' + sites[0].host,
      count: 0,
      title: sites[0].host,
      lastAccessedTime: (new Date()).getTime()
    }
  }
}

/*
 * Create an array of simple locations from history
 * The simple locations will be the root domain for a location
 * without parameters or path
 *
 * @param {object} - history
 */
const createVirtualHistoryItems = (historySites, urlLocationLower) => {
  historySites = historySites || []

  // parse each history item
  const parsedHistorySites = []
  historySites.forEach((site) => {
    if (site && site.location) {
      parsedHistorySites.push(
        urlParse(site.location)
      )
    }
  })
  // group them by host
  var grouped = _.groupBy(parsedHistorySites, (parsedSite) => {
    return parsedSite.host || 'unknown'
  })
  // find groups with more than 2 of the same host
  var multiGroupKeys = _.filter(_.keys(grouped), (k) => {
    return grouped[k].length > 0
  })
  // potentially create virtual history items
  var virtualHistorySites = _.map(multiGroupKeys, (location) => {
    return virtualSite(grouped[location])
  })
  virtualHistorySites = _.filter(virtualHistorySites, (site) => {
    return !!site
  })

  if (urlLocationLower) {
    virtualHistorySites = virtualHistorySites.filter((vs) => vs.location.indexOf(urlLocationLower) !== -1)
  }

  return virtualHistorySites
}

/**
 * Returns a function that sorts 2 sites by their host.
 * The result of that function is a postive, negative, or 0 result.
 * 3 or -3 for a strong indicator of a superior result.
 * 2 or -2 for a good indicator of a superior result.
 * 1 or -1 for a weak indicator of a superior result.
 * 0 if no determination can be made.
 */
const getSortByDomain = (userInputLower, userInputHost) => {
  return (s1, s2) => {
    // Check for matches on hostname which if found overrides
    // any count or frequency calculation.
    // Note that for parsed URLs that are not complete, the pathname contains
    // what the user is entering as the host and the host is null.
    let host1 = s1.parsedUrl.host || s1.parsedUrl.pathname || s1.location || ''
    let host2 = s2.parsedUrl.host || s2.parsedUrl.pathname || s2.location || ''
    host1 = host1.replace('www.', '')
    host2 = host2.replace('www.', '')

    let pos1 = host1.indexOf(userInputHost)
    let pos2 = host2.indexOf(userInputHost)
    if (pos1 !== -1 && pos2 === -1) {
      return -3
    }
    if (pos1 === -1 && pos2 !== -1) {
      return 3
    }
    if (pos1 !== -1 && pos2 !== -1) {
      // Try to match on the first position without taking into account decay sort.
      // This is because autocomplete is based on matching prefixes.
      if (pos1 === 0 && pos2 !== 0) {
        return -2
      }
      if (pos1 !== 0 && pos2 === 0) {
        return 2
      }

      const sortBySimpleURLResult = sortBySimpleURL(s1, s2)
      if (sortBySimpleURLResult !== 0) {
        return sortBySimpleURLResult
      }
    }
    // Can't determine what is the best match
    return 0
  }
}

/**
 * Sorts 2 URLS by if they are a simple URL or not.
 * Returns the normal -1, 1, or 0 result for sort functions.
 */
const sortBySimpleURL = (s1, s2) => {
  // If one of the URLs is a simpleURL and the other isn't then sort the simple one first
  const url1IsSimple = isParsedUrlSimpleDomainNameValue(s1.parsedUrl)
  const url2IsSimple = isParsedUrlSimpleDomainNameValue(s2.parsedUrl)
  if (url1IsSimple && !url2IsSimple) {
    return -1
  }
  if (!url1IsSimple && url2IsSimple) {
    return 1
  }
  const url1IsSecure = s1.parsedUrl.protocol === 'https:'
  const url2IsSecure = s2.parsedUrl.protocol === 'https:'
  if (url1IsSimple && url2IsSimple) {
    if (url1IsSecure && !url2IsSecure) {
      return -1
    }
    if (!url1IsSecure && url2IsSecure) {
      return 1
    }
  }

  // Prefer smaller less complicated domains
  // hostname could be null in cases like javascript: bookmarklets
  if (s1.parsedUrl.hostname && s2.parsedUrl.hostname) {
    const parts1 = s1.parsedUrl.hostname.split('.')
    const parts2 = s2.parsedUrl.hostname.split('.')
    let parts1Size = parts1.length
    let parts2Size = parts2.length
    if (parts1[0] === 'www') {
      parts1Size--
    }
    if (parts2[0] === 'www') {
      parts2Size--
    }
    if (parts1Size < parts2Size) {
      return -1
    }
    if (parts1Size > parts2Size) {
      return 1
    }
  }
  return sortByAccessCountWithAgeDecay(s1, s2)
}

/**
 * Returns a function that sorts 2 sites by their host.
 * The result of that function is a postive, negative, or 0 result.
 */
const getSortByPath = (userInputLower) => {
  return (path1, path2) => {
    const pos1 = path1.indexOf(userInputLower)
    const pos2 = path2.indexOf(userInputLower)
    if (pos1 !== -1 && pos2 === -1) {
      return -1
    }
    if (pos1 === -1 && pos2 !== -1) {
      return 1
    }
    const indexOf1 = path1.indexOf(path2)
    const indexOf2 = path2.indexOf(path1)
    if (indexOf1 === -1 && indexOf2 !== -1) {
      return -1
    }
    if (indexOf1 !== -1 && indexOf2 === -1) {
      return 1
    }
    // Can't determine what is the best match
    return 0
  }
}

// Same as sortByAccessCountWithAgeDecay but if one is a prefix of the
// other then it is considered always sorted first.
const getSortForSuggestions = (userInputLower) => {
  userInputLower = userInputLower.replace(/^http:\/\//, '')
  userInputLower = userInputLower.replace(/^https:\/\//, '')
  const userInputParts = userInputLower.split('/')
  const userInputHost = userInputParts[0]
  const userInputValue = userInputParts[1] || ''
  const sortByDomain = getSortByDomain(userInputLower, userInputHost)
  const sortByPath = getSortByPath(userInputLower)

  return (s1, s2) => {
    if (s1.toJS || s2.toJS) {
      assert('These sorting functions are not meant for Immutable data!')
    }
    s1.parsedUrl = s1.parsedUrl || urlParse(getURL(s1) || '')
    s2.parsedUrl = s2.parsedUrl || urlParse(getURL(s2) || '')

    if (!userInputValue) {
      const sortByDomainResult = sortByDomain(s1, s2)
      if (sortByDomainResult !== 0) {
        return sortByDomainResult
      }
    }

    const path1 = s1.parsedUrl.host + s1.parsedUrl.path + (s1.parsedUrl.hash || '')
    const path2 = s2.parsedUrl.host + s2.parsedUrl.path + (s2.parsedUrl.hash || '')
    const sortByPathResult = sortByPath(path1, path2)
    if (sortByPathResult !== 0) {
      return sortByPathResult
    }

    return sortByAccessCountWithAgeDecay(s1, s2)
  }
}

// Currently we sort only sites that are not immutableJS and
const getURL = (x) => {
  if (typeof x === 'string') {
    return x
  }

  if (x.get) {
    return x.get('location') || x.get('url')
  }

  return x.location || x.url
}

const getMapListToElements = (urlLocationLower) => ({data, maxResults, type,
    filterValue = (site) => {
      return site.toLowerCase().indexOf(urlLocationLower) !== -1
    }
}) => {
  const suggestionsList = Immutable.List()
  const formatTitle = (x) => typeof x === 'object' && x !== null ? x.get('title') : x
  const formatTabId = (x) => typeof x === 'object' && x !== null ? x.get('tabId') : x
  // Filter out things which are already in our own list at a smaller index
  // Filter out things which are already in the suggestions list
  let filteredData = data.filter((site) =>
    suggestionsList.findIndex((x) => (x.location || '').toLowerCase() === (getURL(site) || '').toLowerCase()) === -1 ||
      // Tab autosuggestions should always be included since they will almost always be in history
      type === suggestionTypes.TAB)
  // Per suggestion provider filter
  if (filterValue) {
    filteredData = filteredData.filter(filterValue)
  }

  return makeImmutable(filteredData
    .take(maxResults)
    .map((site) => {
      return Immutable.fromJS({
        title: formatTitle(site),
        location: getURL(site),
        tabId: formatTabId(site),
        type
      })
    }))
}

const getHistorySuggestions = (state, urlLocationLower) => {
  return new Promise((resolve, reject) => {
    const mapListToElements = getMapListToElements(urlLocationLower)
    const options = {
      historySuggestionsOn: getSetting(settings.HISTORY_SUGGESTIONS),
      bookmarkSuggestionsOn: getSetting(settings.BOOKMARK_SUGGESTIONS)
    }

    query(urlLocationLower, options).then((results) => {
      results = results.concat(createVirtualHistoryItems(results, urlLocationLower))
      const sortHandler = getSortForSuggestions(urlLocationLower)
      results = results.sort(sortHandler)
      results = results.slice(0, config.urlBarSuggestions.maxHistorySites)
      results = makeImmutable(results)
      const suggestionsList = mapListToElements({
        data: results,
        maxResults: config.urlBarSuggestions.maxHistorySites,
        type: options.historySuggestionsOn ? suggestionTypes.HISTORY : suggestionTypes.BOOKMARK,
        filterValue: null
      })
      resolve(suggestionsList)
    })
  })
}

const getAboutSuggestions = (state, urlLocationLower) => {
  return new Promise((resolve, reject) => {
    const mapListToElements = getMapListToElements(urlLocationLower)
    const suggestionsList = mapListToElements({
      data: aboutUrls.keySeq().filter((x) => isNavigatableAboutPage(x)),
      maxResults: config.urlBarSuggestions.maxAboutPages,
      type: suggestionTypes.ABOUT_PAGES
    })
    resolve(suggestionsList)
  })
}

const getOpenedTabSuggestions = (state, windowId, urlLocationLower) => {
  return new Promise((resolve, reject) => {
    const mapListToElements = getMapListToElements(urlLocationLower)
    const tabs = getTabsByWindowId(state, windowId)
    let suggestionsList = Immutable.List()
    if (getSetting(settings.OPENED_TAB_SUGGESTIONS)) {
      suggestionsList = mapListToElements({
        data: tabs,
        maxResults: config.urlBarSuggestions.maxOpenedFrames,
        type: suggestionTypes.TAB,
        filterValue: (tab) => !isSourceAboutUrl(tab.get('url')) &&
          !tab.get('active') &&
          (
            (tab.get('title') && tab.get('title').toLowerCase().indexOf(urlLocationLower) !== -1) ||
            (tab.get('url') && tab.get('url').toLowerCase().indexOf(urlLocationLower) !== -1)
          )
      })
    }
    resolve(suggestionsList)
  })
}

const getSearchSuggestions = (state, tabId, urlLocationLower) => {
  return new Promise((resolve, reject) => {
    const mapListToElements = getMapListToElements(urlLocationLower)
    let suggestionsList = Immutable.List()
    if (getSetting(settings.OFFER_SEARCH_SUGGESTIONS)) {
      const searchResults = state.get('searchResults')
      if (searchResults) {
        suggestionsList = mapListToElements({
          data: searchResults,
          maxResults: config.urlBarSuggestions.maxSearch,
          type: suggestionTypes.SEARCH
        })
      }
    }
    resolve(suggestionsList)
  })
}

const getAlexaSuggestions = (state, urlLocationLower) => {
  return new Promise((resolve, reject) => {
    const mapListToElements = getMapListToElements(urlLocationLower)
    const suggestionsList = mapListToElements({
      data: top500,
      maxResults: config.urlBarSuggestions.maxTopSites,
      type: suggestionTypes.TOP_SITE
    })
    resolve(suggestionsList)
  })
}

const generateNewSuggestionsList = debounce((state, windowId, tabId, urlLocation) => {
  if (!urlLocation) {
    return
  }
  const urlLocationLower = urlLocation.toLowerCase()
  Promise.all([
    getHistorySuggestions(state, urlLocationLower),
    getAboutSuggestions(state, urlLocationLower),
    getOpenedTabSuggestions(state, windowId, urlLocationLower),
    getSearchSuggestions(state, tabId, urlLocationLower),
    getAlexaSuggestions(state, urlLocationLower)
  ]).then(([...suggestionsLists]) => {
    const appActions = require('../../../js/actions/appActions')
    // Flatten only 1 level deep for perf only, nested will be objects within arrrays
    appActions.urlBarSuggestionsChanged(windowId, makeImmutable(suggestionsLists).flatten(1))
  })
}, 5)

const generateNewSearchXHRResults = debounce((state, windowId, tabId, input) => {
  const frame = getFrameByTabId(state, tabId)
  if (!frame) {
    // Frame info may not be available yet in app store
    return
  }
  const frameSearchDetail = frame.getIn(['navbar', 'urlbar', 'searchDetail'])
  const searchDetail = state.get('searchDetail')
  if (!searchDetail && !frameSearchDetail) {
    return
  }
  const autocompleteURL = frameSearchDetail
    ? frameSearchDetail.get('autocomplete')
    : searchDetail.get('autocompleteURL')

  const shouldDoSearchSuggestions = getSetting(settings.OFFER_SEARCH_SUGGESTIONS) &&
    autocompleteURL &&
    !isUrl(input) &&
    input.length !== 0

  if (shouldDoSearchSuggestions) {
    if (searchDetail) {
      const replaceRE = new RegExp('^' + searchDetail.get('shortcut') + ' ', 'g')
      input = input.replace(replaceRE, '')
    }
    fetchSearchSuggestions(windowId, tabId, autocompleteURL, input)
  } else {
    const appActions = require('../../../js/actions/appActions')
    appActions.searchSuggestionResultsAvailable(tabId, undefined, Immutable.List())
  }
}, 10)

module.exports = {
  sortingPriority,
  sortByAccessCountWithAgeDecay,
  getSortForSuggestions,
  getSortByPath,
  sortBySimpleURL,
  getSortByDomain,
  isSimpleDomainNameValue,
  normalizeLocation,
  shouldNormalizeLocation,
  createVirtualHistoryItems,
  getMapListToElements,
  getHistorySuggestions,
  getAboutSuggestions,
  getOpenedTabSuggestions,
  getSearchSuggestions,
  getAlexaSuggestions,
  generateNewSuggestionsList,
  generateNewSearchXHRResults
}
