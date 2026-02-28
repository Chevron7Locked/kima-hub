import { useState, useCallback } from "react";

const STORAGE_KEY = "kima:trackDisplayFormat";

function getStoredFormat(): string {
  if (typeof window === "undefined") return "";
  try {
    return localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function useTrackFormat() {
  const [format, setFormatState] = useState<string>(getStoredFormat);

  const setFormat = useCallback((value: string) => {
    setFormatState(value);
    try {
      if (value) localStorage.setItem(STORAGE_KEY, value);
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      // storage unavailable
    }
  }, []);

  return { format, setFormat } as const;
}
