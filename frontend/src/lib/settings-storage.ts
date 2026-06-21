'use client';

import {
  loadRegistry,
  saveRegistry,
  type NovaModelRegistry,
  type ProviderProtocol,
} from '@/lib/nova-models';

const STORAGE_KEY_CCODE_API = 'nova-api-key';
const STORAGE_KEY_CCODE_API_LEGACY = 'ccode-api-key';
const OBFUSCATION_MARKER = '__e:';

function getStorageItem(key: string): string {
  if (typeof window === 'undefined') return '';

  try {
    return localStorage.getItem(key) || '';
  } catch {
    return '';
  }
}

function setStorageItem(key: string, value: string): boolean {
  if (typeof window === 'undefined') return false;

  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function removeStorageItem(key: string): void {
  if (typeof window === 'undefined') return;

  try {
    localStorage.removeItem(key);
  } catch {
    // Ignore unavailable storage.
  }
}

function obfuscate(value: string): string {
  const chars: string[] = [];
  for (let i = 0; i < value.length; i++) {
    chars.push(String.fromCharCode(value.charCodeAt(i) ^ 0x5A));
  }
  return OBFUSCATION_MARKER + btoa(chars.join(''));
}

function deobfuscate(value: string): string | null {
  if (!value.startsWith(OBFUSCATION_MARKER)) return null;
  try {
    const decoded = atob(value.slice(OBFUSCATION_MARKER.length));
    const chars: string[] = [];
    for (let i = 0; i < decoded.length; i++) {
      chars.push(String.fromCharCode(decoded.charCodeAt(i) ^ 0x5A));
    }
    return chars.join('');
  } catch {
    return null;
  }
}

function migrateLegacyApiKeyIfNeeded(registry?: NovaModelRegistry): NovaModelRegistry {
  const nextRegistry = registry || loadRegistry();

  const legacyObfuscated = getStorageItem(STORAGE_KEY_CCODE_API);
  if (legacyObfuscated) {
    const legacyKey = deobfuscate(legacyObfuscated);
    if (legacyKey && !nextRegistry.providers.openai.apiKey) {
      nextRegistry.providers.openai.apiKey = legacyKey;
      saveRegistry(nextRegistry);
    }
    removeStorageItem(STORAGE_KEY_CCODE_API);
  }

  const legacyPlainText = getStorageItem(STORAGE_KEY_CCODE_API_LEGACY);
  if (legacyPlainText) {
    if (!nextRegistry.providers.openai.apiKey) {
      nextRegistry.providers.openai.apiKey = legacyPlainText;
      saveRegistry(nextRegistry);
    }
    removeStorageItem(STORAGE_KEY_CCODE_API_LEGACY);
  }

  return nextRegistry;
}

export function getStoredApiKey(protocol: ProviderProtocol = 'openai'): string {
  const registry = migrateLegacyApiKeyIfNeeded();
  return registry.providers[protocol].apiKey || '';
}

export function setStoredApiKey(key: string, protocol: ProviderProtocol = 'openai'): boolean {
  const registry = migrateLegacyApiKeyIfNeeded();
  registry.providers[protocol].apiKey = key.trim();
  saveRegistry(registry);
  removeStorageItem(STORAGE_KEY_CCODE_API);
  removeStorageItem(STORAGE_KEY_CCODE_API_LEGACY);
  return true;
}

export function removeStoredApiKey(protocol?: ProviderProtocol): void {
  const registry = migrateLegacyApiKeyIfNeeded();
  if (protocol) {
    registry.providers[protocol].apiKey = '';
  } else {
    registry.providers.google.apiKey = '';
    registry.providers.openai.apiKey = '';
  }
  saveRegistry(registry);
  removeStorageItem(STORAGE_KEY_CCODE_API);
  removeStorageItem(STORAGE_KEY_CCODE_API_LEGACY);
}

export const getStoredCcodeKey = getStoredApiKey;
export const setStoredCcodeKey = setStoredApiKey;
export const removeStoredCcodeKey = removeStoredApiKey;

export function getApiKeyFromStorage(protocol?: ProviderProtocol): string {
  const registry = migrateLegacyApiKeyIfNeeded();
  if (protocol) {
    return registry.providers[protocol].apiKey || '';
  }
  return registry.providers.openai.apiKey || registry.providers.google.apiKey || '';
}

export function hasAnyApiKey(): boolean {
  const registry = migrateLegacyApiKeyIfNeeded();
  return Boolean(registry.providers.openai.apiKey || registry.providers.google.apiKey);
}

export function loadJsonFromStorage<T>(key: string): Partial<T> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function saveJsonToStorage<T>(key: string, value: T): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage errors (private mode / quota)
  }
}
