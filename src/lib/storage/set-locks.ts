// A set's generation holds this lock from start to finish, in whichever tab
// runs it: Web Locks are shared by every tab of the app. Browsers offer them
// only on https and localhost.
export const generationLockName = (setId: string) => `generation:${setId}`
export const webLocks = (): LockManager | undefined => navigator.locks ?? undefined

// Runs change unless a tab, this one included, is writing one of these sets,
// and holds their locks meanwhile so no run can start on one. Gives back the
// id of a set being written, having changed nothing, or null once change has
// run. Without Web Locks, or when the browser refuses one, change just runs.
export async function unlessGenerating(setIds: string[], change: () => Promise<void>): Promise<string | null> {
  const locks = webLocks()
  const [first, ...rest] = [...new Set(setIds)]
  if (!locks || first === undefined) {
    await change()
    return null
  }
  let began = false
  try {
    return await locks.request(generationLockName(first), { ifAvailable: true }, (lock) => {
      began = true
      return lock ? unlessGenerating(rest, change) : Promise.resolve(first)
    })
  } catch (error) {
    if (began) throw error
    await change()
    return null
  }
}
