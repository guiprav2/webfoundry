let isServer = typeof window === 'undefined';
let Datastore;
let pathModule = null;
let fsMkdir = null;
let fsReaddir = null;
let fsAccess = null;
let dbBaseDir = null;
let ensuredNamespaceDirs = new Set();
let expressModule = null;
let expressApp = null;
let serverInitialized = false;
let peacock = {};

if (isServer) {
  let pathImport = await import('node:path');
  pathModule = pathImport.default || pathImport;
  let fsImport = await import('fs/promises');
  fsMkdir = fsImport.mkdir;
  fsReaddir = fsImport.readdir;
  fsAccess = fsImport.access;
  let nedbImport = await import('@seald-io/nedb');
  Datastore = nedbImport.default;
  dbBaseDir = pathModule.join(process.cwd(), 'data', 'db');
  let expressImport = await import('express');
  expressModule = expressImport.default || expressImport;
} else {
  let nedbImport = await import('https://esm.run/@seald-io/nedb');
  Datastore = nedbImport.default;
}

let datastores = new Map();
let pendingLoads = new Map();
let knownCollections = new Map();
let browserCollectionsKey = 'peacock.collections';

if (!isServer) {
  let storedCollections = readBrowserCollections();
  for (let [namespace, collections] of storedCollections.entries()) {
    let set = getKnownCollectionSet(namespace);
    for (let index = 0; index < collections.length; index += 1) {
      set.add(collections[index]);
    }
  }
}

peacock.get = async function(namespace, collection, ...args) {
  let ns = ensureNamespace(namespace);
  let name = ensureCollectionName(collection);
  if (name === '_collections') {
    return await peacock.list(ns);
  }
  let parsed = parseIdAndQueryArgs(args);
  let datastore = await getDatastore(ns, name, { createIfMissing: false });
  if (!datastore) {
    if (parsed.id !== undefined) {
      throw httpError(404, 'Not Found');
    }
    return [];
  }
  if (parsed.id !== undefined) {
    ensureQueryMatchesId(parsed.query, parsed.id);
    parsed.query._id = parsed.id;
    let doc = await findDocument(datastore, parsed.query);
    if (!doc) {
      let fallbackQuery = maybeCreateCoercedQuery(parsed.query);
      if (fallbackQuery) {
        doc = await findDocument(datastore, fallbackQuery);
      }
    }
    if (!doc) {
      throw httpError(404, 'Not Found');
    }
    return doc;
  }
  let docs = await findDocuments(datastore, parsed.query);
  let fallbackQuery = maybeCreateCoercedQuery(parsed.query);
  if (fallbackQuery) {
    let extraDocs = await findDocuments(datastore, fallbackQuery);
    docs = mergeDocumentsById(docs, extraDocs);
  }
  return docs;
};

peacock.post = async function(namespace, collection, body) {
  let ns = ensureNamespace(namespace);
  let name = ensureCollectionName(collection);
  if (body === undefined || body === null) {
    throw httpError(400, 'Request body is required');
  }
  if (typeof body !== 'object') {
    throw httpError(400, 'Request body must be an object or array');
  }
  let datastore = await getDatastore(ns, name, { createIfMissing: true });
  let inserted = await insertDocuments(datastore, body);
  return inserted;
};

peacock.put = async function(namespace, collection, ...args) {
  let ns = ensureNamespace(namespace);
  let name = ensureCollectionName(collection);
  if (args.length === 0) {
    throw httpError(400, 'ID is required');
  }
  let idCandidate = args[0];
  if (!isIdValue(idCandidate)) {
    throw httpError(400, 'ID is required');
  }
  if (args.length < 2) {
    throw httpError(400, 'Request body is required');
  }
  let id = String(idCandidate);
  let payload = args[1];
  let querySource = args.length > 2 ? args[2] : undefined;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw httpError(400, 'Request body must be an object');
  }
  if (payload._id && String(payload._id) !== id) {
    throw httpError(400, '_id in body must match route parameter');
  }
  let datastore = await getDatastore(ns, name, { createIfMissing: true });
  let query = buildQuery(querySource);
  ensureQueryMatchesId(query, id);
  query._id = id;
  let usesOperators = hasOperatorKeys(payload);
  let update = usesOperators ? payload : Object.assign({}, payload, { _id: id });
  let result = await updateDocument(datastore, query, update, { upsert: false });
  if (!result.numAffected) {
    let fallbackQuery = maybeCreateCoercedQuery(query);
    if (fallbackQuery) {
      result = await updateDocument(datastore, fallbackQuery, update, { upsert: false });
    }
  }
  if (!result.numAffected) {
    throw httpError(404, 'Not Found');
  }
  return result.affectedDocument;
};

peacock.delete = async function(namespace, collection, ...args) {
  let ns = ensureNamespace(namespace);
  let name = ensureCollectionName(collection);
  let parsed = parseIdAndQueryArgs(args);
  let datastore = await getDatastore(ns, name, { createIfMissing: false });
  if (!datastore) {
    if (parsed.id !== undefined) {
      throw httpError(404, 'Not Found');
    }
    return { deleted: 0 };
  }
  if (parsed.id !== undefined) {
    ensureQueryMatchesId(parsed.query, parsed.id);
    parsed.query._id = parsed.id;
    let removedSingle = await removeDocuments(datastore, parsed.query, { multi: false });
    if (!removedSingle) {
      let fallbackQuery = maybeCreateCoercedQuery(parsed.query);
      if (fallbackQuery) {
        removedSingle = await removeDocuments(datastore, fallbackQuery, { multi: false });
      }
    }
    if (!removedSingle) {
      throw httpError(404, 'Not Found');
    }
    return { deleted: removedSingle };
  }
  let removed = await removeDocuments(datastore, parsed.query, { multi: true });
  let fallbackQuery = maybeCreateCoercedQuery(parsed.query);
  if (fallbackQuery) {
    removed += await removeDocuments(datastore, fallbackQuery, { multi: true });
  }
  return { deleted: removed };
};

peacock.list = async function(namespace) {
  let ns = ensureNamespace(namespace);
  let names = new Set();
  let set = getKnownCollectionSet(ns);
  for (let value of set) {
    names.add(value);
  }
  if (isServer) {
    try {
      let namespaceDir = namespacePath(ns);
      let files = await fsReaddir(namespaceDir);
      for (let index = 0; index < files.length; index += 1) {
        let file = files[index];
        if (file.endsWith('.json')) {
          let collectionName = file.replace(/\.json$/i, '');
          names.add(collectionName);
          if (!set.has(collectionName)) {
            set.add(collectionName);
          }
        }
      }
    } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        throw error;
      }
    }
  }
  return Array.from(names);
};

function ensureCollectionName(collection) {
  if (collection === undefined || collection === null) {
    throw httpError(400, 'Collection name is required');
  }
  return String(collection);
}

function ensureNamespace(namespace) {
  if (namespace === undefined || namespace === null || namespace === '') {
    throw httpError(400, 'Namespace is required');
  }
  return String(namespace);
}

function namespacePath(namespace) {
  if (!isServer) {
    return namespace;
  }
  if (!dbBaseDir) {
    throw new Error('Database base directory not initialized');
  }
  return pathModule.join(dbBaseDir, namespace);
}

function getKnownCollectionSet(namespace) {
  let set = knownCollections.get(namespace);
  if (!set) {
    set = new Set();
    knownCollections.set(namespace, set);
  }
  return set;
}

function parseIdAndQueryArgs(args) {
  let id;
  let querySource;
  if (args.length > 0 && isIdValue(args[0])) {
    id = String(args[0]);
    if (args.length > 1) {
      querySource = args[1];
    }
  } else if (args.length > 0) {
    querySource = args[0];
  }
  let query = buildQuery(querySource);
  return { id, query };
}

function isIdValue(value) {
  return typeof value === 'string' || typeof value === 'number';
}

function buildQuery(params) {
  if (!params || typeof params !== 'object') {
    return {};
  }
  let query = {};
  iterateEntries(params, (key, value) => {
    assignQueryValue(query, key, value);
  });
  return normalizeQueryValue(query);
}

function normalizeQueryValue(value) {
  if (Array.isArray(value)) {
    let normalizedArray = [];
    for (let index = 0; index < value.length; index += 1) {
      normalizedArray.push(normalizeQueryValue(value[index]));
    }
    return normalizedArray;
  }
  if (value && typeof value === 'object') {
    let normalizedObject = {};
    iterateEntries(value, (key, entryValue) => {
      normalizedObject[key] = normalizeQueryValue(entryValue);
    });
    return normalizedObject;
  }
  return value;
}

function assignQueryValue(target, key, value) {
  if (key.includes('[')) {
    let segments = parseKeySegments(key);
    if (!segments.length) {
      segments = [key];
    }
    insertNestedValue(target, segments, value);
    return;
  }
  if (Object.prototype.hasOwnProperty.call(target, key)) {
    let existing = target[key];
    if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      target[key] = [existing, value];
    }
  } else {
    target[key] = value;
  }
}

function iterateEntries(value, iteratee) {
  if (!value) {
    return;
  }
  if (value instanceof URLSearchParams) {
    for (let [entryKey, entryValue] of value.entries()) {
      iteratee(entryKey, entryValue);
    }
    return;
  }
  if (value instanceof Map) {
    for (let [entryKey, entryValue] of value.entries()) {
      iteratee(entryKey, entryValue);
    }
    return;
  }
  let keys = Reflect.ownKeys(value);
  for (let index = 0; index < keys.length; index += 1) {
    let key = keys[index];
    if (typeof key !== 'string') {
      continue;
    }
    if (!Object.prototype.propertyIsEnumerable.call(value, key)) {
      continue;
    }
    iteratee(key, value[key]);
  }
}

function parseKeySegments(key) {
  let segments = [];
  let buffer = '';
  for (let index = 0; index < key.length; index += 1) {
    let char = key.charAt(index);
    if (char === '[') {
      if (buffer) {
        segments.push(buffer);
        buffer = '';
      }
      let end = key.indexOf(']', index + 1);
      if (end === -1) {
        segments.push(key.slice(index + 1));
        return segments;
      }
      segments.push(key.slice(index + 1, end));
      index = end;
    } else {
      buffer += char;
    }
  }
  if (buffer) {
    segments.push(buffer);
  }
  return segments;
}

function insertNestedValue(target, segments, value) {
  let current = target;
  for (let index = 0; index < segments.length; index += 1) {
    let segment = segments[index];
    let isLast = index === segments.length - 1;
    if (isLast) {
      if (segment === '') {
        if (!Array.isArray(current)) {
          return;
        }
        current.push(value);
        return;
      }
      if (Object.prototype.hasOwnProperty.call(current, segment)) {
        let existing = current[segment];
        if (Array.isArray(existing)) {
          existing.push(value);
        } else {
          current[segment] = [existing, value];
        }
      } else {
        current[segment] = value;
      }
      return;
    }
    let nextSegment = segments[index + 1];
    if (segment === '') {
      if (!Array.isArray(current)) {
        return;
      }
      let nextContainer;
      if (nextSegment === '' || isNumericString(nextSegment)) {
        nextContainer = [];
      } else {
        nextContainer = {};
      }
      current.push(nextContainer);
      current = nextContainer;
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(current, segment) || typeof current[segment] !== 'object' || current[segment] === null) {
      current[segment] = nextSegment === '' ? [] : {};
    }
    current = current[segment];
  }
}

function isNumericString(value) {
  if (typeof value !== 'string') {
    return false;
  }
  return /^[0-9]+$/.test(value);
}

function mergeDocumentsById(primary, secondary) {
  if (!secondary || secondary.length === 0) {
    return primary;
  }
  let merged = Array.isArray(primary) ? primary.slice() : [];
  let seen = new Set();
  for (let index = 0; index < merged.length; index += 1) {
    let doc = merged[index];
    if (doc && doc._id !== undefined) {
      seen.add(String(doc._id));
    }
  }
  for (let index = 0; index < secondary.length; index += 1) {
    let doc = secondary[index];
    if (!doc) {
      continue;
    }
    let id = doc._id;
    if (id !== undefined && seen.has(String(id))) {
      continue;
    }
    merged.push(doc);
    if (id !== undefined) {
      seen.add(String(id));
    }
  }
  return merged;
}

function maybeCreateCoercedQuery(query) {
  if (!query || typeof query !== 'object') {
    return null;
  }
  let { value: coerced, changed } = coerceQueryValue(query);
  return changed ? coerced : null;
}

function coerceQueryValue(value) {
  if (Array.isArray(value)) {
    let changed = false;
    let result = new Array(value.length);
    for (let index = 0; index < value.length; index += 1) {
      let element = value[index];
      let { value: coercedElement, changed: elementChanged } = coerceQueryValue(element);
      if (elementChanged || coercedElement !== element) {
        changed = true;
      }
      result[index] = coercedElement;
    }
    if (!changed) {
      return { value, changed: false };
    }
    return { value: result, changed: true };
  }
  if (isPlainObject(value)) {
    let changed = false;
    let proto = Object.getPrototypeOf(value);
    let result = proto === null ? Object.create(null) : {};
    iterateEntries(value, (key, entryValue) => {
      let { value: coercedEntry, changed: entryChanged } = coerceQueryValue(entryValue);
      if (entryChanged || coercedEntry !== entryValue) {
        changed = true;
      }
      result[key] = coercedEntry;
    });
    if (!changed) {
      return { value, changed: false };
    }
    return { value: result, changed: true };
  }
  if (typeof value === 'string') {
    let trimmed = value.trim();
    if (trimmed === '') {
      return { value, changed: false };
    }
    let lower = trimmed.toLowerCase();
    if (lower === 'true') {
      return { value: true, changed: true };
    }
    if (lower === 'false') {
      return { value: false, changed: true };
    }
    if (lower === 'null') {
      return { value: null, changed: true };
    }
    if (/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+\-]?\d+)?$/.test(trimmed)) {
      let num = Number(trimmed);
      if (!Number.isNaN(num)) {
        return { value: num, changed: true };
      }
    }
    return { value, changed: false };
  }
  return { value, changed: false };
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object') {
    return false;
  }
  let proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function ensureQueryMatchesId(query, id) {
  if (!query) {
    return;
  }
  if (query._id !== undefined && String(query._id) !== id) {
    throw httpError(400, 'Query _id must match route parameter');
  }
}

function hasOperatorKeys(payload) {
  let keys = Object.keys(payload);
  for (let index = 0; index < keys.length; index += 1) {
    let key = keys[index];
    if (key.startsWith('$')) {
      return true;
    }
  }
  return false;
}

async function getDatastore(namespace, collection, options = {}) {
  let createIfMissing = options.createIfMissing === undefined ? true : options.createIfMissing;
  let key = `${namespace}::${collection}`;
  if (datastores.has(key)) {
    return datastores.get(key);
  }
  if (pendingLoads.has(key)) {
    return await pendingLoads.get(key);
  }
  let loader = loadDatastoreForCollection(namespace, collection, createIfMissing);
  pendingLoads.set(key, loader);
  try {
    let datastore = await loader;
    return datastore;
  } finally {
    pendingLoads.delete(key);
  }
}

async function loadDatastoreForCollection(namespace, collection, createIfMissing) {
  let filename = isServer
    ? pathModule.join(namespacePath(namespace), `${collection}.json`)
    : `${namespace}/${collection}.json`;
  let datastore = new Datastore({ filename, autoload: false });
  let exists = await collectionExists(namespace, collection);
  if (!exists) {
    if (!createIfMissing) {
      return null;
    }
    if (isServer) {
      await ensureDbDir(namespace);
    }
  } else if (isServer) {
    await ensureDbDir(namespace);
  }
  await loadDatabase(datastore);
  datastores.set(`${namespace}::${collection}`, datastore);
  recordKnownCollection(namespace, collection);
  return datastore;
}

async function collectionExists(namespace, collection) {
  if (isServer) {
    try {
      await fsAccess(pathModule.join(namespacePath(namespace), `${collection}.json`));
      return true;
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }
  let set = knownCollections.get(namespace);
  return !!(set && set.has(collection));
}

function recordKnownCollection(namespace, collection) {
  let set = getKnownCollectionSet(namespace);
  if (!set.has(collection)) {
    set.add(collection);
    if (!isServer) {
      persistBrowserCollections();
    }
  } else if (!isServer) {
    persistBrowserCollections();
  }
}

function readBrowserCollections() {
  if (typeof window === 'undefined') {
    return new Map();
  }
  let storage;
  try {
    storage = window.localStorage;
  } catch (error) {
    return new Map();
  }
  if (!storage) {
    return new Map();
  }
  try {
    let raw = storage.getItem(browserCollectionsKey);
    if (!raw) {
      return new Map();
    }
    let parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      let map = new Map();
      map.set('default', parsed.filter(value => typeof value === 'string'));
      return map;
    }
    if (parsed && typeof parsed === 'object') {
      let entries = Object.entries(parsed);
      let map = new Map();
      for (let index = 0; index < entries.length; index += 1) {
        let entry = entries[index];
        if (Array.isArray(entry[1])) {
          map.set(entry[0], entry[1]);
        }
      }
      return map;
    }
    return new Map();
  } catch (error) {
    return new Map();
  }
}

function persistBrowserCollections() {
  if (typeof window === 'undefined') {
    return;
  }
  let storage;
  try {
    storage = window.localStorage;
  } catch (error) {
    return;
  }
  if (!storage) {
    return;
  }
  try {
    let obj = {};
    for (let [namespace, set] of knownCollections.entries()) {
      obj[namespace] = Array.from(set);
    }
    storage.setItem(browserCollectionsKey, JSON.stringify(obj));
  } catch (error) {
    console.warn('Failed to persist collection list', error);
  }
}

async function ensureDbDir(namespace) {
  if (!isServer) {
    return;
  }
  if (ensuredNamespaceDirs.has(namespace)) {
    return;
  }
  await fsMkdir(namespacePath(namespace), { recursive: true });
  ensuredNamespaceDirs.add(namespace);
}

async function loadDatabase(datastore) {
  await new Promise((resolve, reject) => {
    datastore.loadDatabase(error => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function findDocuments(datastore, query) {
  return new Promise((resolve, reject) => {
    datastore.find(query, (error, docs) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(docs);
    });
  });
}

function findDocument(datastore, query) {
  return new Promise((resolve, reject) => {
    datastore.findOne(query, (error, doc) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(doc);
    });
  });
}

function insertDocuments(datastore, payload) {
  return new Promise((resolve, reject) => {
    datastore.insert(payload, (error, doc) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(doc);
    });
  });
}

function updateDocument(datastore, selector, update, options = {}) {
  let updateOptions = { returnUpdatedDocs: true, multi: false };
  updateOptions = Object.assign(updateOptions, options || {});
  return new Promise((resolve, reject) => {
    datastore.update(selector, update, updateOptions, (error, numAffected, affectedDocument, upsert) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ numAffected, affectedDocument, upsert });
    });
  });
}

function removeDocuments(datastore, selector, options = {}) {
  let removeOptions = { multi: false };
  removeOptions = Object.assign(removeOptions, options || {});
  return new Promise((resolve, reject) => {
    datastore.remove(selector, removeOptions, (error, numRemoved) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(numRemoved);
    });
  });
}

function createHandler(handler, successStatus) {
  return async (req, res) => {
    try {
      let result = await handler(req, res);
      if (successStatus !== undefined) {
        res.status(successStatus);
      }
      res.json(result);
    } catch (error) {
      handleServerError(res, error);
    }
  };
}

function handleServerError(res, error) {
  if (error && typeof error.status === 'number') {
    res.status(error.status).json({ error: error.message });
    return;
  }
  console.error(error);
  res.status(500).json({ error: 'Internal Server Error' });
}

function initializeServer() {
  if (!isServer || serverInitialized) {
    return;
  }
  if (!expressModule) {
    console.warn('Express module unavailable; server not started.');
    return;
  }
  expressApp = expressModule();
  expressApp.use(expressModule.json());

  expressApp.get('/:namespace/_collections', createHandler(req => peacock.get(req.params.namespace, '_collections')));
  expressApp.get('/:namespace/:collection/:_id', createHandler(req => peacock.get(req.params.namespace, req.params.collection, req.params._id, req.query)));
  expressApp.get('/:namespace/:collection', createHandler(req => peacock.get(req.params.namespace, req.params.collection, req.query)));
  expressApp.post('/:namespace/:collection', createHandler(req => peacock.post(req.params.namespace, req.params.collection, req.body), 201));
  expressApp.put('/:namespace/:collection/:_id', createHandler(req => peacock.put(req.params.namespace, req.params.collection, req.params._id, req.body, req.query)));
  expressApp.delete('/:namespace/:collection/:_id', createHandler(req => peacock.delete(req.params.namespace, req.params.collection, req.params._id, req.query)));
  expressApp.delete('/:namespace/:collection', createHandler(req => peacock.delete(req.params.namespace, req.params.collection, req.query)));

  let port = process.env.PORT || 3000;
  expressApp.listen(port, () => {
    console.log(`Server listening on http://localhost:${port}`);
  });
  serverInitialized = true;
}

function httpError(status, message) {
  let error = new Error(message);
  error.status = status;
  return error;
}

if (isServer) {
  initializeServer();
}

export default peacock;
