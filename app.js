'use strict';

const GUTENDEX_URL = 'https://gutendex.com/books/';
const OPEN_LIBRARY_SEARCH_URL = 'https://openlibrary.org/search.json';
const OPEN_LIBRARY_COVER_URL = 'https://covers.openlibrary.org/b/id/';
const WIKIPEDIA_SUMMARY_URL = 'https://en.wikipedia.org/api/rest_v1/page/summary/';
const WIKIPEDIA_SEARCH_URL = 'https://en.wikipedia.org/w/api.php';

// Gutendex routinely takes 10-45 seconds to answer, so its timeout is far
// longer than the others and the UI reports progress while it waits.
const GUTENDEX_TIMEOUT_MS = 60000;
const LOOKUP_TIMEOUT_MS = 12000;
const IMAGE_TIMEOUT_MS = 15000;
const SLOW_NOTICE_MS = 5000;
const VERY_SLOW_NOTICE_MS = 25000;

const COVER_LOOKUP_CONCURRENCY = 3;
const SKELETON_COUNT = 12;
const SKELETON_APPEND_COUNT = 4;
const MAX_BIO_AUTHORS = 3;

const NON_PERSON_AUTHORS = /^(various|anonymous|unknown|n\/a)$/i;
const AUTHOR_WORDS = /\b(writer|author|novelist|poet|playwright|dramatist|essayist|philosopher|historian|journalist|critic|scholar|theologian|naturalist|scientist|explorer|humou?rist|translator|biographer|clergyman|economist|politician|statesman|lawyer|physician|illustrator|editor)\b/i;

const FORMAT_PRIORITY = [
  { label: 'EPUB', matches: (type) => type.startsWith('application/epub') },
  { label: 'HTML', matches: (type) => type.startsWith('text/html') },
  { label: 'TXT', matches: (type) => type.startsWith('text/plain') },
];

const elements = {
  form: document.getElementById('search-form'),
  query: document.getElementById('query'),
  language: document.getElementById('language'),
  title: document.getElementById('results-title'),
  status: document.getElementById('status'),
  notice: document.getElementById('notice'),
  message: document.getElementById('message'),
  messageTitle: document.getElementById('message-title'),
  messageBody: document.getElementById('message-body'),
  messageAction: document.getElementById('message-action'),
  grid: document.getElementById('book-grid'),
  pagerError: document.getElementById('pager-error'),
  loadMore: document.getElementById('load-more'),
  cardTemplate: document.getElementById('book-card'),
  skeletonTemplate: document.getElementById('skeleton-card'),
};

const state = {
  query: '',
  language: '',
  nextUrl: null,
  total: 0,
  shown: 0,
  searchController: null,
  renderedIds: new Set(),
};

const pageCache = new Map();
const coverCache = new Map();
const biographyCache = new Map();

const numberFormat = new Intl.NumberFormat('en');
const languageNames = new Intl.DisplayNames(['en'], { type: 'language' });

/* ---------- Network helpers ---------- */

class ApiError extends Error {
  constructor(kind, status = 0) {
    super(status ? `${kind} (HTTP ${status})` : kind);
    this.name = 'ApiError';
    this.kind = kind; // aborted | timeout | network | rate-limit | server | not-found | client | parse
    this.status = status;
  }

  get retryable() {
    return ['timeout', 'network', 'rate-limit', 'server'].includes(this.kind);
  }
}

function errorForStatus(status) {
  if (status === 404) return new ApiError('not-found', status);
  if (status === 429) return new ApiError('rate-limit', status);
  if (status >= 500) return new ApiError('server', status);
  return new ApiError('client', status);
}

async function fetchOnce(url, signal, timeoutMs) {
  if (signal?.aborted) throw new ApiError('aborted');

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const forwardAbort = () => controller.abort();
  signal?.addEventListener('abort', forwardAbort, { once: true });

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw errorForStatus(response.status);
    return await response.json();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error.name === 'AbortError') throw new ApiError(timedOut ? 'timeout' : 'aborted');
    if (error instanceof SyntaxError) throw new ApiError('parse');
    throw new ApiError('network');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forwardAbort);
  }
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new ApiError('aborted'));
    }, { once: true });
  });
}

async function fetchJson(url, { signal, timeoutMs, retries = 0, onRetry } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetchOnce(url, signal, timeoutMs);
    } catch (error) {
      if (!error.retryable || attempt >= retries) throw error;
      onRetry?.();
      await wait(1000 * 2 ** attempt, signal);
    }
  }
}

function createLimiter(maxActive) {
  const waiting = [];
  let active = 0;

  const startNext = () => {
    if (active >= maxActive || waiting.length === 0) return;
    active += 1;
    const { task, resolve, reject } = waiting.shift();
    task().then(resolve, reject).finally(() => {
      active -= 1;
      startNext();
    });
  };

  return (task) => new Promise((resolve, reject) => {
    waiting.push({ task, resolve, reject });
    startNext();
  });
}

const limitCoverLookup = createLimiter(COVER_LOOKUP_CONCURRENCY);

/* ---------- Data normalisation ---------- */

function safeUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'http:') url.protocol = 'https:';
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function collapseWhitespace(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

// Gutendex stores "Wells, H. G. (Herbert George)"; readers and Wikipedia both
// want "H. G. Wells".
function normalizeAuthor(author) {
  const raw = collapseWhitespace(author?.name);
  const [lastName = '', firstNames = '', suffix = ''] = raw
    .replace(/\([^)]*\)/g, '')
    .split(',')
    .map((part) => part.trim());
  const keepSuffix = /^(jr|sr)\.?$/i.test(suffix) ? suffix : '';
  const name = [firstNames, lastName, keepSuffix].filter(Boolean).join(' ');

  return {
    name: name || 'Unknown author',
    lastName,
    birthYear: Number.isInteger(author?.birth_year) ? author.birth_year : null,
    deathYear: Number.isInteger(author?.death_year) ? author.death_year : null,
    isPerson: Boolean(name) && !NON_PERSON_AUTHORS.test(name),
  };
}

function pickFormats(formats) {
  const entries = Object.entries(formats ?? {});
  const chosen = [];

  for (const { label, matches } of FORMAT_PRIORITY) {
    const candidates = entries
      .filter(([type, url]) => matches(type) && !String(url).endsWith('.zip'))
      .sort(([a], [b]) => Number(b.includes('utf-8')) - Number(a.includes('utf-8')));
    const url = safeUrl(candidates[0]?.[1]);
    if (url) chosen.push({ label, url });
  }
  return chosen;
}

function normalizeBook(raw) {
  const authors = (Array.isArray(raw.authors) ? raw.authors : []).map(normalizeAuthor);
  return {
    id: raw.id,
    title: collapseWhitespace(raw.title) || 'Untitled',
    authors,
    authorLine: authors.map((author) => author.name).join(', ') || 'Unknown author',
    downloads: Number(raw.download_count) || 0,
    languages: Array.isArray(raw.languages) ? raw.languages : [],
    formats: pickFormats(raw.formats),
    gutenbergCover: safeUrl(raw.formats?.['image/jpeg']),
  };
}

function languageLabel(code) {
  try {
    return languageNames.of(code) ?? code;
  } catch {
    return code;
  }
}

function hueFor(text) {
  let hash = 0;
  for (const character of text) hash = (hash * 31 + character.codePointAt(0)) % 360;
  return hash;
}

/* ---------- Gutendex ---------- */

function buildSearchUrl(query, language) {
  const params = new URLSearchParams();
  if (query) params.set('search', query);
  if (language) params.set('languages', language);
  const queryString = params.toString();
  return queryString ? `${GUTENDEX_URL}?${queryString}` : GUTENDEX_URL;
}

async function fetchBooksPage(url, signal, onRetry) {
  if (pageCache.has(url)) return pageCache.get(url);

  const data = await fetchJson(url, {
    signal,
    onRetry,
    timeoutMs: GUTENDEX_TIMEOUT_MS,
    retries: 1,
  });
  if (!Array.isArray(data?.results)) throw new ApiError('parse');

  const page = {
    total: Number(data.count) || data.results.length,
    next: safeUrl(data.next),
    books: data.results.map(normalizeBook),
  };
  pageCache.set(url, page);
  return page;
}

function describeGutendexFailure(error) {
  if (error.kind === 'timeout') {
    return {
      title: 'The book catalogue took too long',
      body: 'Gutendex, the Project Gutenberg catalogue, is often slow and didn’t answer within a minute. Trying again usually works.',
    };
  }
  if (error.kind === 'network') {
    return navigator.onLine === false
      ? { title: 'You appear to be offline', body: 'Check your connection, then try again.' }
      : { title: 'Couldn’t reach the book catalogue', body: 'Gutendex may be down, or something on your network is blocking it.' };
  }
  if (error.kind === 'rate-limit') {
    return {
      title: 'Too many searches for now',
      body: 'Gutendex is limiting requests. Wait a minute, then try again.',
    };
  }
  if (error.kind === 'server') {
    return {
      title: 'The book catalogue is having trouble',
      body: `Gutendex returned a server error (${error.status}). This is on its side, and it usually clears up soon.`,
    };
  }
  if (error.kind === 'parse') {
    return {
      title: 'The catalogue sent an unexpected response',
      body: 'Gutendex answered, but not with book data. Try again in a moment.',
    };
  }
  return {
    title: 'That search didn’t work',
    body: `Gutendex rejected the request${error.status ? ` (${error.status})` : ''}. Try different search terms.`,
  };
}

/* ---------- Open Library covers ---------- */

function coverSearchTitle(title) {
  return title.split(/[;:]/)[0].trim();
}

async function lookupOpenLibraryCover(book, signal) {
  const title = coverSearchTitle(book.title);
  const author = book.authors.find((candidate) => candidate.isPerson);
  const params = new URLSearchParams({ title, limit: '5', fields: 'cover_i' });
  if (author) params.set('author', author.lastName);

  const data = await fetchJson(`${OPEN_LIBRARY_SEARCH_URL}?${params}`, {
    signal,
    timeoutMs: LOOKUP_TIMEOUT_MS,
  });
  const coverId = data?.docs?.find((doc) => doc.cover_i > 0)?.cover_i;
  // default=false makes a missing image a 404 instead of a blank 1px GIF.
  return coverId ? `${OPEN_LIBRARY_COVER_URL}${coverId}-M.jpg?default=false` : null;
}

function findOpenLibraryCover(book, signal) {
  const key = `${coverSearchTitle(book.title)}|${book.authors[0]?.lastName ?? ''}`.toLowerCase();
  if (!coverCache.has(key)) {
    const lookup = limitCoverLookup(() => lookupOpenLibraryCover(book, signal));
    coverCache.set(key, lookup);
    lookup.catch(() => coverCache.delete(key));
  }
  return coverCache.get(key);
}

function preloadImage(url) {
  return new Promise((resolve) => {
    const image = new Image();
    const timer = setTimeout(() => finish(false), IMAGE_TIMEOUT_MS);
    function finish(loaded) {
      clearTimeout(timer);
      image.onload = null;
      image.onerror = null;
      resolve(loaded);
    }
    // Open Library's placeholder for an empty record is a 1x1 image.
    image.onload = () => finish(image.naturalWidth > 1);
    image.onerror = () => finish(false);
    image.src = url;
  });
}

async function loadCover(card, book, signal) {
  const cover = card.querySelector('.cover');
  const sources = [];

  try {
    const openLibraryCover = await findOpenLibraryCover(book, signal);
    if (openLibraryCover) sources.push(openLibraryCover);
  } catch (error) {
    if (signal.aborted) return;
    // A lookup shared with a cancelled search can abort while this one lives on.
    if (error.kind !== 'aborted') {
      showNotice('Open Library covers aren’t available right now, so some books show Project Gutenberg artwork or a placeholder.');
    }
  }
  if (book.gutenbergCover) sources.push(book.gutenbergCover);

  for (const source of sources) {
    if (await preloadImage(source)) {
      if (signal.aborted) return;
      const image = card.querySelector('.cover__image');
      image.src = source;
      image.alt = `Cover of ${book.title}`;
      image.hidden = false;
      break;
    }
  }
  cover.classList.remove('is-loading');
}

// Cover lookups start only as cards approach the viewport, which keeps a long
// result list from hammering Open Library.
const coverObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    coverObserver.unobserve(entry.target);
    entry.target.startCoverLoad?.();
    delete entry.target.startCoverLoad;
  }
}, { rootMargin: '300px 0px' });

/* ---------- Wikipedia biographies ---------- */

function summaryMatchesAuthor(summary, author) {
  if (summary?.type !== 'standard' || !summary.extract) return false;

  const description = summary.description ?? '';
  const text = `${description} ${summary.extract}`;
  const years = [author.birthYear, author.deathYear].filter((year) => year !== null && year > 0);

  if (years.some((year) => text.includes(String(year)))) return true;

  // The page gives a lifespan that isn't this author's: it's a namesake,
  // such as Alexandre Dumas père when the book is by Dumas fils.
  if (years.length > 0 && /\d{3,4}\s*[–-]\s*\d{2,4}/.test(description)) return false;

  return AUTHOR_WORDS.test(text);
}

async function fetchSummary(title) {
  const path = encodeURIComponent(title.replace(/ /g, '_'));
  try {
    return await fetchJson(`${WIKIPEDIA_SUMMARY_URL}${path}`, {
      timeoutMs: LOOKUP_TIMEOUT_MS,
      retries: 1,
    });
  } catch (error) {
    if (error.kind === 'not-found') return null;
    throw error;
  }
}

async function searchWikipediaTitles(author) {
  const params = new URLSearchParams({
    action: 'query',
    list: 'search',
    srsearch: `${author.name} ${author.birthYear ?? ''} writer`.replace(/\s+/g, ' '),
    srlimit: '3',
    srprop: '',
    format: 'json',
    origin: '*',
  });
  const data = await fetchJson(`${WIKIPEDIA_SEARCH_URL}?${params}`, {
    timeoutMs: LOOKUP_TIMEOUT_MS,
    retries: 1,
  });
  return (data?.query?.search ?? []).map((result) => result.title);
}

async function lookupBiography(author) {
  const direct = await fetchSummary(author.name);
  if (summaryMatchesAuthor(direct, author)) return direct;

  for (const title of await searchWikipediaTitles(author)) {
    const summary = await fetchSummary(title);
    if (summaryMatchesAuthor(summary, author)) return summary;
  }
  return null;
}

function getBiography(author) {
  const key = `${author.name}|${author.birthYear ?? ''}`;
  if (!biographyCache.has(key)) {
    const lookup = lookupBiography(author);
    biographyCache.set(key, lookup);
    lookup.catch(() => biographyCache.delete(key));
  }
  return biographyCache.get(key);
}

function lifespan(author) {
  if (author.birthYear === null && author.deathYear === null) return '';
  const format = (year) => (year === null ? '?' : year < 0 ? `${-year} BC` : String(year));
  return ` (${format(author.birthYear)}–${format(author.deathYear)})`;
}

function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function createBiographyEntry(author) {
  const entry = createElement('section', 'bio__entry');
  const name = createElement('p', 'bio__name', author.name);
  name.append(createElement('span', 'bio__years', lifespan(author)));
  entry.append(name);
  return entry;
}

function renderBiography(entry, author, summary) {
  if (!summary) {
    entry.append(createElement('p', 'bio__text', `Wikipedia doesn’t seem to have a biography of ${author.name}.`));
    return;
  }
  entry.append(createElement('p', 'bio__text', summary.extract));

  const pageUrl = safeUrl(summary.content_urls?.desktop?.page);
  if (pageUrl) {
    const link = createElement('a', 'bio__source', 'Read more on Wikipedia');
    link.href = pageUrl;
    link.target = '_blank';
    link.rel = 'noopener';
    entry.append(link);
  }
}

function biographyFailureText(error) {
  if (error.kind === 'timeout') return 'Wikipedia took too long to respond.';
  if (error.kind === 'rate-limit') return 'Wikipedia is limiting requests right now.';
  if (error.kind === 'network') return 'Couldn’t reach Wikipedia.';
  return 'Wikipedia returned an unexpected response.';
}

async function loadBiographies(container, book) {
  const authors = book.authors.filter((author) => author.isPerson).slice(0, MAX_BIO_AUTHORS);
  container.replaceChildren();

  if (authors.length === 0) {
    container.append(createElement('p', 'bio__text', 'This book has no individual author to look up.'));
    container.dataset.state = 'done';
    return;
  }

  const spinner = createElement('p', 'bio__loading');
  spinner.append(createElement('span', 'spinner'), document.createTextNode('Checking Wikipedia…'));
  container.append(spinner);

  const results = await Promise.allSettled(authors.map(getBiography));

  spinner.remove();
  let hasFailure = false;
  results.forEach((result, index) => {
    const author = authors[index];
    const entry = createBiographyEntry(author);
    if (result.status === 'fulfilled') {
      renderBiography(entry, author, result.value);
    } else {
      hasFailure = true;
      entry.append(createElement('p', 'bio__error', biographyFailureText(result.reason)));
    }
    container.append(entry);
  });

  container.dataset.state = hasFailure ? 'failed' : 'done';
  if (hasFailure) {
    const retry = createElement('button', 'bio__retry', 'Try again');
    retry.type = 'button';
    retry.addEventListener('click', () => loadBiographies(container, book));
    container.append(retry);
  }
}

/* ---------- Rendering ---------- */

function setStatus(text) {
  elements.status.textContent = text;
}

function showNotice(text) {
  elements.notice.textContent = text;
  elements.notice.hidden = false;
}

function hideMessage() {
  elements.message.hidden = true;
}

function showMessage({ title, body }, actionLabel, action) {
  elements.messageTitle.textContent = title;
  elements.messageBody.textContent = body;
  elements.messageAction.textContent = actionLabel;
  elements.messageAction.onclick = action;
  elements.message.hidden = false;
}

function appendSkeletons(count) {
  const fragment = document.createDocumentFragment();
  for (let index = 0; index < count; index += 1) {
    fragment.append(elements.skeletonTemplate.content.cloneNode(true));
  }
  elements.grid.append(fragment);
}

function removeSkeletons() {
  elements.grid.querySelectorAll('.book--skeleton').forEach((skeleton) => skeleton.remove());
}

function setGridBusy(isBusy) {
  elements.grid.setAttribute('aria-busy', String(isBusy));
  elements.loadMore.disabled = isBusy;
}

function createFormatLinks(book) {
  if (book.formats.length === 0) {
    return [createElement('p', 'format-none', 'No download available')];
  }
  return book.formats.map(({ label, url }, index) => {
    const isBest = index === 0;
    const link = createElement(
      'a',
      `button format ${isBest ? 'button--primary' : 'button--ghost'}`,
      isBest ? `Get ${label}` : label,
    );
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.setAttribute('aria-label', `${book.title}, ${label} format`);
    return link;
  });
}

function createCard(book, signal) {
  const card = elements.cardTemplate.content.firstElementChild.cloneNode(true);

  card.querySelector('.cover__art').style.setProperty('--hue', hueFor(book.title));
  card.querySelector('.cover__title').textContent = book.title;
  card.querySelector('.cover__author').textContent = book.authorLine;
  card.querySelector('.book__title').textContent = book.title;
  card.querySelector('.book__author').textContent = book.authorLine;
  card.querySelector('.book__downloads').textContent = `${numberFormat.format(book.downloads)} downloads`;
  card.querySelector('.book__languages').textContent = book.languages.map(languageLabel).join(', ');
  card.querySelector('.book__formats').append(...createFormatLinks(book));

  const details = card.querySelector('.bio');
  const content = card.querySelector('.bio__content');
  details.addEventListener('toggle', () => {
    if (!details.open) return;
    content.scrollIntoView({ block: 'nearest' });
    if (!content.dataset.state) {
      content.dataset.state = 'loading';
      loadBiographies(content, book);
    }
  });

  card.startCoverLoad = () => loadCover(card, book, signal);
  coverObserver.observe(card);
  return card;
}

function renderBooks(books, signal) {
  const fresh = books.filter((book) => !state.renderedIds.has(book.id));
  const fragment = document.createDocumentFragment();

  for (const book of fresh) {
    state.renderedIds.add(book.id);
    fragment.append(createCard(book, signal));
  }
  elements.grid.append(fragment);
  state.shown += fresh.length;
}

function resultsSummary() {
  const total = numberFormat.format(state.total);
  const noun = state.total === 1 ? 'book' : 'books';
  return state.shown < state.total
    ? `Showing ${numberFormat.format(state.shown)} of ${total} ${noun}, most downloaded first`
    : `${total} ${noun}, most downloaded first`;
}

function resultsHeading() {
  const language = state.language ? languageLabel(state.language) : '';
  if (state.query) return `Results for “${state.query}”${language ? ` in ${language}` : ''}`;
  return language ? `Most downloaded in ${language}` : 'Most downloaded';
}

function showNoMatches() {
  const language = state.language ? languageLabel(state.language) : '';
  if (language && state.query) {
    showMessage(
      {
        title: `No ${language} books match “${state.query}”`,
        body: 'It may exist in another language, or under a different spelling.',
      },
      'Search all languages',
      () => {
        elements.language.value = '';
        startSearch();
      },
    );
    return;
  }
  showMessage(
    {
      title: state.query ? `No books match “${state.query}”` : `No ${language} books found`,
      body: 'Project Gutenberg holds older, public-domain works. Try a shorter title, or an author’s surname.',
    },
    'Show most downloaded',
    () => {
      elements.query.value = '';
      elements.language.value = '';
      startSearch();
    },
  );
}

/* ---------- Search flow ---------- */

function trackSlowResponse() {
  const timers = [
    setTimeout(() => setStatus('Still searching. The Gutenberg catalogue can be slow…'), SLOW_NOTICE_MS),
    setTimeout(() => setStatus('Nearly a minute is normal here, thanks for waiting…'), VERY_SLOW_NOTICE_MS),
  ];
  return () => timers.forEach(clearTimeout);
}

async function startSearch() {
  state.searchController?.abort();
  const controller = new AbortController();
  const { signal } = controller;

  Object.assign(state, {
    query: collapseWhitespace(elements.query.value),
    language: elements.language.value,
    nextUrl: null,
    total: 0,
    shown: 0,
    searchController: controller,
    renderedIds: new Set(),
  });

  hideMessage();
  elements.notice.hidden = true;
  elements.pagerError.hidden = true;
  elements.loadMore.hidden = true;
  elements.title.textContent = resultsHeading();
  elements.grid.replaceChildren();
  appendSkeletons(SKELETON_COUNT);
  setGridBusy(true);
  setStatus('Searching Project Gutenberg…');

  const stopTracking = trackSlowResponse();
  try {
    const url = buildSearchUrl(state.query, state.language);
    const page = await fetchBooksPage(url, signal, () => {
      setStatus('The catalogue didn’t answer, so we’re trying once more…');
    });

    stopTracking();
    removeSkeletons();
    setGridBusy(false);
    state.total = page.total;
    state.nextUrl = page.next;

    if (page.books.length === 0) {
      setStatus('');
      showNoMatches();
      return;
    }
    renderBooks(page.books, signal);
    setStatus(resultsSummary());
    elements.loadMore.hidden = !state.nextUrl;
  } catch (error) {
    stopTracking();
    if (error.kind === 'aborted') return;
    removeSkeletons();
    setGridBusy(false);
    setStatus('');
    showMessage(describeGutendexFailure(error), 'Try again', startSearch);
  }
}

async function loadMore() {
  const { signal } = state.searchController;

  elements.pagerError.hidden = true;
  appendSkeletons(SKELETON_APPEND_COUNT);
  setGridBusy(true);
  setStatus('Loading more books…');

  const stopTracking = trackSlowResponse();
  try {
    const page = await fetchBooksPage(state.nextUrl, signal);
    stopTracking();
    removeSkeletons();
    setGridBusy(false);
    state.nextUrl = page.next;
    renderBooks(page.books, signal);
    setStatus(resultsSummary());
    elements.loadMore.hidden = !state.nextUrl;
  } catch (error) {
    stopTracking();
    if (error.kind === 'aborted') return;
    removeSkeletons();
    setGridBusy(false);
    setStatus(resultsSummary());
    const { title, body } = describeGutendexFailure(error);
    elements.pagerError.textContent = `${title}. ${body}`;
    elements.pagerError.hidden = false;
    elements.loadMore.textContent = 'Try again';
  }
}

elements.form.addEventListener('submit', (event) => {
  event.preventDefault();
  startSearch();
});
elements.language.addEventListener('change', startSearch);
elements.loadMore.addEventListener('click', () => {
  elements.loadMore.textContent = 'Load more books';
  loadMore();
});

startSearch();
