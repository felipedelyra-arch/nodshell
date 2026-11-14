import '@fontsource-variable/jetbrains-mono'
import '@xyflow/react/dist/base.css'
import '@xterm/xterm/css/xterm.css'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

// No StrictMode: its dev-only double mount would drain buffered PTY output into a discarded xterm.
createRoot(document.getElementById('root')!).render(<App />)
