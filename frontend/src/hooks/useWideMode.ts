'use client';

import { useCallback, useEffect, useState } from 'react';

export const WIDE_MODE_STORAGE_KEY = 'nova-wide-mode';
export const WIDE_MODE_MIN_WIDTH = 0;

type StoredWideMode = 'enabled' | 'disabled';

function readStoredWideMode(): boolean {
  if (typeof window === 'undefined') return false;

  try {
    return localStorage.getItem(WIDE_MODE_STORAGE_KEY) === 'enabled';
  } catch {
    return false;
  }
}

function writeStoredWideMode(enabled: boolean): void {
  if (typeof window === 'undefined') return;

  try {
    const value: StoredWideMode = enabled ? 'enabled' : 'disabled';
    localStorage.setItem(WIDE_MODE_STORAGE_KEY, value);
  } catch {
    // Storage can be unavailable in hardened/private browser modes.
  }
}

function dismissBootLoader(): void {
  const el = document.getElementById('app-boot-loader');
  if (el) el.remove();
}

function syncHtmlAttribute(enabled: boolean): void {
  if (typeof document === 'undefined') return;
  if (enabled) {
    document.documentElement.setAttribute('data-wide-mode', '');
  } else {
    document.documentElement.removeAttribute('data-wide-mode');
  }
}

export function useWideMode() {
  const [wideMode, setWideModeState] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    let cancelled = false;

    queueMicrotask(() => {
      if (cancelled) return;
      setWideModeState(readStoredWideMode());
      setMounted(true);
      dismissBootLoader();
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    syncHtmlAttribute(wideMode);
  }, [wideMode]);

  const setWideMode = useCallback((enabled: boolean) => {
    setWideModeState(enabled);
    writeStoredWideMode(enabled);
  }, []);

  const toggleWideMode = useCallback(() => {
    setWideModeState(current => {
      const next = !current;
      writeStoredWideMode(next);
      return next;
    });
  }, []);

  return {
    wideMode,
    mounted,
    setWideMode,
    toggleWideMode,
  };
}
