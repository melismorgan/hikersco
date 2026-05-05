'use client';

import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'hikers-inventory-drafts-v1';

/**
 * Per-SKU "draft qty" state, persisted to localStorage. Mirrors the editable
 * Draft Qty column on the spreadsheet dashboard (col W). Survives page
 * reloads but is per-device — when Melissa moves to a different machine,
 * drafts don't follow. (If we want cross-device drafts later, persist to a
 * Drafts tab in the sheet.)
 *
 * `setDraft(sku, 0)` (or any non-positive value) deletes the entry rather
 * than storing zero, so the surface stays clean.
 */
export function useDrafts() {
  const [drafts, setDrafts] = useState<Record<string, number>>({});
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      setDrafts(raw ? JSON.parse(raw) : {});
    } catch {
      setDrafts({});
    }
    setHydrated(true);
  }, []);

  const persist = (next: Record<string, number>) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Quota errors etc — non-fatal; in-memory state still works.
    }
  };

  const setDraft = useCallback((sku: string, qty: number) => {
    setDrafts((prev) => {
      const next = { ...prev };
      if (!Number.isFinite(qty) || qty <= 0) delete next[sku];
      else next[sku] = Math.round(qty);
      persist(next);
      return next;
    });
  }, []);

  const clearDrafts = useCallback(() => {
    setDrafts({});
    persist({});
  }, []);

  const removeDraft = useCallback((sku: string) => {
    setDrafts((prev) => {
      if (!(sku in prev)) return prev;
      const next = { ...prev };
      delete next[sku];
      persist(next);
      return next;
    });
  }, []);

  return { drafts, setDraft, clearDrafts, removeDraft, hydrated };
}
