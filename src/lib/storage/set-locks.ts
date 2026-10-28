// A set's generation holds this lock from start to finish, in whichever tab
// runs it: Web Locks are shared by every tab of the app. Browsers offer them
// only on https and localhost.
export const generationLockName = (setId: string) => `generation:${setId}`
export const webLocks = (): LockManager | undefined => navigator.locks ?? undefined

// Calls held with the set's lock, or with null when the lock was asked for
// only if available and another holder has it. Without Web Locks, or when the
// browser refuses the lock outright (a document that isn't fully active, say),
// calls unlocked instead.
export async function withGenerationLock<T>(
  setId: string,
  options: LockOptions,
  held: (lock: Lock | null) => Promise<T>,
  unlocked: () => Promise<T>,
): Promise<T> {
  const locks = webLocks()
  if (!locks) return unlocked()
  let began = false
  try {
    return await locks.request(generationLockName(setId), options, (lock) => {
      began = true
      return held(lock)
    })
  } catch (error) {
    if (began) throw error
    return unlocked()
  }
}

// Runs change unless a tab, this one included, is writing one of these sets,
// and holds their locks meanwhile so no run can start on one. Gives back the
// id of a set being written, having changed nothing, or null once change has
// run. Without Web Locks, or when the browser refuses one, change just runs.
export async function unlessGenerating(setIds: string[], change: () => Promise<void>): Promise<string | null> {
  const [first, ...rest] = [...new Set(setIds)]
  const unlocked = async () => {
    await change()
    return null
  }
  if (first === undefined) return unlocked()
  return withGenerationLock(
    first,
    { ifAvailable: true },
    (lock) => (lock ? unlessGenerating(rest, change) : Promise.resolve(first)),
    unlocked,
  )
}
