import { Route, Routes } from 'react-router-dom'
import { Landing } from './landing/Landing'
import { Platform } from './platform/Platform'
import { BeatDispatch } from './platform/BeatDispatch'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/beat" element={<BeatDispatch />} />
      <Route path="/platform" element={<Platform />} />
      <Route path="/platform/:module" element={<Platform />} />
      <Route path="*" element={<Landing />} />
    </Routes>
  )
}
