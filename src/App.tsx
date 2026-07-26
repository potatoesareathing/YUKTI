import { Route, Routes } from 'react-router-dom'
import { Landing } from './landing/Landing'
import { Platform } from './platform/Platform'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/platform" element={<Platform />} />
      <Route path="/platform/:module" element={<Platform />} />
      <Route path="*" element={<Landing />} />
    </Routes>
  )
}
