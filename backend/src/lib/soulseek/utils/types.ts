 

export type DistributiveOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never

export function distributiveOmit<T, K extends keyof T>(
  obj: T,
  keys: K[]
): T extends any ? Omit<T, K> : never {
  const copy = { ...obj }
  keys.forEach((key) => delete copy[key])
  return copy as T extends any ? Omit<T, K> : never
}
