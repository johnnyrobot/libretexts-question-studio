import { useSyncExternalStore } from 'react'
import { db } from './db'

// The OpenAI key lives in memory for this tab by default. "Remember on this
// device" stores it AES-GCM encrypted under a non-extractable WebCrypto key that
// also lives in IndexedDB: the raw key never sits in storage as plain text and
// cannot be copied out of a disk image or a storage export. It does not stop
// script running on this origin, so the app ships no third-party scripts.

const DEVICE_KEY = 'secret.deviceKey'
const OPENAI_KEY = 'secret.openaiKey'

let memoryKey: string | null = null
const listeners = new Set<() => void>()

export function getSessionKey(): string | null {
  return memoryKey
}

export function setSessionKey(key: string | null): void {
  memoryKey = key?.trim() || null
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The key for this tab, re-rendering when it is saved or forgotten. */
export function useSessionKey(): string | null {
  return useSyncExternalStore(subscribe, getSessionKey)
}

export async function rememberKey(key: string): Promise<void> {
  const deviceKey = await deviceCryptoKey()
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    deviceKey,
    new TextEncoder().encode(key.trim()),
  )
  await db.settings.put({ key: OPENAI_KEY, value: { iv, ciphertext } })
  setSessionKey(key)
}

export async function loadRememberedKey(): Promise<string | null> {
  const row = await db.settings.get(OPENAI_KEY)
  const deviceRow = await db.settings.get(DEVICE_KEY)
  if (!row || !deviceRow) return null
  const { iv, ciphertext } = row.value as { iv: Uint8Array<ArrayBuffer>; ciphertext: ArrayBuffer }
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      deviceRow.value as CryptoKey,
      ciphertext,
    )
    const key = new TextDecoder().decode(plain)
    setSessionKey(key)
    return key
  } catch {
    return null
  }
}

export async function hasRememberedKey(): Promise<boolean> {
  return (await db.settings.get(OPENAI_KEY)) !== undefined
}

export async function forgetKey(): Promise<void> {
  await db.settings.bulkDelete([OPENAI_KEY, DEVICE_KEY])
  setSessionKey(null)
}

async function deviceCryptoKey(): Promise<CryptoKey> {
  const existing = await db.settings.get(DEVICE_KEY)
  if (existing) return existing.value as CryptoKey
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
  await db.settings.put({ key: DEVICE_KEY, value: key })
  return key
}
