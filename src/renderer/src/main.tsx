import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './design/index.css'
import './design/world.css'
import './ui/ui.css'
import { App } from './App.tsx'
import './styles.css'
import './launch.css'

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>
)
