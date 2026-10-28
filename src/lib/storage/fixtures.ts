// Web Locks as a browser shares them between an origin's tabs, exclusive mode
// only. The tests need locks they can let go of as a closing tab does.
export class FakeLocks {
  private held = new Map<string, { released: Promise<void>; release: () => void }>()
  private requests = new Set<Promise<unknown>>()

  request<T>(name: string, ...args: [(lock: object | null) => Promise<T>] | [{ ifAvailable?: boolean }, (lock: object | null) => Promise<T>]) {
    const [options, callback] = args.length === 1 ? [{}, args[0]] : args
    const request = this.run(name, options, callback)
    this.requests.add(request)
    void request.catch(() => undefined).finally(() => this.requests.delete(request))
    return request
  }

  // Resolves once every request made so far has finished, waiting ones included.
  async settled() {
    while (this.requests.size) await Promise.allSettled([...this.requests])
  }

  // As a browser does when a tab closes: every lock it held is let go.
  closeTab() {
    for (const [name, hold] of this.held) {
      this.held.delete(name)
      hold.release()
    }
  }

  private async run<T>(name: string, options: { ifAvailable?: boolean }, callback: (lock: object | null) => Promise<T>) {
    if (options.ifAvailable && this.held.has(name)) return callback(null)
    while (this.held.has(name)) await this.held.get(name)!.released
    let release = () => {}
    const released = new Promise<void>((resolve) => (release = resolve))
    const hold = { released, release }
    this.held.set(name, hold)
    try {
      return await callback({ name, mode: 'exclusive' })
    } finally {
      // closeTab may have let go of it already, and another request may hold the name now.
      if (this.held.get(name) === hold) this.held.delete(name)
      hold.release()
    }
  }
}
