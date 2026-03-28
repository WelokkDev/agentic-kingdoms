import { useEffect, useState } from 'react'

export default function App() {
  const [tick, setTick] = useState(null)

  useEffect(() => {
    const stream = new EventSource('http://localhost:3001/stream')
    stream.onmessage = (e) => {
      const state = JSON.parse(e.data)
      setTick(state.tick)
    }
    return () => stream.close()
  }, [])

  return <div>Tick: {tick ?? 'connecting...'}</div>
}